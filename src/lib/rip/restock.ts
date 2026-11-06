import { decodeAccountID } from "ripple-address-codec";
import { BAND_RANGES, BUY_ALLOW, COLLECTION_PINS, NEVER_BUY, PRIORITY_COLLECTIONS, RESTOCK_PRICES, RESTOCK_STAGES, isRestockStage, type RestockStage } from "../../config/restock.ts";
import { BANDS, itemWeights, tokenOnlyBand } from "./draw.ts";
import type { ArtResolver, MarketRead, MarketReader, MarketSale } from "./market.ts";
import { FLAG_MUTABLE, nftIdCollection } from "./nftid.ts";
import { sellableStock, type LotState, type RipState, type SeasonState } from "./state.ts";
import { NFT_PRICES, type NftPrice } from "../../config/nft-packs.ts";

/**
 * The rules behind putting NFTs back and buying more, in pure code. The engine reads the ledger and the market, asks here, and logs what comes back.
 *
 * The mark's rule on a re-add is the same as registering one: the least of what it stood at and 110% of the floor. What we paid the player stays
 * the lot's cost and doesn't touch its mark. Marking down to the sale price would take 5% off an NFT every lap for no reason in the market, and
 * the pack's return would drift with how often it's sold. A stale high mark isn't a way to pull money out either: a wallet can only sell back what
 * it pulled, so every lap costs a whole pack, and the 95% gate holds what a pack can return. A mark that's too high costs what it costs once, on
 * a pull, and this stops it costing it twice. So it only ever comes down by itself. Only a person's registration can raise one.
 */

/** How long a re-add waits on a market that can't be read, about fifteen minutes, before it goes back at the mark it had. */
export const RELIST_MARKET_WAIT_LEDGERS = 225;
/** With no sweep at all, a player's pass brings a re-add home after this long, about half an hour. Twice the market's wait, so a sweep that's running always gets there first, and its alert goes out. */
export const RELIST_NO_SWEEP_LEDGERS = 2 * RELIST_MARKET_WAIT_LEDGERS;
/** A mark is at most this share of the floor, as 07-register-inventory.mjs has it. */
export const FLOOR_MARK_BPS = 11_000n;
/** A floor this far over a mark gets a mention: that NFT is a better prize than its mark says. */
const UNDER_MARKET_BPS = 12_500n;
/** Market reads one sweep may make. Two calls each, against 7 a minute. */
export const READS_PER_SWEEP = 2;
/** Listings one sweep checks on the ledger, per collection: two reads each. */
export const LEDGER_READS_PER_SLUG = 3;
/** How long a buy offer waits for its broker before it's canceled. xrp.cafe matches in 2 or 3 ledgers. About 45 seconds. */
export const BROKER_WAIT_LEDGERS = 12;
/** A planned buy that hasn't gone out in this long, about two minutes, is dropped and looked at afresh. */
export const BUY_PLAN_LEDGERS = 30;
/** A buy offer's own expiry, so one left behind can't fill days later. */
export const BUY_OFFER_SECONDS = 600;
/** Broker offers in a row that don't fill before buying stops and asks for a person. */
export const MISSES_BEFORE_STOP = 2;
/** No buy may take the pack's sell-back share past this, a little under the gate that closes it. */
export const BUY_MAX_SHARE = 0.94;
/** Room a buy needs beyond its price: its open offer and maybe a new NFT page, 0.2 XRP each. */
export const BUY_ROOM_DROPS = 400_000n;
export const DAY_MS = 86_400_000;

/** What real sales have to look like before a collection's floor is good enough to pay against. Read off the 61 collections in the vault buy list's research. */
const SALE_WINDOW_MS = 30 * DAY_MS;
const MIN_SALES = 5;
const MIN_TRADERS = 3;
const MAX_ONE_TRADER_SHARE = 0.5;
const MAX_CYCLE_SHARE = 0.25;
const MAX_ONE_LISTER_SHARE = 0.75;
/** A listing only counts as the floor if another holder's is within this. Otherwise it's one listing, not a price. */
const FLOOR_GAP = 1.35;
const RECENT_SALES = 10;
/** A floor this far under what it really sells for is a crash or a stunt, and a person can tell which. */
export const FLOOR_UNCLEAR_SHARE = 0.4;
const BUY_FLOOR_RANGE = [0.6, 1.5] as const;
/** One NFT sold this often in the window is being passed around. */
const MAX_FLIPS = 3;

/** A band's value range: a mark from minDrops up to, not including, maxDrops. Null on top means no top. It decides which band a bought NFT goes in, and nothing else. */
export interface MarkWindow {
  readonly minDrops: bigint;
  readonly maxDrops: bigint | null;
}

export interface RestockRules {
  /** The band's value range, for buying: a buy whose mark falls outside it isn't bought for that band. Sold-back NFTs never go through this. */
  windowOf(price: NftPrice, band: number): MarkWindow | null;
  targetOf(price: NftPrice, band: number): number;
  allowOf(price: NftPrice, band: number): readonly string[];
  /** The allowed collection an NFT belongs to, by what its id says. Null for anything else. */
  slugOf(nftId: string): string | null;
  readonly prices: readonly NftPrice[];
  /** How far over a window or a floor-based mark a listing may be. */
  readonly stopBps: number;
  /** A collection's place on the priority list, lowest first, or undefined if it isn't on it. Priority only orders the collections a band may buy from: every check still applies. */
  priorityOf?(slug: string): number | undefined;
}

export interface AutobuyLimits {
  readonly dailyDrops: bigint;
  readonly perNftDrops: bigint;
  /** What the vault always keeps for players' claim offers. */
  readonly keepDrops: bigint;
  readonly lowVaultDrops: bigint;
  /** SEAL_AUTOBUY_PRICES: only these packs are bought for. Null means every pack src/config/restock.ts covers. */
  readonly prices?: readonly NftPrice[] | null;
  /** SEAL_AUTOBUY_COLLECTIONS: only these collections are bought from, inside each band's own list. Null means every one on it. */
  readonly collections?: ReadonlySet<string> | null;
}

export interface RestockDeps {
  readonly rules: RestockRules;
  /** Unset means no floor check: re-adds go back at the mark they had. */
  readonly market?: MarketReader;
  readonly art?: ArtResolver;
  /** Null or unset means buying is off. */
  readonly autobuy?: AutobuyLimits | null;
}

export const AUTOBUY_CONFIRMATION = "the owner turned on automatic NFT buying for Break the Seal";
/** Ceilings no environment setting gets past. A higher limit is a code change somebody has to look at. */
export const HARD_DAILY_XRP = 500;
export const HARD_NFT_XRP = 300;
const DEFAULT_LOW_VAULT_XRP = 25;
const KEEP_XRP = 2;
export const OWNER_STOP_LINE_BPS = 500;

type Env = Readonly<Record<string, string | undefined>>;

const xrpDrops = (n: number) => BigInt(Math.round(n * 1e6));
const positive = (v: string | undefined, ceiling: number): number | null => {
  const n = Number(v);
  return v?.trim() && Number.isFinite(n) && n > 0 && n <= ceiling ? n : null;
};

/** A comma list that can only narrow: unset is no narrowing, and anything in it that isn't allowed makes the whole list a no. */
function narrowing<T>(raw: string | undefined, valid: (x: string) => T | null): readonly T[] | null | "bad" {
  if (!raw?.trim()) return null;
  const out: T[] = [];
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const v = valid(part);
    if (v === null) return "bad";
    out.push(v);
  }
  return out.length ? out : "bad";
}

/**
 * The master switch. Off unless it says exactly "on", with both limits set and sane, and on mainnet the sentence too, so one typo can't start spending. The pack and
 * collection lists only ever narrow what src/config/restock.ts allows; a list with a typo in it turns buying off rather than read as "everything".
 */
export function autobuyConfig(env: Env, mode: "testnet" | "mainnet"): AutobuyLimits | null {
  if (env.SEAL_AUTOBUY !== "on") return null;
  if (mode === "mainnet" && env.SEAL_AUTOBUY_CONFIRM !== AUTOBUY_CONFIRMATION) return null;
  const daily = positive(env.SEAL_AUTOBUY_DAILY_XRP, HARD_DAILY_XRP);
  const each = positive(env.SEAL_AUTOBUY_MAX_NFT_XRP, HARD_NFT_XRP);
  if (daily === null || each === null) return null;
  const prices = narrowing(env.SEAL_AUTOBUY_PRICES, (x) => (NFT_PRICES as readonly number[]).includes(Number(x)) && RESTOCK_PRICES.includes(Number(x) as NftPrice) ? (Number(x) as NftPrice) : null);
  const buyable = new Set(Object.values(BUY_ALLOW).flatMap((bands) => (bands ?? []).flat()));
  const collections = narrowing(env.SEAL_AUTOBUY_COLLECTIONS, (x) => (Object.prototype.hasOwnProperty.call(COLLECTION_PINS, x) && buyable.has(x) && !NEVER_BUY.includes(x) ? x : null));
  if (prices === "bad" || collections === "bad") return null;
  return { dailyDrops: xrpDrops(daily), perNftDrops: xrpDrops(each), keepDrops: xrpDrops(KEEP_XRP), lowVaultDrops: xrpDrops(positive(env.SEAL_AUTOBUY_LOW_XRP, 100_000) ?? DEFAULT_LOW_VAULT_XRP), prices, collections: collections && new Set(collections) };
}

/**
 * The order a band's collections are read in: the priority list first, in its order, then the rest taking turns across sweeps. It's the same collections either way,
 * so being on the list only ever means being looked at first.
 */
export function slugOrder(slugs: readonly string[], turn: number, priorityOf?: (slug: string) => number | undefined): string[] {
  const rank = (s: string) => priorityOf?.(s);
  const first = slugs.filter((s) => rank(s) !== undefined).sort((a, b) => (rank(a) as number) - (rank(b) as number));
  const rest = slugs.filter((s) => rank(s) === undefined);
  const k = rest.length ? ((turn % rest.length) + rest.length) % rest.length : 0;
  return [...first, ...rest.slice(k), ...rest.slice(0, k)];
}

const pinKey = (issuerHex: string, taxon: number) => `${issuerHex}:${taxon}`;
const PIN_INDEX = new Map(Object.entries(COLLECTION_PINS).map(([slug, p]) => [pinKey(Buffer.from(decodeAccountID(p.issuer)).toString("hex").toUpperCase(), p.taxon), slug]));

/** The real rules, from src/config/restock.ts. */
export function configRules(stage: RestockStage = "launch"): RestockRules {
  const targets = RESTOCK_STAGES[stage] as Partial<Record<NftPrice, readonly number[]>>;
  return {
    windowOf(price, band) {
      const w = BAND_RANGES[price]?.[band];
      return w ? { minDrops: xrpDrops(w[0]), maxDrops: w[1] === null ? null : xrpDrops(w[1]) } : null;
    },
    targetOf: (price, band) => targets[price]?.[band] ?? 0,
    allowOf: (price, band) => (BUY_ALLOW[price]?.[band] ?? []).filter((slug) => !NEVER_BUY.includes(slug)),
    slugOf(nftId) {
      if (!/^[0-9A-Fa-f]{64}$/.test(nftId)) return null;
      const c = nftIdCollection(nftId);
      return PIN_INDEX.get(pinKey(c.issuerHex, c.taxon)) ?? null;
    },
    prices: RESTOCK_PRICES,
    stopBps: OWNER_STOP_LINE_BPS,
    priorityOf: (slug) => {
      const i = PRIORITY_COLLECTIONS.indexOf(slug);
      return i < 0 ? undefined : i;
    },
  };
}

export const restockStage = (env: Env): RestockStage => (isRestockStage(env.SEAL_RESTOCK_STAGE?.trim()) ? (env.SEAL_RESTOCK_STAGE?.trim() as RestockStage) : "launch");

export interface MarketVerdict {
  /** The floor, ignoring a lone listing nobody else is near. Null if there's none to go on. */
  readonly floorDrops: number | null;
  readonly medianSaleDrops: number | null;
  /** Why this collection can't be bought from right now, or null if it can. */
  readonly notBuyable: string | null;
}

const median = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Buyer-seller pairs trading both ways, as a share of sales: the mark of a wallet selling to itself. */
function cycleShare(sales: readonly MarketSale[]): number {
  const pairs = new Map<string, number>();
  for (const s of sales) pairs.set(`${s.buyer}>${s.seller}`, (pairs.get(`${s.buyer}>${s.seller}`) ?? 0) + 1);
  let cycling = 0;
  for (const [k, n] of pairs) {
    const [b, a] = k.split(">");
    if (a !== b && pairs.has(`${a}>${b}`)) cycling += n;
    else if (a === b) cycling += n;
  }
  return sales.length ? cycling / sales.length : 0;
}

const topShare = (xs: readonly string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return xs.length ? Math.max(...n.values()) / xs.length : 0;
};

/** The cheapest listing another holder's sits near. */
function floorOf(read: MarketRead): number | null {
  const { listings } = read;
  for (let i = 0; i < listings.length; i++) {
    const next = listings.slice(i + 1).find((l) => l.holder !== listings[i].holder);
    if (next && next.drops <= listings[i].drops * FLOOR_GAP) return listings[i].drops;
  }
  return null;
}

/** Only rows whose id says they're this collection count toward its floor and sales. An indexer's list can't lend a lookalike's prices to the real thing. */
export const pinnedRead = (read: MarketRead, slug: string, rules: Pick<RestockRules, "slugOf">): MarketRead => ({ ...read, listings: read.listings.filter((l) => rules.slugOf(l.nftId) === slug), sales: read.sales.filter((s) => rules.slugOf(s.nftId) === slug) });

/** What a read says: a floor good enough to bring a mark down on, and whether real sales back it enough to pay against. */
export function marketVerdict(read: MarketRead, nowMs: number): MarketVerdict {
  const floorDrops = floorOf(read);
  const recent = read.sales.filter((s) => nowMs - s.at <= SALE_WINDOW_MS);
  const medianSaleDrops = median(recent.slice(0, RECENT_SALES).map((s) => s.drops));
  const out = (notBuyable: string | null): MarketVerdict => ({ floorDrops, medianSaleDrops, notBuyable });
  if (!read.listings.length) return out("no_floor");
  if (recent.length < MIN_SALES) return out("thin_sales");
  if (cycleShare(recent) > MAX_CYCLE_SHARE) return out("wash_pairs");
  if (new Set(recent.map((s) => s.buyer)).size < MIN_TRADERS || topShare(recent.map((s) => s.buyer)) > MAX_ONE_TRADER_SHARE) return out("one_buyer");
  if (new Set(recent.map((s) => s.seller)).size < MIN_TRADERS || topShare(recent.map((s) => s.seller)) > MAX_ONE_TRADER_SHARE) return out("one_seller");
  if (topShare(read.listings.map((l) => l.holder ?? "?")) > MAX_ONE_LISTER_SHARE) return out("one_lister");
  if (floorDrops === null) return out("no_floor");
  const ratio = medianSaleDrops ? floorDrops / medianSaleDrops : 0;
  if (ratio < BUY_FLOOR_RANGE[0] || ratio > BUY_FLOOR_RANGE[1]) return out("floor_far_from_sales");
  return out(null);
}

/** Has this one NFT been passed around, or sold between the same two wallets? */
export function nftWashed(nftId: string, read: MarketRead, nowMs: number): boolean {
  const mine = read.sales.filter((s) => s.nftId === nftId && nowMs - s.at <= SALE_WINDOW_MS);
  return mine.length >= MAX_FLIPS || cycleShare(mine) > 0;
}

/** A mark from a floor: 110% of it, as registering has it. */
export const floorMark = (floorDrops: number) => (BigInt(floorDrops) * FLOOR_MARK_BPS) / 10_000n;

export type RelistDecision = { readonly kind: "wait" } | { readonly kind: "hold"; readonly reason: "floor_unclear" } | { readonly kind: "add"; readonly markDrops: string; readonly note: "kept" | "lowered" | "unpriced" | "under_market" };

/**
 * What a sold-back NFT's mark should be, if it goes back at all. `market` undefined means no check is set up; null means it can't be read right
 * now, which waits a while and then goes back as it was. A floor can only bring a mark down: the least of its mark and 110% of a floor real sales
 * back. There's no band range in this: the owner, 2026-11-03, wants no price caps on the pack, so an NFT goes back at its own value wherever that is.
 * The pack's guards still stand behind it: the 95% sell-back gate, the treasury's cover, the stock rule.
 */
export function relistDecision(input: { readonly markDrops: string; readonly market: MarketVerdict | null | undefined; readonly waitedLedgers?: number }): RelistDecision {
  const old = BigInt(input.markDrops);
  const verdict = input.market;
  if (verdict === null && (input.waitedLedgers ?? 0) < RELIST_MARKET_WAIT_LEDGERS) return { kind: "wait" };
  const floor = verdict?.floorDrops ?? null;
  if (!verdict || floor === null) return { kind: "add", markDrops: old.toString(), note: verdict === null ? "unpriced" : "kept" };
  if (verdict.medianSaleDrops !== null && floor < verdict.medianSaleDrops * FLOOR_UNCLEAR_SHARE && floorMark(floor) < old) return { kind: "hold", reason: "floor_unclear" };
  const fromFloor = floorMark(floor);
  if (fromFloor < old) return { kind: "add", markDrops: fromFloor.toString(), note: "lowered" };
  return { kind: "add", markDrops: old.toString(), note: BigInt(floor) * 10_000n >= old * UNDER_MARKET_BPS ? "under_market" : "kept" };
}

/** The band whose value range holds this mark on a pack, or null if none does. */
export function bandOfMark(price: NftPrice, markDrops: bigint, rules: Pick<RestockRules, "windowOf"> = configRules()): number | null {
  for (let band = 0; band < BANDS.length; band++) {
    const w = rules.windowOf(price, band);
    if (w && markDrops >= w.minDrops && (w.maxDrops === null || markDrops < w.maxDrops)) return band;
  }
  return null;
}

export interface RebandMove {
  readonly lot: LotState;
  /** The band its mark fits, or null when it fits none (under the pack's floor): it leaves the pool and stays in the vault. */
  readonly to: number | null;
}

/**
 * The NFTs in a pack's pool that sit outside the band their mark fits by the pack's value ranges, and where each goes. Only what a pull could land on
 * counts: lots on their way out or already gone don't. A season whose bands are value tiers (the rarity spec) has these moved before it sells, by a
 * person's remove then restock at the marks they have: scripts/rip-admin.mjs reband. A move changes no mark and no cost.
 */
export function rebandMoves(lots: Iterable<LotState>, price: NftPrice, rules: Pick<RestockRules, "windowOf"> = configRules(), leaving: ReadonlySet<string> = new Set()): RebandMove[] {
  const out: RebandMove[] = [];
  for (const lot of lots) {
    if (lot.price !== price || lot.status !== "available" || lot.removeLedger !== null || leaving.has(lot.lot)) continue;
    const to = bandOfMark(price, BigInt(lot.markDrops), rules);
    if (to !== lot.band) out.push({ lot, to });
  }
  return out.sort((a, b) => (a.lot.nftId < b.lot.nftId ? -1 : 1));
}

/** Lots taken out by a pool change that isn't on the ledger yet: still drawable, but on their way out. */
export function leavingLots(s: RipState): Set<string> {
  const out = new Set<string>();
  for (const p of s.poolChanges.values()) if (!p.anchored) p.removes.forEach((id) => out.add(id));
  return out;
}

/**
 * Whether a pack's value ranges run from its lowest band's floor up with no gap, so every NFT at or over that floor fits exactly one band. Only then can
 * a reband put each NFT in a band by its mark: on $10, whose ranges only steer buys and leave gaps, it would take every NFT in a gap out of the pool.
 */
export function bandsTile(price: NftPrice, rules: Pick<RestockRules, "windowOf"> = configRules()): boolean {
  let at: bigint | null = null;
  for (let band = 0; band < BANDS.length; band++) {
    const w = rules.windowOf(price, band);
    if (!w || (at !== null && w.minDrops !== at)) return false;
    if (w.maxDrops === null) return band === BANDS.length - 1;
    at = w.maxDrops;
  }
  return false;
}

/** A reband's list, saved before anything moves: every NFT it takes out, and the band each goes back in (none for one under every band). */
export interface RebandFile {
  readonly price: NftPrice;
  readonly removes: readonly string[];
  readonly adds: readonly { readonly nftId: string; readonly band: number; readonly collection: string; readonly name: string; readonly img: string; readonly costDrops: string; readonly markDrops: string }[];
}

/**
 * Where a saved reband stands, read from the log and never from the file's word that a step ran. `out`: NFTs still drawable outside the band they're
 * going to (or under every band), so their removal never reached the log, or a relist put them back where they were. `back`: NFTs out of the pool, or
 * on their way out, and not yet in their band. An NFT a pull took is a player's, and in neither.
 */
export function rebandProgress(s: RipState, file: RebandFile): { out: LotState[]; back: RebandFile["adds"][number][] } {
  const leaving = leavingLots(s);
  const to = new Map(file.adds.map((r) => [r.nftId, r]));
  const out: LotState[] = [];
  const back: RebandFile["adds"][number][] = [];
  for (const nftId of file.removes) {
    const lot = s.lots.get(s.nftLot.get(nftId) ?? "");
    if (!lot || lot.price !== file.price) continue;
    const row = to.get(nftId);
    if (lot.status === "available" && lot.removeLedger === null && !leaving.has(lot.lot)) {
      if (!row || lot.band !== row.band) out.push(lot);
    } else if (row && (lot.status === "removed" || lot.status === "available")) {
      // Out of the pool, or on its way out: it goes back in its band.
      back.push(row);
    }
  }
  return { out, back };
}

/** The most one buy may cost: the least of the per-NFT limit, 110% of the floor plus the stop line, the day's budget and the vault's free XRP. A band range with a top adds that top plus the stop line. */
export function buyCapDrops(input: { readonly window: MarkWindow; readonly perNftDrops: bigint; readonly floorDrops: number; readonly stopBps: number; readonly budgetLeftDrops: bigint; readonly spendableDrops: bigint }): bigint {
  const stop = BigInt(10_000 + input.stopBps);
  const caps = [...(input.window.maxDrops === null ? [] : [(input.window.maxDrops * stop) / 10_000n]), input.perNftDrops, (floorMark(input.floorDrops) * stop) / 10_000n, input.budgetLeftDrops, input.spendableDrops];
  const least = caps.reduce((a, b) => (b < a ? b : a));
  return least > 0n ? least : 0n;
}

/** Why this NFT can't be bought, whatever it costs. */
export function nftBuyRefusal(nftId: string): string | null {
  return parseInt(nftId.slice(0, 4), 16) & FLAG_MUTABLE ? "its art can change" : null;
}

/** What a buy would mark an NFT at. */
export const buyMark = (paidDrops: number, floorDrops: number): bigint => {
  const fromFloor = floorMark(floorDrops);
  return BigInt(paidDrops) < fromFloor ? BigInt(paidDrops) : fromFloor;
};

export interface BandGap {
  readonly price: NftPrice;
  readonly band: number;
  readonly bandName: string;
  readonly target: number;
  /** In the pool, on its way there, or being bought. */
  readonly have: number;
  readonly short: number;
}

/**
 * On a season with per-item odds, whether an NFT at this mark would make its band's NFTs rarer together. Past the band's committed excess they scale
 * down as one, and on a band that commits none (5-6's Uncommon) to nothing: a 7.5 XRP Uncommon beside the two at 5 takes all three to 0%. Such a buy
 * takes pulls away from the NFTs it was meant to add to. A band at its cap stays there, give or take the draw's rounding of one part per NFT.
 */
export function buyThinsBand(season: Pick<SeasonState, "nftOdds" | "prizeTable" | "sellBps" | "priceDrops">, band: number, poolMarks: readonly (string | bigint)[], markDrops: bigint): boolean {
  const odds = season.nftOdds;
  if (!odds) return false;
  const share = (marks: readonly (string | bigint)[]) => itemWeights(odds, season.prizeTable, band, marks, season.sellBps, season.priceDrops).reduce((a, w) => a + w, 0);
  return share([...poolMarks, markDrops]) + poolMarks.length + 1 < share(poolMarks);
}

/** How far each band is under its target. What's on its way back or being bought counts as there; what's held out for a person doesn't. */
export function bandGaps(s: RipState, price: NftPrice, season: Pick<SeasonState, "prizeTable">, validated: number, rules: Pick<RestockRules, "targetOf">): BandGap[] {
  const stock = sellableStock(s, price, validated);
  return BANDS.flatMap((bandName, band) => {
    const target = rules.targetOf(price, band);
    if (target <= 0 || tokenOnlyBand(season.prizeTable, band)) return [];
    let coming = 0;
    for (const l of s.lots.values()) {
      if (l.price !== price || l.band !== band) continue;
      // Anchored but live only from the next ledger: stock's count doesn't have it yet, and it's on its way all the same.
      const anchoring = l.status === "available" && l.removeLedger === null && l.addLedger !== null && l.addLedger > validated;
      if (l.status === "pending" || anchoring || (l.status === "returned" && s.nftLot.get(l.nftId) === l.lot && !s.restockHolds.has(l.lot))) coming += 1;
    }
    for (const b of s.buys.values()) if (b.price === price && b.band === band && (b.status === "planned" || b.status === "offered" || b.status === "cancelling" || b.status === "filled")) coming += 1;
    const have = stock[band] + coming;
    return [{ price, band, bandName, target, have, short: Math.max(0, target - have) }];
  });
}

/** XRP committed in the last day: bought, or out on an offer. A buy that ended paid nothing. */
export function spentInDay(s: RipState, nowMs: number): bigint {
  let spent = 0n;
  for (const b of s.buys.values()) if (b.status !== "ended" && nowMs - Date.parse(b.at) < DAY_MS) spent += BigInt(b.offeredDrops);
  return spent;
}

/** The last few broker offers since buying was last switched on, all unfilled? */
export function tooManyMisses(s: RipState): boolean {
  const since = [...s.buys.values()].filter((b) => b.seq > s.autobuyOnSeq);
  const last = since.slice(-MISSES_BEFORE_STOP);
  return last.length >= MISSES_BEFORE_STOP && last.every((b) => b.status === "ended" && b.why === "unfilled");
}

/** A hold's reason, in words for the owner. */
export const HOLD_WORDS: Readonly<Record<string, string>> = {
  // Older logs only: sold-back NFTs aren't held for their band's range any more.
  below_band: "its floor has fallen below this band's window",
  floor_unclear: "its floor is far under what it really sells for: a crash or one wallet's stunt",
  not_in_vault: "it's no longer in the vault",
};

/**
 * Whether anything that changes what's in a pool is still on its way: a sold-back NFT not yet back or held, a pool change not yet on the ledger, a buy under way,
 * or a transaction in flight. While it is, a follow-up pass a few seconds on finishes it, so a pack's page shows it without waiting for the cron.
 */
export function settling(s: RipState): boolean {
  for (const l of s.lots.values()) if (l.status === "returned" && s.nftLot.get(l.nftId) === l.lot && !s.restockHolds.has(l.lot)) return true;
  for (const p of s.poolChanges.values()) if (!p.anchored) return true;
  for (const b of s.buys.values()) if (b.status === "planned" || b.status === "offered" || b.status === "cancelling" || b.status === "filled") return true;
  for (const o of s.orders.values()) if (o.pull === "selling") return true;
  for (const p of s.payouts.values()) if (p.status === "due" || p.status === "sent") return true;
  return s.intents.size > 0;
}
