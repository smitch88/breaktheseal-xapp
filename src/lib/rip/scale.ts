import type { NftLadder } from "../../config/nft-packs.ts";
import { BANDS, lotsNeeded } from "./draw.ts";

/**
 * The arithmetic behind growing a pack, in pure code: scripts/scale-plan.mjs prints it from a live pool, and the targets in src/config/restock.ts are held to it.
 * Each band's numbers come from its committed rates and the marks in it. Nothing here is shown to a player.
 */

const SCALE = 10_000;

/** The chance one pull lands an NFT in each band. A band's token rows take their share first. */
export const nftChances = (l: Pick<NftLadder, "bandBps" | "tokenPrizes">): number[] => l.bandBps.map((bps, band) => (bps / SCALE) * Math.max(0, 1 - l.tokenPrizes.filter((r) => r.band === band).reduce((a, r) => a + r.bps, 0) / SCALE));

/**
 * How many NFTs each band should hold at `total`: today's stock, plus the rest shared out by how fast each band is pulled, so the bands run out together
 * instead of one shutting the pack early. Largest remainders settle the rounding. A band that pays only tokens gets none.
 */
export function targetsFor(l: Pick<NftLadder, "bandBps" | "tokenPrizes">, base: readonly number[], total: number): number[] {
  const chances = nftChances(l);
  const all = chances.reduce((a, c) => a + c, 0);
  const extra = total - base.reduce((a, b) => a + b, 0);
  if (extra <= 0 || all <= 0) return [...base];
  const shares = chances.map((c) => (extra * c) / all);
  const out = base.map((b, i) => b + Math.floor(shares[i]));
  let left = extra - shares.reduce((a, s) => a + Math.floor(s), 0);
  const byRemainder = shares.map((s, i) => [s - Math.floor(s), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    if (chances[i] > 0) {
      out[i] += 1;
      left -= 1;
    }
  }
  return out;
}

/** Open checkouts at once this stock can back under the rule in draw.ts: the band that gives out first decides. Stops counting at `limit`. */
export function placesBacked(stock: readonly number[], chances: readonly number[], limit = 500): number {
  for (let places = 1; places <= limit; places++) if (stock.some((n, band) => chances[band] > 0 && n < lotsNeeded(places, chances[band]))) return places - 1;
  return limit;
}

export interface PackEconomics {
  readonly priceXrp: number;
  /** Everything sold back, as a share of the price. */
  readonly allSell: number;
  /** Everything kept, with NFTs at their marks, as a share of the price. */
  readonly allKeep: number;
  /** XRP paid per pull in token rows, which leaves the treasury either way. */
  readonly tokensPerPull: number;
  /** XRP the vault spends per pull to replace what's kept, at marks. */
  readonly nftsPerPull: number;
  /** Standard deviation of one pull's payout, all sold back. */
  readonly sdPerPull: number;
  /** Treasury that keeps sell-backs from ever pausing, at this risk over any run of pulls, all sold back. From the classic ruin bound: sd^2 / (2 x edge) x ln(1/risk). */
  readonly coverAt: (risk: number) => number;
  /** The share if each band's cheapest NFTs had all left, down to its top mark. The pack would close on the gate well before this. */
  readonly worstShare: number;
  /** The top sell-back one pull can bring. */
  readonly topSale: number;
}

/** A pack's cash picture from the marks in each band. `sellShare` is what a sale pays of a mark, as a fraction. */
export function packEconomics(l: Pick<NftLadder, "xrp" | "bandBps" | "tokenPrizes">, marks: readonly (readonly number[])[], sellShare: number): PackEconomics {
  let allSell = 0;
  let allKeep = 0;
  let second = 0;
  let tokensPerPull = 0;
  let nftsPerPull = 0;
  let worst = 0;
  let topSale = 0;
  BANDS.forEach((_, band) => {
    const rate = l.bandBps[band] / SCALE;
    const rows = l.tokenPrizes.filter((r) => r.band === band);
    const tokenShare = rows.reduce((a, r) => a + r.bps, 0) / SCALE;
    const tokenValue = rows.reduce((a, r) => a + (r.bps / SCALE) * r.xrp, 0);
    tokensPerPull += rate * tokenValue;
    second += rate * rows.reduce((a, r) => a + (r.bps / SCALE) * r.xrp * r.xrp, 0);
    const ms = marks[band] ?? [];
    worst += rate * tokenValue;
    if (!ms.length) return;
    const avg = ms.reduce((a, m) => a + m, 0) / ms.length;
    const chance = rate * Math.max(0, 1 - tokenShare);
    nftsPerPull += chance * avg;
    allSell += chance * avg * sellShare;
    allKeep += chance * avg;
    second += (chance * ms.reduce((a, m) => a + (m * sellShare) ** 2, 0)) / ms.length;
    worst += chance * Math.max(...ms) * sellShare;
    topSale = Math.max(topSale, Math.max(...ms) * sellShare);
  });
  allSell += tokensPerPull;
  allKeep += tokensPerPull;
  const sd = Math.sqrt(second - allSell ** 2);
  const edge = l.xrp - allSell;
  return { priceXrp: l.xrp, allSell: allSell / l.xrp, allKeep: allKeep / l.xrp, tokensPerPull, nftsPerPull, sdPerPull: sd, coverAt: (risk) => (edge > 0 ? ((sd * sd) / (2 * edge)) * Math.log(1 / risk) : Infinity), worstShare: worst / l.xrp, topSale };
}

/**
 * How many of the cheapest NFTs would have to leave the pool, kept and not sold back, before the sell-back share passes the gate and the pack closes. Each step takes
 * whichever single NFT moves the share most. Null if it can't get there. The more NFTs a band holds, the further this is.
 */
export function keepsToGate(l: Pick<NftLadder, "xrp" | "bandBps" | "tokenPrizes">, marks: readonly (readonly number[])[], sellShare: number, gate = 0.95): number | null {
  const pools = marks.map((m) => [...m].sort((a, b) => a - b));
  let count = 0;
  while (packEconomics(l, pools, sellShare).allSell <= gate) {
    let best = -1;
    let bestShare = -Infinity;
    pools.forEach((p, band) => {
      if (p.length < 2) return;
      const trial = pools.map((x, i) => (i === band ? x.slice(1) : x));
      const share = packEconomics(l, trial, sellShare).allSell;
      if (share > bestShare) {
        bestShare = share;
        best = band;
      }
    });
    if (best < 0) return null;
    pools[best] = pools[best].slice(1);
    count += 1;
  }
  return count;
}

/** XRP of NFT pages: an NFT page holds up to 32 NFTs, 16 in the worst case, and each page locks 0.2 XRP of reserve. */
export const pageReserveXrp = (nfts: number) => Math.ceil(nfts / 16) * 0.2;
