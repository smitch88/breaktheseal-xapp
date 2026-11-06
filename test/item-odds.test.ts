import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SEASON_5_5 } from "../src/config/nft-packs.ts";
import { ITEM_SCALE, fallbackRowOf, itemBandValue, itemPick, itemWeights, ladderAverageDrops, sha256Hex, stockCovers, type ItemOdds, type PrizeRow } from "../src/lib/rip/draw.ts";
import { MAX_SELL_BACK_SHARE, SELL_BPS, createEngine, sellBackShare } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { RARITY_SPEC, bandOfValue, itemEconomics, oddsFor, valueRanges } from "../src/lib/rip/rarity-spec.ts";
import { emptyState, type LotState, type SeasonState } from "../src/lib/rip/state.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { prizeTableFor, seasonPlan } from "../src/lib/rip/tokens.ts";
import type { Lot, RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { poolView } from "../src/lib/rip/views.ts";
import { TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

/**
 * Per-item NFT odds (owner, 2026-11-05: "Common nfts held shouldn't close the pack"). Each NFT takes its own share of its band, k / its mark; what the
 * pool's NFTs don't take pays the band's ladder, or in a band with no rows (Chase) gives the pull's XRP back; and a band's NFTs scale down together
 * so they never take more than its cap nor add more than its committed excess. So no pool, however it got there, sells back over the 5-6 ceiling,
 * which is under the 95% line. Internal: what a pack returns is never shown to a player.
 */
const POOL = JSON.parse(readFileSync(new URL("./fixtures/pool-5-20261105.json", import.meta.url), "utf8")) as { bands: { nfts: { markXrp: number }[] }[] };
const P = 4;
const L56 = NFT_LADDERS[5];
const ODDS = L56.nftOdds!;
const TABLE = prizeTableFor(L56.tokenPrizes, false);
const BANDED = [0, 1, 2, 3, 4].map((b) => POOL.bands.flatMap((x) => x.nfts.map((n) => n.markXrp)).filter((m) => bandOfValue(P, m) === b));
const drops = (xrp: number) => Math.round(xrp * 1e6);
const CEILING = itemEconomics(L56, ODDS, BANDED, SELL_BPS).ceilingShare;

// ---------- The weights

const oddsArb = fc.record({
  k: fc.integer({ min: 1, max: 10_000_000 }),
  cap: fc.integer({ min: 0, max: 10_000 }),
  excess: fc.integer({ min: 0, max: 50_000_000 }),
});
const rowsArb = fc.array(fc.record({ bps: fc.integer({ min: 1, max: 5_000 }), xrp: fc.integer({ min: 1, max: 60 }) }), { maxLength: 5 });
const marksArb = fc.array(fc.integer({ min: 1, max: 400 }).map((x) => x * 500_000), { maxLength: 40 });

test("each NFT's share is k / its mark, scaled down together: never over the cap, never adding more than the excess, every NFT worth the same per pull", () => {
  fc.assert(fc.property(oddsArb, rowsArb, marksArb, ({ k, cap, excess }, rows, marks) => {
    const odds: ItemOdds = { kDrops: [k, 0, 0, 0, 0], capBps: [cap, 0, 0, 0, 0], excessDrops: [excess, 0, 0, 0, 0] };
    const table: PrizeRow[] = rows.map((r) => ({ band: 0, token: "XRP", bps: r.bps, valueDrops: String(r.xrp * 1_000_000) }));
    const w = itemWeights(odds, table, 0, marks, SELL_BPS, 4_000_000);
    const sum = w.reduce((a, x) => a + x, 0);
    assert.ok(w.every((x) => Number.isInteger(x) && x >= 0));
    assert.ok(sum <= (cap / 10_000) * ITEM_SCALE + 1e-6, "over the cap");
    // Equal value per pull: share x mark is the same for every NFT, to within the floor of one part.
    const values = w.map((x, i) => x * marks[i]);
    if (values.length) assert.ok(Math.max(...values) - Math.min(...values) <= Math.max(...marks) + 1e-6);
    // Never more than the ladder plus the excess, give or take one part per NFT of the floor.
    const ladder = ladderAverageDrops(table, 0, 4_000_000);
    const value = itemBandValue(odds, table, 0, marks, SELL_BPS, 4_000_000);
    assert.ok(value <= ladder + excess + (marks.length * ladder) / ITEM_SCALE + 1e-6, `${value} > ${ladder} + ${excess}`);
  }));
});

test("the item roll lands each NFT at its share and the ladder at the rest, and a band whose NFTs are gone always lands on the ladder", () => {
  const w = itemWeights(ODDS, TABLE, 0, BANDED[0].map(drops), SELL_BPS, 4_000_000);
  const N = 60_000;
  let ladder = 0;
  const hits = w.map(() => 0);
  for (let i = 0; i < N; i++) {
    const at = itemPick(sha256Hex(`item-${i}`), w);
    if (at === null) ladder++;
    else hits[at]++;
  }
  const share = w.reduce((a, x) => a + x, 0) / ITEM_SCALE;
  assert.ok(Math.abs(share - 0.456) < 1e-6, String(share));
  assert.ok(Math.abs(ladder / N - (1 - share)) < 0.01);
  // The cheapest NFT is the likeliest, in proportion to 1 / its mark.
  const cheapest = BANDED[0].indexOf(Math.min(...BANDED[0]));
  assert.ok(Math.abs(hits[cheapest] / N - w[cheapest] / ITEM_SCALE) < 0.006);
  for (let i = 0; i < 200; i++) assert.equal(itemPick(sha256Hex(`empty-${i}`), []), null);
});

// ---------- The proof: no pool sells back over the line

/** A state with these marks in a $5 pool, the way the engine keeps lots, and 5-6 as its season. */
function stateOf(marks: readonly (readonly number[])[]) {
  const s = emptyState();
  let n = 0;
  marks.forEach((ms, band) => {
    for (const m of ms) {
      n++;
      const lot: LotState = { lot: `lot-${n}`, nftId: n.toString(16).padStart(64, "0"), price: 5, band, collection: "c", name: `n${n}`, img: "", costDrops: String(drops(m)), markDrops: String(drops(m)), status: "available", addLedger: 1, removeLedger: null, awardedTo: null };
      s.lots.set(lot.lot, lot);
      s.nftLot.set(lot.nftId, lot.lot);
    }
  });
  const season: SeasonState = { season: "5-6", price: 5, priceDrops: "4000000", bandBps: [...L56.bandBps], commit: "0".repeat(64), length: 20_000, sellBps: SELL_BPS, usdAtOpen: null, prizeTable: TABLE, tokens: [], emptyBand: "rows", nftOdds: ODDS, live: true, anchorTx: null, anchorLedger: null, nextIndex: 0 };
  return { s, season, share: sellBackShare(s, season, 10) };
}

test("5-6's committed ceiling is under the 95% line, and the full pool sells back at 93.60%: the 6.4% margin", () => {
  assert.equal(RARITY_SPEC.gate, MAX_SELL_BACK_SHARE);
  assert.ok(CEILING < MAX_SELL_BACK_SHARE, String(CEILING));
  assert.ok(Math.abs(CEILING - 0.93661) < 0.00001, String(CEILING));
  const full = stateOf(BANDED).share;
  assert.ok(Math.abs(full - 0.936) < 0.00005, String(full));
});

/** An operation on the pool: an NFT kept or taken out (by its place among what's left), a sold-back one back in, or a restock at any value inside the band. */
const op = fc.oneof(
  fc.record({ kind: fc.constant("out" as const), band: fc.integer({ min: 0, max: 4 }), at: fc.nat() }),
  fc.record({ kind: fc.constant("back" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("restock" as const), band: fc.integer({ min: 0, max: 4 }), where: fc.double({ min: 0, max: 0.999, noNaN: true }) }),
);

test("property: no sequence of NFTs kept, taken out, sold back or restocked, in any band, takes 5-6 over its ceiling or the 95% line; only an empty Chase pauses it", () => {
  const ranges = valueRanges(P);
  fc.assert(fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
    const pool = BANDED.map((b) => [...b]);
    const out: { band: number; mark: number }[] = [];
    for (const o of ops) {
      if (o.kind === "out" && pool[o.band].length) {
        const [mark] = pool[o.band].splice(o.at % pool[o.band].length, 1);
        out.push({ band: o.band, mark });
      } else if (o.kind === "back" && out.length) {
        const [x] = out.splice(o.at % out.length, 1);
        pool[x.band].push(x.mark);
      } else if (o.kind === "restock") {
        const [lo, hi] = ranges[o.band];
        const top = hi ?? 250;
        pool[o.band].push(Math.round((lo + o.where * (top - lo)) * 1e6) / 1e6);
      }
      const { share } = stateOf(pool);
      assert.ok(share <= CEILING + 1e-9, `${share} over the ceiling ${CEILING}`);
      assert.ok(share < MAX_SELL_BACK_SHARE);
      // The stock rule: a band with a ladder never asks for NFTs; Chase, with none, pauses only when it's empty.
      const covers = stockCovers(pool.map((b) => b.length), 0, L56.bandBps, TABLE, L56.emptyBand);
      assert.equal(covers, pool[4].length > 0);
    }
  }), { numRuns: 300 });
});

test("the worst order there is: Common kept cheapest first, dearest first, or down to its single dearest NFT, never closes 5-6", () => {
  for (const order of ["cheap", "dear"] as const) {
    const common = [...BANDED[0]].sort((a, b) => (order === "cheap" ? a - b : b - a));
    while (common.length) {
      const pool = [common, ...BANDED.slice(1)];
      assert.ok(stateOf(pool).share <= CEILING + 1e-9);
      common.shift();
    }
  }
  // Common down to its single dearest NFT, every other band down to its single dearest too, and Chase to the Scroll alone.
  const dearest = BANDED.map((b) => [Math.max(...b)]);
  const share = stateOf(dearest).share;
  assert.ok(share <= CEILING + 1e-9 && share < MAX_SELL_BACK_SHARE, String(share));
});

// ---------- On the ledger: the draw, its refunds, its replay

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";

test("per-item draws on a ledger: NFTs at their own odds, the ladder for the rest, an emptied Chase slot gives the XRP back, and /fair replays it all", async () => {
  // Most pulls in a band with a ladder and three NFTs, a fifth in a band of twenty NFTs alone, at small values so the pack sits under the line and Chase is
  // hit often. The engine doesn't hold a table to the spec's value ranges; the cut does. The other bands pay one sure row and never draw.
  const ladder = {
    xrp: 4,
    bandBps: [0, 8000, 0, 0, 2000] as [number, number, number, number, number],
    tokenPrizes: [
      { band: 0, bps: 10_000, xrp: 2, dust: true as const },
      { band: 1, bps: 4000, xrp: 2 },
      { band: 1, bps: 1000, xrp: 2.5 },
      { band: 2, bps: 10_000, xrp: 2 },
      { band: 3, bps: 10_000, xrp: 2 },
    ],
  };
  const marks = [[], [2.5, 3, 3.5], [], [], Array.from({ length: 20 }, (_, i) => 3 + i * 0.05)];
  const odds = oddsFor(ladder, marks, SELL_BPS);
  assert.deepEqual(odds.capBps, [0, 5000, 0, 0, 10_000]);
  const ledger = testLedger("item-odds", 0);
  ledger.fund(TREASURY, 2000);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 5000);
  let ids = 0;
  const store = memoryStore();
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "item-odds", expectedNetworkId: 0, shelf: [5], newId: () => `io-${++ids}` });
  const run = async (passes = 6) => {
    for (let i = 0; i < passes; i++) {
      await engine.advance();
      ledger.close();
      await engine.advance();
    }
  };
  assert.equal(await engine.openSeason(5, "4000000", null, seasonPlan({ ...ladder, emptyBand: "rows", nftOdds: odds }, null)), "5-1");
  await run(2);
  const season = engine.state.seasons.get("5-1")!;
  assert.deepEqual(season.nftOdds, odds);
  const rows: Omit<Lot, "lot" | "price">[] = marks.flatMap((ms, band) => ms.map((m, i) => ({ nftId: `0008${String(band * 10 + i).padStart(60, "0")}`, band, collection: "c", name: `n${band}-${i}`, img: "", costDrops: String(drops(m)), markDrops: String(drops(m)) })));
  for (const r of rows) ledger.mintTo(r.nftId, VAULT);
  assert.equal((await engine.changePool(5, rows)).ok, true);
  await run(3);
  // The pool page quotes each NFT its own odds, and they and the ladder add to the band.
  const view = poolView(engine.state, 5)!;
  const b1 = view.bands[1];
  assert.ok(b1.nfts.every((n) => "pct" in n && typeof n.pct === "number"));
  assert.ok(Math.abs(b1.nftPct + b1.prizes.reduce((a, p) => a + p.pct, 0) - 80) < 1e-6);
  const pull = async () => {
    const q = await engine.createOrder(PLAYER, 5);
    assert.ok(q.ok, JSON.stringify(q));
    ledger.userSubmit(q.tx as never);
    await run(6);
    return engine.state.orders.get(q.order.id)!;
  };
  for (let i = 0; i < 6; i++) await pull();
  // Chase's five cheapest NFTs, its likeliest, come out: a Chase roll that lands on one of their shares now gives the pull's XRP back.
  const cheapest = [...engine.state.lots.values()].filter((l) => l.band === 4 && l.status === "available" && l.removeLedger === null).sort((a, c) => Number(a.markDrops) - Number(c.markDrops)).slice(0, 5);
  assert.equal((await engine.changePool(5, [], cheapest.map((l) => l.lot))).ok, true);
  await run(3);
  const later = poolView(engine.state, 5)!.bands[4] as { refundPct?: number };
  assert.ok((later.refundPct ?? 0) > 0, "an emptied Chase slot gives XRP back, and the pool page says how often");
  for (let i = 0; i < 40; i++) await pull();
  const log = await store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  const kinds = new Set(log.filter((e) => e.type === "pull_drawn" || e.type === "pull_prize_drawn" || e.type === "pull_refund_due").map((e) => (e.type === "pull_refund_due" ? `refund:${e.data.reason}` : e.type)));
  for (const k of ["pull_drawn", "pull_prize_drawn", "refund:slot_empty"]) assert.ok(kinds.has(k), `${k} in ${[...kinds]}`);

  /** Change one event, reseal everything after it, and replay. */
  const forge = (at: number, body: RipEventBody) => {
    const tail = [body, ...log.slice(at + 1).map((e) => ({ type: e.type, data: e.data }) as RipEventBody)];
    return replayLog([...log.slice(0, at), ...sealEvents(at ? log[at - 1].seq : 0, at ? log[at - 1].hash : "0".repeat(64), tail, new Date(0).toISOString())]);
  };
  // A refund turned into the Chase NFT a player would rather have: refused, the roll gave none.
  const refundAt = log.findIndex((e) => e.type === "pull_refund_due" && e.data.reason === "slot_empty");
  const r = log[refundAt].data as Extract<RipEvent, { type: "pull_refund_due" }>["data"];
  const o = engine.state.orders.get(r.order)!;
  const lot = [...engine.state.lots.values()].find((l) => l.band === 4 && l.status !== "removed")!;
  const asNft = forge(refundAt, { type: "pull_drawn", data: { order: r.order, season: o.season, index: o.index as number, seed: r.seed, txHash: o.txHash as string, ledgerHash: r.ledgerHash, entropyLedger: o.entropyLedger as number, address: o.address, digest: r.digest, band: 4, poolSize: 2, pick: 0, lot: lot.lot, nftId: lot.nftId } });
  assert.equal(asNft.ok, false);
  // An NFT pick moved to another NFT in the same pool: refused.
  const drawnAt = log.findIndex((e) => e.type === "pull_drawn" && e.data.poolSize > 1);
  const d = log[drawnAt].data as Extract<RipEvent, { type: "pull_drawn" }>["data"];
  const moved = forge(drawnAt, { type: "pull_drawn", data: { ...d, pick: (d.pick + 1) % d.poolSize } });
  assert.equal(moved.ok, false);
  // A ladder prize turned into a refund: refused, the band's rows pay.
  const rungAt = log.findIndex((e) => e.type === "pull_prize_drawn" && e.data.band === 1);
  if (rungAt >= 0) {
    const p = log[rungAt].data as Extract<RipEvent, { type: "pull_prize_drawn" }>["data"];
    const po = engine.state.orders.get(p.order)!;
    const asRefund = forge(rungAt, { type: "pull_refund_due", data: { id: `pull:${p.order}`, order: p.order, seed: p.seed, ledgerHash: p.ledgerHash, digest: p.digest, band: 1, reason: "slot_empty", to: po.address, drops: po.drops } });
    assert.equal(asRefund.ok, false);
  }
  // Per-item odds with the ladder taken out of the terms: refused where the season opens.
  const openAt = log.findIndex((e) => e.type === "season_open");
  const { emptyBand: _e, ...bare } = log[openAt].data as Extract<RipEvent, { type: "season_open" }>["data"];
  assert.equal(forge(openAt, { type: "season_open", data: bare }).ok, false);
  // The pack's sell-back stayed under its own ceiling throughout what was kept.
  const ceiling = itemEconomics(ladder, odds, marks, SELL_BPS).ceilingShare;
  assert.ok(sellBackShare(engine.state, season, await ledger.chain.validatedLedger()) <= ceiling + 1e-9);
});

test("seasons before 5-6 draw, replay and hash exactly as before: no per-item odds on 5-5, and the fallback is the only rule a ladder adds", () => {
  assert.equal(seasonPlan({ ...L56, ...SEASON_5_5 }, null).nftOdds, undefined);
  assert.equal(seasonPlan(NFT_LADDERS[10], null).nftOdds, undefined);
  // Ladder rungs come from the same roll as an empty band's fallback, so 5-6's ladder is the published one.
  for (let i = 0; i < 200; i++) {
    const row = fallbackRowOf(sha256Hex(`rung-${i}`), TABLE, 0);
    assert.ok(row && row.band === 0);
  }
});
