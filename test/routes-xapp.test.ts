import assert from "node:assert/strict";
import { READ_LIMIT } from "../src/lib/rip/limits.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { encode, encodeForSigning } from "xrpl-binary-codec-prerelease";
import { deriveKeypair, sign } from "ripple-keypairs";
import { readToken, signToken } from "../src/lib/auth/tokens.ts";
import { simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { xrpCoverFor } from "../src/lib/rip/draw.ts";
import { ORDER_LEDGERS } from "../src/lib/rip/engine.ts";
import { acceptInstruction, payInstruction, payManyInstruction, trustInstruction } from "../src/lib/rip/instructions.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { VAULT, nftIdFor } from "./support-ledger.ts";
import { SECRET, addressOf, routeFiles, walletOf, world, type Client } from "./support-routes.ts";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

const PLAYER = addressOf(1);
const MALLORY = addressOf(2);
const API_KEY = "key";

/** A site with the flag on and a Xaman that answers launch tokens the way its docs say: once, only for the app that owns them. */
async function launchWorld(opts: { flag?: string; replayable?: boolean; env?: Record<string, string>; cards?: boolean; gateway?: CardGateway; treasuryXrp?: number } = {}) {
  const w = await world({ xaman: true, cards: opts.cards, gateway: opts.gateway, treasuryXrp: opts.treasuryXrp, env: { SEAL_XAPP: opts.flag ?? "on", ...opts.env } });
  const otts = new Map<string, { app: string; data: Record<string, unknown>; spent: boolean }>();
  const ottCalls: string[] = [];
  const base = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const m = /\/api\/v1\/platform\/xapp\/ott\/(.+)$/.exec(String(url));
    if (!m) return base(url as never, init);
    ottCalls.push(m[1]);
    if (w.xaman.mode === "down") throw new Error("Xaman timed out");
    const hit = otts.get(m[1]);
    const key = (init?.headers as Record<string, string>)["x-api-key"];
    if (!hit || hit.app !== key || (hit.spent && !opts.replayable)) return new Response(JSON.stringify({ error: { reference: "r", code: 404 } }), { status: 404 });
    hit.spent = true;
    return new Response(JSON.stringify(hit.data));
  }) as typeof fetch;
  const launch = (data: Record<string, unknown> = {}, app = API_KEY) => {
    const token = randomUUID();
    otts.set(token, { app, spent: false, data: { account: PLAYER, accountaccess: "FULL", nodetype: "MAINNET", user: randomUUID(), ...data } });
    return token;
  };
  /** Xaman's record of a SignIn that a wallet has signed. */
  const signedBy = (n: number) => {
    const wallet = walletOf(n);
    const keys = deriveKeypair(wallet.seed as string);
    const tx = { TransactionType: "AccountSet", Account: wallet.classicAddress, Fee: "0", Sequence: 0, SigningPubKey: keys.publicKey };
    const hex = encode({ ...tx, TxnSignature: sign(encodeForSigning(tx), keys.privateKey) });
    return { meta: { exists: true, resolved: true, signed: true }, payload: { tx_type: "SignIn" }, custom_meta: { identifier: w.xaman.calls.at(-1)?.custom_meta.identifier }, response: { hex, account: wallet.classicAddress } };
  };
  const post = (as: Client, body: unknown, origin?: string | null) => w.call("POST", "/api/auth/xapp", { as, body, origin });
  const status = (as: Client) => w.call("POST", "/api/auth/xapp/status", { as });
  return { w, launch, signedBy, post, status, ottCalls, otts };
}

const sessionOf = (c: Client) => readToken(c.jar.get("seal_session"), SECRET, ["session"], Math.floor(Date.now() / 1000));

test("flag off: every xApp route is a 404, no token reaches Xaman, and the launch cookie is ignored", async () => {
  for (const flag of ["", "off", "true", "ON"]) {
    const { w, launch, post, status, ottCalls } = await launchWorld({ flag });
    const c = w.client();
    assert.equal((await post(c, { token: launch() })).status, 404);
    assert.equal((await status(c)).status, 404);
    assert.equal((await w.call("GET", "/api/auth/xapp", { as: c })).status, 404);
    assert.deepEqual(ottCalls, []);
    assert.deepEqual(w.xaman.calls, []);
  }
});

test("flag off: a payment request keeps its return URL even with a launch cookie in the browser", async () => {
  const { w } = await launchWorld({ flag: "off" });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  me.jar.set("seal_xapp", signToken({ k: "xapp", a: PLAYER, h: "x", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET));
  await w.newOrder(me);
  assert.ok(w.xaman.calls.at(-1)?.options.return_url);
});

test("a good token opens the app on that account: no sign request, no session cookie, and the account shows", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client();
  const r = await post(c, { token: launch() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { state: "ready", account: PLAYER, proven: false });
  assert.deepEqual(w.xaman.calls, [], "nothing to sign until the player presses for it");
  assert.equal(c.jar.has("seal_session"), false);
  assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body, { session: { address: PLAYER, wallet: "xaman" } });
});

test("pressing to confirm asks for a SignIn bound to that account and network, and it makes no session until it's signed", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client();
  await post(c, { token: launch() });
  const r = await post(c, {});
  assert.equal(r.body.state, "sign");
  assert.equal(typeof r.body.uuid, "string");
  assert.equal(r.body.session, undefined);
  assert.equal(c.jar.has("seal_session"), false);
  const sent = w.xaman.calls.at(-1)!;
  assert.deepEqual(sent.txjson, { TransactionType: "SignIn" });
  assert.deepEqual(sent.options, { submit: false, expire: 5, signers: [PLAYER], force_network: "MAINNET" });
});

test("the launch cookie is httpOnly and says only that Xaman confirmed this launch", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client();
  const r = await post(c, { token: launch() });
  const cookie = r.setCookies.find((s) => s.startsWith("seal_xapp="))!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
  assert.deepEqual((await w.call("GET", "/api/auth/xapp", { as: c })).body, { xapp: true, account: PLAYER, proven: false, network: "MAINNET" });
  assert.deepEqual((await w.call("GET", "/api/auth/xapp", { as: w.client() })).body, { xapp: false, account: null, proven: false, network: null });
});

test("the right signature makes exactly today's session; the response never carries a token", async () => {
  const { w, launch, signedBy, post, status } = await launchWorld();
  const c = w.client();
  await post(c, { token: launch() });
  await post(c, {});
  assert.deepEqual((await status(c)).body, { state: "pending" });
  w.xaman.payload = signedBy(1);
  const done = await status(c);
  assert.deepEqual(done.body, { state: "signed", session: { address: PLAYER, wallet: "xaman" } });
  assert.deepEqual(Object.keys(sessionOf(c)!).sort(), ["a", "exp", "k", "w"]);
  assert.equal(c.jar.has("seal_challenge"), false);
  assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body, { session: { address: PLAYER, wallet: "xaman" } });
  await w.open();
  w.ledger.fund(PLAYER, 500);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } })).status, 200);
});

test("signer differs from the launch's account: no session, and the spent request can't be cashed in anywhere", async () => {
  const { w, launch, signedBy, post, status } = await launchWorld();
  const c = w.client();
  await post(c, { token: launch() });
  await post(c, {});
  const challenge = c.jar.get("seal_challenge")!;
  w.xaman.payload = signedBy(2);
  assert.deepEqual((await status(c)).body, { state: "wrong-account" });
  assert.equal(c.jar.has("seal_session"), false);
  assert.equal(c.jar.has("seal_challenge"), false);
  // The same signed request, replayed through either way in, is used.
  c.jar.set("seal_challenge", challenge);
  assert.deepEqual((await status(c)).body, { state: "used" });
  assert.deepEqual((await w.call("POST", "/api/auth/xaman/status", { as: c })).body, { state: "used" });
  assert.equal(c.jar.has("seal_session"), false);
});

test("a patched Xaman naming the owner's address gets no session, so no admin, and no ship or sale: only a real signature could", async () => {
  const { w, launch, post, status, signedBy } = await launchWorld();
  process.env.SEAL_ADMIN_ADDRESSES = PLAYER;
  const attacker = w.client();
  const r = await post(attacker, { token: launch({ account: PLAYER, accountaccess: "FULL" }) });
  assert.equal(r.body.state, "ready");
  assert.equal((await post(attacker, {})).body.state, "sign");
  w.xaman.payload = signedBy(2);
  assert.deepEqual((await status(attacker)).body, { state: "wrong-account" });
  assert.equal(sessionOf(attacker), null);
  assert.equal((await w.call("POST", "/api/rip/admin/mark-shipped", { as: attacker, body: {} })).status, 404);
});

test("forged token: refused, no cookies, no request, and an older session here is cleared", async () => {
  const { w, post } = await launchWorld();
  const c = w.client(PLAYER);
  c.jar.set("seal_xapp", signToken({ k: "xapp", a: PLAYER, h: "other", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET));
  const r = await post(c, { token: randomUUID() });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { state: "invalid" });
  assert.equal(c.jar.has("seal_session"), false);
  assert.equal(c.jar.has("seal_xapp"), false);
  assert.deepEqual(w.xaman.calls, []);
});

test("replay: a second browser gets nothing, whether Xaman refuses it or, on a debug device, answers again", async () => {
  for (const replayable of [false, true]) {
    const { w, launch, post } = await launchWorld({ replayable });
    const token = launch();
    assert.equal((await post(w.client(), { token })).body.state, "ready");
    const thief = w.client();
    const again = await post(thief, { token });
    assert.equal(again.status, 403);
    assert.equal(again.body.state, replayable ? "used" : "invalid");
    assert.equal(thief.jar.has("seal_xapp"), false);
    assert.equal(thief.jar.has("seal_challenge"), false);
    assert.equal(w.xaman.calls.length, 0);
  }
});

test("expired: Xaman's refusal after its minute is a plain refusal", async () => {
  const { w, launch, post, otts } = await launchWorld();
  const token = launch();
  otts.get(token)!.spent = true;
  const c = w.client();
  assert.deepEqual((await post(c, { token })).body, { state: "invalid" });
  assert.equal(c.jar.has("seal_xapp"), false);
});

test("a token from another app: Xaman won't answer our key for it, so nothing happens", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client();
  const r = await post(c, { token: launch({}, "another-apps-key") });
  assert.equal(r.status, 403);
  assert.equal(r.body.state, "invalid");
  assert.deepEqual(w.xaman.calls, []);
});

test("wrong network, read-only, no account: refused with the reason, and any older session is cleared", async () => {
  const { w, launch, post } = await launchWorld();
  for (const [data, state] of [[{ nodetype: "TESTNET" }, "wrong-network"], [{ nodetype: "XAHAU" }, "wrong-network"], [{ accountaccess: "READONLY" }, "read-only"], [{ accountaccess: "readonly" }, "read-only"], [{ accountaccess: undefined }, "read-only"], [{ account: undefined }, "no-account"], [{ account: "rNope" }, "no-account"]] as const) {
    const c = w.client(PLAYER);
    const r = await post(c, { token: launch(data) });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { state });
    assert.equal(c.jar.has("seal_session"), false, state);
    assert.equal(c.jar.has("seal_xapp"), false, state);
  }
  assert.deepEqual(w.xaman.calls, []);
});

test("a session for another account doesn't survive a launch; one for this account skips the signature", async () => {
  const { w, launch, post } = await launchWorld();
  const other = w.client(MALLORY);
  assert.deepEqual((await post(other, { token: launch() })).body, { state: "ready", account: PLAYER, proven: false });
  assert.equal(other.jar.has("seal_session"), false);
  const same = w.client(PLAYER);
  const before = w.xaman.calls.length;
  assert.deepEqual((await post(same, { token: launch() })).body, { state: "ready", account: PLAYER, proven: true });
  assert.equal(w.xaman.calls.length, before);
  assert.equal(sessionOf(same)?.a, PLAYER);
});

test("reloading the page: no second call to Xaman, and still no session without a signature", async () => {
  const { w, launch, post, ottCalls } = await launchWorld();
  const c = w.client();
  const token = launch();
  await post(c, { token });
  const r = await post(c, { token });
  assert.equal(r.body.state, "ready");
  assert.equal(ottCalls.length, 1);
  assert.equal(c.jar.has("seal_session"), false);
});

test("asking again uses the launch cookie and needs no token; without the cookie it's refused and changes nothing", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client();
  await post(c, { token: launch() });
  assert.equal((await post(c, {})).body.state, "sign");
  assert.equal(w.xaman.calls.at(-1)!.options.signers[0], PLAYER);
  const plain = w.client(PLAYER);
  assert.deepEqual((await post(plain, {})).body, { state: "invalid" });
  assert.equal(plain.jar.has("seal_session"), true, "an ordinary browser's session is untouched");
});

test("Xaman down at launch: 502, nothing confirmed, nothing kept", async () => {
  const { w, launch, post } = await launchWorld();
  w.xaman.mode = "down";
  const c = w.client(MALLORY);
  const r = await post(c, { token: launch() });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { state: "unavailable" });
  assert.equal(c.jar.has("seal_session"), false);
  assert.equal(c.jar.has("seal_xapp"), false);
});

test("Xaman down when the player presses to confirm: the launch is kept and they can try again without a token", async () => {
  const { w, launch, post } = await launchWorld();
  const base = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => (String(u).endsWith("/payload") ? new Response("{}", { status: 503 }) : base(u as never, init))) as typeof fetch;
  const c = w.client();
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  assert.deepEqual((await post(c, {})).body, { state: "retry" });
  assert.equal(c.jar.has("seal_xapp"), true);
  globalThis.fetch = base;
  assert.equal((await post(c, {})).body.state, "sign");
});

test("another site can't start a launch: a missing or foreign origin stops before Xaman", async () => {
  const { w, launch, post, ottCalls } = await launchWorld();
  const c = w.client(PLAYER);
  for (const origin of ["https://evil.test", null]) {
    assert.equal((await post(c, { token: launch() }, origin)).status, 403);
    assert.equal((await w.call("POST", "/api/auth/xapp/status", { as: c, origin })).status, 403);
  }
  assert.deepEqual(ottCalls, []);
  assert.equal(c.jar.has("seal_session"), true);
});

test("the status route needs both cookies: a challenge with no launch signs no one in", async () => {
  const { w, launch, signedBy, post, status } = await launchWorld();
  const c = w.client();
  await post(c, { token: launch() });
  w.xaman.payload = signedBy(1);
  c.jar.delete("seal_xapp");
  assert.deepEqual((await status(c)).body, { state: "expired" });
  assert.equal(c.jar.has("seal_session"), false);
});

test("inside the xApp a payment request has no return URL; the same order elsewhere is unchanged", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const c = w.client();
  await post(c, { token: launch() });
  w.ledger.fund(PLAYER, 500);
  const made = await w.newOrder(c);
  const inside = w.xaman.calls.at(-1)!;
  assert.deepEqual(inside.options, { submit: true, expire: 5, force_network: "MAINNET", signers: [PLAYER] });
  assert.equal((made.wallet as { uuid: string }).uuid.length > 0, true);
  const browser = w.client(MALLORY);
  w.fund(browser);
  const elsewhere = await w.newOrder(browser);
  const url = `${w.SITE}/open/rip_${elsewhere.order.id}`;
  assert.deepEqual(w.xaman.calls.at(-1)!.options, { submit: true, expire: 5, force_network: "MAINNET", signers: [MALLORY], return_url: { app: url, web: url } });
});

test("inside the xApp the ledger is still the only proof: a claimed signature does nothing, and a wrong signer is refunded", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const c = w.client();
  await post(c, { token: launch() });
  w.ledger.fund(PLAYER, 500);
  const made = await w.newOrder(c);
  // Xaman's "signed" event reaching the page, or anything the page says, moves nothing. Only the ledger does.
  await w.pump(2);
  assert.equal(w.orderOf(made.order.id)?.status, "quoted");
  w.fund(w.client(MALLORY));
  const before = w.ledger.balance(MALLORY);
  w.ledger.userSubmit({ ...made.tx, Account: MALLORY } as never);
  await w.pump(3);
  assert.equal(before - w.ledger.balance(MALLORY), 12n);
  assert.equal(w.orderOf(made.order.id)?.status, "quoted");
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
});

test("an ordinary sign-in is unaffected with the flag on: same answers, no launch cookie", async () => {
  const { w, signedBy } = await launchWorld();
  const c = w.client();
  const start = await w.call("POST", "/api/auth/xaman/start", { as: c, origin: w.SITE });
  assert.ok(start.body.qr && start.body.open && start.body.ws);
  assert.equal(c.jar.has("seal_xapp"), false);
  assert.ok(w.xaman.calls.at(-1)!.options.return_url);
  w.xaman.payload = signedBy(1);
  assert.deepEqual((await w.call("POST", "/api/auth/xaman/status", { as: c })).body, { state: "signed", session: { address: PLAYER, wallet: "xaman" } });
});

/** What a response looks like with the values that differ every run taken out. */
const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && ["state", "error", "code"].includes(k) ? x : shape(x)]));
  return typeof v;
};
const cookieShape = (c: string) => c.replace(/^([^=]+)=[^;]*/, "$1").replace(/Expires=[^;]+;?\s*/i, "");

test("with the flag on, a browser that never launched from Xaman walks the same web path with the same answers and cookies", async () => {
  const walk = async (flag: string) => {
    const { w, signedBy } = await launchWorld({ flag });
    await w.open();
    const c = w.client();
    const seen: unknown[] = [];
    const note = (r: { status: number; body: unknown; setCookies: string[] }) => seen.push({ status: r.status, body: shape(r.body), cookies: r.setCookies.map(cookieShape) });
    note(await w.call("GET", "/api/auth/config", { as: c }));
    note(await w.call("GET", "/api/auth/session", { as: c }));
    note(await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } }));
    note(await w.call("POST", "/api/auth/xaman/start", { as: c, body: { to: "/packs" }, origin: w.SITE }));
    note(await w.call("POST", "/api/auth/xaman/status", { as: c }));
    w.xaman.payload = signedBy(1);
    const done = await w.call("POST", "/api/auth/xaman/status", { as: c });
    assert.equal(done.body.state, "signed");
    note(done);
    note(await w.call("GET", "/api/auth/session", { as: c }));
    w.ledger.fund(PLAYER, 500);
    const order = await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } });
    assert.equal(order.status, 200);
    note(order);
    note(await w.call("POST", "/api/rip/wallet-request", { as: c, body: { uuid: "11111111-2222-4333-8444-555555555555" } }));
    note(await w.call("POST", "/api/auth/logout", { as: c }));
    note(await w.call("GET", "/api/auth/session", { as: c }));
    assert.equal(c.jar.has("seal_xapp"), false);
    return { seen, requests: w.xaman.calls.map((x) => ({ txjson: Object.keys(x.txjson).sort(), options: JSON.parse(JSON.stringify({ ...x.options, signers: x.options.signers?.length }).replace(/rip_[0-9a-f]+/g, "rip_ID")) })), jar: [...c.jar.keys()].sort() };
  };
  assert.deepEqual(await walk("on"), await walk("off"));
});

test("a launch for another account: the older session doesn't stay behind, and the launch's account is who shows", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client(MALLORY);
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  assert.equal(c.jar.has("seal_session"), false);
  assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body, { session: { address: PLAYER, wallet: "xaman" } });
});

test("Xaman down when asking again: a session for this very account stands and asks for nothing", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client(PLAYER);
  assert.deepEqual((await post(c, { token: launch() })).body, { state: "ready", account: PLAYER, proven: true });
  w.xaman.mode = "down";
  assert.equal((await post(c, {})).body.state, "signed");
  assert.equal(c.jar.has("seal_session"), true);
});

test("signing out ends the launch too: nothing stays behind in a browser that used it", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const c = w.client(PLAYER);
  await post(c, { token: launch() });
  assert.equal(sessionOf(c)?.a, PLAYER);
  await w.call("POST", "/api/auth/logout", { as: c });
  assert.equal(c.jar.has("seal_session"), false);
  assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body, { session: null });
  assert.equal(c.jar.has("seal_xapp"), false);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } })).status, 401);
  assert.deepEqual((await post(c, {})).body, { state: "invalid" });
});

async function xappSession(env: Record<string, string> = {}) {
  const made = await launchWorld({ env });
  const { w, launch, signedBy, post, status } = made;
  await w.open();
  w.ledger.fund(PLAYER, 500);
  const c = w.client();
  await post(c, { token: launch() });
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  return { ...made, c };
}

test("an xApp session gets no way around the gates: places, terms, the wallet list, the rate limit and admin", async () => {
  const { w, c } = await xappSession({ SEAL_ADMIN_ADDRESSES: MALLORY });
  const place = await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 }, headers: { "x-vercel-ip-country": "IR" } });
  assert.equal(place.status, 403);
  assert.equal(place.body.code, "place_restricted");
  const terms = await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5, acceptedTerms: false } });
  assert.equal(terms.status, 400);
  assert.equal(terms.body.code, "terms_required");
  assert.equal(w.engine.state.orders.size, 0);
  for (const [route, body] of [["/api/rip/admin/mark-shipped", {}], ["/api/rip/admin/resolve-card", {}], ["/api/rip/admin/retry-refund", {}]] as const) {
    assert.ok([403, 404].includes((await w.call("POST", route, { as: c, body })).status), route);
  }
  let limited = 0;
  for (let i = 0; i < READ_LIMIT + 10; i++) if ((await w.call("POST", "/api/rip/wallet-request", { as: c, body: { uuid: "not-a-uuid" } })).status === 429) limited += 1;
  assert.equal(limited, 10, "the same limit as any other session");

  const shut = await xappSession({ SEAL_ALLOWED_WALLETS: MALLORY });
  const refused = await shut.w.call("POST", "/api/rip/orders", { as: shut.c, body: { price: 5 } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "not_open");
});

test("inside the xApp a request opens by itself, so a stored push token isn't used and nothing is pushed", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const c = w.client();
  await post(c, { token: launch() });
  w.ledger.fund(PLAYER, 500);
  await w.secrets.put(`xaman-user-token:${PLAYER}`, "11111111-2222-4333-8444-555555555555");
  const made = await w.newOrder(c);
  assert.equal(w.xaman.calls.at(-1)!.user_token, undefined);
  assert.equal((made.wallet as { pushed: boolean }).pushed, false);
});

/** A real pull by the player, signed and on the ledger, then a phone that only has a launch naming that player. */
async function launchOnly() {
  const made = await launchWorld();
  const { w, launch, post } = made;
  await w.open();
  const owner = w.client(PLAYER);
  w.fund(owner);
  const id = await w.pull(owner);
  const c = w.client();
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  return { ...made, c, id, owner };
}

test("a launch shows that account's items and pending count, with nothing to sign", async () => {
  const { w, c, id } = await launchOnly();
  const held = await w.call("GET", "/api/rip/holdings", { as: c });
  assert.equal(held.status, 200);
  assert.deepEqual(held.body.orders.map((o: { id: string }) => o.id), [id]);
  assert.equal((await w.call("GET", `/api/rip/orders/${id}`, { as: c })).body.mine, true);
  assert.equal((await w.call("GET", "/api/rip/pending", { as: c })).status, 200);
});

test("a launch can't sell or redeem: a patched Xaman naming a victim moves nothing, until a real signature", async () => {
  const { w, c, id, post, status, signedBy } = await launchOnly();
  const paidBefore = w.ledger.balance(PLAYER);
  const quote = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: c });
  assert.equal(quote.status, 200, "a price is only a read");
  const sold = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: c, body: { drops: quote.body.drops } });
  assert.equal(sold.status, 401);
  assert.equal(sold.body.code, "confirm_account");
  const redeemed = await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: c });
  assert.equal(redeemed.status, 401);
  assert.equal(redeemed.body.code, "confirm_account");
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  assert.equal(w.ledger.balance(PLAYER), paidBefore);
  // A signature from anyone else changes nothing.
  await post(c, {});
  w.xaman.payload = signedBy(2);
  assert.deepEqual((await status(c)).body, { state: "wrong-account" });
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: c, body: { drops: quote.body.drops } })).status, 401);
  // The account's own signature is what lets it through.
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  assert.deepEqual((await w.call("GET", "/api/auth/xapp", { as: c })).body.proven, true);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: c, body: { drops: quote.body.drops } })).status, 200);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "sold");
});

test("a launch opens an order the account must sign itself: a hold names it, nothing is charged, and no one else's wallet counts", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  w.fund(w.client(PLAYER));
  const c = w.client();
  await post(c, { token: launch() });
  const before = w.ledger.balance(PLAYER);
  const made = await w.newOrder(c);
  assert.equal(made.tx.Account, PLAYER);
  const sent = w.xaman.calls.at(-1)!;
  assert.deepEqual(sent.options.signers, [PLAYER]);
  await w.pump(3);
  assert.equal(w.orderOf(made.order.id)?.status, "quoted");
  assert.equal(w.ledger.balance(PLAYER), before);
  w.fund(w.client(MALLORY));
  w.ledger.userSubmit({ ...made.tx, Account: MALLORY } as never);
  await w.pump(3);
  assert.equal(w.orderOf(made.order.id)?.status, "quoted");
});

test("a confirmed launch claims only to itself: the offer waits for that wallet's own accept", async () => {
  const { w, c, id, post, status, signedBy } = await launchOnly();
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  let r = await w.call("POST", `/api/rip/orders/${id}/claim`, { as: c });
  for (let i = 0; i < 6 && r.status === 200 && !r.body.tx; i++) {
    await w.pump(2);
    r = await w.call("POST", `/api/rip/orders/${id}/claim`, { as: c });
  }
  assert.equal(r.status, 200);
  assert.equal(r.body.tx.TransactionType, "NFTokenAcceptOffer");
  assert.equal(r.body.tx.Account, PLAYER);
  assert.deepEqual(w.xaman.calls.at(-1)!.options.signers, [PLAYER]);
  assert.match(w.xaman.calls.at(-1)!.custom_meta.instruction, /Accept your NFT/);
});

test("which routes a launch alone can reach is a short, fixed list: a new route is signature-only unless it's added here", () => {
  const launchRoutes = routeFiles().filter((route) => /launch: true/.test(readFileSync(join(SRC_DIR, `app${route}/route.ts`), "utf8")));
  assert.deepEqual(launchRoutes, [
    "/api/rip/bundles",
    "/api/rip/cards",
    "/api/rip/cards/[id]/claim",
    "/api/rip/cards/[id]/sell",
    "/api/rip/orders",
    "/api/rip/orders/[id]/claim",
    "/api/rip/orders/[id]/sell",
    "/api/rip/payouts",
    "/api/rip/wallet-request",
  ]);
  assert.match(readFileSync(join(SRC_DIR, "app/api/rip/payouts/route.ts"), "utf8"), /if \(!g\.proven\) return needsProof\(\);/);
  assert.match(readFileSync(join(SRC_DIR, "app/api/rip/bundles/route.ts"), "utf8"), /const unproven = !g\.proven/);
  for (const sell of ["orders", "cards"]) assert.match(readFileSync(join(SRC_DIR, `app/api/rip/${sell}/[id]/sell/route.ts`), "utf8"), /if \(!g\.proven\) return needsProof\(\);/);
  for (const strict of ["/api/rip/orders/[id]/redeem", "/api/rip/orders/[id]/claim/cancel", "/api/rip/cards/[id]/claim/cancel", "/api/rip/cards/[id]/ship", "/api/rip/admin/mark-shipped", "/api/rip/admin/resolve-card", "/api/rip/admin/retry-refund"]) assert.ok(!launchRoutes.includes(strict), strict);
  // What's left has to pass the launch's weakness on to whatever would act on it.
  assert.match(readFileSync(join(SRC_DIR, "app/api/rip/orders/[id]/claim/route.ts"), "utf8"), /engine\.claim\(g\.address, id, g\.proven\)/);
  assert.match(readFileSync(join(SRC_DIR, "app/api/rip/cards/[id]/claim/route.ts"), "utf8"), /engine\.claimCard\(g\.address, id, g\.proven\)/);
  assert.match(readFileSync(join(SRC_DIR, "app/api/rip/orders/route.ts"), "utf8"), /unproven: !g\.proven/);
  assert.match(readFileSync(join(SRC_DIR, "app/api/rip/cards/route.ts"), "utf8"), /unproven: !g\.proven/);
});

test("what a sign request says: what it does, what it costs and why, within Xaman's 280 characters, for every price", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000_000_000 }), fc.constantFrom("nft", "card") as fc.Arbitrary<"nft" | "card">, fc.constantFrom("mainnet", "testnet"), (drops, kind, mode) => {
      const pay = payInstruction(String(drops), kind, mode);
      assert.ok(pay.length <= 280);
      assert.ok(pay.includes(`Pay ${drops / 1e6} XRP`));
      assert.match(pay, /third-party/);
      assert.match(pay, /random/);
      assert.match(pay, /less than you paid/);
      assert.equal(/testnet/i.test(pay), mode === "testnet");
      const accept = acceptInstruction(kind, mode);
      assert.ok(accept.length <= 280);
      assert.match(accept, /free/);
      assert.equal(/testnet/i.test(accept), mode === "testnet");
    }),
  );
  assert.ok(trustInstruction("SEAL").length <= 280);
});

test("every sign request a player can reach carries its instruction to Xaman: checkout and accept included", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  w.fund(w.client(PLAYER));
  const c = w.client();
  await post(c, { token: launch() });
  const made = await w.newOrder(c);
  const pay = w.xaman.calls.at(-1)!;
  assert.equal(pay.custom_meta.instruction, payInstruction(String(made.tx.Amount), "nft", "mainnet"));
  assert.deepEqual(pay.txjson, made.tx, "the transaction itself is untouched");
  await post(c, {});
  assert.match(w.xaman.calls.at(-1)!.custom_meta.instruction, /moves no funds/);
});

/**
 * The audit of 01abc6f8d. Anyone can get a launch naming anyone, so each of these is a stranger holding a launch that names a real
 * player, or any funded account they picked off the ledger. Each fix was seen failing on 1f2ab6b47 first.
 */
const CONFIRM = { status: 401, code: "confirm_account" };
const refusedForProof = (r: { status: number; body: Record<string, unknown> }) => assert.deepEqual({ status: r.status, code: r.body.code }, CONFIRM);
const THIEF_ADDRESS = { name: "Mallory Thief", street: "9 Dark Alley", city: "Elsewhere", zip: "00000" };
/** The most holds, per pack, that a launch's word can take at once. Past that the player confirms, and the pack stays open. */
const LAUNCH_HOLDS = 3;

/** Open a claim as the real owner and wait until the offer is on the ledger. */
async function ownerOffer(w: Awaited<ReturnType<typeof world>>, owner: Client, path: string) {
  let r = await w.call("POST", `${path}/claim`, { as: owner });
  for (let i = 0; i < 8 && r.status === 200 && !r.body.tx; i++) {
    await w.pump(2);
    r = await w.call("POST", `${path}/claim`, { as: owner });
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.tx);
  return r.body.tx as Record<string, unknown>;
}

/** A launch naming the real owner of a stashed card. */
async function launchOnlyCard() {
  const made = await launchWorld({ cards: true });
  const { w, launch, post } = made;
  await w.engine.advance();
  const owner = w.client(PLAYER);
  w.fund(owner);
  const id = await w.cardPull(owner);
  assert.equal(w.cardOf(id)?.hold, "stashed");
  const c = w.client();
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  return { ...made, c, id, owner };
}

test("audit: a launch naming a victim can't start a claim, so the vault makes no offer and spends no reserve", async () => {
  const { w, c, id } = await launchOnly();
  refusedForProof(await w.call("POST", `/api/rip/orders/${id}/claim`, { as: c }));
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenCreateOffer").length, 0);
});

test("audit: a launch naming a victim can't cancel the victim's open offer out from under their accept", async () => {
  const { w, c, id, owner } = await launchOnly();
  const accept = await ownerOffer(w, owner, `/api/rip/orders/${id}`);
  refusedForProof(await w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: c }));
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "offered");
  w.ledger.userSubmit(accept as never);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "claimed");
});

test("audit: a launch naming a victim can't make a mirror of the victim's card, or take back an open one", async () => {
  const { w, c, id, owner } = await launchOnlyCard();
  refusedForProof(await w.call("POST", `/api/rip/cards/${id}/claim`, { as: c }));
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "stashed");
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenMint").length, 0);
  await ownerOffer(w, owner, `/api/rip/cards/${id}`);
  assert.equal(w.cardOf(id)?.hold, "offered");
  refusedForProof(await w.call("POST", `/api/rip/cards/${id}/claim/cancel`, { as: c }));
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "offered");
});

test("audit: an offer already open needs only the wallet's own accept: a launch gets the transaction, nothing else changes", async () => {
  const nft = await launchOnly();
  await ownerOffer(nft.w, nft.owner, `/api/rip/orders/${nft.id}`);
  const before = nft.w.engine.state.head;
  const r = await nft.w.call("POST", `/api/rip/orders/${nft.id}/claim`, { as: nft.c });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.tx.TransactionType, r.body.tx.Account], ["NFTokenAcceptOffer", PLAYER]);
  assert.deepEqual(nft.w.xaman.calls.at(-1)!.options.signers, [PLAYER]);
  assert.equal(nft.w.orderOf(nft.id)?.pull, "offered");
  assert.ok(nft.w.engine.state.head - before < 3, "no claim was opened");
  const card = await launchOnlyCard();
  await ownerOffer(card.w, card.owner, `/api/rip/cards/${card.id}`);
  const accept = await card.w.call("POST", `/api/rip/cards/${card.id}/claim`, { as: card.c });
  assert.equal(accept.status, 200);
  assert.deepEqual([accept.body.tx.TransactionType, accept.body.tx.Account], ["NFTokenAcceptOffer", PLAYER]);
});

test("audit: the account's own confirm is what starts a claim and takes it back, and the offer can only be for that account", async () => {
  const { w, c, id, post, status, signedBy } = await launchOnly();
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  await ownerOffer(w, c, `/api/rip/orders/${id}`);
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenCreateOffer").at(-1)?.tx.Destination, PLAYER);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: c })).status, 200);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "stashed");
});

test("audit: a launch can't put an address under a victim's card or ask them to approve it: nothing stored, nothing sent to Xaman", async () => {
  const { w, c, id } = await launchOnlyCard();
  const writes = w.secretWrites.length;
  const calls = w.xaman.calls.length;
  refusedForProof(await w.call("POST", `/api/rip/cards/${id}/ship`, { as: c, body: THIEF_ADDRESS }));
  assert.deepEqual(w.secretWrites.slice(writes), []);
  assert.equal(w.xaman.calls.length, calls, "no request for the victim to be talked into signing");
  refusedForProof(await w.call("POST", `/api/rip/cards/${id}/ship`, { as: c, body: { confirm: "a".repeat(64) } }));
  assert.equal(w.cardOf(id)?.hold, "stashed");
});

test("audit: a confirmed account ships as ever: its address, its signature, and the launch never sees another's", async () => {
  const { w, c, id, post, status, signedBy, owner } = await launchOnlyCard();
  // The real owner asked for a shipment on the web and hasn't signed. Nothing a launch does can read or replace it.
  const mine = await w.call("POST", `/api/rip/cards/${id}/ship`, { as: owner, body: { name: "Pat Holder", street: "1 Main St", city: "Springfield", zip: "62701" } });
  assert.equal(mine.status, 200);
  const stored = await w.secrets.get(`ship:${id}:${mine.body.hash}`);
  refusedForProof(await w.call("POST", `/api/rip/cards/${id}/ship`, { as: c, body: { confirm: mine.body.hash } }));
  assert.equal(await w.secrets.get(`ship:${id}:${mine.body.hash}`), stored);
  assert.equal(JSON.stringify((await w.call("GET", `/api/rip/cards/${id}`, { as: c })).body).includes("Main St"), false);
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  const done = await w.shipSigned(c, id, { name: "Pat Holder", street: "2 Main St", city: "Springfield", zip: "62701" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(w.cardOf(id)?.hold, "ship_queue");
});

test("audit: a stranger burning holds in a victim's name doesn't lock the victim out: their own sign-in still buys", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const owner = w.client(PLAYER);
  w.fund(owner);
  const stranger = w.client();
  await post(stranger, { token: launch() });
  let lapsed = 0;
  for (let i = 0; i < 6; i++) {
    const r = await w.call("POST", "/api/rip/orders", { as: stranger, body: { price: 5 } });
    if (r.status === 200) lapsed += 1;
    w.ledger.close(ORDER_LEDGERS + 2);
    await w.engine.advance();
  }
  assert.ok(lapsed >= 3);
  const bought = await w.call("POST", "/api/rip/orders", { as: owner, body: { price: 5 } });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
});

test("audit: past a named wallet's own three lapses, a launch asks for the confirm rather than saying the wallet is out", async () => {
  const { w, launch, post, status, signedBy } = await launchWorld();
  await w.open();
  w.fund(w.client(PLAYER));
  const c = w.client();
  await post(c, { token: launch() });
  let last = await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } });
  for (let i = 0; i < 6 && last.status === 200; i++) {
    w.ledger.close(ORDER_LEDGERS + 2);
    await w.engine.advance();
    last = await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } });
  }
  refusedForProof(last);
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  assert.equal((await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } })).status, 200);
});

test("audit: holds on a launch's word never take the owner's own open-checkout slots", async () => {
  const { w } = await launchWorld();
  await w.open();
  await w.open(10, "8000000");
  await w.open(25, "20000000");
  await w.open(50, "40000000");
  w.fund(w.client(PLAYER));
  for (const price of [5, 10, 25] as const) assert.ok((await w.engine.createOrder(PLAYER, price, 1.25, { unproven: true })).ok);
  const own = await w.engine.createOrder(PLAYER, 50, 1.25);
  assert.equal(own.ok, true, JSON.stringify(own));
});

test("audit: no number of funded accounts named in launches can close a pack: the holds stop at the cap and a signed-in buyer still gets in", async () => {
  const stockAt = [[8, 6, 4, 3, 2], [40, 30, 20, 10, 10], [3, 2, 2, 2, 1], [2, 1, 1, 1, 1]] as const;
  for (const [i, stock] of stockAt.entries()) {
    const { w, launch, post } = await launchWorld();
    await w.open(5, "4000000", stock);
    const seen: number[] = [];
    for (let n = 20; n < 60; n++) {
      const named = addressOf(n);
      w.ledger.fund(named, 50);
      const c = w.client();
      assert.equal((await post(c, { token: launch({ account: named }) })).body.state, "ready");
      const r = await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } });
      seen.push(r.status);
      if (r.status !== 200) refusedForProof(r);
    }
    assert.ok(seen.filter((s) => s === 200).length <= LAUNCH_HOLDS);
    if (i < 2) assert.equal(seen.filter((s) => s === 200).length, LAUNCH_HOLDS);
    const buyer = w.client(MALLORY);
    w.fund(buyer);
    const bought = await w.call("POST", "/api/rip/orders", { as: buyer, body: { price: 5 } });
    assert.equal(bought.status, 200, `${stock}: ${JSON.stringify(bought.body)}`);
    assert.ok(replayLog(await w.store.readFrom(0)).ok, "the log with these on it still replays");
  }
});

test("audit: a launch's hold can't take the treasury's last cover for a prize either", async () => {
  const table = [{ band: 0, token: "XRP", bps: 500, valueDrops: "4000000" }];
  const bandBps = [10_000, 0, 0, 0, 0];
  const cover = (n: number) => Number(xrpCoverFor(table, bandBps, n)) / 1e6;
  assert.ok(cover(2) > cover(1));
  // Enough over the floor for one place's prizes and not for two.
  const { w, launch, post } = await launchWorld({ treasuryXrp: 10 + (cover(1) + cover(2)) / 2 });
  await w.engine.openSeason(5, "4000000", w.state.rate, { bandBps, prizeTable: table, tokens: [] });
  const adds = Array.from({ length: 25 }, (_, i) => {
    const nftId = nftIdFor(90_000 + i);
    w.ledger.mintTo(nftId, VAULT);
    return { nftId, band: i % 5, collection: "c", name: `n${i}`, img: "/x.webp", costDrops: "2000000", markDrops: "3000000" };
  });
  await w.engine.changePool(5, adds);
  await w.pump(4);
  w.fund(w.client(PLAYER));
  const c = w.client();
  await post(c, { token: launch() });
  refusedForProof(await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5 } }));
  const buyer = w.client(MALLORY);
  w.fund(buyer);
  const bought = await w.call("POST", "/api/rip/orders", { as: buyer, body: { price: 5 } });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
});

test("audit: a launch's hold can't take the last of the card float", async () => {
  const { w, launch, post } = await launchWorld({ cards: true, gateway: simulatedGateway({ floatMicro: 60_000_000n }) });
  await w.engine.advance();
  const named = (n: number) => {
    w.ledger.fund(addressOf(n), 500);
    return launch({ account: addressOf(n) });
  };
  const first = w.client();
  await post(first, { token: named(20) });
  assert.equal((await w.call("POST", "/api/rip/cards", { as: first, body: { code: "pokemon_25" } })).status, 200);
  const second = w.client();
  await post(second, { token: named(21) });
  refusedForProof(await w.call("POST", "/api/rip/cards", { as: second, body: { code: "pokemon_25" } }));
  const buyer = w.client(MALLORY);
  w.fund(buyer);
  const bought = await w.call("POST", "/api/rip/cards", { as: buyer, body: { code: "pokemon_25" } });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
});

test("audit, property: however launches and sign-ins interleave, launch holds stay at the cap and every sign-in the pack can take gets a place", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.integer({ min: 20, max: 60 }), fc.boolean()), { minLength: 8, maxLength: 16 }), async (steps) => {
      const { w } = await launchWorld();
      await w.open(5, "4000000", [20, 20, 20, 20, 20]);
      const onWord = new Set<string>();
      for (const [n, unproven] of steps) {
        w.ledger.fund(addressOf(n), 50);
        const known = new Set(w.engine.state.orders.keys());
        const made = await w.engine.createOrder(addressOf(n), 5, 1.25, { unproven });
        if (!unproven) assert.ok(made.ok, JSON.stringify(made));
        else if (!made.ok) assert.equal(made.code, "confirm_account");
        else if (!known.has(made.order.id)) onWord.add(made.order.id);
      }
      assert.ok(onWord.size <= LAUNCH_HOLDS, `${onWord.size} holds on a launch's word`);
    }),
    { numRuns: 12 },
  );
});

test("audit: a launch can't drain the card float for everyone: its holds stop at the cap, and a signed-in buyer still gets in", async () => {
  const { w, launch, post } = await launchWorld({ cards: true });
  await w.engine.advance();
  const seen: number[] = [];
  for (let n = 20; n < 45; n++) {
    const named = addressOf(n);
    w.ledger.fund(named, 500);
    const c = w.client();
    await post(c, { token: launch({ account: named }) });
    const r = await w.call("POST", "/api/rip/cards", { as: c, body: { code: "pokemon_25" } });
    seen.push(r.status);
    if (r.status !== 200) refusedForProof(r);
  }
  assert.equal(seen.filter((s) => s === 200).length, LAUNCH_HOLDS);
  const buyer = w.client(MALLORY);
  w.fund(buyer);
  const bought = await w.call("POST", "/api/rip/cards", { as: buyer, body: { code: "pokemon_25" } });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
});

test("audit: the terms record says whether a signature stood behind the accepting account", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const buyer = w.client(MALLORY);
  w.fund(buyer);
  const signed = await w.newOrder(buyer);
  assert.equal(JSON.parse((await w.secrets.get(`terms:order:${signed.order.id}`))!).proven, true);
  w.fund(w.client(PLAYER));
  const c = w.client();
  await post(c, { token: launch() });
  const named = await w.newOrder(c);
  assert.equal(JSON.parse((await w.secrets.get(`terms:order:${named.order.id}`))!).proven, false);
});

test("audit: a stranger's launch can't overwrite the terms a signed-in buyer accepted on the same open order", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  const owner = w.client(PLAYER);
  w.fund(owner);
  const made = await w.newOrder(owner);
  const key = `terms:order:${made.order.id}`;
  const before = await w.secrets.get(key);
  const stranger = w.client();
  await post(stranger, { token: launch() });
  const again = await w.newOrder(stranger);
  assert.equal(again.order.id, made.order.id, "the hold already open comes back");
  assert.equal(await w.secrets.get(key), before);
});

test("audit: what a launch adds to a public read of someone's order or card is the word mine, and nothing else", async () => {
  const same = async (w: Awaited<ReturnType<typeof world>>, viewer: Client, path: string) => {
    const stranger = await w.call("GET", path, { as: w.client() });
    const named = await w.call("GET", path, { as: viewer });
    assert.deepEqual(named.body.order, stranger.body.order);
    assert.deepEqual([stranger.body.mine, named.body.mine], [false, true]);
  };
  const card = await launchOnlyCard();
  await same(card.w, card.c, `/api/rip/cards/${card.id}`);
  const nft = await launchOnly();
  await same(nft.w, nft.c, `/api/rip/orders/${nft.id}`);
});

test("audit: a signed-in buyer's hold is written to the log exactly as before, with no new field", async () => {
  const { w } = await launchWorld();
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  await w.newOrder(me);
  const event = (await w.store.readFrom(0)).find((e) => e.type === "order_created")!;
  assert.deepEqual(Object.keys(event.data).sort(), ["address", "createdLedger", "drops", "id", "invoice", "lastLedger", "price", "season"]);
});

test("audit: a new launch the rate limit turns away leaves no older account behind in this browser", async () => {
  const { w, launch, post } = await launchWorld();
  const c = w.client(MALLORY);
  await post(c, { token: launch({ account: MALLORY }) });
  assert.equal(c.jar.has("seal_session"), true);
  let last = await post(c, {});
  for (let i = 0; i < 40 && last.status !== 429; i++) last = await post(c, {});
  assert.equal(last.status, 429);
  assert.equal(c.jar.has("seal_session"), true, "a press that's turned away changes nothing");
  assert.equal((await post(c, { token: launch() })).status, 429);
  for (const cookie of ["seal_session", "seal_xapp", "seal_challenge"]) assert.equal(c.jar.has(cookie), false, cookie);
});

test("audit: a launch names no account past Xaman's answer: a stale confirmed session never survives a switch, by any answer the server gives", async () => {
  for (const [data, wanted] of [[{ account: PLAYER }, 200], [{ nodetype: "TESTNET" }, 403], [{ accountaccess: "READONLY" }, 403]] as const) {
    const { w, launch, post } = await launchWorld();
    const c = w.client(MALLORY);
    await post(c, { token: launch({ account: MALLORY }) });
    assert.equal(sessionOf(c)?.a, MALLORY);
    const r = await post(c, { token: launch(data) });
    assert.equal(r.status, wanted);
    assert.equal(c.jar.has("seal_session"), false);
    const sold = await w.call("POST", "/api/rip/orders/none/sell", { as: c, body: { drops: "1" } });
    assert.equal(sold.status, 401);
  }
});

/** Every route that goes through guard, by method, with a made-up id. */
const guardedCalls = () =>
  routeFiles().flatMap((route) => {
    const src = readFileSync(join(SRC_DIR, `app${route}/route.ts`), "utf8");
    // These don't exist with the multi-pack switch off, and routes-multi and the launch tests below cover them with it on.
    if (!/\bguard\(/.test(src) || /rip\/(bundles|payouts)/.test(route)) return [];
    const path = route.replace(/\[[a-z]+\]/g, "nope");
    return [...(/export async function GET/.test(src) ? (["GET"] as const) : []), ...(/export async function POST/.test(src) ? (["POST"] as const) : [])].map((method) => ({ method, path }));
  });
const launchReads = ["/api/rip/holdings", "/api/rip/orders", "/api/rip/pending"];

test("the switch: with SEAL_XAPP anything but exactly on, a real launch cookie is as good as none on every guarded route", async () => {
  assert.ok(guardedCalls().length >= 12);
  for (const flag of ["", "off", "true", "ON", "on "].slice(0, 4)) {
    const { w } = await launchWorld({ flag });
    await w.open();
    w.ledger.fund(PLAYER, 500);
    const marked = w.client();
    marked.jar.set("seal_xapp", signToken({ k: "xapp", a: PLAYER, h: "x", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET));
    const plain = w.client();
    for (const { method, path } of guardedCalls()) {
      const a = await w.call(method, path, { as: marked, body: method === "POST" ? { price: 5 } : undefined });
      const b = await w.call(method, path, { as: plain, body: method === "POST" ? { price: 5 } : undefined });
      assert.deepEqual({ status: a.status, body: a.body }, { status: b.status, body: b.body }, `${method} ${path}`);
      assert.deepEqual({ status: a.status, error: a.body.error }, { status: 401, error: "Connect a wallet first." }, `${method} ${path}`);
    }
    for (const path of launchReads) assert.equal((await w.call("GET", path, { as: marked })).status, 401, path);
    assert.deepEqual((await w.call("GET", "/api/auth/session", { as: marked })).body, { session: null });
    assert.equal(w.engine.state.orders.size, 0);
  }
});

test("the switch: with SEAL_XAPP on, a browser that never launched answers exactly as with it off, signed in or not, on every guarded route", async () => {
  const sweep = async (flag: string) => {
    const { w } = await launchWorld({ flag, cards: true });
    await w.open();
    const out: unknown[] = [];
    const me = w.client(PLAYER);
    w.fund(me);
    for (const as of [w.client(), me]) {
      for (const { method, path } of guardedCalls()) {
        const r = await w.call(method, path, { as, body: method === "POST" ? {} : undefined });
        out.push({ method, path, status: r.status, body: shape(r.body), cookies: r.setCookies.map(cookieShape) });
      }
    }
    return out;
  };
  assert.deepEqual(await sweep("on"), await sweep("off"));
});

test("the switch: an ordinary signed-in browser walks claim, take-back, sale and shipment with the same answers and the same asks to Xaman, on or off", async () => {
  const walk = async (flag: string) => {
    const { w } = await launchWorld({ flag, cards: true });
    await w.open();
    const me = w.client(PLAYER);
    w.fund(me);
    const seen: unknown[] = [];
    const note = (r: { status: number; body: unknown; setCookies: string[] }) => seen.push({ status: r.status, body: shape(r.body), cookies: r.setCookies.map(cookieShape) });
    const id = await w.pull(me);
    note(await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me }));
    note(await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me }));
    await w.pump(3);
    note(await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me }));
    note(await w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: me }));
    await w.pump(3);
    const quote = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me });
    note(await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops: quote.body.drops } }));
    const card = await w.cardPull(me);
    note(await w.call("POST", `/api/rip/cards/${card}/claim`, { as: me }));
    await w.pump(3);
    note(await w.call("POST", `/api/rip/cards/${card}/claim`, { as: me }));
    note(await w.call("POST", `/api/rip/cards/${card}/claim/cancel`, { as: me }));
    await w.pump(3);
    note(await w.shipSigned(me, card, THIEF_ADDRESS));
    note(await w.call("GET", "/api/rip/holdings", { as: me }));
    return { seen, requests: w.xaman.calls.map((x) => ({ type: x.txjson.TransactionType, return: !!x.options.return_url, signers: x.options.signers })) };
  };
  assert.deepEqual(await walk("on"), await walk("off"));
});

test("the switch, property: nothing but our own signed launch token names an account, and no token of one kind passes as another", async () => {
  const { w } = await launchWorld();
  const now = Math.floor(Date.now() / 1000);
  const session = signToken({ k: "session", a: PLAYER, w: "xaman", exp: now + 3600 }, SECRET);
  const launchToken = signToken({ k: "xapp", a: PLAYER, h: "x", exp: now + 3600 }, SECRET);
  const challenge = signToken({ k: "xaman", n: "n", u: "u", exp: now + 3600 }, SECRET);
  const forged = [session, challenge, signToken({ k: "xapp", a: PLAYER, h: "x", exp: now - 1 }, SECRET), signToken({ k: "xapp", a: PLAYER, h: "x", exp: now + 3600 }, "another-secret-of-the-same-length-000000"), signToken({ k: "xapp", a: "rNope", h: "x", exp: now + 3600 }, SECRET), `${launchToken}x`];
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.constantFrom(...forged), fc.string()), async (raw) => {
      const c = w.client();
      c.jar.set("seal_xapp", raw);
      assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body, { session: null });
    }),
    { numRuns: 80 },
  );
  // And a launch token is never a session, whichever cookie it's put in.
  const c = w.client();
  c.jar.set("seal_session", launchToken);
  assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body, { session: null });
  const r = await w.call("POST", "/api/rip/orders/none/sell", { as: c, body: { drops: "1" } });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, undefined);
});


const MULTI_ON = { SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: "20" };

async function launchMulti(extra: { stock?: readonly number[]; cards?: boolean; gateway?: CardGateway; treasuryXrp?: number } = {}) {
  const made = await launchWorld({ env: MULTI_ON, cards: extra.cards, gateway: extra.gateway, treasuryXrp: extra.treasuryXrp });
  const { w, launch, post } = made;
  await w.open(5, "4000000", extra.stock ?? [40, 40, 40, 40, 40]);
  w.ledger.fund(PLAYER, 500);
  const c = w.client();
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  return { ...made, c };
}
const buyMany = (w: Awaited<ReturnType<typeof launchWorld>>["w"], as: Client, qty: number, price = 5) => w.call("POST", "/api/rip/bundles", { as, body: { price, qty, acceptedTerms: true } });
/** A second launch, of another funded account. */
const launchAs = async (made: Awaited<ReturnType<typeof launchMulti>>, n: number) => {
  made.w.ledger.fund(addressOf(n), 500);
  const other = made.w.client();
  assert.equal((await made.post(other, { token: made.launch({ account: addressOf(n) }) })).body.state, "ready");
  return other;
};

test("multi-pack in Xaman: within the cap a launch buys with no extra step, and the wallet is told what it's paying for", async () => {
  const { w, c } = await launchMulti();
  const q = await buyMany(w, c, 3);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.tx.Account, PLAYER);
  assert.equal(q.body.tx.Amount, "12000000");
  const asked = w.xaman.calls.at(-1) as Record<string, any>;
  assert.equal(asked.custom_meta.instruction, payManyInstruction("12000000", 3, "nft", "mainnet"));
  assert.match(asked.custom_meta.instruction, /to Break the Seal, a third-party app, for 3 NFT packs in one payment/);
  assert.ok(asked.custom_meta.instruction.length <= 280);
  const b = w.engine.state.bundles.get(q.body.bundle.id)!;
  assert.equal(b.unproven, true);
  assert.ok(b.children.every((id) => w.orderOf(id)?.unproven === true));
  assert.equal((await w.call("GET", "/api/rip/bundles", { as: c })).body.open.id, b.id, "a launch can read its own account's open order");
  assert.equal((await w.call("GET", `/api/rip/bundles/${b.id}`, { as: c })).body.mine, true);
  // Paying is the wallet's own signature, so it stands like any other payment.
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(5);
  assert.ok(b.children.every((id) => w.orderOf(id)?.status === "drawn"));
  assert.ok(replayLog(await w.store.readFrom(0)).ok);
});

test("multi-pack in Xaman: a launch-only order can't pass the three-hold cap, counted place by place, with singles and other accounts in the count", async () => {
  const made = await launchMulti();
  const { w, c } = made;
  refusedForProof(await buyMany(w, c, 4));
  refusedForProof(await buyMany(w, c, 20));
  assert.equal(w.engine.state.bundles.size, 0, "nothing held");
  assert.equal((await buyMany(w, c, 2)).status, 200);
  const other = await launchAs(made, 3);
  refusedForProof(await buyMany(w, other, 2));
  assert.equal((await w.call("POST", "/api/rip/orders", { as: other, body: { price: 5 } })).status, 200, "the third place, as a single");
  const third = await launchAs(made, 4);
  refusedForProof(await w.call("POST", "/api/rip/orders", { as: third, body: { price: 5 } }));
  refusedForProof(await buyMany(w, third, 2));
  const heldUnproven = [...w.engine.state.orders.values()].filter((o) => o.unproven && o.status === "quoted").length;
  assert.equal(heldUnproven, LAUNCH_HOLDS);
  // A real signature is the way past it, and the pack stays open for it.
  const signed = w.client(addressOf(4));
  assert.equal((await buyMany(w, signed, 5)).status, 200);
});

test("multi-pack in Xaman: a launch-only order never takes the last place of stock or XRP cover", async () => {
  // Stock that holds three places: a launch gets two and can't hold the third.
  const thin = await launchMulti({ stock: [8, 3, 3, 3, 2] });
  const room = (await thin.w.engine.quantityRoom(5, thin.w.state.rate)).max;
  assert.ok(room >= 2 && room < 20, String(room));
  const over = await buyMany(thin.w, thin.c, Math.min(room + 1, 3));
  assert.ok(over.status === 409 || over.status === 200, JSON.stringify(over.body));
  if (over.status === 409) assert.equal(over.body.code, "qty_too_high");
  const afterAll = thin.w.client(addressOf(5));
  thin.w.ledger.fund(addressOf(5), 500);
  assert.equal((await thin.w.call("POST", "/api/rip/orders", { as: afterAll, body: { price: 5 } })).status, 200, "a signed-in buyer still gets in");

  const lean = await launchWorld({ env: MULTI_ON, treasuryXrp: 20 });
  await lean.w.engine.openSeason(5, "4000000", lean.w.state.rate, { bandBps: [10_000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: "XRP", bps: 10_000, valueDrops: "3000000" }], tokens: [] });
  const adds = [1, 2, 3, 4].map((band) => {
    const nftId = nftIdFor(800_000 + band);
    lean.w.ledger.mintTo(nftId, VAULT);
    return { nftId, band, collection: "c", name: "n", img: "/x.webp", costDrops: "1", markDrops: "1000000" };
  });
  await lean.w.engine.changePool(5, adds);
  await lean.w.pump(4);
  lean.w.ledger.fund(PLAYER, 500);
  const c2 = lean.w.client();
  assert.equal((await lean.post(c2, { token: lean.launch() })).body.state, "ready");
  const cover = await buyMany(lean.w, c2, 3);
  assert.equal(cover.status, 409, "just under 10 XRP free covers three places of 3 XRP, and this order would use the last");
  assert.equal(cover.body.code, "qty_too_high");
  assert.equal(cover.body.max, 2);
  assert.equal((await buyMany(lean.w, c2, 2)).status, 200);
});

test("multi-pack in Xaman: selling out and redeeming need the confirmed account, a quote doesn't, and a stranger naming a victim moves nothing", async () => {
  const made = await launchMulti();
  const { w, c, post, status, signedBy } = made;
  const q = await buyMany(w, c, 3);
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(5);
  const ids = q.body.bundle.orders.map((o: { id: string }) => o.id);
  const quote = await w.call("POST", "/api/rip/payouts", { as: c, body: { ids } });
  assert.equal(quote.status, 200, "a price is only a read");
  const paidBefore = w.paidTo(PLAYER).length;
  refusedForProof(await w.call("POST", "/api/rip/payouts", { as: c, body: { items: quote.body.items } }));
  for (const id of ids) refusedForProof(await w.call("POST", `/api/rip/orders/${id}/claim`, { as: c }));
  await w.pump(3);
  assert.equal(w.paidTo(PLAYER).length, paidBefore);
  assert.ok(ids.every((id: string) => w.orderOf(id)?.pull === "stashed"));
  assert.equal(w.engine.state.payouts.size, 0);
  // The account's own signature lets it through.
  await post(c, {});
  w.xaman.payload = signedBy(1);
  assert.equal((await status(c)).body.state, "signed");
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: c, body: { items: quote.body.items } })).status, 200);
  await w.pump(5);
  assert.equal(w.paidTo(PLAYER).length, paidBefore + 1);
  assert.ok(replayLog(await w.store.readFrom(0)).ok);
});

test("multi-pack in Xaman: a stranger's launch holds never count against the wallet's signed-in owner, and their lapses don't lock them out", async () => {
  const made = await launchMulti();
  const { w, c } = made;
  const owner = w.client(PLAYER);
  assert.equal((await buyMany(w, c, 3)).status, 200);
  const mine = await buyMany(w, owner, 5);
  assert.equal(mine.status, 200, `the owner isn't blocked by what a launch opened: ${JSON.stringify(mine.body)}`);
  // A launch repeating itself is held to its own one order, and to the owner's.
  assert.equal((await buyMany(w, c, 2)).body.code, "open_checkout");
  // Lapses on a launch's word stay on that side.
  for (let i = 0; i < 4; i++) {
    w.ledger.close(50);
    await w.engine.advance();
    await w.engine.advance();
    const again = await buyMany(w, c, 3);
    if (again.status !== 200) refusedForProof(again);
  }
  w.ledger.close(50);
  await w.engine.advance();
  const ownerLater = await buyMany(w, owner, 2);
  assert.notEqual(ownerLater.body.code, "too_many_lapsed", "a stranger's walking away isn't the owner's");
  assert.notEqual(ownerLater.body.code, "confirm_account");
});

test("multi-pack in Xaman: with the switch off a launch gets no bundle route at all, and the fixed list of launch routes stays closed", async () => {
  const { w, launch, post } = await launchWorld();
  await w.open();
  w.ledger.fund(PLAYER, 500);
  const c = w.client();
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  assert.equal((await buyMany(w, c, 2)).status, 404);
  assert.equal((await w.call("GET", "/api/rip/bundles", { as: c })).status, 404);
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: c, body: { ids: [] } })).status, 404);
});

test("multi-pack in Xaman: a launch-only card order is capped the same way, and never takes the last of the float", async () => {
  const code = "pokemon_25";
  const body = (qty: number) => ({ code, qty, acceptedTerms: true });
  // Plenty of float: the cap is what stops it.
  const big = await launchWorld({ cards: true, gateway: simulatedGateway({ floatMicro: 1_000_000_000n }), env: { ...MULTI_ON, SEAL_MULTI_CARD_MAX: "8" } });
  await big.w.engine.advance();
  big.w.ledger.fund(PLAYER, 2000);
  const c = big.w.client();
  assert.equal((await big.post(c, { token: big.launch() })).body.state, "ready");
  refusedForProof(await big.w.call("POST", "/api/rip/bundles", { as: c, body: body(4) }));
  assert.equal((await big.w.call("POST", "/api/rip/bundles", { as: c, body: body(3) })).status, 200);
  const signed = big.w.client(addressOf(8));
  big.w.ledger.fund(addressOf(8), 2000);
  assert.equal((await big.w.call("POST", "/api/rip/bundles", { as: signed, body: body(5) })).status, 200, "a signature buys as ever");
  assert.equal([...big.w.engine.state.cards.values()].filter((x) => x.unproven && x.status === "quoted").length, LAUNCH_HOLDS);

  // Thin float: $100 at $25 is four packs. One order leaves one, for whoever comes next.
  const thin = await launchWorld({ cards: true, gateway: simulatedGateway({ floatMicro: 100_000_000n }), env: { ...MULTI_ON, SEAL_MULTI_CARD_MAX: "8" } });
  await thin.w.engine.advance();
  thin.w.ledger.fund(PLAYER, 2000);
  const d = thin.w.client();
  assert.equal((await thin.post(d, { token: thin.launch() })).body.state, "ready");
  assert.equal((await thin.w.call("POST", "/api/rip/bundles", { as: d, body: body(3) })).status, 200);
  const next = thin.w.client(addressOf(9));
  thin.w.ledger.fund(addressOf(9), 2000);
  assert.equal((await thin.w.call("POST", "/api/rip/cards", { as: next, body: { code } })).status, 200, "the last of the float is still there for a signature");
});

test("multi-pack in Xaman: a stranger's launch order never stands in for the owner's own, on this pack or another", async () => {
  const made = await launchWorld({ env: MULTI_ON });
  const { w, launch, post } = made;
  await w.open(5, "4000000", [40, 40, 40, 40, 40]);
  await w.open(10, "8000000", [40, 40, 40, 40, 40]);
  w.ledger.fund(PLAYER, 900);
  const c = w.client();
  assert.equal((await post(c, { token: launch() })).body.state, "ready");
  const owner = w.client(PLAYER);
  const stranger = await buyMany(w, c, 3, 10);
  assert.equal(stranger.status, 200, JSON.stringify(stranger.body));
  const mine = await buyMany(w, owner, 2, 5);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const onFive = await w.call("GET", "/api/rip/bundles?price=5", { as: owner });
  assert.equal(onFive.body.open.id, mine.body.bundle.id, "this pack's order, not the older one on another pack");
  const blocked = await buyMany(w, owner, 3, 5);
  assert.equal(blocked.body.code, "open_checkout");
  assert.equal(blocked.body.open.id, mine.body.bundle.id, "the refusal names what's really in the way");
  assert.equal((await w.call("GET", "/api/rip/bundles", { as: owner })).body.open.id, mine.body.bundle.id, "a signature comes first when no pack is named");
  // A launch and a signature on the same pack: the owner gets their own.
  const same = await launchWorld({ env: MULTI_ON });
  await same.w.open(5, "4000000", [40, 40, 40, 40, 40]);
  same.w.ledger.fund(PLAYER, 900);
  const d = same.w.client();
  assert.equal((await same.post(d, { token: same.launch() })).body.state, "ready");
  assert.equal((await buyMany(same.w, d, 2)).status, 200);
  const own = await buyMany(same.w, same.w.client(PLAYER), 3);
  assert.equal(own.status, 200);
  assert.equal((await same.w.call("GET", "/api/rip/bundles?price=5", { as: same.w.client(PLAYER) })).body.open.id, own.body.bundle.id);
});
