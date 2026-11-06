import ART from "../../config/nft-art.json" with { type: "json" };
import { MAINNET_ID } from "./chain.ts";
import { ART_ROUTE } from "./art-paths.ts";
import { sha256Hex } from "./draw.ts";

/**
 * What a player sees for an NFT. The `img` in a pool_change is part of the public log's hash chain, so it stays as written
 * and a wrong one is corrected here, on the way out, by NFT id. Only pictures depend on this: draws, bands and replay never read it.
 */
export const TESTNET_PLACEHOLDER = "/assets/testnet-nft.webp";
export { NO_PICTURE } from "./art-paths.ts";

export interface NftArtRow {
  readonly img: string;
  readonly name: string | null;
  readonly uri: string;
  readonly media: string;
}
export const NFT_ART: Readonly<Record<string, NftArtRow>> = ART;

/** Where an NFT's own art lives under public/. */
export const artPathFor = (slug: string, nftId: string) => `/nfts/${slug}/${nftId.slice(-16).toLowerCase()}.webp`;

export { ART_ROUTE };
/**
 * The art route names an NFT by a hash of its id, not the id: the feed of recent pulls shows a picture and must not hand out the NFT it was,
 * which leads to the wallet that pulled it. Stable, so a picture is cached once.
 */
export const artKey = (nftId: string) => sha256Hex(`seal-art:${nftId.toUpperCase()}`).slice(0, 40);
export const artProxy = (nftId: string) => `${ART_ROUTE}${artKey(nftId)}`;

/** A link to somewhere else: https, IPFS or Arweave. A browser can't be trusted to load one (ipfs.io refuses browsers now), so it goes through the art route. */
export const isRemoteArt = (img: string) => /^(https|ipfs|ar):\/\//i.test(img.trim());

/** Is this picture the NFT's own? A file under /nfts/ is named after the NFT it shows, so a collection sample of another NFT isn't. An http(s) link came from its own metadata. */
export function isOwnArt(nftId: string, img: string): boolean {
  if (/^https:\/\//.test(img)) return true;
  return img.startsWith("/nfts/") && img.endsWith(`/${nftId.slice(-16).toLowerCase()}.webp`);
}

/**
 * The picture to show. A remote link always goes through the art route, on any network, so a browser never has to reach a gateway itself.
 * Off mainnet, anything else is exactly what the log says. On mainnet: the saved copy, else its own file, else the art route, which reads the NFT's
 * own metadata off the ledger. Never the testnet placeholder or a different NFT. When nothing loads, the page shows NO_PICTURE (NftImg).
 */
export function prizeImg(lot: { readonly nftId: string; readonly img: string }, networkId: number | null | undefined, art: Readonly<Record<string, Pick<NftArtRow, "img">>> = NFT_ART): string {
  if (networkId !== MAINNET_ID) return isRemoteArt(lot.img) ? artProxy(lot.nftId) : lot.img;
  const saved = art[lot.nftId]?.img;
  if (saved) return saved;
  return isOwnArt(lot.nftId, lot.img) && !isRemoteArt(lot.img) ? lot.img : artProxy(lot.nftId);
}

/** The name the kit and the buyer write when an NFT's metadata names nothing: its collection and the end of its id. */
export const fallbackName = (collection: string, nftId: string) => `${collection} #${nftId.slice(-6)}`;
/** A name made from the NFT's id rather than read from its metadata. Any name ending in the id's last six is one. */
export const isFallbackName = (lot: { readonly nftId: string; readonly name: string }) => lot.name.trim().toUpperCase().endsWith(`#${lot.nftId.slice(-6).toUpperCase()}`);
/** A name from metadata, as one line of plain text a page can show. */
export const cleanName = (name: string) => name.replace(/[^\p{L}\p{N} #.'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);

/** Names read from NFTs' own metadata on this server, by NFT id: src/lib/rip/nft-meta.ts fills it. Kept here so this file stays pure. */
export const LEARNED_NAMES = new Map<string, string>();
const learnedName = (nftId: string) => LEARNED_NAMES.get(nftId) ?? null;

/**
 * The name to show. Off mainnet, the log's. On mainnet: the saved art row's, then the name the NFT was registered with if that came from its metadata,
 * then the name its metadata has, read on this server. The id-made name only when the metadata has none, or can't be read yet.
 */
export function prizeTitle(lot: { readonly nftId: string; readonly name: string }, networkId: number | null | undefined, art: Readonly<Record<string, Pick<NftArtRow, "name">>> = NFT_ART, learned: (nftId: string) => string | null = learnedName): string {
  if (networkId !== MAINNET_ID) return lot.name;
  const saved = art[lot.nftId]?.name?.trim();
  if (saved) return saved;
  if (!isFallbackName(lot)) return lot.name;
  return learned(lot.nftId)?.trim() || lot.name;
}

export type ArtKind = "its own" | "collection sample" | "PLACEHOLDER";

/** Why --apply must stop: on mainnet every NFT goes in with its own picture unless the owner says otherwise. Null means go ahead. */
export function artRefusal(rows: readonly { readonly name: string; readonly art: ArtKind }[], network: string, allowed: boolean): string | null {
  if (network !== "mainnet" || allowed) return null;
  const bad = rows.filter((r) => r.art !== "its own");
  if (!bad.length) return null;
  return `${bad.length} NFT${bad.length === 1 ? " has" : "s have"} no picture of its own: ${bad.map((r) => `${r.name} (${r.art})`).join(", ")}.`;
}
