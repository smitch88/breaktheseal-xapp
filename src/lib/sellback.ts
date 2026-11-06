/** Sell-back math, in whole cents and rounded down, so we never quote a fraction of a cent or round in the seller's disfavor twice. */
export const SELL_FEE_PERCENT = 2;
/** NFTs sell back at this share of floor. */
export const NFT_SELL_PERCENT = 97;

/** Insured value x instant sell-back, less the sell fee. $14 at 85% pays $11.66. */
export function cardSellBack(insured: number, instantBuybackPercent: number): number {
  const cents = Math.round(insured * 100);
  return Math.floor((cents * Math.round(instantBuybackPercent * 100) * (100 - SELL_FEE_PERCENT)) / 1_000_000) / 100;
}

/** Floor value x 97%, less the sell fee. */
export function nftSellBack(floorUsd: number): number {
  return Math.floor((Math.round(floorUsd * 100) * NFT_SELL_PERCENT * (100 - SELL_FEE_PERCENT)) / 10_000) / 100;
}

/** Collector Crypt's instant buyback closes about 72 hours after the pull. Its answer is what counts: this is only the clock we show. */
export const CARD_SELL_WINDOW_MS = 72 * 60 * 60 * 1000;

/** When a held card's sell window closes, or null if it has no window. */
export function cardSellUntil(c: { readonly gateway: string; readonly heldAt?: string | null }): string | null {
  if (c.gateway !== "collector-crypt" || !c.heldAt) return null;
  const at = Date.parse(c.heldAt);
  return Number.isFinite(at) ? new Date(at + CARD_SELL_WINDOW_MS).toISOString() : null;
}

/** What's left, in the two largest units, always rounded down so it never promises time that isn't there. Null once it has passed. */
export function sellWindowLeft(until: string, now: number): string | null {
  const ms = Date.parse(until) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "under a minute";
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

/**
 * The one muted line under a card's sell button: how long the instant sell-back is open, or, once it has passed with no price to show,
 * that it has closed. Null when there's nothing to say. Collector Crypt sets the window; the reveal's Details says so.
 */
export function sellWindowLine(until: string | null | undefined, now: number, priced: boolean): string | null {
  if (!until) return null;
  const left = sellWindowLeft(until, now);
  if (left) return `Sell-back closes in ${left}`;
  return priced ? null : "Sell-back closed. You can still ship it.";
}
