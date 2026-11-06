import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import type { NftPrice } from "../src/config/nft-packs.ts";
import { digestOf, invoiceOf, seedMatches, xrpCoverFor } from "../src/lib/rip/draw.ts";
import { createEngine, sellBackShare, MAX_SELL_BACK_SHARE, type RipEngine } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { multiConfig } from "../src/lib/rip/mode.ts";
import { apply, emptyState, holdsFor, treasuryOwed } from "../src/lib/rip/state.ts";
import { memoryStore, type EventStore } from "../src/lib/rip/store.ts";
import { XRP_TOKEN } from "../src/lib/rip/tokens.ts";
import type { Chain, RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const PRICE: NftPrice = 5;
const EACH = 4_000_000n;
const LIVE_TABLE = [
  { band: 0, token: XRP_TOKEN, bps: 6000, valueDrops: "1000000" },
  { band: 0, token: XRP_TOKEN, bps: 3300, valueDrops: "2000000" },
  { band: 0, token: XRP_TOKEN, bps: 700, valueDrops: "4000000" },
  { band: 1, token: XRP_TOKEN, bps: 2500, valueDrops: "3000000" },
  { band: 2, token: XRP_TOKEN, bps: 1500, valueDrops: "8000000" },
  { band: 3, token: XRP_TOKEN, bps: 5000, valueDrops: "42000000" },
];
/** Season 5-4 as it is on mainnet today. */
const LIVE_PLAN = { bandBps: [7448, 2000, 210, 314, 28], prizeTable: LIVE_TABLE, tokens: [] };
const LIVE_STOCK = [0, 14, 9, 4, 3];
const LIVE_MARKS = [1, 3_000_000, 12_000_000, 50_000_000, 100_000_000];
const NFTS_ONLY = { bandBps: [3000, 3000, 2000, 1500, 500], prizeTable: [], tokens: [] };
const CHEAP_MARKS = [1_000_000, 2_000_000, 3_000_000, 5_000_000, 8_000_000];

let nftCounter = 0;

async function setup(opts: { plan?: typeof LIVE_PLAN | typeof NFTS_ONLY; stock?: readonly number[]; marks?: readonly number[]; treasuryXrp?: number; seed?: string; store?: EventStore; max?: number; multi?: boolean; chain?: (c: Chain) => Chain } = {}) {
  const ledger = testLedger(opts.seed ?? "multi");
  ledger.fund(TREASURY, opts.treasuryXrp ?? 2000);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 5000);
  ledger.fund(OTHER, 5000);
  const store = opts.store ?? memoryStore();
  const chain = opts.chain ? opts.chain(ledger.chain) : ledger.chain;
  const make = (extra: Partial<Parameters<typeof createEngine>[0]> = {}) => createEngine({ store, chain, signer: testSigner(), drawSecret: "multi-secret", expectedNetworkId: 1, ...(opts.multi === false ? {} : { multi: { max: opts.max ?? 20, cardMax: 1 } }), ...extra });
  const engine = make();
  await engine.openSeason(PRICE, EACH.toString(), null, opts.plan ?? LIVE_PLAN);
  const stock = opts.stock ?? LIVE_STOCK;
  const marks = opts.marks ?? (opts.plan && opts.plan !== LIVE_PLAN ? CHEAP_MARKS : LIVE_MARKS);
  const adds = stock.flatMap((count, band) =>
    Array.from({ length: count }, (_, i) => {
      const nftId = nftIdFor(100_000 + ++nftCounter);
      ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: `c${i % 4}`, name: `n${nftCounter}`, img: "/x.webp", costDrops: "1000000", markDrops: String(marks[band]) };
    }),
  );
  if (adds.length) assert.equal((await engine.changePool(PRICE, adds)).ok, true);
  await run(engine, ledger, 6);
  return { ledger, store, chain, engine, make };
}

async function run(engine: RipEngine, ledger: ReturnType<typeof testLedger>, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

const childrenOf = (engine: RipEngine, id: string) => (engine.state.bundles.get(id)?.children ?? []).map((c) => engine.state.orders.get(c)!);
const payoutsTo = (ledger: ReturnType<typeof testLedger>, to: string) => ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.tx.Destination === to && t.result === "tesSUCCESS");
const paidOut = (ledger: ReturnType<typeof testLedger>, to: string) => payoutsTo(ledger, to).reduce((a, t) => a + BigInt(String(t.delivered)), 0n);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { events?: RipEvent[] } | RipEvent[];
const eventsOf = (f: ReturnType<typeof fixture>) => (Array.isArray(f) ? f : (f.events as RipEvent[]));

/** Pay and draw a bundle. */
async function buy(ctx: Awaited<ReturnType<typeof setup>>, qty: number, address = PLAYER) {
  const q = await ctx.engine.createBundle(address, PRICE, qty);
  assert.ok(q.ok, JSON.stringify(q));
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 6);
  return q.bundle.id;
}

/** Everything stashed in a bundle, priced by the server, asked for by the player. */
async function cashOut(engine: RipEngine, address: string, id: string) {
  const ids = childrenOf(engine, id).filter((o) => o.pull === "stashed").map((o) => o.id);
  const quote = await engine.quotePayout(address, ids);
  assert.ok(quote.ok, JSON.stringify(quote));
  return { quote, done: await engine.requestPayout(address, quote.items) };
}

test("the switch must say exactly on, and the maximum defaults low and tops out at 20", () => {
  for (const v of [undefined, "", "ON", "On", " on", "on ", "true", "1", "yes", "off"]) assert.equal(multiConfig({ SEAL_MULTI_QTY: v }), null, String(v));
  assert.deepEqual(multiConfig({ SEAL_MULTI_QTY: "on" }), { max: 3, cardMax: 1 });
  assert.equal(multiConfig({ SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: "20" })?.max, 20);
  assert.equal(multiConfig({ SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: "21" })?.max, 20, "over the hard cap clamps");
  for (const bad of ["0", "-3", "abc", "2.5", "", "1e3x"]) assert.equal(multiConfig({ SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: bad })?.max, 3, bad);
  assert.equal(multiConfig({ SEAL_MULTI_QTY: "on", SEAL_MULTI_CARD_MAX: "8" })?.cardMax, 8);
});

test("one payment, the exact total, signed once: N real pulls, each with its own seed, all provable", async () => {
  const ctx = await setup();
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 20);
  assert.ok(q.ok, JSON.stringify(q));
  assert.equal(q.tx.TransactionType, "Payment");
  assert.equal(q.tx.Amount, (EACH * 20n).toString());
  assert.equal(q.tx.Destination, TREASURY);
  assert.equal(q.tx.Account, PLAYER);
  assert.equal(q.tx.InvoiceID, invoiceOf(q.bundle.id));
  assert.equal(q.tx.LastLedgerSequence, ctx.ledger.ledger() + 45);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 6);

  const inbound = ctx.ledger.history.filter((t) => t.tx.Account === PLAYER && t.tx.Destination === TREASURY);
  assert.equal(inbound.length, 1, "one transaction on the ledger");
  const kids = childrenOf(ctx.engine, q.bundle.id);
  assert.equal(kids.length, 20);
  assert.ok(kids.every((o) => o.status === "drawn" && o.txHash === inbound[0].hash));
  assert.deepEqual(kids.map((o) => o.index), Array.from({ length: 20 }, (_, i) => kids[0].index! + i), "consecutive places in the season");

  const log = await ctx.store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.equal(replay.pulls, 20);
  const draws = log.filter((e): e is Extract<RipEvent, { type: "pull_drawn" | "pull_prize_drawn" }> => e.type === "pull_drawn" || e.type === "pull_prize_drawn");
  assert.equal(new Set(draws.map((e) => e.data.digest)).size, 20, "same payment and ledger, twenty different digests");
  assert.equal(new Set(draws.map((e) => e.data.seed)).size, 20);
  const season = ctx.engine.state.seasons.get(kids[0].season)!;
  for (const d of draws) {
    assert.ok(seedMatches(d.data.seed, d.data.index, season.commit), "each seed hashes back to the committed tip");
    assert.equal(d.data.digest, digestOf({ season: d.data.season, index: d.data.index, seed: d.data.seed, txHash: d.data.txHash, ledgerHash: d.data.ledgerHash, address: d.data.address }));
  }
  const onLedger = await verifyAgainstChain(log, ctx.ledger.chain, TREASURY, 100);
  assert.ok(onLedger.ok, JSON.stringify(onLedger));
});

test("any wrong amount comes back whole and draws nothing; the exact amount still works afterward", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 20 }), fc.bigInt({ min: 1_000_000n, max: 200_000_000n }), async (qty, amount) => {
      const total = EACH * BigInt(qty);
      fc.pre(amount !== total);
      const ctx = await setup();
      const q = await ctx.engine.createBundle(PLAYER, PRICE, qty);
      assert.ok(q.ok);
      ctx.ledger.userSubmit({ ...q.tx, Amount: amount.toString() } as never);
      await run(ctx.engine, ctx.ledger, 5);
      assert.ok(childrenOf(ctx.engine, q.bundle.id).every((o) => o.status === "quoted"), "nothing was drawn");
      assert.equal(paidOut(ctx.ledger, PLAYER), amount, "the whole payment went back");
      ctx.ledger.userSubmit(q.tx as never);
      await run(ctx.engine, ctx.ledger, 6);
      assert.ok(childrenOf(ctx.engine, q.bundle.id).every((o) => o.status === "drawn"));
      assert.ok(replayLog(await ctx.store.readFrom(0)).ok);
    }),
    { numRuns: 12 },
  );
});

test("a partial payment is judged by what the ledger delivered, not what it claimed", async () => {
  const short = { on: true };
  const ctx = await setup({
    chain: (c) => ({
      ...c,
      accountTx: async (a, f) => (await c.accountTx(a, f)).map((t) => (short.on && t.tx.Account === PLAYER && t.tx.Destination === TREASURY ? { ...t, delivered: "1500000" } : t)),
    }),
  });
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 5);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  assert.ok(childrenOf(ctx.engine, q.bundle.id).every((o) => o.status === "quoted"), "the Amount field never pays for anything");
  assert.equal(ctx.engine.state.refunds.get(`pay:${ctx.ledger.history.find((t) => t.tx.Account === PLAYER)!.hash}`)?.drops, "1500000");
});

test("wrong wallet, late, and a second payment: each comes back whole, and no pull is paid twice", async () => {
  const ctx = await setup();
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(q.ok);
  ctx.ledger.userSubmit({ ...q.tx, Account: OTHER } as never);
  await run(ctx.engine, ctx.ledger, 4);
  assert.equal(paidOut(ctx.ledger, OTHER), EACH * 3n);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  assert.ok(childrenOf(ctx.engine, q.bundle.id).every((o) => o.status === "drawn"));
  const again = { ...q.tx, Memos: [{ Memo: { MemoType: "AA", MemoData: "BB" } }] };
  ctx.ledger.userSubmit(again as never);
  await run(ctx.engine, ctx.ledger, 4);
  assert.equal(paidOut(ctx.ledger, PLAYER) >= EACH * 3n, true, "the second payment came back");
  assert.equal([...ctx.engine.state.orders.values()].filter((o) => o.status === "drawn").length, 3);

  const late = await setup();
  const r = await late.engine.createBundle(PLAYER, PRICE, 4);
  assert.ok(r.ok);
  late.ledger.close(50);
  await late.engine.advance();
  assert.equal(late.engine.state.bundles.get(r.bundle.id)?.status, "expired");
  assert.equal(holdsFor(late.engine.state, PRICE), 0, "the hold is gone");
  late.ledger.userSubmit({ ...r.tx, LastLedgerSequence: undefined } as never);
  await run(late.engine, late.ledger, 4);
  assert.equal(paidOut(late.ledger, PLAYER), EACH * 4n);
  assert.ok(childrenOf(late.engine, r.bundle.id).every((o) => o.status === "expired"));
  assert.ok(replayLog(await late.store.readFrom(0)).ok);
});

test("no NFT is ever pulled twice across a bundle, at any size and any seed, and the log replays", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 20 }), fc.string({ minLength: 1, maxLength: 6 }), async (qty, seed) => {
      const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20], seed });
      const id = await buy(ctx, qty);
      const nfts = childrenOf(ctx.engine, id).map((o) => o.nftId);
      assert.ok(nfts.every(Boolean));
      assert.equal(new Set(nfts).size, qty);
      const replay = replayLog(await ctx.store.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
    }),
    { numRuns: 25 },
  );
});

test("rates hold inside a bundle: band rolls across many bundles land at the published rates", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [200, 200, 200, 200, 200], treasuryXrp: 5000 });
  const counts = [0, 0, 0, 0, 0];
  for (let b = 0; b < 15; b++) {
    const id = await buy(ctx, 20);
    for (const o of childrenOf(ctx.engine, id)) counts[o.band as number]++;
  }
  const total = 300;
  NFTS_ONLY.bandBps.forEach((bps, i) => {
    const p = bps / 10_000;
    const sd = Math.sqrt(total * p * (1 - p));
    assert.ok(Math.abs(counts[i] - total * p) < 5 * sd, `band ${i}: ${counts[i]} of ${total}`);
  });
});

test("a band that runs out partway: that pull's XRP goes back whole, the others stand, and replay checks the band really was empty", async () => {
  const ctx = await setup({ plan: { bandBps: [0, 0, 0, 0, 10_000], prizeTable: [], tokens: [] }, stock: [1, 1, 1, 1, 6], marks: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 2_000_000] });
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 5);
  assert.ok(q.ok, JSON.stringify(q));
  // A pool change the normal path would refuse, forced onto the log: three lots leave while the bundle holds its places.
  await ctx.engine.sync();
  const removes = [...ctx.engine.state.lots.values()].filter((l) => l.band === 4).slice(0, 3).map((l) => l.lot);
  const { poolRoot } = await import("../src/lib/rip/log.ts");
  const forced: RipEventBody = { type: "pool_change", data: { id: "forced", price: PRICE, adds: [], removes, root: poolRoot(PRICE, [], removes) } };
  assert.equal(await ctx.store.append(ctx.engine.state.head, sealEvents(ctx.engine.state.head, ctx.engine.state.headHash, [forced], new Date().toISOString())), true);
  await run(ctx.engine, ctx.ledger, 4);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 8);
  const kids = childrenOf(ctx.engine, q.bundle.id);
  assert.equal(kids.filter((o) => o.status === "drawn").length, 3);
  assert.equal(kids.filter((o) => o.status === "refunded").length, 2);
  assert.equal(paidOut(ctx.ledger, PLAYER), EACH * 2n, "two packs' price, whole");
  assert.equal(new Set(kids.flatMap((o) => (o.nftId ? [o.nftId] : []))).size, 3);
  const log = await ctx.store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.ok((await verifyAgainstChain(log, ctx.ledger.chain, TREASURY, 100)).ok);
});

test("sell all: one payment for the whole lot, paid once, and every NFT goes back to its pool", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 10);
  const { quote, done } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok, JSON.stringify(done));
  const kids = childrenOf(ctx.engine, id);
  const want = kids.reduce((a, o) => a + (BigInt(ctx.engine.state.lots.get(o.lot as string)!.markDrops) * 9506n) / 10_000n, 0n);
  assert.equal(BigInt(quote.total), want, "2% fee and 97% of mark, each rounded down, as a single sale would");
  assert.equal(treasuryOwed(ctx.engine.state), want, "owed from the moment it's asked for");
  await run(ctx.engine, ctx.ledger, 6);
  assert.equal(payoutsTo(ctx.ledger, PLAYER).length, 1, "one payment");
  assert.equal(paidOut(ctx.ledger, PLAYER), want);
  assert.ok(childrenOf(ctx.engine, id).every((o) => o.pull === "sold" && o.sellTx === payoutsTo(ctx.ledger, PLAYER)[0].hash));
  assert.equal(treasuryOwed(ctx.engine.state), 0n);
  const returned = kids.map((o) => o.nftId);
  const inPool = returned.filter((n) => [...ctx.engine.state.lots.values()].some((l) => l.nftId === n && l.status === "available"));
  assert.equal(inPool.length, 10, "relisted through one anchored pool change");
  const log = await ctx.store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.ok((await verifyAgainstChain(log, ctx.ledger.chain, TREASURY, 100)).ok);
});

test("XRP prizes go in the same payment with no fee, and the wallet gets exactly what the prizes say", async () => {
  const ctx = await setup({ plan: { bandBps: [10_000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 10_000, valueDrops: "2000000" }], tokens: [] }, stock: [0, 1, 1, 1, 1], marks: [1, 1_000_000, 1_000_000, 1_000_000, 1_000_000] });
  const id = await buy(ctx, 6);
  const { quote, done } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  assert.ok(quote.items.every((i) => i.action === "redeem" && i.drops === "2000000"));
  await run(ctx.engine, ctx.ledger, 4);
  assert.equal(payoutsTo(ctx.ledger, PLAYER).length, 1);
  assert.equal(paidOut(ctx.ledger, PLAYER), 12_000_000n);
  assert.ok(childrenOf(ctx.engine, id).every((o) => o.pull === "redeemed" && o.prize?.redeemTx));
  assert.ok(replayLog(await ctx.store.readFrom(0)).ok);
});

test("double-sell: any mix of repeated requests, single sales and two servers pays each item exactly once", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("bulk", "bulk2", "single", "other", "close"), { minLength: 2, maxLength: 14 }), async (moves) => {
      const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
      const id = await buy(ctx, 5);
      const ids = childrenOf(ctx.engine, id).map((o) => o.id);
      const second = ctx.make();
      for (const m of moves) {
        if (m === "close") {
          await run(ctx.engine, ctx.ledger, 1);
          continue;
        }
        const engine = m === "bulk2" ? second : ctx.engine;
        await engine.sync();
        if (m === "other") {
          const q = await engine.quotePayout(OTHER, ids);
          assert.equal(q.ok, false, "someone else's items");
          assert.equal((await engine.requestPayout(OTHER, ids.map((order) => ({ order, action: "sell" as const, drops: "1" })))).ok, false);
          continue;
        }
        if (m === "single") {
          const p = engine.sellPrice(PLAYER, ids[0]);
          if (p.ok) await engine.sell(PLAYER, ids[0], p.drops);
          continue;
        }
        const q = await engine.quotePayout(PLAYER, ids.filter((x) => engine.state.orders.get(x)?.pull === "stashed"));
        if (q.ok && q.items.length) await Promise.all([engine.requestPayout(PLAYER, q.items), ctx.engine.requestPayout(PLAYER, q.items)]);
      }
      await run(ctx.engine, ctx.ledger, 8);
      const kids = childrenOf(ctx.engine, id);
      const expected = kids.filter((o) => o.pull === "sold").reduce((a, o) => a + (BigInt(ctx.engine.state.lots.get(o.lot as string)!.markDrops) * 9506n) / 10_000n, 0n);
      assert.equal(paidOut(ctx.ledger, PLAYER), expected, "paid for exactly what sold, once");
      assert.ok(kids.every((o) => o.pull === "sold" || o.pull === "stashed"));
      const replay = replayLog(await ctx.store.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
    }),
    { numRuns: 30 },
  );
});

test("a press sent again, after a busy answer or a dropped connection, is the same payout: same id, paid once", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 3);
  const { done, quote } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  for (let i = 0; i < 3; i++) {
    const again = await ctx.engine.requestPayout(PLAYER, quote.items);
    assert.deepEqual(again, done, `retry ${i + 1}`);
  }
  await run(ctx.engine, ctx.ledger, 6);
  assert.equal(payoutsTo(ctx.ledger, PLAYER).length, 1);
});

test("a wallet that refuses the payment: every item goes back to the stash, nothing moved, and it waits before another try", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 4);
  ctx.ledger.refusePayments(PLAYER, "tecNO_PERMISSION");
  const { done, quote } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  await run(ctx.engine, ctx.ledger, 4);
  assert.ok(childrenOf(ctx.engine, id).every((o) => o.pull === "stashed" && o.sellDrops === null));
  assert.equal(paidOut(ctx.ledger, PLAYER), 0n);
  assert.equal(treasuryOwed(ctx.engine.state), 0n);
  const again = await ctx.engine.requestPayout(PLAYER, quote.items);
  assert.equal(again.ok, false);
  assert.equal((again as { code: string }).code, "try_later");
  ctx.ledger.refusePayments(PLAYER, null);
  ctx.ledger.close(230);
  await ctx.engine.advance();
  assert.equal((await ctx.engine.requestPayout(PLAYER, quote.items)).ok, true);
  await run(ctx.engine, ctx.ledger, 4);
  assert.equal(payoutsTo(ctx.ledger, PLAYER).length, 1);
  assert.ok(replayLog(await ctx.store.readFrom(0)).ok);
});

test("a sale the treasury can't cover is refused before anything changes", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20], treasuryXrp: 40, marks: [3_500_000, 3_500_000, 3_500_000, 3_500_000, 3_500_000] });
  const id = await buy(ctx, 4);
  const ids = childrenOf(ctx.engine, id).map((o) => o.id);
  const q = await ctx.engine.quotePayout(PLAYER, ids);
  assert.ok(q.ok);
  ctx.ledger.setBalance(TREASURY, 12);
  const r = await ctx.engine.requestPayout(PLAYER, q.items);
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "sell_short");
  assert.ok(childrenOf(ctx.engine, id).every((o) => o.pull === "stashed"));
});

test("a stale price, a made-up price or an over-long list never pays", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 3);
  const q = await ctx.engine.quotePayout(PLAYER, childrenOf(ctx.engine, id).map((o) => o.id));
  assert.ok(q.ok);
  const raised = q.items.map((i) => ({ ...i, drops: (BigInt(i.drops) + 1n).toString() }));
  const r = await ctx.engine.requestPayout(PLAYER, raised);
  assert.equal((r as { code: string }).code, "price_changed");
  assert.equal((await ctx.engine.requestPayout(PLAYER, [q.items[0], q.items[0]])).ok, false, "the same item twice");
  assert.equal((await ctx.engine.requestPayout(PLAYER, [])).ok, false);
  assert.equal((await ctx.engine.requestPayout(PLAYER, Array.from({ length: 21 }, (_, i) => ({ order: `x${i}`, action: "sell" as const, drops: "1" })))).ok, false);
  assert.ok(childrenOf(ctx.engine, id).every((o) => o.pull === "stashed"));
});

test("crash anywhere in buy, draw and sell-all: all the money adds up, nothing happens twice, and the log replays", async () => {
  let bought = 0;
  let sold_ = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(fc.nat(50), { minLength: 1, maxLength: 16 }), fc.array(fc.constantFrom("pay", "sell", "bad", "none"), { minLength: 4, maxLength: 12 }), fc.integer({ min: 2, max: 20 }), async (crashAt, moves, qty) => {
      const inner = memoryStore();
      const base = await setup({ plan: NFTS_ONLY, stock: [30, 30, 30, 30, 30], store: inner });
      const { ledger } = base;
      let ticks = 0;
      const plan = new Set(crashAt);
      const maybeCrash = () => {
        if (plan.delete(++ticks)) throw new Error("crash");
      };
      const store: EventStore = {
        readFrom: (a) => inner.readFrom(a),
        append: async (h, ev) => {
          maybeCrash();
          const ok = await inner.append(h, ev);
          maybeCrash();
          return ok;
        },
      };
      const chain: Chain = {
        ...ledger.chain,
        submit: async (blob) => {
          maybeCrash();
          const r = await ledger.chain.submit(blob);
          maybeCrash();
          return r;
        },
      };
      const fresh = () => createEngine({ store, chain, signer: testSigner(), drawSecret: "multi-secret", expectedNetworkId: 1, multi: { max: 20, cardMax: 1 } });
      let engine = fresh();
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch {
          engine = fresh();
        }
      };
      const paid = new Set<string>();
      for (const move of moves) {
        await attempt(() => engine.advance());
        ledger.close();
        if (move === "pay") {
          await attempt(async () => {
            const q = await engine.createBundle(PLAYER, PRICE, qty);
            if (q.ok && !paid.has(q.bundle.id)) {
              ledger.userSubmit(q.tx as never);
              paid.add(q.bundle.id);
            }
          });
        } else if (move === "bad") {
          ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "3000000" });
        } else if (move === "sell") {
          await attempt(async () => {
            await engine.sync();
            const held = [...engine.state.orders.values()].filter((o) => o.pull === "stashed" && o.address === PLAYER).slice(0, 20).map((o) => o.id);
            if (!held.length) return;
            const q = await engine.quotePayout(PLAYER, held);
            if (q.ok) await engine.requestPayout(PLAYER, q.items);
          });
        }
      }
      plan.clear();
      engine = fresh();
      await run(engine, ledger, 12);
      for (const id of paid) {
        const b = engine.state.bundles.get(id)!;
        assert.equal(b.status === "paid" || b.status === "expired", true, b.status);
        for (const c of b.children) {
          const o = engine.state.orders.get(c)!;
          assert.equal(o.status, b.status === "paid" ? "drawn" : "expired", `${b.status} child ended ${o.status}`);
        }
      }
      // Every inbound whole-XRP payment ended somewhere known.
      for (const t of ledger.history.filter((x) => x.tx.TransactionType === "Payment" && x.tx.Destination === TREASURY && x.tx.Account !== TREASURY && x.result === "tesSUCCESS")) {
        const pulled = [...engine.state.orders.values()].some((o) => o.txHash === t.hash && o.status === "drawn");
        const refunded = engine.state.refunds.get(`pay:${t.hash}`)?.status === "done";
        assert.ok(pulled || refunded || engine.state.seenTx.has(t.hash), `${t.hash} went nowhere`);
      }
      // Paid out exactly what sold, one payment per batch.
      const orders = [...engine.state.orders.values()];
      const sold = orders.filter((o) => o.pull === "sold").reduce((a, o) => a + BigInt(o.sellDrops as string), 0n);
      const refunds = [...engine.state.refunds.values()].filter((r) => r.to === PLAYER && r.status === "done").reduce((a, r) => a + BigInt(r.drops), 0n);
      assert.equal(paidOut(ledger, PLAYER), sold + refunds);
      assert.ok(orders.every((o) => o.pull !== "selling"), "nothing left owed");
      bought += orders.filter((o) => o.status === "drawn").length;
      sold_ += orders.filter((o) => o.pull === "sold").length;
      const batches = payoutsTo(ledger, PLAYER).map((t) => JSON.stringify(t.tx.Memos));
      assert.equal(new Set(batches).size, batches.length, "no memo paid twice");
      const nfts = orders.filter((o) => o.pull === "stashed" && o.nftId).map((o) => o.nftId);
      assert.equal(new Set(nfts).size, nfts.length);
      const replay = replayLog(await inner.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
    }),
    // 40 runs: sells are rare in a random walk, and at 25 runs the coverage check below fell short about 1 time in 8.
    { numRuns: 40 },
  );
  assert.ok(bought > 20 && sold_ > 5, `the runs have to do something: ${bought} drawn, ${sold_} sold`);
});

test("the guards hold through a multi order: the maximum tracks stock and cover, and every size up to it is accepted and none past it", async () => {
  const ctx = await setup({ treasuryXrp: 298 });
  const room = await ctx.engine.quantityRoom(PRICE);
  assert.equal(room.max, 20, "today's $5 pack at the env cap");
  const capped = await setup({ treasuryXrp: 298, max: 5 });
  assert.equal((await capped.engine.quantityRoom(PRICE)).max, 5, "the env cap wins");
  const refused = await capped.engine.createBundle(PLAYER, PRICE, 6);
  assert.equal((refused as { code: string }).code, "qty_too_high");
  assert.equal((refused as { max: number }).max, 5);

  // About 268 XRP on the treasury is under what 20 places could need: cover allows 16 places, and one is kept for someone buying a single.
  const lean = await setup({ treasuryXrp: 269 });
  assert.equal((await lean.engine.quantityRoom(PRICE)).max, 15);
  assert.equal((await lean.engine.createBundle(PLAYER, PRICE, 16) as { code: string }).code, "qty_too_high");
  const ok = await lean.engine.createBundle(PLAYER, PRICE, 15);
  assert.ok(ok.ok, JSON.stringify(ok));
  // Those places count against everyone else now.
  assert.equal(holdsFor(lean.engine.state, PRICE), 15);
  assert.ok((await lean.engine.quantityRoom(PRICE)).max < 15);
  const single = await lean.engine.createOrder(OTHER, PRICE);
  assert.ok(single.ok || (single as { code: string }).code === "restocking");

  const thin = await setup({ stock: [0, 2, 1, 1, 1] });
  const max = (await thin.engine.quantityRoom(PRICE)).max;
  assert.ok(max >= 1 && max < 20, String(max));
  if (max >= 2) assert.ok((await thin.engine.createBundle(PLAYER, PRICE, max)).ok);
  const closed = await setup({ stock: [0, 0, 1, 1, 1] });
  const none = await closed.engine.quantityRoom(PRICE);
  assert.equal(none.max, 0);
  assert.equal((await closed.engine.createBundle(PLAYER, PRICE, 2) as { code: string }).code, "restocking");
});

test("the sell-back guard closes a multi order exactly as it closes a single one, and the average pull can't beat it", async () => {
  const hot = await setup({ plan: NFTS_ONLY, stock: [10, 10, 10, 10, 10], marks: [4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000] });
  await hot.engine.sync();
  const season = hot.engine.state.seasons.get(hot.engine.state.activeSeason.get(PRICE) as string)!;
  assert.ok(sellBackShare(hot.engine.state, season, hot.ledger.ledger()) > MAX_SELL_BACK_SHARE);
  assert.equal((await hot.engine.createBundle(PLAYER, PRICE, 2) as { code: string }).code, "restocking");
  assert.equal((await hot.engine.createOrder(PLAYER, PRICE) as { code: string }).code, "restocking");

  // The share in the pool is the share the bundle gets on average, however many came first: picks are uniform.
  const ctx = await setup({ plan: NFTS_ONLY, stock: [200, 200, 200, 200, 200], marks: [1_000_000, 2_000_000, 3_000_000, 4_000_000, 8_000_000], treasuryXrp: 9000 });
  await ctx.engine.sync();
  const s = ctx.engine.state.seasons.get(ctx.engine.state.activeSeason.get(PRICE) as string)!;
  const before = sellBackShare(ctx.engine.state, s, ctx.ledger.ledger());
  let got = 0n;
  let pulls = 0;
  for (let i = 0; i < 12; i++) {
    const id = await buy(ctx, 20);
    for (const o of childrenOf(ctx.engine, id)) {
      got += (BigInt(ctx.engine.state.lots.get(o.lot as string)!.markDrops) * BigInt(s.sellBps)) / 10_000n;
      pulls += 1;
    }
  }
  const realized = Number(got) / pulls / Number(EACH);
  assert.ok(Math.abs(realized - before) < 0.12, `realized ${realized} against ${before}`);
});

test("one open multi checkout per wallet: the same size comes back, another size is refused, and a child can't be handed back as a single", async () => {
  const ctx = await setup();
  const a = await ctx.engine.createBundle(PLAYER, PRICE, 5);
  assert.ok(a.ok);
  const same = await ctx.engine.createBundle(PLAYER, PRICE, 5);
  assert.ok(same.ok);
  assert.equal(same.bundle.id, a.bundle.id, "a repeat tap gets the same order");
  assert.equal(holdsFor(ctx.engine.state, PRICE), 5);
  const other = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.equal((other as { code: string }).code, "open_checkout");
  const single = await ctx.engine.createOrder(PLAYER, PRICE);
  assert.ok(single.ok);
  assert.ok(!a.bundle.children.includes(single.order.id), "a single is its own order");
  assert.equal(single.tx.Amount, EACH.toString());
});

test("a lapsed bundle counts by size: lapsing a 20 waits an hour, lapsing a 3 doesn't", async () => {
  const big = await setup();
  assert.ok((await big.engine.createBundle(PLAYER, PRICE, 20)).ok);
  big.ledger.close(85);
  await big.engine.advance();
  assert.equal((await big.engine.createBundle(PLAYER, PRICE, 2) as { code: string }).code, "too_many_lapsed");
  assert.equal((await big.engine.createOrder(PLAYER, PRICE) as { code: string }).code, "too_many_lapsed");
  big.ledger.close(905);
  await big.engine.advance();
  assert.ok((await big.engine.createBundle(PLAYER, PRICE, 2)).ok, "the wait ends");

  const small = await setup();
  assert.ok((await small.engine.createBundle(PLAYER, PRICE, 3)).ok);
  small.ledger.close(85);
  await small.engine.advance();
  assert.ok((await small.engine.createBundle(PLAYER, PRICE, 3)).ok);
});

test("a wallet that can't pay the total is refused before it holds anything", async () => {
  const ctx = await setup();
  const poor = "rPOORpoorPOORpoorPOORpoorPOORpo";
  ctx.ledger.fund(poor, 10);
  assert.equal((await ctx.engine.createBundle(poor, PRICE, 3) as { code: string }).code, "wallet_short");
  assert.equal(holdsFor(ctx.engine.state, PRICE), 0);
  assert.ok((await ctx.engine.createBundle(poor, PRICE, 2)).ok);
});

test("a treasury short of XRP at the draw still strikes every prize, owes it, and pays it by itself after a top-up", async () => {
  const plan = { bandBps: [10_000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 10_000, valueDrops: "3000000" }], tokens: [] };
  const ctx = await setup({ plan, stock: [0, 1, 1, 1, 1], marks: [1, 1_000_000, 1_000_000, 1_000_000, 1_000_000], treasuryXrp: 30 });
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(q.ok, JSON.stringify(q));
  ctx.ledger.setBalance(TREASURY, 11);
  ctx.ledger.userSubmit(q.tx as never);
  ctx.ledger.close();
  await ctx.engine.advance();
  ctx.ledger.setBalance(TREASURY, 11);
  await run(ctx.engine, ctx.ledger, 5);
  const kids = childrenOf(ctx.engine, q.bundle.id);
  assert.ok(kids.every((o) => o.status === "drawn" && o.prize));
  ctx.ledger.fund(TREASURY, 50);
  await run(ctx.engine, ctx.ledger, 6);
  assert.ok(replayLog(await ctx.store.readFrom(0)).ok);
});

test("forged logs don't replay: every multi rule is checked from the log alone", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 4);
  const { done } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  await run(ctx.engine, ctx.ledger, 4);
  const log = await ctx.store.readFrom(0);
  assert.ok(replayLog(log).ok);
  /** Change one event, reseal everything after it so the hash chain holds, and replay. */
  const forge = (pick: (e: RipEvent) => boolean, change: (d: Record<string, any>) => void) => {
    const at = log.findIndex(pick);
    assert.ok(at >= 0, "the event to forge is there");
    const copy = structuredClone(log) as RipEvent[];
    change(copy[at].data as Record<string, any>);
    const resealed = sealEvents(at ? copy[at - 1].seq : 0, at ? copy[at - 1].hash : "0".repeat(64), copy.slice(at).map((e) => ({ type: e.type, data: e.data }) as RipEventBody), new Date(0).toISOString());
    return replayLog([...copy.slice(0, at), ...resealed]);
  };
  const isType = (t: string) => (e: RipEvent) => e.type === t;
  for (const [name, r] of [
    ["a total that isn't N packs", forge(isType("bundle_created"), (d) => (d.drops = "1000000"))],
    ["a per-pack price the season never committed", forge(isType("bundle_created"), (d) => (d.each = "1000000"))],
    ["a quantity that isn't its children", forge(isType("bundle_created"), (d) => (d.qty = 9))],
    ["a size past the hard cap", forge(isType("bundle_created"), (d) => { d.qty = 21; d.children = Array.from({ length: 21 }, (_, i) => `k${i}`); d.drops = (EACH * 21n).toString(); })],
    ["a bundle paid for less", forge(isType("bundle_paid"), (d) => (d.drops = "4000000"))],
    ["a payout for more than its items", forge(isType("payout_requested"), (d) => { d.total = (BigInt(d.total) + 1n).toString(); })],
    ["an item priced over its quote", forge(isType("payout_requested"), (d) => { d.items[0].drops = (BigInt(d.items[0].drops) + 1n).toString(); d.total = (BigInt(d.total) + 1n).toString(); })],
    ["someone else's payout", forge(isType("payout_requested"), (d) => (d.address = OTHER))],
    ["a payment to the wrong wallet", forge((e) => e.type === "tx_intent" && e.data.kind === "payout", (d) => (d.tx.Destination = OTHER))],
    ["a payment of the wrong size", forge((e) => e.type === "tx_intent" && e.data.kind === "payout", (d) => (d.tx.Amount = "1"))],
  ] as const) assert.equal(r.ok, false, name);

  // A bundle's pulls have to follow its payment, with nothing between them.
  const paid = log.findIndex(isType("bundle_paid"));
  const swapped = structuredClone(log) as RipEvent[];
  [swapped[paid + 1], swapped[paid + 2]] = [swapped[paid + 2], swapped[paid + 1]];
  const out = sealEvents(swapped[paid].seq, swapped[paid].hash, swapped.slice(paid + 1).map((e) => ({ type: e.type, data: e.data }) as RipEventBody), new Date(0).toISOString());
  assert.equal(replayLog([...swapped.slice(0, paid + 1), ...out]).ok, false);

  // A second pull_paid with the same tx outside a bundle is still refused, as it always was.
  const lone = await setup();
  const q = await lone.engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  lone.ledger.userSubmit(q.tx as never);
  await run(lone.engine, lone.ledger, 5);
  assert.ok(replayLog(await lone.store.readFrom(0)).ok);
});

test("a chain check catches a bundle whose payment doesn't match the ledger", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  await buy(ctx, 3);
  const log = await ctx.store.readFrom(0);
  const lying: Chain = {
    ...ctx.ledger.chain,
    tx: async (h, r) => {
      const t = await ctx.ledger.chain.tx(h, r);
      return t.found && t.tx.tx.Account === PLAYER ? { ...t, tx: { ...t.tx, delivered: "1" } } : t;
    },
  };
  const checked = await verifyAgainstChain(log, lying, TREASURY, 100);
  assert.equal(checked.ok, false);
});

test("old logs still replay, byte for byte, on the new rules", () => {
  for (const name of ["mainnet-log-20261102.json", "mainnet-log-20261102-5-3.json", "mainnet-log-20261102-139.json", "log-a5078e36e.json"]) {
    const r = replayLog(eventsOf(fixture(name)));
    assert.ok(r.ok, `${name}: ${JSON.stringify(r)}`);
  }
  const s = emptyState();
  for (const e of eventsOf(fixture("mainnet-log-20261102-139.json"))) apply(s, e);
  assert.equal(s.bundles.size, 0);
  assert.equal(s.payouts.size, 0);
});

test("switch off: no bundle can be made and nothing about a single order changes", async () => {
  const ctx = await setup({ multi: false });
  assert.equal((await ctx.engine.createBundle(PLAYER, PRICE, 2) as { code: string }).code, "multi_off");
  assert.equal((await ctx.engine.quotePayout(PLAYER, []) as { code: string }).code, "multi_off");
  assert.equal((await ctx.engine.requestPayout(PLAYER, []) as { code: string }).code, "multi_off");
  assert.equal((await ctx.engine.quantityRoom(PRICE)).max, 1);
  const q = await ctx.engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  const types = new Set((await ctx.store.readFrom(0)).map((e) => e.type));
  for (const t of ["bundle_created", "bundle_paid", "payout_requested"]) assert.ok(!types.has(t as never));
  assert.equal(ctx.engine.state.orders.get(q.order.id)?.status, "drawn");
});

test("switch turned off with a bundle in flight: it still pays, draws and sells out what was asked for", async () => {
  const on = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const q = await on.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(q.ok);
  const off = on.make({ multi: undefined });
  on.ledger.userSubmit(q.tx as never);
  await run(off, on.ledger, 6);
  assert.ok(childrenOf(off, q.bundle.id).every((o) => o.status === "drawn"));
  await on.engine.sync();
  const { done } = await cashOut(on.engine, PLAYER, q.bundle.id);
  assert.ok(done.ok);
  await run(off, on.ledger, 5);
  assert.equal(payoutsTo(on.ledger, PLAYER).length, 1);
});

/** Reseal a log after changing it, so the hash chain holds and only the rules can catch it. */
const reseal = (head: readonly RipEvent[], rest: readonly RipEventBody[]) => {
  const last = head.at(-1);
  return [...head, ...sealEvents(last ? last.seq : 0, last ? last.hash : "0".repeat(64), rest, new Date(0).toISOString())];
};
const bodies = (log: readonly RipEvent[]) => log.map((e) => ({ type: e.type, data: e.data }) as RipEventBody);

test("a bundle's pulls have to sit on its payment's own ledger: nobody writing the log can shop for an entropy ledger", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  await buy(ctx, 5);
  const log = await ctx.store.readFrom(0);
  const at = log.findIndex((e) => e.type === "pull_paid");
  for (const change of [
    (d: Record<string, any>) => { d.ledger += 7; d.entropyLedger += 7; },
    (d: Record<string, any>) => { d.txIndex += 1; },
    (d: Record<string, any>) => { d.season = "10-1"; },
  ]) {
    const copy = structuredClone(log) as RipEvent[];
    change(copy[at].data as Record<string, any>);
    const forged = reseal(copy.slice(0, at), bodies(copy.slice(at)));
    assert.equal(replayLog(forged).ok, false);
    assert.equal((await verifyAgainstChain(forged, ctx.ledger.chain, TREASURY, 100)).ok, false);
  }
  const later = structuredClone(log) as RipEvent[];
  const paidCount = later.filter((e) => e.type === "pull_paid").length;
  assert.equal(paidCount, 5);
  for (const e of later) if (e.type === "pull_paid") Object.assign(e.data, { ledger: e.data.ledger + 3, entropyLedger: e.data.entropyLedger + 3 });
  const shifted = reseal(later.slice(0, at), bodies(later.slice(at)));
  assert.equal(replayLog(shifted).ok, false, "all of them moved together is no better");
});

test("no free pull can cite a bundle's payment: another order naming that transaction is refused by replay and by the ledger check", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 3);
  const log = await ctx.store.readFrom(0);
  const b = ctx.engine.state.bundles.get(id)!;
  const season = ctx.engine.state.seasons.get(b.season as string)!;
  const free: RipEventBody[] = [
    { type: "order_created", data: { id: "insider", season: b.season as string, price: PRICE, address: OTHER, invoice: invoiceOf("insider"), drops: EACH.toString(), lastLedger: (b.ledger as number) + 80, createdLedger: b.ledger as number } },
    { type: "pull_paid", data: { order: "insider", season: b.season as string, index: season.nextIndex, txHash: b.txHash as string, ledger: (b.ledger as number) + 1, txIndex: 0, address: OTHER, drops: EACH.toString(), entropyLedger: (b.ledger as number) + 4 } },
  ];
  const forged = reseal(log, free);
  assert.equal(replayLog(forged).ok, false);
  assert.equal((await verifyAgainstChain(forged, ctx.ledger.chain, TREASURY, 100)).ok, false);
});

test("a pull's season has to be its order's, on a single order too", async () => {
  const ctx = await setup();
  const q = await ctx.engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  const log = await ctx.store.readFrom(0);
  assert.ok(replayLog(log).ok);
  const at = log.findIndex((e) => e.type === "pull_paid");
  const copy = structuredClone(log) as RipEvent[];
  (copy[at].data as Record<string, any>).season = "5-99";
  assert.equal(replayLog(reseal(copy.slice(0, at), bodies(copy.slice(at)))).ok, false);
});

test("free holds: a bundle can't take a pack's last place, unpaid bundles together can't hold more than one order's cap, and a wallet can't overlap two", async () => {
  // Stock that takes three places at most: a bundle gets two, and a single can still buy.
  const thin = await setup({ stock: [0, 3, 3, 3, 2] });
  const room = await thin.engine.quantityRoom(PRICE);
  assert.ok(room.max >= 2, String(room.max));
  const held = await thin.engine.createBundle(PLAYER, PRICE, room.max);
  assert.ok(held.ok, JSON.stringify(held));
  const single = await thin.engine.createOrder(OTHER, PRICE);
  assert.ok(single.ok, `a single still gets in: ${JSON.stringify(single)}`);

  const ctx = await setup({ stock: [0, 60, 40, 40, 40], treasuryXrp: 2000 });
  const third = "rTHIRDthirdTHIRDthirdTHIRDthird";
  ctx.ledger.fund(third, 500);
  assert.ok((await ctx.engine.createBundle(PLAYER, PRICE, 20)).ok);
  assert.equal((await ctx.engine.quantityRoom(PRICE)).max, 20, "the next buyer isn't shut out by one quote");
  assert.ok((await ctx.engine.createBundle(OTHER, PRICE, 20)).ok);
  assert.equal((await ctx.engine.quantityRoom(PRICE)).max, 1, "two orders' worth is all that can sit unpaid");
  assert.equal((await ctx.engine.createBundle(third, PRICE, 2) as { code: string }).code, "qty_too_high");
  assert.ok((await ctx.engine.createOrder(third, PRICE)).ok, "singles stay open however many bundles are held");

  // Near its end a wallet's quote can't be stacked with another.
  const stack = await setup({ stock: [0, 30, 20, 20, 20] });
  const a = await stack.engine.createBundle(PLAYER, PRICE, 5);
  assert.ok(a.ok);
  stack.ledger.close(a.bundle.lastLedger - stack.ledger.ledger() - 5);
  await stack.engine.sync();
  assert.equal((await stack.engine.createBundle(PLAYER, PRICE, 5) as { code: string }).code, "open_checkout");
  assert.equal(holdsFor(stack.engine.state, PRICE), 5);
});

test("a multi order's quote is short, and a late payment still comes back whole", async () => {
  const ctx = await setup();
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(q.ok);
  assert.equal(q.bundle.lastLedger, ctx.ledger.ledger() + 45);
  const single = await ctx.engine.createOrder(OTHER, PRICE);
  assert.ok(single.ok);
  assert.equal(single.order.lastLedger, ctx.ledger.ledger() + 80, "a single's is what it always was");
});

test("a payout a wallet refused still says so, until the player does something else", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 2);
  ctx.ledger.refusePayments(PLAYER, "tecNO_PERMISSION");
  const { done, quote } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  await run(ctx.engine, ctx.ledger, 4);
  const { publicBundle } = await import("../src/lib/rip/views.ts");
  const seen = publicBundle(ctx.engine.state, ctx.engine.state.bundles.get(id)!);
  assert.ok(seen.orders.every((o) => o.pull === "stashed" && o.payout?.status === "failed"));
  ctx.ledger.refusePayments(PLAYER, null);
  ctx.ledger.close(230);
  await ctx.engine.advance();
  assert.equal((await ctx.engine.requestPayout(PLAYER, quote.items)).ok, true);
  const after = publicBundle(ctx.engine.state, ctx.engine.state.bundles.get(id)!);
  assert.ok(after.orders.every((o) => o.payout?.status !== "failed"));
  await run(ctx.engine, ctx.ledger, 4);
  assert.equal(payoutsTo(ctx.ledger, PLAYER).length, 1);
  assert.ok(replayLog(await ctx.store.readFrom(0)).ok);
});

test("a bundle's public face names no wallet, a refund included", async () => {
  const ctx = await setup({ plan: { bandBps: [0, 0, 0, 0, 10_000], prizeTable: [], tokens: [] }, stock: [1, 1, 1, 1, 6], marks: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 2_000_000] });
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 5);
  assert.ok(q.ok, JSON.stringify(q));
  await ctx.engine.sync();
  const removes = [...ctx.engine.state.lots.values()].filter((l) => l.band === 4).slice(0, 3).map((l) => l.lot);
  const { poolRoot } = await import("../src/lib/rip/log.ts");
  await ctx.store.append(ctx.engine.state.head, sealEvents(ctx.engine.state.head, ctx.engine.state.headHash, [{ type: "pool_change", data: { id: "forced", price: PRICE, adds: [], removes, root: poolRoot(PRICE, [], removes) } }], new Date().toISOString()));
  await run(ctx.engine, ctx.ledger, 4);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 8);
  const { publicBundle } = await import("../src/lib/rip/views.ts");
  const seen = publicBundle(ctx.engine.state, ctx.engine.state.bundles.get(q.bundle.id)!);
  assert.ok(seen.orders.some((o) => o.refund));
  assert.ok(!JSON.stringify(seen).includes(PLAYER));
});

test("reading the room costs one treasury read per ledger, however many packs and however many asks", async () => {
  let reads = 0;
  const ctx = await setup({ chain: (c) => ({ ...c, account: async (a, l) => { if (a === TREASURY) reads++; return c.account(a, l); } }) });
  await ctx.engine.sync();
  const ledger = ctx.ledger.ledger();
  await ctx.engine.closedPacks(ledger, async () => null);
  reads = 0;
  const first = await ctx.engine.quantityRooms(ledger, async () => null);
  assert.equal(first["5"], 20);
  assert.ok(reads <= 1, `${reads} reads`);
  reads = 0;
  for (let i = 0; i < 5; i++) await ctx.engine.quantityRooms(ledger, async () => null);
  assert.equal(reads, 0, "cached");
});

test("a season that pays SEAL: every pull strikes from its own ledger with one read of each thing, the float can't be promised twice, and selling them out pays one XRP payment", async () => {
  const { SEAL_CURRENCY, SEAL_ISSUER, SEAL_TOKEN, iouToMicro } = await import("../src/lib/rip/tokens.ts");
  const SPEC = { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer: SEAL_ISSUER };
  const plan = { bandBps: [10_000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: SEAL_TOKEN, bps: 5000, valueDrops: "2500000" }, { band: 0, token: XRP_TOKEN, bps: 5000, valueDrops: "2500000" }], tokens: [SPEC] };
  let pools = 0;
  let lines = 0;
  let hashes = 0;
  const ledger = testLedger("multi-seal");
  ledger.fund(TREASURY, 2000);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 2000);
  ledger.setPool(SPEC, "33007194945", iouToMicro("44788357114.1098"));
  // Only enough SEAL for a few of these prizes: past that, the row pays XRP at value rather than promise tokens twice.
  ledger.setLine(SPEC, TREASURY, 200_000_000n);
  ledger.setLine(SPEC, PLAYER, 0n);
  const chain: Chain = {
    ...ledger.chain,
    ammPool: async (s, l) => (pools++, ledger.chain.ammPool!(s, l)),
    trustLine: async (a, s) => (lines++, ledger.chain.trustLine!(a, s)),
    ledgerHash: async (s) => (hashes++, ledger.chain.ledgerHash(s)),
  };
  const store = memoryStore();
  const engine = createEngine({ store, chain, signer: testSigner(), drawSecret: "multi-secret", expectedNetworkId: 1, multi: { max: 20, cardMax: 1 } });
  await engine.openSeason(PRICE, EACH.toString(), null, plan);
  const adds = [1, 2, 3, 4].flatMap((band) => Array.from({ length: 2 }, (_, i) => {
    const nftId = nftIdFor(300_000 + ++nftCounter);
    ledger.mintTo(nftId, VAULT);
    return { nftId, band, collection: "c", name: `n${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "1000000" };
  }));
  assert.equal((await engine.changePool(PRICE, adds)).ok, true);
  await run(engine, ledger, 6);
  const q = await engine.createBundle(PLAYER, PRICE, 12);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  ledger.close();
  await engine.advance();
  ledger.close(4);
  pools = lines = hashes = 0;
  await engine.advance();
  const kids = childrenOf(engine, q.bundle.id);
  assert.ok(kids.every((o) => o.status === "drawn" && o.prize), "all twelve drawn in one pass");
  assert.equal(hashes, 1, "one ledger hash for twelve pulls");
  assert.ok(pools <= 2, `${pools} pool reads`);
  assert.ok(lines <= 2, `${lines} trust line reads`);
  const seal = kids.filter((o) => o.prize?.token === SEAL_TOKEN);
  const promised = seal.reduce((a, o) => a + BigInt(o.prize!.amount), 0n);
  assert.ok(promised <= 200_000_000n, "never more SEAL than the treasury holds");
  assert.ok(seal.length > 0);
  const quote = await engine.quotePayout(PLAYER, kids.map((o) => o.id));
  assert.ok(quote.ok, JSON.stringify(quote));
  assert.ok(quote.items.every((i) => (engine.state.orders.get(i.order)?.prize?.token === XRP_TOKEN ? i.action === "redeem" : i.action === "sell")));
  const done = await engine.requestPayout(PLAYER, quote.items);
  assert.ok(done.ok, JSON.stringify(done));
  await run(engine, ledger, 5);
  assert.equal(payoutsTo(ledger, PLAYER).length, 1);
  assert.equal(paidOut(ledger, PLAYER), BigInt(quote.total));
  assert.ok(childrenOf(engine, q.bundle.id).every((o) => o.pull === (o.prize?.token === XRP_TOKEN ? "redeemed" : "sold")));
  assert.equal(ledger.tokenBalance(SPEC, TREASURY), 200_000_000n, "a sold prize leaves its SEAL with the treasury, free");
  const log = await store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  const onLedger = await verifyAgainstChain(log, ledger.chain, TREASURY, 100);
  assert.ok(onLedger.ok, JSON.stringify(onLedger));
});

test("a hold on one pack can't close another: cover keeps a place for a single on any pack that's open", async () => {
  for (const treasuryXrp of [160, 260, 320, 400]) {
    const ctx = await setup({ treasuryXrp });
    await ctx.engine.openSeason(10 as NftPrice, "8000000", null, LIVE_PLAN);
    const adds = [1, 2, 3, 4].flatMap((band) => Array.from({ length: 12 }, (_, i) => {
      const nftId = nftIdFor(500_000 + ++nftCounter);
      ctx.ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: "c", name: `n${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "3000000" };
    }));
    assert.equal((await ctx.engine.changePool(10 as NftPrice, adds)).ok, true);
    await run(ctx.engine, ctx.ledger, 6);
    const room = await ctx.engine.quantityRoom(PRICE);
    if (room.max >= 2) assert.ok((await ctx.engine.createBundle(PLAYER, PRICE, room.max)).ok);
    const single = await ctx.engine.createOrder(OTHER, 10 as NftPrice);
    assert.ok(single.ok, `treasury ${treasuryXrp}, held ${room.max}: ${JSON.stringify(single)}`);
  }
});

test("a pack with no stock of its own takes nothing from the maximum: only a pack that can sell keeps a place", async () => {
  const ctx = await setup({ treasuryXrp: 298 });
  await ctx.engine.openSeason(10 as NftPrice, "8000000", null, LIVE_PLAN);
  await run(ctx.engine, ctx.ledger, 4);
  assert.equal((await ctx.engine.quantityRoom(PRICE)).max, 20, "the $10 can't sell, so the $5 keeps its 20");
});

test("one quote doesn't shut multi orders for everyone else: unpaid orders can hold twice one order's cap, and singles stay open past that", async () => {
  const ctx = await setup({ stock: [0, 200, 200, 200, 200], treasuryXrp: 9000, max: 3 });
  const third = "rTHIRDthirdTHIRDthirdTHIRDthird";
  const fourth = "rFOURTHfourthFOURTHfourthFOURTH";
  ctx.ledger.fund(third, 500);
  ctx.ledger.fund(fourth, 500);
  assert.ok((await ctx.engine.createBundle(PLAYER, PRICE, 2)).ok);
  assert.equal((await ctx.engine.quantityRoom(PRICE)).max, 3, "the next buyer still gets the whole cap");
  assert.ok((await ctx.engine.createBundle(OTHER, PRICE, 3)).ok);
  assert.equal((await ctx.engine.quantityRoom(PRICE)).max, 1);
  assert.equal((await ctx.engine.createBundle(third, PRICE, 2) as { code: string }).code, "qty_too_high");
  assert.ok((await ctx.engine.createOrder(fourth, PRICE)).ok);
});

test("a single card pull has to rest on a real payment too", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [5, 5, 5, 5, 5] });
  const log = await ctx.store.readFrom(0);
  const forged = reseal(log, [
    { type: "card_order_created", data: { id: "c1", code: "pokemon_25", name: "x", usd: 25, drops: "20000000", xrpUsd: 1.25, address: OTHER, invoice: invoiceOf("c1"), lastLedger: 999, createdLedger: 100, gateway: "collector-crypt" } },
    { type: "card_paid", data: { order: "c1", txHash: "A".repeat(64), ledger: 110, txIndex: 0, address: OTHER, drops: "20000000" } },
  ]);
  assert.equal((await verifyAgainstChain(forged, ctx.ledger.chain, TREASURY, 100)).ok, false);
});

test("a bundle's payment can't pay for anything else, whichever comes first on the log", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  ctx.ledger.close();
  await ctx.engine.advance();
  const log = await ctx.store.readFrom(0);
  const at = log.findIndex((e) => e.type === "bundle_paid");
  const paid = log[at] as Extract<RipEvent, { type: "bundle_paid" }>;
  const season = ctx.engine.state.orders.get(q.bundle.children[0])!.season;
  const first = (log[at + 1] as Extract<RipEvent, { type: "pull_paid" }>).data.index;
  const sneaked: RipEventBody[] = [
    { type: "order_created", data: { id: "sneak", season, price: PRICE, address: PLAYER, invoice: invoiceOf("sneak"), drops: paid.data.drops, lastLedger: paid.data.ledger + 80, createdLedger: paid.data.ledger - 1 } },
    { type: "pull_paid", data: { order: "sneak", season, index: first, txHash: paid.data.txHash, ledger: paid.data.ledger, txIndex: paid.data.txIndex, address: PLAYER, drops: paid.data.drops, entropyLedger: paid.data.ledger + 3 } },
    { type: "bundle_paid", data: paid.data },
    ...log.slice(at + 1, at + 4).map((e) => {
      const d = e.data as Extract<RipEvent, { type: "pull_paid" }>["data"];
      return { type: "pull_paid", data: { ...d, index: d.index + 1 } } as RipEventBody;
    }),
  ];
  const forged = reseal(log.slice(0, at), sneaked);
  const r = replayLog(forged);
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /can't pay for anything else|paid twice|paid two|already paid/);
});

test("a quote stays payable and can be found again for nearly all its life", async () => {
  const ctx = await setup();
  const q = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(q.ok);
  ctx.ledger.close(q.bundle.lastLedger - ctx.ledger.ledger() - 19);
  await ctx.engine.sync();
  const again = await ctx.engine.createBundle(PLAYER, PRICE, 3);
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.bundle.id, q.bundle.id);
  assert.equal((await ctx.engine.openBundle(PLAYER))?.bundle.id, q.bundle.id);
  const { openCheckouts } = await import("../src/lib/rip/views.ts");
  assert.equal(openCheckouts(ctx.engine.state, PLAYER, ctx.ledger.ledger()).bundles?.length, 1);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  assert.ok(childrenOf(ctx.engine, q.bundle.id).every((o) => o.status === "drawn"));
});

test("a refused payout stops saying so once the player does something else with that item", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 2);
  ctx.ledger.refusePayments(PLAYER, "tecNO_PERMISSION");
  const { done } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  await run(ctx.engine, ctx.ledger, 4);
  const { publicOrder } = await import("../src/lib/rip/views.ts");
  const [a, b] = childrenOf(ctx.engine, id);
  assert.equal(publicOrder(ctx.engine.state, a).payout?.status, "failed");
  ctx.ledger.refusePayments(PLAYER, null);
  ctx.ledger.close(230);
  await ctx.engine.advance();
  assert.equal((await ctx.engine.claim(PLAYER, a.id)).ok, true);
  assert.equal(publicOrder(ctx.engine.state, ctx.engine.state.orders.get(a.id)!).payout, undefined, "claimed");
  const p = ctx.engine.sellPrice(PLAYER, b.id);
  assert.ok(p.ok);
  assert.equal((await ctx.engine.sell(PLAYER, b.id, p.drops)).ok, true);
  assert.equal(publicOrder(ctx.engine.state, ctx.engine.state.orders.get(b.id)!).payout, undefined, "sold on its own");
});

test("a refunded child's own page names no wallet either, and a single order's stays as it was", async () => {
  const { publicOrder } = await import("../src/lib/rip/views.ts");
  const s = emptyState();
  s.seasons.set("5-1", { sellBps: 9506 } as never);
  s.refunds.set("r", { id: "r", to: PLAYER, drops: "1", reason: "band_empty", order: "k", sourceTag: null, status: "due", txHash: null, result: null, paymentTx: null });
  const base = { id: "k", season: "5-1", price: 5, drops: "1", address: PLAYER, status: "refund_due", refundId: "r", band: null, lot: null, prize: null, pull: null, sellDrops: null, txHash: null, sellTx: null, offerId: null, claimTx: null, lastLedger: 1, index: null } as never as import("../src/lib/rip/state.ts").OrderState;
  assert.ok(!JSON.stringify(publicOrder(s, { ...base, bundle: "b" })).includes(PLAYER));
  assert.ok(JSON.stringify(publicOrder(s, base)).includes(PLAYER), "unchanged with the switch off");
});

test("a payment can't be refunded and also pay for something: refunds and funding notes count as its one use", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  await buy(ctx, 3);
  const log = await ctx.store.readFrom(0);
  const paid = log.find((e) => e.type === "bundle_paid") as Extract<RipEvent, { type: "bundle_paid" }>;
  const refundedToo = reseal(log, [{ type: "payment_refund_due", data: { id: `pay:${paid.data.txHash}`, txHash: paid.data.txHash, ledger: paid.data.ledger, txIndex: paid.data.txIndex, from: PLAYER, drops: paid.data.drops, reason: "wrong_amount", order: paid.data.bundle, sourceTag: null } }]);
  assert.equal(replayLog(refundedToo).ok, false);

  const stray = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  stray.ledger.userSubmit({ TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "4000000" });
  await run(stray.engine, stray.ledger, 4);
  const strayLog = await stray.store.readFrom(0);
  assert.ok(replayLog(strayLog).ok, "an honest refund replays");
  const due = strayLog.find((e) => e.type === "payment_refund_due") as Extract<RipEvent, { type: "payment_refund_due" }>;
  const season = stray.engine.state.seasons.get(stray.engine.state.activeSeason.get(PRICE) as string)!;
  const pulledToo = reseal(strayLog, [
    { type: "order_created", data: { id: "again", season: season.season, price: PRICE, address: PLAYER, invoice: invoiceOf("again"), drops: due.data.drops, lastLedger: due.data.ledger + 80, createdLedger: due.data.ledger - 1 } },
    { type: "pull_paid", data: { order: "again", season: season.season, index: season.nextIndex, txHash: due.data.txHash, ledger: due.data.ledger, txIndex: due.data.txIndex, address: PLAYER, drops: due.data.drops, entropyLedger: due.data.ledger + 3 } },
  ]);
  assert.equal(replayLog(pulledToo).ok, false);
});

test("a live pack off the shelf keeps no room: nobody can buy it", async () => {
  const ctx = await setup({ treasuryXrp: 260 });
  await ctx.engine.openSeason(10 as NftPrice, "8000000", null, LIVE_PLAN);
  const adds = [1, 2, 3, 4].flatMap((band) => Array.from({ length: 12 }, (_, i) => {
    const nftId = nftIdFor(700_000 + ++nftCounter);
    ctx.ledger.mintTo(nftId, VAULT);
    return { nftId, band, collection: "c", name: `n${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "3000000" };
  }));
  assert.equal((await ctx.engine.changePool(10 as NftPrice, adds)).ok, true);
  await run(ctx.engine, ctx.ledger, 6);
  const both = (await ctx.engine.quantityRoom(PRICE)).max;
  const shelved = ctx.make({ shelf: [PRICE] });
  const alone = (await shelved.quantityRoom(PRICE)).max;
  assert.ok(alone > both, `${alone} against ${both}`);
});

test("forged logs where a paying player gets less, or a payout reads paid when it wasn't, don't replay", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const id = await buy(ctx, 3);
  const { done } = await cashOut(ctx.engine, PLAYER, id);
  assert.ok(done.ok);
  await run(ctx.engine, ctx.ledger, 4);
  const log = await ctx.store.readFrom(0);
  assert.ok(replayLog(log).ok);
  const b = ctx.engine.state.bundles.get(id)!;
  const paidAt = log.findIndex((e) => e.type === "bundle_paid");
  const insert = (at: number, extra: RipEventBody[]) => reseal(log.slice(0, at), [...extra, ...bodies(log.slice(at))]);
  // A child struck off before its bundle's payment: two pulls for three packs' money.
  assert.equal(replayLog(insert(paidAt, [{ type: "order_expired", data: { id: b.children[0] } }])).ok, false, "a child can't expire alone");

  const final = log.findIndex((e) => e.type === "tx_final" && (ctx.engine.state.settled.get(e.data.id)?.kind === "payout"));
  const change = (fn: (d: Record<string, any>) => void) => {
    const copy = structuredClone(log) as RipEvent[];
    fn(copy[final].data as Record<string, any>);
    return reseal(copy.slice(0, final), bodies(copy.slice(final)));
  };
  assert.equal(replayLog(change((d) => (d.ledger = null))).ok, false, "a success has to name its ledger");
  assert.equal(replayLog(change((d) => (d.hash = "F".repeat(64)))).ok, false, "a result has to be for the transaction signed");

  // The wrong kind of pull for its bundle.
  const asCard = structuredClone(log) as RipEvent[];
  const first = asCard[paidAt + 1] as Extract<RipEvent, { type: "pull_paid" }>;
  const { order, txHash, ledger, txIndex, address, drops } = first.data;
  const swapped = bodies(asCard.slice(paidAt));
  swapped[1] = { type: "card_paid", data: { order, txHash, ledger, txIndex, address, drops } };
  assert.equal(replayLog(reseal(asCard.slice(0, paidAt), swapped)).ok, false);

  // A single sale of something already going out in a payout.
  const payoutAt = log.findIndex((e) => e.type === "payout_requested");
  const item = (log[payoutAt] as Extract<RipEvent, { type: "payout_requested" }>).data.items[0];
  const double = reseal(log.slice(0, payoutAt + 1), [{ type: "tx_intent", data: { id: "sellback:x", kind: "sellback", ref: item.order, account: TREASURY, sequence: 1, lastLedger: 9999, hash: "A".repeat(64), blob: "", tx: { TransactionType: "Payment", Destination: PLAYER, Amount: item.drops } } }]);
  assert.equal(replayLog(double).ok, false);

  // A payment the treasury never sent can't settle a payout on the ledger check.
  const liar: Chain = { ...ctx.ledger.chain, tx: async (h, r) => {
    const t = await ctx.ledger.chain.tx(h, r);
    return t.found && t.tx.tx.Destination === PLAYER && t.tx.tx.Account === TREASURY ? { ...t, tx: { ...t.tx, tx: { ...t.tx.tx, Account: OTHER } } } : t;
  } };
  assert.equal((await verifyAgainstChain(log, liar, TREASURY, 100)).ok, false);
});

test("forged logs on a single order don't replay either: a second payment swallowed, or a drawn order's id reused", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  const q = await ctx.engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  const log = await ctx.store.readFrom(0);
  assert.ok(replayLog(log).ok);
  const o = ctx.engine.state.orders.get(q.order.id)!;
  const season = ctx.engine.state.seasons.get(o.season)!;
  const swallowed = reseal(log, [{ type: "pull_paid", data: { order: o.id, season: o.season, index: season.nextIndex, txHash: "B".repeat(64), ledger: (o.ledger as number) + 5, txIndex: 0, address: PLAYER, drops: o.drops, entropyLedger: (o.ledger as number) + 8 } }]);
  assert.equal(replayLog(swallowed).ok, false);
  const reused = reseal(log, [{ type: "order_created", data: { id: o.id, season: o.season, price: PRICE, address: PLAYER, invoice: invoiceOf(o.id), drops: o.drops, lastLedger: 9999, createdLedger: 200 } }]);
  assert.equal(replayLog(reused).ok, false);
});

test("a launch's single can't take the XRP cover another pack needs: a signed-in buyer on that pack still gets in", async () => {
  for (const treasuryXrp of [140, 150, 160, 170]) {
    const ctx = await setup({ treasuryXrp });
    await ctx.engine.openSeason(10 as NftPrice, "8000000", null, LIVE_PLAN);
    const adds = [1, 2, 3, 4].flatMap((band) => Array.from({ length: 12 }, (_, i) => {
      const nftId = nftIdFor(900_000 + ++nftCounter);
      ctx.ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: "c", name: `n${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "3000000" };
    }));
    assert.equal((await ctx.engine.changePool(10 as NftPrice, adds)).ok, true);
    await run(ctx.engine, ctx.ledger, 6);
    const named = ["rNAMEDonenamedONEnamedONEnamedO", "rNAMEDtwonamedTWOnamedTWOnamedT"];
    for (const n of named) ctx.ledger.fund(n, 500);
    await ctx.engine.createBundle(named[0], PRICE, 2, null, { unproven: true });
    await ctx.engine.createOrder(named[1], PRICE, null, { unproven: true });
    const signed = await ctx.engine.createOrder(OTHER, 10 as NftPrice);
    assert.ok(signed.ok, `treasury ${treasuryXrp}: ${JSON.stringify(signed)}`);
  }
});

test("one payment can't settle two payouts: two intents naming one transaction don't replay", async () => {
  const flat = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000];
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20], marks: flat });
  const first = await buy(ctx, 2);
  const second = await buy(ctx, 2);
  const { done } = await cashOut(ctx.engine, PLAYER, first);
  assert.ok(done.ok);
  await run(ctx.engine, ctx.ledger, 4);
  const log = await ctx.store.readFrom(0);
  const paid = ctx.engine.state.payouts.get((done as { id: string }).id)!;
  const quote = await ctx.engine.quotePayout(PLAYER, childrenOf(ctx.engine, second).map((o) => o.id));
  assert.ok(quote.ok);
  const forged = reseal(log, [
    { type: "payout_requested", data: { id: "second", address: PLAYER, total: paid.total, items: quote.items } },
    { type: "tx_intent", data: { id: "payout:again", kind: "payout", ref: "second", account: TREASURY, sequence: 99, lastLedger: 9999, hash: paid.txHash as string, blob: "", tx: { TransactionType: "Payment", Destination: PLAYER, Amount: paid.total } } },
    { type: "tx_final", data: { id: "payout:again", hash: paid.txHash as string, result: "tesSUCCESS", ledger: ctx.engine.state.settled.get(`payout:${paid.txHash}`)?.ledger ?? 1 } },
  ]);
  assert.equal(replayLog(forged).ok, false);
});

test("a real purchase can't be written off as funding, on a single or a bundle", async () => {
  for (const many of [false, true]) {
    const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
    const q = many ? await ctx.engine.createBundle(PLAYER, PRICE, 2) : await ctx.engine.createOrder(PLAYER, PRICE);
    assert.ok(q.ok);
    ctx.ledger.userSubmit(q.tx as never);
    ctx.ledger.close();
    await ctx.engine.advance();
    const log = await ctx.store.readFrom(0);
    const at = log.findIndex((e) => e.type === "pull_paid" || e.type === "bundle_paid");
    const paid = log[at] as Extract<RipEvent, { type: "pull_paid" }>;
    const orderId = many ? (q as { bundle: { id: string } }).bundle.id : (q as { order: { id: string } }).order.id;
    const forged = reseal(log.slice(0, at), [
      { type: "payment_ignored", data: { txHash: paid.data.txHash, ledger: paid.data.ledger, txIndex: paid.data.txIndex, from: PLAYER, reason: "funding" } },
      { type: "order_expired", data: { id: orderId } },
    ]);
    assert.ok(replayLog(forged).ok, "it reads fine alone");
    const checked = await verifyAgainstChain(forged, ctx.ledger.chain, TREASURY, 100);
    assert.equal(checked.ok, false, JSON.stringify(checked));
  }
});

test("refunds and single sales are tied to what they owe, in the log and on the ledger", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  ctx.ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "9000000" });
  const q = await ctx.engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  const p = ctx.engine.sellPrice(PLAYER, q.order.id);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal((await ctx.engine.sell(PLAYER, q.order.id, p.drops)).ok, true);
  await run(ctx.engine, ctx.ledger, 5);
  const log = await ctx.store.readFrom(0);
  assert.ok(replayLog(log).ok);
  assert.ok((await verifyAgainstChain(log, ctx.ledger.chain, TREASURY, 100)).ok);
  const intent = (kind: string) => log.findIndex((e) => e.type === "tx_intent" && e.data.kind === kind);
  const change = (at: number, fn: (d: Record<string, any>) => void) => {
    const copy = structuredClone(log) as RipEvent[];
    fn(copy[at].data as Record<string, any>);
    return reseal(copy.slice(0, at), bodies(copy.slice(at)));
  };
  assert.equal(replayLog(change(intent("refund"), (d) => (d.tx.Amount = "1"))).ok, false, "a refund for less than it owes");
  assert.equal(replayLog(change(intent("refund"), (d) => (d.tx.Destination = PLAYER))).ok, false, "a refund to someone else");
  assert.equal(replayLog(change(intent("sellback"), (d) => (d.tx.Destination = OTHER))).ok, false, "a sale paid to someone else");
  assert.equal(replayLog(change(intent("sellback"), (d) => (d.tx.Amount = "1"))).ok, false, "a sale for less than agreed");
  const due = log.findIndex((e) => e.type === "payment_refund_due");
  const small = change(due, (d) => (d.drops = "1"));
  assert.equal((await verifyAgainstChain(small, ctx.ledger.chain, TREASURY, 100)).ok, false, "a refund recorded for less than the ledger delivered");
  const missing = (kind: string): Chain => ({ ...ctx.ledger.chain, tx: async (h, r) => (h === (log[intent(kind)] as Extract<RipEvent, { type: "tx_intent" }>).data.hash ? { found: false, definite: true } : ctx.ledger.chain.tx(h, r)) });
  assert.equal((await verifyAgainstChain(log, missing("sellback"), TREASURY, 100)).ok, false, "a sale marked paid that isn't on the ledger");
  assert.equal((await verifyAgainstChain(log, missing("refund"), TREASURY, 100)).ok, false, "a refund marked paid that isn't on the ledger");
});

test("with the switch off, a launch's single has only the base's checks", async () => {
  const build = async (multi: boolean) => {
    const ctx = await setup({ treasuryXrp: 150, multi });
    await ctx.engine.openSeason(10 as NftPrice, "8000000", null, LIVE_PLAN);
    const adds = [1, 2, 3, 4].flatMap((band) => Array.from({ length: 12 }, (_, i) => {
      const nftId = nftIdFor(950_000 + ++nftCounter);
      ctx.ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: "c", name: `n${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "3000000" };
    }));
    assert.equal((await ctx.engine.changePool(10 as NftPrice, adds)).ok, true);
    await run(ctx.engine, ctx.ledger, 6);
    const named = ["rNAMEDonenamedONEnamedONEnamedO", "rNAMEDtwonamedTWOnamedTWOnamedT", "rNAMEDthrnamedTHRnamedTHRnamedT"];
    for (const n of named) ctx.ledger.fund(n, 500);
    const out: string[] = [];
    for (const n of named) {
      const r = await ctx.engine.createOrder(n, PRICE, null, { unproven: true });
      out.push(r.ok ? "held" : (r as { code: string }).code);
    }
    return out;
  };
  const off = await build(false);
  const on = await build(true);
  assert.ok(off.filter((x) => x === "held").length >= on.filter((x) => x === "held").length, `${off} against ${on}`);
  assert.ok(on.includes("confirm_account"), "with the switch on, the cross-pack check is what speaks");
  assert.deepEqual(off.slice(0, 2), ["held", "held"], "off, the base has only its own pack to think of");
});

test("forged logs: a refund paid twice, a sale under its quote, or a sale in another wallet's name don't replay", async () => {
  const ctx = await setup({ plan: NFTS_ONLY, stock: [20, 20, 20, 20, 20] });
  ctx.ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "9000000" });
  const q = await ctx.engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  ctx.ledger.userSubmit(q.tx as never);
  await run(ctx.engine, ctx.ledger, 5);
  const p = ctx.engine.sellPrice(PLAYER, q.order.id);
  assert.ok(p.ok);
  assert.equal((await ctx.engine.sell(PLAYER, q.order.id, p.drops)).ok, true);
  await run(ctx.engine, ctx.ledger, 5);
  const log = await ctx.store.readFrom(0);
  assert.ok(replayLog(log).ok);
  const refund = log.find((e) => e.type === "tx_intent" && e.data.kind === "refund") as Extract<RipEvent, { type: "tx_intent" }>;
  const again = reseal(log, [{ type: "tx_intent", data: { ...refund.data, id: "refund:again", hash: "C".repeat(64), blob: "" } }]);
  assert.equal(replayLog(again).ok, false, "a refund that's already done");
  const sold = log.findIndex((e) => e.type === "sell_requested");
  for (const fn of [(d: Record<string, any>) => (d.drops = "1"), (d: Record<string, any>) => (d.address = OTHER)]) {
    const copy = structuredClone(log) as RipEvent[];
    fn(copy[sold].data as Record<string, any>);
    assert.equal(replayLog(reseal(copy.slice(0, sold), bodies(copy.slice(sold)))).ok, false);
  }
  const cardLog = reseal(log, [
    { type: "card_order_created", data: { id: "c9", code: "x", name: "x", usd: 25, drops: "20000000", xrpUsd: 1.25, address: PLAYER, invoice: invoiceOf("c9"), lastLedger: 9999, createdLedger: 200, gateway: "simulated" } },
    { type: "card_exit_requested", data: { order: "c9", kind: "sell", by: OTHER, drops: "1", usdMicro: "1", addressHash: null } },
  ]);
  assert.equal(replayLog(cardLog).ok, false, "a card's exit in someone else's name");
});

test("lower treasury bounds keep a pack open on a lean treasury: a 2 XRP floor and one top prize of cover, where the defaults close it", async () => {
  // The cover one place needs on this plan, read from the season itself.
  const probe = await setup();
  await probe.engine.sync();
  const season = probe.engine.state.seasons.get(probe.engine.state.activeSeason.get(PRICE) as string)!;
  const one = Number(xrpCoverFor(season.prizeTable, season.bandBps, 1)) / 1e6;
  // One XRP under what the default 10 XRP floor plus one place needs.
  const lean = await setup({ treasuryXrp: one + 9 });
  assert.equal((await lean.engine.createOrder(PLAYER, PRICE) as { code: string }).code, "restocking");
  const relaxed = lean.make({ treasuryFloorDrops: 2_000_000n, xrpCoverPlacesMax: 1 });
  await relaxed.sync();
  assert.ok((await relaxed.createOrder(PLAYER, PRICE)).ok);
  // Places held past the cap count for nothing more, so a multi order still has room on the same treasury.
  assert.ok((await relaxed.quantityRoom(PRICE)).max >= 2);
});
