/** Display helpers shared by server and client. */
const NBSP = "\u00a0";

const number = (n: number, min: number, max: number) => n.toLocaleString("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

/** $25 or $25.50: cents only when the amount has them. */
export const usd = (n: number) => "$" + number(n, n % 1 ? 2 : 0, 2);
/** Always two decimals: $25.00. */
export const usd2 = (n: number) => "$" + number(n, 2, 2);
/** A dollar amount in XRP at the given rate (USD per XRP). */
export const xrpOf = (usdAmount: number, xrpUsd: number) => number(usdAmount / xrpUsd, 2, 2);
export const whole = (n: number) => number(Math.round(n), 0, 0);

/** Glue the last two words together so a wrapped line never ends in one lonely word. */
export function noOrphan(text: string): string {
  const t = text.trim();
  const i = t.lastIndexOf(" ");
  return i < 0 ? t : t.slice(0, i) + NBSP + t.slice(i + 1);
}

/** A pack in a narrow picker: the price leads, so running out of room can only cut the name. */
export const packLabel = (name: string, price: number) => `${usd(price)} · ${name}`;

/**
 * One pull's own value against what its pack cost, to one decimal: "3.4x", "0.6x". The value is Award.value, which is the
 * insured value for a card and the floor in USD for an NFT. Null when there's no real number to show. A value too small to
 * reach a tenth still reads 0.1x, because "0.0x" would look broken.
 */
export function winMultiple(value: number, paid: number): string | null {
  if (!(value > 0) || !(paid > 0)) return null;
  const ratio = value / paid;
  if (!Number.isFinite(ratio)) return null;
  return `${number(Math.max(1, Math.round(ratio * 10)) / 10, 1, 1)}x`;
}

export const tidy = (s: string) => String(s).replace(/\s+/g, " ").trim();

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : DATE.format(d);
};

/** rHb9CJ...kT4, for a wallet chip. */
export const shortAddress = (a: string | null | undefined) => {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-3)}` : a;
};
