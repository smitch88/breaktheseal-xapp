/**
 * One pull's outcome against what its pack cost: what the player can get back for it right now, over the exact price of that one pack.
 * It's a per-pull fact only. It never says anything about odds, return or what a pack is expected to give.
 *
 * - A card or an NFT counts its sell-back offer. An XRP prize counts its XRP. Anything else, or anything not priced yet, has no multiple.
 * - The price is the one pack's: a multi order's per-pack price, not its total.
 * - It rounds down, so it never says more than the player would get.
 */
export interface PullMultiple {
  readonly ratio: number;
  /** "1.43×", "0.85×", "12.4×", "140×". */
  readonly text: string;
  /** At or above what the pack cost. */
  readonly up: boolean;
}

/** Both sides in millionths, so XRP read from drops divides exactly and float noise can't push 1× under. */
const micro = (n: number) => Math.round(n * 1e6);

const fixedDown = (ratio: number, places: number) => {
  const f = 10 ** places;
  // A hair over, so 1.43 doesn't floor to 1.42 because 1.43 * 100 lands on 142.99999.
  return (Math.floor(ratio * f + 1e-9) / f).toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
};

/** Two places under 10×, one under 100×, whole above. Under 0.01× it says so instead of a broken-looking 0.00×. */
export function multipleText(ratio: number): string {
  if (ratio < 0.01) return "<0.01×";
  if (ratio < 10) return `${fixedDown(ratio, 2)}×`;
  if (ratio < 100) return `${fixedDown(ratio, 1)}×`;
  return `${fixedDown(ratio, 0)}×`;
}

/** Null when either side isn't a real, positive amount yet: no badge beats a guess. */
export function pullMultiple(back: number | null | undefined, paid: number | null | undefined): PullMultiple | null {
  if (typeof back !== "number" || typeof paid !== "number" || !Number.isFinite(back) || !Number.isFinite(paid)) return null;
  const b = micro(back);
  const p = micro(paid);
  if (b <= 0 || p <= 0) return null;
  const ratio = b / p;
  return { ratio, text: multipleText(ratio), up: b >= p };
}

/** A whole order: everything it can get back over every pack's price. Only once every pull in it is priced, or there's no total. */
export function totalMultiple(backs: readonly (number | null | undefined)[], each: number | null | undefined): PullMultiple | null {
  if (!backs.length || typeof each !== "number") return null;
  let sum = 0;
  for (const b of backs) {
    if (typeof b !== "number" || !Number.isFinite(b) || micro(b) <= 0) return null;
    sum += micro(b);
  }
  return pullMultiple(sum / 1e6, (micro(each) * backs.length) / 1e6);
}

/** What a real NFT pull can get back now, in XRP: an XRP prize's own XRP, else the sell-back offer the server quoted. */
export function orderBackXrp(o: { readonly sellXrp: number | null; readonly prize: { readonly token: string; readonly valueXrp: number } | null }): number | null {
  if (o.prize?.token === "XRP") return o.prize.valueXrp;
  return o.sellXrp;
}

/** The same rule for an award alone, in its own units: the demo's are dollars, against a pack price in dollars. */
export function awardBack(a: { readonly token?: string; readonly value: number; readonly sell: number }): number | null {
  if (a.token === "XRP") return a.value;
  return a.sell > 0 ? a.sell : null;
}
