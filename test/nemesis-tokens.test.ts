import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SHELF_PRICES, type NftPrice } from "../src/config/nft-packs.ts";
import { createEngine, sellBackShare, type RipEngine } from "../src/lib/rip/engine.ts";
import { lotsNeeded, nftChanceOf, stockCovers } from "../src/lib/rip/draw.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { emptyState, treasuryOwed, tokenOwed } from "../src/lib/rip/state.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { SEAL_CURRENCY, SEAL_ISSUER, SEAL_TOKEN, XRP_TOKEN, checkPool, iouToMicro, seasonPlan, strikeAmount, tokenSellDrops, type TokenSpec } from "../src/lib/rip/tokens.ts";
import type { RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/**
 * Failures found by the second nemesis audit, over token prizes. Each is written to fail on the code it was found in.
 * Racing servers, a pool pushed around the draw, and a treasury run down to the edge are what the flow tests don't show.
 */
const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const FUNDER = "rFUNDERfunderFUNDERfunderFUNDER";
const SPEC: TokenSpec = { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer: SEAL_ISSUER };
const POOL_XRP = "33007194945";
const POOL_TOKEN = iouToMicro("44788357114.1098");
const ALL = (token: string, valueDrops: string) => ({ bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token, bps: 10000, valueDrops }], tokens: token === SEAL_TOKEN ? [SPEC] : [] });
type Deps = Partial<Parameters<typeof createEngine>[0]>;

async function setup(opts: { treasuryXrp?: number; seal?: bigint; stock?: number; deps?: Deps; seasons?: readonly [NftPrice, string, Parameters<RipEngine["openSeason"]>[3]][] } = {}) {
  const ledger = testLedger("nemesis-tokens");
  ledger.fund(TREASURY, opts.treasuryXrp ?? 1000);
  ledger.fund(VAULT, 100);
  for (const a of [PLAYER, OTHER, FUNDER]) ledger.fund(a, 5000);
  ledger.setPool(SPEC, POOL_XRP, POOL_TOKEN);
  ledger.setLine(SPEC, TREASURY, opts.seal ?? 10_000_000_000n);
  const store = memoryStore();
  const make = (extra: Deps = {}) => createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "test-secret", expectedNetworkId: 1, ...opts.deps, ...extra });
  const engine = make();
  let n = 0;
  for (const [price, drops, plan] of opts.seasons ?? [[10, "8000000", ALL(SEAL_TOKEN, "2500000")] as const]) {
    await engine.openSeason(price, drops, null, plan);
    const adds = [0, 1, 2, 3, 4].flatMap((band) => Array.from({ length: opts.stock ?? 6 }, () => {
      const nftId = nftIdFor(++n);
      ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: `c${band}`, name: `n${n}`, img: "/x.webp", costDrops: "1000000", markDrops: "1000000" };
    }));
    assert.equal((await engine.changePool(price, adds)).ok, true);
  }
  await run(engine, ledger, 8);
  return { ledger, store, engine, make };
}

async function run(engine: RipEngine, ledger: ReturnType<typeof testLedger>, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

async function paid(engine: RipEngine, ledger: ReturnType<typeof testLedger>, price: NftPrice = 10, who = PLAYER) {
  const q = await engine.createOrder(who, price);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  return q.order.id;
}

const payouts = (ledger: ReturnType<typeof testLedger>, to = PLAYER) => ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.tx.Destination === to && t.result === "tesSUCCESS");

test("a pool pushed past the guard at the draw can't turn a losing SEAL row into a whole refund: the row pays its value in XRP", async () => {
  const { engine, ledger, store } = await setup();
  const id = await paid(engine, ledger);
  // The player pays, then pushes the pool 6% before their entropy ledger closes. On the code this was found in, a row worth
  // 2.5 XRP became an 8 XRP refund, while every NFT and XRP row kept paying: a one-way bet on every pull.
  ledger.setPool(SPEC, String((BigInt(POOL_XRP) * 106n) / 100n), POOL_TOKEN);
  await run(engine, ledger, 8);
  const o = engine.state.orders.get(id)!;
  assert.equal(o.status, "drawn", "the pull was refunded");
  assert.equal(o.prize?.token, XRP_TOKEN);
  assert.equal(o.prize?.amount, "2500000");
  assert.equal(engine.state.refunds.size, 0);
  const replay = replayLog(await store.readFrom(0));
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("the same push can't void a big SEAL win either: the winner still gets its value", async () => {
  const { engine, ledger } = await setup({ seasons: [[10, "60000000", ALL(SEAL_TOKEN, "42000000")]] });
  const id = await paid(engine, ledger);
  ledger.setPool(SPEC, POOL_XRP, String((BigInt(POOL_TOKEN) * 106n) / 100n));
  await run(engine, ledger, 8);
  const o = engine.state.orders.get(id)!;
  assert.equal(o.status, "drawn");
  assert.equal(o.prize?.amount, "42000000");
});

test("an unreadable pool past the wait, or SEAL running short, pays the row in XRP and never refunds", async () => {
  const down = await setup();
  const a = await paid(down.engine, down.ledger);
  down.ledger.setPoolDown(true);
  await run(down.engine, down.ledger, 3);
  assert.equal(down.engine.state.orders.get(a)?.status, "paid", "it waits first, in order");
  down.ledger.close(200);
  await run(down.engine, down.ledger, 3);
  assert.equal(down.engine.state.orders.get(a)?.prize?.token, XRP_TOKEN);
  assert.equal(down.engine.state.refunds.size, 0);

  const short = await setup();
  const b = await paid(short.engine, short.ledger);
  short.ledger.setLine(SPEC, TREASURY, 0n);
  await run(short.engine, short.ledger, 8);
  assert.equal(short.engine.state.orders.get(b)?.prize?.token, XRP_TOKEN);
  assert.equal(short.engine.state.refunds.size, 0);
  assert.equal(tokenOwed(short.engine.state, SEAL_TOKEN), 0n);
});

test("property: whatever the pool or the SEAL float does around a paid pull, a token row is never a refund, and the log replays", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 20, max: 300 }), fc.integer({ min: 20, max: 300 }), fc.boolean(), async (nowPct, tokPct, drain) => {
      const { engine, ledger, store } = await setup();
      const id = await paid(engine, ledger);
      if (drain) ledger.setLine(SPEC, TREASURY, 1n);
      ledger.setPool(SPEC, String((BigInt(POOL_XRP) * BigInt(nowPct)) / 100n), String((BigInt(POOL_TOKEN) * BigInt(tokPct)) / 100n));
      await run(engine, ledger, 8);
      const o = engine.state.orders.get(id)!;
      assert.equal(o.status, "drawn");
      assert.equal(engine.state.refunds.size, 0);
      const r = replayLog(await store.readFrom(0));
      assert.ok(r.ok, JSON.stringify(r));
    }),
    { numRuns: 25 },
  );
});

test("two wins in one short pass: the second counts what the first took, neither is voided, and a top-up pays both once", async () => {
  // Two tiers. A $10 pull that can't be covered is owed, and a $5 pull right behind it is looking at the same XRP.
  const { engine, ledger } = await setup({ treasuryXrp: 200, seasons: [[10, "100000000", ALL(XRP_TOKEN, "60000000")], [5, "20000000", ALL(XRP_TOKEN, "15000000")]] });
  const first = await paid(engine, ledger, 10);
  const second = await paid(engine, ledger, 5, OTHER);
  ledger.close();
  // The owner sweeps the float down between the payments and the draw: 30 XRP free above the floor.
  const floor = 10_000_000n;
  ledger.fund(TREASURY, -Number((ledger.balance(TREASURY) - floor - 30_000_000n) / 1_000_000n));
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(first)?.prize?.owed, true);
  assert.equal(engine.state.orders.get(second)?.prize?.owed, true, "the second pull was promised XRP the first already took");
  assert.equal(engine.state.refunds.size, 0);
  ledger.fund(TREASURY, 100);
  await run(engine, ledger, 4);
  assert.equal(payouts(ledger).length, 1);
  assert.equal(payouts(ledger, OTHER).length, 1);
});

test("selling back can't spend the XRP held for a paid pull: a winner isn't refunded because someone else sold first", async () => {
  // Pack A's SEAL prize sells for about 68 XRP. Pack B pays 42 XRP on a 45 XRP pack.
  const { engine, ledger } = await setup({ treasuryXrp: 100, seasons: [[10, "100000000", ALL(SEAL_TOKEN, "80000000")], [5, "45000000", ALL(XRP_TOKEN, "42000000")]] });
  const stash = await paid(engine, ledger, 10);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(stash)?.prize?.token, SEAL_TOKEN);
  // The owner has spent the takings on restocking. 90 XRP stays free: enough for the next pull's top prize.
  ledger.fund(TREASURY, -Number((ledger.balance(TREASURY) - 10_000_000n - 90_000_000n) / 1_000_000n));
  const winner = await paid(engine, ledger, 5, OTHER);
  ledger.close();
  await engine.advance();
  assert.equal(engine.state.orders.get(winner)?.status, "paid");
  const quote = await engine.quoteSell(PLAYER, stash);
  assert.ok(quote.ok, JSON.stringify(quote));
  // 100 XRP free: selling for about 68 would leave less than the 42 the winner may need.
  ledger.fund(TREASURY, -Number((ledger.balance(TREASURY) - 10_000_000n - 100_000_000n) / 1_000_000n));
  const sale = await engine.sell(PLAYER, stash, quote.drops);
  assert.equal(sale.ok, false, "the sale spent XRP held for a paid pull");
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(winner)?.status, "drawn", "the winner was refunded");
  assert.equal(engine.state.orders.get(winner)?.prize?.amount, "42000000");
  // Once the draw is done, nothing is held, and the sale goes through.
  const again = await engine.quoteSell(PLAYER, stash);
  assert.ok(again.ok);
  ledger.fund(TREASURY, 100);
  assert.deepEqual(await engine.sell(PLAYER, stash, again.drops), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(stash)?.pull, "sold");
  assert.ok(ledger.balance(TREASURY) >= treasuryOwed(engine.state));
});

test("SEAL_TOKEN_PRIZES=off flipped mid-season: new draws pay XRP at value, the float stops mattering, stashed SEAL still redeems once", async () => {
  const { engine, ledger, make, store } = await setup();
  const stashed = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(stashed)?.prize?.token, SEAL_TOKEN);
  const off = make({ sealOff: true });
  await off.sync();
  ledger.setLine(SPEC, TREASURY, BigInt(engine.state.orders.get(stashed)?.prize?.amount as string));
  const next = await off.createOrder(OTHER, 10);
  assert.ok(next.ok, JSON.stringify(next));
  ledger.userSubmit(next.tx as never);
  await run(off, ledger, 8);
  const o = off.state.orders.get(next.order.id)!;
  assert.equal(o.prize?.token, XRP_TOKEN);
  assert.equal(o.prize?.amount, "2500000");
  assert.equal(await off.sealFloatStatus(), null);
  ledger.setLine(SPEC, PLAYER, 0n);
  assert.deepEqual(await off.redeem(PLAYER, stashed), { ok: true });
  await run(off, ledger, 3);
  assert.equal(off.state.orders.get(stashed)?.pull, "redeemed");
  assert.equal(payouts(ledger).length, 1);
  const r = replayLog(await store.readFrom(0));
  assert.ok(r.ok, JSON.stringify(r));
});

test("the lookalike issuer can't get in: no season, no trust line and no payout names it", async () => {
  const { sealTokenSpec } = await import("../src/lib/rip/tokens.ts");
  const lookalike = "rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB";
  assert.throws(() => sealTokenSpec({ SEAL_RAILS_MODE: "mainnet", SEAL_TOKEN_ISSUER: lookalike }), /fixed/);
  // A holder of the lookalike alone has no line to the real token, so redeeming asks for the real one.
  const { engine, ledger } = await setup();
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  ledger.setLine({ currency: SEAL_CURRENCY, issuer: lookalike }, PLAYER, 5n);
  const need = await engine.redeem(PLAYER, id);
  assert.equal(need.ok, false);
  assert.equal((need as { code: string }).code, "needs_trustline");
  assert.equal((need as unknown as { tx: { LimitAmount: { issuer: string } } }).tx.LimitAmount.issuer, SEAL_ISSUER);
});

test("SEAL dust into the treasury costs the log nothing, and verify still passes", async () => {
  const { engine, ledger, store } = await setup();
  ledger.setLine(SPEC, OTHER, 1000n);
  const before = (await store.readFrom(0)).length;
  for (let i = 0; i < 25; i++) ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: { currency: SEAL_CURRENCY, issuer: SEAL_ISSUER, value: "1" } });
  await run(engine, ledger, 3);
  const added = (await store.readFrom(0)).slice(before).filter((e) => e.type === "payment_ignored" || e.type === "payment_refund_due");
  assert.equal(added.length, 0, "token dust grew the log");
  const check = await verifyAgainstChain(await store.readFrom(0), ledger.chain, TREASURY, 100);
  assert.ok(check.ok, JSON.stringify(check));
});

test("a stream of dust, one a ledger, can't grow the log a line a ledger through the scan's own bookmark", async () => {
  const { engine, ledger, store } = await setup();
  ledger.setLine(SPEC, OTHER, 100_000n);
  const before = (await store.readFrom(0)).length;
  for (let i = 0; i < 60; i++) {
    ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: { currency: SEAL_CURRENCY, issuer: SEAL_ISSUER, value: "1" } });
    ledger.userSubmit({ TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "1" });
    await engine.advance();
    ledger.close();
  }
  await engine.advance();
  const grew = (await store.readFrom(0)).length - before;
  assert.ok(grew <= 2, `60 ledgers of dust wrote ${grew} log entries, about 21,600 a day for 0.2 XRP`);
  // A long quiet stretch still moves the bookmark, so a later pass doesn't reread it.
  ledger.close(600);
  ledger.userSubmit({ TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "1" });
  ledger.close();
  await engine.advance();
  assert.ok((engine.state.cursors.get(TREASURY) as number) > ledger.ledger() - 10);
});

test("property: however the pool is held, pushed or walked up one step at a time, selling a struck prize never pays what it's worth, so selling can't beat the draw", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 5_000_000_000n, max: 200_000_000_000n }), fc.bigInt({ min: 10n ** 15n, max: 10n ** 17n }), fc.integer({ min: -500, max: 500 }), fc.integer({ min: 100_000, max: 200_000_000 }), fc.integer({ min: 1000, max: 9000 }), fc.array(fc.integer({ min: -500, max: 500 }), { maxLength: 30 }), (x, t, moveBps, value, sellBps, walk) => {
        const prior = { ledger: 1, xrpDrops: ((x * BigInt(10_000 + moveBps)) / 10_000n).toString(), tokenMicro: t.toString(), closeMs: null };
        const now = { ledger: 451, xrpDrops: x.toString(), tokenMicro: t.toString(), closeMs: null };
        const check = checkPool(now, prior);
        if (!check.ok) return;
        const amount = strikeAmount(String(value), check.strike);
        if (amount <= 0n) return;
        // The stash holds it while the pool moves, each half hour inside the guard, for as long as anyone likes.
        let last = now;
        for (const step of walk) {
          const next = { ...last, ledger: last.ledger + 450, xrpDrops: ((BigInt(last.xrpDrops) * BigInt(10_000 + step)) / 10_000n).toString() };
          const moved = checkPool(next, last);
          last = next;
          if (!moved.ok) continue;
          const sale = tokenSellDrops(amount.toString(), moved.sell, sellBps, String(value));
          assert.ok(sale * 10_000n <= BigInt(value) * BigInt(sellBps), `${sale} on a prize worth ${value}`);
        }
        const sale = tokenSellDrops(amount.toString(), check.sell, sellBps, String(value));
        assert.ok(sale * 10_000n <= BigInt(value) * BigInt(sellBps), `${sale} on a prize worth ${value}`);
      },
    ),
  );
  // The walk the audit found: 42 XRP struck, and 13 steps of 4% up.
  const start = { ledger: 1, xrpDrops: POOL_XRP, tokenMicro: POOL_TOKEN, closeMs: null };
  const check = checkPool(start, start);
  assert.ok(check.ok);
  const amount = strikeAmount("42000000", check.strike);
  let x = BigInt(POOL_XRP);
  for (let i = 0; i < 13; i++) x = (x * 104n) / 100n;
  const high = { xrpDrops: x.toString(), tokenMicro: POOL_TOKEN };
  assert.equal(tokenSellDrops(amount.toString(), high, 8500, "42000000"), 35_700_000n);
});

test("a wallet that refuses its own prize can't spin on the treasury's one slot: it waits, and everyone behind it gets paid", async () => {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", ALL(XRP_TOKEN, "2500000")]] });
  const mine = await paid(engine, ledger);
  await run(engine, ledger, 8);
  const theirs = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  ledger.refusePayments(PLAYER, "tecNO_PERMISSION");
  const before = (await store.readFrom(0)).length;
  let refusedAgain = false;
  for (let i = 0; i < 30; i++) {
    const r = await engine.redeem(PLAYER, mine);
    if (!r.ok && r.code === "try_later") refusedAgain = true;
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
  assert.ok(refusedAgain, "it was never told to wait");
  assert.ok((await store.readFrom(0)).length - before <= 6, "each try wrote to the log and burned a treasury slot");
  assert.deepEqual(await engine.redeem(OTHER, theirs), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(theirs)?.pull, "redeemed");
  // Nothing is lost: once the wallet takes payments and the wait is over, it's paid once.
  ledger.refusePayments(PLAYER, null);
  ledger.close(300);
  assert.equal(engine.state.orders.get(mine)?.pull, "stashed");
  assert.deepEqual(await engine.redeem(PLAYER, mine), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(mine)?.pull, "redeemed");
  assert.equal(payouts(ledger).length, 1);
});

test("claim and cancel can't loop on the vault's one slot: after a cancel the NFT can be sold now and claimed again later", async () => {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", { bandBps: [10000, 0, 0, 0, 0], prizeTable: [], tokens: [] }]] });
  const mine = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.ok((await engine.claim(PLAYER, mine)).ok);
  await run(engine, ledger, 2);
  assert.ok((await engine.cancelClaim(PLAYER, mine)).ok);
  await run(engine, ledger, 2);
  assert.equal(engine.state.orders.get(mine)?.pull, "stashed");
  const before = (await store.readFrom(0)).length;
  const again = await engine.claim(PLAYER, mine);
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.code, "try_later");
  assert.equal((await store.readFrom(0)).length, before);
  assert.ok(engine.sellPrice(PLAYER, mine).ok, "selling is what a cancel is for");
  ledger.close(300);
  await engine.advance();
  assert.ok((await engine.claim(PLAYER, mine)).ok);
});

test("a funding wallet that buys a pack gets a pack: only a payment naming no order is funding", async () => {
  const { engine, ledger, store } = await setup({ deps: { fundingAddresses: [FUNDER] } });
  const id = await paid(engine, ledger, 10, FUNDER);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(id)?.status, "drawn", "the owner's own check would hang here");
  ledger.userSubmit({ TransactionType: "Payment", Account: FUNDER, Destination: TREASURY, Amount: "20000000" });
  await run(engine, ledger, 2);
  assert.equal(engine.state.refunds.size, 0);
  assert.equal((await store.readFrom(0)).filter((e) => e.type === "payment_ignored").length, 1);
});

/** Re-seal a log with one event changed, as someone rewriting history would. */
function rewrite(events: readonly RipEvent[], change: (e: RipEventBody) => RipEventBody): RipEvent[] {
  let out: RipEvent[] = [];
  for (const e of events) {
    const { seq: _s, prev: _p, hash: _h, at, ...body } = e;
    const last = out.at(-1);
    out = [...out, ...sealEvents(last?.seq ?? 0, last?.hash ?? "", [change(body as RipEventBody)], at)];
  }
  return out;
}

test("the ledger holds a season's whole terms: rates, sell-back, price and the token's issuer can't be rewritten after the anchor", async () => {
  const { engine, ledger, store } = await setup();
  await paid(engine, ledger);
  await run(engine, ledger, 8);
  const log = await store.readFrom(0);
  assert.ok((await verifyAgainstChain(log, ledger.chain, TREASURY, 100)).ok);
  const season = (f: (d: Extract<RipEventBody, { type: "season_open" }>["data"]) => object) => (e: RipEventBody): RipEventBody => (e.type === "season_open" ? ({ ...e, data: { ...e.data, ...f(e.data) } } as RipEventBody) : e);
  for (const [what, change] of Object.entries({
    sellBps: season(() => ({ sellBps: 1000 })),
    issuer: season(() => ({ tokens: [{ ...SPEC, issuer: "rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB" }] })),
    priceDrops: season(() => ({ priceDrops: "16000000" })),
  })) {
    const check = await verifyAgainstChain(rewrite(log, change), ledger.chain, TREASURY, 100);
    assert.equal(check.ok, false, `${what} was rewritten and verify passed`);
  }
});

test("replay won't take a strike from a prior read at some other ledger, a payout in another token, or XRP paid over a price that was fine", async () => {
  const { engine, ledger, store } = await setup();
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  ledger.setLine(SPEC, PLAYER, 0n);
  assert.deepEqual(await engine.redeem(PLAYER, id), { ok: true });
  await run(engine, ledger, 3);
  const log = await store.readFrom(0);
  const prior = rewrite(log, (e) => (e.type === "pull_prize_drawn" && e.data.reads ? { ...e, data: { ...e.data, reads: { ...e.data.reads, prior: { ...e.data.reads.prior, ledger: e.data.reads.prior.ledger - 1000 } } } } : e));
  assert.equal(replayLog(prior).ok, false, "a prior read from another ledger passed");
  const other = rewrite(log, (e) => (e.type === "tx_intent" && e.data.kind === "prize_redeem" ? { ...e, data: { ...e.data, tx: { ...e.data.tx, Amount: { ...(e.data.tx.Amount as object), issuer: "rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB" } } } } : e));
  assert.equal(replayLog(other).ok, false, "a payout in the lookalike passed");
  const excuse = rewrite(log, (e) => (e.type === "pull_prize_drawn" ? { ...e, data: { ...e.data, token: XRP_TOKEN, amount: e.data.valueDrops, paidInXrp: { token: SEAL_TOKEN, code: "price_moved" } } } : e));
  assert.equal(replayLog(excuse).ok, false, "XRP over a healthy price passed");
});

test("verify reads a payout's result off the ledger, instead of taking the log's word", async () => {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", ALL(XRP_TOKEN, "2500000")]] });
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.deepEqual(await engine.redeem(PLAYER, id), { ok: true });
  await run(engine, ledger, 3);
  const log = await store.readFrom(0);
  assert.ok((await verifyAgainstChain(log, ledger.chain, TREASURY, 100)).ok);
  const paidOut = payouts(ledger)[0];
  const wrong = { ...ledger.chain, tx: async (hash: string, range: { account: string; minLedger: number; maxLedger: number }) => {
    const t = await ledger.chain.tx(hash, range);
    return t.found && hash === paidOut.hash ? { ...t, tx: { ...t.tx, delivered: "1" } } : t;
  } };
  assert.equal((await verifyAgainstChain(log, wrong, TREASURY, 100)).ok, false, "a payout that delivered less passed");

});

test("two servers racing on a redemption pay it once, through every interleaving of stalled reads", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("a", "b", "close", "tap"), { minLength: 6, maxLength: 30 }), async (steps) => {
      const { engine: a, ledger, make } = await setup();
      const id = await paid(a, ledger);
      await run(a, ledger, 8);
      ledger.setLine(SPEC, PLAYER, 0n);
      const b = make();
      await b.sync();
      assert.deepEqual(await a.redeem(PLAYER, id), { ok: true });
      for (const s of steps) {
        if (s === "a") await a.advance();
        else if (s === "b") await b.advance();
        else if (s === "tap") await b.redeem(PLAYER, id);
        else ledger.close();
      }
      await run(a, ledger, 4);
      assert.equal(a.state.orders.get(id)?.pull, "redeemed");
      assert.equal(payouts(ledger).length, 1, "a prize was paid twice");
      const amount = BigInt(a.state.orders.get(id)?.prize?.amount as string);
      assert.equal(ledger.tokenBalance(SPEC, PLAYER), amount);
    }),
    { numRuns: 30 },
  );
});

test("the sell-back guard counts SEAL at what a player can really get for it on the pool, not at our own lower bid", () => {
  const season = { season: "10-1", price: 10 as NftPrice, priceDrops: "8000000", bandBps: [10000, 0, 0, 0, 0], commit: "", length: 10, sellBps: 5000, usdAtOpen: null, live: true, anchorTx: null, anchorLedger: 1, nextIndex: 0, prizeTable: [{ band: 0, token: SEAL_TOKEN, bps: 10000, valueDrops: "8000000" }] };
  const share = sellBackShare({ lots: new Map() } as never, season, 10);
  assert.ok(share > 0.97, `a SEAL row worth the whole pack counted as ${share}`);
});

test("the sweep hears what stops money without an error: a short XRP float, a stuck refund, a payout with no result", async () => {
  const { engine, ledger } = await setup({ treasuryXrp: 100, seasons: [[10, "8000000", ALL(XRP_TOKEN, "2500000")]] });
  assert.deepEqual(await engine.opsAlerts(), []);
  ledger.fund(TREASURY, -Number((ledger.balance(TREASURY) - 10_500_000n) / 1_000_000n));
  const codes = (await engine.opsAlerts()).map((a) => a.code);
  assert.deepEqual(codes, ["xrp_float"]);
});

test("mainnet takes its one trusted ledger server over https only", async () => {
  const { railsConfig, MAINNET_CONFIRMATION } = await import("../src/lib/rip/mode.ts");
  const env = { SEAL_RAILS_MODE: "mainnet", SEAL_REAL_MONEY_CONFIRM: MAINNET_CONFIRMATION, DATABASE_URL: "postgres://x", SEAL_TREASURY_ADDRESS: "a", SEAL_TREASURY_SEED: "b", SEAL_VAULT_ADDRESS: "c", SEAL_VAULT_SEED: "d", SEAL_DRAW_SECRET: "x".repeat(32) };
  assert.equal(railsConfig({ ...env, SEAL_XRPL_RPC: "https://rpc.example" }).mode, "mainnet");
  const plain = railsConfig({ ...env, SEAL_XRPL_RPC: "http://rpc.example" });
  assert.equal(plain.mode, "demo");
  assert.ok(plain.problems.some((p) => /https/.test(p)));
});

/** The launch plan's marks, in XRP, by band. Common holds no NFTs on the shelf. */
const SHELF_MARKS: Record<number, number[][]> = {
  5: [[], [1.78, 3.05, 3.04, 2.87, 2.88, 2.82, 2.84, 2.73, 2.73, 3.04, 3.05, 3.38, 3.56, 3.56], [10.16, 11.18, 12.19, 5.08, 9.14], [45.72, 49.78, 50.69, 58.92], [96.51, 85.23]],
  10: [[], [5.08, 7.11, 5.08, 5.08, 5.08, 5.08, 5.07, 5.08, 5.07, 5.07, 5.58, 5.59, 5.98, 5.98], [14.22, 14.22, 15.24, 14.22, 17.17, 17.17], [59.94, 50.61, 50.79, 45.72, 68.06], [253.97, 177.78]],
};

test("the thin shelf tables: a pool held off its price from the first pull to the last never refunds a token row", async () => {
  for (const price of SHELF_PRICES) {
    const drops = String(NFT_LADDERS[price].xrp * 1e6);
    const { engine, ledger, store } = await setup({ treasuryXrp: 20_000, stock: 35, seasons: [[price, drops, seasonPlan(NFT_LADDERS[price], SPEC)]] });
    ledger.setLine(SPEC, PLAYER, 0n);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const who = i % 2 ? PLAYER : OTHER;
      const q = await engine.createOrder(who, price);
      assert.ok(q.ok, JSON.stringify(q));
      ids.push(q.order.id);
      ledger.userSubmit(q.tx as never);
      ledger.close();
      // Pushed after the order, every time: the gate would refuse a new one if it stayed pushed.
      ledger.setPool(SPEC, String((BigInt(POOL_XRP) * 106n) / 100n), POOL_TOKEN);
      await run(engine, ledger, 5);
      ledger.setPool(SPEC, POOL_XRP, POOL_TOKEN);
      ledger.close(460);
      await engine.advance();
    }
    for (const id of ids) assert.equal(engine.state.orders.get(id)?.status, "drawn", `$${price}: a pull went back whole`);
    assert.equal(engine.state.refunds.size, 0);
    const r = replayLog(await store.readFrom(0));
    assert.ok(r.ok, JSON.stringify(r));
  }
});

test("property: on the thin shelf tables, however the pool's mix drifts, an average pull never sells back for its price, and the launch mix is under the guard", () => {
  for (const price of SHELF_PRICES) {
    const l = NFT_LADDERS[price];
    const plan = seasonPlan(l, SPEC);
    const season = { season: `${price}-1`, price, priceDrops: String(l.xrp * 1e6), bandBps: plan.bandBps, commit: "", length: 10, sellBps: 8500, usdAtOpen: null, live: true, anchorTx: null, anchorLedger: 1, nextIndex: 0, prizeTable: plan.prizeTable };
    const marks = SHELF_MARKS[price];
    fc.assert(
      fc.property(fc.array(fc.array(fc.boolean(), { minLength: 14, maxLength: 14 }), { minLength: 5, maxLength: 5 }), (keepers) => {
        const s = emptyState();
        marks.forEach((band, b) => {
          // Any lots may have gone. Each band keeps at least one, or the pack is closed anyway.
          const left = band.filter((_, i) => keepers[b][i]);
          (left.length ? left : band.slice(0, 1)).forEach((m, i) => s.lots.set(`l${b}-${i}`, { lot: `l${b}-${i}`, nftId: `n${b}-${i}`, price, band: b, collection: "c", name: "n", img: "", costDrops: "1", markDrops: String(Math.round(m * 1e6)), status: "available", addLedger: 1, removeLedger: null, awardedTo: null }));
        });
        assert.ok(sellBackShare(s, season, 10) < 1);
      }),
    );
    // At the launch mix it's open, with room to the guard.
    const s = emptyState();
    marks.forEach((band, b) => band.forEach((m, i) => s.lots.set(`l${b}-${i}`, { lot: `l${b}-${i}`, nftId: `n${b}-${i}`, price, band: b, collection: "c", name: "n", img: "", costDrops: "1", markDrops: String(Math.round(m * 1e6)), status: "available", addLedger: 1, removeLedger: null, awardedTo: null })));
    assert.ok(sellBackShare(s, season, 10) < 0.95);
  }
});

/** P(more than `lots` of `places` pulls land here), worked exactly. */
function overrun(places: number, chance: number, lots: number) {
  let term = (1 - chance) ** places;
  let cdf = term;
  for (let k = 0; k < lots; k++) {
    term *= ((places - k) / (k + 1)) * (chance / (1 - chance));
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

test("property: a player holding every place the stock rule allows, on any stock, overruns a band under the claimed chance", () => {
  for (const price of SHELF_PRICES) {
    const { bandBps, prizeTable } = seasonPlan(NFT_LADDERS[price], SPEC);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 5, maxLength: 5 }), (stock) => {
        // Most places the rule lets one wallet farm hold at once, opening them all before any draws.
        let places = 0;
        while (places < 500 && stockCovers(stock, places, bandBps, prizeTable)) places++;
        stock.forEach((lots, band) => {
          const chance = nftChanceOf(bandBps, prizeTable, band);
          if (chance > 0) assert.ok(overrun(places, chance, lots) <= 1e-4 + 1e-12, `$${price} band ${band}: ${overrun(places, chance, lots)} on ${lots} lots and ${places} places`);
        });
      }),
    );
  }
  assert.equal(lotsNeeded(1, 0.5), 1);
});

test("an overrun isn't a free option: even a quote kept open until a band is empty never pays for itself, on the launch marks", () => {
  for (const price of SHELF_PRICES) {
    const l = NFT_LADDERS[price];
    const { bandBps, prizeTable } = seasonPlan(l, SPEC);
    const marks = SHELF_MARKS[price];
    const avg = (b: number) => (marks[b].length ? marks[b].reduce((a, m) => a + m, 0) / marks[b].length : 0);
    const tokens = prizeTable.reduce((a, r) => a + (bandBps[r.band] / 10_000) * (r.bps / 10_000) * (Number(r.valueDrops) / 1e6) * (r.token === XRP_TOKEN ? 1 : 0.985), 0);
    // Everything sold at its best liquid price, the 8% the plan's unwind pays to resell an NFT, and a refund for any band it wanted empty.
    const worth = (emptied: number) => tokens + [1, 2, 3, 4].reduce((a, b) => a + nftChanceOf(bandBps, prizeTable, b) * (b === emptied ? l.xrp : avg(b) * 0.92), 0);
    for (const b of [1, 2, 3, 4]) assert.ok(worth(b) < l.xrp, `$${price}: band ${b} empty is worth ${worth(b)} on a ${l.xrp} XRP pack`);
  }
});

test("the dust mark is part of what's anchored: a dust row can't be added to a table after the season opens", async () => {
  const { engine, ledger, store } = await setup();
  await paid(engine, ledger);
  await run(engine, ledger, 8);
  const log = await store.readFrom(0);
  assert.ok((await verifyAgainstChain(log, ledger.chain, TREASURY, 100)).ok);
  const dusted = rewrite(log, (e) => (e.type === "season_open" && e.data.prizeTable ? { ...e, data: { ...e.data, prizeTable: e.data.prizeTable.map((r) => ({ ...r, dust: true })) } } : e));
  assert.equal((await verifyAgainstChain(dusted, ledger.chain, TREASURY, 100)).ok, false);
});

test("a dust row: no trust line pays its value in XRP and a line pays SEAL, and neither read is on the pool, so moving it does nothing for a player without one", async () => {
  const plan = { bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: SEAL_TOKEN, bps: 10000, valueDrops: "2000000", dust: true }], tokens: [SPEC] };
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", plan]] });
  const none = await paid(engine, ledger);
  ledger.setPool(SPEC, String((BigInt(POOL_XRP) * 12n) / 10n), POOL_TOKEN);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(none)?.prize?.token, XRP_TOKEN);
  assert.equal(engine.state.orders.get(none)?.prize?.amount, "2000000");
  ledger.setPool(SPEC, POOL_XRP, POOL_TOKEN);
  ledger.close(460);
  await engine.advance();
  ledger.setLine(SPEC, OTHER, 0n);
  const line = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  const got = engine.state.orders.get(line)?.prize;
  assert.equal(got?.token, SEAL_TOKEN);
  // Struck at or under its value. Taking SEAL is never better than having no line, so managing a line buys nothing.
  assert.ok((BigInt(got?.amount as string) * BigInt(POOL_XRP)) / BigInt(POOL_TOKEN) * 1_000_000n <= 2_000_000n);
  // A wallet can't claim the no-line path on a row the season didn't mark as dust.
  const r = replayLog(await store.readFrom(0));
  assert.ok(r.ok, JSON.stringify(r));
  const lied = rewrite(await store.readFrom(0), (e) => (e.type === "season_open" && e.data.prizeTable ? { ...e, data: { ...e.data, prizeTable: e.data.prizeTable.map(({ dust: _d, ...row }) => row) } } : e));
  assert.equal(replayLog(lied).ok, false);
});

test("SEAL #449 can't enter a pool, by id in either case", async () => {
  const { poolRefusal, NEVER_POOL } = await import("../src/lib/rip/nftid.ts");
  const { engine, ledger } = await setup();
  const id = NEVER_POOL[0];
  ledger.mintTo(id, VAULT);
  const r = await engine.changePool(10, [{ nftId: id, band: 1, collection: "seal", name: "SEAL #449", img: "/x.webp", costDrops: "1", markDrops: "1" }]);
  assert.equal(r.ok, false);
  assert.ok(poolRefusal(id.toLowerCase()));
  const burnableOk = await engine.changePool(10, [{ nftId: id.toLowerCase(), band: 1, collection: "seal", name: "SEAL #449", img: "/x.webp", costDrops: "1", markDrops: "1" }], [], { allowBurnable: true });
  assert.equal(burnableOk.ok, false);
});
