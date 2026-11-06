import { sha256 } from "@noble/hashes/sha2";

/**
 * The draw, in pure code that runs the same on the server and in a browser. Nothing here touches a store or a network.
 *
 * A season commits to the tip of a hash chain before any pack sells. Pull i of the season reveals the chain's next link,
 * which anyone can hash back to the commitment, and which says nothing about the links still to come. Each pull mixes
 * that link with its payment's transaction hash and the hash of a ledger that closed after the payment landed:
 *
 *   digest = SHA-256(version | season | index | seed | payment tx hash | entropy ledger hash | player address)
 *
 * The seed was fixed before the player paid. The ledger hash did not exist yet when the player signed or when the seed
 * was committed. So neither side can choose the result, and replaying the published values gives the same pull.
 */
export const DRAW_VERSION = "seal-rips-draw-v1";

/** Ledgers between the one holding the payment and the one whose hash feeds the draw. */
export const ENTROPY_DELAY = 3;

export const BANDS = ["Common", "Uncommon", "Rare", "Epic", "Chase"] as const;
export type BandName = (typeof BANDS)[number];
/** Rarity rates in basis points, in band order. They hold on every pull: draws don't depend on any earlier draw. */
export const BAND_BPS: readonly number[] = [6600, 2400, 700, 200, 100];
const SCALE = 10_000;

const encoder = new TextEncoder();
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
export const sha256Hex = (text: string) => toHex(sha256(encoder.encode(text)));

function hashTimes(seed: Uint8Array, times: number): Uint8Array {
  let out = seed;
  for (let i = 0; i < times; i++) out = sha256(out);
  return out;
}

/** The public commitment for a season of `length` pulls: the root hashed `length` times. */
export const commitmentOf = (rootHex: string, length: number) => toHex(hashTimes(fromHex(rootHex), length));

/** Pull `index`'s seed: one hash short of the previous pull's, so the links are given out from the tip back to the root. */
export function seedAt(rootHex: string, length: number, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= length) throw new Error("seed index out of range");
  return toHex(hashTimes(fromHex(rootHex), length - 1 - index));
}

/** True if this seed hashes back to the commitment in exactly index + 1 steps. */
export const seedMatches = (seedHex: string, index: number, commitment: string) => toHex(hashTimes(fromHex(seedHex), index + 1)) === commitment.toLowerCase();

export interface DrawInput {
  readonly season: string;
  readonly index: number;
  readonly seed: string;
  readonly txHash: string;
  readonly ledgerHash: string;
  readonly address: string;
}

export const digestOf = (d: DrawInput) => sha256Hex([DRAW_VERSION, d.season, d.index, d.seed.toLowerCase(), d.txHash.toUpperCase(), d.ledgerHash.toUpperCase(), d.address].join("|"));

/** A whole number in [0, n), with no modulo bias: values past the last full multiple of n are thrown out and rehashed. */
export function uniform(digest: string, label: string, n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("uniform needs a positive size");
  const range = 2 ** 48;
  const limit = range - (range % n);
  for (let i = 0; ; i++) {
    const h = sha256(encoder.encode(`${digest}|${label}|${i}`));
    const x = h[0] * 2 ** 40 + h[1] * 2 ** 32 + h[2] * 2 ** 24 + h[3] * 2 ** 16 + h[4] * 2 ** 8 + h[5];
    if (x < limit) return x % n;
  }
}

/** Which band a digest lands in. The rates are the only input: no count, no history and no clock. */
export function bandOf(digest: string, bps: readonly number[] = BAND_BPS): number {
  const roll = uniform(digest, "band", SCALE);
  let edge = 0;
  for (let i = 0; i < bps.length; i++) {
    edge += bps[i];
    if (roll < edge) return i;
  }
  throw new Error("rarity rates must add to 100%");
}

/** The position in the band's pool, sorted by NFT id so that the pick depends only on what is in the pool. */
export const pickOf = (digest: string, poolSize: number) => uniform(digest, "nft", poolSize);

/** Below this, a payment that isn't exactly what an order asked for is dust, not a customer. No refund, no log entry. */
export const DUST_DROPS = 1_000_000n;

/** One row of a season's token prizes. `bps` is its share of that band's pulls. Fixed in the log when the season opens. */
export interface PrizeRow {
  readonly band: number;
  readonly token: string;
  readonly bps: number;
  readonly valueDrops: string;
  /** A small prize: its SEAL pays the same value in XRP to a wallet whose trust line is missing or too small to hold it. Part of what a season commits to. */
  readonly dust?: boolean;
}

/**
 * After the band, one more roll says whether this pull pays a token prize, at the season's fixed share for that band. If
 * not, the pull goes on to its fair pick across every NFT in the band, exactly as before. Pool size never enters this, so
 * a token's share of a band stays put however many NFTs are in stock.
 */
export function prizeRowOf(digest: string, table: readonly PrizeRow[], band: number): PrizeRow | null {
  const rows = table.filter((r) => r.band === band);
  if (!rows.length) return null;
  const roll = uniform(digest, "prize", SCALE);
  let edge = 0;
  for (const r of rows) {
    edge += r.bps;
    if (roll < edge) return r;
  }
  return null;
}

/** A band whose every pull pays a token. It holds no NFTs, so the stock rule has nothing to ask of it. */
export function tokenOnlyBand(table: readonly PrizeRow[], band: number): boolean {
  return table.filter((r) => r.band === band).reduce((a, r) => a + r.bps, 0) >= SCALE;
}

/**
 * What a band's NFT share pays when its pool is empty, as a season commits it. "rows": one of that band's own token rows, rolled by their
 * weights. Absent, as on every season before 5-6, the pull's XRP goes back whole. A season that has it keeps selling while a band's NFTs
 * run out, on that band's rows: the stock rule asks nothing of a band with rows.
 */
export type EmptyBand = "rows";

/** A band that pays something on every pull without an NFT: all tokens, or, on a season whose empty NFT share falls back to rows, any band with rows. */
export const paysWithoutNfts = (table: readonly PrizeRow[], band: number, emptyBand?: EmptyBand) => tokenOnlyBand(table, band) || (emptyBand === "rows" && table.some((r) => r.band === band && r.bps > 0));

/** On a season with `emptyBand: "rows"`, the row an empty band's NFT share pays: one of the band's rows, by their own weights, from its own roll. */
export function fallbackRowOf(digest: string, table: readonly PrizeRow[], band: number): PrizeRow | null {
  const rows = table.filter((r) => r.band === band && r.bps > 0);
  const total = rows.reduce((a, r) => a + r.bps, 0);
  if (!total) return null;
  const roll = uniform(digest, "empty-band", total);
  let edge = 0;
  for (const r of rows) {
    edge += r.bps;
    if (roll < edge) return r;
  }
  return null;
}

/**
 * Per-item NFT odds, as a season commits them (owner, 2026-11-05: "Common nfts held shouldn't close the pack"). Instead of one fair pick across a
 * band's pool at a fixed share, each NFT takes its own share of the band, k / its mark, so every NFT is worth the same per pull and a dearer one is
 * rarer in proportion. Whatever share the NFTs in the pool don't take pays the band's ladder (its rows, by their weights, from fallbackRowOf's
 * roll), or, in a band with no rows, gives the pull's XRP back whole. All a band's NFTs scale down together, never up, so that:
 * - their shares never add to more than `capBps` of the band, and
 * - they never add more than `excessDrops` per band pull over what the ladder would pay on their share.
 * So a band pays at most its ladder's average plus `excessDrops` per pull, whatever's in its pool: NFTs kept, sold back, taken out or restocked in
 * any order. A season cut by the rarity spec commits the values its full pool gives exactly. Everything here is + - x / and floor, which every
 * JavaScript engine rounds the same way, so /fair reproduces each share in a browser.
 */
export interface ItemOdds {
  /** Per band, in drops: an NFT's share of its band is kDrops / its mark. */
  readonly kDrops: readonly number[];
  /** Per band, in bps of the band: the most its NFTs together may take. */
  readonly capBps: readonly number[];
  /** Per band, in drops per band pull: the most its NFTs together may add over its ladder's average. */
  readonly excessDrops: readonly number[];
}

/** Parts per band a pull's item roll is drawn in. */
export const ITEM_SCALE = 1_000_000_000;

/** A band's ladder average in drops at face, by its rows' weights; with no rows, the pack's price, which is what its leftover share pays back. */
export function ladderAverageDrops(table: readonly PrizeRow[], band: number, priceDrops: string | number): number {
  const rows = table.filter((r) => r.band === band && r.bps > 0);
  const total = rows.reduce((a, r) => a + r.bps, 0);
  return total ? rows.reduce((a, r) => a + r.bps * Number(r.valueDrops), 0) / total : Number(priceDrops);
}

/**
 * Each NFT's share of its band, in parts of ITEM_SCALE, for a pool in its own order (the draw's: by NFT id). `sellBps` values an NFT at what a sale
 * pays, the measure the excess is held to.
 */
export function itemWeights(odds: ItemOdds, table: readonly PrizeRow[], band: number, marksDrops: readonly (string | number | bigint)[], sellBps: number, priceDrops: string | number): number[] {
  const k = odds.kDrops[band] ?? 0;
  if (!(k > 0) || !marksDrops.length) return marksDrops.map(() => 0);
  const marks = marksDrops.map((m) => Number(m));
  const ladder = ladderAverageDrops(table, band, priceDrops);
  const raw = marks.map((m) => (m > 0 ? k / m : 0));
  const share = raw.reduce((a, x) => a + x, 0);
  const excess = raw.reduce((a, x, i) => a + x * ((sellBps * marks[i]) / SCALE - ladder), 0);
  const cap = (odds.capBps[band] ?? 0) / SCALE;
  const most = odds.excessDrops[band] ?? 0;
  let scale = 1;
  if (share > cap) scale = Math.min(scale, cap / share);
  if (excess > most) scale = Math.min(scale, most > 0 ? most / excess : 0);
  return raw.map((x) => Math.floor(scale * x * ITEM_SCALE));
}

/** Which NFT a pull's own item roll lands on, by position in the pool, or null for the band's ladder (or, with no rows, its XRP back). */
export function itemPick(digest: string, weights: readonly number[]): number | null {
  const roll = uniform(digest, "item", ITEM_SCALE);
  let edge = 0;
  for (let i = 0; i < weights.length; i++) {
    edge += weights[i];
    if (roll < edge) return i;
  }
  return null;
}

/**
 * What one pull on a band pays, on average, in drops, valued the way the sell-back line values it: an NFT at a sale's share of its mark, an XRP row at
 * face, a token row at `tokenShare` of its value, a refund at the price. Per-item seasons only.
 */
export function itemBandValue(odds: ItemOdds, table: readonly PrizeRow[], band: number, marksDrops: readonly (string | number | bigint)[], sellBps: number, priceDrops: string | number, tokenShare = 1): number {
  const w = itemWeights(odds, table, band, marksDrops, sellBps, priceDrops);
  const nft = w.reduce((a, x, i) => a + (x / ITEM_SCALE) * Number(marksDrops[i]) * (sellBps / SCALE), 0);
  const left = 1 - w.reduce((a, x) => a + x, 0) / ITEM_SCALE;
  const rows = table.filter((r) => r.band === band && r.bps > 0);
  const total = rows.reduce((a, r) => a + r.bps, 0);
  const ladder = total ? rows.reduce((a, r) => a + r.bps * Number(r.valueDrops) * (r.token === "XRP" ? 1 : tokenShare), 0) / total : Number(priceDrops);
  return nft + left * ladder;
}

/**
 * The stock rule used to hold one NFT per band for every open checkout, so two Chase NFTs meant two checkouts at a time, however
 * rare a Chase is. Now a band needs enough NFTs that this many pulls overrun it with a chance under HOLD_RISK. If one ever does,
 * that pull's XRP goes back whole, which is the refund a band with no prize left has always made. A band's last NFT still
 * counts as stock, and a band with none closes the pack.
 */
export const HOLD_RISK = 1e-4;

/** How many NFTs a band needs for `places` pulls, each landing an NFT there with chance `nftChance`. At least one. */
export function lotsNeeded(places: number, nftChance: number): number {
  if (nftChance >= 1) return Math.max(1, places);
  if (nftChance <= 0) return 1;
  let term = (1 - nftChance) ** places;
  let cdf = term;
  for (let k = 0; k < places; k++) {
    if (k >= 1 && 1 - cdf <= HOLD_RISK) return k;
    term *= ((places - k) / (k + 1)) * (nftChance / (1 - nftChance));
    cdf += term;
  }
  return Math.max(1, places);
}

/** The chance one pull lands on an NFT in this band. */
export function nftChanceOf(bandBps: readonly number[], table: readonly PrizeRow[], band: number): number {
  const tokens = table.filter((r) => r.band === band).reduce((a, r) => a + r.bps, 0);
  return ((bandBps[band] ?? 0) / SCALE) * Math.max(0, 1 - tokens / SCALE);
}

/**
 * Whether a tier's bands can take one more place, on top of `holds` already open. A band that pays only tokens asks for no NFTs, and nor does
 * a band with rows on a season whose empty NFT share falls back to them.
 */
export const stockCovers = (stock: readonly number[], holds: number, bandBps: readonly number[], table: readonly PrizeRow[], emptyBand?: EmptyBand) =>
  stock.every((n, band) => paysWithoutNfts(table, band, emptyBand) || n >= lotsNeeded(holds + 1, nftChanceOf(bandBps, table, band)));

/**
 * The XRP `places` pulls on this table could need, whichever way a token row falls, since any row can pay its value in XRP. Each
 * prize size gets the hits it could take at HOLD_RISK, so the chance of needing more is under that per size. A season's biggest
 * prize times its places is the most it can ever need. Going short delays a prize and never takes it back: see strikePrize.
 * With `emptyBand: "rows"` a band's rows can take its whole rate once its NFTs are gone, so each row counts at its share of the rows.
 */
export function xrpCoverFor(table: readonly PrizeRow[], bandBps: readonly number[], places: number, emptyBand?: EmptyBand): bigint {
  if (places <= 0) return 0n;
  const chance = new Map<string, number>();
  const rowsOf = (band: number) => table.filter((r) => r.band === band).reduce((a, r) => a + r.bps, 0);
  for (const r of table) {
    const share = emptyBand === "rows" ? r.bps / Math.max(1, rowsOf(r.band)) : r.bps / SCALE;
    const c = ((bandBps[r.band] ?? 0) / SCALE) * share;
    if (c > 0) chance.set(r.valueDrops, (chance.get(r.valueDrops) ?? 0) + c);
  }
  let need = 0n;
  let biggest = 0n;
  for (const [value, c] of chance) {
    need += BigInt(value) * BigInt(lotsNeeded(places, c));
    if (BigInt(value) > biggest) biggest = BigInt(value);
  }
  const most = biggest * BigInt(places);
  return need < most ? need : most;
}

export const prizeTableHash = (table: readonly PrizeRow[]) => sha256Hex(JSON.stringify(table.map((r) => (r.dust ? [r.band, r.token, r.bps, r.valueDrops, 1] : [r.band, r.token, r.bps, r.valueDrops]))));

/** Everything a season promises a player. Its hash goes on the ledger with the commitment, so none of it can change afterward. */
export interface SeasonTerms {
  readonly priceDrops: string;
  readonly bandBps: readonly number[];
  readonly sellBps: number;
  readonly prizeTable: readonly PrizeRow[];
  readonly tokens: readonly { readonly id: string; readonly currency: string; readonly issuer: string }[];
  /** What an empty band's NFT share pays. Part of the terms only when a season sets it, so every earlier season's hash stands. */
  readonly emptyBand?: EmptyBand;
  /** Per-item NFT odds. Part of the terms only when a season sets them, after `emptyBand`, so every earlier season's hash stands. */
  readonly nftOdds?: ItemOdds;
}
export const seasonTermsHash = (t: SeasonTerms) =>
  sha256Hex(
    JSON.stringify([
      t.priceDrops,
      t.bandBps,
      t.sellBps,
      prizeTableHash(t.prizeTable),
      t.tokens.map((k) => [k.id, k.currency, k.issuer]),
      ...(t.emptyBand ? [t.emptyBand] : []),
      ...(t.nftOdds ? [["per-item", t.nftOdds.kDrops, t.nftOdds.capBps, t.nftOdds.excessDrops]] : []),
    ]),
  );

export const invoiceOf = (orderId: string) => sha256Hex(`seal-rips-invoice|${orderId}`).toUpperCase();
