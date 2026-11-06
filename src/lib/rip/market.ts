import { safeFetch } from "./art-fetch.ts";
import { NFT_ART } from "./nft-art.ts";
import { mediaUrls } from "../nft/media.ts";

/**
 * What the market says about one collection, for the restocker's floor checks. It's an indexer's word, so it never decides a payment by itself:
 * a buy is read again from the ledger before anything signs, and a re-add can only bring a mark down.
 */
export interface MarketListing {
  readonly nftId: string;
  readonly drops: number;
  /** Who holds it, by the indexer. Null if it doesn't say. */
  readonly holder: string | null;
}
export interface MarketSale {
  readonly nftId: string;
  readonly drops: number;
  readonly buyer: string;
  readonly seller: string;
  readonly at: number;
}
export interface MarketRead {
  readonly slug: string;
  readonly at: number;
  /** Cheapest first, in XRP. */
  readonly listings: readonly MarketListing[];
  /** Newest first. */
  readonly sales: readonly MarketSale[];
}
export interface MarketReader {
  /** Null if it can't be read right now. Never throws for a bad answer. */
  read(slug: string): Promise<MarketRead | null>;
  /** Whether a read of this collection would come from what's already held, costing the indexer nothing. */
  cached?(slug: string): boolean;
}

const API = "https://api.xrpl.to/v1";
/** Keyless xrpl.to allows about 300 calls a day and some routes 7 a minute: a read costs two calls, a read is good for half an hour, and this stops short of the day's limit. */
const TTL_MS = 30 * 60_000;
const DAILY_CALLS = 250;
const PER_MINUTE = 6;
const SERVER_ERROR_REST_MS = 5 * 60_000;

/** Data by xrpl.to. Numbers read here decide things and aren't shown or re-served; see the note on their terms in the go-live doc. */
export function xrplToMarket(opts: { fetchImpl?: typeof fetch; now?: () => number; dailyCalls?: number; ttlMs?: number; api?: string; perMinute?: number } = {}): MarketReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const limit = opts.dailyCalls ?? DAILY_CALLS;
  const ttl = opts.ttlMs ?? TTL_MS;
  const cache = new Map<string, MarketRead>();
  let day = "";
  let used = 0;
  let restingUntil = 0;
  let thisMinute = 0;
  let usedThisMinute = 0;

  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= limit || now() < restingUntil) return null;
    const minute = Math.floor(now() / 60_000);
    if (minute !== thisMinute) {
      thisMinute = minute;
      usedThisMinute = 0;
    }
    if (usedThisMinute >= (opts.perMinute ?? PER_MINUTE)) return null;
    usedThisMinute += 1;
    used += 1;
    try {
      const res = await fetchImpl((opts.api ?? API) + path, { headers: { Accept: "application/json", "User-Agent": "seal-rips/0.1" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (res.status === 429) {
        restingUntil = now() + (Number(res.headers.get("retry-after")) || 60) * 1000;
        return null;
      }
      if (!res.ok) {
        if (res.status >= 500) restingUntil = now() + SERVER_ERROR_REST_MS;
        return null;
      }
      const body = (await res.json()) as Record<string, unknown>;
      // A rate limit can also arrive as HTTP 200 with success: false.
      return body?.success === false ? null : body;
    } catch {
      return null;
    }
  };

  return {
    cached(slug) {
      const held = cache.get(slug);
      return !!held && now() - held.at < ttl;
    },
    async read(slug) {
      const held = cache.get(slug);
      if (held && now() - held.at < ttl) return held;
      const q = encodeURIComponent(slug);
      const [sold, listed] = await Promise.all([get(`/nft/collections/${q}/history?type=SALE&limit=100`), get(`/nft/collections/${q}/nfts?listed=xrp&sort=price-low&limit=12&lightweight=true`)]);
      if (!sold || !listed) return null;
      const read = parseMarket(slug, sold, listed, now());
      cache.set(slug, read);
      return read;
    },
  };
}

const NFT_ID = /^[0-9A-Fa-f]{64}$/;
/** An XRP figure as whole drops, or null: a price that rounds to nothing, or one too big to be a price, isn't one. */
const dropsOf = (xrp: unknown): number | null => {
  const drops = Math.round(Number(xrp) * 1e6);
  return Number.isSafeInteger(drops) && drops >= 1 ? drops : null;
};

/** Everything the indexer sends is checked for shape here. Anything else is left out, and the verdict sees a thinner market. Ids come out as the ledger writes them, since the log and the vault's own list are compared by exact text. */
export function parseMarket(slug: string, sold: Record<string, unknown>, listed: Record<string, unknown>, at: number): MarketRead {
  const sales: MarketSale[] = [];
  for (const h of (sold.history as Record<string, unknown>[] | undefined) ?? []) {
    const drops = dropsOf(h?.costXRP);
    // A sale from the future would count as recent for ever.
    if (h?.type !== "SALE" || typeof h.buyer !== "string" || typeof h.seller !== "string" || typeof h.NFTokenID !== "string" || !NFT_ID.test(h.NFTokenID) || drops === null || !(Number(h.time) > 0) || Number(h.time) > at) continue;
    sales.push({ nftId: h.NFTokenID.toUpperCase(), drops, buyer: h.buyer, seller: h.seller, at: Number(h.time) });
  }
  const listings: MarketListing[] = [];
  for (const n of (listed.nfts as Record<string, unknown>[] | undefined) ?? []) {
    const cost = n?.cost as { currency?: unknown; amount?: unknown } | undefined;
    const drops = dropsOf(cost?.amount);
    if (typeof n?.NFTokenID !== "string" || !NFT_ID.test(n.NFTokenID) || cost?.currency !== "XRP" || drops === null) continue;
    listings.push({ nftId: n.NFTokenID.toUpperCase(), drops, holder: typeof n.account === "string" ? n.account : null });
  }
  listings.sort((a, b) => a.drops - b.drops);
  sales.sort((a, b) => b.at - a.at);
  return { slug, at, listings, sales };
}

export interface LiveArt {
  readonly img: string;
  readonly name: string | null;
}
/** The NFT's own picture, or null. An NFT without one never goes in a pool. */
export type ArtResolver = (uri: string | null, nftId: string) => Promise<LiveArt | null>;

/**
 * The NFT's own art from its on-ledger URI, through whichever gateway answers, the way 07-register-inventory does. A server can't save a file, so the
 * log holds that link, and players see it through the art route (/api/rip/art), which fetches it for them. Running scripts/nft-art.mjs later
 * pins a local copy, and prizeImg prefers it, by NFT id. Metadata is anyone's to write, so the default fetch keeps to public https (art-fetch.ts).
 */
export function liveArtResolver(fetchImpl: typeof fetch = safeFetch()): ArtResolver {
  const get = async (url: string) => fetchImpl(url, { headers: { "User-Agent": "seal-rips/0.1" }, signal: AbortSignal.timeout(8000), redirect: "follow", cache: "no-store" }).catch(() => null);
  const isImage = (res: Response | null) => !!res?.ok && (res.headers.get("content-type") ?? "").startsWith("image/");

  const picture = async (media: string): Promise<string | null> => {
    for (const url of mediaUrls(media)) if (isImage(await get(url))) return url;
    return null;
  };

  return async (uri, nftId) => {
    const pinned = NFT_ART[nftId];
    if (pinned) return { img: pinned.img, name: pinned.name };
    if (!uri) return null;
    const inline = /^data:application\/json[^,]*,(.*)$/s.exec(uri);
    if (inline) {
      try {
        const meta = JSON.parse(decodeURIComponent(inline[1])) as { image?: unknown; name?: unknown };
        const img = typeof meta.image === "string" ? await picture(meta.image) : null;
        return img ? { img, name: typeof meta.name === "string" ? meta.name : null } : null;
      } catch {
        return null;
      }
    }
    for (const url of mediaUrls(uri)) {
      const res = await get(url);
      if (!res?.ok) continue;
      if (isImage(res)) return { img: url, name: null };
      try {
        const meta = JSON.parse(await res.text()) as Record<string, unknown>;
        const media = [meta.image, meta.image_url, meta.imageUrl].find((m): m is string => typeof m === "string" && !!m);
        if (!media) continue;
        const img = await picture(media);
        return img ? { img, name: typeof meta.name === "string" ? meta.name : null } : null;
      } catch {
        // The next gateway may answer with the real thing.
      }
    }
    return null;
  };
}
