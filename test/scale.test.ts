import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SEASON_5_4, SEASON_5_5 } from "../src/config/nft-packs.ts";
import { RESTOCK_STAGES } from "../src/config/restock.ts";
import { SELL_BPS } from "../src/lib/rip/engine.ts";
import { keepsToGate, nftChances, packEconomics, placesBacked, targetsFor } from "../src/lib/rip/scale.ts";
import { apply, emptyState } from "../src/lib/rip/state.ts";
import type { RipEvent } from "../src/lib/rip/types.ts";

const { events } = JSON.parse(readFileSync(new URL("./fixtures/mainnet-log-20261103-253.json", import.meta.url), "utf8")) as { events: RipEvent[] };
const state = emptyState();
for (const e of events) apply(state, e);
const marks = (price: 5 | 10) => [0, 1, 2, 3, 4].map((band) => [...state.lots.values()].filter((l) => l.price === price && l.band === band && l.status === "available" && l.removeLedger === null).map((l) => Number(l.markDrops) / 1e6));

test("the targets in the config are what the rule gives: bands fill in proportion to how fast they're pulled, and never shrink", () => {
  for (const price of [5, 10] as const) {
    const base = RESTOCK_STAGES.launch[price];
    for (const total of [50, 100] as const) {
      assert.deepEqual([...RESTOCK_STAGES[String(total) as "50" | "100"][price]], targetsFor(NFT_LADDERS[price], base, total), `$${price} at ${total}`);
      assert.equal(RESTOCK_STAGES[String(total) as "50" | "100"][price].reduce((a: number, b: number) => a + b, 0), total);
    }
  }
  fc.assert(fc.property(fc.array(fc.nat(30), { minLength: 5, maxLength: 5 }), fc.integer({ min: 1, max: 300 }), fc.constantFrom(5, 10) as fc.Arbitrary<5 | 10>, (base, total, price) => {
    const out = targetsFor(NFT_LADDERS[price], base, total);
    out.forEach((n, i) => assert.ok(n >= base[i]));
    assert.equal(out.reduce((a, b) => a + b, 0), Math.max(total, base.reduce((a, b) => a + b, 0)));
    // $10's Common pays only tokens. $5's holds NFTs from season 5-6, and fills fastest: it's pulled most.
    if (price === 10) assert.equal(out[0], base[0], "a band that pays only tokens gets no NFTs");
  }));
});

test("the pack as it stands on mainnet in season 5-4, at 97% less 2%: about 91.0% all sold, 93.1% all kept, under the gate and not by much", () => {
  assert.equal(SELL_BPS, 9506);
  const m = marks(5);
  assert.equal(m.flat().length, 29);
  // Season 5-4's own rates: the $5 ladder is on 5-5 now.
  const l54 = { ...NFT_LADDERS[5], ...SEASON_5_4 };
  const e = packEconomics(l54, m, SELL_BPS / 10_000);
  assert.ok(Math.abs(e.allSell - 0.9099) < 0.0005, String(e.allSell));
  assert.ok(Math.abs(e.allKeep - 0.9315) < 0.0005, String(e.allKeep));
  assert.ok(Math.abs(e.topSale - 135.94) < 0.01, String(e.topSale));
  assert.ok(e.allSell < 0.95);
  assert.ok(e.worstShare > 0.95, "cheap NFTs leaving can take it past the gate, which closes the pack: that's the gate working");
  assert.ok(keepsToGate(l54, m, SELL_BPS / 10_000)! >= 1);
});

test("the checkouts a pool can back, and the room to the gate, only grow with more NFTs at the same marks", () => {
  // That pool sits in 5-4's bands, Common empty, so it's read on the rates of a season with a dust Common: 5-5's.
  const m = marks(5);
  const l55 = { ...NFT_LADDERS[5], ...SEASON_5_5 };
  const doubled = m.map((b) => [...b, ...b]);
  const share = SELL_BPS / 10_000;
  const chances = nftChances(l55);
  assert.ok(placesBacked(doubled.map((b) => b.length), chances) >= placesBacked(m.map((b) => b.length), chances));
  assert.ok(keepsToGate(l55, doubled, share)! > keepsToGate(l55, m, share)!);
  // The same marks give the same return, whatever the depth.
  assert.ok(Math.abs(packEconomics(l55, doubled, share).allSell - packEconomics(l55, m, share).allSell) < 1e-9);
});

test("the cover the treasury needs falls as the margin grows and rises as the risk taken falls", () => {
  const m = marks(5);
  const at95 = packEconomics(NFT_LADDERS[5], m, 0.9506);
  const at85 = packEconomics(NFT_LADDERS[5], m, 0.85);
  assert.ok(at95.coverAt(0.01) > at85.coverAt(0.01));
  assert.ok(at95.coverAt(0.01) > at95.coverAt(0.1));
  assert.equal(packEconomics({ ...NFT_LADDERS[5], xrp: 1 }, m, 0.9506).coverAt(0.01), Infinity, "no margin, no cover is enough");
});
