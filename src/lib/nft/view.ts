import { NFT_LADDERS, fiftyUpBps, isDustBand, isNftPrice, type NftPrice, type TokenPrizeRow } from "../../config/nft-packs.ts";
import { NFT_TIERS, type NftTier } from "./bands.ts";

export interface NftSample {
  readonly id: string;
  readonly name: string;
  /** Public path of the real art, resized from the NFT's own on-chain media. */
  readonly img: string;
}

export interface NftCollection {
  readonly slug: string;
  readonly name: string;
  readonly floor: number;
  readonly items: number | null;
  readonly samples: readonly NftSample[];
}

export interface NftSnapshot {
  readonly asOf: string;
  readonly xrpUsd: number;
  readonly collections: Readonly<Record<string, NftCollection>>;
}

export interface NftTierView {
  readonly tier: NftTier;
  readonly rate: number;
  readonly slug: string;
  readonly collection: NftCollection | null;
  /** How many other collections share this band. */
  readonly more: number;
  /** A band that pays only small XRP or SEAL prizes: their sizes in XRP, smallest first. Null if it holds NFTs. */
  readonly dustXrp: readonly number[] | null;
}

export interface NftPackView {
  readonly price: NftPrice;
  readonly name: string;
  readonly shortName: string;
  readonly art: string;
  /** The pack's price in whole XRP. */
  readonly xrp: number;
  readonly tiers: readonly NftTierView[];
  /** Token prizes: a share of a band's pulls pay XRP or SEAL instead of an NFT. */
  readonly tokenPrizes: readonly TokenPrizeRow[];
  /** Share of pulls landing on $50 or more at today's floors, in percent. */
  readonly fiftyUpPct: number;
  /** Every collection on the Chase band. */
  readonly chase: readonly string[];
  /** This season's token rows pay only XRP. */
  readonly xrpOnly?: boolean;
}

/** What the live pool holds, in the shape poolView gives it: only what a pack view needs. */
export interface LivePoolFacts {
  readonly bands: readonly {
    readonly pct: number;
    readonly nftPct: number;
    readonly prizes: readonly { readonly xrp: number; readonly tokens: readonly string[]; readonly pct: number }[];
    readonly nfts: readonly { readonly id: string; readonly name: string; readonly collection: string; readonly img: string; readonly markXrp: number }[];
  }[];
}

/** "The Bear Champ - Dead As Fuck" reads as "Bear Champ DAF" on the page. */
export const shortCollection = (n: string) => n.trim().replace(/ - Dead As Fuck$/, " DAF").replace(/^The Bear Champ/, "Bear Champ");

/** "76" in a collection called Bear Champ is "Bear Champ #76". */
export function nftTitle(collectionName: string, nftName: string): string {
  const n = String(nftName ?? "").trim();
  const base = shortCollection(collectionName);
  if (!n) return base;
  return /^#?\d+$/.test(n) ? `${base} #${n.replace("#", "")}` : n;
}

export function nftPack(price: NftPrice, collections: NftSnapshot["collections"]): NftPackView {
  const ladder = NFT_LADDERS[price];
  return {
    price,
    name: ladder.name,
    shortName: ladder.name.replace(" NFT Pack", ""),
    art: `/assets/pack-${ladder.art}.webp`,
    xrp: ladder.xrp,
    tokenPrizes: ladder.tokenPrizes,
    fiftyUpPct: fiftyUpBps(ladder) / 100,
    chase: ladder.bands[4],
    tiers: ladder.bands.map((band, i) => ({ tier: NFT_TIERS[i], rate: ladder.bandBps[i] / 100, slug: band[0] ?? "", collection: collections[band[0]] ?? null, more: Math.max(0, band.length - 1), dustXrp: isDustBand(ladder, i) ? ladder.tokenPrizes.filter((r) => r.band === i).map((r) => r.xrp).sort((a, b) => a - b) : null })),
  };
}

/**
 * The pack, with rails on, as the free demo should see it: this season's rates and rows and only NFTs really in the pool, none from the plan. A band with no
 * NFT and no token row is left out of the demo's roll, because the demo has nothing true to show for it.
 */
export function livePack(pack: NftPackView, pool: LivePoolFacts | null): NftPackView {
  const bands = pool?.bands ?? [];
  return {
    ...pack,
    fiftyUpPct: 0,
    chase: [],
    xrpOnly: bands.every((b) => b.prizes.every((p) => p.tokens.length === 1 && p.tokens[0] === "XRP")),
    tokenPrizes: bands.flatMap((b, band) => b.prizes.map((p) => ({ band, xrp: p.xrp, bps: Math.round((p.pct / b.pct) * 10_000) }))),
    tiers: NFT_TIERS.map((tier, i) => {
      const b = bands[i];
      const dust = !!b && b.nftPct === 0 && b.prizes.length > 0;
      const nfts = b?.nfts ?? [];
      const has = dust || nfts.length > 0;
      return {
        tier,
        rate: has ? b.pct : 0,
        slug: "",
        more: 0,
        dustXrp: dust ? b.prizes.map((p) => p.xrp) : null,
        collection: nfts.length ? { slug: "", name: nfts[0].collection, floor: nfts.reduce((a, n) => a + n.markXrp, 0) / nfts.length, items: null, samples: nfts.map((n) => ({ id: n.id, name: nftTitle(n.collection, n.name), img: n.img })) } : null,
      };
    }),
  };
}

export const parseNftPrice = (raw: string): NftPrice | null => {
  const n = Number(raw);
  return /^\d+$/.test(raw) && isNftPrice(n) ? n : null;
};
