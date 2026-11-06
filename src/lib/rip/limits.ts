/**
 * The brakes on the routes that act for a player, by purpose. A quote or a status look ("read") and a press that moves something ("act")
 * each have their own budget per account, so a page asking for prices can never use up the one sale a player pressed for. Under both sits
 * a looser ceiling per connection, for floods. Per function instance and in memory, like every other brake here: rough, not a ledger.
 */
export type Purpose = "read" | "act";

export const RATE_WINDOW_MS = 60_000;
/** Per connection, whoever it says it is. Several people on one carrier or one Wi-Fi share an address, so this is only for floods. */
export const IP_LIMIT = 300;
/** Per account: quotes and status looks. A results page prices each card once and a sheet asks once, so this is a lot of headroom. */
export const READ_LIMIT = 120;
/** Per account: presses that move something. Nobody presses Sell thirty times a minute. */
export const ACT_LIMIT = 30;

export interface Limiter {
  /** Spend one from every bucket named, only if all of them have room. A refused try spends nothing, so it can't lock anyone out longer. */
  take(buckets: readonly { readonly key: string; readonly limit: number }[], now?: number): boolean;
}

export function createLimiter(windowMs = RATE_WINDOW_MS, maxKeys = 5000): Limiter {
  const hits = new Map<string, number[]>();
  return {
    take(buckets, now = Date.now()) {
      const recent = buckets.map((b) => (hits.get(b.key) ?? []).filter((t) => now - t < windowMs));
      if (buckets.some((b, i) => recent[i].length >= b.limit)) {
        buckets.forEach((b, i) => hits.set(b.key, recent[i]));
        return false;
      }
      if (hits.size > maxKeys) hits.clear();
      buckets.forEach((b, i) => hits.set(b.key, [...recent[i], now]));
      return true;
    },
  };
}

/** The ceiling per connection, spent before anyone is known. */
export const ipBucket = (ip: string) => ({ key: `rip:ip:${ip}`, limit: IP_LIMIT });

/**
 * The account's own budget for this purpose. A signed-in account is keyed by its address. An unproven launch can name any account, so it's
 * keyed by that account on this connection only: a stranger naming someone else's address can't spend that person's budget.
 */
export function accountBucket(ip: string, who: { readonly address: string; readonly proven: boolean }, purpose: Purpose) {
  return { key: `rip:${purpose}:${who.proven ? who.address : `${who.address}@${ip}`}`, limit: purpose === "read" ? READ_LIMIT : ACT_LIMIT };
}

/** How long a sheet waits before it asks once more by itself. Nothing was done the first time, so asking again is safe. */
export const RETRY_AFTER_S = 5;

/** How a route's body says what it's for: a quote or a status look reads; anything else acts. */
export type PurposeOf = Purpose | ((body: Record<string, unknown> | null) => Purpose);
export const quoteUnless = (field: string): PurposeOf => (b) => (b && b[field] !== undefined ? "act" : "read");
