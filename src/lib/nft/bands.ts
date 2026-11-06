/**
 * The bands of an NFT pack. Every pull rolls these same rates on its own, whatever came before it, so there is no deck to
 * count and nothing to time. The real draw's rates live in src/lib/rip/draw.ts and a test keeps the two equal.
 */
export const NFT_TIERS = ["Common", "Uncommon", "Rare", "Epic", "Chase"] as const;
export type NftTier = (typeof NFT_TIERS)[number];

/** Rarity rates, in percent. */
export const NFT_RATES: readonly number[] = [66, 24, 7, 2, 1];
/** Target prize value per band, as a multiple of the pack price. */
export const TIER_TARGETS: readonly number[] = [0.4, 0.8, 1.8, 5, 15];

/** Prize value a band aims for at a given pack price. */
export const targetFor = (price: number, tierIndex: number) => price * TIER_TARGETS[tierIndex];

/** What the bands aim to pay per pack at the given per-band values, divided by the pack price. Internal math only. */
export function bandPrizeShare(price: number, tierValues: readonly number[]): number {
  return tierValues.reduce((sum, v, i) => sum + (v * NFT_RATES[i]) / 100, 0) / price;
}
