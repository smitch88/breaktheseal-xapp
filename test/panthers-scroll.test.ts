import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SEASON_5_4, isDustBand } from "../src/config/nft-packs.ts";
import { lotsNeeded, nftChanceOf, stockCovers, xrpCoverFor } from "../src/lib/rip/draw.ts";
import { MAX_SELL_BACK_SHARE, SELL_BPS, sellBackShare } from "../src/lib/rip/engine.ts";
import { prizeTableFor } from "../src/lib/rip/tokens.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import type { RipEvent } from "../src/lib/rip/types.ts";

/**
 * Season 5-4's rates, on the real $5 pool as the public log held it, plus what the owner chose on 2026-11-02: 4 Panthers in Rare and one
 * Scroll V2 in Chase. Internal: what a pack pays back is never shown to a player.
 */
const OLD_RATES = [7396, 2000, 250, 314, 40];
/** 5-4 as committed. The $5 ladder has moved on to 5-5 since (test/restock-value-odds.test.ts). */
const NEW_RATES = SEASON_5_4.bandBps;
const PANTHERS = [13.20657, 13.714515, 14.22246, 14.22246];
const SCROLL_PAID = 198.09855;
const SCROLL_MARK = 143; // min(paid, floor x 1.1) with the Scroll registered at --floor 130, its 30-day median sale.
const TABLE = prizeTableFor(SEASON_5_4.tokenPrizes, false);

const drops = (xrp: number) => String(Math.round(xrp * 1e6));
const { events } = JSON.parse(readFileSync(new URL("./fixtures/mainnet-log-20261102-5-3.json", import.meta.url), "utf8")) as { events: RipEvent[] };

function pool(adds: { band: number; mark: number }[] = []) {
  const replay = replayLog(events);
  assert.ok(replay.ok);
  const { state } = replay;
  const season = state.seasons.get("5-3");
  assert.ok(season);
  const ledger = (season.anchorLedger as number) + 1;
  adds.forEach((a, i) => {
    const id = `added-${i}`;
    state.lots.set(id, { lot: id, nftId: `NFT${i}`, price: 5, band: a.band, collection: "added", name: id, img: "", costDrops: drops(a.mark), markDrops: drops(a.mark), status: "available", addLedger: ledger - 1, removeLedger: null } as never);
  });
  const shareAt = (bandBps: readonly number[]) => sellBackShare(state, { ...season, bandBps: [...bandBps] }, ledger);
  return { state, season, ledger, shareAt };
}
const withPanthers = PANTHERS.map((mark) => ({ band: 2, mark }));
const scroll = (mark: number) => ({ band: 4, mark });

test("the $5 rates add up, and only Common, Rare and Chase moved", () => {
  assert.equal(NEW_RATES.reduce((a, b) => a + b, 0), 10_000);
  assert.deepEqual(NEW_RATES.map((b, i) => (b === OLD_RATES[i] ? "same" : "moved")), ["moved", "same", "moved", "same", "moved"]);
  assert.equal(isDustBand({ ...NFT_LADDERS[5], ...SEASON_5_4 }, 0), true);
});

test("the rule that closes a pack: a Scroll at what the vault pays closes $5 on the old rates, at any mix, and the new rates carry it", () => {
  assert.ok(pool().shareAt(OLD_RATES) < MAX_SELL_BACK_SHARE);
  assert.ok(pool([scroll(SCROLL_PAID)]).shareAt(OLD_RATES) > MAX_SELL_BACK_SHARE, "the Scroll alone");
  assert.ok(pool([...withPanthers, scroll(SCROLL_PAID)]).shareAt(OLD_RATES) > MAX_SELL_BACK_SHARE, "with the Panthers");
  assert.ok(pool([...withPanthers, scroll(SCROLL_PAID)]).shareAt(NEW_RATES) < MAX_SELL_BACK_SHARE, "new rates at the full mark");
});

test("at the planned marks and new rates a pull pays back no more than it did, and no single NFT leaving can close the pack", () => {
  const { state, shareAt } = pool([...withPanthers, scroll(SCROLL_MARK)]);
  assert.ok(shareAt(NEW_RATES) <= pool().shareAt(OLD_RATES), "under today's average");
  for (const lot of [...state.lots.values()]) {
    if (lot.price !== 5 || lot.status !== "available" || lot.removeLedger !== null) continue;
    const at = lot.status;
    (lot as { status: string }).status = "taken";
    assert.ok(shareAt(NEW_RATES) < MAX_SELL_BACK_SHARE, lot.nftId);
    (lot as { status: string }).status = at;
  }
});

test("what a pull costs the house when the winner keeps the NFT is no higher than it was: a mark can't lower this, only rarer bands can", () => {
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const { state } = pool();
  const paid = (band: number) => [...state.lots.values()].filter((l) => l.price === 5 && l.band === band && l.status === "available" && l.removeLedger === null).map((l) => Number(l.markDrops) / 1e6);
  const keepCost = (rates: readonly number[], rare: number[], chase: number[]) =>
    rates.reduce((sum, bps, band) => {
      const rows = TABLE.filter((r) => r.band === band);
      const tokenShare = rows.reduce((a, r) => a + r.bps / 10_000, 0);
      const tokens = rows.reduce((a, r) => a + (r.bps / 10_000) * (Number(r.valueDrops) / 1e6), 0);
      const nfts = band === 2 ? rare : band === 4 ? chase : paid(band);
      return sum + (bps / 10_000) * (tokens + (nfts.length ? (1 - tokenShare) * avg(nfts) : 0));
    }, 0);
  const today = keepCost(OLD_RATES, paid(2), paid(4));
  const sameRates = keepCost(OLD_RATES, [...paid(2), ...PANTHERS], [...paid(4), SCROLL_PAID]);
  const newRates = keepCost(NEW_RATES, [...paid(2), ...PANTHERS], [...paid(4), SCROLL_PAID]);
  assert.ok(sameRates > today + 0.15, `${sameRates} against ${today}`);
  assert.ok(newRates <= today, `${newRates} against ${today}`);
});

test("per NFT: uniform within a band, so each Chase NFT is 0.0933% and each Rare NFT is 0.1983%, and the Scroll's odds are every other Chase NFT's", () => {
  const each = (band: number, lots: number, bps: readonly number[]) => nftChanceOf(bps, TABLE, band) / lots;
  assert.ok(Math.abs(each(4, 2, OLD_RATES) - 0.002) < 1e-12);
  assert.ok(Math.abs(each(4, 3, NEW_RATES) - 0.0028 / 3) < 1e-12);
  assert.ok(Math.abs(each(2, 5, OLD_RATES) - 0.00425) < 1e-12);
  assert.ok(Math.abs(each(2, 9, NEW_RATES) - (0.021 * 0.85) / 9) < 1e-12);
});

test("up to 5 open places the treasury covers no more than it did, 42, 84 and 122 XRP for 1, 2 and 3, and stock can hold at least as many as today", () => {
  for (const [places, need] of [[1, 42_000_000n], [2, 84_000_000n], [3, 122_000_000n]] as const) assert.equal(xrpCoverFor(TABLE, NEW_RATES, places), need);
  for (let places = 1; places <= 5; places++) assert.ok(xrpCoverFor(TABLE, NEW_RATES, places) <= xrpCoverFor(TABLE, OLD_RATES, places), String(places));
  const most = (stock: number[], rates: readonly number[]) => {
    let holds = 0;
    while (holds < 500 && stockCovers(stock, holds, rates, TABLE)) holds++;
    return holds;
  };
  assert.ok(most([0, 14, 9, 4, 3], NEW_RATES) >= most([0, 14, 5, 4, 2], OLD_RATES));
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 60 }), (places) => {
      for (const band of [2, 4]) assert.ok(lotsNeeded(places, nftChanceOf(NEW_RATES, TABLE, band)) <= lotsNeeded(places, nftChanceOf(OLD_RATES, TABLE, band)));
    }),
  );
});

test("a sell-back is the season's rate of the mark: a Scroll marked 143 pays 135.9358, not what the vault paid", () => {
  assert.equal(SELL_BPS, 9506);
  assert.equal((BigInt(drops(SCROLL_MARK)) * BigInt(SELL_BPS)) / 10_000n, 135_935_800n);
});
