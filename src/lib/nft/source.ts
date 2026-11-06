import type { CachedGet } from "../catalog/source.ts";
import type { NftCollection, NftSnapshot } from "./view.ts";

/**
 * Market data from xrpl.to. Keyless calls are limited (30 a minute, about 300 a day), so runtime reads are one list call
 * and one rates call an hour, shared by every visitor, and everything else comes from the checked-in snapshot.
 */
export const XRPL_API = "https://api.xrpl.to/v1";
export const FLOORS_TTL_S = 3600;
export const RATE_TTL_S = 3600;
export const COLLECTIONS_URL = `${XRPL_API}/nft/collections?sort=vol30d&order=desc&limit=200&lightweight=true&skip_metrics=true`;
export const RATES_URL = `${XRPL_API}/stats/rates`;

export interface MarketView {
  readonly collections: NftSnapshot["collections"];
  readonly xrpUsd: number;
  /** True when any figure is the snapshot's rather than a live read. */
  readonly stale: boolean;
  readonly asOf: string;
}

/** `exch.USD` is XRP per dollar, so USD per XRP is its inverse. Returns null for anything unusable. */
export function parseXrpUsd(payload: unknown): number | null {
  const exch = (payload as { exch?: { USD?: unknown } } | null)?.exch?.USD;
  if (typeof exch !== "number" || !Number.isFinite(exch) || exch <= 0) return null;
  const usd = 1 / exch;
  return usd > 0.01 && usd < 1000 ? usd : null;
}

/** slug to live floor (XRP), for the collections the payload has. */
export function parseFloors(payload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rows = (payload as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const { slug, floor } = (row ?? {}) as { slug?: unknown; floor?: unknown };
    const value = typeof floor === "object" && floor !== null ? (floor as { amount?: unknown }).amount : floor;
    if (typeof slug === "string" && typeof value === "number" && Number.isFinite(value) && value > 0) out.set(slug, value);
  }
  return out;
}

/** Overlay live figures on the snapshot. Art always stays the snapshot's real, checked-in art. */
export async function readMarket(get: CachedGet, snapshot: NftSnapshot, picked: readonly string[]): Promise<MarketView> {
  const json = async (url: string, ttl: number): Promise<unknown> => {
    const res = await get(url, ttl);
    if (!res.ok) throw new Error(`xrpl.to ${res.status}`);
    return res.json();
  };
  // One after the other: xrpl.to's keyless limit is two calls a second.
  const floors = await json(COLLECTIONS_URL, FLOORS_TTL_S).then(parseFloors, () => new Map<string, number>());
  const rate = await json(RATES_URL, RATE_TTL_S).then(parseXrpUsd, () => null);
  const collections: Record<string, NftCollection> = {};
  let allLive = rate !== null;
  for (const [slug, c] of Object.entries(snapshot.collections)) {
    const live = floors.get(slug);
    collections[slug] = live ? { ...c, floor: live } : c;
    if (!live && picked.includes(slug)) allLive = false;
  }
  return { collections, xrpUsd: rate ?? snapshot.xrpUsd, stale: !allLive, asOf: snapshot.asOf };
}
