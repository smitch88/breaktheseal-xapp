import assert from "node:assert/strict";
import { test } from "node:test";
import { FEED_SIZE, recentPulls } from "../src/lib/rip/recent-pulls.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { GatewayRefused, simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { TREASURY, addressOf, world } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);
const ON = { SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: "20" };

async function setup(extra: Parameters<typeof world>[0] = {}) {
  const w = await world({ ...extra, env: { ...ON, ...extra.env } });
  await w.open(5, "4000000", [10, 10, 10, 10, 10]);
  const me = w.client(PLAYER);
  w.fund(me);
  return { w, me };
}

test("a multi order through the real routes: one payment to sign, the page sees it through, and every pull has its own page", async () => {
  const { w, me } = await setup();
  const q = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty: 5, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.tx.Amount, "20000000");
  assert.equal(q.body.tx.Account, PLAYER);
  assert.equal(q.body.tx.Destination, TREASURY);
  assert.equal(q.body.bundle.qty, 5);
  assert.equal(q.body.bundle.status, "quoted");
  const id = q.body.bundle.id as string;
  assert.equal((await w.call("GET", "/api/rip/bundles", { as: me })).body.open.id, id, "a reload finds its way back");
  assert.deepEqual((await w.call("GET", "/api/rip/orders", { as: me })).body.open, { nft: [], cards: [], bundles: [{ id, qty: 5, price: 5 }] }, "a child is never a checkout of its own");
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(5);
  const look = await w.call("GET", `/api/rip/bundles/${id}`, { as: me });
  assert.equal(look.body.mine, true);
  assert.equal(look.body.bundle.status, "paid");
  assert.equal(look.body.bundle.orders.length, 5);
  for (const o of look.body.bundle.orders) {
    assert.equal(o.status, "drawn");
    assert.equal(o.xrp, 4, "each shows one pack's price, not the total");
    assert.equal(o.bundle, id);
    const own = await w.call("GET", `/api/rip/orders/${o.id}`, { as: me });
    assert.equal(own.status, 200);
    assert.equal(own.body.order.id, o.id);
  }
  const held = await w.call("GET", "/api/rip/holdings", { as: me });
  assert.equal(held.body.orders.length, 5);
  assert.equal((await w.call("GET", "/api/rip/bundles", { as: me })).body.open, null);
  const stranger = await w.call("GET", `/api/rip/bundles/${id}`, { as: w.client(OTHER) });
  assert.equal(stranger.body.mine, false);
  assert.ok(!JSON.stringify(stranger.body).includes(PLAYER), "no wallet on the order's public face");
  assert.ok(replayLog(await w.store.readFrom(0)).ok);
});

test("the client never decides: over the limit is refused with the server's figure, an env cap holds, and a bad quantity is no order", async () => {
  const { w, me } = await setup({ env: { SEAL_MULTI_MAX: "5" } });
  const over = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty: 6, acceptedTerms: true } });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "qty_too_high");
  assert.equal(over.body.max, 5);
  for (const qty of [0, 1, -3, 2.5, 21, "5x", null, 1e9]) {
    const r = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty, acceptedTerms: true } });
    assert.equal(r.status, 409, String(qty));
    assert.equal(r.body.code, "bad_qty", String(qty));
  }
  assert.equal(w.engine.state.bundles.size, 0);
  const config = await w.call("GET", "/api/rip/config");
  assert.equal(config.body.multi.max, 5);
  assert.equal(config.body.multi.room["5"], 5);
  assert.equal(config.body.multi.room["10"], 0, "a pack with no season has no room");
  // The body can't name a wallet, a price or an amount.
  const ok = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty: 2, acceptedTerms: true, drops: "1", address: OTHER, Account: OTHER, each: "1" } });
  assert.equal(ok.body.tx.Amount, "8000000");
  assert.equal(ok.body.tx.Account, PLAYER);
});

test("the same gates as one pack: terms, origin, session, place, allowlist", async () => {
  const { w, me } = await setup();
  const body = { price: 5, qty: 3 };
  assert.equal((await w.call("POST", "/api/rip/bundles", { as: me, raw: JSON.stringify(body) })).body.code, "terms_required");
  assert.equal((await w.call("POST", "/api/rip/bundles", { as: me, body: { ...body, acceptedTerms: true }, origin: "https://evil.test" })).status, 403);
  assert.equal((await w.call("POST", "/api/rip/bundles", { as: w.client(OTHER, false), body: { ...body, acceptedTerms: true } })).status, 401);
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: w.client(OTHER, false), body: { ids: [] } })).status, 401);
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: me, body: { ids: [] }, origin: "https://evil.test" })).status, 403);
  const allow = await world({ allowed: OTHER, env: ON });
  await allow.open();
  const c = allow.client(PLAYER);
  allow.fund(c);
  assert.equal((await allow.call("POST", "/api/rip/bundles", { as: c, body: { ...body, acceptedTerms: true } })).status, 403);
  assert.ok(w.secretWrites.every((k) => !k.startsWith("terms:") || k.includes("order")));
});

test("with the switch on, every order records the terms the site is showing", async () => {
  const { TERMS_MULTI_VERSION, TERMS_VERSION } = await import("../src/lib/legal/content.ts");
  const { w, me } = await setup();
  const q = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty: 3, acceptedTerms: true } });
  assert.notEqual(TERMS_MULTI_VERSION, TERMS_VERSION);
  assert.equal(JSON.parse((await w.secrets.get(`terms:order:${q.body.bundle.id}`)) as string).version, TERMS_MULTI_VERSION);
  const single = await w.newOrder(w.client(addressOf(3)).address ? (() => { const c = w.client(addressOf(3)); w.fund(c); return c; })() : me);
  assert.equal(JSON.parse((await w.secrets.get(`terms:order:${single.order.id}`)) as string).version, TERMS_MULTI_VERSION);
  const off = await world();
  await off.open();
  const c = off.client(addressOf(1));
  off.fund(c);
  const plain = await off.newOrder(c);
  assert.equal(JSON.parse((await off.secrets.get(`terms:order:${plain.order.id}`)) as string).version, TERMS_VERSION, "the switch off is what it was");
});

test("sell all through the routes: quote, a fee already in the price, one payment, and a repeat changes nothing", async () => {
  const { w, me } = await setup();
  const q = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty: 4, acceptedTerms: true } });
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(5);
  const ids = q.body.bundle.orders.map((o: { id: string }) => o.id);
  const quote = await w.call("POST", "/api/rip/payouts", { as: me, body: { ids } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.items.length, 4);
  const lower = quote.body.items.map((i: { drops: string }) => ({ ...i, drops: String(BigInt(i.drops) + 1n) }));
  const refused = await w.call("POST", "/api/rip/payouts", { as: me, body: { items: lower } });
  assert.equal(refused.body.code, "price_changed");
  assert.equal(refused.body.total, quote.body.total, "the live figure comes back to confirm");
  const someoneElse = w.client(OTHER);
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: someoneElse, body: { items: quote.body.items } })).body.code, "not_yours");
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: me, body: { items: [{ order: ids[0], action: "steal", drops: "1" }] } })).status, 400);
  assert.equal((await w.call("POST", "/api/rip/payouts", { as: me, body: { items: "nope" } })).status, 400);
  const first = await w.call("POST", "/api/rip/payouts", { as: me, body: { items: quote.body.items } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await w.call("POST", "/api/rip/payouts", { as: me, body: { items: quote.body.items } });
  assert.equal(again.body.id, first.body.id, "a double tap is the same sale");
  // A reload in the middle reads the same story from the server.
  const during = await w.call("GET", `/api/rip/bundles/${q.body.bundle.id}`, { as: me });
  assert.ok(during.body.bundle.orders.every((o: { payout: { id: string }; pull: string }) => o.payout?.id === first.body.id));
  await w.pump(5);
  assert.equal(w.paidTo(PLAYER).length, 1);
  const after = await w.call("GET", `/api/rip/bundles/${q.body.bundle.id}`, { as: me });
  for (const o of after.body.bundle.orders) {
    assert.equal(o.pull, "sold");
    assert.equal(o.payout.status, "done");
    assert.equal(o.payout.count, 4);
    assert.equal(o.sellTx, w.paidTo(PLAYER)[0].hash);
  }
  // Selling is paused by the same switch that pauses one sale.
  const paused = await setup({ env: { SEAL_SELLBACK_PAUSED: "1" } });
  const b = await paused.w.call("POST", "/api/rip/bundles", { as: paused.me, body: { price: 5, qty: 2, acceptedTerms: true } });
  paused.w.ledger.userSubmit(b.body.tx as never);
  await paused.w.pump(5);
  const stopped = await paused.w.call("POST", "/api/rip/payouts", { as: paused.me, body: { ids: b.body.bundle.orders.map((o: { id: string }) => o.id) } });
  assert.equal(stopped.body.code, "sell_paused");
});

test("the ticker shows a multi order once, by its first pull, and never more than one row from it", async () => {
  const { w, me } = await setup();
  const q = await w.call("POST", "/api/rip/bundles", { as: me, body: { price: 5, qty: 6, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(5);
  const later = Date.now() + 3_600_000;
  const pulls = recentPulls(w.engine.state, later);
  assert.equal(pulls.length, 1, "one row, not six");
  assert.ok(pulls.length <= FEED_SIZE);
  const text = JSON.stringify(pulls);
  assert.ok(!text.includes(PLAYER) && !text.includes(q.body.bundle.id));
  for (const o of w.engine.state.orders.values()) assert.ok(!text.includes(o.id) && !(o.txHash && text.includes(o.txHash)));
  assert.deepEqual(recentPulls(w.engine.state, Date.now()), [], "held back while the player is still opening");
  const first = w.engine.state.orders.get(q.body.bundle.orders[0].id)!;
  assert.equal(pulls[0].tier, ["Common", "Uncommon", "Rare", "Epic", "Chase"][first.band as number], "the first, not the rarest");
});

test("a multi order of card packs: custody caps it, one payment, a child that fails refunds alone and whole", async () => {
  const base = simulatedGateway({ floatMicro: 100_000_000n });
  let calls = 0;
  const gateway: CardGateway = {
    ...base,
    generate: (code, ref) => {
      calls += 1;
      if (calls === 2) throw new GatewayRefused("no pack for you");
      return base.generate(code, ref);
    },
  };
  const w = await world({ cards: true, gateway, env: { ...ON, SEAL_MULTI_CARD_MAX: "8" } });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me, 2000);
  assert.equal((await w.call("GET", "/api/rip/bundle-room?code=pokemon_25", { as: me })).body.max, 3, "$100 of custody, $25 a pack, one kept back for a single");
  const over = await w.call("POST", "/api/rip/bundles", { as: me, body: { code: "pokemon_25", qty: 4, acceptedTerms: true } });
  assert.equal(over.body.code, "qty_too_high");
  assert.equal(over.body.max, 3);
  const q = await w.call("POST", "/api/rip/bundles", { as: me, body: { code: "pokemon_25", qty: 3, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.bundle.kind, "card");
  const each = BigInt(Math.round(q.body.bundle.eachXrp * 1e6));
  assert.equal(BigInt(q.body.tx.Amount), each * 3n);
  assert.equal((await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } })).status, 200, "a single still fits");
  const other = w.client(OTHER);
  w.fund(other, 2000);
  assert.equal((await w.call("POST", "/api/rip/cards", { as: other, body: { code: "pokemon_25" } })).body.code, "restocking", "what's held counts against custody");
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(10);
  const look = (await w.call("GET", `/api/rip/bundles/${q.body.bundle.id}`, { as: me })).body.bundle;
  assert.equal(look.cards.filter((c: { status: string }) => c.status === "held").length, 2);
  const back = look.cards.filter((c: { status: string }) => c.status === "refunded");
  assert.equal(back.length, 1);
  assert.equal(back[0].refund.reason, "source_refused");
  const refunds = w.paidTo(PLAYER);
  assert.equal(refunds.length, 1);
  assert.equal(BigInt(String(refunds[0].delivered)), each, "that pack's price, whole");
  const log = await w.store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  // Each card takes its own way out, as a single card does.
  const held = look.cards.find((c: { status: string }) => c.status === "held");
  assert.equal((await w.call("GET", `/api/rip/cards/${held.id}`, { as: me })).body.order.bundle, q.body.bundle.id);
});

test("card packs stay single until the owner raises their own cap", async () => {
  const w = await world({ cards: true, env: ON });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me, 2000);
  assert.equal((await w.call("GET", "/api/rip/bundle-room?code=pokemon_25", { as: me })).body.max, 1);
  assert.equal((await w.call("POST", "/api/rip/bundles", { as: me, body: { code: "pokemon_25", qty: 2, acceptedTerms: true } })).body.code, "qty_too_high");
  assert.equal(w.engine.state.bundles.size, 0);
});
