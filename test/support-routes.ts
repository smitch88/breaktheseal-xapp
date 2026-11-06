import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Wallet } from "xrpl";
import type { NftPrice } from "../src/config/nft-packs.ts";
import { signToken } from "../src/lib/auth/tokens.ts";
import { simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { createEngine, type EngineDeps, type RipEngine } from "../src/lib/rip/engine.ts";
import { multiConfig } from "../src/lib/rip/mode.ts";
import { memoryOnce, memoryPrivate, memoryStore, type EventStore } from "../src/lib/rip/store.ts";
import type { RelayRails } from "../src/lib/rip/relay.ts";
import type { Chain } from "../src/lib/rip/types.ts";
import { ISSUER, MINTER, TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/**
 * Runs the real route handlers, the real guard and the real auth, in-process, against the in-memory ledger. Only the edges
 * are replaced: Next's cookie store, its caches, and the rails factory, which would otherwise build a live RPC client.
 * Every world gets fresh copies of the app's modules, so its rate limiter and its cached rails start clean.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const stub = (js: string) => ({ url: `data:text/javascript,${encodeURIComponent(js)}`, shortCircuit: true as const });
const jars = new AsyncLocalStorage<Map<string, string>>();
interface Shared {
  rails: unknown;
  jar: () => Map<string, string>;
  generation: number;
}
const shared: Shared = { rails: null, jar: () => jars.getStore() ?? new Map(), generation: 0 };
(globalThis as unknown as { __sealTest: Shared }).__sealTest = shared;
const JS = { headers: `export const cookies = async () => { const jar = globalThis.__sealTest.jar(); return { get: (n) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined) }; };`, factory: `export const buildRails = () => globalThis.__sealTest.rails;`, cache: `export const unstable_cache = (f) => f;`, functions: `const m = new Map(); export const getCache = () => ({ get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) }); export const attachDatabasePool = () => {};`, react: `export const cache = (f) => f;` };

const fileFor = (spec: string): string | null => {
  const base = join(SRC, spec.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
};

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "server-only") return stub("");
    if (spec === "next/headers") return stub(JS.headers);
    if (spec === "next/cache") return stub(JS.cache);
    if (spec === "@vercel/functions") return stub(JS.functions);
    if (spec === "react" && ctx.parentURL?.includes("/src/lib/")) return stub(JS.react);
    if (spec === "next/server") return next("next/server.js", ctx);
    const target = spec.startsWith("@/") ? (fileFor(spec) ? pathToFileURL(fileFor(spec) as string).href : spec) : spec;
    const r = next(target, ctx);
    if (!r.url.startsWith("file:") || !fileURLToPath(r.url.split("?")[0]).startsWith(SRC)) return r;
    if (r.url.split("?")[0].endsWith("/lib/rip/factory.ts") && !ctx.parentURL?.includes("/test/")) return stub(JS.factory);
    return { ...r, url: `${r.url.split("?")[0]}?g=${shared.generation}`, shortCircuit: true };
  },
  load(url, ctx, next) {
    if (url.split("?")[0].endsWith(".json") && url.startsWith("file:") && fileURLToPath(url.split("?")[0]).startsWith(SRC)) return { format: "module", source: `export default ${readFileSync(fileURLToPath(url.split("?")[0]), "utf8")}`, shortCircuit: true };
    return next(url, ctx);
  },
});

/** Every route file in the app, as `/api/rip/orders/[id]/sell`. */
export function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}/${name}`);
      else if (name === "route.ts") out.push(prefix);
    }
  };
  walk(join(SRC, "app/api"), "/api");
  return out.sort();
}

const ROUTES = routeFiles();
const SITE = "https://seal.test";
export const SECRET = "route-test-session-secret-32-characters-long";
export const CRON = "route-test-cron-secret";
const OUR_ENV = /^(SEAL_|XAMAN_|REOWN_|CRON_SECRET$|DATABASE_URL$)/;

export const addressOf = (n: number) => Wallet.fromEntropy(new Uint8Array(16).fill(n)).classicAddress;
export const walletOf = (n: number) => Wallet.fromEntropy(new Uint8Array(16).fill(n));

export interface Client {
  readonly address: string | null;
  readonly jar: Map<string, string>;
  readonly ip: string;
}

export interface Answer {
  status: number;
  body: Record<string, any>;
  headers: Headers;
  setCookies: string[];
  thrown?: unknown;
}

export interface WorldOptions {
  ledgerReadMs?: number;
  /** Rails off: demo mode. */
  off?: boolean;
  cards?: boolean;
  gateway?: CardGateway;
  rate?: number | null;
  allowed?: string;
  admins?: string;
  xaman?: boolean;
  joey?: boolean;
  /** The passthrough rails. Given the ledger, so a fake Relay can deliver on it. Off when unset, as on a site with the switch off. */
  relay?: (ledger: ReturnType<typeof testLedger>) => RelayRails;
  /** Wrap the ledger's chain, to make it fail on purpose. */
  wrapChain?: (c: Chain) => Chain;
  /** More engine deps, such as the restocker's. */
  engineExtra?: Partial<EngineDeps>;
  treasuryXrp?: number;
  store?: EventStore;
  env?: Readonly<Record<string, string>>;
}

export type World = Awaited<ReturnType<typeof world>>;

/** A site with its own ledger, log and wallets. */
export async function world(opts: WorldOptions = {}) {
  shared.generation += 1;
  for (const k of Object.keys(process.env)) if (OUR_ENV.test(k)) delete process.env[k];
  Object.assign(process.env, { SEAL_SESSION_SECRET: SECRET, CRON_SECRET: CRON, ...(opts.cards ? { SEAL_MACHINE_CODES: "pokemon_25" } : {}), ...opts.env });
  if (!opts.off) process.env.SEAL_RAILS_MODE = "mainnet";
  if (opts.allowed) process.env.SEAL_ALLOWED_WALLETS = opts.allowed;
  if (opts.admins) process.env.SEAL_ADMIN_ADDRESSES = opts.admins;
  if (opts.xaman) Object.assign(process.env, { XAMAN_API_KEY: "key", XAMAN_API_SECRET: "api-secret" });
  if (opts.joey) process.env.REOWN_PROJECT_ID = "route-test";

  const ledger = testLedger();
  for (const [a, x] of [[TREASURY, opts.treasuryXrp ?? 1000], [VAULT, 100], [MINTER, 100], [ISSUER, 50]] as const) ledger.fund(a, x);
  ledger.authorize(ISSUER, MINTER);
  const state = { rate: opts.rate === undefined ? 1.25 : opts.rate, clockMs: 0 };
  const base: Chain = { ...ledger.chain, networkId: async () => 0, xrpUsd: async () => state.rate };
  const chain = opts.wrapChain ? opts.wrapChain(base) : base;
  const store = opts.store ?? memoryStore();
  const gateway = opts.cards ? opts.gateway ?? simulatedGateway() : undefined;
  const once = memoryOnce();
  const stored = memoryPrivate();
  const secretWrites: string[] = [];
  const secrets = { get: stored.get, put: async (k: string, v: string) => (secretWrites.push(k), stored.put(k, v)) } as { get: typeof stored.get; put: typeof stored.put };
  const relayRails = opts.relay?.(ledger);
  const makeEngine = (): RipEngine => createEngine({ store, chain, signer: testSigner(), drawSecret: "route-test-draw-secret-32-characters", expectedNetworkId: 0, rateGuardBps: 1500, now: () => new Date(Date.now() + state.clockMs), multi: multiConfig(process.env) ?? undefined, ...(gateway ? { gateway, mirror: { issuer: ISSUER, transferFee: 2000, taxon: 1, origin: SITE } } : {}), ...opts.engineExtra, ...(relayRails ? { relay: relayRails } : {}) });
  let engine = makeEngine();
  const railsObject = () => ({ engine, once, secrets, cardsOn: !!gateway, store, mode: "mainnet" as const, treasury: TREASURY, vault: VAULT, ledgerReadMs: opts.ledgerReadMs ?? 0 });
  shared.rails = opts.off ? null : railsObject();

  // Nothing here should reach the network. Xaman answers from this list, and everything else fails as an outage would.
  const xaman = { mode: "ok" as "ok" | "down" | "duplicate-check", calls: [] as Record<string, any>[], payload: { meta: { exists: true, resolved: false } } as unknown, identifiers: new Set<string>(), refuseUserToken: false };
  /** Collector Crypt's public marketplace, by mint. Empty, as an unknown card reads. */
  const cc = { rows: [] as Record<string, unknown>[], calls: 0, down: false, gacha: null as ((u: URL) => unknown) | null, gachaCalls: [] as string[] };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.collectorcrypt.com/marketplace?")) {
      cc.calls += 1;
      if (cc.down) throw new Error("Collector Crypt timed out");
      return new Response(JSON.stringify({ filterNFtCard: cc.rows }));
    }
    if (u.startsWith("https://gacha.collectorcrypt.com/") && cc.gacha) {
      cc.gachaCalls.push(u);
      if (cc.down) throw new Error("Collector Crypt timed out");
      return new Response(JSON.stringify(cc.gacha(new URL(u))));
    }
    if (!u.startsWith("https://xumm.app/")) throw new Error(`no network in tests: ${u}`);
    if (xaman.mode === "down") throw new Error("Xaman timed out");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      xaman.calls.push(body);
      // Xaman's documented rule: a custom identifier can only be used once.
      if (xaman.identifiers.has(body.custom_meta?.identifier)) return new Response("{}", { status: 409 });
      xaman.identifiers.add(body.custom_meta?.identifier);
      if (body.user_token && xaman.refuseUserToken) return new Response("{}", { status: 400 });
      const uuid = randomBytes(8).toString("hex");
      return new Response(JSON.stringify({ uuid, pushed: !!body.user_token, next: { always: `https://xumm.app/sign/${uuid}` }, refs: { qr_png: `https://xumm.app/sign/${uuid}_q.png`, websocket_status: `wss://xumm.app/sign/${uuid}` } }));
    }
    return new Response(JSON.stringify(xaman.payload));
  }) as typeof fetch;

  let ipCounter = 0;
  // A world with Xaman set up signs its players in with Xaman, unless a test asks for a Joey player.
  const client = (address: string | null = null, session = true, wallet: "xaman" | "joey" = opts.xaman ? "xaman" : "joey"): Client => {
    const jar = new Map<string, string>();
    if (address && session) jar.set("seal_session", signToken({ k: "session", a: address, w: wallet, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET));
    return { address, jar, ip: `10.0.${shared.generation % 250}.${++ipCounter % 250}` };
  };

  const route = (path: string) => {
    const parts = path.split("/");
    for (const r of ROUTES) {
      const segs = r.split("/");
      if (segs.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (segs.every((s, i) => (s.startsWith("[") ? ((params[s.slice(1, -1)] = decodeURIComponent(parts[i])), true) : s === parts[i]))) return { file: r, params };
    }
    throw new Error(`no route for ${path}`);
  };

  /** One request, through the real handler, with the wallet's cookies. A throw is what Next would turn into a 500. */
  async function call(method: "GET" | "POST", url: string, input: { as?: Client; body?: unknown; raw?: string; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Answer> {
    const who = input.as ?? client();
    const [path] = url.split("?");
    const { file, params } = route(path);
    const mod = (await import(pathToFileURL(join(SRC, "app", file, "route.ts")).href)) as Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> | Response>;
    const handler = mod[method];
    if (!handler) throw new Error(`${file} has no ${method}`);
    const headers = new Headers({ host: "seal.test", "x-forwarded-proto": "https", "x-forwarded-for": who.ip, ...input.headers });
    if (input.origin !== null) headers.set("origin", input.origin ?? SITE);
    headers.set("content-type", "application/json");
    // A checkout always sends this after the player ticks the box. A test about the box passes `acceptedTerms` itself or uses `raw`.
    const sent = (path === "/api/rip/orders" || path === "/api/rip/cards") && input.body && typeof input.body === "object" && !("acceptedTerms" in input.body) ? { ...input.body, acceptedTerms: true } : input.body;
    const body = method === "POST" ? input.raw ?? (sent === undefined ? "{}" : JSON.stringify(sent)) : undefined;
    const req = new Request(SITE + url, { method, headers, body });
    return jars.run(who.jar, async () => {
      let res: Response;
      try {
        res = await handler(req, { params: Promise.resolve(params) });
      } catch (thrown) {
        return { status: 500, body: {}, headers: new Headers(), setCookies: [], thrown };
      }
      const setCookies = res.headers.getSetCookie();
      for (const c of setCookies) {
        const [kv] = c.split(";");
        const i = kv.indexOf("=");
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || !kv.slice(i + 1)) who.jar.delete(kv.slice(0, i));
        else who.jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any>, headers: res.headers, setCookies };
    });
  }

  /** The ledger moves on and the server keeps up: what a real minute of block time and polling does. */
  const pump = async (passes = 3) => {
    for (let i = 0; i < passes; i++) {
      await engine.advance();
      ledger.close();
      await engine.advance();
    }
  };

  /** Open a tier and fill it, with a season committed at the current rate. */
  const open = async (price: NftPrice = 5, drops = "4000000", stock: readonly number[] = [8, 6, 4, 3, 2]) => {
    await engine.openSeason(price, drops, state.rate);
    const adds = stock.flatMap((count, band) =>
      Array.from({ length: count }, () => {
        const nftId = nftIdFor(++nftCounter);
        ledger.mintTo(nftId, VAULT);
        return { nftId, band, collection: `c${nftCounter % 5}`, name: `n${nftCounter}`, img: "/x.webp", costDrops: "2000000", markDrops: "3000000" };
      }),
    );
    if (adds.length) await engine.changePool(price, adds);
    await pump(4);
  };

  const fund = (c: Client, xrp = 500) => ledger.fund(c.address as string, xrp);

  const newOrder = async (c: Client, price: NftPrice = 5) => {
    const r = await call("POST", "/api/rip/orders", { as: c, body: { price } });
    if (r.status !== 200) throw new Error(`order: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { order: Record<string, any>; tx: Record<string, unknown>; wallet: unknown };
  };

  /** Order, pay and draw: a stashed NFT. */
  const pull = async (c: Client, price: NftPrice = 5) => {
    const q = await newOrder(c, price);
    ledger.userSubmit(q.tx as never);
    await pump(5);
    return q.order.id as string;
  };

  /** A card order, paid, opened and proven: a stashed card. */
  const cardPull = async (c: Client, code = "pokemon_25") => {
    const q = await call("POST", "/api/rip/cards", { as: c, body: { code } });
    if (q.status !== 200) throw new Error(`card: ${q.status} ${JSON.stringify(q.body)}`);
    ledger.userSubmit(q.body.tx as never);
    await pump(6);
    return q.body.order.id as string;
  };

  /** Ask to ship, sign what comes back in the wallet, and confirm: the whole way a card starts to ship. */
  const shipSigned = async (c: Client, id: string, address: unknown) => {
    const asked = await call("POST", `/api/rip/cards/${id}/ship`, { as: c, body: address });
    if (asked.status !== 200) return asked;
    ledger.userSubmit(asked.body.tx as never);
    ledger.close();
    return call("POST", `/api/rip/cards/${id}/ship`, { as: c, body: { confirm: asked.body.hash } });
  };

  /** A new server on the same log: a crash, a cold start, a second region. */
  const restart = () => {
    engine = makeEngine();
    shared.generation += 1;
    shared.rails = railsObject();
  };

  const orderOf = (id: string) => engine.state.orders.get(id);
  const cardOf = (id: string) => engine.state.cards.get(id);
  /** Payments that left the treasury to this wallet. */
  const paidTo = (address: string) => ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.tx.Destination === address && t.result === "tesSUCCESS");

  return { ledger, chain, store, once, secrets, secretWrites, gateway, call, client, pump, open, fund, newOrder, pull, cardPull, shipSigned, restart, orderOf, cardOf, paidTo, xaman, cc, state, get engine() { return engine; }, SITE };
}

let nftCounter = 0;

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export { TREASURY, VAULT, MINTER, ISSUER };
