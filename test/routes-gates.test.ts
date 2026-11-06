import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { signToken } from "../src/lib/auth/tokens.ts";
import { ACT_LIMIT, READ_LIMIT } from "../src/lib/rip/limits.ts";
import { CRON, SECRET, addressOf, routeFiles, world } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);

/** Every route in the app, and what stands in front of it. A new route with no row here fails the first test. */
const POST_GUARDED = ["/api/rip/wallet-request", "/api/rip/orders", "/api/rip/orders/x/sell", "/api/rip/orders/x/claim", "/api/rip/orders/x/claim/cancel", "/api/rip/cards", "/api/rip/cards/x/sell", "/api/rip/cards/x/claim", "/api/rip/cards/x/claim/cancel", "/api/rip/cards/x/ship"];
const ADMIN_ROUTES = ["/api/rip/admin/autobuy", "/api/rip/admin/mark-shipped", "/api/rip/admin/resolve-card", "/api/rip/admin/resolve-swap", "/api/rip/admin/retry-refund"];
const GET_RAILS = ["/api/rip/log", "/api/rip/holdings", "/api/rip/orders", "/api/rip/orders/x", "/api/rip/cards/x", "/api/rip/cards/x/details", "/api/rip/pending", "/api/mirror/x", "/api/rip/tick", "/api/rip/cards"];
const COVERED: Readonly<Record<string, string>> = {
  "/api/auth/config": "routes-auth",
  "/api/auth/joey/challenge": "routes-auth",
  "/api/auth/joey/nonce": "routes-joey",
  "/api/auth/joey/signin": "routes-joey",
  "/api/auth/joey/verify": "routes-auth",
  "/api/auth/logout": "routes-auth",
  "/api/auth/session": "routes-auth",
  "/api/auth/xaman/return": "routes-xaman-return",
  "/api/auth/xaman/start": "routes-auth",
  "/api/auth/xaman/status": "routes-auth",
  "/api/auth/xapp": "routes-xapp",
  "/api/auth/xapp/status": "routes-xapp",
  "/api/mirror/[id]": "routes-cards",
  "/api/nft/[price]": "routes-gates",
  "/api/packs/[code]/browse": "pack-browser",
  "/api/packs/[code]/card/[mint]": "pack-browser",
  "/api/packs/[code]/items": "routes-gates",
  "/api/rip/admin/autobuy": "routes-admin",
  "/api/rip/admin/mark-shipped": "routes-admin",
  "/api/rip/admin/resolve-card": "routes-admin",
  "/api/rip/admin/resolve-swap": "passthrough",
  "/api/rip/admin/retry-refund": "routes-admin",
  "/api/rip/bundle-room": "routes-multi",
  "/api/rip/bundles": "routes-multi",
  "/api/rip/bundles/[id]": "routes-multi",
  "/api/rip/payouts": "routes-multi",
  "/api/rip/cards": "routes-cards",
  "/api/rip/cards/[id]": "routes-cards",
  "/api/rip/cards/[id]/claim": "routes-cards",
  "/api/rip/cards/[id]/claim/cancel": "inventory",
  "/api/rip/cards/[id]/details": "inventory",
  "/api/rip/cards/[id]/sell": "routes-cards",
  "/api/rip/cards/[id]/ship": "routes-cards",
  "/api/rip/config": "routes-gates",
  "/api/rip/holdings": "routes-pulls",
  "/api/rip/log": "routes-pulls",
  "/api/rip/orders": "routes-pulls",
  "/api/rip/orders/[id]": "routes-pulls",
  "/api/rip/orders/[id]/claim": "routes-pulls",
  "/api/rip/orders/[id]/claim/cancel": "routes-pulls",
  "/api/rip/art/[key]": "remote-art",
  "/api/rip/orders/[id]/redeem": "routes-pulls",
  "/api/rip/orders/[id]/sell": "routes-pulls",
  "/api/rip/pending": "inventory",
  "/api/rip/pool/[price]": "routes-pool",
  "/api/rip/pulls": "recent-pulls",
  "/api/rip/tick": "routes-gates",
  "/api/rip/wallet-request": "routes-joey",
};

test("every route file has a test home: a new route can't ship untested", () => {
  assert.deepEqual(routeFiles(), Object.keys(COVERED).sort());
});

test("rails off: every real route is a 404, the config says demo, and nothing throws", async () => {
  const w = await world({ off: true });
  const me = w.client(PLAYER);
  for (const p of [...POST_GUARDED, ...ADMIN_ROUTES]) {
    const r = await w.call("POST", p, { as: me, body: { price: 5, code: "pokemon_25", id: "x", ref: "y", action: "resume", drops: "1" } });
    assert.equal(r.status, 404, `POST ${p}`);
    assert.equal(r.thrown, undefined);
  }
  for (const p of GET_RAILS) assert.equal((await w.call("GET", p, { as: me })).status, 404, `GET ${p}`);
  const config = await w.call("GET", "/api/rip/config");
  assert.deepEqual(config.body, { mode: "demo", tiers: [] });
});

test("a call from another site or with no origin is refused before anything happens", async () => {
  const w = await world({ cards: true });
  const me = w.client(PLAYER);
  for (const p of POST_GUARDED) {
    for (const origin of ["https://evil.test", "not a url", null]) {
      const r = await w.call("POST", p, { as: me, origin, body: { price: 5, code: "pokemon_25" } });
      assert.equal(r.status, 403, `${p} from ${origin}`);
    }
  }
  assert.equal(w.engine.state.orders.size + w.engine.state.cards.size, 0);
});

test("signed out, tampered, expired or the wrong kind of cookie: every guarded route says connect first", async () => {
  const w = await world({ cards: true });
  const now = Math.floor(Date.now() / 1000);
  const good = signToken({ k: "session", a: PLAYER, w: "joey", exp: now + 3600 }, SECRET);
  const badCookies = [
    null,
    "junk",
    `${good.slice(0, -2)}xx`,
    signToken({ k: "session", a: PLAYER, w: "joey", exp: now - 1 }, SECRET),
    signToken({ k: "session", a: PLAYER, w: "joey", exp: now + 3600 }, "a-different-secret-entirely-32-characters"),
    signToken({ k: "joey", n: "n", a: PLAYER, exp: now + 3600 }, SECRET),
    signToken({ k: "session", a: "not-an-address", w: "joey", exp: now + 3600 }, SECRET),
  ];
  for (const cookie of badCookies) {
    const c = w.client();
    if (cookie) c.jar.set("seal_session", cookie);
    for (const p of POST_GUARDED) assert.equal((await w.call("POST", p, { as: c, body: { price: 5 } })).status, 401, `${p} with ${String(cookie).slice(0, 12)}`);
    assert.equal((await w.call("GET", "/api/rip/holdings", { as: c })).status, 401);
    assert.equal((await w.call("GET", "/api/rip/cards", { as: c })).status, 401);
  }
});

test("while the allowlist is set, every other wallet is refused on every guarded route and the listed one gets through", async () => {
  const w = await world({ cards: true, allowed: PLAYER });
  await w.open();
  const other = w.client(OTHER);
  for (const p of POST_GUARDED) {
    const r = await w.call("POST", p, { as: other, body: { price: 5 } });
    assert.equal(r.status, 403, p);
    assert.equal(r.body.code, "not_open");
  }
  assert.equal(w.engine.state.orders.size, 0);
  const listed = w.client(PLAYER);
  w.fund(listed);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: listed, body: { price: 5 } })).status, 200);
});

test("quotes and presses each have their own limit per account: a flood of quotes never blocks the press, and another account is untouched", async () => {
  const w = await world();
  await w.open();
  const noisy = w.client(PLAYER);
  const quotes: number[] = [];
  for (let i = 0; i < READ_LIMIT + 10; i++) quotes.push((await w.call("POST", "/api/rip/orders/x/sell", { as: noisy })).status);
  assert.equal(quotes.filter((s) => s === 429).length, 10);
  assert.equal(quotes.at(-1), 429);
  const busy = await w.call("POST", "/api/rip/orders/x/sell", { as: noisy });
  assert.equal(busy.body.code, "rate_limited");
  assert.equal(busy.headers.get("retry-after"), "5");
  // The sale the player pressed for still goes through to its own checks.
  const presses: number[] = [];
  for (let i = 0; i < ACT_LIMIT + 2; i++) presses.push((await w.call("POST", "/api/rip/orders/x/sell", { as: noisy, body: { drops: "1" } })).status);
  assert.notEqual(presses[0], 429);
  assert.equal(presses.filter((s) => s === 429).length, 2);
  assert.notEqual((await w.call("POST", "/api/rip/orders/x/sell", { as: w.client(addressOf(2)) })).status, 429);
});

test("collection polling is per client: many viewers on one instance never share one rate limit", async () => {
  const w = await world({ cards: true });
  for (let n = 0; n < 8; n++) {
    const viewer = w.client(addressOf(10 + n));
    for (let i = 0; i < 10; i++) assert.equal((await w.call("GET", "/api/rip/cards", { as: viewer })).status, 200, `viewer ${n}, poll ${i}`);
  }
});

test("the sweep runs only with the cron secret, and finishes a paid pull nobody is watching", async () => {
  const w = await world();
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${CRON}x` }, { authorization: CRON.slice(1) }] as Record<string, string>[]) {
    assert.equal((await w.call("GET", "/api/rip/tick", { headers })).status, 401);
  }
  const q = await w.newOrder(me);
  w.ledger.userSubmit(q.tx as never);
  for (let i = 0; i < 5; i++) {
    w.ledger.close();
    const r = await w.call("GET", "/api/rip/tick", { headers: { authorization: `Bearer ${CRON}` } });
    assert.equal(r.status, 200);
  }
  assert.equal(w.orderOf(q.order.id)?.status, "drawn");
});

test("the sweep is closed, not open, if the cron secret was never set", async () => {
  const w = await world();
  delete process.env.CRON_SECRET;
  for (const headers of [{}, { authorization: "Bearer " }, { authorization: "Bearer undefined" }] as Record<string, string>[]) assert.equal((await w.call("GET", "/api/rip/tick", { headers })).status, 401);
});

test("config names the wallets and shows only what's open, and a full tier reads open", async () => {
  const w = await world();
  let r = await w.call("GET", "/api/rip/config");
  assert.equal(r.body.mode, "mainnet");
  assert.ok(r.body.tiers.every((t: { open: boolean }) => !t.open));
  await w.open();
  r = await w.call("GET", "/api/rip/config");
  const five = r.body.tiers.find((t: { price: number }) => t.price === 5);
  assert.equal(five.open, true);
  assert.equal(five.xrp, 4);
  assert.ok(!JSON.stringify(r.body).includes("costDrops"));
});

test("a node error on the ledger read: config still answers, every pack reads closed, nothing sells, and it reopens by itself", async () => {
  let down = false;
  const w = await world({ wrapChain: (c) => ({ ...c, validatedLedger: async () => (down ? Promise.reject(new Error("rpc 503")) : c.validatedLedger()) }) });
  await w.open();
  const me = w.client(PLAYER);
  assert.equal((await w.call("GET", "/api/rip/config")).body.tiers.find((t: { price: number }) => t.price === 5).open, true);
  down = true;
  const r = await w.call("GET", "/api/rip/config");
  assert.equal(r.thrown, undefined);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "mainnet");
  assert.ok(r.body.tiers.length > 0);
  assert.ok(r.body.tiers.every((t: { open: boolean }) => t.open === false), JSON.stringify(r.body.tiers));
  await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(w.engine.state.orders.size, 0, "an order opened with the ledger unreadable");
  down = false;
  assert.equal((await w.call("GET", "/api/rip/config")).body.tiers.find((t: { price: number }) => t.price === 5).open, true);
});

test("catalog reads: an unknown pack is a 404, and a dead upstream serves the snapshot and says so", async () => {
  const w = await world({ off: true });
  assert.equal((await w.call("GET", "/api/nft/7")).status, 404);
  assert.equal((await w.call("GET", "/api/nft/abc")).status, 404);
  const pack = await w.call("GET", "/api/nft/5");
  assert.equal(pack.status, 200);
  assert.equal(pack.body.stale, true);
  assert.equal((await w.call("GET", "/api/packs/nope_nope/items")).status, 404);
  assert.equal((await w.call("GET", "/api/packs/..%2F..%2Fetc/items")).status, 404);
  const items = await w.call("GET", "/api/packs/pokemon_25/items");
  assert.equal(items.status, 200);
  assert.equal(items.body.stale, true);
});

test("no junk body can make a guarded route throw: it answers with a refusal", async () => {
  const w = await world({ cards: true });
  await w.open();
  const me = w.client(PLAYER);
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...POST_GUARDED), fc.oneof(fc.json(), fc.string(), fc.constant("null"), fc.constant("[]"), fc.constant('{"drops":{"a":1}}'), fc.constant('{"price":"__proto__"}')), async (path, raw) => {
      const c = { ...me, ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
      const r = await w.call("POST", path, { as: c, raw });
      assert.equal(r.thrown, undefined, `${path} threw on ${raw}: ${String(r.thrown)}`);
      assert.ok(r.status < 500, `${path} ${r.status}`);
    }),
    { numRuns: 120 },
  );
});
