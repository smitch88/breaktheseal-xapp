import type { NftLadder, TokenPrizeRow } from "../../config/nft-packs.ts";
import { ITEM_SCALE, itemBandValue, itemWeights, ladderAverageDrops, lotsNeeded, nftChanceOf, stockCovers, type EmptyBand, type ItemOdds } from "./draw.ts";
import { prizeTableFor } from "./tokens.ts";

/**
 * The one rarity spec an NFT pack's season is cut to, and its builder. Pure code: nothing here reads a store, the ledger or the market.
 *
 * The owner, 2026-11-05: "adjust our 5 dollar pack opening tiers so that commons hits between .5x-1.2x nothing at .25x, and we adjust the odds like
 * we have set up for collector crypt pack structure just like we did with cubes.fun recently". This mirrors cubes.fun's spec cubes-rarity-v3
 * (apps/cubes-fun/apps/paw/lib/rarity/spec.ts and lib/server/spot/rarity-tables.ts), which took its shape from Collector Crypt's Starter Pokemon pack:
 * Common 75% at 0.5-1.2x the price, Uncommon 20% at 1.2-2.2x, Rare 4% at 2.2-5x, Epic 1% at 5-20x, and a grail above 20x at small odds.
 * The floor is stricter than cubes' 25%: nothing under half the price. The owner, later that day: cubes.fun's 6.4% margin, and "more XRP ladders ...
 * across all tiers": every tier pays a ladder of XRP rows across its range, and a band whose NFTs run out keeps paying them.
 *
 * The only inputs are the price, the inventory (every NFT's mark), the margin and the cover cap. How it maps onto this engine, where a pull lands on a
 * band, then on one of the band's XRP rows at its share, else on one NFT picked fairly from the band's whole pool:
 * - A band is a tier, by value: every prize in it, NFT or XRP rung, sits inside the tier's range of multiples of the price.
 * - Each tier has a ladder of XRP rungs across its range, cheapest most often: each rung is `cheapRatio` (cubes' 0.45) as likely as the one below.
 *   The NFTs in a band can't be weighted one by one, since the pick across them is fair, so in the rarer tiers they count as one prize at their
 *   average, in its place on the ladder, but never ahead of the cheapest rung. No rung is bigger than the cover cap.
 * - XRP rows are cubes' ETH prizes: they cost the house their full value, where an NFT sold back costs 95.06% of its mark. So, as cubes thins ETH in
 *   favor of real prizes, Common's NFTs take as much of the band as the margin and the stock rule allow, and its ladder takes the rest.
 * - The margin lands on Common: with room, its ladder flattens toward even rungs; short of it, Common's NFTs give way, then its ladder steepens
 *   toward 0.5x, then Uncommon sits on its cheapest rung, and only then do the rarer rates thin, inside their tolerances. With Common's NFTs at
 *   their cap and its ladder flat and room still left, the rarer rates grow, the same way.
 * - The stock rule caps an NFT band's share: the pool backs `minPlaces` open places (a ten-pack order and its neighbors) at HOLD_RISK. A season cut
 *   here commits `emptyBand: "rows"`: once a band's NFTs are gone, its NFT share pays its ladder, so the pack sells on while it restocks.
 * - And per-item NFT odds (`nftOdds`, ItemOdds in draw.ts; owner: "Common nfts held shouldn't close the pack"): each NFT its own share of its band,
 *   k / its mark, so they're all worth the same per pull and their value as one prize is their harmonic mean; whatever share the pool's NFTs don't
 *   take pays the ladder. `oddsFor` commits k, the cap and the excess so the full pool draws exactly as cut, and no pool can add more. So a cut's
 *   `ceilingShare`, under the 95% sell-back line, holds however NFTs are kept, sold back, taken out or restocked.
 *
 * Internal: what a pack returns is never shown to a player.
 */

export type TierId = "common" | "uncommon" | "rare" | "epic" | "chase";
export interface RarityTier {
  readonly id: TierId;
  readonly label: string;
  /** The engine's band. */
  readonly band: number;
  /** The published rate, and the tolerance it may move inside when the margin needs it. */
  readonly rate: number;
  readonly min: number;
  readonly max: number;
  /** The tier's value range, as multiples of the price: from lo up to, not including, hi. No hi: no top. */
  readonly lo: number;
  readonly hi: number | null;
  /** The tier's XRP ladder, as multiples of the price, cheapest first. At 4 XRP: 2 to 4.5, 5 to 8, 9 to 18, 21 to 42. */
  readonly xrp: readonly number[];
}

export const RARITY_SPEC = Object.freeze({
  version: "seal-rarity-v3",
  mirrors: "cubes-rarity-v3",
  tiers: Object.freeze([
    { id: "common", label: "Common", band: 0, rate: 0.75, min: 0.7, max: 0.82, lo: 0.5, hi: 1.2, xrp: [0.5, 0.625, 0.75, 0.875, 1, 1.125] },
    { id: "uncommon", label: "Uncommon", band: 1, rate: 0.2, min: 0.14, max: 0.24, lo: 1.2, hi: 2.2, xrp: [1.25, 1.5, 1.75, 2] },
    { id: "rare", label: "Rare", band: 2, rate: 0.04, min: 0.03, max: 0.055, lo: 2.2, hi: 5, xrp: [2.25, 3, 3.75, 4.5] },
    { id: "epic", label: "Epic", band: 3, rate: 0.01, min: 0.006, max: 0.015, lo: 5, hi: 20, xrp: [5.25, 7.5, 10.5] },
    // The grail: season 5-5's 0.17%, inside cubes' Legendary 0 to 0.3%. NFTs only: an XRP rung at 20x or more needs more cover than the treasury
    // holds. With no NFT in the pool, Common takes its share.
    { id: "chase", label: "Chase", band: 4, rate: 0.0017, min: 0, max: 0.003, lo: 20, hi: null, xrp: [] },
  ] as readonly RarityTier[]),
  /** No prize under this share of the price. The owner, 2026-11-05: "nothing at .25x". */
  floorFrac: 0.5,
  /** Each prize on a tier's ladder is this much as likely as the next cheaper one (cubes' G). Common's moves between 0 and 1 to land the margin. */
  cheapRatio: 0.45,
  /** The cut lands within this of its margin. */
  marginToleranceBps: 50,
  /** Open places the pool must back on every NFT band: more than 20, so a ten-pack order and its neighbors fit. */
  minPlaces: 21,
  /** What a band's NFT share pays once its pool is empty, committed with the season. */
  emptyBand: "rows" as EmptyBand,
  /** The sell-back line a pack closes at (MAX_SELL_BACK_SHARE in the engine, which a test holds this to). A cut's ceiling stays under it. */
  gate: 0.95,
});

type Five<T> = readonly [T, T, T, T, T];
const SCALE = 10_000;
const TIERS = RARITY_SPEC.tiers;

/** The band a value belongs in by its multiple of the price, or null under the floor. */
export function tierOfMultiple(multiple: number): number | null {
  for (let b = TIERS.length - 1; b >= 0; b--) {
    const t = TIERS[b];
    if (multiple >= t.lo - 1e-12 && (t.hi === null || multiple < t.hi - 1e-12)) return b;
  }
  return null;
}
export const bandOfValue = (priceXrp: number, xrp: number) => tierOfMultiple(xrp / priceXrp);

/** Each band's value range in XRP for a pack price, as src/config/restock.ts's BAND_RANGES writes it: from, and up to (null: no top). */
export const valueRanges = (priceXrp: number): Five<readonly [number, number | null]> =>
  TIERS.map((t) => [round6(t.lo * priceXrp), t.hi === null ? null : round6(t.hi * priceXrp)] as const) as unknown as Five<readonly [number, number | null]>;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** A tier's XRP ladder at a pack price, in XRP, cheapest first, without any rung over the cover cap. */
export const ladderOf = (priceXrp: number, band: number, maxRowXrp = Infinity): number[] => TIERS[band].xrp.map((m) => round6(priceXrp * m)).filter((x) => x <= maxRowXrp + 1e-9);

export interface RarityInput {
  readonly priceXrp: number;
  /** Every NFT in the pack's pool, by its mark in XRP, whatever band it sits in now: the cut bands them by value. */
  readonly marks: readonly number[];
  /** The sell-path margin to land, in basis points of the price: what's kept if every NFT is sold back. */
  readonly marginBps: number;
  /** What a sale pays of a mark, the season's sellBps / 10,000. */
  readonly sellShare: number;
  /** No XRP rung over this, so one place's cover stays inside what the treasury holds. Unset: no cap. */
  readonly maxRowXrp?: number;
}

export interface RarityCut {
  readonly version: string;
  readonly priceXrp: number;
  readonly bandBps: Five<number>;
  readonly tokenPrizes: readonly TokenPrizeRow[];
  readonly emptyBand: EmptyBand;
  /** Per-item NFT odds the season commits: on the full pool they draw exactly the shares above. */
  readonly nftOdds: ItemOdds;
  /**
   * The most an average pull can sell back for, as a share of the price, whatever is in any band's pool: each band's ladder average (or the price, in
   * a band with no rows) plus its committed excess. Under the gate, so NFTs kept, sold back, taken out or restocked never close the pack on that line.
   */
  readonly ceilingShare: number;
  /** The marks each band holds, by value. */
  readonly marks: Five<readonly number[]>;
  /** NFTs under the floor: they leave the pool before the season opens. */
  readonly out: readonly number[];
  /** Everything sold back, and everything kept at its mark, as margins in basis points. */
  readonly sellMarginBps: number;
  readonly keepMarginBps: number;
  /** Share of pulls that land an NFT, and the XRP the rows pay per pull. */
  readonly nftPerPull: number;
  readonly xrpPerPull: number;
  /** Share of pulls that give the price back: a band with no rows whose roll falls past its NFTs' shares. None on the full pool. */
  readonly refundPerPull: number;
  /** The biggest XRP rung: one place's cover. */
  readonly topRowXrp: number;
  /** Open places this pool backs at these rates, up to 500. */
  readonly places: number;
  readonly feasible: boolean;
  readonly notes: readonly string[];
}

type Ladder = Pick<NftLadder, "xrp" | "bandBps" | "tokenPrizes">;
interface Item {
  readonly kind: "xrp" | "nft";
  readonly xrp: number;
}

/** The largest share of a band, in bps, its NFTs can take with the pool still backing `places` open places. */
export function nftShareCap(count: number, bandRate: number, places: number = RARITY_SPEC.minPlaces): number {
  if (count <= 0) return 0;
  if (count >= lotsNeeded(places, bandRate)) return SCALE;
  let lo = 0;
  let hi = SCALE;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (count >= lotsNeeded(places, (bandRate * mid) / SCALE)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const drops = (xrp: number) => Math.round(xrp * 1e6);

/**
 * Per-item odds for a ladder on its full pool. Each band's k is set so its NFTs take exactly its NFT share (what its rows leave), that share is
 * the cap, and the excess is what those NFTs add over the ladder at a sale's value, rounded up, so the full pool draws exactly as cut and no pool
 * can add more. A band whose NFTs are worth less than its ladder commits no excess: losing them can only bring it up to its ladder's average.
 */
export function oddsFor(ladder: Ladder, marksXrp: readonly (readonly number[])[], sellBps: number): ItemOdds {
  const table = prizeTableFor(ladder.tokenPrizes, false);
  const price = drops(ladder.xrp);
  const kDrops: number[] = [];
  const capBps: number[] = [];
  const excessDrops: number[] = [];
  for (let b = 0; b < 5; b++) {
    const marks = (marksXrp[b] ?? []).map(drops).filter((m) => m > 0);
    const cap = marks.length ? SCALE - ladder.tokenPrizes.filter((r) => r.band === b).reduce((a, r) => a + r.bps, 0) : 0;
    const inverse = marks.reduce((a, m) => a + 1 / m, 0);
    const k = cap > 0 && inverse > 0 ? Math.floor(cap / SCALE / inverse) : 0;
    const ladderAvg = ladderAverageDrops(table, b, price);
    const excess = marks.reduce((a, m) => a + (k / m) * ((sellBps * m) / SCALE - ladderAvg), 0);
    kDrops.push(k);
    capBps.push(cap);
    excessDrops.push(k > 0 ? Math.max(0, Math.ceil(excess)) : 0);
  }
  return { kDrops, capBps, excessDrops };
}

export interface ItemEconomics {
  /** Everything sold back, and everything kept at its mark, as a share of the price. */
  readonly allSell: number;
  readonly allKeep: number;
  /** XRP the rows pay per pull, the share of pulls landing an NFT, and the share giving the price back. */
  readonly tokensPerPull: number;
  readonly nftPerPull: number;
  readonly refundPerPull: number;
  /** The most an average pull can sell back for on any pool, as a share of the price: each band's ladder plus its committed excess. */
  readonly ceilingShare: number;
}

/** A ladder's cash picture under per-item odds on a pool, worked through the draw's own functions: what the engine and /fair compute. */
export function itemEconomics(ladder: Ladder, odds: ItemOdds, marksXrp: readonly (readonly number[])[], sellBps: number): ItemEconomics {
  const table = prizeTableFor(ladder.tokenPrizes, false);
  const price = drops(ladder.xrp);
  let sell = 0;
  let keep = 0;
  let tokens = 0;
  let nfts = 0;
  let refunds = 0;
  let ceiling = 0;
  for (let b = 0; b < 5; b++) {
    const rate = (ladder.bandBps[b] ?? 0) / SCALE;
    const marks = (marksXrp[b] ?? []).map(drops);
    const w = itemWeights(odds, table, b, marks, sellBps, price);
    const taken = w.reduce((a, x) => a + x, 0) / ITEM_SCALE;
    const hasRows = table.some((r) => r.band === b && r.bps > 0);
    const ladderAvg = ladderAverageDrops(table, b, price);
    sell += rate * itemBandValue(odds, table, b, marks, sellBps, price);
    keep += rate * (w.reduce((a, x, i) => a + (x / ITEM_SCALE) * marks[i], 0) + (1 - taken) * ladderAvg);
    if (hasRows) tokens += rate * (1 - taken) * ladderAvg;
    else refunds += rate * (1 - taken);
    nfts += rate * taken;
    ceiling += rate * (ladderAvg + Math.max(0, odds.excessDrops[b] ?? 0));
  }
  return { allSell: sell / price, allKeep: keep / price, tokensPerPull: tokens / 1e6, nftPerPull: nfts, refundPerPull: refunds, ceilingShare: ceiling / price };
}

/** Whole bps for a band's rungs, floored so the ladder never rises, with what's left to the cheapest rung. The NFTs take the rest, never over their cap. */
function rowsBps(items: readonly Item[], share: readonly number[], capBps: number): number[] {
  const rows = items.map((it, i) => (it.kind === "xrp" ? Math.floor(share[i] * SCALE + 1e-9) : 0));
  const xi = items.map((it, i) => (it.kind === "xrp" ? i : -1)).filter((i) => i >= 0);
  if (!xi.length) return rows;
  const hasNft = items.some((i) => i.kind === "nft");
  const wanted = Math.round(xi.reduce((a, i) => a + share[i], 0) * SCALE);
  const want = hasNft ? Math.min(SCALE, Math.max(SCALE - capBps, wanted)) : SCALE;
  rows[xi[0]] += want - rows.reduce((a, r) => a + r, 0);
  return rows;
}

/**
 * Cut a season from the spec. Never bends a tier's value range, the floor, the cover cap, a rate outside its tolerance or the stock rule: what it
 * can't reach at the margin, it says in `notes` and `feasible`.
 */
export function cutRarityLadder(input: RarityInput): RarityCut {
  const P = input.priceXrp;
  const cap = input.maxRowXrp ?? Infinity;
  const notes: string[] = [];
  const target = 1 - input.marginBps / SCALE;
  const tol = RARITY_SPEC.marginToleranceBps / SCALE;
  const marks: number[][] = TIERS.map(() => []);
  const out: number[] = [];
  for (const m of input.marks) {
    const b = bandOfValue(P, m);
    if (b === null) out.push(m);
    else marks[b].push(m);
  }
  if (out.length) notes.push(`${out.length} NFT(s) under ${RARITY_SPEC.floorFrac}x (${out.join(", ")} XRP) leave the pool: no prize may be worth less`);
  const dropped = TIERS.filter((t) => t.xrp.some((m) => P * m > cap + 1e-9)).map((t) => t.label);
  if (dropped.length) notes.push(`${dropped.join(", ")}: rungs over the ${cap} XRP cover cap left off`);
  // Per-item odds make every NFT worth the same per pull, so a band's NFTs pay their harmonic mean on its NFT share: that's their value as one prize.
  const avg = (b: number) => marks[b].length / marks[b].reduce((a, m) => a + 1 / m, 0);
  const sellBps = Math.round(input.sellShare * SCALE);
  // A tier's prizes, cheapest first, the NFTs as one prize at that value and never ahead of the cheapest rung.
  const itemsOf = (b: number): Item[] => {
    const rungs: Item[] = ladderOf(P, b, cap).map((x) => ({ kind: "xrp", xrp: x }));
    if (!marks[b].length) return rungs;
    const at = rungs.findIndex((r) => r.xrp > avg(b));
    const i = Math.max(rungs.length ? 1 : 0, at < 0 ? rungs.length : at);
    return [...rungs.slice(0, i), { kind: "nft", xrp: avg(b) }, ...rungs.slice(i)];
  };
  const items = TIERS.map((_, b) => itemsOf(b));

  const ratesAt = (scale: number): number[] => {
    const r = TIERS.map((t) => (t.id === "common" ? 0 : !items[t.band].length ? 0 : t.id === "chase" ? t.rate : Math.min(t.max, Math.max(t.min, t.rate * scale))));
    const bps = r.map((x) => Math.round(x * SCALE));
    bps[0] = SCALE - bps.reduce((a, x) => a + x, 0);
    return bps;
  };
  const capOf = (b: number, bandBps: readonly number[]) => nftShareCap(marks[b].length, bandBps[b] / SCALE) / SCALE;

  /**
   * A band's shares. Rungs weigh `ratio`^k, k counting up the ladder from its cheapest. In a rarer tier the NFTs weigh `ratio`^(their place) and
   * are held to the stock rule; in Common they take `commonNft` of the band, under the stock rule and never one likelier than the cheapest rung.
   */
  const sharesOf = (b: number, bandBps: readonly number[], ratio: number, commonNft: number): number[] => {
    const its = items[b];
    const nftCap = capOf(b, bandBps);
    let rung = 0;
    const w = its.map((it, j) => (it.kind === "nft" ? (b === 0 ? 0 : ratio ** j) : ratio ** rung++));
    const n = its.findIndex((it) => it.kind === "nft");
    const rungW = w.reduce((a, x, j) => a + (j === n ? 0 : x), 0);
    // Common's NFTs, each, never likelier than its cheapest rung. The likeliest NFT is the cheapest, at share x f, with f its part of the band's 1/mark;
    // the cheapest rung has (1 - share) x q. So share is at most q / (q + f).
    const q = rungW > 0 ? w[its.findIndex((it) => it.kind === "xrp")] / rungW : 1;
    const inverse = marks[b].reduce((a, m) => a + 1 / m, 0);
    const f = marks[b].length ? 1 / Math.min(...marks[b]) / inverse : 1;
    const byCheapest = q / (q + f);
    const nftShare = n < 0 ? 0 : b === 0 ? Math.min(commonNft, nftCap, byCheapest) : Math.min(nftCap, w[n] / w.reduce((a, x) => a + x, 0));
    return its.map((_, j) => (j === n ? nftShare : rungW > 0 ? ((1 - nftShare) * w[j]) / rungW : 0));
  };
  const ladderAt = (scale: number, commonNft: number, ratio: number): Ladder => {
    const bandBps = ratesAt(scale);
    const rows: TokenPrizeRow[] = [];
    TIERS.forEach((t, b) => {
      const its = items[b];
      const share = sharesOf(b, bandBps, ratio, commonNft);
      const bps = rowsBps(its, share, Math.round(capOf(b, bandBps) * SCALE));
      its.forEach((it, j) => {
        if (it.kind === "xrp" && bps[j] > 0) rows.push({ band: b, bps: bps[j], xrp: it.xrp, ...(t.id === "common" ? { dust: true as const } : {}) });
      });
    });
    return { xrp: P, bandBps: bandBps as unknown as Ladder["bandBps"], tokenPrizes: rows };
  };
  const sellOf = (l: Ladder) => itemEconomics(l, oddsFor(l, marks, sellBps), marks, sellBps).allSell;
  const bisect = (lo: number, hi: number, ok: (x: number) => boolean, up: boolean) => {
    // The largest (up) or smallest x in [lo, hi] for which ok holds, ok being monotone the right way.
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid) === up) lo = mid;
      else hi = mid;
    }
    return up ? lo : hi;
  };
  const G = RARITY_SPEC.cheapRatio;

  // At a rate scale: Common's NFTs at their cap, and one ladder ratio for every tier that lands the margin: flatter than cubes' 0.45 with room,
  // steeper without. Only with every ladder on its cheapest rung do Common's NFTs give way. Null: too rich even then.
  type Sol = { commonNft: number; ratio: number; room: boolean };
  const solveAt = (scale: number): Sol | null => {
    const nftCap = capOf(0, ratesAt(scale));
    const f = (s: number, r: number) => sellOf(ladderAt(scale, s, r));
    if (f(nftCap, G) <= target) {
      if (f(nftCap, 1) <= target) return { commonNft: nftCap, ratio: 1, room: true };
      return { commonNft: nftCap, ratio: bisect(G, 1, (r) => f(nftCap, r) <= target, true), room: false };
    }
    if (f(nftCap, 0) <= target) return { commonNft: nftCap, ratio: bisect(0, G, (r) => f(nftCap, r) <= target, true), room: false };
    if (f(0, 0) <= target) return { commonNft: bisect(0, nftCap, (s) => f(s, 0) <= target, true), ratio: 0, room: false };
    return null;
  };
  const commonOk = (scale: number) => {
    const c = ratesAt(scale)[0] / SCALE;
    return c >= TIERS[0].min - 1e-9 && c <= TIERS[0].max + 1e-9;
  };

  let scale = 1;
  let sol = solveAt(1);
  if (!sol) {
    if (!solveAt(0)) {
      scale = 0;
      sol = { commonNft: 0, ratio: 0, room: false };
      notes.push("even the thinnest rates overshoot the margin: the inventory is too dear for the price");
    } else {
      scale = bisect(0, 1, (s) => !!solveAt(s), true);
      sol = solveAt(scale)!;
      notes.push(`rarer rates thinned to ${(scale * 100).toFixed(1)}% of the reference to hold the margin`);
    }
  } else if (sol.room && sellOf(ladderAt(1, sol.commonNft, sol.ratio)) < target - tol) {
    const fits = (s: number) => {
      if (!commonOk(s)) return false;
      const x = solveAt(s);
      return !!x && sellOf(ladderAt(s, x.commonNft, x.ratio)) <= target;
    };
    scale = fits(2.5) ? 2.5 : bisect(1, 2.5, fits, true);
    sol = solveAt(scale)!;
    if (scale > 1) notes.push(`rarer rates raised to ${(scale * 100).toFixed(1)}% of the reference: every ladder was flat with margin to spare`);
  }
  if (sol.ratio === 0 && TIERS.some((t) => t.xrp.length > 1)) notes.push("every ladder sits on its cheapest rung to hold the margin");
  if (sol.ratio < G && sol.ratio > 0) notes.push(`ladders steepened to ${sol.ratio.toFixed(3)} a rung (cubes: ${G}) to hold the margin with Common's NFTs at their cap`);

  const ladder = ladderAt(scale, sol.commonNft, sol.ratio);
  const nftOdds = oddsFor(ladder, marks, sellBps);
  const e = itemEconomics(ladder, nftOdds, marks, sellBps);
  const table = prizeTableFor(ladder.tokenPrizes, false);
  const chances = TIERS.map((_, b) => nftChanceOf(ladder.bandBps, table, b));
  const stock = marks.map((m) => m.length);
  let places = 0;
  while (places < 500 && stockCovers(stock, places, ladder.bandBps, table, RARITY_SPEC.emptyBand)) places++;
  const sellMarginBps = Math.round((1 - e.allSell) * SCALE);
  const keepMarginBps = Math.round((1 - e.allKeep) * SCALE);
  const onMargin = Math.abs(sellMarginBps - input.marginBps) <= RARITY_SPEC.marginToleranceBps;
  if (!onMargin) notes.push(`sell margin ${(sellMarginBps / 100).toFixed(2)}% is off its ${(input.marginBps / 100).toFixed(2)}% target by more than ${RARITY_SPEC.marginToleranceBps / 100} points`);
  if (!commonOk(scale)) notes.push(`Common at ${(ladder.bandBps[0] / 100).toFixed(2)}% is outside ${TIERS[0].min * 100}-${TIERS[0].max * 100}%`);
  const thin = TIERS.filter((t) => marks[t.band].length && chances[t.band] === 0 && t.xrp.length).map((t) => t.label);
  if (thin.length) notes.push(`${thin.join(", ")}: too few NFTs to back ${RARITY_SPEC.minPlaces} places at any share, so its ladder pays every pull; restock that band`);
  const bare = TIERS.filter((t) => ladder.bandBps[t.band] > 0 && !items[t.band].length).map((t) => t.label);
  if (bare.length) notes.push(`${bare.join(", ")}: no rung under the ${cap} XRP cover cap and no NFT, so nothing to pay: raise the cap or stock the band`);
  const underGate = e.ceilingShare < RARITY_SPEC.gate;
  if (!underGate) notes.push(`the most a pull can sell back for on any pool, ${(e.ceilingShare * 100).toFixed(2)}%, isn't under the ${RARITY_SPEC.gate * 100}% line`);
  if (places < RARITY_SPEC.minPlaces) {
    const short = TIERS.filter((t) => marks[t.band].length && marks[t.band].length < lotsNeeded(RARITY_SPEC.minPlaces, nftChanceOf(ladder.bandBps, table, t.band))).map((t) => t.label);
    notes.push(`the pool backs ${places} open places, under ${RARITY_SPEC.minPlaces}: ${short.join(", ") || "a band"} needs more NFTs`);
  }
  return {
    version: RARITY_SPEC.version,
    priceXrp: P,
    bandBps: [...ladder.bandBps] as unknown as Five<number>,
    tokenPrizes: ladder.tokenPrizes,
    emptyBand: RARITY_SPEC.emptyBand,
    nftOdds,
    ceilingShare: e.ceilingShare,
    marks: marks.map((m) => [...m].sort((a, b) => a - b)) as unknown as Five<readonly number[]>,
    out,
    sellMarginBps,
    keepMarginBps,
    nftPerPull: e.nftPerPull,
    xrpPerPull: e.tokensPerPull,
    refundPerPull: e.refundPerPull,
    topRowXrp: ladder.tokenPrizes.reduce((a, r) => Math.max(a, r.xrp), 0),
    places,
    feasible: onMargin && commonOk(scale) && places >= RARITY_SPEC.minPlaces && !bare.length && underGate,
    notes,
  };
}

/** Why a ladder breaks the spec on this pool, or an empty list. The tests and the owner's season script ask this of a ladder before it opens. */
export function specBreaks(ladder: Ladder & { readonly nftOdds?: ItemOdds }, marksByBand: readonly (readonly number[])[], maxRowXrp = Infinity): string[] {
  const P = ladder.xrp;
  const out: string[] = [];
  if (ladder.bandBps.reduce((a, b) => a + b, 0) !== SCALE) out.push("rates don't add to 100%");
  TIERS.forEach((t, b) => {
    const rate = ladder.bandBps[b] / SCALE;
    const hasPrizes = (marksByBand[b]?.length ?? 0) > 0 || ladder.tokenPrizes.some((r) => r.band === b);
    if (hasPrizes && (rate < t.min - 1e-9 || rate > t.max + 1e-9)) out.push(`${t.label} at ${rate * 100}% is outside ${t.min * 100}-${t.max * 100}%`);
    const rows = ladder.tokenPrizes.filter((r) => r.band === b);
    if (rows.reduce((a, r) => a + r.bps, 0) > SCALE) out.push(`${t.label}'s rows take more than the band`);
    for (const v of [...rows.map((r) => r.xrp), ...(marksByBand[b] ?? [])]) if (bandOfValue(P, v) !== b) out.push(`${v} XRP (${(v / P).toFixed(3)}x) isn't ${t.label}`);
    for (const r of rows) if (r.xrp > maxRowXrp + 1e-9) out.push(`${r.xrp} XRP is over the ${maxRowXrp} XRP cover cap`);
    // The ladder never rises: a dearer rung is never likelier than a cheaper one, so the cheapest prize is the commonest.
    const sorted = [...rows].sort((a, c) => a.xrp - c.xrp);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].bps > sorted[i - 1].bps) out.push(`${t.label}'s ${sorted[i].xrp} XRP rung is likelier than its ${sorted[i - 1].xrp}`);
    const nftBps = SCALE - rows.reduce((a, r) => a + r.bps, 0);
    // Per-item odds: the likeliest NFT is the cheapest, at k / its mark. Otherwise every NFT has the band's share over its count.
    const marks = marksByBand[b] ?? [];
    const k = ladder.nftOdds?.kDrops[b];
    const each = !marks.length ? 0 : k !== undefined ? (k / drops(Math.min(...marks))) * SCALE : nftBps / marks.length;
    if (sorted.length && each > sorted[0].bps + 1) out.push(`a ${t.label} NFT is likelier than its cheapest rung`);
    if (ladder.nftOdds && marks.length && (ladder.nftOdds.capBps[b] ?? 0) !== nftBps) out.push(`${t.label}'s per-item cap isn't the share its rows leave`);
  });
  return out;
}
