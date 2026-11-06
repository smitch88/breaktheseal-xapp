import { EXCLUDED_COLLECTIONS, NFT_LADDERS, SHELF_PRICES } from "../config/nft-packs.ts";
import type { NftCollection } from "./nft/view.ts";
import { ART_ROUTE } from "./rip/art-paths.ts";

/** What the home hero's sample bite pulls out: real art that's really on the site. Still only a sample, nothing is drawn. */
export interface HeroSample {
  readonly kind: "card" | "nft";
  readonly img: string;
  readonly name: string;
}

const MAX_SAMPLES = 16;
const PER_COLLECTION = 2;
/** Owner, 2026-11-01: every SEAL but this one. */
const WITHHELD_NFT = /(^|[^0-9])449([^0-9]|$)/;

/** The collections on the shelf's packs, rarest band first, each once and never an excluded one. */
export function shelfCollections(): string[] {
  const out: string[] = [];
  for (const price of SHELF_PRICES) {
    for (const band of [...NFT_LADDERS[price].bands].reverse()) for (const slug of band) if (!out.includes(slug) && !EXCLUDED_COLLECTIONS.includes(slug)) out.push(slug);
  }
  return out;
}

const nftName = (collection: string, sample: string) => {
  const label = sample.trim();
  if (!label) return collection;
  if (/^[0-9]+$/.test(label)) return `${collection} #${label}`;
  return label.toLowerCase().includes(collection.toLowerCase()) ? label : `${collection}: ${label}`;
};

/** Card, NFT, card, NFT: slab photos from the packs and art from the NFT packs, as far as both last. */
export function heroSamples(input: { cards: readonly { readonly img: string; readonly name: string }[]; collections: Readonly<Record<string, NftCollection>> }): HeroSample[] {
  const seen = new Set<string>();
  const fresh = (img: string) => {
    if (!img || seen.has(img)) return false;
    seen.add(img);
    return true;
  };
  const cards: HeroSample[] = input.cards.filter((c) => c.name && fresh(c.img)).map((c) => ({ kind: "card", img: c.img, name: c.name }));
  const nfts: HeroSample[] = [];
  for (const slug of shelfCollections()) {
    const collection = input.collections[slug];
    if (!collection) continue;
    const usable = collection.samples.filter((s) => !WITHHELD_NFT.test(s.name) && fresh(s.img)).slice(0, PER_COLLECTION);
    for (const s of usable) nfts.push({ kind: "nft", img: s.img, name: nftName(collection.name, s.name) });
  }
  const out: HeroSample[] = [];
  for (let i = 0; out.length < MAX_SAMPLES && (i < cards.length || i < nfts.length); i++) {
    if (cards[i]) out.push(cards[i]);
    if (nfts[i] && out.length < MAX_SAMPLES) out.push(nfts[i]);
  }
  return out;
}

/** Rails on: the home hero's NFT art comes from what's really in the pools, in with the same card, NFT, card, NFT order. */
export function withLiveNfts(cards: readonly HeroSample[], live: readonly { readonly img: string; readonly name: string }[]): HeroSample[] {
  const nfts: HeroSample[] = [...new Map(live.map((n) => [n.img, { kind: "nft" as const, img: n.img, name: n.name }])).values()];
  const out: HeroSample[] = [];
  for (let i = 0; out.length < MAX_SAMPLES && (i < cards.length || i < nfts.length); i++) {
    if (cards[i]) out.push(cards[i]);
    if (nfts[i] && out.length < MAX_SAMPLES) out.push(nfts[i]);
  }
  return out;
}

/** The next one to show: never the same twice running, and a run through the list before any repeat. */
export const nextSample = (count: number, last: number): number => (count <= 0 ? -1 : (last + 1 + count) % count);

/** A slab photo, or an NFT's art fetched by the art route, goes through the site's image route; a saved NFT picture is already a small file of ours. */
export const sampleSrc = (s: Pick<HeroSample, "kind" | "img">): string => (s.kind === "card" || s.img.startsWith(ART_ROUTE) ? `/_next/image?url=${encodeURIComponent(s.img)}&w=640&q=75` : s.img);

/** A slab's full name can run to a whole line of grading detail: the status line takes the start of it, on a word. */
export function shortSampleName(name: string, max = 44): string {
  const text = name.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,:;/(-]+$/, "")}…`;
}
