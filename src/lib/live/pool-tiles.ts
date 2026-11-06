import { XRP_PRIZE_ART } from "../prize-art.ts";
import type { TierName } from "../rails/types.ts";

/** What one tile needs from the pool. Only the shape, so this works on any read of it. */
interface PoolNftIn {
  readonly id: string;
  readonly name: string;
  readonly collection: string;
  readonly img: string;
  readonly markXrp: number;
  /** On a season with per-item odds, this NFT's own chance per pull, in percent. */
  readonly pct?: number;
}
interface PoolPrizeIn {
  readonly xrp: number;
  readonly tokens: readonly string[];
  readonly pct: number;
}
interface PoolBandIn<N extends PoolNftIn> {
  readonly tier: string;
  readonly pct: number;
  readonly nftPct: number;
  readonly prizes: readonly PoolPrizeIn[];
  readonly nfts: readonly N[];
}

export type PoolTile<N extends PoolNftIn = PoolNftIn> =
  | { readonly kind: "nft"; readonly key: string; readonly tier: TierName; readonly value: number; readonly odds: string; readonly nft: N }
  | { readonly kind: "prize"; readonly key: string; readonly tier: TierName; readonly value: number; readonly odds: string; readonly name: string; readonly img: string; readonly tokens: readonly string[] };

const RARITY: readonly string[] = ["Chase", "Epic", "Rare", "Uncommon", "Common"];

/** Enough places that a small chance isn't rounded to nothing, and no trailing zeros. */
const pct = (n: number) => `${Number(n.toFixed(4))}%`;

const prizeName = (tokens: readonly string[]) => (tokens.length > 1 ? tokens.join(" or ") : `${tokens[0]} prize`);

/**
 * The whole pool as one list, rarest first and highest value first within a rarity. A band with nothing in it has no tiles. An NFT quotes its
 * band's chance and its place among that band's NFTs: a pull picks fairly among them, and giving one NFT a percentage of its own isn't a figure the draw publishes.
 * On a season with per-item odds the draw does publish one, so the NFT quotes its own.
 */
export function poolTiles<N extends PoolNftIn>(pool: { readonly bands: readonly PoolBandIn<N>[] }): PoolTile<N>[] {
  const rank = (t: string) => RARITY.indexOf(t);
  return [...pool.bands]
    .sort((a, b) => rank(a.tier) - rank(b.tier))
    .flatMap((b) => {
      const tier = b.tier as TierName;
      const nfts: PoolTile<N>[] = b.nfts.map((nft) => ({ kind: "nft", key: nft.id, tier, value: nft.markXrp, odds: nft.pct !== undefined ? `${tier}: ${pct(nft.pct)} of pulls are this NFT` : `${tier}: ${pct(b.nftPct)} of pulls are an NFT from this band, 1 of ${b.nfts.length}`, nft }));
      const prizes: PoolTile<N>[] = b.prizes.map((p, i) => ({ kind: "prize", key: `${tier}-${p.xrp}-${i}`, tier, value: p.xrp, odds: `${tier}: ${pct(p.pct)} of pulls pay this prize`, name: prizeName(p.tokens), img: p.tokens.includes("XRP") ? XRP_PRIZE_ART : "/assets/prize-seal.svg", tokens: p.tokens }));
      return [...nfts, ...prizes].sort((x, y) => y.value - x.value);
    });
}

/** A card pack's badge. Collector Crypt publishes each band's rate and draws the card itself, so it says that and no more. */
export const cardOdds = (tier: string, rate: number) => `${tier}: ${Number(rate.toFixed(4))}% of pulls land in this band`;
