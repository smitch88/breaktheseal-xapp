import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SEASON_5_5 } from "../src/config/nft-packs.ts";
import { bandOf, fallbackRowOf, itemPick, itemWeights, prizeTableHash, seasonTermsHash, sha256Hex, xrpCoverFor, type PrizeRow, type SeasonTerms } from "../src/lib/rip/draw.ts";
import { MAX_SELL_BACK_SHARE, SELL_BPS, createEngine, sellBackShare } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { bandOfValue, itemEconomics } from "../src/lib/rip/rarity-spec.ts";
import { bandsTile, leavingLots, rebandMoves, rebandProgress, type RebandFile } from "../src/lib/rip/restock.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { prizeTableFor, seasonPlan } from "../src/lib/rip/tokens.ts";
import type { Lot, RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { inPoolAlready } from "../src/lib/rip/views.ts";
import { TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

/**
 * AU-BTS nemesis audit of the $5 Copper pack's season 5-6 (feat/seal-rips-copper-tiers at e7dbe7281), 2026-11-05. Each test is one question the audit
 * asked of the code, answered from the committed table, the 2026-11-05 pool and the simulated ledger. Report: audit/2026-11-05-copper-5-6-nemesis.md.
 * Internal: margins and returns here are never shown to a player.
 */
const POOL = JSON.parse(readFileSync(new URL("./fixtures/pool-5-20261105.json", import.meta.url), "utf8")) as { bands: { nfts: { id: string; collection: string; name: string; markXrp: number }[] }[] };
const P = 4;
const SELL = SELL_BPS / 10_000;
const L56 = NFT_LADDERS[5];
const L55 = { ...L56, ...SEASON_5_5 };
const NFTS = POOL.bands.flatMap((b, band) => b.nfts.map((n) => ({ ...n, band55: band, band56: bandOfValue(P, n.markXrp) })));
/** The pool in 5-6's value bands, the zPunk under every band left out. */
const BANDED = [0, 1, 2, 3, 4].map((b) => NFTS.filter((n) => n.band56 === b).map((n) => n.markXrp));
const TABLE = prizeTableFor(L56.tokenPrizes, false);
const xrp = (n: number) => BigInt(Math.round(n * 1e6));
const close = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ---------- Q5: the margin and the odds, recomputed

/**
 * One band's numbers by plain arithmetic under per-item odds: each NFT at k / its mark of the band, what they leave to the band's rows at their
 * weights (or, with no rows, the price back). A band's rows' published shares are its full pool's.
 */
function bandMath(band: number, marks: readonly number[]) {
  const rate = L56.bandBps[band] / 10_000;
  const rows = L56.tokenPrizes.filter((r) => r.band === band);
  const rowShare = rows.reduce((a, r) => a + r.bps, 0) / 10_000;
  const avgRow = rowShare ? rows.reduce((a, r) => a + (r.bps / 10_000) * r.xrp, 0) / rowShare : P;
  const k = L56.nftOdds!.kDrops[band] / 1e6;
  const p = marks.map((m) => k / m);
  const taken = p.reduce((a, x) => a + x, 0);
  const nftSell = p.reduce((a, x, i) => a + x * marks[i] * SELL, 0);
  const nftKeep = p.reduce((a, x, i) => a + x * marks[i], 0);
  const left = 1 - taken;
  return { rate, xrpPrize: rows.length ? rate * left * avgRow : 0, nftChance: rate * taken, sell: rate * (nftSell + left * avgRow), keep: rate * (nftKeep + left * avgRow) };
}

test("5-6's numbers by plain arithmetic on the 2026-11-05 pool, each NFT at its own odds: 6.40% sold, 4.86% kept, 35.0% NFTs, 29.09% at exactly 2 XRP, 255.6 / 374.4 / 124.9 per 100, and the code agrees", () => {
  assert.deepEqual(BANDED.map((m) => m.length), [15, 2, 22, 5, 4]);
  assert.deepEqual(NFTS.filter((n) => n.band56 === null).map((n) => n.markXrp), [1.75]);
  const bands = BANDED.map((m, b) => bandMath(b, m));
  const sell = bands.reduce((a, b) => a + b.sell, 0);
  const keep = bands.reduce((a, b) => a + b.keep, 0);
  const xrpPrizes = bands.reduce((a, b) => a + b.xrpPrize, 0);
  const nfts = bands.reduce((a, b) => a + b.nftChance, 0);
  close(1 - sell / P, 0.064, 0.00005, "sell-path margin");
  close(1 - keep / P, 0.0486, 0.00005, "keep-path margin");
  close(nfts, 0.35, 0.0005, "NFT pulls");
  // On the full pool the NFTs take what the rows leave, so the 2 XRP rung keeps its published share.
  close((L56.bandBps[0] / 10_000) * (3888 / 10_000), 0.2909, 0.00005, "exactly 2 XRP");
  close(xrpPrizes * 100, 255.6, 0.05, "XRP prizes per 100");
  close(sell * 100, 374.4, 0.05, "outflow per 100, every NFT sold");
  close((keep - xrpPrizes) * 100, 124.9, 0.05, "NFTs kept per 100, at marks");
  // Nothing under half the pack: every row and every pooled NFT is 2 XRP or more.
  assert.ok([...L56.tokenPrizes.map((r) => r.xrp), ...BANDED.flat()].every((v) => v >= P / 2));
  // The code's own figures, through the draw's weights (floored to a billionth of a band).
  const e = itemEconomics(L56, L56.nftOdds!, BANDED, SELL_BPS);
  close(e.allSell, sell / P, 1e-6, "itemEconomics.allSell");
  close(e.allKeep, keep / P, 1e-6, "itemEconomics.allKeep");
  close(e.tokensPerPull, xrpPrizes, 1e-6, "itemEconomics.tokensPerPull");
});

test("the engine's own draw functions land those odds: 100,000 digests through bandOf, itemPick, fallbackRowOf, full pool and empty bands", () => {
  const N = 100_000;
  const pools = BANDED.map((m) => [...m].sort((a, b) => a - b));
  const tally = (emptyBands: ReadonlySet<number>) => {
    const bands = [0, 0, 0, 0, 0];
    const weights = pools.map((m, b) => itemWeights(L56.nftOdds!, TABLE, b, emptyBands.has(b) ? [] : m.map((x) => xrp(x)), SELL_BPS, 4_000_000));
    let paid = 0;
    let nft = 0;
    let two = 0;
    let under = 0;
    for (let i = 0; i < N; i++) {
      const d = sha256Hex(`copper-audit-${i}`);
      const band = bandOf(d, L56.bandBps);
      bands[band]++;
      const at = itemPick(d, weights[band]);
      let value: number;
      if (at !== null) {
        value = pools[band][at] * SELL;
        nft++;
      } else {
        const row: PrizeRow | null = fallbackRowOf(d, TABLE, band);
        value = row ? Number(row.valueDrops) / 1e6 : P;
        if (row && value === 2) two++;
        if (row && value < P / 2 - 1e-9) under++;
      }
      paid += value;
    }
    return { bands: bands.map((n) => n / N), mean: paid / N, nft: nft / N, two: two / N, under };
  };
  const full = tally(new Set());
  L56.bandBps.forEach((bps, b) => close(full.bands[b], bps / 10_000, 4 * Math.sqrt((bps / 10_000) * (1 - bps / 10_000) / N) + 1e-4, `band ${b}`));
  close(full.nft, 0.35, 0.006, "NFT share");
  close(full.two, 0.2909, 0.006, "exactly 2 XRP");
  assert.equal(full.under, 0);
  // One pull's payout has a standard deviation near 4.2 XRP: 4 standard errors over 100,000 pulls is under 0.06 XRP.
  close(full.mean, P * (1 - 0.064), 0.06, "mean sell-path payout");
  // Every band but Chase empty: each pays its own rows, at their published weights.
  const empty = tally(new Set([0, 1, 2, 3]));
  const want = BANDED.map((m, b) => bandMath(b, b === 4 ? m : [])).reduce((a, b) => a + b.sell, 0);
  close(empty.mean, want, 0.06, "mean payout with four empty bands");
});

test("no set of empty bands puts the house behind or past its ceiling; an empty Common costs players about 4.9 points, which the owner should know", () => {
  const share = (empty: ReadonlySet<number>) => BANDED.map((m, b) => bandMath(b, empty.has(b) ? [] : m)).reduce((a, x) => a + x.sell, 0) / P;
  const all = share(new Set());
  const ceiling = itemEconomics(L56, L56.nftOdds!, BANDED, SELL_BPS).ceilingShare;
  for (let mask = 0; mask < 16; mask++) {
    const empty = new Set([0, 1, 2, 3].filter((b) => mask & (1 << b)));
    const s = share(empty);
    assert.ok(s <= ceiling + 1e-9 && s < MAX_SELL_BACK_SHARE, `${[...empty]}: ${s}`);
    assert.ok(s < 1, `${[...empty]}: the house keeps a margin`);
    // Only an empty Uncommon pays players a little more than its NFTs did: its ladder beats its two NFTs at a sale's value.
    if (!empty.has(1)) assert.ok(s <= all + 1e-12, `${[...empty]}`);
  }
  close(share(new Set([0])), 0.8851, 0.0005, "Common empty");
  close(share(new Set([1])), 0.9366, 0.0005, "Uncommon empty: the ceiling");
  close(share(new Set([0, 1, 2, 3])), 0.8824, 0.0005, "all but Chase empty");
});

// ---------- Q1: the terms hash

/** The terms hash as 874013738 wrote it, before 5-6. Every season on the ledger was anchored with this. */
const oldTermsHash = (t: SeasonTerms) => sha256Hex(JSON.stringify([t.priceDrops, t.bandBps, t.sellBps, prizeTableHash(t.prizeTable), t.tokens.map((k) => [k.id, k.currency, k.issuer])]));

test("property: a season without the fallback hashes byte for byte as before; one with it differs, and the hash commits to it", () => {
  const row = fc.record({ band: fc.integer({ min: 0, max: 4 }), token: fc.constantFrom("XRP", "SEAL"), bps: fc.integer({ min: 0, max: 10_000 }), valueDrops: fc.bigInt({ min: 1n, max: 10n ** 9n }).map(String), dust: fc.option(fc.constant(true as const), { nil: undefined }) });
  const terms = fc.record({
    priceDrops: fc.bigInt({ min: 1n, max: 10n ** 9n }).map(String),
    bandBps: fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 5, maxLength: 5 }),
    sellBps: fc.integer({ min: 0, max: 10_000 }),
    prizeTable: fc.array(row.map((r) => (r.dust ? r : { band: r.band, token: r.token, bps: r.bps, valueDrops: r.valueDrops })), { maxLength: 20 }),
    tokens: fc.array(fc.record({ id: fc.constantFrom("SEAL", "X"), currency: fc.hexaString({ minLength: 3, maxLength: 40 }), issuer: fc.string({ minLength: 1, maxLength: 34 }) }), { maxLength: 2 }),
  });
  fc.assert(fc.property(terms, (t) => {
    assert.equal(seasonTermsHash(t), oldTermsHash(t));
    assert.equal(seasonTermsHash({ ...t, emptyBand: undefined }), oldTermsHash(t));
    assert.notEqual(seasonTermsHash({ ...t, emptyBand: "rows" }), oldTermsHash(t));
    // Per-item odds are in the hash too, after the fallback, and only when a season has them.
    const odds = { kDrops: [1, 2, 3, 4, 5], capBps: [10, 20, 30, 40, 50], excessDrops: [0, 0, 0, 0, 7] };
    assert.equal(seasonTermsHash({ ...t, emptyBand: "rows", nftOdds: undefined }), seasonTermsHash({ ...t, emptyBand: "rows" }));
    assert.notEqual(seasonTermsHash({ ...t, emptyBand: "rows", nftOdds: odds }), seasonTermsHash({ ...t, emptyBand: "rows" }));
    assert.notEqual(seasonTermsHash({ ...t, emptyBand: "rows", nftOdds: odds }), seasonTermsHash({ ...t, emptyBand: "rows", nftOdds: { ...odds, excessDrops: [0, 0, 0, 0, 8] } }));
  }));
  // The seasons themselves: 5-5 as it was anchored, 5-6 with its fallback in the hash.
  const t55 = { priceDrops: "4000000", bandBps: [...SEASON_5_5.bandBps], sellBps: SELL_BPS, prizeTable: seasonPlan(L55, null).prizeTable, tokens: [] };
  assert.equal(seasonTermsHash({ ...t55, ...(seasonPlan(L55, null).emptyBand ? { emptyBand: "rows" as const } : {}) }), oldTermsHash(t55));
  const plan56 = seasonPlan(L56, null);
  const t56 = { priceDrops: "4000000", bandBps: [...plan56.bandBps], sellBps: SELL_BPS, prizeTable: plan56.prizeTable, tokens: [] };
  assert.equal(plan56.emptyBand, "rows");
  assert.notEqual(seasonTermsHash({ ...t56, emptyBand: plan56.emptyBand }), seasonTermsHash(t56));
});

// ---------- Q2: cover

test("cover: one 5-6 place needs its top rung, 42 XRP, so 44 free with the site's 2 XRP floor; the kit's 52 / 94 / 136 are 42 / 84 / 126 plus its own 10 XRP floor, uncapped", () => {
  const cover = (n: number) => Number(xrpCoverFor(TABLE, L56.bandBps, n, "rows")) / 1e6;
  assert.deepEqual([1, 2, 3, 10].map(cover), [42, 84, 126, 420]);
  // Without the fallback the same table would ask no more for one place: one place can only ever need its own biggest prize.
  assert.equal(Number(xrpCoverFor(TABLE, L56.bandBps, 1)) / 1e6, 42);
  assert.deepEqual([1, 2, 3].map((n) => cover(n) + 10), [52, 94, 136]);
  // $10's table tops out at 42 too: a place held there asks its own 42 of the same treasury.
  assert.equal(Number(xrpCoverFor(prizeTableFor(NFT_LADDERS[10].tokenPrizes, false), NFT_LADDERS[10].bandBps, 1)) / 1e6, 42);
});

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const THIRD = "rTHIRDthirdTHIRDthirdTHIRDthird";

/** The site as it runs: SEAL off, 2 XRP floor, one cover place. `stock` says how many of each 5-6 band's NFTs go in; null opens 5-5 on its old bands instead. */
async function shop(opts: { treasuryXrp?: number; stock?: readonly number[] | null; dear?: boolean; ten?: boolean; salt?: string } = {}) {
  const ledger = testLedger(`copper-audit-${opts.salt ?? "a"}`, 0);
  ledger.fund(TREASURY, opts.treasuryXrp ?? 1000);
  ledger.fund(VAULT, 100);
  for (const w of [PLAYER, OTHER, THIRD]) ledger.fund(w, 5000);
  const store = memoryStore();
  let ids = 0;
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: `copper-audit-${opts.salt ?? "a"}`, expectedNetworkId: 0, shelf: [5, 10], newId: () => `ca-${++ids}`, treasuryFloorDrops: 2_000_000n, xrpCoverPlacesMax: 1 });
  const run = async (passes = 6) => {
    for (let i = 0; i < passes; i++) {
      await engine.advance();
      ledger.close();
      await engine.advance();
    }
  };
  const old = opts.stock === null;
  assert.ok(await engine.openSeason(5, "4000000", null, seasonPlan(old ? L55 : L56, null)));
  await run(2);
  const rows: Omit<Lot, "lot" | "price">[] = [];
  for (let b = 0; b < 5; b++) {
    // A thin band holds its cheapest NFTs, or its dearest with `dear`.
    const here = NFTS.filter((n) => (old ? n.band55 : n.band56) === b)
      .sort((x, y) => (opts.dear ? y.markXrp - x.markXrp : x.markXrp - y.markXrp))
      .slice(0, old ? undefined : (opts.stock ?? [15, 2, 22, 5, 4])[b]);
    for (const n of here) rows.push({ nftId: n.id, band: b, collection: n.collection, name: n.name, img: "", costDrops: String(xrp(n.markXrp)), markDrops: String(xrp(n.markXrp)) });
  }
  for (const r of rows) ledger.mintTo(r.nftId, VAULT);
  if (rows.length) assert.equal((await engine.changePool(5, rows)).ok, true);
  if (opts.ten) {
    assert.ok(await engine.openSeason(10, "8000000", null, seasonPlan(NFT_LADDERS[10], null)));
    const ten = [1, 2, 3, 4].map((band) => ({ nftId: `${"0008"}${String(band).padStart(60, "A")}`, band, collection: "Ten", name: `t${band}`, img: "", costDrops: "9000000", markDrops: "9000000" }));
    for (const r of ten) ledger.mintTo(r.nftId, VAULT);
    await run(2);
    assert.equal((await engine.changePool(10, ten)).ok, true);
  }
  await run(3);
  const pay = async (who: string, price: 5 | 10 = 5) => {
    const q = await engine.createOrder(who, price);
    assert.ok(q.ok, JSON.stringify(q));
    ledger.userSubmit(q.tx as never);
    return q.order.id;
  };
  return { ledger, store, engine, run, pay };
}

test("on the site's settings 5-6 opens with 44 XRP free and closes at 43; a paid pull in flight doesn't stop the next quote (the README says it waits); a $10 place held asks 42 more", async () => {
  const s = await shop({ ten: true });
  // closedPacks answers once per ledger and log position, so each look is on a ledger of its own.
  const free = async () => {
    s.ledger.close();
    return !(await s.engine.closedPacks(await s.ledger.chain.validatedLedger(), async () => null)).has(5);
  };
  s.ledger.setBalance(TREASURY, 44);
  assert.equal(await free(), true, "44 free: open");
  s.ledger.setBalance(TREASURY, 43);
  assert.equal(await free(), false, "43: closed");
  // One pull paid and not yet drawn, its entropy ledger still to close: another wallet can still quote, on the same one place of cover.
  s.ledger.setBalance(TREASURY, 44);
  const first = await s.pay(PLAYER);
  s.ledger.close();
  await s.engine.advance();
  assert.equal(s.engine.state.orders.get(first)!.status, "paid");
  const second = await s.engine.createOrder(OTHER, 5);
  assert.equal(second.ok, true, "a second quote doesn't wait for the first pull's draw");
  await s.run(6);
  // A $10 place held takes its own 42 from the same treasury: with 48 free the $5 pack closes until it lapses or draws.
  s.ledger.setBalance(TREASURY, 100);
  const ten = await s.engine.createOrder(THIRD, 10);
  assert.equal(ten.ok, true, JSON.stringify(ten));
  s.ledger.setBalance(TREASURY, 50);
  assert.equal(await free(), false, "50 XRP with a $10 place held: $5 needs 44 + 42");
});

test("BTS56-3, fixed: Common thinning never closes 5-6 on the sell-back line, kept cheapest first, dearest first or down to two dear ones, and nothing alerts", async () => {
  // Under one fair pick, keeping three cheap Commons closed it. Each NFT at its own odds, an NFT that leaves hands its share to the ladder.
  const ceiling = itemEconomics(L56, L56.nftOdds!, BANDED, SELL_BPS).ceilingShare;
  assert.ok(ceiling < MAX_SELL_BACK_SHARE);
  for (const order of ["cheap", "dear"] as const) {
    const common = [...BANDED[0]].sort((a, b) => (order === "cheap" ? a - b : b - a));
    for (let kept = 0; kept <= common.length; kept++) {
      const e = itemEconomics(L56, L56.nftOdds!, [common.slice(kept), ...BANDED.slice(1)], SELL_BPS);
      assert.ok(e.allSell <= ceiling + 1e-9, `${order} ${kept}: ${e.allSell}`);
    }
  }
  const dear = await shop({ stock: [2, 2, 22, 5, 4], dear: true, salt: "dear" });
  dear.ledger.close();
  assert.equal((await dear.engine.closedPacks(await dear.ledger.chain.validatedLedger(), async () => null)).has(5), false, "two dear Commons left: still open");
  assert.ok(!(await dear.engine.opsAlerts()).some((a) => a.code === "sell_line"));
  // With Common empty, its ladder takes the whole band, the pack sells, and nothing is said.
  const bare = await shop({ stock: [0, 2, 22, 5, 4], salt: "bare" });
  bare.ledger.close();
  assert.equal((await bare.engine.closedPacks(await bare.ledger.chain.validatedLedger(), async () => null)).has(5), false);
  assert.ok(!(await bare.engine.opsAlerts()).some((a) => a.code === "sell_line"));
});

// ---------- Q1 and Q3: the fallback on the ledger, replayed, and forgeries refused

/** Swap in `replace` for the events from `at` (dropping `drop` of them), reseal everything after so the chain holds, and replay. */
function rewrite(log: readonly RipEvent[], at: number, drop: number, replace: readonly RipEventBody[]) {
  const head = log.slice(0, at);
  const tail = [...replace, ...log.slice(at + drop).map((e) => ({ type: e.type, data: e.data }) as RipEventBody)];
  const resealed = sealEvents(at ? log[at - 1].seq : 0, at ? log[at - 1].hash : "0".repeat(64), tail, new Date(0).toISOString());
  return replayLog([...head, ...resealed]);
}

test("5-6 on the ledger with thin bands: ladder prizes and NFTs replay and check against the chain; a refund, a made-up NFT, a rung where the roll gave an NFT, and a swapped draw order are all refused", async () => {
  // Common with its 3 cheapest NFTs, the likeliest at their own odds, so it gives NFTs; Uncommon empty, so every Uncommon pull pays its ladder.
  const s = await shop({ stock: [3, 0, 22, 5, 4], salt: "thin" });
  for (let i = 0; i < 14; i++) {
    await s.pay(i % 2 ? PLAYER : OTHER);
    await s.run(5);
  }
  // Two pulls paid in one ledger and drawn in one pass.
  await s.pay(PLAYER);
  await s.pay(OTHER);
  await s.run(6);
  const log = await s.store.readFrom(0);
  const ok = replayLog(log);
  assert.ok(ok.ok, JSON.stringify(ok));
  const chain = await verifyAgainstChain(log, s.ledger.chain, TREASURY, 1);
  assert.ok(chain.ok, JSON.stringify(chain));
  const season = s.engine.state.seasons.get("5-1")!;
  assert.equal(season.emptyBand, "rows");
  const draws = log.map((e, i) => [e, i] as const).filter(([e]) => e.type === "pull_drawn" || e.type === "pull_prize_drawn");
  assert.ok(season.nftOdds, "5-6 draws each NFT at its own odds");
  const fallbackAt = draws.find(([e]) => e.type === "pull_prize_drawn" && e.data.band === 1)?.[1];
  const nftAt = draws.find(([e]) => e.type === "pull_drawn")?.[1];
  assert.ok(fallbackAt !== undefined, "a pull landed on the empty Uncommon and was paid its ladder");
  assert.ok(nftAt !== undefined, "a pull landed an NFT");
  const fb = log[fallbackAt].data as Extract<RipEvent, { type: "pull_prize_drawn" }>["data"];
  const o = s.engine.state.orders.get(fb.order)!;

  // A refund where the season's rows pay.
  const refund = rewrite(log, fallbackAt, 1, [{ type: "pull_refund_due", data: { id: `pull:${fb.order}`, order: fb.order, seed: fb.seed, ledgerHash: fb.ledgerHash, digest: fb.digest, band: fb.band, reason: "band_empty", to: o.address, drops: o.drops } }]);
  assert.equal(refund.ok, false);
  assert.match((refund as { why: string }).why, /rows pay/);

  // An NFT out of an empty band: refused by name, not by an exception in the pick.
  // Uncommon holds none, so any lot in the vault stands in for the made-up one.
  const lot = [...s.engine.state.lots.values()].find((l) => l.price === 5)!;
  const made = rewrite(log, fallbackAt, 1, [{ type: "pull_drawn", data: { order: fb.order, season: fb.season, index: fb.index, seed: fb.seed, txHash: fb.txHash, ledgerHash: fb.ledgerHash, entropyLedger: fb.entropyLedger, address: fb.address, digest: fb.digest, band: fb.band, poolSize: 0, pick: 0, lot: lot.lot, nftId: lot.nftId } }]);
  assert.equal(made.ok, false);
  assert.match((made as { why: string }).why, /empty band/);

  // A rung where the roll gave an NFT.
  const nd = log[nftAt].data as Extract<RipEvent, { type: "pull_drawn" }>["data"];
  const rung = fallbackRowOf(nd.digest, season.prizeTable, nd.band)!;
  const swapped = rewrite(log, nftAt, 1, [{ type: "pull_prize_drawn", data: { order: nd.order, season: nd.season, index: nd.index, seed: nd.seed, txHash: nd.txHash, ledgerHash: nd.ledgerHash, entropyLedger: nd.entropyLedger, address: nd.address, digest: nd.digest, band: nd.band, valueDrops: rung.valueDrops, token: "XRP", amount: rung.valueDrops, reads: null } }]);
  assert.equal(swapped.ok, false);
  assert.match((swapped as { why: string }).why, /doesn't reproduce/);

  // The last two pulls, paid in one ledger, drawn the other way round: who drew first would decide who got an NFT and who a rung.
  const lastTwo = draws.slice(-2).map(([, i]) => i);
  assert.equal(lastTwo[1], lastTwo[0] + 1);
  const reordered = rewrite(log, lastTwo[0], 2, [log[lastTwo[1]], log[lastTwo[0]]].map((e) => ({ type: e.type, data: e.data }) as RipEventBody));
  assert.equal(reordered.ok, false);
  assert.match((reordered as { why: string }).why, /ahead of one paid before it/);

  // Taking the fallback out of the season's terms: its prizes stop replaying, and its anchor no longer holds its terms.
  const openAt = log.findIndex((e) => e.type === "season_open");
  const { emptyBand: _gone, ...bare } = log[openAt].data as Extract<RipEvent, { type: "season_open" }>["data"];
  const stripped = rewrite(log, openAt, 1, [{ type: "season_open", data: bare }]);
  assert.equal(stripped.ok, false);
});

// ---------- Q4: the owner's command order

test("a season can't open while a pool change for its pack is still on its way to the ledger: the change goes first, so 5-6 never sells on 5-5's bands", async () => {
  const s = await shop({ stock: null, salt: "order" });
  const moves = rebandMoves(s.engine.state.lots.values(), 5);
  assert.equal(moves.length, 19);
  assert.equal((await s.engine.changePool(5, [], moves.map((m) => m.lot.lot))).ok, true);
  // Committed, not anchored: the next anchor out would be a new season's, ahead of this change's.
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), null);
  await s.run(3);
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), "5-2");
  // A rerun before it's live waits for it, instead of opening 5-3 behind it.
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), null);
  await s.run(3);
  const live = s.engine.state.seasons.get("5-2")!;
  assert.equal([...s.engine.state.seasons.keys()].filter((k) => k.startsWith("5-")).length, 2);
  assert.equal(live.live, true);
  // A 5-6 payment lands after its anchor's ledger, and every mover was out of its old band from then on: no 5-6 pull can draw one there.
  for (const m of moves) {
    const l = s.engine.state.lots.get(m.lot.lot)!;
    assert.ok(l.removeLedger !== null && l.removeLedger <= (live.anchorLedger as number) + 1, `${m.lot.name}`);
  }
});

test("a paid 5-5 pull holds the switch until it draws, and the quote before it too", async () => {
  const s = await shop({ stock: null, salt: "held" });
  const id = await s.pay(PLAYER);
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), null, "quoted");
  s.ledger.close();
  await s.engine.advance();
  assert.equal(s.engine.state.orders.get(id)!.status, "paid");
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), null, "paid, not drawn");
  await s.run(6);
  assert.equal(s.engine.state.orders.get(id)!.status, "drawn");
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), "5-2");
});

test("reband reads its progress from the log, not its file: a run that stopped before the removal, a removal not yet on the ledger, and the way back", async () => {
  const s = await shop({ stock: null, salt: "reband" });
  assert.equal(bandsTile(5), true);
  assert.equal(bandsTile(10), false, "$10's ranges leave gaps: a reband there would empty them");
  const moves = rebandMoves(s.engine.state.lots.values(), 5);
  const file: RebandFile = { price: 5, removes: moves.map((m) => m.lot.nftId), adds: moves.filter((m) => m.to !== null).map(({ lot: l, to }) => ({ nftId: l.nftId, band: to!, collection: l.collection, name: l.name, img: l.img, costDrops: l.costDrops, markDrops: l.markDrops })) };
  assert.equal(file.adds.length, 18);
  // Saved, then stopped before the removal reached the log: nothing is out, and the file mustn't be taken at its word.
  let p = rebandProgress(s.engine.state, file);
  assert.equal(p.out.length, 19);
  assert.equal(p.back.length, 0);
  // The removal is in the log and not yet on the ledger.
  assert.equal((await s.engine.changePool(5, [], p.out.map((l) => l.lot))).ok, true);
  p = rebandProgress(s.engine.state, file);
  assert.equal(p.out.length, 0);
  assert.equal(p.back.length, 18, "on its way out is not back");
  // What the worker's script asked: every one of them reads as already in a pool, so it said "Done" and deleted the list.
  assert.equal(file.adds.filter((r) => !inPoolAlready(s.engine.state, r.nftId)).length, 0);
  assert.equal(leavingLots(s.engine.state).size, 19);
  assert.deepEqual(rebandMoves(s.engine.state.lots.values(), 5, undefined, leavingLots(s.engine.state)), [], "a second reband doesn't take them out twice");
  await s.run(3);
  assert.equal(rebandProgress(s.engine.state, file).back.length, 18);
  assert.equal(await s.engine.openSeason(5, "4000000", null, seasonPlan(L56, null)), "5-2");
  await s.run(3);
  assert.equal((await s.engine.changePool(5, rebandProgress(s.engine.state, file).back)).ok, true);
  // In the log, on its way in: done, and nothing out of place.
  p = rebandProgress(s.engine.state, file);
  assert.deepEqual([p.out.length, p.back.length], [0, 0]);
  await s.run(3);
  assert.deepEqual(rebandMoves(s.engine.state.lots.values(), 5), []);
  const banded = [0, 1, 2, 3, 4].map((b) => [...s.engine.state.lots.values()].filter((l) => l.band === b && l.status === "available" && l.removeLedger === null).length);
  assert.deepEqual(banded, [15, 2, 22, 5, 4]);
  const share = sellBackShare(s.engine.state, s.engine.state.seasons.get("5-2")!, await s.ledger.chain.validatedLedger());
  close(share, 1 - 0.064, 0.0005, "the 5-6 pool's sell share once it's back");
  assert.ok(replayLog(await s.store.readFrom(0)).ok);
});
