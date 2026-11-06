import { MAINNET_ID } from "./chain.ts";
import { readNftMeta, safeGet, type ArtGet, type NftMeta } from "./art-fetch.ts";
import { LEARNED_NAMES, NFT_ART, cleanName, isFallbackName } from "./nft-art.ts";
import type { RipState } from "./state.ts";

/**
 * NFTs' own metadata, read from the ledger's URI on this server and kept for the life of the instance. Only NFTs whose art can't change go in a pool,
 * so a read that worked is good for ever. One that failed is asked again after an hour, so a dead gateway costs one ledger read an hour, not one a page.
 */
export type NftUri = (nftId: string) => Promise<{ readonly uri: string | null }>;

const FAILED_AGAIN_MS = 60 * 60_000;
const known = new Map<string, { meta: NftMeta | null; until: number }>();
const asking = new Map<string, Promise<NftMeta | null>>();

export async function nftMeta(nftId: string, nftUri: NftUri | undefined, get: ArtGet = safeGet, now = Date.now()): Promise<NftMeta | null> {
  const k = known.get(nftId);
  if (k && (k.meta || k.until > now)) return k.meta;
  if (!nftUri) return null;
  const open = asking.get(nftId);
  if (open) return open;
  const ask = (async () => {
    const uri = (await nftUri(nftId).catch(() => null))?.uri ?? null;
    const meta = uri ? await readNftMeta(uri, get).catch(() => null) : null;
    known.set(nftId, { meta, until: now + FAILED_AGAIN_MS });
    const name = meta?.name ? cleanName(meta.name) : "";
    if (name) LEARNED_NAMES.set(nftId, name);
    return meta;
  })().finally(() => asking.delete(nftId));
  asking.set(nftId, ask);
  return ask;
}

/** Mainnet NFTs in the log that were registered under an id-made name and have no saved name. These are the ones worth a metadata read. */
export function unnamedLots(s: RipState): string[] {
  if (s.genesis?.networkId !== MAINNET_ID) return [];
  const out = new Set<string>();
  for (const l of s.lots.values()) if (isFallbackName(l) && !NFT_ART[l.nftId]?.name?.trim() && !LEARNED_NAMES.has(l.nftId)) out.add(l.nftId);
  return [...out];
}

/**
 * Before a page shows NFT names: read the metadata of any that only have an id-made name, a few at a time, for at most `budgetMs`. What
 * isn't back by then is still asked for, and the next page shows it. Never throws, and never holds a page up longer than the budget.
 */
export async function learnNames(s: RipState, nftUri: NftUri | undefined, opts: { budgetMs?: number; most?: number; get?: ArtGet } = {}): Promise<void> {
  if (!nftUri) return;
  const now = Date.now();
  const ids = unnamedLots(s).filter((id) => !((known.get(id)?.until ?? 0) > now)).slice(0, opts.most ?? 8);
  if (!ids.length) return;
  const all = Promise.all(ids.map((id) => nftMeta(id, nftUri, opts.get).catch(() => null)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise((r) => (timer = setTimeout(r, opts.budgetMs ?? 1500)))]);
  clearTimeout(timer);
}

/** For tests: forget everything read. */
export function forgetMeta() {
  known.clear();
  asking.clear();
  LEARNED_NAMES.clear();
}
