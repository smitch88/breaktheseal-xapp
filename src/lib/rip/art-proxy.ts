import { mediaUrls } from "../nft/media.ts";
import { safeGet, sniffImage, type ArtGet } from "./art-fetch.ts";
import { NFT_ART, artKey, isOwnArt, isRemoteArt } from "./nft-art.ts";
import { nftMeta, type NftUri } from "./nft-meta.ts";
import type { RipState } from "./state.ts";

/**
 * The picture for /api/rip/art/<artKey>. It serves only NFTs the public log has put in a pool, so it is no open proxy: the source is the link the
 * log holds for that NFT, then the picture its own metadata names. Each goes through every IPFS gateway in turn, a gateway that says 429 is left
 * alone a minute, and only bytes that really are a picture come back. With sharp to hand they come back as a webp no wider than 840.
 */
export const ART_IN_MAX = 12 * 1024 * 1024;
/** A function's response has to fit in 4.5 MB, so a picture sent as it is must be under this. */
export const ART_OUT_MAX = 4 * 1024 * 1024;
const KEY = /^[0-9a-f]{40}$/;
const BUDGET_MS = 20_000;

export type Shrink = (b: Buffer) => Promise<Buffer | null>;
export type ArtAnswer = { readonly kind: "picture"; readonly type: string; readonly body: Buffer } | { readonly kind: "saved"; readonly path: string } | { readonly kind: "none" };

/** Art keys to the lots the log holds them in, now or last, worked out again only when the log has moved. */
let keys: { state: RipState; head: number; size: number; byKey: Map<string, string> } | null = null;
function lotOf(s: RipState, key: string) {
  if (!keys || keys.state !== s || keys.head !== s.head || keys.size !== s.lots.size) {
    const byKey = new Map<string, string>();
    for (const l of s.lots.values()) byKey.set(artKey(l.nftId), l.lot);
    for (const [nftId, lot] of s.nftLot) byKey.set(artKey(nftId), lot);
    keys = { state: s, head: s.head, size: s.lots.size, byKey };
  }
  return s.lots.get(keys.byKey.get(key) ?? "") ?? null;
}

const resting = new Map<string, number>();
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

let sharpShrink: Shrink | null | undefined;
/** sharp when the server has it; else pictures go as they are. Same rules as scripts/nft-art.mjs: small pixel art scales up with hard edges. */
async function defaultShrink(): Promise<Shrink | null> {
  if (sharpShrink !== undefined) return sharpShrink;
  try {
    const sharp = (await import("sharp")).default;
    sharpShrink = async (buf) => {
      try {
        const meta = await sharp(buf, { animated: false, limitInputPixels: 64_000_000 }).metadata();
        const small = Math.max(meta.width ?? 0, meta.height ?? 0) < 210;
        return await sharp(buf, { animated: false, limitInputPixels: 64_000_000 }).resize(small ? 420 : 840, small ? 420 : 840, { fit: "inside", withoutEnlargement: !small, kernel: small ? "nearest" : "lanczos3" }).webp({ quality: 80, effort: 4 }).toBuffer();
      } catch {
        return null;
      }
    };
  } catch {
    sharpShrink = null;
  }
  return sharpShrink;
}

export async function serveArt(key: string, deps: { state: RipState; nftUri?: NftUri; get?: ArtGet; shrink?: Shrink | null; now?: () => number }): Promise<ArtAnswer> {
  if (!KEY.test(key)) return { kind: "none" };
  const lot = lotOf(deps.state, key);
  if (!lot) return { kind: "none" };
  const id = lot.nftId;
  const saved = NFT_ART[id]?.img;
  if (saved) return { kind: "saved", path: saved };
  const get = deps.get ?? safeGet;
  const now = deps.now ?? Date.now;
  const shrink = deps.shrink === undefined ? await defaultShrink() : deps.shrink;
  const stop = now() + BUDGET_MS;

  const picture = async (ref: string): Promise<ArtAnswer | null> => {
    for (const url of mediaUrls(ref)) {
      if (now() > stop) return null;
      if ((resting.get(hostOf(url)) ?? 0) > now()) continue;
      const got = await get(url, { maxBytes: ART_IN_MAX, timeoutMs: 8000 });
      if (got?.status === 429) resting.set(hostOf(url), now() + 60_000);
      if (got?.status !== 200) continue;
      const type = sniffImage(got.body);
      if (!type) continue;
      const small = shrink ? await shrink(got.body) : null;
      if (small) return { kind: "picture", type: "image/webp", body: small };
      if (got.body.length <= ART_OUT_MAX) return { kind: "picture", type, body: got.body };
    }
    return null;
  };

  // The log's own link first, when it is one: what the buyer or the kit read from this NFT's metadata.
  if (isRemoteArt(lot.img) && (isOwnArt(id, lot.img) || /^(ipfs|ar):\/\//i.test(lot.img))) {
    const got = await picture(lot.img);
    if (got) return got;
  }
  const meta = await nftMeta(id, deps.nftUri, get).catch(() => null);
  if (meta && meta.media !== lot.img) {
    const got = await picture(meta.media);
    if (got) return got;
  }
  return { kind: "none" };
}
