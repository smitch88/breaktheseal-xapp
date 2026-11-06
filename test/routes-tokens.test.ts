import assert from "node:assert/strict";
import { test } from "node:test";
import { SEAL_CURRENCY, SEAL_ISSUER, SEAL_TOKEN, XRP_TOKEN } from "../src/lib/rip/tokens.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { CRON, TREASURY, VAULT, addressOf, world, type World } from "./support-routes.ts";
import { nftIdFor } from "./support-ledger.ts";

/**
 * Token prizes by route: stash, redeem, sell, no trust line, a declined one, and a pack paused on a stale price. The engine's
 * rules are in token-prizes.test.ts. These are the same interactions through the guard, with every failure a player can cause.
 */
const PLAYER = addressOf(1);
const OTHER = addressOf(2);
const spec = { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer: SEAL_ISSUER };
const TREASURY_SEAL = 100_000_000_000n;
let nft = 7000;

async function ready(token: string, opts: Parameters<typeof world>[0] = {}) {
  const w = await world(opts);
  const me = w.client(PLAYER);
  const other = w.client(OTHER);
  w.fund(me);
  w.fund(other);
  w.ledger.setPool(spec, "33000000000", "44800000000000000");
  w.ledger.setLine(spec, TREASURY, TREASURY_SEAL);
  // Every pull pays this token, so each test gets the prize it's about.
  const prizeTable = [{ band: 0, token, bps: 9999, valueDrops: "2000000" }];
  await w.engine.openSeason(5, "4000000", w.state.rate, { bandBps: [10000, 0, 0, 0, 0], prizeTable, tokens: token === SEAL_TOKEN ? [spec] : [] });
  const adds = [0, 1, 2, 3, 4].flatMap((band) =>
    [0, 1].map(() => {
      const nftId = nftIdFor(++nft);
      w.ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: "c", name: "n", img: "/x.webp", costDrops: "1", markDrops: "1" };
    }),
  );
  await w.engine.changePool(5, adds);
  await w.pump(4);
  return { w, me, other };
}

async function prize(w: World, me: ReturnType<World["client"]>) {
  const id = await w.pull(me);
  const got = await w.call("GET", `/api/rip/orders/${id}`);
  assert.equal(got.body.order.pull, "stashed", JSON.stringify(got.body.order));
  assert.ok(got.body.order.prize, "this pull should have paid a token");
  return id;
}

const redeem = (w: World, c: ReturnType<World["client"]>, id: string) => w.call("POST", `/api/rip/orders/${id}/redeem`, { as: c, body: {} });

test("stash: a token prize rests in the stash, shows in holdings with its fixed amount, and the log replays", async () => {
  const { w, me } = await ready(SEAL_TOKEN);
  const id = await prize(w, me);
  const held = await w.call("GET", "/api/rip/holdings", { as: me });
  const row = held.body.orders.find((o: { id: string }) => o.id === id);
  assert.equal(row.prize.token, SEAL_TOKEN);
  assert.ok(BigInt(row.prize.amount) > 0n);
  const before = row.prize.amount;
  // The amount was struck at the draw. The price moving later changes nothing.
  w.ledger.setPool(spec, "20000000000", "44800000000000000");
  await w.pump(2);
  assert.equal((await w.call("GET", `/api/rip/orders/${id}`)).body.order.prize.amount, before);
  assert.equal(replayLog((await w.call("GET", "/api/rip/log")).body.events).ok, true);
});

test("redeem XRP: a double tap and a replay pay once, and it can't be redeemed by a stranger, signed out, or from elsewhere", async () => {
  const { w, me, other } = await ready(XRP_TOKEN);
  const id = await prize(w, me);
  assert.equal((await redeem(w, other, id)).status, 409);
  assert.equal((await redeem(w, w.client(), id)).status, 401);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/redeem`, { as: me, origin: "https://evil.test", body: {} })).status, 403);
  assert.equal((await redeem(w, me, "no-such-order")).status, 409);
  const before = w.ledger.balance(PLAYER);
  const taps = await Promise.all(Array.from({ length: 5 }, () => redeem(w, me, id)));
  assert.ok(taps.every((t) => t.status === 200), JSON.stringify(taps.map((t) => t.body.code)));
  await w.pump(3);
  assert.equal((await redeem(w, me, id)).status, 200);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "redeemed");
  assert.equal(w.paidTo(PLAYER).length, 1);
  assert.equal(w.ledger.balance(PLAYER) - before, 2_000_000n);
});

test("rails off, and the allowlist: redeem is a 404 and a refusal", async () => {
  const off = await world({ off: true });
  assert.equal((await redeem(off, off.client(PLAYER), "x")).status, 404);
  const closed = await world({ allowed: PLAYER });
  const r = await redeem(closed, closed.client(OTHER), "x");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "not_open");
});

test("redeem with no trust line: the wallet gets a TrustSet to sign, nothing moves, and the prize stays in the stash", async () => {
  const { w, me } = await ready(SEAL_TOKEN);
  const id = await prize(w, me);
  const ask = await redeem(w, me, id);
  assert.equal(ask.status, 200);
  assert.equal(ask.body.needsTrustLine, true);
  assert.equal(ask.body.tx.TransactionType, "TrustSet");
  assert.equal(ask.body.tx.LimitAmount.issuer, SEAL_ISSUER);
  assert.equal(ask.body.tx.LimitAmount.currency, SEAL_CURRENCY);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  await w.pump(3);
  assert.equal(w.ledger.tokenBalance(spec, TREASURY), TREASURY_SEAL);
});

test("a declined trust line loses nothing: ask as often as you like, sell instead, or sign later and it arrives once", async () => {
  const { w, me } = await ready(SEAL_TOKEN);
  const id = await prize(w, me);
  const amount = BigInt(w.orderOf(id)?.prize?.amount ?? 0);
  // Declined, three times, and a double tap on the ask.
  const asks = await Promise.all(Array.from({ length: 3 }, () => redeem(w, me, id)));
  assert.ok(asks.every((a) => a.body.needsTrustLine === true));
  await w.pump(4);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  // Signs in the end.
  w.ledger.setLine(spec, PLAYER, 0n);
  const go = await Promise.all(Array.from({ length: 3 }, () => redeem(w, me, id)));
  assert.ok(go.every((g) => g.status === 200));
  await w.pump(4);
  assert.equal((await redeem(w, me, id)).status, 200);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "redeemed");
  assert.equal(w.ledger.tokenBalance(spec, PLAYER), amount);
  assert.equal(w.ledger.tokenBalance(spec, TREASURY), TREASURY_SEAL - amount);
});

test("Xaman on: a trust line request gets a link, and Xaman being down still gets the transaction to sign by hand", async () => {
  const { w, me } = await ready(SEAL_TOKEN, { xaman: true });
  const id = await prize(w, me);
  const ask = await redeem(w, me, id);
  assert.ok(ask.body.wallet?.open);
  assert.equal(w.xaman.calls.at(-1)?.txjson.TransactionType, "TrustSet");
  assert.equal(w.xaman.calls.at(-1)?.options.force_network, "MAINNET");
  w.xaman.mode = "down";
  const again = await redeem(w, me, id);
  assert.equal(again.body.wallet, null);
  assert.equal(again.body.tx.TransactionType, "TrustSet");
});

test("sell SEAL: a quote, a double tap pays once, a stale quote is refused, a stranger is refused, and the token stays with us", async () => {
  const { w, me, other } = await ready(SEAL_TOKEN);
  const id = await prize(w, me);
  const quote = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: other })).status, 409);
  // A quote above the market is refused, with the live one to confirm. A sale only ever pays what the market still covers.
  const high = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops: (BigInt(quote.body.drops) * 2n).toString() } });
  assert.equal(high.body.code, "price_changed");
  assert.equal(high.body.drops, quote.body.drops);
  for (const junk of ["0", "-1", "1e9", "abc"]) assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops: junk } })).body.code, "price_changed", junk);
  const before = w.ledger.balance(PLAYER);
  const taps = await Promise.all(Array.from({ length: 4 }, () => w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops: quote.body.drops } })));
  assert.ok(taps.some((t) => t.status === 200));
  await w.pump(4);
  assert.equal(w.orderOf(id)?.pull, "sold");
  assert.equal(w.ledger.balance(PLAYER) - before, BigInt(quote.body.drops));
  assert.equal(w.paidTo(PLAYER).length, 1);
  assert.equal(w.ledger.tokenBalance(spec, TREASURY), TREASURY_SEAL);
  assert.equal((await redeem(w, me, id)).status, 409);
});

test("an XRP prize has no sale, and a token prize can't be claimed like an NFT", async () => {
  const { w, me } = await ready(XRP_TOKEN);
  const id = await prize(w, me);
  assert.equal((await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body.code, "no_sale");
  assert.notEqual((await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me })).status, 200);
  assert.equal(w.orderOf(id)?.pull, "stashed");
});

test("redeeming blocks a sale, and selling blocks a redeem", async () => {
  const a = await ready(SEAL_TOKEN);
  const id = await prize(a.w, a.me);
  a.w.ledger.setLine(spec, PLAYER, 0n);
  await redeem(a.w, a.me, id);
  assert.equal(a.w.orderOf(id)?.pull, "redeeming");
  assert.equal((await a.w.call("POST", `/api/rip/orders/${id}/sell`, { as: a.me })).status, 409);
  const b = await ready(SEAL_TOKEN);
  const id2 = await prize(b.w, b.me);
  const q = await b.w.call("POST", `/api/rip/orders/${id2}/sell`, { as: b.me });
  await b.w.call("POST", `/api/rip/orders/${id2}/sell`, { as: b.me, body: { drops: q.body.drops } });
  assert.equal(b.w.orderOf(id2)?.pull, "selling");
  assert.equal((await redeem(b.w, b.me, id2)).status, 409);
});

test("a server dies mid-redeem: a cold start finishes it from the log, and it pays once", async () => {
  const { w, me } = await ready(XRP_TOKEN);
  const id = await prize(w, me);
  await redeem(w, me, id);
  await w.engine.advance();
  w.restart();
  w.ledger.close();
  w.restart();
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "redeemed");
  assert.equal(w.paidTo(PLAYER).length, 1);
  assert.equal(replayLog(await w.store.readFrom(0)).ok, true);
});

test("a pack paused on a bad token price: refused before anything is charged, and it reopens when the price is good", async () => {
  const { w, me } = await ready(SEAL_TOKEN);
  const before = w.ledger.balance(PLAYER);
  // Half the pool's XRP: the price moved far from half an hour back.
  w.ledger.setPool(spec, "15000000000", "44800000000000000");
  w.ledger.close();
  const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "prize_paused");
  assert.equal(w.engine.state.orders.size, 0);
  assert.equal(w.ledger.balance(PLAYER), before);
});

test("a low float reaches the owner once per change through the sweep, closes the pack with nothing charged, and clears when refilled", async () => {
  const { w, me } = await ready(SEAL_TOKEN);
  process.env.SEAL_ALERT_WEBHOOK = "https://hook.test/alert";
  const posts: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://hook.test/")) {
      posts.push(String(init?.body));
      return new Response("{}");
    }
    return inner(url as string, init);
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const tick = () => w.call("GET", "/api/rip/tick", { headers: { authorization: `Bearer ${CRON}` } });
    assert.equal((await tick()).body.sealFloatLow, false);
    assert.equal(posts.length, 0);
    w.ledger.setLine(spec, TREASURY, 1000n);
    const low = await tick();
    assert.equal(low.body.sealFloatLow, true);
    assert.deepEqual(low.body.packsPaused, [5]);
    await tick();
    assert.equal(posts.length, 1, "one alert for one change");
    assert.ok(!/RTP|house edge/i.test(posts[0]));
    const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
    assert.equal(r.status, 409);
    assert.equal(w.engine.state.orders.size, 0);
    w.ledger.setLine(spec, TREASURY, TREASURY_SEAL);
    const back = await tick();
    assert.equal(back.body.sealFloatLow, false);
    assert.deepEqual(back.body.packsPaused, []);
    assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).status, 200);
  } finally {
    console.warn = warn;
    globalThis.fetch = inner;
  }
});

test("the sweep posts what stops money quietly, once per change: a short XRP float, then a sweep that can't run", async () => {
  const { w } = await ready(XRP_TOKEN);
  process.env.SEAL_ALERT_WEBHOOK = "https://hook.test/alert";
  const posts: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://hook.test/")) {
      posts.push(String(init?.body));
      return new Response("{}");
    }
    return inner(url as string, init);
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const tick = () => w.call("GET", "/api/rip/tick", { headers: { authorization: `Bearer ${CRON}` } });
    assert.deepEqual((await tick()).body.alerts, []);
    w.ledger.fund(TREASURY, -Number((w.ledger.balance(TREASURY) - 10_500_000n) / 1_000_000n));
    assert.deepEqual((await tick()).body.alerts, ["xrp_float"]);
    await tick();
    assert.equal(posts.length, 1, "one alert for one change");
    assert.match(posts[0], /XRP float/);
    assert.ok(!/RTP|house edge/i.test(posts[0]));
    (w.engine as { advance: unknown }).advance = async () => {
      throw new Error("the ledger server is down");
    };
    const down = await tick();
    assert.equal(down.status, 200);
    assert.ok(down.body.alerts.includes("sweep_failed"));
    assert.match(posts[1], /sweep failed/);
  } finally {
    console.warn = warn;
    globalThis.fetch = inner;
  }
});

test("the shelf can't read open while the pack would refuse: short of SEAL, or XRP moved, and it reopens by itself", async () => {
  const { w, me } = await ready(SEAL_TOKEN);
  const five = async () => (await w.call("GET", "/api/rip/config")).body.tiers.find((t: { price: number }) => t.price === 5);
  assert.equal((await five()).open, true);
  w.ledger.setLine(spec, TREASURY, 1000n);
  w.ledger.close();
  assert.equal((await five()).open, false, "the shelf read open while the checkout refuses");
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).status, 409);
  w.ledger.setLine(spec, TREASURY, TREASURY_SEAL);
  w.ledger.close();
  assert.equal((await five()).open, true);
  w.state.rate = 2.5;
  w.ledger.close();
  assert.equal((await five()).open, false, "XRP moved past the guard and the shelf read open");
  w.state.rate = 1.25;
  w.ledger.close();
  assert.equal((await five()).open, true);
});

test("an owed prize says so on the player's own pages, with no refund, and pays itself after a top-up", async () => {
  const { w, me } = await ready(XRP_TOKEN);
  const q = await w.newOrder(me);
  w.ledger.userSubmit(q.tx as never);
  w.ledger.close();
  // The owner sweeps the float while this pull waits for its draw.
  w.ledger.fund(TREASURY, -Number((w.ledger.balance(TREASURY) - 10_000_000n) / 1_000_000n));
  await w.pump(6);
  const id = q.order.id as string;
  const got = await w.call("GET", `/api/rip/orders/${id}`);
  assert.equal(got.body.order.status, "drawn");
  assert.equal(got.body.order.refund, null);
  assert.equal(got.body.order.prize.owed, true);
  assert.equal(got.body.order.pull, "redeeming");
  const held = await w.call("GET", "/api/rip/holdings", { as: me });
  assert.equal(held.body.orders.find((o: { id: string }) => o.id === id).prize.owed, true);
  assert.equal(w.paidTo(PLAYER).length, 0);
  w.ledger.fund(TREASURY, 100);
  await w.pump(3);
  const paid = await w.call("GET", `/api/rip/orders/${id}`);
  assert.equal(paid.body.order.pull, "redeemed");
  assert.equal(w.paidTo(PLAYER).length, 1);
  assert.equal(replayLog(await w.store.readFrom(0)).ok, true);
});
