import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS } from "../src/config/nft-packs.ts";
import { ITEM_SCALE, bandOf, itemBandValue, itemPick, itemWeights, ladderAverageDrops, seasonTermsHash, sha256Hex, type ItemOdds } from "../src/lib/rip/draw.ts";
import { MAX_SELL_BACK_SHARE, SELL_BPS, createEngine, sellBackShare } from "../src/lib/rip/engine.ts";
import { bandOfValue, itemEconomics } from "../src/lib/rip/rarity-spec.ts";
import { buyThinsBand } from "../src/lib/rip/restock.ts";
import { emptyState, poolAt, type LotState, type SeasonState } from "../src/lib/rip/state.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { prizeTableFor, seasonPlan } from "../src/lib/rip/tokens.ts";
import type { Lot } from "../src/lib/rip/types.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { poolView } from "../src/lib/rip/views.ts";
import { TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

/**
 * AU-BTS re-audit of season 5-6 on per-item NFT odds (feat/seal-rips-copper-slots at 0173857a7), 2026-11-05: the ceiling attacked, the weights'
 * determinism, the gate against the draw's pool, Chase's refunds, the committed shape, and what a dear restock does. Report:
 * audit/2026-11-05-copper-5-6-nemesis.md, second part. Internal: margins and returns here are never shown to a player.
 */
const POOL = JSON.parse(readFileSync(new URL("./fixtures/pool-5-20261105.json", import.meta.url), "utf8")) as { bands: { nfts: { id: string; collection: string; name: string; markXrp: number }[] }[] };
const P = 4;
const L56 = NFT_LADDERS[5];
const ODDS = L56.nftOdds!;
const TABLE = prizeTableFor(L56.tokenPrizes, false);
const NFTS = POOL.bands.flatMap((b) => b.nfts.map((n) => ({ ...n, band: bandOfValue(P, n.markXrp) })));
const BANDED = [0, 1, 2, 3, 4].map((b) => NFTS.filter((n) => n.band === b).map((n) => n.markXrp));
const CEILING = itemEconomics(L56, ODDS, BANDED, SELL_BPS).ceilingShare;
const drops = (xrp: number) => Math.round(xrp * 1e6);

/** 5-6 over these pools, as the engine holds lots and seasons: lots sorted the way the draw sorts them, by NFT id. */
function share(marks: readonly (readonly number[])[], odds: ItemOdds = ODDS) {
  const s = emptyState();
  let n = 0;
  marks.forEach((ms, band) => {
    for (const m of ms) {
      n++;
      const lot: LotState = { lot: `lot-${n}`, nftId: n.toString(16).padStart(64, "0"), price: 5, band, collection: "c", name: `n${n}`, img: "", costDrops: String(m), markDrops: String(m), status: "available", addLedger: 1, removeLedger: null, awardedTo: null };
      s.lots.set(lot.lot, lot);
      s.nftLot.set(lot.nftId, lot.lot);
    }
  });
  const season: SeasonState = { season: "5-6", price: 5, priceDrops: "4000000", bandBps: [...L56.bandBps], commit: "0".repeat(64), length: 20_000, sellBps: SELL_BPS, usdAtOpen: null, prizeTable: TABLE, tokens: [], emptyBand: "rows", nftOdds: odds, live: true, anchorTx: null, anchorLedger: null, nextIndex: 0 };
  return sellBackShare(s, season, 10);
}
/** The floor's slack: each NFT's weight rounds down by under one part, which in a band of n can add at most n parts of its ladder per band pull. */
const slack = (marks: readonly (readonly number[])[]) => marks.reduce((a, ms, b) => a + ((L56.bandBps[b] / 10_000) * ms.length * ladderAverageDrops(TABLE, b, 4_000_000)) / ITEM_SCALE, 0) / 4_000_000;

// ---------- The ceiling, attacked

test("property: no pool at all, any count of NFTs at any mark from 1 drop to a million XRP in any band, sells back over 5-6's ceiling or the 95% line", () => {
  const mark = fc.oneof(fc.integer({ min: 1, max: 1_000 }), fc.integer({ min: 1_000_000, max: 300_000_000 }), fc.integer({ min: 1, max: 1_000_000_000_000 }));
  const pool = fc.array(fc.array(mark, { maxLength: 60, size: "max" }), { minLength: 5, maxLength: 5 });
  fc.assert(fc.property(pool, (marks) => {
    const s = share(marks);
    assert.ok(s <= CEILING + slack(marks) + 1e-12, `${s} over ${CEILING}`);
    assert.ok(s < MAX_SELL_BACK_SHARE);
  }), { numRuns: 400 });
});

test("a greedy attacker adding and removing NFTs one at a time, always the move that raises the share most, tops out at the ceiling and no higher", () => {
  // Candidates: every mark in the pool, the edges of every band, and marks far outside any band.
  const candidates = [...new Set([...BANDED.flat(), 0.000001, 0.5, 1, 2, 2.2, 4.79, 4.8, 5.3, 5.37, 5.4, 7.4, 7.5, 8.79, 8.8, 10.12, 10.13, 19.99, 20, 24.1, 24.2, 79.99, 80, 96, 500, 1e6].map(drops))];
  let pool = BANDED.map((b) => b.map(drops));
  let best = share(pool);
  for (let step = 0; step < 60; step++) {
    let move: number[][] | null = null;
    let top = best;
    for (let b = 0; b < 5; b++) {
      for (const c of candidates) {
        const trial = pool.map((x, i) => (i === b ? [...x, c] : x));
        const s = share(trial);
        if (s > top) [top, move] = [s, trial];
      }
      for (let i = 0; i < pool[b].length; i++) {
        const trial = pool.map((x, j) => (j === b ? x.filter((_, k) => k !== i) : x));
        const s = share(trial);
        if (s > top) [top, move] = [s, trial];
      }
    }
    if (!move) break;
    pool = move;
    best = top;
  }
  assert.ok(best <= CEILING + slack(pool) + 1e-12, `${best} over ${CEILING}`);
  assert.ok(Math.abs(best - CEILING) < 1e-4, `the attacker reaches the ceiling (${best}), and that's where it stops`);
  assert.ok(Math.abs(CEILING - 0.93661) < 1e-5);
});

test("the gate's pool and the draw's pool differ only by lots on their way out: whichever a pull meets, it pays under the ceiling", () => {
  fc.assert(fc.property(fc.array(fc.array(fc.integer({ min: 1, max: 400 }).map((x) => x * 500_000), { maxLength: 30 }), { minLength: 5, maxLength: 5 }), fc.array(fc.nat(), { maxLength: 10 }), (marks, leave) => {
    // The draw sees everything with a removal not yet in force; the gate leaves those out. Both are pools like any other.
    const gate = marks.map((ms, b) => ms.filter((_, i) => !leave.includes(b * 100 + i)));
    for (const pool of [marks, gate]) assert.ok(share(pool) <= CEILING + slack(pool) + 1e-12);
  }), { numRuns: 200 });
});

// ---------- The weights: determinism and the floor

test("property: an NFT's weight depends only on the committed odds and the marks in draw order, not on how a mark is written; the floor costs under one part per NFT", () => {
  const marksArb = fc.array(fc.integer({ min: 1, max: 2_000_000_000 }), { maxLength: 40 });
  fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), marksArb, (band, marks) => {
    const asNumber = itemWeights(ODDS, TABLE, band, marks, SELL_BPS, "4000000");
    // The engine and /fair pass the log's strings, the sell-back line passes bigints for what's coming: every form gives the same parts.
    assert.deepEqual(itemWeights(ODDS, TABLE, band, marks.map(String), SELL_BPS, "4000000"), asNumber);
    assert.deepEqual(itemWeights(ODDS, TABLE, band, marks.map((m) => BigInt(m)), SELL_BPS, 4_000_000), asNumber);
    // Exactly reproducible: the same inputs, the same parts, every time (only + - x / floor and min, which every JavaScript engine rounds alike).
    assert.deepEqual(itemWeights(ODDS, TABLE, band, [...marks], SELL_BPS, "4000000"), asNumber);
    // Each weight is its unrounded share, scaled down by the band's one factor, less under one part.
    const k = ODDS.kDrops[band];
    const raw = marks.map((m) => k / m);
    const sum = raw.reduce((a, x) => a + x, 0);
    const ladder = ladderAverageDrops(TABLE, band, 4_000_000);
    const excess = raw.reduce((a, x, i) => a + x * ((SELL_BPS * marks[i]) / 10_000 - ladder), 0);
    const cap = ODDS.capBps[band] / 10_000;
    const most = ODDS.excessDrops[band];
    const lambda = Math.min(1, sum > cap ? cap / sum : 1, excess > most ? (most > 0 ? most / excess : 0) : 1);
    asNumber.forEach((w, i) => {
      const exact = lambda * raw[i] * ITEM_SCALE;
      assert.ok(w <= exact + 1e-6 && w > exact - 1 - 1e-6, `${w} vs ${exact}`);
    });
  }), { numRuns: 300 });
});

test("the item roll's NFT share and Chase's refund share land where the weights say, over 200,000 digests", () => {
  // Chase with its cheapest NFT kept: that NFT's share now gives the pull's XRP back.
  const chase = [...BANDED[4]].sort((a, b) => a - b).slice(1).map(drops);
  const w = itemWeights(ODDS, TABLE, 4, chase, SELL_BPS, 4_000_000);
  const left = 1 - w.reduce((a, x) => a + x, 0) / ITEM_SCALE;
  assert.ok(Math.abs(left - 0.312) < 0.001, String(left));
  let refunds = 0;
  const N = 200_000;
  for (let i = 0; i < N; i++) if (itemPick(sha256Hex(`chase-${i}`), w) === null) refunds++;
  assert.ok(Math.abs(refunds / N - left) < 0.004);
  // Per pull, that's the Chase rate times it, which the pool page quotes.
  assert.ok(Math.abs((L56.bandBps[4] / 10_000) * left - 0.00053) < 0.00001);
  // A band roll lands on Chase at its committed rate however Chase is stocked: the band roll reads only the rates.
  let chaseHits = 0;
  for (let i = 0; i < N; i++) if (bandOf(sha256Hex(`band-${i}`), L56.bandBps) === 4) chaseHits++;
  assert.ok(Math.abs(chaseHits / N - 0.0017) < 0.0004);
});

// ---------- What a season commits

test("the hash commits to every per-item number; the replay checks only the odds' shape, so the ceiling is 5-6's numbers', and the 95% line still stands behind any others", () => {
  const base = { priceDrops: "4000000", bandBps: [...L56.bandBps], sellBps: SELL_BPS, prizeTable: TABLE, tokens: [], emptyBand: "rows" as const };
  const h = seasonTermsHash({ ...base, nftOdds: ODDS });
  for (const key of ["kDrops", "capBps", "excessDrops"] as const) {
    for (let b = 0; b < 5; b++) {
      const changed = { ...ODDS, [key]: ODDS[key].map((x, i) => (i === b ? x + 1 : x)) };
      assert.notEqual(seasonTermsHash({ ...base, nftOdds: changed }), h, `${key}[${b}]`);
    }
  }
  // Numbers far looser than 5-6's: a ceiling over the line. The engine's line closes the pack on the pool, whatever the season committed.
  const loose: ItemOdds = { ...ODDS, excessDrops: ODDS.excessDrops.map((x) => x + 20_000_000) };
  const looseCeiling = itemEconomics(L56, loose, BANDED, SELL_BPS).ceilingShare;
  assert.ok(looseCeiling > MAX_SELL_BACK_SHARE);
  // A pool that reaches past the line on those numbers: every band full of dear NFTs.
  const dear = [Array(40).fill(4.7), Array(40).fill(8.7), Array(40).fill(19.9), Array(40).fill(79), Array(10).fill(400)].map((b: number[]) => b.map(drops));
  assert.ok(share(dear, loose) > MAX_SELL_BACK_SHARE, "so a season cut like that would close on the line, the house's backstop");
  assert.ok(share(dear) <= CEILING + slack(dear), "5-6's own numbers hold it under");
});

// ---------- A dear restock

test("a dear NFT scales its band's NFTs down together, on Uncommon to 0%: the buyer now passes on such a buy, and the owner is told when one is in a pool", async () => {
  const unc = [5_000_000, 5_079_450];
  const total = (marks: readonly number[]) => itemWeights(ODDS, TABLE, 1, marks, SELL_BPS, 4_000_000).reduce((a, w) => a + w, 0);
  assert.ok(total([...unc, 7_400_000]) > 0);
  assert.equal(total([...unc, 7_500_000]), 0, "Uncommon commits no excess: one at 7.5 XRP takes all three to 0%");
  const season = { nftOdds: ODDS, prizeTable: TABLE, sellBps: SELL_BPS, priceDrops: "4000000" };
  assert.equal(buyThinsBand(season, 1, unc.map(String), 7_500_000n), true);
  assert.equal(buyThinsBand(season, 1, ["5000000"], 5_500_000n), false, "with one kept, a cheap one adds odds");
  // Common full: a 4.7 XRP Common scales all sixteen down (45.6% to 41.0%); with three cheap ones kept, a 2.1 XRP one adds odds.
  const common = BANDED[0].map((m) => String(drops(m)));
  assert.equal(buyThinsBand(season, 0, common, 4_700_000n), true);
  const sorted = [...BANDED[0]].sort((a, b) => a - b).slice(3).map((m) => String(drops(m)));
  assert.equal(buyThinsBand(season, 0, sorted, 2_100_000n), false);
  assert.equal(buyThinsBand({ ...season, nftOdds: undefined }, 1, unc.map(String), 8_000_000n), false, "seasons before 5-6 aren't asked");

  // On the ledger: a person registers an 8 XRP Uncommon by hand; the pool page shows its band at 0% and the owner hears of it.
  const ledger = testLedger("copper-audit2", 0);
  ledger.fund(TREASURY, 1000);
  ledger.fund(VAULT, 100);
  let ids = 0;
  const store = memoryStore();
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "copper-audit2", expectedNetworkId: 0, shelf: [5], newId: () => `c2-${++ids}`, treasuryFloorDrops: 2_000_000n, xrpCoverPlacesMax: 1 });
  const run = async (passes = 3) => {
    for (let i = 0; i < passes; i++) {
      await engine.advance();
      ledger.close();
      await engine.advance();
    }
  };
  assert.ok(await engine.openSeason(5, "4000000", null, seasonPlan(L56, null)));
  await run(2);
  const rows: Omit<Lot, "lot" | "price">[] = NFTS.filter((n) => n.band !== null).map((n) => ({ nftId: n.id, band: n.band as number, collection: n.collection, name: n.name, img: "", costDrops: String(drops(n.markXrp)), markDrops: String(drops(n.markXrp)) }));
  const dearOne = { nftId: `0008${"D".repeat(60)}`, band: 1, collection: "King", name: "dear", img: "", costDrops: "8000000", markDrops: "8000000" };
  for (const r of [...rows, dearOne]) ledger.mintTo(r.nftId, VAULT);
  assert.equal((await engine.changePool(5, rows)).ok, true);
  await run();
  assert.ok(!(await engine.opsAlerts()).some((a) => a.code === "nft_odds_zero"));
  // A full Chase leaves only the draw's rounding to refunds: under a ten-thousandth of a percent, which the pool page doesn't quote as "0% of pulls".
  const fullChase = (poolView(engine.state, 5)!.bands[4] as { refundPct?: number }).refundPct ?? 0;
  assert.ok(fullChase > 0 && Number(fullChase.toFixed(4)) === 0, String(fullChase));
  assert.equal((await engine.changePool(5, [dearOne])).ok, true);
  await run();
  const view = poolView(engine.state, 5)!;
  assert.equal(view.bands[1].nftPct, 0);
  assert.ok(view.bands[1].nfts.every((n) => n.pct === 0));
  const alert = (await engine.opsAlerts()).find((a) => a.code === "nft_odds_zero");
  assert.ok(alert && alert.text.includes("$5 Uncommon"), JSON.stringify(alert));
  // Still under the ceiling, and the pack still sells: this costs players their Uncommon NFTs, not the house.
  const s = engine.state.seasons.get("5-1")!;
  assert.ok(sellBackShare(engine.state, s, await ledger.chain.validatedLedger()) <= CEILING + 1e-6);
  assert.equal(poolAt(engine.state, 5, 1, await ledger.chain.validatedLedger()).length, 3);
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("the band value per-item odds pay is the draw's own: itemBandValue is the item roll's NFTs at a sale's value and the ladder for the rest", () => {
  const marks = BANDED[2].map(drops);
  const w = itemWeights(ODDS, TABLE, 2, marks, SELL_BPS, 4_000_000);
  const left = 1 - w.reduce((a, x) => a + x, 0) / ITEM_SCALE;
  const byHand = w.reduce((a, x, i) => a + (x / ITEM_SCALE) * marks[i] * (SELL_BPS / 10_000), 0) + left * ladderAverageDrops(TABLE, 2, 4_000_000);
  assert.ok(Math.abs(itemBandValue(ODDS, TABLE, 2, marks, SELL_BPS, 4_000_000) - byHand) < 1e-6);
});
