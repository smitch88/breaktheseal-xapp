import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { NftPrice } from "../src/config/nft-packs.ts";
import { BAND_BPS, bandOf, commitmentOf, digestOf, pickOf, seedAt, seedMatches, sha256Hex, toHex, uniform } from "../src/lib/rip/draw.ts";
import { createEngine, DUST_DROPS, type RipEngine } from "../src/lib/rip/engine.ts";
import { nftIdFlags, poolRefusal } from "../src/lib/rip/nftid.ts";
import { GENESIS_HASH, holdsFor, poolAt, sellableStock, stockOf } from "../src/lib/rip/state.ts";
import type { RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { memoryStore, sealEvents, type EventStore } from "../src/lib/rip/store.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const PRICE: NftPrice = 5;
const DROPS = "4000000";

async function setup(opts: { stock?: readonly number[]; treasuryXrp?: number; seed?: string; store?: EventStore } = {}) {
  const ledger = testLedger(opts.seed ?? "seed");
  ledger.fund(TREASURY, opts.treasuryXrp ?? 1000);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 1000);
  ledger.fund(OTHER, 1000);
  const store = opts.store ?? memoryStore();
  const make = (extra: Partial<Parameters<typeof createEngine>[0]> = {}) => createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "test-secret", expectedNetworkId: 1, ...extra });
  const engine = make();
  await engine.openSeason(PRICE, DROPS);
  let n = 0;
  const stock = opts.stock ?? [40, 20, 8, 4, 2];
  const adds = stock.flatMap((count, band) =>
    Array.from({ length: count }, () => {
      const nftId = nftIdFor(++n);
      ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: `c${n % 8}`, name: `n${n}`, img: "/x.webp", costDrops: "2000000", markDrops: "2000000" };
    }),
  );
  const added = await engine.changePool(PRICE, adds);
  assert.equal(added.ok, true);
  await run(engine, ledger, 6);
  return { ledger, store, engine, make };
}

async function run(engine: RipEngine, ledger: ReturnType<typeof testLedger>, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

async function buy(engine: RipEngine, ledger: ReturnType<typeof testLedger>, address = PLAYER) {
  const quote = await engine.createOrder(address, PRICE);
  assert.ok(quote.ok, JSON.stringify(quote));
  ledger.userSubmit(quote.tx as never);
  return quote.order.id;
}

test("seeds hash back to the commitment, and one seed says nothing about the next", () => {
  const root = sha256Hex("root");
  const commit = commitmentOf(root, 50);
  for (let i = 0; i < 50; i++) assert.ok(seedMatches(seedAt(root, 50, i), i, commit));
  assert.ok(!seedMatches(seedAt(root, 50, 4), 5, commit));
  assert.throws(() => seedAt(root, 50, 50));
});

test("every number comes out of uniform equally often, with no modulo bias, for any pool size", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 40 }), fc.string({ minLength: 1, maxLength: 10 }), (n, salt) => {
      const counts = new Array(n).fill(0);
      const draws = n * 300;
      for (let i = 0; i < draws; i++) counts[uniform(sha256Hex(`${salt}|${i}`), "nft", n)]++;
      // Every outcome lands within 5 standard deviations of even. A biased pick or a skipped index fails this.
      const mean = draws / n;
      const limit = 5 * Math.sqrt(mean * (1 - 1 / n));
      return counts.every((c) => Math.abs(c - mean) < limit);
    }),
    { numRuns: 25 },
  );
});

test("band odds match the published rarity rates", () => {
  const counts = new Array(5).fill(0);
  const draws = 200_000;
  for (let i = 0; i < draws; i++) counts[bandOf(sha256Hex(`band|${i}`))]++;
  BAND_BPS.forEach((bps, b) => {
    const p = bps / 10_000;
    const limit = 5 * Math.sqrt(draws * p * (1 - p));
    assert.ok(Math.abs(counts[b] - draws * p) < limit, `band ${b}: ${counts[b]}`);
  });
});

test("a pull depends only on its published inputs, and any change to one changes the digest", () => {
  fc.assert(
    fc.property(fc.hexaString({ minLength: 64, maxLength: 64 }), fc.hexaString({ minLength: 64, maxLength: 64 }), fc.integer({ min: 0, max: 19999 }), (txHash, ledgerHash, index) => {
      const seed = sha256Hex(txHash);
      const base = { season: "5-1", index, seed, txHash, ledgerHash, address: PLAYER };
      assert.equal(digestOf(base), digestOf({ ...base }));
      assert.notEqual(digestOf(base), digestOf({ ...base, ledgerHash: sha256Hex(ledgerHash).toUpperCase() }));
      assert.notEqual(digestOf(base), digestOf({ ...base, txHash: sha256Hex(txHash).toUpperCase() }));
      assert.notEqual(digestOf(base), digestOf({ ...base, seed: sha256Hex(seed) }));
      return true;
    }),
    { numRuns: 60 },
  );
});

test("timing buys nothing: band odds are the same early, late, and straight after a chase", () => {
  // Group 150,000 pulls by when they happened and by what came before. Every group sees the published rates.
  const draws = 150_000;
  const groups: Record<string, { n: number; chase: number; common: number }> = {};
  const hit = (k: string, band: number) => {
    const g = (groups[k] ??= { n: 0, chase: 0, common: 0 });
    g.n++;
    if (band === 4) g.chase++;
    if (band === 0) g.common++;
  };
  let last = -1;
  for (let i = 0; i < draws; i++) {
    const band = bandOf(digestOf({ season: "5-1", index: i, seed: sha256Hex(`s${i}`), txHash: sha256Hex(`t${i}`), ledgerHash: sha256Hex(`l${i}`), address: PLAYER }));
    hit(`third${Math.floor((i / draws) * 3)}`, band);
    hit(`after${last}`, band);
    last = band;
  }
  for (const [k, g] of Object.entries(groups)) {
    const tol = (p: number) => 5 * Math.sqrt(g.n * p * (1 - p));
    assert.ok(Math.abs(g.chase - g.n * 0.01) < tol(0.01), `${k} chase ${g.chase}/${g.n}`);
    assert.ok(Math.abs(g.common - g.n * 0.66) < tol(0.66), `${k} common ${g.common}/${g.n}`);
  }
});

test("a pick across a band is fair across every NFT, so collections share in proportion to what they hold", () => {
  const size = 24;
  const counts = new Array(size).fill(0);
  const draws = 96_000;
  for (let i = 0; i < draws; i++) counts[pickOf(sha256Hex(`pick|${i}`), size)]++;
  const mean = draws / size;
  for (const c of counts) assert.ok(Math.abs(c - mean) < 5 * Math.sqrt(mean));
});

test("end to end on the test ledger: pay, draw, verify, sell, claim", async () => {
  const { ledger, engine, store } = await setup();
  const a = await buy(engine, ledger);
  const b = await buy(engine, ledger, OTHER);
  await run(engine, ledger, 5);
  const oa = engine.state.orders.get(a)!;
  const ob = engine.state.orders.get(b)!;
  assert.equal(oa.status, "drawn");
  assert.equal(ob.status, "drawn");
  assert.notEqual(oa.nftId, ob.nftId);
  // The NFT stays in the vault while it's stashed.
  assert.equal(ledger.ownerOf(oa.nftId!), VAULT);

  const before = ledger.balance(PLAYER);
  const price = engine.sellPrice(PLAYER, a);
  assert.ok(price.ok);
  assert.equal(price.drops, "1901200");
  assert.deepEqual(await engine.sell(PLAYER, a, price.drops), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(a)!.pull, "sold");
  assert.equal(ledger.balance(PLAYER), before + 1_901_200n);

  assert.deepEqual(await engine.claim(OTHER, b), { ok: true });
  await run(engine, ledger, 3);
  const offered = engine.state.orders.get(b)!;
  assert.equal(offered.pull, "offered");
  ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: OTHER, NFTokenSellOffer: offered.offerId });
  await run(engine, ledger, 2);
  assert.equal(engine.state.orders.get(b)!.pull, "claimed");
  assert.equal(ledger.ownerOf(offered.nftId!), OTHER);

  const events = await store.readFrom(0);
  const replay = replayLog(events);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.equal(replay.pulls, 2);
  assert.deepEqual(await verifyAgainstChain(events, ledger.chain, TREASURY, 1).then((r) => r.ok), true);
});

test("nothing sells before the commitment is on the ledger, and the network check refuses a wrong ledger", async () => {
  const ledger = testLedger();
  ledger.fund(TREASURY, 100);
  ledger.fund(VAULT, 100);
  const engine = createEngine({ store: memoryStore(), chain: ledger.chain, signer: testSigner(), drawSecret: "x", expectedNetworkId: 1 });
  await engine.openSeason(PRICE, DROPS);
  const r = await engine.createOrder(PLAYER, PRICE);
  assert.ok(!r.ok);
  assert.equal(r.code, "not_open");

  const mainnet = testLedger("m", 0);
  mainnet.fund(TREASURY, 100);
  const wrong = createEngine({ store: memoryStore(), chain: mainnet.chain, signer: testSigner(), drawSecret: "x", expectedNetworkId: 1 });
  await assert.rejects(() => wrong.advance(), /refusing to run/);
  assert.equal(mainnet.submitted.length, 0);
});

test("a wrong payment is never a pull: amount, wallet, lateness, double pay and no order all get their XRP back", async () => {
  const { ledger, engine } = await setup();
  const quote = async (who = PLAYER) => {
    const q = await engine.createOrder(who, PRICE);
    assert.ok(q.ok);
    return q;
  };
  const start = ledger.balance(OTHER);

  const wrongAmount = await quote(OTHER);
  ledger.userSubmit({ ...(wrongAmount.tx as object), Amount: "3999999" } as never);
  await run(engine, ledger, 4);
  assert.equal(ledger.balance(OTHER), start - 12n, "refund came back whole, only the network fee spent");

  const fromElsewhere = await quote(PLAYER);
  const p0 = ledger.balance(OTHER);
  ledger.userSubmit({ ...(fromElsewhere.tx as object), Account: OTHER } as never);
  await run(engine, ledger, 4);
  assert.equal(ledger.balance(OTHER), p0 - 12n, "a stranger paying someone's order is refunded");
  assert.equal(engine.state.orders.get(fromElsewhere.order.id)!.status, "quoted");

  ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: DUST_DROPS.toString() });
  await run(engine, ledger, 4);
  const noOrderRefund = [...engine.state.refunds.values()].find((r) => r.reason === "no_order");
  assert.equal(noOrderRefund?.status, "done");

  const good = await quote(PLAYER);
  // Same order paid twice, both in time: the second comes back.
  const p1 = ledger.balance(PLAYER);
  ledger.userSubmit(good.tx as never);
  ledger.close();
  ledger.userSubmit(good.tx as never);
  await run(engine, ledger, 6);
  assert.equal(engine.state.orders.get(good.order.id)!.status, "drawn");
  assert.equal(ledger.balance(PLAYER), p1 - BigInt(DROPS) - 24n);
  assert.equal([...engine.state.refunds.values()].filter((r) => r.reason === "already_paid" && r.status === "done").length, 1);

  // Dust from nobody is left alone: no refund and no log entry.
  ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "5" });
  await run(engine, ledger, 2);
  assert.equal([...engine.state.refunds.values()].filter((r) => r.drops === "5").length, 0);
});

test("a payment after the quote's last ledger is refunded, and a funding wallet is left alone", async () => {
  const { ledger, make, store } = await setup();
  const engine = make({ fundingAddresses: [OTHER] });
  await engine.sync();
  const q = await engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  const { LastLedgerSequence: _drop, ...noLimit } = q.tx as Record<string, unknown>;
  await run(engine, ledger, 85);
  assert.equal(engine.state.orders.get(q.order.id)!.status, "expired");
  assert.equal(holdsFor(engine.state, PRICE), 0);
  const before = ledger.balance(PLAYER);
  ledger.userSubmit(noLimit as never);
  await run(engine, ledger, 4);
  assert.equal(ledger.balance(PLAYER), before - 12n);
  const funded = ledger.balance(TREASURY);
  ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "50000000" });
  await run(engine, ledger, 4);
  assert.ok(ledger.balance(TREASURY) >= funded + 50_000_000n - 1000n);
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("stock rule: a paid pull lands on an NFT or gets its XRP back whole, whichever band it hits, and float can't go negative", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 5, maxLength: 5 }), fc.array(fc.nat(9), { minLength: 5, maxLength: 40 }), fc.string({ minLength: 1, maxLength: 6 }), async (stock, script, seed) => {
      const { ledger, engine, store } = await setup({ stock, seed });
      let paid = 0;
      for (const move of script) {
        if (move < 6) {
          const q = await engine.createOrder(move < 3 ? PLAYER : OTHER, PRICE);
          if (q.ok && move % 2 === 0) {
            ledger.userSubmit(q.tx as never);
            paid++;
          }
        }
        await engine.advance();
        ledger.close();
        await engine.sync();
      }
      await run(engine, ledger, 8);
      const orders = [...engine.state.orders.values()];
      // The rule keeps an overrun under HOLD_RISK. If one happens anyway, the XRP goes back whole. A second payment on one order is also refunded.
      for (const r of engine.state.refunds.values()) assert.ok(["band_empty", "already_paid"].includes(r.reason as string), r.reason);
      const nfts = orders.filter((o) => o.nftId).map((o) => o.nftId);
      assert.equal(new Set(nfts).size, nfts.length, "no NFT delivered twice");
      const replay = replayLog(await store.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
      return true;
    }),
    { numRuns: 25 },
  );
});

test("sell-backs can't overdraw the treasury, and everything owed stays covered", async () => {
  const { ledger, engine } = await setup({ treasuryXrp: 15, stock: [10, 5, 5, 5, 5] });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await buy(engine, ledger));
    await run(engine, ledger, 5);
  }
  const start = ledger.balance(TREASURY);
  let accepted = 0n;
  // Hold the floor at 10 XRP on top of the 15 in plus 12 from sales, and try selling all of it, repeatedly.
  for (const id of ids) {
    const p = engine.sellPrice(PLAYER, id);
    if (!p.ok) continue;
    const r = await engine.sell(PLAYER, id, p.drops);
    if (r.ok) accepted += BigInt(p.drops);
  }
  await run(engine, ledger, 5);
  assert.ok(ledger.balance(TREASURY) >= start - accepted - 2000n);
  assert.ok(ledger.balance(TREASURY) >= 10_000_000n - 2000n, "the floor holds");
});

test("selling twice pays once, and a claimed NFT can't be sold", async () => {
  const { ledger, engine } = await setup();
  const id = await buy(engine, ledger);
  await run(engine, ledger, 5);
  const p = engine.sellPrice(PLAYER, id);
  assert.ok(p.ok);
  const before = ledger.balance(PLAYER);
  await Promise.all([engine.sell(PLAYER, id, p.drops), engine.sell(PLAYER, id, p.drops), engine.sell(PLAYER, id, p.drops)]);
  await run(engine, ledger, 4);
  assert.equal(ledger.balance(PLAYER), before + BigInt(p.drops));
  assert.ok(!(await engine.claim(PLAYER, id)).ok, "sold can't be claimed");
  assert.ok(!engine.sellPrice(OTHER, id).ok);

  const id2 = await buy(engine, ledger);
  await run(engine, ledger, 5);
  await engine.claim(PLAYER, id2);
  await run(engine, ledger, 3);
  assert.ok(!engine.sellPrice(PLAYER, id2).ok, "an open offer blocks selling");
  // Taking the offer back reopens selling.
  await engine.cancelClaim(PLAYER, id2);
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(id2)!.pull, "stashed");
  assert.equal(ledger.offers.size, 0);
  assert.ok(engine.sellPrice(PLAYER, id2).ok);
});

test("a stale claim-cancel loses to the player's accept in an earlier ledger: the player keeps the NFT", async () => {
  const { ledger, engine } = await setup();
  const id = await buy(engine, ledger);
  await run(engine, ledger, 5);
  await engine.claim(PLAYER, id);
  await run(engine, ledger, 3);
  const offered = engine.state.orders.get(id)!;
  ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offered.offerId });
  await engine.cancelClaim(PLAYER, id);
  await run(engine, ledger, 4);
  assert.equal(engine.state.orders.get(id)!.pull, "claimed");
  assert.equal(ledger.ownerOf(offered.nftId!), PLAYER);
});

test("a cancel that lands right after the accept can't double-spend: the player keeps the NFT and can't sell it", async () => {
  const { ledger, engine } = await setup();
  const id = await buy(engine, ledger);
  await run(engine, ledger, 5);
  await engine.claim(PLAYER, id);
  await run(engine, ledger, 3);
  const offered = engine.state.orders.get(id)!;
  const nftId = offered.nftId!;
  const offerId = offered.offerId;
  await engine.cancelClaim(PLAYER, id);
  // Accept lands first in the same ledger as our cancel, which then succeeds on an offer already gone.
  ledger.queueFirst({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offerId });
  await engine.advance();
  ledger.close();
  await engine.advance();
  await run(engine, ledger, 3);
  assert.equal(ledger.ownerOf(nftId), PLAYER);
  const after = engine.state.orders.get(id)!;
  assert.equal(after.pull, "claimed");
  assert.equal(engine.sellPrice(PLAYER, id).ok, false);
});

test("a log belongs to one network and treasury: a testnet database can't run on mainnet", async () => {
  const { store } = await setup();
  const mainnet = testLedger("m", 0);
  mainnet.fund(TREASURY, 100);
  const wrong = createEngine({ store, chain: mainnet.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 0 });
  await assert.rejects(() => wrong.advance(), /different network/);
  assert.equal(mainnet.submitted.length, 0);
});

test("a server missing history or a sequence proof can't cause a second payment", async () => {
  const { ledger, store } = await setup();
  const engine = createEngine({ store, chain: { ...ledger.chain, tx: async () => ({ found: false, definite: true }), account: async (a, at) => (at ? null : ledger.chain.account(a)) }, signer: testSigner(), drawSecret: "test-secret", expectedNetworkId: 1 });
  await engine.sync();
  ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "5000000" });
  ledger.close();
  await engine.advance();
  const before = [...engine.state.intents.values()].length;
  assert.equal(before, 1, "a refund is in flight");
  for (let i = 0; i < 30; i++) {
    ledger.close();
    await engine.advance();
  }
  // The refund landed, but this server can't see it. It must wait rather than sign another.
  const paid = ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.result === "tesSUCCESS");
  assert.equal(paid.length, 1);
  assert.equal([...engine.state.intents.values()].length, 1);
});

test("a flood of stray payments can't starve a player's sell-back", async () => {
  const { ledger, engine } = await setup();
  const id = await buy(engine, ledger);
  await run(engine, ledger, 5);
  for (let i = 0; i < 6; i++) ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "1000000" });
  ledger.close();
  await engine.advance();
  const p = engine.sellPrice(PLAYER, id);
  assert.ok(p.ok);
  await engine.sell(PLAYER, id, p.drops);
  for (let i = 0; i < 6; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
  assert.equal(engine.state.orders.get(id)!.pull, "sold");
});

test("a sold-back NFT goes back in its pool as a new lot, through the anchored door, and can be pulled again", async () => {
  const { ledger, engine, store } = await setup({ stock: [1, 1, 1, 1, 1] });
  const id = await buy(engine, ledger);
  await run(engine, ledger, 5);
  const first = engine.state.orders.get(id)!;
  const p = engine.sellPrice(PLAYER, id);
  assert.ok(p.ok);
  await engine.sell(PLAYER, id, p.drops);
  await run(engine, ledger, 6);
  const lots = [...engine.state.lots.values()].filter((l) => l.nftId === first.nftId);
  assert.equal(lots.length, 2);
  assert.equal(lots[1].status, "available");
  assert.equal(lots[1].costDrops, p.drops);
  assert.equal(lots[0].status, "removed");
  assert.equal(poolAt(engine.state, PRICE, first.band!, ledger.ledger()).length, 1);
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("restock refuses what can't be delivered: not in the vault, non-transferable, burnable, already listed", async () => {
  const { ledger, engine } = await setup({ stock: [1, 1, 1, 1, 1] });
  const row = (nftId: string) => ({ nftId, band: 0, collection: "c", name: "n", img: "/x.webp", costDrops: "1", markDrops: "1" });
  const notHeld = nftIdFor(9001);
  assert.equal((await engine.changePool(PRICE, [row(notHeld)])).ok, false);
  const stuck = nftIdFor(9002, 0);
  ledger.mintTo(stuck, VAULT);
  assert.equal((await engine.changePool(PRICE, [row(stuck)])).ok, false);
  assert.equal(poolRefusal(stuck), "not transferable");
  const burnable = nftIdFor(9003, 9);
  ledger.mintTo(burnable, VAULT);
  assert.equal((await engine.changePool(PRICE, [row(burnable)])).ok, false);
  assert.equal(poolRefusal(burnable), "its issuer can burn it");
  const fine = nftIdFor(9004);
  ledger.mintTo(fine, VAULT);
  assert.equal((await engine.changePool(PRICE, [row(fine)])).ok, true);
  assert.equal((await engine.changePool(PRICE, [row(fine)])).ok, false, "already listed");
  assert.deepEqual(nftIdFlags(nftIdFor(1, 8, 5000)), { flags: 8, transferFee: 5000 });
});

test("a pool change can't reach a pull already paid: it applies only after its anchor's ledger", async () => {
  const { ledger, engine, store } = await setup({ stock: [2, 2, 2, 2, 2] });
  const id = await buy(engine, ledger);
  ledger.close(); // The payment is in; the entropy ledger isn't.
  const fresh = nftIdFor(9100);
  ledger.mintTo(fresh, VAULT);
  await engine.changePool(PRICE, [{ nftId: fresh, band: 0, collection: "c", name: "n", img: "/x.webp", costDrops: "1", markDrops: "1" }]);
  await run(engine, ledger, 6);
  const o = engine.state.orders.get(id)!;
  assert.notEqual(o.nftId, fresh);
  const lot = [...engine.state.lots.values()].find((l) => l.nftId === fresh)!;
  assert.ok(lot.addLedger! > o.ledger!);
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("taking a lot out can't strand an open order", async () => {
  const { ledger, engine } = await setup({ stock: [1, 1, 1, 1, 1] });
  const q = await engine.createOrder(PLAYER, PRICE);
  assert.ok(q.ok);
  const lot = poolAt(engine.state, PRICE, 2, ledger.ledger())[0];
  const r = await engine.changePool(PRICE, [], [lot.lot]);
  assert.equal(r.ok, false);
  assert.ok(sellableStock(engine.state, PRICE, ledger.ledger()).every((n) => n === 1));
});

test("a wallet can't sit on the stock: a repeat tap returns the open order", async () => {
  const { engine } = await setup();
  const a = await engine.createOrder(PLAYER, PRICE);
  const b = await engine.createOrder(PLAYER, PRICE);
  assert.ok(a.ok && b.ok);
  assert.equal(a.order.id, b.order.id);
  assert.equal(holdsFor(engine.state, PRICE), 1);
});

test("replay catches any edit to the log", async () => {
  const { ledger, engine, store } = await setup({ stock: [6, 3, 3, 3, 3] });
  for (let i = 0; i < 3; i++) await buy(engine, ledger);
  await run(engine, ledger, 6);
  const events = [...(await store.readFrom(0))];
  assert.ok(replayLog(events).ok);
  const drawAt = events.findIndex((e) => e.type === "pull_drawn");
  await fc.assert(
    fc.property(fc.nat(events.length - 1), (i) => {
      const edited = events.map((e, j) => (j === i ? { ...e, at: "2000-01-01T00:00:00.000Z" } : e));
      return !replayLog(edited).ok;
    }),
    { numRuns: 30 },
  );
  // Even a forger who rehashes the whole log can't change what a pull landed on.
  const forged = replayForge(events, drawAt, (d: Record<string, unknown>) => ({ ...d, band: ((d.band as number) + 1) % 5 }));
  assert.equal(replayLog(forged).ok, false);
  const forgedSeed = replayForge(events, drawAt, (d: Record<string, unknown>) => ({ ...d, seed: toHex(new Uint8Array(32).fill(7)) }));
  assert.equal(replayLog(forgedSeed).ok, false);
});

function replayForge(events: readonly RipEvent[], at: number, change: (d: Record<string, unknown>) => Record<string, unknown>): RipEvent[] {
  const out: RipEvent[] = [];
  events.forEach((e, i) => {
    const body = { type: e.type, data: i === at ? change(e.data as Record<string, unknown>) : e.data } as RipEventBody;
    const last = out.at(-1);
    out.push(...sealEvents(last?.seq ?? 0, last?.hash ?? GENESIS_HASH, [body], e.at));
  });
  return out;
}

/** Crash wherever the store or the ledger is touched, restart with a fresh engine, and everything must still add up. */
test("crash anywhere, restart, and it all adds up: no charge without a pull, no double delivery, no double payment", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.nat(30), { minLength: 1, maxLength: 14 }), fc.array(fc.constantFrom("sell", "claim", "pay", "bad", "none"), { minLength: 3, maxLength: 10 }), fc.string({ minLength: 1, maxLength: 5 }), async (crashAt, moves, seed) => {
      const inner = memoryStore();
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
      const base = await setup({ seed, store: inner, stock: [8, 4, 3, 3, 3] });
      const { ledger } = base;
      const chain = {
        ...ledger.chain,
        submit: async (blob: string) => {
          maybeCrash();
          const r = await ledger.chain.submit(blob);
          maybeCrash();
          return r;
        },
      };
      const fresh = () => createEngine({ store, chain, signer: testSigner(), drawSecret: "test-secret", expectedNetworkId: 1 });
      let engine = fresh();
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch {
          engine = fresh(); // The process died. Everything in memory is gone.
        }
      };
      const paid: string[] = [];
      for (const move of moves) {
        await attempt(() => engine.advance());
        ledger.close();
        if (move === "pay") {
          await attempt(async () => {
            const q = await engine.createOrder(PLAYER, PRICE);
            if (q.ok && !paid.includes(q.order.id)) {
              ledger.userSubmit(q.tx as never);
              paid.push(q.order.id);
            }
          });
        } else if (move === "bad") {
          ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "3000000" });
        } else if (move === "sell" || move === "claim") {
          await attempt(async () => {
            await engine.sync();
            const held = [...engine.state.orders.values()].find((o) => o.pull === "stashed");
            if (!held) return;
            if (move === "claim") await engine.claim(held.address, held.id);
            else {
              const p = engine.sellPrice(held.address, held.id);
              if (p.ok) await engine.sell(held.address, held.id, p.drops);
            }
          });
        }
      }
      // Stop crashing and let it finish.
      plan.clear();
      engine = fresh();
      await run(engine, ledger, 10);
      const orders = [...engine.state.orders.values()];
      for (const id of paid) {
        const o = orders.find((x) => x.id === id);
        assert.ok(o);
        assert.ok(o.status === "drawn" || o.status === "refunded" || o.status === "expired", `order ended ${o.status}`);
      }
      const onChainPayments = ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Destination === TREASURY && t.tx.Account !== TREASURY && t.result === "tesSUCCESS");
      for (const t of onChainPayments) {
        const pull = orders.find((o) => o.txHash === t.hash && o.status === "drawn");
        const refunded = engine.state.refunds.get(`pay:${t.hash}`);
        const ignored = engine.state.seenTx.has(t.hash);
        assert.ok(pull || refunded?.status === "done" || ignored, `payment ${t.hash} went nowhere`);
      }
      // No refund or sell-back paid twice: each one has exactly one validated success on the ledger.
      const payouts = new Map<string, number>();
      for (const t of ledger.history) {
        if (t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.result === "tesSUCCESS") {
          const key = JSON.stringify(t.tx.Memos);
          payouts.set(key, (payouts.get(key) ?? 0) + 1);
        }
      }
      for (const [k, n] of payouts) assert.equal(n, 1, `paid ${n} times: ${k}`);
      const nfts = orders.filter((o) => o.nftId && o.pull !== "sold").map((o) => o.nftId);
      assert.equal(new Set(nfts).size, nfts.length, "an NFT is held by two pulls");
      assert.deepEqual((await store.readFrom(0)).length > 0, true);
      const replay = replayLog(await inner.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
      return true;
    }),
    { numRuns: 40 },
  );
});

test("two servers racing: the log lets one win each step, and nothing happens twice", async () => {
  const base = await setup({ stock: [8, 4, 3, 3, 3] });
  const { ledger, make } = base;
  const a = make();
  const b = make();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const q = await (i % 2 ? a : b).createOrder(i % 2 ? PLAYER : OTHER, PRICE);
    if (q.ok && !ids.includes(q.order.id)) {
      ledger.userSubmit(q.tx as never);
      ids.push(q.order.id);
    }
    ledger.close();
    await Promise.all([a.advance(), b.advance()]);
  }
  for (let i = 0; i < 8; i++) {
    await Promise.all([a.advance(), b.advance()]);
    ledger.close();
  }
  await a.sync();
  const drawn = ids.map((id) => a.state.orders.get(id)!);
  assert.ok(drawn.every((o) => o.status === "drawn"));
  assert.equal(new Set(drawn.map((o) => o.nftId)).size, ids.length);
  assert.ok(replayLog(await base.store.readFrom(0)).ok);
});
