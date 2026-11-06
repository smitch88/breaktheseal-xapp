import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SEASON_5_4, SEASON_5_5 } from "../src/config/nft-packs.ts";
import { BAND_RANGES } from "../src/config/restock.ts";
import { lotsNeeded, nftChanceOf, stockCovers, xrpCoverFor } from "../src/lib/rip/draw.ts";
import { FLOOR_MARK_BPS, bandOfMark, buyCapDrops, configRules, relistDecision } from "../src/lib/rip/restock.ts";
import { bandOfValue, valueRanges } from "../src/lib/rip/rarity-spec.ts";
import { packEconomics } from "../src/lib/rip/scale.ts";
import { prizeTableFor } from "../src/lib/rip/tokens.ts";

/**
 * The owner, 2026-11-03: no price-window caps on the $5 pack; set its odds from what its NFTs are really worth. Internal: what a pack pays back is never
 * shown to a player.
 */

/** The live $5 pool as the owner's rebuy left it, 2026-11-03 (48 NFTs, season 5-4), by band, in XRP, with the Scroll re-marked to what the vault paid. */
const AFTER: readonly (readonly number[])[] = [
  [],
  [3, 3.382914, 2.844492, 2.821127, 3.037511, 2.86481, 3.352437, 2.874969, 3.555615, 3.555615, 3.04767, 2.03178, 1.75, 2.732744, 2.732745],
  [5, 9.14301, 10, 10.1589, 10.1589, 10.1589, 13.714515, 14.22246, 14, 14.22246, 13.20657, 14, 23.36547, 5.07945, 16.152651, 16.25424, 11.17479, 14, 14.22246, 14.22246, 15.136761, 17.27013, 17.27013, 17.259972, 12],
  [49.77861, 45.71505, 56.788251, 50.692911],
  // The Scroll from 143 to 198.09855 XRP, the vault's price on the ledger: under 110% of its 194 floor. season-5-5.sh re-marks it before 5-5 opens.
  [96.508535, 85.233171, 81.2712, 198.09855],
];
/** And as that pool stands on the log under 5-4, with the Scroll still at 143: what a pack pays today. */
const TODAY: readonly (readonly number[])[] = [...AFTER.slice(0, 4), [96.508535, 85.233171, 81.2712, 143]];
const SELL = 0.9506;
const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Season 5-5, as committed: these tests are its history. 5-6 cut the $5 bands to value tiers: test/rarity-spec.test.ts.
const NEW = { ...NFT_LADDERS[5], ...SEASON_5_5 };
const T54 = prizeTableFor(SEASON_5_4.tokenPrizes, false);
const T55 = prizeTableFor(NEW.tokenPrizes, false);
const xrp = (n: number) => BigInt(Math.round(n * 1e6));

// ---------- No window caps on what goes back

test("a sold-back NFT goes back at its own mark, or 110% of a floor that backs less, whatever band it's in and however high or low that is", () => {
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 1, max: 10 ** 12 }), (mark, floor) => {
    const d = relistDecision({ markDrops: mark.toString(), market: { floorDrops: floor, medianSaleDrops: floor, notBuyable: null } });
    assert.equal(d.kind, "add");
    const fromFloor = (BigInt(floor) * FLOOR_MARK_BPS) / 10_000n;
    assert.equal(BigInt((d as { markDrops: string }).markDrops), fromFloor < mark ? fromFloor : mark);
  }));
  // No floor read, or one that can't be had: it goes back as it was.
  for (const mark of [1n, xrp(23.36547), xrp(143), xrp(5000)]) assert.deepEqual(relistDecision({ markDrops: mark.toString(), market: undefined }), { kind: "add", markDrops: mark.toString(), note: "kept" });
});

test("the floor's own safeguards stay: a floor far under what it really sells for still holds for a person, and nothing else does", () => {
  assert.deepEqual(relistDecision({ markDrops: String(xrp(90)), market: { floorDrops: Number(xrp(10)), medianSaleDrops: Number(xrp(90)), notBuyable: null } }), { kind: "hold", reason: "floor_unclear" });
});

// ---------- Bands by value, from the shelf

test("the $5 bands are the rarity spec's value tiers at 4 XRP, and every NFT the rebuy left fits the tier its mark says, or none under 2 XRP", () => {
  const ranges = BAND_RANGES[5]!;
  assert.deepEqual(ranges.map((r) => [...r!]), valueRanges(4).map((r) => [...r]));
  assert.equal(ranges[4]![1], null, "Chase has no top");
  for (let b = 0; b < 4; b++) assert.equal(ranges[b]![1], ranges[b + 1]![0], "the ranges meet");
  for (const m of AFTER.flat()) assert.equal(bandOfMark(5, xrp(m)), bandOfValue(4, m), `${m}`);
  assert.equal(bandOfMark(5, xrp(1.75)), null, "the 1.75 XRP zPunk fits no band: under half the pack");
  fc.assert(fc.property(fc.double({ min: 0.01, max: 1000, noNaN: true }), (m) => assert.equal(bandOfMark(5, xrp(m)), bandOfValue(4, Number(xrp(m)) / 1e6))));
});

test("buying keeps band membership by value and its own spend limits, with no window top: a Chase buy's cap is the per-NFT limit, the floor rule and the budget", () => {
  const rules = configRules();
  const chase = rules.windowOf(5, 4)!;
  assert.equal(chase.maxDrops, null);
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.integer({ min: 1, max: 10 ** 9 }), fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.bigInt({ min: 0n, max: 10n ** 9n }), (per, floor, budget, spendable) => {
    const cap = buyCapDrops({ window: chase, perNftDrops: per, floorDrops: floor, stopBps: 500, budgetLeftDrops: budget, spendableDrops: spendable });
    const fromFloor = (((BigInt(floor) * FLOOR_MARK_BPS) / 10_000n) * 10_500n) / 10_000n;
    assert.equal(cap, [per, fromFloor, budget, spendable].reduce((a, b) => (b < a ? b : a)));
  }));
});

// ---------- Odds from value: season 5-5

const economics = (l: Pick<typeof NEW, "xrp" | "bandBps" | "tokenPrizes">, shelf: readonly (readonly number[])[]) => packEconomics(l, shelf, SELL);

test("season 5-5's $5 rates add up, and every NFT on the shelf is worth the same per pull: a pricier NFT is rarer in proportion to its value", () => {
  assert.equal(NEW.bandBps.reduce((a, b) => a + b, 0), 10_000);
  const each = (band: number) => nftChanceOf(NEW.bandBps, T55, band) / AFTER[band].length;
  const values = [1, 2, 3, 4].map((b) => each(b) * avg(AFTER[b]));
  // Within whole basis points: Chase's 17 is 1 bp in 17, about 6%, so the bands sit within 5% of each other.
  for (const v of values) assert.ok(Math.abs(v / Math.max(...values) - 1) < 0.05, values.join(" "));
  for (let b = 1; b < 4; b++) assert.ok(each(b + 1) < each(b), `band ${b + 1} isn't rarer per NFT than band ${b}`);
  // Under 5-4 it ran the other way: an Epic NFT was likelier than a Rare one.
  assert.ok(nftChanceOf(SEASON_5_4.bandBps, T54, 3) / 4 > nftChanceOf(SEASON_5_4.bandBps, T54, 2) / 25);
});

test("5-5 pays what 5-4 pays on that pool today, sells back no more, and stays well under the gate, with the treasury covering the biggest sale and 3 places", () => {
  const today = economics(SEASON_5_4, TODAY);
  const after = economics(NEW, AFTER);
  assert.ok(Math.abs(after.allKeep - today.allKeep) < 0.001, `${after.allKeep} vs ${today.allKeep}`);
  assert.ok(after.allSell <= today.allSell, `${after.allSell} vs ${today.allSell}`);
  assert.ok(after.allSell < 0.92);
  // The Scroll's sale back is the biggest, 188.31 XRP. With 3 places open and the 10 XRP floor that's 282.31, inside the treasury's 373.5.
  assert.ok(Math.abs(after.topSale - 188.3125) < 0.001);
  assert.ok(after.topSale + Number(xrpCoverFor(T55, NEW.bandBps, 3)) / 1e6 + 10 < 373.5);
});

test("5-5 never asks the treasury for more cover than 5-4, for 1 to 20 open places, and no XRP row takes more than half its band", () => {
  for (let places = 1; places <= 20; places++) assert.ok(xrpCoverFor(T55, NEW.bandBps, places) <= xrpCoverFor(T54, SEASON_5_4.bandBps, places), String(places));
  for (const r of NEW.tokenPrizes) assert.ok(r.dust || r.bps <= 5000, `band ${r.band}`);
});

test("the post-rebuy stock backs at least 20 open places on 5-5, so a ten-pack order and its neighbors fit", () => {
  let holds = 0;
  while (holds < 500 && stockCovers([0, 15, 25, 4, 4], holds, NEW.bandBps, T55)) holds++;
  assert.ok(holds >= 20, String(holds));
  fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (places) => {
    for (const band of [1, 2, 3, 4]) assert.ok(lotsNeeded(places, nftChanceOf(NEW.bandBps, T55, band)) <= AFTER[band].length);
  }));
});

// ---------- Re-marking an NFT already in a pool

test("re-marking a pooled NFT is a person's remove then restock: never one a player holds, not before the removal is on the ledger, and the replay takes the new mark", async () => {
  const { world, addressOf } = await import("./support-routes.ts");
  const { replayLog } = await import("../src/lib/rip/verify.ts");
  const w = await world();
  await w.open(5, "4000000", [3, 3, 3, 3, 3]);
  const me = w.client(addressOf(7));
  w.fund(me, 2000);
  // An NFT in a stash isn't in the pool, so there's nothing to take out.
  let pulled = null as null | { lot: string };
  for (let i = 0; i < 30 && !pulled; i++) {
    const id = await w.pull(me);
    const o = w.orderOf(id)!;
    if (o.lot) pulled = { lot: o.lot };
  }
  assert.ok(pulled);
  assert.equal((await w.engine.changePool(5, [], [pulled.lot])).ok, false);
  const chase = [...w.engine.state.lots.values()].find((l) => l.price === 5 && l.band === 4 && l.status === "available" && l.removeLedger === null)!;
  const { nftId, band, collection, name, img, costDrops } = chase;
  const row = { nftId, band, collection, name, img, costDrops, markDrops: "198098550" };
  assert.equal((await w.engine.changePool(5, [], [chase.lot])).ok, true);
  assert.equal((await w.engine.changePool(5, [row])).ok, false, "not until the removal is on the ledger");
  await w.pump(4);
  assert.equal((await w.engine.changePool(5, [row])).ok, true);
  await w.pump(4);
  const now = [...w.engine.state.lots.values()].filter((l) => l.nftId === nftId && l.status === "available" && l.removeLedger === null);
  assert.equal(now.length, 1);
  assert.equal(now[0].markDrops, "198098550");
  const replay = replayLog(await w.store.readFrom(0));
  assert.ok(replay.ok, JSON.stringify(replay));
});
