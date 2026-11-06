import { NFT_LADDERS, NFT_PRICES, type NftPrice } from "./nft-packs.ts";

/**
 * What the restocker may hold and buy, and the only file to edit to change it. Nothing here turns buying on: that takes SEAL_AUTOBUY in the
 * environment (see src/lib/rip/restock.ts), and limits there can only make these narrower.
 */

/** Every collection the buyer may touch, pinned to its issuer and taxon. An NFT's id carries both, so an indexer can't pass off a lookalike. */
export const COLLECTION_PINS: Readonly<Record<string, { readonly issuer: string; readonly taxon: number }>> = {
  "animal-fam": { issuer: "rsynspCY79NU4ghuH8hgvedQv533rdvYfM", taxon: 1 },
  "anti-social-media": { issuer: "rJpqMyXEgSZHPbx6a6DLiywRBHMXcrk8Hm", taxon: 777 },
  babyseal: { issuer: "rMwtxPxXKPvcqtrmMJ5nRka9kR6rd1nAQf", taxon: 1 },
  // The owner's rebuy of 2026-11-03, issuer and taxon read off the NFT ids it bought.
  blackmarketdawgs: { issuer: "rYL3n9Ufc3W6ZHarPKEPZaF9gZruhRZkw", taxon: 10 },
  maxonxrpl: { issuer: "rhPej1i49GM2ftuKXhF8K5PFFQqGMkph7k", taxon: 1 },
  "wbc-bang": { issuer: "rNEjKEmgvANn9cTtGTdXBdeDPSc28j95zu", taxon: 3 },
  xshrooms: { issuer: "rJeBz69krYh8sXb8uKsEE22ADzbi1Z4yF2", taxon: 8000 },
  teddybg: { issuer: "rwYNpdWqnjB43doyurzezv2yRvgMMABDGy", taxon: 0 },
  // JCRivera, The Bear Champ: every collection of his the indexer resolves, by issuer and taxon read off the ledger. Food and Liquor and Corruptions are his too.
  bearchampdaf: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 1 },
  bearchamp: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 0 },
  bearchampgf: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 2 },
  voxechoesoffreedom: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 4 },
  luckypunch: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 6 },
  bottlechamp: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 9 },
  daggerchamp: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 8 },
  "bear-champ-custom-pfps": { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 3 },
  bchampkey: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 7 },
  "bchamp-sdd": { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 12 },
  baysedbirds: { issuer: "rPQ9mJjHLgAC16ZyLLDe76647TNCC8EuPA", taxon: 1 },
  "bearableguyclub-loadstar-ii": { issuer: "rLoMBprALb22SkmNK4K3hFWrpgqXbAi6qQ", taxon: 20705 },
  corruptions: { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 5 },
  "digital-minds": { issuer: "rfBsNiKwzdrVEjsEvD5rMXKJUf2t8J5nxZ", taxon: 0 },
  doodlepunkx: { issuer: "rDPUNKX2Rf5joEyVnmXFnnWL5MYa92wLPN", taxon: 90386995 },
  dropchan: { issuer: "rDropCHANEgmG7FBz1nzPpG27BGzWjnCnn", taxon: 0 },
  "food-and-liquor": { issuer: "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", taxon: 20 },
  fuzzycubs: { issuer: "rCUbpFYSh2vySPLT26SMwqAQU9rzKAxvZ", taxon: 666133630 },
  hogs: { issuer: "rUv6Bmw6GRQHgJaiVcXnnNFCeTMKUE6FCa", taxon: 1 },
  innerdreams: { issuer: "rnDkbM6UZkzFfQoSQK9gX7DwneJeM2pAgm", taxon: 5041986 },
  king: { issuer: "rKingAa11yp4eCuxVraesW2UAvz5THWNCy", taxon: 123 },
  moneygrabbers: { issuer: "rsAmfViA5ao8wKTm1DXmwFskhbwSAjo8Ko", taxon: 0 },
  ouroboros: { issuer: "rKQkjmocgRWo9AnNRrsgP2EnDxvN44MQxK", taxon: 1 },
  phnixs: { issuer: "rMiNJh6eQE5fSpgke5vrjUGiU9rXhrgoSA", taxon: 1 },
  "pixel-puppets-by-swadoki": { issuer: "rppTPMRKjDdaNJqUAL3dEUwACSuPe543Qi", taxon: 123 },
  punx: { issuer: "rPhMmag9YDcw9d5izQaFRRLfU7EB7WNQky", taxon: 0 },
  "rituals-r3gxhxz": { issuer: "r3GxHxz3Fqusrc8tu5JH8vczTmS1ZATTTs", taxon: 5 },
  "round-tripprx-beyond": { issuer: "r4TpNPsUpFCTm4MtoUKQBvaQC856h9GBfQ", taxon: 0 },
  "seal-cto-scrolls": { issuer: "rUSdvkwdGnU8qpfRR2sa1h7JExzBi7fUHr", taxon: 2 },
  "seal-on-xrpl-cto": { issuer: "rst9Sq8mVxK8b7BbgFs4VmnVtfm7N2qN4j", taxon: 1 },
  "sexy-betzy": { issuer: "rp9rkXEfgVmkwgr1jJ7dBYWqQvtYQXzGbF", taxon: 2 },
  "shitty-panther-club": { issuer: "rGnivxmi1yAu15Kou1nqt91ZxtXhkWB2iM", taxon: 0 },
  soitbegins: { issuer: "raNypRjrVu98Rp3AYLRhQBDUeJKyyRRV92", taxon: 123589321 },
  "wbc-smile": { issuer: "rNEjKEmgvANn9cTtGTdXBdeDPSc28j95zu", taxon: 1 },
  "when-pigs-fly": { issuer: "rB7UyKs9SwS4pX87tqtMjq4XRiEhkBfmuH", taxon: 911 },
  "xcainz-universe": { issuer: "reEuFtr2Zi9yPZQy1s2AZ8rXYdxrapaWt", taxon: 1 },
  xpunks: { issuer: "rpbjkoncKiv1LkPWShzZksqYPzKXmUhTW7", taxon: 52 },
  "xrp-army-og-collection": { issuer: "rHDkTGymZL6WQbrrsxPnpeTqhcF8S44kR1", taxon: 1 },
  xrpfrensclub: { issuer: "rEfekxLoQD3h6JocT3VYBDuDKdAqWR7SyU", taxon: 0 },
  xrpmf: { issuer: "rfJc8Dn79HSrWwexJFCshYGBo6qb67FKsd", taxon: 10671 },
  "xspectar-avatar-v1-collection": { issuer: "ra59pDJcuqKJcQws7Xpuu1S8UYKmKnpUkW", taxon: 10 },
  yamada: { issuer: "rLYFg5etEnRY4VkajySaeCDf6f9oZTHwbZ", taxon: 0 },
  zpunks: { issuer: "rGHGrjaLGhCqFwyCm7UwpX5wdeTtA2Kf3x", taxon: 22914 },
};

type Range = readonly [fromXrp: number, toXrp: number | null] | null;
type PerBand<T> = readonly [T, T, T, T, T];

/**
 * Each band's value range, in XRP: from the first number up to, not including, the second; null on top means no top. They say which band an NFT
 * belongs in by what it's worth, and they're used only to choose the band a bought NFT goes in. A sold-back NFT goes back at its own mark (the floor
 * rule can bring it down), never capped or held for its range: the owner, 2026-11-03, wants no price caps on the pack.
 *
 * $5, from season 5-6: the rarity spec's value tiers at 4 XRP (valueRanges in src/lib/rip/rarity-spec.ts, which a test holds this to). Common 0.5x to
 * 1.2x, Uncommon to 2.2x, Rare to 5x, Epic to 20x, Chase above. Nothing under 2 XRP belongs in any band, so the buyer never buys one.
 */
export const BAND_RANGES: Partial<Readonly<Record<NftPrice, PerBand<Range>>>> = {
  5: [[2, 4.8], [4.8, 8.8], [8.8, 20], [20, 80], [80, null]],
  10: [null, [4, 7], [12, 18], [40, 70], [150, 280]],
};

/**
 * Collections the buyer may buy, by band. MAX on XRPL and Sexy Betzy are on $5 Rare by the owner's rebuy, but every one of their NFTs seen so far has art its issuer
 * can change, and the buyer never buys one of those (nftBuyRefusal), so they're bought by hand. Their sold-back NFTs still go back with the floor check.
 */
export const BUY_ALLOW: Partial<Readonly<Record<NftPrice, PerBand<readonly string[]>>>> = {
  // Season 5-6's value tiers, from where each collection's NFTs sit in the pool. A collection on two lists is bought for whichever band its price fits.
  5: [
    ["babyseal", "blackmarketdawgs", "digital-minds", "doodlepunkx", "fuzzycubs", "rituals-r3gxhxz", "round-tripprx-beyond", "xspectar-avatar-v1-collection", "zpunks"],
    ["anti-social-media", "king", "ouroboros"],
    ["anti-social-media", "dropchan", "king", "luckypunch", "maxonxrpl", "punx", "sexy-betzy", "shitty-panther-club", "wbc-bang", "wbc-smile", "xcainz-universe"],
    ["animal-fam", "food-and-liquor", "phnixs", "teddybg", "xshrooms", "yamada"],
    ["bearchampdaf", "seal-cto-scrolls", "teddybg", "xpunks", "xrp-army-og-collection"],
  ],
  10: [
    [],
    ["anti-social-media", "baysedbirds", "king", "ouroboros", "pixel-puppets-by-swadoki", "soitbegins", "when-pigs-fly", "xrpmf"],
    ["luckypunch", "shitty-panther-club", "bearableguyclub-loadstar-ii", "hogs", "innerdreams", "moneygrabbers"],
    ["animal-fam", "corruptions", "food-and-liquor", "phnixs", "yamada"],
    ["seal-on-xrpl-cto", "seal-cto-scrolls"],
  ],
};

/**
 * Collections the buyer never buys, whatever a list above or SEAL_AUTOBUY_COLLECTIONS says. The owner, 2026-11-03: no XRP Frens Club (FREN). A FREN already in a
 * pool still goes back when it's sold back: that's the vault's own NFT, not a buy.
 */
export const NEVER_BUY: readonly string[] = ["xrpfrensclub"];

/**
 * The owner's priority, 2026-11-03: JCRivera's (The Bear Champ) collections, in his order. A band reads these first and buys from one when it passes every check any
 * other collection must: real recent sales by many wallets, a floor near them, a price inside the band's window and under every cap. Being here never skips one.
 * Only a collection on a band's own list above can be bought at all, and most of these sit outside every window: see the deploy plan for which fit where.
 * THE BEAR CHAMP Editions isn't here: no indexer or ledger read ties a collection by that name to an issuer and taxon yet. The BCHAMP token isn't an NFT.
 */
export const PRIORITY_COLLECTIONS: readonly string[] = [
  "bearchampdaf",
  "bearchamp",
  "bearchampgf",
  "voxechoesoffreedom",
  "luckypunch",
  "bottlechamp",
  "corruptions",
  "daggerchamp",
  "bear-champ-custom-pfps",
  "bchampkey",
  "bchamp-sdd",
];

/**
 * How many NFTs each band should hold, by stage. `launch` is season 5-6's shelf for $5, the 2026-11-05 pool in its value bands (15, 2, 22, 5 and 4 NFTs), and the plan's first buy for $10. `50` and `100` add to it in proportion to how fast each band
 * is pulled, so the bands run out together: see targetsFor in src/lib/rip/scale.ts, which a test holds these to. SEAL_RESTOCK_STAGE picks one.
 */
export const RESTOCK_STAGES = {
  launch: { 5: [15, 2, 22, 5, 4], 10: [0, 14, 7, 5, 2] },
  "50": { 5: [17, 2, 22, 5, 4], 10: [0, 29, 11, 8, 2] },
  "100": { 5: [66, 3, 22, 5, 4], 10: [0, 64, 18, 15, 3] },
} as const satisfies Record<string, Partial<Record<NftPrice, PerBand<number>>>>;
export type RestockStage = keyof typeof RESTOCK_STAGES;
export const isRestockStage = (s: string | undefined): s is RestockStage => !!s && Object.prototype.hasOwnProperty.call(RESTOCK_STAGES, s);

/** Shelf packs this file covers. A pack with no window, list or target is never bought for. */
export const RESTOCK_PRICES: readonly NftPrice[] = NFT_PRICES.filter((p) => NFT_LADDERS[p].offered && !!BAND_RANGES[p]);
