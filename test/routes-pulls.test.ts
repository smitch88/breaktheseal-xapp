import assert from "node:assert/strict";
import { test } from "node:test";
import { ORDER_LEDGERS } from "../src/lib/rip/engine.ts";
import { holdsFor } from "../src/lib/rip/state.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { REFUND_REASONS } from "../src/lib/live/client.ts";
import { SEAL_CURRENCY, SEAL_ISSUER, SEAL_TOKEN, XRP_TOKEN } from "../src/lib/rip/tokens.ts";
import { nftIdFor } from "./support-ledger.ts";
import { TREASURY, VAULT, addressOf, world, type World } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);

async function ready(opts: Parameters<typeof world>[0] = {}) {
  const w = await world(opts);
  await w.open();
  const me = w.client(PLAYER);
  const other = w.client(OTHER);
  w.fund(me);
  w.fund(other);
  return { w, me, other };
}

/** The public log still replays and matches the state, whatever just happened. */
async function logHolds(w: World) {
  const r = await w.call("GET", "/api/rip/log");
  assert.equal(r.status, 200);
  const replay = replayLog(r.body.events);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  return r.body.events as { type: string; data: Record<string, unknown> }[];
}

test("happy path by route: order, pay, poll, stash, quote, sell, paid once, log replays", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  assert.equal(made.tx.TransactionType, "Payment");
  assert.equal(made.tx.Destination, TREASURY);
  assert.equal(made.tx.Account, PLAYER);
  assert.equal(made.tx.Amount, "4000000");
  assert.equal(made.wallet, null);
  assert.equal(made.order.status, "quoted");
  const id = made.order.id as string;
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  const polled = await w.call("GET", `/api/rip/orders/${id}`);
  assert.equal(polled.body.order.status, "drawn");
  assert.equal(polled.body.order.pull, "stashed");
  assert.ok(!JSON.stringify(polled.body).includes("costDrops"));
  const holdings = await w.call("GET", "/api/rip/holdings", { as: me });
  assert.deepEqual(holdings.body.orders.map((o: { id: string }) => o.id), [id]);
  const quote = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me });
  assert.equal(quote.body.drops, "2851800");
  const before = w.ledger.balance(PLAYER);
  const sold = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops: quote.body.drops } });
  assert.equal(sold.status, 200);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "sold");
  assert.equal(w.ledger.balance(PLAYER) - before, 2_851_800n);
  await logHolds(w);
});

test("double tap on Pay: five at once make one order, one hold, and every answer names it", async () => {
  const { w, me } = await ready();
  const answers = await Promise.all(Array.from({ length: 5 }, () => w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })));
  assert.ok(answers.every((a) => a.status === 200));
  assert.equal(new Set(answers.map((a) => a.body.order.id)).size, 1);
  assert.equal(holdsFor(w.engine.state, 5), 1);
});

test("an order for what isn't a pack is a 400 and logs nothing", async () => {
  const { w, me } = await ready();
  const before = w.engine.state.head;
  for (const raw of ['{"price":7}', '{"price":"abc"}', '{"price":-5}', '{"price":null}', "{}", "not json", "[]", '{"price":5.5}']) {
    const r = await w.call("POST", "/api/rip/orders", { as: me, raw });
    assert.equal(r.status, 400, raw);
  }
  assert.equal(w.engine.state.head, before);
});

test("closed, restocking and too many open: each gets its own refusal and no order", async () => {
  const w = await world();
  const me = w.client(PLAYER);
  w.fund(me);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).body.code, "not_open");
  await w.open(5, "4000000", [1, 1, 1, 1, 0]);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).body.code, "restocking");
  await w.open(10, "8000000");
  await w.open(25, "20000000");
  // Off the shelf, even with a season open on the log: the route won't take it.
  await w.open(50, "40000000");
  await w.open(100, "80000000");
  for (const price of [50, 100]) assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price } })).status, 400);
  for (const price of [25, 50, 100]) assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price } })).status, 400);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 10 } })).status, 200);
});

test("too many open: the engine's cap holds, though three tiers and one open order each can't reach it through the shelf", async () => {
  const { w, me } = await ready();
  await w.open(10, "8000000");
  await w.open(25, "20000000");
  await w.open(50, "40000000");
  await w.open(100, "80000000");
  for (const price of [5, 10]) assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price } })).status, 200);
  assert.ok((await w.engine.createOrder(me.address as string, 25, await w.chain.xrpUsd?.())).ok);
  const r = await w.engine.createOrder(me.address as string, 50);
  assert.equal((r as { code?: string }).code, "too_many");
});

test("redeem route: an XRP prize pays once, a SEAL prize asks for a trust line first, and strangers get nothing", async () => {
  const w = await world();
  const me = w.client(PLAYER);
  const other = w.client(OTHER);
  w.fund(me);
  w.fund(other);
  const spec = { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer: SEAL_ISSUER };
  w.ledger.setPool(spec, "33000000000", "44800000000000000");
  w.ledger.setLine(spec, TREASURY, 10_000_000_000n);
  // Every Common pull pays a token here, half and half, so a few pulls see both.
  const plan = { bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: SEAL_TOKEN, bps: 5000, valueDrops: "1000000" }, { band: 0, token: XRP_TOKEN, bps: 5000, valueDrops: "1000000" }], tokens: [spec] };
  await w.engine.openSeason(5, "4000000", w.state.rate, plan);
  const adds = [0, 1, 2, 3, 4].map((band, i) => {
    const nftId = nftIdFor(900 + i);
    w.ledger.mintTo(nftId, VAULT);
    return { nftId, band, collection: "c", name: "n", img: "/x.webp", costDrops: "1", markDrops: "1" };
  });
  await w.engine.changePool(5, adds);
  await w.pump(4);
  const seen = new Set<string>();
  for (let i = 0; i < 12 && seen.size < 2; i++) {
    const id = await w.pull(me);
    const got = await w.call("GET", `/api/rip/orders/${id}`, { as: me });
    const token = got.body.order.prize?.token as string;
    if (seen.has(token)) continue;
    seen.add(token);
    assert.equal((await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: other, body: {} })).status, 409);
    if (token === XRP_TOKEN) {
      assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: {} })).status, 409);
      const before = w.ledger.balance(me.address as string);
      assert.equal((await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: me, body: {} })).status, 200);
      await w.pump(3);
      assert.equal((await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: me, body: {} })).status, 200);
      await w.pump(3);
      assert.equal(w.ledger.balance(me.address as string) - before, 1_000_000n);
    } else {
      const ask = await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: me, body: {} });
      assert.equal(ask.status, 200);
      assert.equal(ask.body.needsTrustLine, true);
      assert.equal(ask.body.tx.TransactionType, "TrustSet");
      assert.equal(ask.body.tx.LimitAmount.issuer, SEAL_ISSUER);
      assert.equal(w.engine.state.orders.get(id)?.pull, "stashed");
      w.ledger.setLine(spec, me.address as string, 0n);
      assert.equal((await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: me, body: {} })).status, 200);
      await w.pump(4);
      assert.equal(w.engine.state.orders.get(id)?.pull, "redeemed");
      assert.equal(w.ledger.tokenBalance(spec, me.address as string), BigInt(w.engine.state.orders.get(id)?.prize?.amount ?? 0));
    }
  }
  assert.equal(seen.size, 2);
  await logHolds(w);
});

test("declined signature: nothing is charged, the order ends, the hold comes back, and they can start again", async () => {
  const { w, me } = await ready();
  const before = w.ledger.balance(PLAYER);
  const made = await w.newOrder(me);
  assert.equal(holdsFor(w.engine.state, 5), 1);
  w.ledger.close(ORDER_LEDGERS + 2);
  await w.engine.advance();
  const polled = await w.call("GET", `/api/rip/orders/${made.order.id}`);
  assert.equal(polled.body.order.status, "expired");
  assert.equal(holdsFor(w.engine.state, 5), 0);
  assert.equal(w.ledger.balance(PLAYER), before);
  const again = await w.newOrder(me);
  assert.notEqual(again.order.id, made.order.id);
});

test("expired quote: the ledger won't take the signed payment after its last ledger, so no pull and no charge", async () => {
  const { w, me } = await ready();
  const before = w.ledger.balance(PLAYER);
  const made = await w.newOrder(me);
  w.ledger.close(ORDER_LEDGERS + 2);
  w.ledger.userSubmit(made.tx as never);
  await w.pump(4);
  assert.equal(w.orderOf(made.order.id)?.status, "expired");
  assert.equal(w.ledger.balance(PLAYER), before);
  assert.equal(w.engine.state.refunds.size, 0);
});

test("a late payment with no last ledger on it comes back whole, and the screen has words for it", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  w.ledger.close(ORDER_LEDGERS + 2);
  await w.engine.advance();
  const { LastLedgerSequence: _drop, ...tx } = made.tx;
  const before = w.ledger.balance(PLAYER);
  w.ledger.userSubmit(tx as never);
  await w.pump(4);
  const polled = await w.call("GET", `/api/rip/orders/${made.order.id}`);
  assert.equal(polled.body.order.refund.reason, "late");
  assert.equal(polled.body.order.refund.status, "done");
  assert.ok(REFUND_REASONS.late);
  assert.equal(before - w.ledger.balance(PLAYER), 12n);
});

test("wrong wallet pays the order: it goes back to who sent it, and the order can still be paid by its own wallet", async () => {
  const { w, me, other } = await ready();
  const made = await w.newOrder(me);
  const before = w.ledger.balance(OTHER);
  w.ledger.userSubmit({ ...made.tx, Account: OTHER } as never);
  await w.pump(3);
  assert.equal(before - w.ledger.balance(OTHER), 12n);
  assert.equal(w.orderOf(made.order.id)?.status, "quoted");
  assert.equal((await w.call("GET", `/api/rip/orders/${made.order.id}`)).body.order.refund.reason, "wrong_wallet");
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
  void other;
});

test("the wrong amount, a second payment, and a payment naming nothing all come back whole", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  const start = w.ledger.balance(PLAYER);
  w.ledger.userSubmit({ ...made.tx, Amount: "3999999" } as never);
  await w.pump(3);
  assert.equal(start - w.ledger.balance(PLAYER), 12n + 0n);
  assert.equal(w.orderOf(made.order.id)?.status, "quoted");
  w.ledger.userSubmit(made.tx as never);
  await w.pump(2);
  w.ledger.userSubmit({ ...made.tx, LastLedgerSequence: undefined } as never);
  await w.pump(5);
  w.ledger.userSubmit({ TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "5000000" } as never);
  await w.pump(4);
  const reasons = [...w.engine.state.refunds.values()].map((r) => [r.reason, r.status]);
  assert.deepEqual(reasons.sort(), [["already_paid", "done"], ["no_order", "done"], ["wrong_amount", "done"]]);
  assert.equal(start - w.ledger.balance(PLAYER), 4_000_000n + 48n);
  for (const r of w.engine.state.refunds.values()) assert.ok(REFUND_REASONS[r.reason], r.reason);
});

test("replay: submitting the same signed payment again can't make a second pull", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  w.ledger.userSubmit(made.tx as never);
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
  const drawn = [...w.engine.state.orders.values()].filter((o) => o.status === "drawn");
  assert.equal(drawn.length, 1);
});

test("stale price: XRP past the guard pauses new orders, no price at all pauses them, and it reopens when the price is back", async () => {
  const { w, me } = await ready();
  w.state.rate = 1.25 * 1.2;
  let r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "rate_moved");
  w.state.rate = null;
  r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "no_rate");
  assert.equal(w.engine.state.orders.size, 0);
  w.state.rate = 1.26;
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).status, 200);
});

test("a paid order still draws, and a stash can still be sold, while the price guard has new orders paused", async () => {
  const { w, me } = await ready();
  const a = await w.pull(me);
  const made = await w.newOrder(me);
  w.ledger.userSubmit(made.tx as never);
  w.state.rate = 0.5;
  await w.pump(5);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
  const quote = await w.call("POST", `/api/rip/orders/${a}/sell`, { as: me });
  assert.equal((await w.call("POST", `/api/rip/orders/${a}/sell`, { as: me, body: { drops: quote.body.drops } })).status, 200);
});

test("sell, double tap: five at once and a replay after it landed pay exactly once", async () => {
  const { w, me } = await ready();
  const id = await w.pull(me);
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  const answers = await Promise.all(Array.from({ length: 5 }, () => w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } })));
  assert.ok(answers.every((a) => a.status === 200), JSON.stringify(answers.map((a) => a.body)));
  await w.pump(3);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } })).status, 200);
  await w.pump(3);
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("sell, every refusal: not yours, signed-out, wrong price, not drawn yet, offered, claimed, paused, unfunded, gone", async () => {
  const { w, me, other } = await ready();
  const id = await w.pull(me);
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: other, body: { drops } })).body.code, "not_yours");
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: w.client(), body: { drops } })).status, 401);
  for (const bad of ["1", "99999999999", "2550001", "abc", ""]) assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops: bad } })).body.code, "price_changed", bad);
  assert.equal((await w.call("POST", "/api/rip/orders/no-such-order/sell", { as: me, body: { drops } })).body.code, "not_yours");
  process.env.SEAL_SELLBACK_PAUSED = "1";
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } })).body.code, "sell_paused");
  delete process.env.SEAL_SELLBACK_PAUSED;
  const paid = await w.newOrder(me);
  w.ledger.userSubmit(paid.tx as never);
  w.ledger.close();
  await w.engine.advance();
  assert.equal((await w.call("POST", `/api/rip/orders/${paid.order.id}/sell`, { as: me, body: { drops } })).body.code, "not_stashed");
  assert.equal(w.orderOf(id)?.pull, "stashed");
  assert.equal(w.paidTo(PLAYER).length, 0);
});

test("the treasury can't cover a sale: the player is told it's paused, and the NFT stays in the stash", async () => {
  const { w, me } = await ready({ treasuryXrp: 11 });
  const id = await w.pull(me);
  // Bring the treasury down to just above its floor: the pack's 4 XRP doesn't leave enough over it for a 2.55 XRP sale.
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  w.ledger.userSubmit({ TransactionType: "Payment", Account: TREASURY, Destination: VAULT, Amount: "4900000" } as never);
  await w.pump(2);
  const r = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "sell_paused");
  assert.equal(w.orderOf(id)?.pull, "stashed");
  w.ledger.fund(TREASURY, 50);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } })).status, 200);
  await w.pump(3);
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("the NFT left the vault out of band: selling refuses instead of paying for what we don't hold", async () => {
  const { w, me } = await ready();
  const id = await w.pull(me);
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  w.ledger.mintTo(w.orderOf(id)?.nftId as string, OTHER);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } })).body.code, "not_stashed");
  assert.equal(w.paidTo(PLAYER).length, 0);
});

test("claim by route: the first tap makes the offer, the second gets the accept, a double tap makes one offer", async () => {
  const { w, me } = await ready();
  const id = await w.pull(me);
  const taps = await Promise.all(Array.from({ length: 4 }, () => w.call("POST", `/api/rip/orders/${id}/claim`, { as: me })));
  assert.ok(taps.every((t) => t.status === 200));
  await w.pump(2);
  const claim = await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me });
  assert.equal(claim.body.tx.TransactionType, "NFTokenAcceptOffer");
  assert.equal(claim.body.tx.Account, PLAYER);
  const offers = w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenCreateOffer");
  assert.equal(offers.length, 1);
  w.ledger.userSubmit(claim.body.tx);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "claimed");
  assert.equal(w.ledger.ownerOf(w.orderOf(id)?.nftId as string), PLAYER);
  // Claimed: a replay is a calm yes, and it can't be sold or canceled now.
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me })).status, 200);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body.code, "not_stashed");
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: me })).body.code, "no_offer");
});

test("claim, wrong wallet: refused by the server, and the ledger refuses a stranger who takes the offer", async () => {
  const { w, me, other } = await ready();
  const id = await w.pull(me);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/claim`, { as: other })).body.code, "not_yours");
  await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me });
  await w.pump(2);
  const claim = await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me });
  w.ledger.userSubmit({ ...claim.body.tx, Account: OTHER });
  await w.pump(3);
  assert.equal(w.ledger.ownerOf(w.orderOf(id)?.nftId as string), VAULT);
  assert.equal(w.orderOf(id)?.pull, "offered");
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: other })).body.code, "not_yours");
});

test("declined accept: the offer waits, sale is blocked until it's taken back, then the NFT can be sold", async () => {
  const { w, me } = await ready();
  const id = await w.pull(me);
  await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me });
  await w.pump(2);
  assert.equal(w.orderOf(id)?.pull, "offered");
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body.code, "not_stashed");
  const cancels = await Promise.all(Array.from({ length: 3 }, () => w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: me })));
  assert.ok(cancels.every((c) => c.status === 200));
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenCancelOffer").length, 1);
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } })).status, 200);
});

test("signed out, an order's page still reads, and a poll on an unknown id is a 404 that logs nothing", async () => {
  const { w, me } = await ready();
  const id = await w.pull(me);
  const head = w.engine.state.head;
  assert.equal((await w.call("GET", `/api/rip/orders/${id}`)).status, 200);
  for (const junk of ["nope", "__proto__", "constructor", "%00", "a".repeat(500)]) assert.equal((await w.call("GET", `/api/rip/orders/${junk}`)).status, 404, junk);
  assert.equal(w.engine.state.head, head);
});

test("holdings show only your own, never a quote or an expired checkout", async () => {
  const { w, me, other } = await ready();
  const mine = await w.pull(me);
  await w.pull(other);
  await w.newOrder(me);
  const r = await w.call("GET", "/api/rip/holdings", { as: me });
  assert.deepEqual(r.body.orders.map((o: { id: string }) => o.id), [mine]);
});

test("the public log carries no signed bytes and no cost, and junk paging can't break it", async () => {
  const { w, me } = await ready();
  await w.pull(me);
  const events = await logHolds(w);
  const text = JSON.stringify(events);
  assert.ok(events.filter((e) => e.type === "tx_intent").every((e) => e.data.blob === ""));
  assert.ok(events.filter((e) => e.type === "pool_change").every((e) => (e.data.adds as { costDrops: string }[]).every((l) => l.costDrops === "")));
  assert.ok(!text.includes("route-test-draw-secret"));
  for (const q of ["-1", "abc", "1.5", "99999999", "1e9", ""]) {
    const r = await w.call("GET", `/api/rip/log?after=${q}`);
    assert.equal(r.status, 200, q);
    assert.ok(Array.isArray(r.body.events));
  }
  const tail = await w.call("GET", `/api/rip/log?after=${events.length - 1}`);
  assert.equal(tail.body.events.length, 1);
});

test("a server dies between paying and drawing: a cold start finishes it from the log, charged once", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  w.ledger.userSubmit(made.tx as never);
  w.ledger.close();
  w.restart();
  w.ledger.close(4);
  const polled = await w.call("GET", `/api/rip/orders/${made.order.id}`);
  assert.equal(polled.status, 200);
  await w.pump(2);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
  assert.equal(w.ledger.history.filter((t) => t.tx.Account === PLAYER).length, 1);
  await logHolds(w);
});

test("Xaman on: the order comes with a link pinned to mainnet, says nothing about testnet, and a repeat tap still gets a link", async () => {
  const { w, me } = await ready({ xaman: true });
  const first = await w.newOrder(me);
  assert.match(String((first.wallet as { open: string }).open), /^https:\/\/xumm\.app\//);
  const sent = w.xaman.calls[0];
  assert.equal(sent.options.force_network, "MAINNET");
  assert.equal(sent.options.submit, true);
  assert.ok(!/testnet/i.test(sent.custom_meta.instruction));
  assert.equal(sent.txjson.Amount, "4000000");
  const again = await w.newOrder(me);
  assert.equal(again.order.id, first.order.id);
  assert.ok(again.wallet, "a second tap on the same order should still get a Xaman link");
});

test("Xaman down or slow: the order still stands with the transaction to sign by hand", async () => {
  const { w, me } = await ready({ xaman: true });
  w.xaman.mode = "down";
  const made = await w.newOrder(me);
  assert.equal(made.wallet, null);
  assert.equal(made.tx.Amount, "4000000");
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
});

test("the ledger stops answering: reads still answer from the log, and an order that was made still stands", async () => {
  let down = false;
  const { w, me } = await ready({
    wrapChain: (c) =>
      new Proxy(c, {
        get(target, key: keyof typeof c) {
          const v = target[key];
          if (typeof v !== "function") return v;
          return (...a: unknown[]) => (down ? Promise.reject(new Error("rpc timeout")) : (v as (...x: unknown[]) => unknown).apply(target, a));
        },
      }),
  });
  const id = await w.pull(me);
  const stale = await w.newOrder(me);
  down = true;
  assert.equal((await w.call("GET", `/api/rip/orders/${id}`)).status, 200);
  assert.equal((await w.call("GET", "/api/rip/holdings", { as: me })).status, 200);
  const head = w.engine.state.head;
  // New business can't start blind, and the refusal charges nothing.
  const r = await w.call("POST", "/api/rip/orders", { as: w.client(OTHER), body: { price: 5 } });
  assert.notEqual(r.status, 200);
  assert.equal(w.engine.state.head, head);
  down = false;
  await w.pump(2);
  assert.equal(w.orderOf(stale.order.id)?.status, "quoted");
});

test("an order made just before the ledger drops out isn't reported as a failure", async () => {
  let failAdvance = false;
  const { w, me } = await ready({
    wrapChain: (c) => ({
      ...c,
      accountTx: (...a: Parameters<typeof c.accountTx>) => (failAdvance ? Promise.reject(new Error("rpc timeout")) : c.accountTx(...a)),
    }),
  });
  failAdvance = true;
  w.state.clockMs += 60_000;
  const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(r.status, 200, String(r.thrown));
  assert.equal(r.body.order.status, "quoted");
});

test("a hold takes a wallet that can pay, and one that keeps walking away from quotes has to wait", async () => {
  const { w, me } = await ready();
  const broke = w.client(addressOf(9));
  assert.equal((await w.call("POST", "/api/rip/orders", { as: broke, body: { price: 5 } })).body.code, "wallet_short");
  w.ledger.fund(addressOf(9), 2);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: broke, body: { price: 5 } })).body.code, "wallet_short");
  assert.equal(holdsFor(w.engine.state, 5), 0);
  let refused: string | undefined;
  for (let i = 0; i < 12 && !refused; i++) {
    const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
    if (r.status !== 200) refused = r.body.code;
    w.ledger.close(ORDER_LEDGERS + 2);
    await w.engine.advance();
  }
  assert.equal(refused, "too_many_lapsed");
});

test("an order while the ledger can't be read says nothing was charged, and opens nothing", async () => {
  let down = false;
  const { w, me } = await ready({
    wrapChain: (c) => ({
      ...c,
      validatedLedger: () => {
        if (down) throw new Error("the ledger server is down");
        return c.validatedLedger();
      },
    }),
  });
  down = true;
  const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5, acceptedTerms: true } });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "unavailable");
  assert.match(r.body.error, /Nothing was charged/);
  assert.equal(r.body.tx, undefined);
  down = false;
  assert.ok(!(await logHolds(w)).some((e) => e.type === "order_created"));
  assert.equal((await w.newOrder(me)).order.status, "quoted");
});
