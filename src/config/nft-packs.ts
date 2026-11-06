/**
 * NFT pack ladders. This is the one file to edit when the owner makes final collection picks.
 *
 * `bands` lists the collections each band's pool is meant to hold, in rarity order: Common, Uncommon, Rare, Epic, Chase.
 * The first slug in a band is that band's primary, the one the pack page shows art for. Every collection in a band shares
 * the band's rarity rate: a pull lands on a band first, then on one NFT picked fairly from everything in that band's pool.
 * The shelf's bands are the launch collections from the 2026-11-01 plan (plan2.py, plan/buy-list.json in the plan folder).
 * deploy/lib.mjs refuses a plan whose rates and prize rows differ from these, because a season commits to them on the ledger.
 * On $10, Common holds no NFTs: every Common pull pays dust, a small XRP or SEAL prize. From season 5-6, $5's bands are value tiers cut by
 * src/lib/rip/rarity-spec.ts, and its Common holds NFTs beside XRP rows, all worth 0.5x to 1.2x the pack.
 *
 * `xrp` is the pack's price in whole XRP. It holds for a season, because floors are in XRP. The dollar sticker is a label.
 *
 * After changing a primary, run `pnpm snapshot:nfts <slug>` so its floor and real sample art are checked in. `pnpm test`
 * fails if a primary has no real art in the snapshot, or if any collection is on the exclusion list. The restock tool
 * refuses any single NFT that can't reach a player, or that its issuer could burn in our vault.
 */
export const NFT_PRICES = [5, 10, 25, 50, 100] as const;
export type NftPrice = (typeof NFT_PRICES)[number];

/** Owner, 2026-11-01: only packs under $50 are on the shelf, and of those only $5 and $10 for now ($25 is `offered: false`). */
export const SHELF_UNDER_USD = 50;

/**
 * A prize paid in a token instead of an NFT, by band: `bps` of that band's pulls land here, worth `xrp` struck at the draw.
 * XRP pays its face. The SEAL token takes half of a row when it is on; while it's off the whole row pays XRP, so the math holds.
 */
export interface TokenPrizeRow {
  readonly band: number;
  readonly bps: number;
  readonly xrp: number;
  /** A small prize. Its SEAL half pays the same value in XRP to a wallet whose SEAL trust line is missing or too small to hold it. Committed with the season. */
  readonly dust?: true;
}

export interface NftLadder {
  readonly name: string;
  /** public/assets/pack-<art>.webp */
  readonly art: string;
  /** Pack price in whole XRP. */
  readonly xrp: number;
  /** On the shelf. Built packs stay here switched off rather than deleted, and nothing can sell while this is false. */
  readonly offered: boolean;
  /** Rarity rates in basis points, Common to Chase. Each season commits to these on the ledger. */
  readonly bandBps: readonly [number, number, number, number, number];
  /** The first band whose prizes are all worth $50 or more at today's floors. Null if there isn't one. */
  readonly fiftyUpFromBand: number | null;
  /** Token prizes, by band. Empty means every pull is an NFT. */
  readonly tokenPrizes: readonly TokenPrizeRow[];
  /** "rows": a band whose NFTs run out pays its XRP rows on its NFT share, and the pack keeps selling. Committed with the season. Unset: refunded whole. */
  readonly emptyBand?: "rows";
  /** Per-item NFT odds (ItemOdds in src/lib/rip/draw.ts): each NFT its own share, k / its mark, the rest to the band's ladder. Committed with the season. */
  readonly nftOdds?: { readonly kDrops: readonly number[]; readonly capBps: readonly number[]; readonly excessDrops: readonly number[] };
  /**
   * The SEAL this pack wants on hand, valued in XRP. The owner refills as prizes are won, by hand: start with `startXrp`,
   * get an alert under `lowXrp`, top up by `refillXrp` at a time. Under one biggest prize the pack pauses, nothing charged.
   */
  readonly sealFloat: { readonly startXrp: number; readonly lowXrp: number; readonly refillXrp: number };
  /** Collection slugs per band: Common, Uncommon, Rare, Epic, Chase. The first in each is the primary. */
  readonly bands: readonly [readonly string[], readonly string[], readonly string[], readonly string[], readonly string[]];
}

/** Never use these. `seals` and `seal-scrolls` are the V1 collections; SEAL V2 is `seal-on-xrpl-cto`. */
export const EXCLUDED_COLLECTIONS: readonly string[] = ["seals", "seal-scrolls"];

/**
 * Season 5-4's $5 rates and XRP rows, as committed on the ledger on 2026-11-02 (4 Panthers in Rare, a Scroll V2 in Chase): Rare 2.5% to 2.1%, Chase 0.4%
 * to 0.28%, the difference to Common. History, for the tests that check 5-5 against it. Nothing opens a season from this.
 */
export const SEASON_5_4: Pick<NftLadder, "xrp" | "bandBps" | "tokenPrizes" | "emptyBand" | "nftOdds"> = {
  xrp: 4,
  // Spread over today's ladder, it stays what it was: an empty band refunds.
  emptyBand: undefined,
  nftOdds: undefined,
  bandBps: [7448, 2000, 210, 314, 28],
  tokenPrizes: [
    { band: 0, bps: 6000, xrp: 1, dust: true },
    { band: 0, bps: 3300, xrp: 2, dust: true },
    { band: 0, bps: 700, xrp: 4, dust: true },
    { band: 1, bps: 2500, xrp: 3 },
    { band: 2, bps: 1500, xrp: 8 },
    { band: 3, bps: 5000, xrp: 42 },
  ],
};

/**
 * Season 5-5's $5 rates and XRP rows, as committed on the ledger on 2026-11-03: every NFT worth the same per pull on the rebuy's pool, Common all dust at 1, 2
 * and 4 XRP. History, for the tests that check 5-6 against it and for a plan made before 5-6 opened. Nothing opens a season from this.
 */
export const SEASON_5_5: Pick<NftLadder, "xrp" | "bandBps" | "tokenPrizes" | "emptyBand" | "nftOdds"> = {
  xrp: 4,
  emptyBand: undefined,
  nftOdds: undefined,
  bandBps: [5348, 3456, 1112, 67, 17],
  tokenPrizes: [
    { band: 0, bps: 6000, xrp: 1, dust: true },
    { band: 0, bps: 3300, xrp: 2, dust: true },
    { band: 0, bps: 700, xrp: 4, dust: true },
    { band: 1, bps: 2500, xrp: 3 },
    { band: 2, bps: 1500, xrp: 8 },
    { band: 3, bps: 4000, xrp: 42 },
  ],
};

export const NFT_LADDERS: Readonly<Record<NftPrice, NftLadder>> = {
  5: {
    name: "Copper NFT Pack",
    art: "n5",
    xrp: 4,
    offered: true,
    // Season 5-6, owner 2026-11-05: "commons hits between .5x-1.2x nothing at .25x", odds shaped like the Collector Crypt packs, as cubes.fun did, at
    // cubes.fun's 6.4% sell-path margin (5-5 ran 9.55% on this pool), "more XRP ladders ... across all tiers", and "Common nfts held shouldn't close
    // the pack". Cut by cutRarityLadder (src/lib/rip/rarity-spec.ts) from the $5 pool on 2026-11-05 (49 NFTs), no rung over 5-5's 42 XRP:
    // - every tier a ladder of XRP rungs across its range, each rung 0.286 as likely as the one below;
    // - per-item NFT odds (nftOdds): each NFT its own share of its band, k / its mark, so every NFT is worth the same per pull. On the full pool the
    //   NFTs take Common 45.6% (15 NFTs, 2.03 to 3.56 XRP), Uncommon 2.15% (2, about 5), Rare 5.56% (22, 9.14 to 17.27), Epic 5.65% (5, 23.37 to
    //   56.79) and all of Chase (4, 81.27 to 198.10). An NFT that leaves hands its share to its band's ladder (Chase, with no ladder, gives the pull's
    //   XRP back), and a band's NFTs never add more than its committed excess, so the most a pull can sell back for on any pool is 93.66%, under the
    //   95% line: NFTs kept, sold back or restocked never close the pack on it. Only an empty Chase pauses it.
    // Nothing pays under 2 XRP: the 1.75 XRP zPunk leaves the pool. The NFTs moved to their value's band before 5-6 opened (rip-admin reband).
    // test/rarity-spec.test.ts holds these to the spec and that pool; 5-5's rates are SEASON_5_5 above.
    bandBps: [7483, 2000, 400, 100, 17],
    fiftyUpFromBand: 4,
    emptyBand: "rows",
    nftOdds: {
      kDrops: [89355, 54173, 32998, 462744, 25350615],
      capBps: [4560, 215, 556, 565, 10000],
      excessDrops: [271753, 0, 127432, 835663, 92393179],
    },
    tokenPrizes: [
      { band: 0, bps: 3888, xrp: 2, dust: true },
      { band: 0, bps: 1111, xrp: 2.5, dust: true },
      { band: 0, bps: 318, xrp: 3, dust: true },
      { band: 0, bps: 90, xrp: 3.5, dust: true },
      { band: 0, bps: 26, xrp: 4, dust: true },
      { band: 0, bps: 7, xrp: 4.5, dust: true },
      { band: 1, bps: 7034, xrp: 5 },
      { band: 1, bps: 2012, xrp: 6 },
      { band: 1, bps: 575, xrp: 7 },
      { band: 1, bps: 164, xrp: 8 },
      { band: 2, bps: 6789, xrp: 9 },
      { band: 2, bps: 1942, xrp: 12 },
      { band: 2, bps: 555, xrp: 15 },
      { band: 2, bps: 158, xrp: 18 },
      { band: 3, bps: 6898, xrp: 21 },
      { band: 3, bps: 1973, xrp: 30 },
      { band: 3, bps: 564, xrp: 42 },
    ],
    sealFloat: { startXrp: 90, lowXrp: 60, refillXrp: 50 },
    // By value at 4 XRP, from what's in the pool. Each primary has real art in the snapshot.
    bands: [
      ["babyseal", "blackmarketdawgs", "digital-minds", "doodlepunkx", "fuzzycubs", "rituals-r3gxhxz", "round-tripprx-beyond", "xrpfrensclub", "xspectar-avatar-v1-collection"],
      ["anti-social-media", "king", "ouroboros"],
      ["shitty-panther-club", "dropchan", "luckypunch", "maxonxrpl", "punx", "sexy-betzy", "wbc-bang", "wbc-smile", "xcainz-universe"],
      ["animal-fam", "food-and-liquor", "phnixs", "xshrooms", "yamada"],
      ["xpunks", "seal-cto-scrolls", "teddybg", "xrp-army-og-collection"],
    ],
  },
  10: {
    name: "Silver NFT Pack",
    art: "n10",
    xrp: 8,
    offered: true,
    bandBps: [6750, 2100, 450, 675, 25],
    fiftyUpFromBand: 3,
    tokenPrizes: [
      { band: 0, bps: 6000, xrp: 2, dust: true },
      { band: 0, bps: 3300, xrp: 4, dust: true },
      { band: 0, bps: 700, xrp: 8, dust: true },
      { band: 1, bps: 2000, xrp: 5.5 },
      { band: 2, bps: 1500, xrp: 15 },
      { band: 3, bps: 5000, xrp: 42 },
    ],
    sealFloat: { startXrp: 95, lowXrp: 60, refillXrp: 50 },
    bands: [
      [],
      ["anti-social-media", "baysedbirds", "king", "ouroboros", "pixel-puppets-by-swadoki", "soitbegins", "when-pigs-fly", "xrpmf"],
      ["shitty-panther-club", "bearableguyclub-loadstar-ii", "hogs", "innerdreams", "moneygrabbers", "sexy-betzy"],
      ["animal-fam", "corruptions", "food-and-liquor", "phnixs", "yamada"],
      ["seal-on-xrpl-cto", "seal-cto-scrolls"],
    ],
  },
  25: {
    name: "Gold NFT Pack",
    art: "n25",
    xrp: 20,
    offered: false,
    bandBps: [6200, 2400, 1180, 180, 40],
    fiftyUpFromBand: 2,
    tokenPrizes: [
      { band: 0, bps: 3000, xrp: 6.5 },
      { band: 1, bps: 2000, xrp: 14 },
      { band: 2, bps: 1500, xrp: 42 },
      { band: 3, bps: 1000, xrp: 100 },
    ],
    sealFloat: { startXrp: 225, lowXrp: 130, refillXrp: 100 },
    bands: [
      ["anti-social-media", "codedcheetahs", "gnosticugaselderscircle", "ramp-reapers", "round-tripprx", "when-pigs-fly", "xcainz-universe"],
      ["shitty-panther-club", "bearableguyclub-loadstar-ii", "hogs", "moneygrabbers"],
      ["animal-fam", "food-and-liquor", "phnixs", "ravagers", "yamada"],
      ["xpunks", "animal-fam-illegal-breeds", "bearableguyclub-genesis-i", "bearchampdaf", "totonia-genesis", "xrp-army-og-collection"],
      ["seal-on-xrpl-cto", "bearchamp", "bearchampgf", "bearxrpl", "bottlechamp", "cultorigin", "fuzzybears"],
    ],
  },
  // Built and off. These keep their earlier ladders, rates and all, until someone chooses to bring them back.
  50: {
    name: "Surge NFT Pack",
    art: "n50",
    xrp: 40,
    offered: false,
    bandBps: [6600, 2400, 700, 200, 100],
    fiftyUpFromBand: null,
    tokenPrizes: [],
    sealFloat: { startXrp: 0, lowXrp: 0, refillXrp: 0 },
    bands: [
      ["shitty-panther-club", "dropchan", "moneygrabbers", "maxonxrpl", "1sbydale", "voc-ancient", "bearableguyclub-loadstar-ii", "hogs", "whiterabbit", "bear-pixel-collection", "birdjpg", "affenballe"],
      ["parc", "bored-apes-xrp-club", "drop-is-coded", "miladynoir", "xshrooms", "fuzzy-bars", "monx", "salute", "berthren"],
      ["animal-fam", "teddybg", "xrp-army-og-collection", "food-and-liquor"],
      ["bearchampdaf", "seal-on-xrpl-cto"],
      ["bearchampgf"],
    ],
  },
  100: {
    name: "Black Foil NFT Pack",
    art: "n100",
    xrp: 80,
    offered: false,
    bandBps: [6600, 2400, 700, 200, 100],
    fiftyUpFromBand: null,
    tokenPrizes: [],
    sealFloat: { startXrp: 0, lowXrp: 0, refillXrp: 0 },
    bands: [
      ["parc", "drop-is-coded", "miladynoir", "xshrooms", "fuzzy-bars", "monx", "salute", "berthren", "bored-apes-xrp-club", "voxechoesoffreedom"],
      ["animal-fam", "casino-society", "food-and-liquor", "phnixs", "yamada", "ugasbrethren", "monx"],
      ["seal-cto-scrolls", "bearchampdaf", "hydros", "tessera"],
      ["bearchampgf", "bottlechamp"],
      ["bearchamp"],
    ],
  },
};

/** What the shelf sells: on, and under the cap. The one list every page and route takes its packs from. */
export const SHELF_PRICES: readonly NftPrice[] = NFT_PRICES.filter((p) => NFT_LADDERS[p].offered && p < SHELF_UNDER_USD);
export const isOffered = (p: NftPrice) => SHELF_PRICES.includes(p);
/** Share of pulls landing on $50 or more at today's floors, in basis points. */
export const fiftyUpBps = (l: NftLadder) => (l.fiftyUpFromBand === null ? 0 : l.bandBps.slice(l.fiftyUpFromBand).reduce((a, b) => a + b, 0));

/** The collection a band shows art for. */
export const primaryOf = (ladder: NftLadder, band: number) => ladder.bands[band][0];
/** One primary per band, in rarity order. */
export const picksOf = (ladder: NftLadder) => ladder.bands.flatMap((b) => (b.length ? [b[0]] : []));
/** A band that pays only XRP or SEAL. It holds no NFTs. */
export const isDustBand = (ladder: NftLadder, band: number) => ladder.tokenPrizes.filter((r) => r.band === band).reduce((a, r) => a + r.bps, 0) >= 10_000;

export const isNftPrice = (n: number): n is NftPrice => (NFT_PRICES as readonly number[]).includes(n);

/** Why a season can't open at this price. A season commits its price on the ledger, and this file is the only place it comes from. */
export function seasonPriceRefusal(price: number, xrp: number): string | null {
  if (!isNftPrice(price)) return `There's no $${price} pack. Nothing was opened.`;
  const ladder = NFT_LADDERS[price].xrp;
  return xrp === ladder ? null : `The $${price} pack is ${ladder} XRP. Use open-season ${price} ${ladder}. Nothing was opened.`;
}
