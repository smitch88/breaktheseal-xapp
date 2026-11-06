import { createHmac, randomBytes } from "node:crypto";
import { NFT_LADDERS, NFT_PRICES, type NftPrice } from "../../config/nft-packs.ts";
import { NEVER_BUY } from "../../config/restock.ts";
import { BAND_BPS, BANDS, DRAW_VERSION, DUST_DROPS, ENTROPY_DELAY, bandOf, commitmentOf, digestOf, fallbackRowOf, invoiceOf, itemBandValue, itemPick, itemWeights, lotsNeeded, nftChanceOf, pickOf, prizeRowOf, seasonTermsHash, seedAt, stockCovers, tokenOnlyBand, xrpCoverFor, type EmptyBand, type PrizeRow } from "./draw.ts";
import { COVER_HEADROOM_BPS, SEAL_LIQUID_SHARE, TOKEN_POLICY, XRP_TOKEN, checkPool, maxRowValue, maxValueOf, prizeTooBig, redeemAmount, strikeAmount, tokenSellDrops, trustSetTx, type Price, type PriceCheck, type SeasonPlan, type TokenSpec } from "./tokens.ts";
import { SELL_FEE_PERCENT } from "../sellback.ts";
import { GatewayRefused, cardSellMicro, type CardGateway } from "./card-gateway.ts";
import { poolRefusal } from "./nftid.ts";
import { fallbackName } from "./nft-art.ts";
import { BROKER_WAIT_LEDGERS, LEDGER_READS_PER_SLUG, BUY_MAX_SHARE, slugOrder, BUY_OFFER_SECONDS, BUY_PLAN_LEDGERS, BUY_ROOM_DROPS, DAY_MS, HOLD_WORDS, READS_PER_SWEEP, RELIST_NO_SWEEP_LEDGERS, bandGaps, bandOfMark, buyCapDrops, buyMark, buyThinsBand, marketVerdict, nftBuyRefusal, nftWashed, pinnedRead, relistDecision, spentInDay, tooManyMisses, type BandGap, type MarketVerdict, type RestockDeps } from "./restock.ts";
import { bestListing, rippleTime } from "./vault-buy.ts";
import { namesShipment, shipMemos } from "./ship.ts";
import { QUOTE_MAX_AGE_MS, RelayRateMoved, RelayRefused, checkUsdcToXrp, checkXrpToUsdc, deliveryMemo, depositMemos, depositRefusal, usdcToXrpBody, xrpToUsdcBody, type CheckedQuote, type RelayRails } from "./relay.ts";
import { apply, emptyState, holdsFor, poolAt, seasonToken, sellableStock, swappedSince, tokenOwed, treasuryOwed, usdcReserved, type Accrual, type BundleState, type BuyState, type CardState, type LotState, type SwapState, type OrderState, type RipState, type SeasonState } from "./state.ts";
import { poolRootV2, sealEvents } from "./log.ts";
import type { EventStore } from "./store.ts";
import { MULTI_HARD_MAX, type MultiConfig } from "./mode.ts";
import type { Chain, ChainTx, Drops, Lot, PayoutItem, RipEventBody, Role, Signer, StrikeReads, TxKind } from "./types.ts";

/** How long a quote stays open, in ledgers. Ledgers close about every 4 seconds, so this is about five minutes. */
export const ORDER_LEDGERS = 80;
/** A transaction we sign is valid for this many ledgers. If it hasn't landed by then it never will, and we sign again. */
export const TX_LEDGERS = 20;
/**
 * How far before a transaction's own range to look for the one that spent its Sequence. That can only have landed after the
 * ledger the stale read answered for, so this covers a server up to an hour behind. Past that it waits, and the alert says so.
 */
export const SPENT_LOOKBACK_LEDGERS = 900;
export const SEASON_LENGTH = 20_000;
export { DUST_DROPS };
/** An NFT's sell-back, as a season commits it: 97% of its mark, less the 2% sell fee. */
export const SELL_BPS = 9506;
/** A SEAL prize's sell-back, before its live price checks. Seasons with no SEAL never use it. */
export const TOKEN_SELL_BPS = 8500;
export const MAX_OPEN_ORDERS = 3;
/**
 * A pack stops selling if selling back an average pull would return more than this share of its price. Marks and pools are
 * on the public log, so if a pool ever drifts or a manifest or price is mistyped, someone can see it and buy only then.
 */
export const MAX_SELL_BACK_SHARE = 0.95;
/** Quotes a wallet can let lapse unpaid in this many ledgers (about an hour) before it has to wait. A hold costs nothing else. */
export const MAX_LAPSED_ORDERS = 3;
export const LAPSE_LEDGERS = 900;
/**
 * Holds one pack (or the card line) can carry at once on a launch's word alone. A launch can name any funded account, so without
 * this a stranger could hold every place on a pack for free. Past it the player confirms their account, and buys as ever.
 */
export const MAX_LAUNCH_HOLDS = 3;
/** How long to wait on a provider's answer before treating it as lost. */
export const GENERATE_WAIT_MS = 120_000;
/** A paid card that hasn't moved in this long goes to a person. */
export const CARD_STALL_MS = 30 * 60_000;
/** Longer than a Solana transaction stays valid, so a sale already signed can't land after a card goes back in the stash. */
export const RESTASH_WAIT_MS = 5 * 60_000;
/** The most steps one card takes in one pass: paid, generated, signed, or source paid, opened, held. */
export const MAX_CARD_HOPS = 4;
/** Below this custody can't sell the cheapest pack Collector Crypt has listed. */
export const CARD_FLOAT_LOW_MICRO = 25_000_000n;
/** About a hundred packs' worth of network fees. Collector Crypt pays the fee on a buyback. */
export const CUSTODY_SOL_LOW_LAMPORTS = 1_000_000n;
/** Room above the minter's reserve for one more mirror: its NFT page and its offer, 0.2 XRP each, and fees. */
export const MINTER_SPARE_DROPS = 500_000n;
/** Mirrors can be retired by the issuer's minter, can be traded, and take XRP only. */
export const MIRROR_FLAGS = 1 | 2 | 8;
/** Room for the XRP moving while a card is being bought with dollars. */
export const CARD_RATE_ROOM_BPS = 50n;
/**
 * The same room once the switch is on. Relay costs about 0.35 to 0.4% against the ledger's own XRP price, so 1% leaves about 0.6% for XRP
 * moving during a five-minute checkout. Past that a swap can't be afforded and the order goes back whole. See the margin table in the report.
 */
export const PASSTHROUGH_RATE_ROOM_BPS = 100n;
/** XRP has fallen this far past a checkout's room: it goes through the checked path, so a quote left open can't be cashed in on the house. */
export const UNDERWATER_BPS = 100n;
/** A deposit Relay hasn't answered for in this long goes to a person. */
export const SWAP_STALL_MS = 10 * 60_000;
/** A paid pack still waiting on Relay after this long goes back whole. */
export const SWAP_GIVE_UP_MS = 30 * 60_000;
/** A refill that failed waits this long before it's tried again, so an outage can't spend fees over and over. */
export const REFILL_RETRY_MS = 5 * 60_000;
/** How often a server looks at whether a refill is due. */
const REFILL_LOOK_MS = 30_000;
/** The same while the log hasn't moved since the last look. */
const REFILL_IDLE_LOOK_MS = 10 * 60_000;
/** A player's own swap that failed tries again much sooner. */
export const SWAP_RETRY_MS = 60_000;
/** An alert from something that isn't in the log stays up this long after it last happened. */
const NOTE_LIFE_MS = 15 * 60_000;
/** A refill out of XRP that has fallen short pays what it can, down to this share of what it replaces. Under it, it waits and says so. */
const REFILL_MIN_SHARE_BPS = 9000n;
/** Sell quotes stay good for five minutes. */
export const SELL_QUOTE_S = 300;
/** How long a paid pull waits on an unreadable token price, in ledgers, before its row pays in XRP instead. About ten minutes. */
export const STRIKE_WAIT_LEDGERS = 150;

/**
 * Each signing account sends one transaction at a time. A wallet that refuses its own payout, or that claims and cancels over
 * and over, would take that slot and write to the log for free, so another try waits this long. About fifteen minutes.
 */
export const RETRY_WAIT_LEDGERS = 225;

/** How long a multi order's quote stays open, in ledgers: about three minutes. A held place is free, so a big hold lasts less than a single's. */
export const BUNDLE_LEDGERS = 45;
/** How many full-size multi orders can sit unpaid on one pack at once. */
export const UNPAID_ORDERS = 2;
/** A quote with fewer ledgers left than this isn't offered again: there's no time to sign it. */
const BUNDLE_MARGIN = 5;
/** Places in one lapsed multi order that count as one lapsed checkout: lapsing a 20 is four of them, and the wallet waits. */
export const LAPSE_PLACES = 5;
/** Children of multi orders that may start buying from a provider in one pass. Each runs its whole chain in that pass, so its payment doesn't die waiting. */
export const CARD_STARTS_PER_PASS = 3;
/** How long one read of a card pack's room is good for. Each read asks Collector Crypt twice and Solana once. */
const CARD_ROOM_MS = 30_000;

export type Refusal = { readonly ok: false; readonly code: string; readonly message: string };
/** A wallet that can't hold the token yet. Nothing changed: the prize is still in the stash, and this is what to sign. */
export type NeedsTrustLine = { readonly ok: false; readonly code: "needs_trustline"; readonly message: string; readonly tx: Readonly<Record<string, unknown>> };
const no = (code: string, message: string): Refusal => ({ ok: false, code, message });
/** The account is only named, by a launch, and this needs a signature behind it. Nothing changed. */
export const CONFIRM_ACCOUNT = "confirm_account";
const confirmFirst = () => no(CONFIRM_ACCOUNT, "Confirm your account in Xaman first. Nothing moved.");

export interface EngineDeps {
  readonly store: EventStore;
  readonly chain: Chain;
  readonly signer: Signer;
  /** The secret every season's seed chain comes from. It is never logged and never leaves the server. */
  readonly drawSecret: string;
  /** Must match the ledger before anything is signed: 1 for testnet, 0 for mainnet. */
  readonly expectedNetworkId: number;
  /** Drops left in the treasury above its reserve that sell-backs may never touch. */
  readonly treasuryFloorDrops?: bigint;
  /** At most this many places count toward a season's XRP cover (SEAL_XRP_COVER_PLACES). Unset: every place held counts. */
  readonly xrpCoverPlacesMax?: number;
  /** Wallets that top up the treasury. Their payments are funding, so they are never refunded back. */
  readonly fundingAddresses?: readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Pause sales when XRP moves this far from a season's rate, in basis points. */
  readonly rateGuardBps?: number;
  /** The card line. Without it, card orders are refused. */
  readonly gateway?: CardGateway;
  /** The mirror's issuer settings. A cold issuer names the minter on the ledger; the minter signs here. */
  readonly mirror?: { readonly issuer: string; readonly transferFee: number; readonly taxon: number; readonly origin: string };
  /** Which packs may sell. Unset means every tier a season is open on. */
  readonly shelf?: readonly NftPrice[];
  /** SEAL_TOKEN_PRIZES=off on a running site: a SEAL row of a season already open pays its value in XRP. */
  readonly sealOff?: boolean;
  /** SEAL_MULTI_QTY=on. Without it no multi order can open or sell out, and one already paid still runs to its end. */
  readonly multi?: MultiConfig;
  /** The passthrough. Unset or not enabled, nothing is ever swapped and the card line works from its float. */
  readonly relay?: RelayRails;
  /** Putting sold-back NFTs back by the rules, and buying more. Unset means a plain re-add at the mark it had, and no buying. */
  readonly restock?: RestockDeps;
  /** Test hook: called after an intent is logged and before it is sent. */
  readonly beforeSubmit?: (intentId: string) => Promise<void> | void;
}

export interface SealFloatStatus {
  readonly token: string;
  readonly held: string;
  readonly owed: string;
  readonly free: string;
  readonly freeXrp: number | null;
  readonly lowXrp: number;
  readonly startXrp: number;
  readonly refillXrp: number;
  readonly priceOk: boolean;
  readonly priceCode: string | null;
  readonly low: boolean;
  readonly pauses: readonly NftPrice[];
}

export type OrderQuote = { readonly ok: true; readonly order: OrderState; readonly tx: Readonly<Record<string, unknown>> };
export type BundleQuote = { readonly ok: true; readonly bundle: BundleState; readonly tx: Readonly<Record<string, unknown>> };
/** A multi order over what's available. `max` is what the server would take right now. */
export type TooMany = { readonly ok: false; readonly code: "qty_too_high"; readonly message: string; readonly max: number };

/** Every write in the system races for the same head, so a burst of checkouts has to spread out or it all loses together. */
const pause = (tries: number) => (tries ? new Promise((r) => setTimeout(r, Math.random() * 60 * tries)) : Promise.resolve());

const hexMemo = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const memo = (type: string, data: string) => ({ Memo: { MemoType: hexMemo(type), MemoData: hexMemo(data) } });

/** One-way: the seed chain's root for a season. Nothing stores it, so a stolen database can't predict a pull. */
export const seasonRoot = (secret: string, season: string) => createHmac("sha256", secret).update(`seal-rips-season|${season}`).digest("hex");

/** A sell-back quote: a share of the lot's mark, rounded down to whole drops. */
export const sellQuote = (markDrops: Drops, sellBps: number): bigint => (BigInt(markDrops) * BigInt(sellBps)) / 10_000n;

/** What an average pull sells back for right now, as a share of the pack's price. Internal, and never shown to a player. */
export function sellBackShare(s: RipState, season: Omit<SeasonState, "prizeTable" | "tokens"> & Partial<Pick<SeasonState, "prizeTable">>, ledger: number, extra?: { readonly band: number; readonly markDrops: bigint } | readonly { readonly band: number; readonly markDrops: bigint }[]): number {
  const extras = extra === undefined ? [] : Array.isArray(extra) ? extra : [extra as { readonly band: number; readonly markDrops: bigint }];
  let average = 0;
  const sellShare = season.sellBps / 10_000;
  BANDS.forEach((_, band) => {
    const pool = poolAt(s, season.price, band, ledger).filter((l) => l.removeLedger === null);
    // Token rows take their share of the band first. XRP pays its face. SEAL is worth what a player can get for it, and they
    // can redeem it and sell it on the pool, so our own lower bid isn't the measure.
    const sealShare = Math.max(sellShare, SEAL_LIQUID_SHARE);
    const rows = (season.prizeTable ?? []).filter((r) => r.band === band);
    const tokenShare = rows.reduce((a, r) => a + r.bps / 10_000, 0);
    const tokens = rows.reduce((a, r) => a + (r.bps / 10_000) * Number(r.valueDrops) * (r.token === XRP_TOKEN ? 1 : sealShare), 0);
    const more = extras.filter((x) => x.band === band);
    // Per-item odds: what the draw itself would pay on this pool, which their scaling keeps at or under the band's committed most.
    if (season.nftOdds) {
      const marks = [...pool.map((l) => l.markDrops), ...more.map((x) => x.markDrops)];
      average += (season.bandBps[band] / 10_000) * itemBandValue(season.nftOdds, season.prizeTable ?? [], band, marks, season.sellBps, season.priceDrops, sealShare);
      return;
    }
    const held = pool.length + more.length;
    // An empty band whose season falls back to its rows pays them on its NFT share too, at their own average.
    const fallback = !held && season.emptyBand === "rows" && tokenShare > 0 ? ((1 - tokenShare) * tokens) / tokenShare : 0;
    const nfts = held ? ((1 - tokenShare) * (pool.reduce((sum, l) => sum + Number(l.markDrops), 0) + more.reduce((sum, x) => sum + Number(x.markDrops), 0)) * sellShare) / held : fallback;
    average += (season.bandBps[band] / 10_000) * (nfts + tokens);
  });
  return average / Number(season.priceDrops);
}

/** What a pack can take right now. `refusal` says why a max of 0 is 0. */
export interface Room {
  readonly max: number;
  readonly refusal: Refusal | null;
}

/** A name from an NFT's own metadata goes on the public log and into a Discord alert, so nothing but plain words and no ping. */
const plainName = (name: string) => name.replace(/[^\p{L}\p{N} #.'-]/gu, "").trim().slice(0, 60);

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const newId = deps.newId ?? (() => randomBytes(16).toString("hex"));
  const treasury = deps.signer.address("treasury");
  const vault = deps.signer.address("vault");
  const minter = deps.gateway && deps.mirror ? deps.signer.address("minter") : null;
  const floor = deps.treasuryFloorDrops ?? 10_000_000n;
  /** A season's XRP cover for `places`, counting at most `xrpCoverPlacesMax` of them: the owner's lower bound (2026-11-03). A prize the
   * treasury can't pay at once is still owed and pays when it's topped up (strikePrize), never taken back. */
  const coverFor = (table: Parameters<typeof xrpCoverFor>[0], bandBps: Parameters<typeof xrpCoverFor>[1], places: number, emptyBand?: EmptyBand) =>
    xrpCoverFor(table, bandBps, deps.xrpCoverPlacesMax ? Math.min(places, deps.xrpCoverPlacesMax) : places, emptyBand);
  const state: RipState = emptyState();
  let networkChecked = false;
  const relayOn = () => deps.relay?.enabled === true;
  /** Checked instructions for Solana swaps opened here. They aren't logged: a server without them lets the quote lapse and asks for a new one. */
  const quoteDetail = new Map<string, CheckedQuote>();
  const notes = new Map<string, { at: number; text: string }>();
  const note = (code: string, text: string) => notes.set(code, { at: nowMs(), text });
  const nowS = () => Math.floor(nowMs() / 1000);
  const microOf = (usd: number) => BigInt(Math.round(usd * 1e6));

  const sync = async () => {
    // Two reads can overlap and finish in either order. Only the next event applies, so the state can't rewind or apply twice.
    for (const e of await deps.store.readFrom(state.head)) if (e.seq === state.head + 1) apply(state, e);
  };

  /** Append or report that the log moved. Callers re-read and decide again, so a lost race costs nothing. */
  const commit = async (drafts: readonly RipEventBody[], basis?: number): Promise<boolean> => {
    if (!drafts.length) return true;
    // `basis` is the head a decision was made on. Other requests on this server move the head during any await, and the
    // store's check only compares against the head at the moment of writing, so a stale decision has to be caught here.
    if (basis !== undefined && basis !== state.head) {
      await sync();
      return false;
    }
    const sealed = sealEvents(state.head, state.headHash, drafts, now().toISOString());
    const ok = await deps.store.append(state.head, sealed);
    await sync();
    return ok;
  };

  /** Decide over awaits, then log it only if the log hasn't moved since the decision began. */
  const decide = async (make: () => Promise<readonly RipEventBody[]> | readonly RipEventBody[]) => {
    const basis = state.head;
    return commit(await make(), basis);
  };

  /** A hold on the shelf costs nothing, so it takes a wallet that can pay and hasn't been walking away from quotes. */
  const walletRefusal = async (address: string, drops: Drops, validated: number, unproven = false, packs = 1): Promise<Refusal | null> => {
    // A launch can name anyone, so holds on its word never count against a wallet's signed-in owner. They only stop more of the same.
    const lapsed = [...state.orders.values(), ...state.cards.values()].filter((o) => o.address === address && o.status === "expired" && !o.bundle && o.lastLedger > validated - LAPSE_LEDGERS && !!o.unproven === unproven).length;
    // A hold on twenty places costs as little as a hold on one, so walking away from a big one counts for more.
    const lapsedBundles = [...state.bundles.values()].filter((b) => b.address === address && b.status === "expired" && b.lastLedger > validated - LAPSE_LEDGERS && !!b.unproven === unproven).reduce((a, b) => a + Math.ceil(b.qty / LAPSE_PLACES), 0);
    // With the switch on, a card that went back after its money started moving counts too: a refund can cost the house a round trip through Relay,
    // so buy-and-refund can't be spun. One that went back before anything moved (Relay down, a cap, the rate) cost only a fee, and was the house's doing.
    let wentBack = 0;
    if (relayOn()) {
      const perBundle = new Map<string, number>();
      for (const c of state.cards.values()) {
        if (c.address !== address || (c.status !== "refund_due" && c.status !== "refunded") || !(c.fundingSwap || c.funding) || c.lastLedger <= validated - LAPSE_LEDGERS || !!c.unproven !== unproven) continue;
        if (c.bundle) perBundle.set(c.bundle, (perBundle.get(c.bundle) ?? 0) + 1);
        else wentBack += 1;
      }
      for (const n of perBundle.values()) wentBack += Math.ceil(n / LAPSE_PLACES);
    }
    if (lapsed + lapsedBundles + wentBack >= MAX_LAPSED_ORDERS) return unproven ? confirmFirst() : no("too_many_lapsed", "Too many unpaid checkouts. Try again in an hour.");
    const info = await deps.chain.account(address);
    if (!info || BigInt(info.balance) < BigInt(drops)) return no("wallet_short", `This wallet doesn't hold enough XRP for ${packs > 1 ? `${packs} packs` : "this pack"}.`);
    return null;
  };

  /** For an answer we must not lose: a lost race only means the log moved, so seal it again on the new head. */
  const commitSurely = async (drafts: readonly RipEventBody[]) => {
    for (let i = 0; i < 6; i++) if (await commit(drafts)) return true;
    throw new Error("the log is too busy to record this");
  };

  /** A player's action that lost a race for the log: read again and decide again, so a double tap isn't an error. */
  const retryBusy = async <T extends { ok: boolean; code?: string }>(attempt: () => Promise<T>): Promise<T> => {
    let last = await attempt();
    for (let tries = 0; tries < 3 && last.code === "busy"; tries++) last = await attempt();
    return last;
  };

  const assertNetwork = async () => {
    if (networkChecked) return;
    const id = await deps.chain.networkId();
    if (id !== deps.expectedNetworkId) throw new Error(`refusing to run: ledger network ${id}, expected ${deps.expectedNetworkId}`);
    networkChecked = true;
    await sync();
    if (!state.genesis && state.head === 0) await commit([{ type: "log_genesis", data: { networkId: id, treasury, vault } }]);
    // A log belongs to one network and one treasury. Pointing a testnet database at mainnet would make its refunds real.
    if (state.genesis && (state.genesis.networkId !== id || state.genesis.treasury !== treasury || state.genesis.vault !== vault)) {
      networkChecked = false;
      throw new Error("refusing to run: this log belongs to a different network or treasury");
    }
  };

  /** A refusal if this card's mirror has to wait after a mint or burn that failed on the ledger. */
  const mirrorWait = async (c: CardState, message: string): Promise<Refusal | null> => {
    if (c.mirrorFailLedger === null || (await deps.chain.validatedLedger()) - c.mirrorFailLedger >= RETRY_WAIT_LEDGERS) return null;
    return no("try_later", message);
  };
  const BURN_FAILED = "The last try to retire this card's NFT didn't go through, so check it's still in this wallet. Your card is safe. Try again in a few minutes.";

  /** A refusal if this pull has to wait after a payout its wallet refused. */
  const payoutWait = async (o: OrderState): Promise<Refusal | null> => {
    if (o.payoutFailLedger === null || (await deps.chain.validatedLedger()) - o.payoutFailLedger >= RETRY_WAIT_LEDGERS) return null;
    return no("try_later", "Your wallet refused the last payment, so check its settings. What you won is safe in your stash. Try again in a few minutes.");
  };

  const seedOf = (season: string, length: number, index: number) => seedAt(seasonRoot(deps.drawSecret, season), length, index);

  /** The pool's price now and half an hour back, checked. One read per validated ledger, shared by every quote in it. */
  let liveCache: { key: string; result: { check: PriceCheck; reads: StrikeReads | null } } | null = null;
  const livePrice = async (spec: TokenSpec, validated: number): Promise<{ check: PriceCheck; reads: StrikeReads | null }> => {
    const key = `${spec.currency}:${spec.issuer}:${validated}`;
    if (liveCache?.key === key) return liveCache.result;
    let result: { check: PriceCheck; reads: StrikeReads | null };
    try {
      const health = await deps.chain.issuerState?.(spec.issuer);
      // A token its issuer can freeze, claw back or skim isn't one we can promise a fixed amount of.
      if (!health || health.globalFreeze || health.clawback || health.transferRate !== 0) result = { check: { ok: false, code: "issuer_unsafe" }, reads: null };
      else {
        const [now, prior] = await Promise.all([deps.chain.ammPool?.(spec, validated), deps.chain.ammPool?.(spec, validated - TOKEN_POLICY.priorLedgers)]);
        result = now && prior ? { check: checkPool(now, prior, TOKEN_POLICY, nowMs()), reads: { now, prior } } : { check: { ok: false, code: "price_unreadable" }, reads: null };
      }
    } catch {
      result = { check: { ok: false, code: "price_unreadable" }, reads: null };
    }
    liveCache = { key, result };
    return result;
  };

  /** The USDC day's room. */
  const dayRoom = () => {
    if (!deps.relay) return 0n;
    const used = swappedSince(state, nowMs() - 24 * 3600_000);
    return deps.relay.policy.maxDayMicro > used ? deps.relay.policy.maxDayMicro - used : 0n;
  };
  /** Why this many dollars can't swap right now, if anything. */
  const overCap = (micro: bigint) => !deps.relay || micro > deps.relay.policy.maxSwapMicro || micro > dayRoom();

  /** XRP that paid pulls could still need at their draw. Any token row pays its value in XRP if its amount can't be set. */
  const xrpHeldForPaidPulls = () => {
    let held = 0n;
    // Twenty paid at once would hold twenty of the biggest prize for the few seconds until they draw, and stop every sale meanwhile. They hold what they could need at the odds, as a place does.
    const children = new Map<string, number>();
    for (const o of state.orders.values()) {
      if (o.status !== "paid") continue;
      if (o.bundle) children.set(o.season, (children.get(o.season) ?? 0) + 1);
      else held += maxRowValue(state.seasons.get(o.season)?.prizeTable ?? []);
    }
    for (const [id, places] of children) {
      const s = state.seasons.get(id);
      if (s) held += coverFor(s.prizeTable, s.bandBps, places, s.emptyBand);
    }
    return held;
  };

  /** The XRP the places held on every open pack could need, plus `more` places on `extra` and one on `also`, at the odds xrpCoverFor works to. */
  const xrpCoverNeed = (extra: NftPrice, more = 1, also?: NftPrice) => {
    let need = 0n;
    for (const s of state.seasons.values()) if (state.activeSeason.get(s.price) === s.season) need += coverFor(s.prizeTable, s.bandBps, holdsFor(state, s.price) + (s.price === extra ? more : 0) + (s.price === also ? 1 : 0), s.emptyBand);
    return need;
  };

  /** The XRP the treasury holds that nothing has a claim on: not what it owes, not paid pulls' draws, not the cover its open packs need, not its floor. */
  const xrpCoverNow = () => {
    let need = 0n;
    for (const s of state.seasons.values()) if (state.activeSeason.get(s.price) === s.season) need += coverFor(s.prizeTable, s.bandBps, holdsFor(state, s.price), s.emptyBand);
    return need;
  };
  const treasuryFree = (balance: bigint) => balance - treasuryOwed(state, relayOn()) - xrpHeldForPaidPulls() - xrpCoverNow() - floor;

  /** Too little free SEAL for one more of this table's biggest prize. A strike the float can't reach pays XRP at value, so one is what a place needs. */
  const sealShort = (table: readonly PrizeRow[], spec: TokenSpec, strike: Price, free: bigint) => free < (strikeAmount(maxValueOf(table, spec.id).toString(), strike) * COVER_HEADROOM_BPS) / 10_000n;

  /**
   * Can this pack promise its token prizes right now? A stale, unreadable or moved price pauses it before anything is
   * charged, and so does XRP that can't cover the places held at the odds, or SEAL that can't cover one prize on top of
   * what's already owed. Free quotes can't close a pack on SEAL this way: any row SEAL can't pay, XRP does, and XRP is what's sized by the places.
   */
  const prizeGate = async (price: NftPrice, season: SeasonState, validated: number, more = 1): Promise<Refusal | null> => {
    const paused = no("prize_paused", "This pack is paused while a prize price settles. Nothing was charged.");
    const short = no("restocking", "This pack is restocking. Try again soon.");
    if (maxRowValue(season.prizeTable) > 0n) {
      const info = await deps.chain.account(treasury);
      if (!info || BigInt(info.balance) - treasuryOwed(state, relayOn()) - floor < xrpCoverNeed(price, more)) return short;
    }
    for (const spec of deps.sealOff ? [] : season.tokens) {
      const biggest = maxValueOf(season.prizeTable, spec.id);
      if (biggest === 0n) continue;
      const { check, reads } = await livePrice(spec, validated);
      if (!check.ok || !reads) return paused;
      if (prizeTooBig(biggest.toString(), reads.now.xrpDrops)) return paused;
      const line = await deps.chain.trustLine?.(treasury, spec).catch(() => null);
      if (!line || sealShort(season.prizeTable, spec, check.strike, BigInt(line.balanceMicro) / 1_000_000n - tokenOwed(state, spec.id))) return short;
    }
    return null;
  };

  /** What a season's pack costs on this tier, or a refusal if it can't be sold. */
  const canSell = (price: NftPrice, ledger: number, xrpUsd: number | null): Refusal | { ok: true; season: string; priceDrops: Drops } => {
    const id = state.activeSeason.get(price);
    const season = id ? state.seasons.get(id) : null;
    if (!season?.live) return no("not_open", "This pack isn't open yet.");
    // A new season is on its way to the ledger. A place held on this one now could land on a table its stock no longer suits.
    for (const s of state.seasons.values()) if (s.price === price && !s.live) return no("season_full", "This pack is between seasons. Try again soon.");
    const holds = holdsFor(state, price);
    if (season.nextIndex + holds >= season.length) return no("season_full", "This pack is between seasons. Try again soon.");
    // Every band must be able to cover every place already held, plus this one. This is the rule that means a paid pull
    // always has an NFT to land on, whichever band it hits.
    const stock = sellableStock(state, price, ledger);
    if (!stockCovers(stock, holds, season.bandBps, season.prizeTable, season.emptyBand)) return no("restocking", "This pack is restocking. Try again soon.");
    if (sellBackShare(state, season, ledger) > MAX_SELL_BACK_SHARE) return no("restocking", "This pack is restocking. Try again soon.");
    if (deps.rateGuardBps !== undefined && season.usdAtOpen !== null) {
      if (xrpUsd === null) return no("no_rate", "XRP's price isn't available right now.");
      const move = Math.abs(xrpUsd - season.usdAtOpen) / season.usdAtOpen;
      if (move * 10_000 > deps.rateGuardBps) return no("rate_moved", "XRP moved too far from this pack's price. It reopens at a new price soon.");
    }
    return { ok: true, season: season.season, priceDrops: season.priceDrops };
  };

  const paymentTx = (o: OrderState) => ({
    TransactionType: "Payment",
    Account: o.address,
    Destination: treasury,
    Amount: o.drops,
    InvoiceID: o.invoice,
    LastLedgerSequence: o.lastLedger,
    Memos: [memo("seal-rips/pack", o.id)],
  });

  const cardPaymentTx = (c: CardState) => ({
    TransactionType: "Payment",
    Account: c.address,
    Destination: treasury,
    Amount: c.drops,
    InvoiceID: c.invoice,
    LastLedgerSequence: c.lastLedger,
    Memos: [memo("seal-rips/card-pack", c.id)],
  });

  const bundlePaymentTx = (b: BundleState) => ({
    TransactionType: "Payment",
    Account: b.address,
    Destination: treasury,
    Amount: b.drops,
    InvoiceID: b.invoice,
    LastLedgerSequence: b.lastLedger,
    Memos: [memo(b.kind === "nft" ? "seal-rips/pack-multi" : "seal-rips/card-pack-multi", `${b.id}:${b.qty}`)],
  });

  /** Pull everything new off the ledger and turn it into log events, in ledger order. */
  const scanTreasury = async (validated: number): Promise<RipEventBody[]> => {
    const from = state.cursors.get(treasury);
    if (from === undefined) return [];
    const drafts: RipEventBody[] = [];
    const nextIndex = new Map<string, number>();
    const indexFor = (season: string) => {
      const n = nextIndex.get(season) ?? state.seasons.get(season)?.nextIndex ?? 0;
      nextIndex.set(season, n + 1);
      return n;
    };
    const claimed = new Set<string>();
    let last = from;
    let dust = false;
    for (const t of await deps.chain.accountTx(treasury, from)) {
      last = Math.max(last, t.ledger);
      if (state.seenTx.has(t.hash) || t.tx.TransactionType !== "Payment" || t.tx.Destination !== treasury || t.result !== "tesSUCCESS" || t.tx.Account === treasury) continue;
      const draft = classify(t, claimed, indexFor);
      if (Array.isArray(draft)) drafts.push(...draft);
      else if (draft) drafts.push(draft);
      else dust = true;
    }
    // The bookmark is a log entry too, so dust can't move it every ledger. Dust behind it is read again, and comes to nothing again.
    const behind = last - (state.cursors.get(treasury) ?? 0);
    if (behind > 0 && (drafts.length || behind > (dust ? 100 : 500))) drafts.push({ type: "scan_cursor", data: { account: treasury, ledger: last } });
    return drafts;
  };

  /**
   * Every inbound payment ends in exactly one place: a pull, a refund, a logged note (funding), or, for dust and tokens, nothing at all.
   * Invoices are public, so dust naming an order gets the same answer as dust naming nothing: a refund per drop would let
   * anyone fill the treasury's one-at-a-time queue for almost nothing, and a log entry per drop would fill the log.
   */
  const classify = (t: ChainTx, claimed: Set<string>, indexFor: (season: string) => number): RipEventBody | RipEventBody[] | null => {
    const from = String(t.tx.Account);
    const base = { txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, from };
    const invoice = typeof t.tx.InvoiceID === "string" ? t.tx.InvoiceID.toUpperCase() : null;
    const orderId = invoice ? state.orderByInvoice.get(invoice) : undefined;
    const order = orderId ? state.orders.get(orderId) : undefined;
    const card = orderId ? state.cards.get(orderId) : undefined;
    const bundle = orderId ? state.bundles.get(orderId) : undefined;
    // A funding wallet can buy a pack like anyone else. It's only funding when it names no order.
    if (!order && !card && !bundle && (from === vault || deps.fundingAddresses?.includes(from))) return { type: "payment_ignored", data: { ...base, reason: "funding" } };
    // A token sent to the treasury just adds to its float. It's dust: a log entry per payment would let a millionth of a SEAL fill the log.
    if (typeof t.delivered !== "string" || !/^\d+$/.test(t.delivered)) return null;
    const drops = t.delivered;
    const sourceTag = typeof t.tx.SourceTag === "number" ? t.tx.SourceTag : null;
    if (BigInt(drops) < DUST_DROPS && drops !== (card ?? order ?? bundle)?.drops) return null;
    // Relay's solver is never a stray: bouncing it would send a sale's money away. It's only signed by Relay's key, so a stranger can't pose as it.
    // A swap counts it later, and only with the memo or Relay's status tying it to that swap. A switch turned off still has to hear about swaps already out.
    if (!order && !card && !bundle && deps.relay && (relayOn() || state.swaps.size > 0) && (deps.relay.policy.xrpSolvers.includes(from) || deps.relay.policy.xrpDepositories.includes(from))) return { type: "relay_arrival", data: { txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, from, drops, memo: deliveryMemo(t.tx.Memos) } };
    // Someone off the list naming one of our swaps. It goes back as any stray does, and if Relay has added a solver, this is how a person hears before it costs a sale.
    if (!order && !card && !bundle && [...state.swaps.values()].some((x) => liveSwap(x) && x.orderId === deliveryMemo(t.tx.Memos))) note("relay_lookalike", `${from} paid the treasury naming a live Relay order and was treated as a stray. If deploy/13-relay-check.mjs says Relay has a new solver, add it to the list.`);
    const refund = (reason: string): RipEventBody => ({ type: "payment_refund_due", data: { id: `pay:${t.hash}`, ...base, drops, reason, order: order?.id ?? bundle?.id ?? null, sourceTag } });
    if (bundle) {
      if (claimed.has(bundle.id) || bundle.status === "paid") return refund("already_paid");
      if (bundle.status === "expired" || t.ledger > bundle.lastLedger) return refund("late");
      if (from !== bundle.address) return refund("wrong_wallet");
      if (drops !== bundle.drops) return refund("wrong_amount");
      claimed.add(bundle.id);
      const paid: RipEventBody = { type: "bundle_paid", data: { bundle: bundle.id, txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, address: from, drops } };
      // One payment, N places in line: consecutive seeds, drawn in this order, so each can be checked on its own.
      if (bundle.kind === "card") return [paid, ...bundle.children.map((id): RipEventBody => ({ type: "card_paid", data: { order: id, txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, address: from, drops: bundle.each } }))];
      return [paid, ...bundle.children.map((id): RipEventBody => ({ type: "pull_paid", data: { order: id, season: bundle.season as string, index: indexFor(bundle.season as string), txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, address: from, drops: bundle.each, entropyLedger: t.ledger + ENTROPY_DELAY } }))];
    }
    if (card) {
      const back = (reason: string): RipEventBody => ({ type: "payment_refund_due", data: { id: `pay:${t.hash}`, ...base, drops, reason, order: card.id, sourceTag } });
      if (claimed.has(card.id) || (card.status !== "quoted" && card.status !== "expired")) return back("already_paid");
      if (card.status === "expired" || t.ledger > card.lastLedger) return back("late");
      if (from !== card.address) return back("wrong_wallet");
      if (drops !== card.drops) return back("wrong_amount");
      claimed.add(card.id);
      return { type: "card_paid", data: { order: card.id, txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, address: from, drops } };
    }
    if (!order) return refund("no_order");
    if (order.status !== "quoted" && order.status !== "expired") return refund("already_paid");
    if (claimed.has(order.id)) return refund("already_paid");
    if (order.status === "expired" || t.ledger > order.lastLedger) return refund("late");
    if (from !== order.address) return refund("wrong_wallet");
    if (drops !== order.drops) return refund("wrong_amount");
    claimed.add(order.id);
    return { type: "pull_paid", data: { order: order.id, season: order.season, index: indexFor(order.season), txHash: t.hash, ledger: t.ledger, txIndex: t.txIndex, address: from, drops, entropyLedger: t.ledger + ENTROPY_DELAY } };
  };

  /**
   * A player taking the vault's zero-price offer shows up on the vault's account. There is no cursor to get wrong: while an
   * offer is open, the scan starts at the ledger that created the oldest one.
   */
  const scanOffers = async (account: string, open: readonly { ledger: number; offerId: string; event: (t: ChainTx) => RipEventBody }[]): Promise<RipEventBody[]> => {
    if (!open.length) return [];
    const cursor = state.cursors.get(account) ?? 0;
    const from = Math.max(cursor, Math.min(...open.map((o) => o.ledger)));
    const drafts: RipEventBody[] = [];
    let last = from;
    for (const t of await deps.chain.accountTx(account, from)) {
      last = Math.max(last, t.ledger);
      if (t.tx.TransactionType !== "NFTokenAcceptOffer" || t.result !== "tesSUCCESS") continue;
      const hit = open.find((o) => o.offerId === String(t.tx.NFTokenSellOffer ?? ""));
      if (hit) drafts.push(hit.event(t));
    }
    // One abandoned offer can't make every pass rescan from its ledger forever. The cursor moves only when no offer of ours
    // is in flight, so every offer that exists is already known to this scan and nothing behind the cursor can be missed.
    const inFlight = [...state.intents.values()].some((i) => i.account === account);
    if (!inFlight && last - cursor > 200) drafts.push({ type: "scan_cursor", data: { account, ledger: last } });
    return drafts;
  };

  const scanVault = () =>
    scanOffers(
      vault,
      [...state.orders.values()]
        .filter((o) => o.offerId && o.offerLedger !== null && (o.pull === "offered" || o.pull === "cancelling"))
        .map((o) => ({ ledger: o.offerLedger as number, offerId: o.offerId as string, event: (t: ChainTx) => ({ type: "claim_accepted" as const, data: { order: o.id, txHash: t.hash, ledger: t.ledger, offerId: o.offerId as string } }) })),
    );

  /** The same for mirrors: the minter's zero-price offer, taken by the player's wallet. */
  const scanMinter = async (): Promise<RipEventBody[]> => {
    if (!minter) return [];
    return scanOffers(
      minter,
      [...state.cards.values()]
        .filter((c) => c.mirror && !c.mirror.accepted)
        .map((c) => ({ ledger: c.mirror?.ledger as number, offerId: c.mirror?.offerId as string, event: (t: ChainTx) => ({ type: "mirror_accepted" as const, data: { order: c.id, txHash: t.hash, ledger: t.ledger, offerId: c.mirror?.offerId as string } }) })),
    );
  };

  /**
   * Move one card one step, journaling before anything that can't be repeated. No USDC moves until a payment we signed lands,
   * so anything that ends before that gives the XRP back whole with no person needed. Signed bytes are stored before they are
   * sent. After a payment has landed, only a person can settle a card that doesn't move.
   */
  const stepCard = async (gw: CardGateway, c: CardState) => {
    const review = (reason: string) => commit([{ type: "card_review", data: { order: c.id, reason } }]);
    const refund = (reason: string) => commit([{ type: "card_refund_due", data: { id: `card:${c.id}`, order: c.id, to: c.address, drops: c.drops, reason } }]);
    const ageMs = (at: string) => now().getTime() - Date.parse(at);
    try {
      if (c.status === "generating") {
        // We asked and never recorded an answer. Another server may still be waiting on it, so give that time. After that a
        // pack may exist, unpaid, and without its answer nothing can ever sign for it. A late answer lands on a finished order.
        if (ageMs(c.generatingAt ?? c.movedAt) > GENERATE_WAIT_MS) await refund("source_unknown");
      } else if (c.status === "held" && c.hold === "exit_source" && ageMs(c.movedAt) > CARD_STALL_MS) {
        // The mirror is already burned and the provider won't take the card. Only a person can settle this.
        await review("stalled_at_exit_source");
      } else if (["signed", "source_paid", "opened"].includes(c.status) && ageMs(c.movedAt) > CARD_STALL_MS) {
        // Paid and not moving: a provider that won't reveal, a card we can't prove, or a Solana we can't read.
        await review(`stalled_at_${c.status}`);
      } else if (c.status === "funding") {
        const x = c.fundingSwap ? state.swaps.get(c.fundingSwap) : null;
        // Its XRP has gone to Relay and hasn't come back as USDC. It goes back whole from what the treasury has free. If Relay delivers later, that USDC is marked to come back, and no pack is ever bought with it.
        if (x?.status === "deposited" && ageMs(x.movedAt) > SWAP_GIVE_UP_MS) await refund("relay_timeout");
      } else if (c.status === "paid" && relayOn() && !c.funding) {
        await fundCard(gw, c, refund, ageMs);
      } else if (c.status === "paid" && relayOn() && c.funding === "swap" && (await gw.floatMicro()) - usdcReserved(state, c.id) < microOf(c.usd)) {
        // USDC landed and custody still can't pay. Less arrived than the pack costs, or a read is behind. Nothing's spent either way.
        const landed = c.fundingSwap ? state.swaps.get(c.fundingSwap) : null;
        if (BigInt(c.landedMicro ?? 0) < microOf(c.usd)) await refund("relay_partial");
        else if (landed && ageMs(landed.movedAt) > SWAP_GIVE_UP_MS) await refund("relay_timeout");
      } else if (c.status === "paid") {
        if (!(await commit([{ type: "card_generating", data: { order: c.id } }]))) return;
        let made: { memo: string; transaction: string };
        try {
          made = await gw.generate(c.code, c.id);
        } catch (e) {
          // A pack may exist or not, and asking again could make another. It's unpaid either way: only we can sign for it.
          await refund(e instanceof GatewayRefused ? "source_refused" : "source_unknown");
          return;
        }
        await commitSurely([{ type: "card_generated", data: { order: c.id, memo: made.memo, transaction: made.transaction } }]);
      } else if (c.status === "generated" && c.memo && c.transaction) {
        let signed: { signature: string; bytes: string };
        try {
          signed = await gw.sign({ memo: c.memo, transaction: c.transaction, usd: c.usd });
        } catch {
          // The provider's payment didn't match our rules, so it's never signed. No money has moved at the source.
          await refund("source_payment_invalid");
          return;
        }
        await commitSurely([{ type: "card_signed", data: { order: c.id, signature: signed.signature, bytes: signed.bytes } }]);
      } else if (c.status === "signed" && c.bytes && c.signature) {
        const status = await gw.sourceStatus(c.signature);
        if (status === "finalized") await commit([{ type: "card_source_paid", data: { order: c.id, signature: c.signature } }]);
        // It ran and failed, which is all or nothing: no USDC moved.
        else if (status === "failed") await refund("source_failed");
        // Well past its blockhash's life, and the chain agrees it can't land and never did.
        else if (ageMs(c.movedAt) > RESTASH_WAIT_MS && (await gw.sourceExpired(c.bytes, c.signature))) {
          // One more witness before XRP goes back. Collector Crypt says no for a pack it never saw paid. A reveal means the payment
          // landed, whatever that read said, and anything else it answers waits, then reaches a person.
          const revealed = c.memo ? await gw.open(c.memo).catch((e) => {
            if (e instanceof GatewayRefused) return null;
            throw e;
          }) : null;
          if (revealed) await commit([{ type: "card_source_paid", data: { order: c.id, signature: c.signature } }]);
          else await refund("source_expired");
        }
        else await gw.send(c.bytes, c.signature);
      } else if (c.status === "source_paid" && c.memo) {
        const opened = await gw.open(c.memo);
        if (opened) {
          const machine = await gw.machine(c.code);
          // One card backs one order. A provider that names a card someone already holds gets a person's attention.
          const taken = [...state.cards.values()].some((o) => o.id !== c.id && o.mint === opened.mint && o.hold !== "sold" && o.hold !== "shipped" && o.status !== "refund_due" && o.status !== "refunded");
          if (taken) {
            await review("card_already_assigned");
            return;
          }
          await commit([{ type: "card_opened", data: { order: c.id, mint: opened.mint, name: opened.name, img: opened.img, grade: opened.grade, insuredMicro: opened.insuredMicro, rarity: opened.rarity, instantBuybackPct: machine?.instantBuybackPct ?? 0 } }]);
        }
      } else if (c.status === "opened" && c.mint) {
        const proof = await gw.prove(c.mint);
        if (proof.held) await commit([{ type: "card_held", data: { order: c.id, mint: c.mint, slot: proof.slot, proof: proof.proof } }]);
      } else if (c.status === "held" && c.hold === "exit_source" && c.mint && c.exit?.kind === "sell") {
        if (!c.exit.started) {
          // Before any sale has been tried, a missing card isn't a sale that landed. XRP is paid only for a sale of ours.
          if (!(await gw.prove(c.mint)).held) {
            await review("custody_gone_before_sale");
            return;
          }
          if (!(await commit([{ type: "card_sell_started", data: { order: c.id } }]))) return;
        }
        const others = [...state.cards.values()].filter((o) => o.id !== c.id && o.mint && o.mint !== c.mint && o.hold !== "sold" && o.hold !== "shipped" && o.status !== "refund_due" && o.status !== "refunded").map((o) => o.mint as string);
        const sold = await gw.sellBack(c.mint, `sell-${c.id}`, { minNetMicro: c.exit.usdMicro, others });
        await commit([{ type: "card_sold_source", data: { order: c.id, usdMicro: sold.usdMicro, ref: sold.ref } }]);
      }
    } catch (e) {
      if (e instanceof Error && e.message === "crash") throw e;
      // The source is down or slow. Everything above is safe to try again on the next pass.
    }
  };

  /**
   * Where this pack's USDC comes from. Custody has it free: pay now, and the XRP follows in a refill. Otherwise its own XRP swaps first, and the
   * pack is asked for only once USDC has landed, so Collector Crypt's one-minute window opens with the money already there.
   */
  const fundCard = async (gw: CardGateway, c: CardState, refund: (reason: string) => Promise<boolean>, ageMs: (at: string) => number) => {
    const relay = deps.relay as RelayRails;
    // Timed from the first try. Every new try logs a step, so the card's own last move can't be the clock: a deposit that keeps dying would never give up.
    const tries = [...state.swaps.values()].filter((x) => x.card === c.id && x.purpose === "buy_first").map((x) => x.openedAt);
    const since = tries.length ? tries.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b)) : c.movedAt;
    if (ageMs(since) > SWAP_GIVE_UP_MS) {
      await refund("relay_unavailable");
      return;
    }
    // A deposit that expired can go again at once. Anything else that failed waits a moment, so a bad route can't fill the log.
    if (failedLately((x) => x.card === c.id && x.deadReason !== "expired", SWAP_RETRY_MS)) return;
    const basis = state.head;
    const usd = microOf(c.usd);
    const free = (await gw.floatMicro()) - usdcReserved(state, c.id);
    if (free >= usd) {
      // XRP that has fallen past its room would be a loss to the house to replace, so it can't take the fast way.
      const rate = await deps.chain.xrpUsd?.().catch(() => null);
      const worth = rate ? (BigInt(c.drops) * microOf(rate)) / 1_000_000n : 0n;
      if (worth * 10_000n >= usd * (10_000n - UNDERWATER_BPS)) {
        await commit([{ type: "card_funding", data: { order: c.id, via: "float" } }], basis);
        return;
      }
    }
    // Custody pays the pack's Solana fees. Without enough SOL its USDC would land and sit, so no XRP goes across. It waits, and goes back whole at the limit.
    const gas = await gw.gasLamports().catch(() => null);
    if (gas === null || gas < CUSTODY_SOL_LOW_LAMPORTS) {
      note("custody_sol_swap", "A paid pack is waiting because custody is too low on SOL to buy it. Top up custody's SOL, or it goes back whole after half an hour.");
      return;
    }
    // A closed machine costs nothing to find out now. After a swap, it costs a round trip.
    const machine = await gw.machine(c.code);
    if (!machine || machine.usd !== c.usd) {
      await refund("machine_changed");
      return;
    }
    if (overCap(usd)) {
      await refund("relay_cap");
      return;
    }
    // A quote is only good for a minute, and the treasury sends one transaction a pass. On a quiet site a pass is the cron's, a minute apart, so a
    // quote opened while another deposit or an anchor is ahead of it would lapse unsent. It waits for a pass where it goes out at once.
    if (!depositGoesNow()) return;
    let q: CheckedQuote;
    try {
      q = checkXrpToUsdc(await relay.api.quote(xrpToUsdcBody(relay.policy, { outMicro: usd })), relay.policy, { outMicro: usd, maxInDrops: BigInt(c.drops) }, nowS());
    } catch (e) {
      if (e instanceof RelayRateMoved) {
        await refund("rate_moved");
        return;
      }
      note(e instanceof RelayRefused ? "relay_refused" : "relay_down", e instanceof RelayRefused ? `A Relay quote was refused and nothing was signed: ${e.message}.` : "Relay isn't answering. Packs that can't be paid from custody are waiting, and go back whole after half an hour.");
      return;
    }
    // The order's own XRP is in the treasury, so this only fails if the treasury is under its floor. Opening a swap that can't send would just spin.
    const info = await deps.chain.account(treasury);
    if (!info || BigInt(info.balance) < BigInt(q.inAmount) + floor) {
      note("treasury_floor", "A paid pack can't swap because the treasury is under its floor. Top it up, or it goes back whole after half an hour.");
      return;
    }
    await commit([{ type: "card_funding", data: { order: c.id, via: "swap" } }, swapDraft(q, "buy_first", c.id, [], usd)], basis);
  };

  const depositGoesNow = () => {
    if ([...state.intents.values()].some((i) => i.account === treasury)) return false;
    // Whatever the treasury would send next goes first: an anchor, a refund or a sale taking its turn. Only a refill's deposit yields to this one.
    const ahead = nextWork("treasury");
    return !ahead || (ahead.kind === "relay_deposit" && state.swaps.get(ahead.ref)?.purpose === "refill");
  };

  /** Custody signs and pays for every Solana transaction. Under this, a USDC swap would fail its simulation every pass, so nothing tries. */
  const custodyCanSend = async (gw: CardGateway) => {
    const gas = await gw.gasLamports().catch(() => null);
    if (gas !== null && gas >= CUSTODY_SOL_LOW_LAMPORTS) return true;
    note("custody_sol_swap", "USDC is waiting to go across because custody is too low on SOL to send it. Top up custody's SOL; sales and refills go by themselves after.");
    return false;
  };

  const swapDraft = (q: CheckedQuote, purpose: SwapState["purpose"], card: string | null, accruals: readonly string[], usdMicro: bigint): RipEventBody => ({ type: "swap_opened", data: { id: newId(), dir: q.dir, purpose, card, accruals, requestId: q.requestId, orderId: q.orderId, depository: q.depository, inAmount: q.inAmount, outMin: q.outMin, outExpected: q.outExpected, deadline: q.deadline, usdMicro: usdMicro.toString() } });

  /** A swap's money isn't re-offered while a failure is fresh, so a dead route can't spend fees on every pass. */
  const failedLately = (match: (x: SwapState) => boolean, waitMs: number) => [...state.swaps.values()].some((x) => match(x) && (x.status === "dead" || x.status === "refunded") && nowMs() - Date.parse(x.movedAt) < waitMs);
  const liveSwap = (x: SwapState) => x.status === "quoted" || x.status === "depositing" || x.status === "signed" || x.status === "deposited";

  /** Sign a USDC deposit and log the bytes, then send them. A second server loses the append and never sends what it signed. */
  const signSwap = async (gw: CardGateway, x: SwapState) => {
    const q = quoteDetail.get(x.id);
    if (!q?.instructions) return;
    const basis = state.head;
    const others = [...state.cards.values()].filter((c) => c.mint && c.hold !== "sold" && c.hold !== "shipped" && c.status !== "refund_due" && c.status !== "refunded").map((c) => c.mint as string);
    let signed: { signature: string; bytes: string };
    try {
      signed = await gw.signRelaySwap({ orderId: x.orderId, instructions: q.instructions, lookupTables: q.lookupTables ?? [], amountMicro: BigInt(x.inAmount), others });
    } catch (e) {
      if (e instanceof Error && e.message === "crash") throw e;
      const why = e instanceof Error ? e.message : "couldn't sign";
      note("relay_refused", `A Relay deposit wasn't signed: ${why}.`);
      await commit([{ type: "swap_dead", data: { id: x.id, reason: why.slice(0, 200) } }], basis);
      return;
    }
    if (await commit([{ type: "swap_signed", data: { id: x.id, signature: signed.signature, bytes: signed.bytes } }], basis)) {
      quoteDetail.delete(x.id);
      await gw.sendRaw(signed.bytes, signed.signature).catch(() => {});
    }
  };

  /** Has this deposit come out the other side? The ledger or Solana says so. Relay's status only ever says where to look. */
  const checkLanding = async (gw: CardGateway, x: SwapState) => {
    const relay = deps.relay as RelayRails;
    const open = [...state.relayArrivals.values()].filter((a) => !a.swap);
    const basis = state.head;
    if (x.dir === "usdc_to_xrp") {
      const named = open.find((a) => a.memo === x.orderId && relay.policy.xrpSolvers.includes(a.from));
      if (named) {
        await commit([{ type: "swap_landed", data: { id: x.id, amount: named.drops, txHash: named.txHash } }], basis);
        return;
      }
    }
    const st = await relay.api.status(x.requestId);
    const hashes = new Set(st.txHashes.map((h) => h.toUpperCase()));
    const listed = open.find((a) => hashes.has(a.txHash.toUpperCase()));
    const gaveBack = st.status === "refund" || st.status === "refunded";
    if (x.dir === "usdc_to_xrp") {
      if (listed && !gaveBack) {
        await commit([{ type: "swap_landed", data: { id: x.id, amount: listed.drops, txHash: listed.txHash } }], basis);
        return;
      }
    }
    if (gaveBack) {
      const c = x.card ? state.cards.get(x.card) : null;
      const refund: RipEventBody[] = x.purpose === "buy_first" && c?.status === "funding" ? [{ type: "card_refund_due", data: { id: `card:${c.id}`, order: c.id, to: c.address, drops: c.drops, reason: "relay_refunded" } }] : [];
      if (x.dir === "xrp_to_usdc") {
        // XRP came back to the treasury. Relay's fee on the way is the house's, and the player gets back what they paid.
        const back = listed ?? open.find((a) => a.memo === x.orderId);
        if (back) await commit([{ type: "swap_refunded", data: { id: x.id, amount: back.drops, txHash: back.txHash } }, ...refund], basis);
      } else {
        for (const sig of st.txHashes) {
          if (state.swapProofs.has(sig)) continue;
          const p = await gw.proveUsdcFill(sig, 1n);
          if (p) {
            await commit([{ type: "swap_refunded", data: { id: x.id, amount: p.micro, signature: sig } }], basis);
            return;
          }
        }
      }
      return;
    }
    if (x.dir === "xrp_to_usdc" && st.status === "success") {
      for (const sig of st.txHashes) {
        // A signature counts once, ever, so an old fill can't pay for a new pack.
        if (state.swapProofs.has(sig)) continue;
        const p = await gw.proveUsdcFill(sig, 1n);
        if (p) {
          await commit([{ type: "swap_landed", data: { id: x.id, amount: p.micro, signature: sig } }], basis);
          return;
        }
      }
    }
  };

  /** Move every open swap as far as it goes. This runs with the switch off too: what's already out still has to finish. */
  const advanceSwaps = async () => {
    if (!deps.relay || !deps.gateway) return;
    const gw = deps.gateway;
    for (const { id } of [...state.swaps.values()]) {
      const x = state.swaps.get(id);
      if (!x) continue;
      try {
        if (x.status === "quoted") {
          if (nowMs() - Date.parse(x.openedAt) > QUOTE_MAX_AGE_MS) await commit([{ type: "swap_dead", data: { id: x.id, reason: "quote_stale" } }], state.head);
          else if (x.dir === "usdc_to_xrp") await signSwap(gw, x);
        } else if (x.status === "signed" && x.signature && x.bytes) {
          const status = await gw.sourceStatus(x.signature);
          if (status === "finalized") await commit([{ type: "swap_deposited", data: { id: x.id, signature: x.signature } }]);
          else if (status === "failed") await commit([{ type: "swap_dead", data: { id: x.id, reason: "deposit_failed" } }]);
          else if (nowMs() - Date.parse(x.movedAt) > RESTASH_WAIT_MS && (await gw.sourceExpired(x.bytes, x.signature))) await commit([{ type: "swap_dead", data: { id: x.id, reason: "deposit_expired" } }]);
          else await gw.sendRaw(x.bytes, x.signature);
        } else if (x.status === "deposited") {
          await checkLanding(gw, x);
        }
      } catch (e) {
        if (e instanceof Error && e.message === "crash") throw e;
        // Relay or Solana is down or slow. Everything here is safe to try again on the next pass.
      }
    }
  };

  /** Payouts that can't go this pass. They wait without holding up what can pay. Empty with the switch off: there, a head of the line that can't pay waits as it always did. */
  const relayWaiting = new Set<string>();

  const preparePayouts = async () => {
    relayWaiting.clear();
    if (!relayOn()) return;
    // Nothing due, nothing to read: an idle site reads no balance for this.
    if (![...state.refunds.values()].some((r) => r.status === "due") && ![...state.cards.values()].some((c) => c.hold === "selling" && c.status !== "review" && c.exit?.drops)) return;
    const info = await deps.chain.account(treasury).catch(() => null);
    if (!info) return;
    const balance = BigInt(info.balance);
    const spare = treasuryFree(balance);
    for (const r of state.refunds.values()) if (r.status === "due" && balance < BigInt(r.drops) + floor) relayWaiting.add(r.id);
    for (const c of state.cards.values()) {
      if (c.hold !== "selling" || c.status === "review" || !c.exit?.drops) continue;
      const need = BigInt(c.exit.drops);
      if (c.exit.passthrough && !c.exit.funded ? spare < need : balance < need + floor) relayWaiting.add(c.id);
    }
  };

  /** Open a swap of custody's USDC. Quote failures don't throw: they say which alert to raise and leave the money where it is. */
  const quoteSell = async (amount: bigint, minOutDrops: bigint): Promise<CheckedQuote | "rate" | "failed"> => {
    const relay = deps.relay as RelayRails;
    try {
      return checkUsdcToXrp(await relay.api.quote(usdcToXrpBody(relay.policy, amount)), relay.policy, { inMicro: amount, minOutDrops }, nowS());
    } catch (e) {
      if (e instanceof RelayRateMoved) return "rate";
      note(e instanceof RelayRefused ? "relay_refused" : "relay_down", e instanceof RelayRefused ? `A Relay quote was refused and nothing was signed: ${e.message}.` : "Relay isn't answering. Sales wait for XRP, and refills wait too.");
      return "failed";
    }
  };

  /** A player's payout that the treasury can't make: its own USDC goes across now, and the payout follows when XRP lands. */
  const openPayoutSwaps = async () => {
    if (!relayOn() || !deps.gateway || !relayWaiting.size) return;
    const gw = deps.gateway;
    const relay = deps.relay as RelayRails;
    // Only ask custody's SOL when a payout actually has USDC to swap.
    if (![...relayWaiting].some((id) => [...state.accruals.values()].some((a) => a.order === (state.refunds.get(id)?.order ?? id) && a.dir === "to_treasury" && a.status === "owed"))) return;
    if (!(await custodyCanSend(gw))) return;
    for (const id of [...relayWaiting]) {
      try {
        const r = state.refunds.get(id);
        const orderId = r?.order ?? id;
        const c = state.cards.get(orderId);
        if (!c) continue;
        const a = [...state.accruals.values()].find((x) => x.order === c.id && x.dir === "to_treasury" && x.status === "owed");
        if (!a) continue;
        if (failedLately((x) => x.accruals.includes(a.id), SWAP_RETRY_MS)) continue;
        const amount = BigInt(a.amount);
        if (overCap(amount)) {
          note("swap_cap", `A payout of ${Number(amount) / 1e6} USDC is over the Relay cap, so it's waiting. Top up the treasury or raise the cap.`);
          continue;
        }
        const basis = state.head;
        const free = (await gw.floatMicro()) - usdcReserved(state, c.id);
        if (free < amount) continue;
        // A sale's figure is fixed, so its USDC has to cover it. A refund is the house's to make whole, and any XRP helps.
        const q = await quoteSell(amount, r ? 1n : BigInt(c.exit?.drops ?? 1));
        if (q === "rate") {
          note("sale_rate_hold", `XRP has moved so far that a sale's USDC no longer covers its quote. It's held rather than paid from anyone else's money. Top up the treasury by ${Number(c.exit?.drops ?? 0) / 1e6} XRP to pay it, or it goes by itself if the price comes back.`);
          continue;
        }
        if (q === "failed") continue;
        const draft = swapDraft(q, r ? "refund_back" : "sell_first", c.id, [a.id], amount);
        if (await commit([draft], basis)) {
          quoteDetail.set((draft.data as { id: string }).id, q);
          const made = state.swaps.get((draft.data as { id: string }).id);
          if (made) await signSwap(gw, made);
        }
      } catch (e) {
        if (e instanceof Error && e.message === "crash") throw e;
      }
    }
  };

  /** Take whole accruals, oldest first, until `want` is met. Never past the caps or `room`. A refill moves only what orders brought in. */
  const pickAccruals = (dir: Accrual["dir"], want: bigint, room: bigint, sizeOf: (a: Accrual) => bigint, skip: (a: Accrual) => boolean = () => false) => {
    const chosen: Accrual[] = [];
    let total = 0n;
    for (const a of [...state.accruals.values()].filter((x) => x.dir === dir && x.status === "owed" && !skip(x)).sort((p, q) => Date.parse(p.createdAt) - Date.parse(q.createdAt))) {
      if (total >= want) break;
      const size = sizeOf(a);
      if (total + size > room || overCap(total + size)) break;
      chosen.push(a);
      total += size;
    }
    return { chosen, total };
  };

  let lastRefillLook = 0;
  let lastRefillHead = -1;
  /**
   * A sale's USDC whose payout hasn't gone yet. It's that payout's own money: its swap is judged against the player's figure, and a refill's isn't.
   * A refill taking it would move it at any price and leave the sale with nothing to swap.
   */
  const saleWaiting = (a: Accrual) => {
    if (a.reason !== "sale") return false;
    const c = state.cards.get(a.order);
    return !!c && (c.hold === "exit_burn" || c.hold === "exit_source" || c.hold === "selling");
  };

  /**
   * Refills: the background work that puts money back on the side it came from. Below a target, owed money comes across in one batch, up to
   * the ceiling. It never takes XRP that's owed or needed for cover, and never USDC promised to a pack or sale. A failure here only ever
   * leaves the float where it is: a player's own money goes first and through its own swap.
   */
  const openRefills = async () => {
    if (!relayOn() || !deps.gateway) return;
    const gw = deps.gateway;
    const relay = deps.relay as RelayRails;
    // Each look reads both balances, and refills can sit owed for days, so this doesn't happen on every pass.
    // When the log has moved, money may have: look again soon. When it hasn't, only a top-up from outside can change the answer, so look rarely.
    const since = nowMs() - lastRefillLook;
    if (since < (relay.refillLookMs ?? REFILL_LOOK_MS) || (state.head === lastRefillHead && since < REFILL_IDLE_LOOK_MS)) return;
    const liveRefill = (dir: SwapState["dir"]) => [...state.swaps.values()].some((x) => x.purpose === "refill" && x.dir === dir && liveSwap(x));
    const owedAny = [...state.accruals.values()].some((a) => a.status === "owed");
    if (!owedAny) return;
    lastRefillLook = nowMs();
    lastRefillHead = state.head;
    try {
      const basis = state.head;
      const info = await deps.chain.account(treasury);
      if (!info) return;
      const xrpFree = treasuryFree(BigInt(info.balance));
      const usdcFree = (await gw.floatMicro()) - usdcReserved(state);
      if (usdcFree < relay.custodyTargetMicro && !liveRefill("xrp_to_usdc") && !failedLately((x) => x.purpose === "refill" && x.dir === "xrp_to_usdc", REFILL_RETRY_MS)) {
        const { chosen, total } = pickAccruals("to_custody", relay.custodyTargetMicro - usdcFree, relay.custodyCeilingMicro - usdcFree, (a) => BigInt(a.usdMicro ?? 0));
        const drops = chosen.reduce((sum, a) => sum + BigInt(a.amount), 0n);
        const urgent = usdcFree < CARD_FLOAT_LOW_MICRO;
        // A refill can't leave the treasury under its own target, unless custody can't even sell a pack.
        if (chosen.length && (total >= relay.minBatchMicro || urgent) && xrpFree - drops >= (urgent ? 0n : relay.treasuryTargetDrops)) {
          let q: CheckedQuote | null = null;
          try {
            q = checkXrpToUsdc(await relay.api.quote(xrpToUsdcBody(relay.policy, { outMicro: total })), relay.policy, { outMicro: total, maxInDrops: drops }, nowS());
          } catch (e) {
            if (e instanceof Error && e.message === "crash") throw e;
            if (!(e instanceof RelayRateMoved)) throw e;
            // XRP fell: it can't buy back quite what the packs cost. It moves what it brought in, the shortfall is the house's, and past a limit it waits.
            q = checkXrpToUsdc(await relay.api.quote(xrpToUsdcBody(relay.policy, { inDrops: drops })), relay.policy, { inDrops: drops, maxInDrops: drops, minOutMicro: (total * REFILL_MIN_SHARE_BPS) / 10_000n }, nowS());
          }
          await commit([swapDraft(q, "refill", null, chosen.map((a) => a.id), total)], basis);
          return;
        }
      }
      if (liveRefill("usdc_to_xrp") || failedLately((x) => x.purpose === "refill" && x.dir === "usdc_to_xrp", REFILL_RETRY_MS)) return;
      const treasuryLow = xrpFree < relay.treasuryTargetDrops;
      const custodyOver = usdcFree > relay.custodyCeilingMicro;
      if (!treasuryLow && !custodyOver) return;
      // Treasury low: move everything owed that custody can spare. Custody over its ceiling: move what's above it.
      const want = treasuryLow ? usdcFree : usdcFree - relay.custodyCeilingMicro;
      const { chosen, total } = pickAccruals("to_treasury", want, usdcFree, (a) => BigInt(a.amount), saleWaiting);
      if (!chosen.length || total < relay.minBatchMicro) return;
      if (!(await custodyCanSend(gw))) return;
      const q = await quoteSell(total, 1n);
      if (q === "failed") {
        note("refill_failed", "A refill to the treasury couldn't get a quote.");
        return;
      }
      if (q === "rate") return;
      const draft = swapDraft(q, "refill", null, chosen.map((a) => a.id), total);
      if (await commit([draft], basis)) {
        const id = (draft.data as { id: string }).id;
        quoteDetail.set(id, q);
        const made = state.swaps.get(id);
        if (made) await signSwap(gw, made);
      }
    } catch (e) {
      if (e instanceof Error && e.message === "crash") throw e;
      note("refill_failed", `A refill couldn't start: ${e instanceof Error ? e.message.slice(0, 120) : "unknown error"}.`);
    }
  };

  /**
   * A provider's payment dies about a minute after it's built, and a player who signed in Xaman may never come back to poll,
   * which leaves only the once-a-minute sweep. So a card takes every step it can in one pass: pay, generate, sign and send
   * go out together, and a slow source can't hold up the next card by more than its own timeouts.
   */
  const advanceCards = async () => {
    if (!deps.gateway) return;
    const gw = deps.gateway;
    let started = 0;
    for (const { id } of [...state.cards.values()]) {
      // A bundle's cards start a few at a time: the provider publishes no rate limit, and a slow pass mustn't let a built payment die.
      const first = state.cards.get(id);
      if (first?.bundle && first.status === "paid" && ++started > CARD_STARTS_PER_PASS) continue;
      // With the switch on, deciding where a pack's USDC comes from is one more step in the same pass.
      for (let hop = 0; hop < MAX_CARD_HOPS + (relayOn() ? 1 : 0); hop++) {
        const c = state.cards.get(id);
        if (!c) break;
        const before = `${c.status}:${c.hold}:${c.funding ?? ""}`;
        await stepCard(gw, c);
        const after = state.cards.get(id);
        if (!after || `${after.status}:${after.hold}:${after.funding ?? ""}` === before) break;
      }
    }
  };

  const resolveIntents = async (validated: number): Promise<RipEventBody[]> => {
    const drafts: RipEventBody[] = [];
    for (const i of state.intents.values()) {
      const found = await deps.chain.tx(i.hash, { account: i.account, minLedger: i.lastLedger - TX_LEDGERS, maxLedger: i.lastLedger });
      if (found.found && found.validated) {
        const { offerId, nftId } = found.tx;
        let stillHeld: boolean | undefined;
        if (i.kind === "claim_cancel" && found.tx.result === "tesSUCCESS") {
          // Only this transaction's own metadata can say it removed the offer, which proves the player hadn't taken it and
          // now never can. A read of the vault can't: a server a ledger behind still shows an NFT the player just took.
          const held = state.orders.get(i.ref);
          const offer = held?.offerId?.toUpperCase();
          stillHeld = !!offer && (found.tx.deletedOffers ?? []).some((d) => d.toUpperCase() === offer);
          // The offer was already gone, so a player cancelled it or took it. The vault holding the NFT at this very ledger, with no
          // accept of that offer on the vault's record, says they cancelled it. Without this it could never leave "offered".
          if (!stillHeld && held?.offerId && held.nftId && held.offerLedger !== null && found.tx.ledger !== null) {
            const inVault = await deps.chain.accountNfts(vault, found.tx.ledger).then((n) => n.some((x) => x.nftId === held.nftId), () => false);
            const taken = inVault ? await deps.chain.accountTx(vault, held.offerLedger).then((all) => all.some((t) => t.tx.TransactionType === "NFTokenAcceptOffer" && t.result === "tesSUCCESS" && String(t.tx.NFTokenSellOffer ?? "").toUpperCase() === offer), () => true) : true;
            stillHeld = !taken;
          }
        }
        if (i.kind === "vault_buy_cancel" && found.tx.result === "tesSUCCESS") {
          const offer = state.buys.get(i.ref)?.offerId?.toUpperCase();
          stillHeld = !!offer && (found.tx.deletedOffers ?? []).some((d) => d.toUpperCase() === offer);
        }
        drafts.push({ type: "tx_final", data: { id: i.id, hash: i.hash, result: found.tx.result, ledger: found.tx.ledger, ...(offerId ? { offerId } : {}), ...(nftId ? { nftId } : {}), ...(stillHeld !== undefined ? { stillHeld } : {}) } });
      } else if (validated > i.lastLedger && !found.found && found.definite) {
        // Past its last ledger, and a server with those whole ledgers says it isn't in them. Before signing the work again,
        // the account's own sequence at that ledger has to agree this transaction never used its number, or the ledger has
        // to show a different transaction of this account that did. Each Sequence is spent once, so that one can never land.
        // A second payment is the one mistake this can't make, so a failed read, or anything less than both proofs, waits.
        const at = await deps.chain.account(i.account, i.lastLedger).catch(() => null);
        if (!at) continue;
        const unused = at.sequence <= i.sequence;
        const spent = !unused && (await deps.chain.accountTx(i.account, i.lastLedger - TX_LEDGERS - SPENT_LOOKBACK_LEDGERS).catch(() => [])).some((t) => t.tx.Account === i.account && t.tx.Sequence === i.sequence && t.hash !== i.hash);
        if (unused || spent) drafts.push({ type: "tx_final", data: { id: i.id, hash: i.hash, result: "expired", ledger: null } });
      }
    }
    return drafts;
  };

  const expireOrders = (validated: number): RipEventBody[] =>
    [...state.orders.values(), ...state.cards.values(), ...state.bundles.values()].filter((o) => o.status === "quoted" && !("bundle" in o && o.bundle) && validated > o.lastLedger).map((o) => ({ type: "order_expired" as const, data: { id: o.id } }));

  /** One answer per question in one draw pass. Twenty pulls on one payment share an entropy ledger, so they ask the same things, and this keeps it to one read each. */
  type PassReads = <T>(kind: string, key: string, read: () => Promise<T>) => Promise<T>;
  const passReads = (): PassReads => {
    const seen = new Map<string, Promise<unknown>>();
    return <T,>(kind: string, key: string, read: () => Promise<T>) => {
      const at = `${kind}:${key}`;
      if (!seen.has(at)) seen.set(at, read());
      return seen.get(at) as Promise<T>;
    };
  };

  /**
   * Strike a token prize at the pull's own entropy ledger. XRP is its value. A token's amount comes from the pool's reserves
   * at that ledger, which anyone can read back. When that amount can't be set fairly (a price that moved or can't be read, a
   * float that can't cover it), the row pays its value in XRP instead. It's never refunded: a whole refund on a cheap row,
   * with the good rows still paying, would let anyone who can push the pool bet one way, and a refund on a big one takes back
   * a win. So XRP running short doesn't void anything: the prize is struck anyway, marked owed, and goes out by itself as soon
   * as the treasury can pay it. `batch` is what earlier draws in this pass have taken, which the log doesn't know yet.
   */
  const strikePrize = async (o: OrderState, season: SeasonState, row: PrizeRow, draw: { seed: string; ledgerHash: string; digest: string; band: number }, validated: number, batch: Map<string, bigint>, reads_: PassReads): Promise<RipEventBody | "wait"> => {
    const entropyLedger = o.entropyLedger as number;
    const base = { order: o.id, season: o.season, index: o.index as number, seed: draw.seed, txHash: o.txHash as string, ledgerHash: draw.ledgerHash, entropyLedger, address: o.address, digest: draw.digest, band: draw.band, valueDrops: row.valueDrops };
    const inXrp = async (code?: string, reads: StrikeReads | null = null): Promise<RipEventBody | "wait"> => {
      const info = await reads_("account", treasury, () => deps.chain.account(treasury)).catch(() => null);
      if (!info) return "wait";
      const amount = BigInt(row.valueDrops);
      const owed = BigInt(info.balance) - treasuryOwed(state, relayOn()) - floor - (batch.get(XRP_TOKEN) ?? 0n) < amount;
      batch.set(XRP_TOKEN, (batch.get(XRP_TOKEN) ?? 0n) + amount);
      return { type: "pull_prize_drawn", data: { ...base, token: XRP_TOKEN, amount: row.valueDrops, reads, ...(code ? { paidInXrp: { token: row.token, code } } : {}), ...(owed ? { owed: true as const } : {}) } };
    };
    if (row.token === XRP_TOKEN) return inXrp();
    const spec = seasonToken(state, o.season, row.token);
    if (!spec || deps.sealOff) return inXrp("token_off");
    // Dust: a row the season committed to as a small prize. A wallet with no SEAL trust line gets its value in XRP: a line costs
    // 0.2 XRP of reserve, too much to ask for a prize this size. A wallet that has one gets the SEAL it rolled.
    let holderLine;
    if (row.dust) {
      try {
        holderLine = await reads_("line", `${o.address}:${spec.id}`, async () => deps.chain.trustLine?.(o.address, spec));
        if (!holderLine) return inXrp("no_trust_line");
      } catch {
        return validated - entropyLedger > STRIKE_WAIT_LEDGERS ? inXrp("price_unreadable") : "wait";
      }
    }
    let reads: StrikeReads;
    try {
      const [nowRead, prior] = await Promise.all([reads_("pool", `${spec.id}:${entropyLedger}`, async () => deps.chain.ammPool?.(spec, entropyLedger)), reads_("pool", `${spec.id}:${entropyLedger - TOKEN_POLICY.priorLedgers}`, async () => deps.chain.ammPool?.(spec, entropyLedger - TOKEN_POLICY.priorLedgers))]);
      if (!nowRead || !prior) throw new Error("no pool");
      reads = { now: nowRead, prior };
    } catch {
      return validated - entropyLedger > STRIKE_WAIT_LEDGERS ? inXrp("price_unreadable") : "wait";
    }
    const check = checkPool(reads.now, reads.prior);
    if (!check.ok) return inXrp(check.code, reads);
    if (prizeTooBig(row.valueDrops, reads.now.xrpDrops)) return inXrp("prize_too_big", reads);
    const amount = strikeAmount(row.valueDrops, check.strike);
    if (amount <= 0n) return inXrp("strike_empty", reads);
    // A line too small to hold this amount, like a leftover zero limit, counts as no line. The swap carries no reads, as replay
    // requires, and pays the row's full value, which a strike never exceeds, so a wallet gains nothing by setting its limit.
    if (holderLine && BigInt(holderLine.limitMicro) - BigInt(holderLine.balanceMicro) < amount * 1_000_000n) return inXrp("no_trust_line");
    let line;
    try {
      line = await reads_("line", `${treasury}:${spec.id}`, async () => deps.chain.trustLine?.(treasury, spec));
    } catch {
      return "wait";
    }
    const free = (line ? BigInt(line.balanceMicro) / 1_000_000n : 0n) - tokenOwed(state, row.token) - (batch.get(row.token) ?? 0n);
    if (free < amount) return inXrp("float_short", reads);
    batch.set(row.token, (batch.get(row.token) ?? 0n) + amount);
    return { type: "pull_prize_drawn", data: { ...base, token: row.token, amount: amount.toString(), reads } };
  };

  /** Draw paid pulls in the order the ledger took their payments, once their entropy ledger is in. */
  const drawPending = async (validated: number): Promise<RipEventBody[]> => {
    // A pool change still on its way to the ledger might already apply to these pulls, so settle it first.
    for (const i of state.intents.values()) if (i.kind === "anchor") return [];
    // A bundle's pulls share a ledger and a transaction, so their places in line break the tie.
    const pending = [...state.orders.values()].filter((o) => o.status === "paid").sort((a, b) => (a.ledger ?? 0) - (b.ledger ?? 0) || (a.txIndex ?? 0) - (b.txIndex ?? 0) || (a.index ?? 0) - (b.index ?? 0));
    const drafts: RipEventBody[] = [];
    const reads_ = passReads();
    // Draws in this batch affect one another, so they work on a scratch list of what has been taken.
    const taken = new Set<string>();
    const struckThisPass = new Map<string, bigint>();
    for (const o of pending) {
      if ((o.entropyLedger ?? Infinity) > validated) break;
      const season = state.seasons.get(o.season);
      if (!season || o.index === null || !o.txHash) continue;
      const seed = seedOf(o.season, season.length, o.index);
      let ledgerHash: string;
      try {
        ledgerHash = await reads_("hash", String(o.entropyLedger), () => deps.chain.ledgerHash(o.entropyLedger as number));
      } catch {
        // This server can't answer for that ledger. Draws wait, in order, and refunds and sales still go out.
        break;
      }
      const digest = digestOf({ season: o.season, index: o.index, seed, txHash: o.txHash, ledgerHash, address: o.address });
      const band = bandOf(digest, season.bandBps);
      // Per-item odds: each NFT in the band its own share, the rest to the band's ladder, or with no rows the pull's XRP back. See ItemOdds in draw.ts.
      if (season.nftOdds) {
        const pool = poolAt(state, o.price, band, o.ledger as number).filter((l) => !taken.has(l.lot));
        const at = itemPick(digest, itemWeights(season.nftOdds, season.prizeTable, band, pool.map((l) => l.markDrops), season.sellBps, season.priceDrops));
        if (at !== null) {
          const lot = pool[at];
          taken.add(lot.lot);
          drafts.push({ type: "pull_drawn", data: { order: o.id, season: o.season, index: o.index, seed, txHash: o.txHash, ledgerHash, entropyLedger: o.entropyLedger as number, address: o.address, digest, band, poolSize: pool.length, pick: at, lot: lot.lot, nftId: lot.nftId } });
          continue;
        }
        const rung = fallbackRowOf(digest, season.prizeTable, band);
        if (rung) {
          const struck = await strikePrize(o, season, rung, { seed, ledgerHash, digest, band }, validated, struckThisPass, reads_);
          if (struck === "wait") break;
          drafts.push(struck);
          continue;
        }
        // A band with no rows (Chase) whose roll fell on a share no NFT in it holds now: the pull's XRP goes back whole.
        drafts.push({ type: "pull_refund_due", data: { id: `pull:${o.id}`, order: o.id, seed, ledgerHash, digest, band, reason: pool.length ? "slot_empty" : "band_empty", to: o.address, drops: o.drops } });
        struckThisPass.set(XRP_TOKEN, (struckThisPass.get(XRP_TOKEN) ?? 0n) + BigInt(o.drops));
        continue;
      }
      const row = prizeRowOf(digest, season.prizeTable, band);
      if (row) {
        const struck = await strikePrize(o, season, row, { seed, ledgerHash, digest, band }, validated, struckThisPass, reads_);
        // The price can't be read just now. Later pulls wait too, so the order on the ledger is the order of the draws.
        if (struck === "wait") break;
        drafts.push(struck);
        continue;
      }
      const pool = poolAt(state, o.price, band, o.ledger as number).filter((l) => !taken.has(l.lot));
      // A season that says so pays an empty band's NFT share from that band's own rows, by their weights, so the pack sells on while it restocks.
      const fallback = !pool.length && season.emptyBand === "rows" ? fallbackRowOf(digest, season.prizeTable, band) : null;
      if (fallback) {
        const struck = await strikePrize(o, season, fallback, { seed, ledgerHash, digest, band }, validated, struckThisPass, reads_);
        if (struck === "wait") break;
        drafts.push(struck);
        continue;
      }
      if (!pool.length) {
        // The stock rule makes this very unlikely, not impossible. If it happens, the player gets their money back, whole.
        drafts.push({ type: "pull_refund_due", data: { id: `pull:${o.id}`, order: o.id, seed, ledgerHash, digest, band, reason: "band_empty", to: o.address, drops: o.drops } });
        struckThisPass.set(XRP_TOKEN, (struckThisPass.get(XRP_TOKEN) ?? 0n) + BigInt(o.drops));
        continue;
      }
      const pick = pickOf(digest, pool.length);
      const lot = pool[pick];
      taken.add(lot.lot);
      drafts.push({ type: "pull_drawn", data: { order: o.id, season: o.season, index: o.index, seed, txHash: o.txHash, ledgerHash, entropyLedger: o.entropyLedger as number, address: o.address, digest, band, poolSize: pool.length, pick, lot: lot.lot, nftId: lot.nftId } });
    }
    return drafts;
  };

  const lotLabel = (l: Pick<LotState, "name" | "price" | "band">) => `${l.name} ($${l.price} ${BANDS[l.band]})`;
  const xrpText = (drops: bigint | string) => `${Number(drops) / 1e6} XRP`;

  /**
   * Sold-back NFTs go back in their pool as new lots, through the same anchored door as a restock. What we paid becomes the lot's cost. Its mark goes
   * by relistDecision. A pack's sales share one pool change and one anchor when they settle close together, and an open pool change holds the next until
   * it's on the ledger, so the treasury's one slot goes to players' money first. A band a checkout needs doesn't wait.
   *
   * `unread` is a player's pass standing in for a sweep that isn't running. It never asks the market. It only takes lots that have waited well past what a market
   * that can't be read makes them wait, and they go back by that same rule. A sweep that's firing always gets to them first.
   */
  const relistPass = async (validated: number, notices: string[], opts: { readonly unread?: boolean } = {}) => {
    const rules = deps.restock?.rules;
    const market = opts.unread ? undefined : deps.restock?.market;
    const byPrice = new Map<NftPrice, LotState[]>();
    for (const l of state.lots.values()) {
      if (l.status !== "returned" || state.nftLot.get(l.nftId) !== l.lot || state.restockHolds.has(l.lot)) continue;
      byPrice.set(l.price, [...(byPrice.get(l.price) ?? []), l]);
    }
    if (!byPrice.size) return;
    const basis = state.head;
    const waited = (l: LotState) => (typeof l.returnedLedger !== "number" ? Infinity : validated - l.returnedLedger);
    const due: LotState[] = [];
    for (const [price, lots] of byPrice) {
      if ([...state.poolChanges.values()].some((p) => p.price === price && !p.anchored)) continue;
      // A pass with the floor check takes everything back that's come in since the last, as soon as it can: a pool should show what's really in it.
      // Sales that settle between two passes still share one pool change and one anchor.
      if (opts.unread) due.push(...lots.filter((l) => waited(l) >= RELIST_NO_SWEEP_LEDGERS));
      else due.push(...lots);
    }
    if (!due.length) return;
    // A read that fails waits for the next pass. The rest of this one still has to pay players.
    const held = await deps.chain.accountNfts(vault).then((list) => new Set(list.map((n) => n.nftId)), () => null);
    if (!held) return;
    const verdicts = new Map<string, MarketVerdict | null>();
    let reads = 0;
    const adds = new Map<NftPrice, Lot[]>();
    const drafts: RipEventBody[] = [];
    const said: string[] = [];
    for (const l of due) {
      if (!held.has(l.nftId)) {
        drafts.push({ type: "restock_hold", data: { lot: l.lot, nftId: l.nftId, reason: "not_in_vault" } });
        said.push(`Held out ${lotLabel(l)}: ${HOLD_WORDS.not_in_vault}. Someone should look.`);
        continue;
      }
      let verdict: MarketVerdict | null | undefined = opts.unread ? null : undefined;
      if (market) {
        const slug = rules?.slugOf(l.nftId) ?? null;
        if (!slug || !rules) verdict = { floorDrops: null, medianSaleDrops: null, notBuyable: "unknown_collection" };
        else if (verdicts.has(slug)) verdict = verdicts.get(slug);
        else if (reads >= READS_PER_SWEEP) continue; // Next sweep's turn.
        else {
          reads += 1;
          const read = await market.read(slug).catch(() => null);
          verdict = read ? marketVerdict(pinnedRead(read, slug, rules), nowMs()) : null;
          verdicts.set(slug, verdict);
        }
      }
      const decision = relistDecision({ markDrops: l.markDrops, market: verdict, waitedLedgers: waited(l) });
      if (decision.kind === "wait") continue;
      if (decision.kind === "hold") {
        drafts.push({ type: "restock_hold", data: { lot: l.lot, nftId: l.nftId, reason: decision.reason } });
        said.push(`Held out ${lotLabel(l)}: ${HOLD_WORDS[decision.reason]}. It stays in the vault until you release it: scripts/rip-admin.mjs release-held ${l.nftId} [markXrp] [band].`);
        continue;
      }
      const order = [...state.orders.values()].find((o) => o.lot === l.lot);
      const list = adds.get(l.price) ?? [];
      list.push({ lot: `${l.nftId.slice(-12)}-${state.head + 1 + drafts.length + list.length}`, nftId: l.nftId, price: l.price, band: l.band, collection: l.collection, name: l.name, img: l.img, costDrops: order?.sellDrops ?? l.costDrops, markDrops: decision.markDrops });
      adds.set(l.price, list);
      // A relist never moves band by itself: what a pull lands on stays what the season's odds were set for. The owner hears when the value says otherwise.
      const fits = rules ? bandOfMark(l.price, BigInt(decision.markDrops), rules) : l.band;
      if (fits !== null && fits !== l.band) said.push(`${lotLabel(l)} went back at ${xrpText(decision.markDrops)}, which fits $${l.price} ${BANDS[fits]} by value. It stays in ${BANDS[l.band]}; to move it: scripts/rip-admin.mjs remove ${l.price} ${l.nftId}, then restock it in ${BANDS[fits]}.`);
      // A floor that fell can bring a mark under the pack's lowest band, which on a season cut to value bands is a prize under its floor. The owner hears of that too.
      const lowest = rules?.windowOf(l.price, 0);
      if (fits === null && lowest && BigInt(decision.markDrops) < lowest.minDrops) said.push(`${lotLabel(l)} went back at ${xrpText(decision.markDrops)}, under the $${l.price} pack's lowest band by value. It stays in ${BANDS[l.band]}; to take it out: scripts/rip-admin.mjs reband ${l.price}.`);
      if (decision.note === "lowered") said.push(`Back in the pool at a lower mark: ${lotLabel(l)}, ${xrpText(l.markDrops)} down to ${xrpText(decision.markDrops)}. Its floor fell.`);
      if (decision.note === "under_market") said.push(`Back in the pool under the market: ${lotLabel(l)} stays at ${xrpText(l.markDrops)}, with its floor well over that. Marks only go up when you register one.`);
      if (decision.note === "unpriced") said.push(`Back in the pool unchecked: ${lotLabel(l)}'s floor couldn't be read, so it went back at ${xrpText(decision.markDrops)} after waiting.`);
    }
    for (const [price, list] of adds) drafts.push({ type: "pool_change", data: { id: `relist-${state.head + 1}-${price}`, price, adds: list, removes: [], root: poolRootV2(price, list, []), v: 2 } });
    if (await commit(drafts, basis)) notices.push(...said);
  };

  /**
   * The vault's XRP a buy may spend. Every NFT in a stash can become a claim offer, and each offer locks a reserve the vault has to have: a bundle can stash ten
   * at once, so those reserves come off before anything is bought. Offers already out are in the owner count.
   */
  let spendableRead: { key: string; read: Promise<[Awaited<ReturnType<Chain["account"]>>, Awaited<ReturnType<Chain["reserves"]>>]> } | null = null;
  const vaultSpendable = async (): Promise<bigint> => {
    // One read of the vault per ledger and log position: the sweep's buyer and its alerts ask the same thing a moment apart.
    const key = `${stepLedger}:${state.head}`;
    if (stepLedger === null || spendableRead?.key !== key) spendableRead = { key, read: Promise.all([deps.chain.account(vault), deps.chain.reserves()]) };
    const pending = spendableRead.read;
    const [info, r] = await pending.catch((e) => {
      if (spendableRead?.read === pending) spendableRead = null;
      throw e;
    });
    if (!info) return 0n;
    let claimable = 0n;
    for (const o of state.orders.values()) if (o.lot && (o.pull === "stashed" || o.pull === "offering")) claimable += 1n;
    const free = BigInt(info.balance) - BigInt(r.base) - (BigInt(info.ownerCount) + claimable) * BigInt(r.inc);
    return free > 0n ? free : 0n;
  };

  /**
   * What the treasury could give up with nothing it owes or may be asked for going short: what's owed, every sell-back sitting in a stash, the prize cover
   * for places held, one more of the biggest sale a pull could bring, and its floor. It's for the owner to read. The engine never moves XRP between wallets.
   */
  const treasurySpare = async (): Promise<bigint> => {
    const info = await deps.chain.account(treasury);
    if (!info) return 0n;
    let stash = 0n;
    for (const o of state.orders.values()) {
      if (!o.lot || (o.pull !== "stashed" && o.pull !== "offering" && o.pull !== "offered" && o.pull !== "cancelling")) continue;
      const lot = state.lots.get(o.lot);
      const season = state.seasons.get(o.season);
      if (lot && season) stash += sellQuote(lot.markDrops, season.sellBps);
    }
    let cover = 0n;
    let top = 0n;
    for (const s of state.seasons.values()) {
      if (state.activeSeason.get(s.price) !== s.season) continue;
      cover += coverFor(s.prizeTable, s.bandBps, holdsFor(state, s.price), s.emptyBand);
      for (const band of BANDS.keys()) {
        for (const l of poolAt(state, s.price, band, Number.MAX_SAFE_INTEGER)) {
          const quote = sellQuote(l.markDrops, s.sellBps);
          if (quote > top) top = quote;
        }
      }
    }
    return BigInt(info.balance) - treasuryOwed(state, relayOn()) - xrpHeldForPaidPulls() - stash - cover - top - floor;
  };

  /** Drive what's already out: see fills, cancel what's waited too long, end what's gone stale, and register what landed. */
  const progressBuys = async (validated: number, notices: string[]) => {
    const open = [...state.buys.values()].filter((b) => b.status !== "ended" && b.status !== "registered");
    if (!open.length) return;
    const basis = state.head;
    const held = await deps.chain.accountNfts(vault).then((list) => new Set(list.map((n) => n.nftId)), () => null);
    if (!held) return;
    const inFlight = (b: BuyState) => [...state.intents.values()].some((i) => i.ref === b.id);
    const drafts: RipEventBody[] = [];
    const said: string[] = [];
    for (const b of open) {
      if (inFlight(b)) continue;
      if (b.status === "planned" && validated - b.createdLedger > BUY_PLAN_LEDGERS) drafts.push({ type: "restock_buy_ended", data: { id: b.id, why: "stale" } });
      if (b.status === "offered" || b.status === "cancelling") {
        const age = validated - (b.offerLedger ?? b.createdLedger);
        if (held.has(b.nftId)) drafts.push({ type: "restock_buy_filled", data: { id: b.id, ledger: validated } });
        else if (b.status === "offered" && !b.cancelTried && b.offerId && age >= BROKER_WAIT_LEDGERS) drafts.push({ type: "restock_buy_cancel", data: { id: b.id } });
        // Past its own expiry and not ours: nothing was paid, and it can't fill now.
        else if (b.status === "offered" && age > BUY_OFFER_SECONDS / 3) drafts.push({ type: "restock_buy_ended", data: { id: b.id, why: b.cancelTried ? "offer_gone" : "offer_expired" } });
      }
    }
    if (drafts.length && !(await commit(drafts, basis))) return;
    const registerBasis = state.head;
    const byPrice = new Map<NftPrice, Lot[]>();
    for (const b of state.buys.values()) {
      if (b.status !== "filled" || !held.has(b.nftId) || inFlight(b)) continue;
      const list = byPrice.get(b.price) ?? [];
      list.push({ lot: `${b.nftId.slice(-12)}-${state.head + 1 + list.length}`, nftId: b.nftId, price: b.price, band: b.band, collection: b.collection, name: b.name, img: b.img, costDrops: b.offeredDrops, markDrops: b.markDrops });
      byPrice.set(b.price, list);
      said.push(`Bought ${b.name} for $${b.price} ${BANDS[b.band]}: ${xrpText(b.offeredDrops)} from ${b.seller}, marked ${xrpText(b.markDrops)}. It goes in the pool once anchored.`);
    }
    const register: RipEventBody[] = [...byPrice].map(([price, list]) => ({ type: "pool_change", data: { id: `b${state.head + 1}-${price}`, price, adds: list, removes: [], root: poolRootV2(price, list, []), v: 2 } }));
    if (register.length && (await commit(register, registerBasis))) notices.push(...said);
  };

  /** Broker offers that keep not filling mean the market changed under the rules. Stop and ask, rather than keep trying. */
  const stopOnMisses = async (notices: string[]) => {
    if (!deps.restock?.autobuy || state.autobuyOff || !tooManyMisses(state)) return;
    if (await commit([{ type: "restock_switch", data: { on: false, by: "auto", why: "broker offers in a row didn't fill" } }])) notices.push("Buying stopped: broker offers in a row didn't fill, so something about the market has changed. Nothing was paid for them. Look, then turn it back on with scripts/rip-admin.mjs autobuy-on.");
  };

  let readTurn = 0;
  /** Listings the ledger or their art turned down, by NFT and listed price, until when. Only ever a reason not to look, never a reason to buy. */
  const turnedDown = new Map<string, number>();
  const LOOK_AGAIN_MS = 30 * 60_000;
  const LOOK_AGAIN_FAILED_MS = 5 * 60_000;

  /** Look for the one NFT most worth buying right now, and log the decision. At most one buy is open at a time, and only the vault's own XRP pays for it. */
  const planBuy = async (validated: number) => {
    // Before the first look at the log: anything that lands during the reads below means the checks here decided on old news.
    const basis = state.head;
    const limits = deps.restock?.autobuy;
    const rules = deps.restock?.rules;
    const market = deps.restock?.market;
    const resolveArt = deps.restock?.art;
    if (!limits || !rules || !market || !resolveArt || state.autobuyOff) return;
    if (!deps.chain.nftInfo || !deps.chain.nftSellOffers) return;
    if ([...state.buys.values()].some((b) => b.status !== "ended" && b.status !== "registered")) return;
    const gaps: BandGap[] = [];
    for (const price of rules.prices) {
      if (deps.shelf && !deps.shelf.includes(price)) continue;
      if (limits.prices && !limits.prices.includes(price)) continue;
      const season = state.seasons.get(state.activeSeason.get(price) ?? "");
      if (season?.live) gaps.push(...bandGaps(state, price, season, validated, rules).filter((g) => g.short > 0));
    }
    if (!gaps.length) return;
    const budgetLeft = limits.dailyDrops - spentInDay(state, nowMs());
    if (budgetLeft <= 0n) return;
    const spendable = (await vaultSpendable()) - limits.keepDrops - BUY_ROOM_DROPS;
    if (spendable <= 0n) return;
    const known = new Set([...state.lots.values()].map((l) => l.nftId));
    // One the ledger turned away waits a day: a seller who keeps pulling a listing can't keep the vault's slot and fill the log. Unfilled offers have their own stop.
    for (const b of state.buys.values()) if (b.status !== "ended" || (b.why?.startsWith("tec") && nowMs() - Date.parse(b.at) < DAY_MS)) known.add(b.nftId);
    const own = new Set([treasury, vault, ...(minter ? [minter] : [])]);
    // The band furthest under its target first. Collections take turns across sweeps, to stay inside the indexer's limits.
    gaps.sort((a, b) => a.have / a.target - b.have / b.target);
    let reads = 0;
    for (const gap of gaps) {
      const window = rules.windowOf(gap.price, gap.band);
      const slugs = slugOrder(rules.allowOf(gap.price, gap.band).filter((x) => !NEVER_BUY.includes(x) && (!limits.collections || limits.collections.has(x))), readTurn, rules.priorityOf);
      if (!window || !slugs.length) continue;
      const season = state.seasons.get(state.activeSeason.get(gap.price) ?? "") as SeasonState;
      let turned = 0;
      const coming = [...state.lots.values()].filter((l) => l.price === gap.price && l.removeLedger === null && (l.status === "pending" || (l.status === "available" && l.addLedger !== null && l.addLedger > validated))).map((l) => ({ band: l.band, markDrops: BigInt(l.markDrops) }));
      for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        // Only a read that goes out to the indexer counts against the sweep's share. A priority collection read a minute ago costs nothing to look at again.
        const fresh = !market.cached?.(slug);
        if (fresh && reads >= READS_PER_SWEEP) continue;
        if (fresh) {
          reads += 1;
          if (rules.priorityOf?.(slug) === undefined) turned += 1;
        }
        const raw = await market.read(slug).catch(() => null);
        if (!raw) continue;
        const read = pinnedRead(raw, slug, rules);
        const verdict = marketVerdict(read, nowMs());
        if (verdict.notBuyable || verdict.floorDrops === null) continue;
        const cap = buyCapDrops({ window, perNftDrops: limits.perNftDrops, floorDrops: verdict.floorDrops, stopBps: rules.stopBps, budgetLeftDrops: budgetLeft, spendableDrops: spendable });
        let ledgerReads = 0;
        for (const listing of read.listings) {
          if (BigInt(listing.drops) > cap || ledgerReads >= LEDGER_READS_PER_SLUG) break;
          if (known.has(listing.nftId) || rules.slugOf(listing.nftId) !== slug) continue;
          if (poolRefusal(listing.nftId) || nftBuyRefusal(listing.nftId) || nftWashed(listing.nftId, read, nowMs())) continue;
          // One the ledger already turned down at this price waits: the indexer keeps listing it for half an hour, and asking again every minute only costs calls.
          const look = `${listing.nftId}:${listing.drops}`;
          if ((turnedDown.get(look) ?? 0) > nowMs()) continue;
          const no = (ms = LOOK_AGAIN_MS) => {
            if (turnedDown.size > 500) for (const [k, until] of turnedDown) if (until <= nowMs()) turnedDown.delete(k);
            turnedDown.set(look, nowMs() + ms);
          };
          // The indexer named it. The ledger decides: who holds it, what they really ask, and through whom. A turn-down is only ever remembered, never a yes.
          ledgerReads += 1;
          const onLedger = await Promise.all([deps.chain.nftInfo(listing.nftId), deps.chain.nftSellOffers(listing.nftId)]).catch(() => null);
          if (!onLedger) {
            no(LOOK_AGAIN_FAILED_MS);
            continue;
          }
          const [info, offers] = onLedger;
          const { best } = bestListing(offers, info.owner, vault, rippleTime(nowMs()));
          const markDrops = best ? buyMark(best.allInDrops, verdict.floorDrops) : 0n;
          // What's already on its way in counts: a buy registered and not yet anchored, a relist, a person's restock. Two buys can't each pass alone and fail together.
          const before = sellBackShare(state, season, validated, coming);
          const after = sellBackShare(state, season, validated, [...coming, { band: gap.band, markDrops }]);
          // Band membership by value: an NFT is bought for a band only if its mark is that band's kind of NFT.
          const fitsBand = markDrops >= window.minDrops && (window.maxDrops === null || markDrops < window.maxDrops);
          // Per-item odds: one dear enough to scale the band's NFTs down together would take pulls away from them. The same pool the sell-back line reads.
          const bandMarks = [...poolAt(state, gap.price, gap.band, validated).filter((l) => l.removeLedger === null).map((l) => l.markDrops), ...coming.filter((x) => x.band === gap.band).map((x) => x.markDrops)];
          const thins = buyThinsBand(season, gap.band, bandMarks, markDrops);
          if (info.burned || !info.owner || own.has(info.owner) || !best?.seller || own.has(best.seller) || !best.offerIndex || BigInt(best.allInDrops) > cap || !fitsBand || thins || (after > BUY_MAX_SHARE && after >= before)) {
            no();
            continue;
          }
          const art = await resolveArt(info.uri, listing.nftId).catch(() => null);
          if (!art) {
            no();
            continue;
          }
          // A lot already in that collection names it best.
          const collection = [...state.lots.values()].find((l) => rules.slugOf(l.nftId) === slug)?.collection ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          const id = `buy-${state.head + 1}-${listing.nftId.slice(-12)}`;
          await commit([{ type: "restock_buy_planned", data: { id, nftId: listing.nftId, price: gap.price, band: gap.band, slug, collection, name: plainName(art.name ?? "") || fallbackName(collection, listing.nftId), img: art.img, route: best.route, offerIndex: best.route === "direct" ? best.offerIndex : null, broker: best.broker, seller: best.seller, listDrops: String(best.listDrops), offeredDrops: String(best.allInDrops), markDrops: markDrops.toString(), createdLedger: validated } }], basis);
          return;
        }
      }
      readTurn += turned;
    }
  };

  /** Redemptions that can't go this pass, because the treasury is short of that token. They wait, show on the admin page, and don't hold up what can pay. */
  const waitingRedeems = new Set<string>();
  /** The same for payouts: one that can't go yet mustn't stop a smaller one behind it. */
  const waitingPayouts = new Set<string>();

  /** The ledger has the last word before a token leaves: no trust line means back in the stash, with nothing lost. */
  const prepareRedeems = async () => {
    waitingRedeems.clear();
    waitingPayouts.clear();
    let xrpOnHand: bigint | null = null;
    for (const p of state.payouts.values()) {
      if (p.status !== "due") continue;
      xrpOnHand ??= BigInt((await deps.chain.account(treasury))?.balance ?? 0);
      if (xrpOnHand < BigInt(p.total) + floor) waitingPayouts.add(p.id);
    }
    for (const o of [...state.orders.values()]) {
      // A payout's items go together, and the payout answers for them.
      if (o.payout) continue;
      if (o.pull !== "redeeming" || !o.prize) continue;
      // One on its way can only be settled by the ledger. Pulling it back now could pay it twice.
      if ([...state.intents.values()].some((i) => i.kind === "prize_redeem" && i.ref === o.id)) continue;
      if (o.prize.token === XRP_TOKEN) {
        xrpOnHand ??= BigInt((await deps.chain.account(treasury))?.balance ?? 0);
        if (xrpOnHand < BigInt(o.prize.amount) + floor) waitingRedeems.add(o.id);
        continue;
      }
      const basis = state.head;
      const spec = seasonToken(state, o.season, o.prize.token);
      if (!spec) {
        waitingRedeems.add(o.id);
        continue;
      }
      const need = BigInt(o.prize.amount) * 1_000_000n;
      try {
        const [line, ours] = await Promise.all([deps.chain.trustLine?.(o.address, spec), deps.chain.trustLine?.(treasury, spec)]);
        if (!line || line.frozen || BigInt(line.limitMicro) - BigInt(line.balanceMicro) < need) {
          await commit([{ type: "redeem_returned", data: { order: o.id, reason: "needs_trustline" } }], basis);
          continue;
        }
        if (!ours || BigInt(ours.balanceMicro) < need) waitingRedeems.add(o.id);
      } catch {
        waitingRedeems.add(o.id);
      }
    }
  };

  const nextSale = (): { kind: TxKind; ref: string; build: () => Record<string, unknown> } | null => {
    for (const p of state.payouts.values()) {
      if (p.status === "due" && !waitingPayouts.has(p.id)) return { kind: "payout", ref: p.id, build: () => ({ TransactionType: "Payment", Destination: p.address, Amount: p.total, Memos: [memo("seal-rips/payout", p.id)] }) };
    }
    for (const o of state.orders.values()) {
      if (o.payout) continue;
      if (o.pull === "redeeming" && o.prize && !waitingRedeems.has(o.id)) {
        const { token, amount } = o.prize;
        const spec = seasonToken(state, o.season, token);
        if (token !== XRP_TOKEN && !spec) continue;
        return { kind: "prize_redeem", ref: o.id, build: () => ({ TransactionType: "Payment", Destination: o.address, Amount: redeemAmount(amount, token, spec), Memos: [memo("seal-rips/redeem", o.id)] }) };
      }
      if (o.pull === "selling" && o.sellDrops) {
        const drops = o.sellDrops;
        return { kind: "sellback", ref: o.id, build: () => ({ TransactionType: "Payment", Destination: o.address, Amount: drops, Memos: [memo("seal-rips/sell", o.id)] }) };
      }
    }
    for (const c of state.cards.values()) {
      if (c.hold === "selling" && c.exit?.drops && c.status !== "review" && !relayWaiting.has(c.id)) {
        const { by, drops } = c.exit;
        return { kind: "card_sellback", ref: c.id, build: () => ({ TransactionType: "Payment", Destination: by, Amount: drops as string, Memos: [memo("seal-rips/card-sell", c.id)] }) };
      }
    }
    return null;
  };

  /** The next transaction each signing account should send. One in flight per account, so sequence numbers can't collide. */
  const buyWork = (): { kind: TxKind; ref: string; build: () => Record<string, unknown> } | null => {
    for (const b of state.buys.values()) {
      if (b.status === "planned") {
        // Switched off between the plan and the send: it doesn't go, and it ages out as stale.
        if (state.autobuyOff || !deps.restock?.autobuy) continue;
        const signal = [memo("seal-rips/buy", b.id)];
        return { kind: "vault_buy", ref: b.id, build: () => (b.route === "direct" ? { TransactionType: "NFTokenAcceptOffer", NFTokenSellOffer: b.offerIndex, Memos: signal } : { TransactionType: "NFTokenCreateOffer", NFTokenID: b.nftId, Owner: b.seller, Amount: b.offeredDrops, Destination: b.broker, Flags: 0, Expiration: rippleTime(nowMs()) + BUY_OFFER_SECONDS, Memos: signal }) };
      }
      if (b.status === "cancelling" && b.offerId) {
        const offerId = b.offerId;
        return { kind: "vault_buy_cancel", ref: b.id, build: () => ({ TransactionType: "NFTokenCancelOffer", NFTokenOffers: [offerId], Memos: [memo("seal-rips/buy-cancel", b.id)] }) };
      }
    }
    return null;
  };

  const nextWork = (role: Role): { kind: TxKind; ref: string; build: () => Record<string, unknown> } | null => {
    const busy = (a: string) => [...state.intents.values()].some((i) => i.account === a);
    if (role === "treasury" && !busy(treasury)) {
      for (const s of state.seasons.values()) {
        if (!s.live) {
          const ref = `season:${s.season}`;
          return { kind: "anchor", ref, build: () => ({ TransactionType: "AccountSet", Memos: [memo("seal-rips/commit", `${s.season}:${s.commit}:${s.length}:${DRAW_VERSION}:${seasonTermsHash(s)}`)] }) };
        }
      }
      for (const p of state.poolChanges.values()) {
        if (!p.anchored) {
          const ref = `pool:${p.id}`;
          return { kind: "anchor", ref, build: () => ({ TransactionType: "AccountSet", Memos: [memo("seal-rips/pool", `${p.id}:${p.root}`)] }) };
        }
      }
      // A deposit a player is waiting on takes its turn among them. Refills go last, when nobody's waiting.
      const deposit = (player: boolean): { kind: TxKind; ref: string; build: () => Record<string, unknown> } | null => {
        for (const x of state.swaps.values()) {
          if (x.dir === "xrp_to_usdc" && x.status === "quoted" && (x.purpose !== "refill") === player) return { kind: "relay_deposit", ref: x.id, build: () => ({ TransactionType: "Payment", Destination: x.depository, Amount: x.inAmount, Memos: depositMemos(x.orderId) }) };
        }
        return null;
      };
      if (state.lastTreasuryKind !== "relay_deposit") {
        const first = deposit(true);
        if (first) return first;
      }
      // Refunds and sell-backs take turns, so a flood of stray payments can't hold up a player's sale, or the reverse.
      const sellFirst = state.lastTreasuryKind === "refund";
      if (sellFirst) {
        const sale = nextSale();
        if (sale) return sale;
      }
      for (const r of state.refunds.values()) {
        if (r.status === "due" && !relayWaiting.has(r.id)) {
          return {
            kind: "refund",
            ref: r.id,
            build: () => ({ TransactionType: "Payment", Destination: r.to, Amount: r.drops, ...(r.sourceTag !== null ? { DestinationTag: r.sourceTag } : {}), Memos: [memo("seal-rips/refund", `${r.reason}:${r.paymentTx ?? ""}`)] }),
          };
        }
      }
      const sale = nextSale();
      if (sale) return sale;
      const left = deposit(true) ?? deposit(false);
      if (left) return left;
    }
    if (role === "minter" && minter && deps.mirror && !busy(minter)) {
      const { issuer, transferFee, taxon, origin } = deps.mirror;
      for (const c of state.cards.values()) {
        if (c.status === "review") continue;
        if (c.hold === "minting") {
          // One transaction makes the mirror and a free offer only this wallet can take.
          return {
            kind: "mirror_mint",
            ref: c.id,
            build: () => ({ TransactionType: "NFTokenMint", Issuer: issuer, NFTokenTaxon: taxon, Flags: MIRROR_FLAGS, TransferFee: transferFee, URI: hexMemo(`${origin}/api/mirror/${c.id}`), Amount: "0", Destination: c.address, Memos: [memo("seal-rips/mirror", `${c.id}:${c.mint}:${c.proof}`)] }),
          };
        }
        if (c.hold === "exit_burn" && c.mirror) {
          const { nftId, accepted } = c.mirror;
          const owner = accepted ? c.exit?.by : undefined;
          return { kind: "mirror_burn", ref: c.id, build: () => ({ TransactionType: "NFTokenBurn", NFTokenID: nftId, ...(owner ? { Owner: owner } : {}), Memos: [memo("seal-rips/retire", `${c.id}:${c.exit?.kind}`)] }) };
        }
      }
    }
    if (role === "vault" && !busy(vault)) {
      for (const o of state.orders.values()) {
        if (o.pull === "offering" && o.nftId) {
          const nftId = o.nftId;
          return { kind: "claim_offer", ref: o.id, build: () => ({ TransactionType: "NFTokenCreateOffer", NFTokenID: nftId, Amount: "0", Flags: 1, Destination: o.address, Memos: [memo("seal-rips/claim", o.id)] }) };
        }
        if (o.pull === "cancelling" && o.offerId) {
          const offerId = o.offerId;
          return { kind: "claim_cancel", ref: o.id, build: () => ({ TransactionType: "NFTokenCancelOffer", NFTokenOffers: [offerId] }) };
        }
      }
      // Players' claims first. A buy waits its turn on the vault's one slot.
      const buy = buyWork();
      if (buy) return buy;
    }
    return null;
  };

  const sendNext = async (role: Role, validated: number) => {
    // Sign, log the intent, then send. If we crash after logging, the next pass sends the same bytes again, which the
    // ledger treats as one transaction. A second server loses the append and never sends what it signed.
    const basis = state.head;
    const work = nextWork(role);
    if (!work) return;
    const account = deps.signer.address(role);
    const info = await deps.chain.account(account);
    if (!info) throw new Error(`${role} account isn't funded`);
    const base = work.build();
    if (work.kind === "relay_deposit") {
      // The last look before anything goes to an outside address, and a refill can't have come to depend on XRP that's since been spoken for.
      const x = state.swaps.get(work.ref) as SwapState;
      const refused = depositRefusal(base, x, deps.relay?.policy.xrpDepositories);
      // A deposit that can't go is ended here, not left at the head of the line holding up everyone else's payout.
      const notFree = x.purpose === "refill" ? treasuryFree(BigInt(info.balance)) < BigInt(x.inAmount) : BigInt(info.balance) < BigInt(x.inAmount) + floor;
      if (refused || notFree || !relayOn()) {
        if (refused) note("relay_refused", `A deposit wasn't signed: ${refused}.`);
        await commit([{ type: "swap_dead", data: { id: x.id, reason: refused ?? (notFree ? "not_free" : "switch_off") } }], basis);
        return;
      }
    }
    const paysXrp = work.kind === "refund" || work.kind === "sellback" || work.kind === "card_sellback" || work.kind === "payout" || (work.kind === "prize_redeem" && typeof base.Amount === "string");
    if (paysXrp && BigInt(info.balance) < BigInt(String(base.Amount)) + floor) return; // Stays due, and shows on the admin page.
    if (work.kind === "vault_buy") {
      const b = state.buys.get(work.ref);
      // The vault's balance may have moved since the plan. It's refused here, and the plan goes stale.
      if (!b || (await vaultSpendable()) - (deps.restock?.autobuy?.keepDrops ?? 0n) - BUY_ROOM_DROPS < BigInt(b.offeredDrops)) return;
    }
    const fee = await deps.chain.fee();
    const tx = { ...base, Account: account, Sequence: info.sequence, Fee: fee, LastLedgerSequence: validated + TX_LEDGERS };
    const signed = deps.signer.sign(role, tx);
    const id = `${work.kind}:${signed.hash}`;
    const ok = await commit([{ type: "tx_intent", data: { id, kind: work.kind, ref: work.ref, account, sequence: info.sequence, lastLedger: tx.LastLedgerSequence, hash: signed.hash, tx, blob: signed.blob } }], basis);
    if (!ok) return;
    await deps.beforeSubmit?.(id);
    await deps.chain.submit(signed.blob);
  };

  const resend = async (validated: number) => {
    for (const i of state.intents.values()) {
      // Past its last ledger the ledger can't take it, and resubmitting only keeps it cached on the server.
      if (validated > i.lastLedger) continue;
      // A buy logged and then switched off: a send that never went out doesn't go now. It expires, and the plan ages away.
      if (i.kind === "vault_buy" && (state.autobuyOff || !deps.restock?.autobuy)) continue;
      await deps.beforeSubmit?.(i.id);
      await deps.chain.submit(i.blob).catch(() => {});
    }
  };

  /** A live price for selling a struck token back. XRP has no sale: it's already XRP, so it just redeems. */
  const prizeSellQuote = async (o: OrderState): Promise<{ ok: true; drops: Drops } | Refusal> => {
    if (!o.prize) return no("not_stashed", "Only something in your stash can be sold.");
    if (o.prize.token === XRP_TOKEN) return no("no_sale", "XRP prizes go straight to your wallet. Redeem it instead.");
    const spec = seasonToken(state, o.season, o.prize.token);
    const season = state.seasons.get(o.season);
    if (!spec || !season) return no("sell_paused", "Selling is paused for a moment. Your prize is safe in your stash.");
    const { check } = await livePrice(spec, await deps.chain.validatedLedger());
    if (!check.ok) return no("sell_paused", "Selling is paused while the price settles. Your prize is safe in your stash.");
    return { ok: true, drops: tokenSellDrops(o.prize.amount, check.sell, TOKEN_SELL_BPS, o.prize.valueDrops).toString() };
  };

  const sellPrice = (address: string, orderId: string): { ok: true; drops: Drops } | Refusal => {
    const o = state.orders.get(orderId);
    if (!o || o.address !== address) return no("not_yours", "That isn't yours.");
    if (o.prize) return no("live_price", "Ask for a live price.");
    if (o.pull !== "stashed" || !o.lot) return no("not_stashed", "Only something in your stash can be sold.");
    const lot = state.lots.get(o.lot);
    const season = state.seasons.get(o.season);
    if (!lot || !season) return no("not_stashed", "Only something in your stash can be sold.");
    return { ok: true, drops: sellQuote(lot.markDrops, season.sellBps).toString() };
  };

  /** A live quote that passes every check, one per amount for a little while. A pack can't swap past the caps. */
  let relayOk: { key: string; at: number } | null = null;
  const relayCanBring = async (short: bigint, pack: bigint) => {
    const relay = deps.relay as RelayRails;
    if (pack > relay.policy.maxSwapMicro || short > dayRoom()) return false;
    const key = pack.toString();
    if (relayOk?.key === key && nowMs() - relayOk.at < 20_000) return true;
    try {
      checkXrpToUsdc(await relay.api.quote(xrpToUsdcBody(relay.policy, { outMicro: pack })), relay.policy, { outMicro: pack, maxInDrops: (1n << 62n) }, nowS());
      relayOk = { key, at: nowMs() };
      return true;
    } catch {
      return false;
    }
  };

  /**
   * How many of this pack custody's free USDC pays for, and with the switch on, how many more Relay can bring today: each card swaps on its own,
   * so each has to fit one swap, and all of them the day's room. Off, it's custody alone, as it always was.
   */
  const cardFits = async (free: bigint, usd: bigint) => {
    const floatFits = free <= 0n ? 0 : Number(free / usd);
    if (!relayOn()) return floatFits;
    const extra = Number(dayRoom() / usd);
    return extra > 0 && (await relayCanBring(usd, usd)) ? floatFits + extra : floatFits;
  };

  const sellCanLand = async (gross: bigint, drops: bigint) => {
    const q = await quoteSell(gross, drops);
    return q !== "rate" && q !== "failed";
  };

  let lastAdvanceMs = 0;
  let running: Promise<void> | null = null;
  let closedCache: { key: string; closed: ReadonlySet<NftPrice> } | null = null;
  let roomCache: { key: string; rooms: Readonly<Record<string, number>> } | null = null;
  const cardRooms = new Map<string, { at: number; max: number }>();

  /**
   * The largest order this pack can take right now. Every test a single order passes, then the same rules at N places: seeds left in the
   * season, the stock rule, and XRP for the prizes at the odds. Selling back needs no test of its own: every pick is uniform across its band,
   * so the average pull is worth the same however many came first, and the guard in canSell already says what that is.
   */
  /** The other packs a buyer could open right now, as far as stock and XRP cover go. */
  const packsOpenElsewhere = (price: NftPrice, validated: number, free: bigint) =>
    [...state.activeSeason.keys()].filter((p) => {
      const s = state.seasons.get(state.activeSeason.get(p) as string);
      return p !== price && (!deps.shelf || deps.shelf.includes(p)) && !!s?.live && stockCovers(sellableStock(state, p, validated), holdsFor(state, p), s.bandBps, s.prizeTable, s.emptyBand) && free >= xrpCoverNeed(p);
    });

  const roomFor = async (price: NftPrice, validated: number, xrpUsd: number | null, known?: { readonly gated: true; readonly balance: () => Promise<bigint | null> }): Promise<Room> => {
    if (deps.shelf && !deps.shelf.includes(price)) return { max: 0, refusal: no("not_open", "This pack isn't open yet.") };
    if (!known) {
      const can = canSell(price, validated, xrpUsd);
      if (!can.ok) return { max: 0, refusal: can };
      const gate = await prizeGate(price, state.seasons.get(can.season) as SeasonState, validated);
      if (gate) return { max: 0, refusal: gate };
    }
    const cap = deps.multi?.max ?? 1;
    if (cap <= 1) return { max: 1, refusal: null };
    const season = state.seasons.get(state.activeSeason.get(price) as string) as SeasonState;
    const stock = sellableStock(state, price, validated);
    const holds = holdsFor(state, price);
    let free: bigint | null = null;
    if (maxRowValue(season.prizeTable) > 0n) {
      const balance = known ? await known.balance() : await deps.chain.account(treasury).then((info) => (info ? BigInt(info.balance) : null));
      free = balance === null ? -1n : balance - treasuryOwed(state, relayOn()) - floor;
    }
    // XRP cover is shared, so a hold here can close a pack there. Any other pack with stock to sell keeps room for one single too.
    const others = free === null ? [] : packsOpenElsewhere(price, validated, free);
    let room = 1;
    for (let n = 2; n <= cap + 1; n++) {
      if (season.nextIndex + holds + n > season.length) break;
      if (!stockCovers(stock, holds + n - 1, season.bandBps, season.prizeTable, season.emptyBand)) break;
      if (free !== null && free < xrpCoverNeed(price, n)) break;
      if (free !== null && others.some((p) => (free as bigint) < xrpCoverNeed(price, n - 1, p))) break;
      room = n;
    }
    // A hold costs nothing, so holds can't be what closes a pack. One order always leaves a place for someone buying one. Unpaid multi orders together hold no more than two orders could,
    // so one buyer's quote doesn't shut the picker for the next.
    const unpaid = [...state.bundles.values()].filter((b) => b.price === price && b.status === "quoted").reduce((a, b) => a + b.qty, 0);
    return { max: Math.max(1, Math.min(room - 1, cap, cap * UNPAID_ORDERS - unpaid)), refusal: null };
  };

  /** Whether this wallet's own orders leave room: one open multi checkout at a time, and it counts as a checkout with the rest. */
  const openOf = (address: string, validated: number) => {
    const quoted = [...state.bundles.values()].filter((b) => b.address === address && b.status === "quoted");
    return {
      bundles: quoted.filter((b) => b.lastLedger > validated + BUNDLE_MARGIN),
      /** Every one still holding places, even with too little time left to offer again. A wallet can't stack another on top of it. */
      holding: quoted.length,
      /** The same with a signature behind it. A launch can name anyone, so holds on its word never count against a wallet's signed-in owner, as with one pack. */
      holdingProven: quoted.filter((b) => !b.unproven).length,
      proven: quoted.filter((b) => !b.unproven && b.lastLedger > validated + BUNDLE_MARGIN).length,
      singles: [...state.orders.values(), ...state.cards.values()].filter((o) => o.address === address && o.status === "quoted" && !o.bundle && !o.unproven && o.lastLedger > validated + 20).length,
    };
  };
  const OPEN_CHECKOUT = "You already have a multi-pack checkout open. Pay it, or wait for it to end. Nothing has been charged.";

  /** The validated ledger the last pass ran on, so the restocker's part of the same pass doesn't ask again. */
  let stepLedger: number | null = null;
  const step = async () => {
    await assertNetwork();
    await sync();
    const validated = await deps.chain.validatedLedger();
    stepLedger = validated;
    // The order matters. Results first, then new payments, then expiries, and expiries only once this pass's payments are in
    // the log: a scan that lost the race for the log hasn't recorded them, and an order paid in time would read as unpaid.
    // Then draws, then at most one new transaction for each account.
    await decide(() => resolveIntents(validated));
    const scanned = await decide(() => scanTreasury(validated));
    await decide(scanVault);
    await decide(scanMinter);
    if (scanned) await decide(() => expireOrders(validated));
    await decide(() => drawPending(validated));
    // With a market to ask, this waits for the sweep, so no player's request ever waits on an indexer. If the sweep isn't running, this is what still brings sold-back NFTs home.
    const late: string[] = [];
    await relistPass(validated, late, { unread: !!deps.restock?.market });
    for (const line of late) console.warn(`seal-rips: ${line}`);
    await advanceCards();
    await advanceSwaps();
    await resend(validated);
    await prepareRedeems();
    await preparePayouts();
    await openPayoutSwaps();
    await openRefills();
    await sendNext("treasury", validated);
    await sendNext("vault", validated);
    if (minter) await sendNext("minter", validated);
  };

  /** Move everything forward as far as the ledger allows. Safe to call from anywhere, any number of times. */
  const advance = async (opts: { minGapMs?: number } = {}) => {
    const t = now().getTime();
    if (running) return running;
    if (opts.minGapMs && t - lastAdvanceMs < opts.minGapMs) return sync();
    lastAdvanceMs = t;
    running = step().finally(() => {
      running = null;
    });
    return running;
  };

  /**
   * advance, then the restocker's part that finishes what's under way: sold-back NFTs back in with the floor check, and buys seen through to their pool. `buy` adds
   * looking for the next one. The ledger reads only when the restocker is set up, and only once.
   */
  const restockPass = async (opts: { readonly buy: boolean }, pass: () => Promise<void> = advance): Promise<{ notices: readonly string[] }> => {
    await pass();
    const notices: string[] = [];
    if (!deps.restock) return { notices };
    const before = state.head;
    try {
      const validated = stepLedger ?? (await deps.chain.validatedLedger());
      if (deps.restock.market) await relistPass(validated, notices);
      await progressBuys(validated, notices);
      if (opts.buy) {
        await stopOnMisses(notices);
        await planBuy(validated);
      }
    } catch (e) {
      // Players' money has already moved on this pass. A market or ledger read that failed here tries again next minute.
      console.warn(`seal-rips: restock pass stopped: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    // What that decided goes out on this pass, not the next one's.
    if (state.head !== before) await pass();
    return { notices };
  };

  return {
    state,
    chain: deps.chain,
    sync,
    advance,

    /**
     * The cron's pass: everything advance does, then the restocker, whose market reads and buying only ever run from here. `notices` is what a person should
     * hear about once. A second server doing the same at the same moment loses the log and buys nothing: every decision is made on the head it read.
     */
    async sweep(): Promise<{ notices: readonly string[] }> {
      return restockPass({ buy: true }, () => this.advance());
    },

    /**
     * A pass a few seconds after a sale or a buy, off any player's request: the same as the sweep, but it never looks for something new to buy. Run while
     * settling(state) says something that changes a pool is still on its way, so a sold-back or bought NFT shows on its pack in seconds instead of at the next cron.
     */
    async followUp(): Promise<{ notices: readonly string[] }> {
      return restockPass({ buy: false }, () => this.advance());
    },

    /** The kill switch: off stops new buys on the next sweep. An offer already out is still canceled. It's on the log, so a restart keeps it. */
    async setAutobuy(on: boolean, by: string, why: string | null = null) {
      await assertNetwork();
      await sync();
      if (on === !state.autobuyOff) return true;
      // It's the owner's stop button: a lost race for the head means try again here, not an answer to them.
      return commitSurely([{ type: "restock_switch", data: { on, by, why } }]).catch(() => false);
    },

    /** Owner: put back a sold-back NFT that was held out. Never above its old mark. Its band can change, since a floor that fell may mean it belongs lower. */
    async releaseHeld(nftId: string, by: string, opts: { markDrops?: string; band?: number } = {}): Promise<{ ok: true; id: string } | Refusal> {
      await assertNetwork();
      for (let tries = 0; tries < 4; tries++) {
        await sync();
        const l = state.lots.get(state.nftLot.get(nftId) ?? "");
        if (!l || l.status !== "returned" || !state.restockHolds.has(l.lot)) return no("not_held", `${nftId} isn't held out.`);
        const mark = opts.markDrops ?? l.markDrops;
        if (!/^[1-9][0-9]*$/.test(mark) || BigInt(mark) > BigInt(l.markDrops)) return no("bad_mark", "A mark can come down here, not go up. Register it as a new NFT to raise one.");
        const band = opts.band ?? l.band;
        if (!(band >= 0 && band < BANDS.length)) return no("bad_band", `Band ${band} doesn't exist.`);
        const basis = state.head;
        if (!(await deps.chain.accountNfts(vault)).some((n) => n.nftId === nftId)) return no("not_in_vault", `${nftId} isn't in the vault.`);
        const order = [...state.orders.values()].find((o) => o.lot === l.lot);
        const id = `release-${state.head + 1}-${l.price}`;
        const adds: Lot[] = [{ lot: `${nftId.slice(-12)}-${state.head + 1}`, nftId, price: l.price, band, collection: l.collection, name: l.name, img: l.img, costDrops: order?.sellDrops ?? l.costDrops, markDrops: mark }];
        if (await commit([{ type: "pool_change", data: { id, price: l.price, adds, removes: [], root: poolRootV2(l.price, adds, []), v: 2 } }], basis)) return { ok: true, id };
      }
      return no("busy", "Try again.");
    },

    /** Where the restocker stands, for the admin page and the owner's tools. */
    async restockStatus() {
      await assertNetwork();
      await sync();
      const validated = await deps.chain.validatedLedger();
      const rules = deps.restock?.rules;
      const gaps = rules
        ? rules.prices.flatMap((price) => {
            const season = state.seasons.get(state.activeSeason.get(price) ?? "");
            return season ? bandGaps(state, price, season, validated, rules) : [];
          })
        : [];
      const limits = deps.restock?.autobuy ?? null;
      return {
        on: !!limits && !state.autobuyOff,
        limits,
        off: state.autobuyOff,
        gaps,
        spentDayDrops: spentInDay(state, nowMs()),
        vaultSpendableDrops: await vaultSpendable(),
        treasurySpareDrops: await treasurySpare(),
        holds: [...state.restockHolds.entries()].map(([lot, h]) => ({ lot, ...h })),
        buys: [...state.buys.values()].slice(-30),
      };
    },

    /** Set a tier's price and seed chain. Sales open once the commitment is on the ledger. */
    async openSeason(price: NftPrice, priceDrops: Drops, usdAtOpen: number | null = null, plan?: SeasonPlan) {
      await assertNetwork();
      // A pack off the shelf can't be opened, by any tool.
      if (deps.shelf && !deps.shelf.includes(price)) return null;
      await sync();
      const basis = state.head;
      // A checkout held on the old season pays out on the old table against today's stock, so a switch waits until none is open.
      if (holdsFor(state, price) > 0) return null;
      // A season's anchor takes the treasury's slot ahead of any pool change's, so a change still on its way would land after the new season went live,
      // and that season's first pulls would draw on a pool its odds weren't cut for. The change goes on the ledger first, then the season.
      if ([...state.poolChanges.values()].some((p) => p.price === price && !p.anchored)) return null;
      // A season still on its way to the ledger is the one this would open again: a rerun waits for it instead of opening the next.
      if ([...state.seasons.values()].some((s) => s.price === price && !s.live)) return null;
      const count = [...state.seasons.values()].filter((s) => s.price === price).length;
      const season = `${price}-${count + 1}`;
      const commitment = commitmentOf(seasonRoot(deps.drawSecret, season), SEASON_LENGTH);
      const validated = await deps.chain.validatedLedger();
      // From here on no payment can be missed, however long the server is down: the scan resumes from this ledger.
      const cursor: RipEventBody[] = state.cursors.has(treasury) ? [] : [{ type: "scan_cursor", data: { account: treasury, ledger: validated } }];
      const ok = await commit([...cursor, { type: "season_open", data: { season, price, priceDrops, bandBps: plan?.bandBps ?? BAND_BPS, commit: commitment, length: SEASON_LENGTH, sellBps: SELL_BPS, usdAtOpen, drawVersion: DRAW_VERSION, ...(plan?.prizeTable.length ? { prizeTable: plan.prizeTable, tokens: plan.tokens, ...(plan.emptyBand ? { emptyBand: plan.emptyBand } : {}), ...(plan.emptyBand && plan.nftOdds ? { nftOdds: plan.nftOdds } : {}) } : {}) } }], basis);
      return ok ? season : null;
    },

    /**
     * Add NFTs to a pool or take them out. Adds must be in the vault and able to reach a player. Nothing changes until the
     * change is on the ledger, and it applies from the next ledger on, so it can't be aimed at a pull already paid.
     */
    async changePool(price: NftPrice, adds: readonly Omit<Lot, "lot" | "price">[], removes: readonly string[] = [], opts: { allowBurnable?: boolean } = {}): Promise<{ ok: true; id: string } | Refusal> {
      await assertNetwork();
      await sync();
      const validated = await deps.chain.validatedLedger();
      const held = new Set((await deps.chain.accountNfts(vault)).map((n) => n.nftId));
      const lots: Lot[] = [];
      if (new Set(adds.map((a) => a.nftId)).size !== adds.length) return no("duplicate", "The same NFT is listed twice.");
      for (const a of adds) {
        if (!(a.band >= 0 && a.band < BANDS.length)) return no("bad_band", `Band ${a.band} doesn't exist.`);
        if (!held.has(a.nftId)) return no("not_in_vault", `${a.nftId} isn't in the vault.`);
        const refusal = poolRefusal(a.nftId, opts);
        if (refusal) return no("not_eligible", `${a.nftId}: ${refusal}.`);
        const current = state.lots.get(state.nftLot.get(a.nftId) ?? "");
        // A lot that was taken out is closed once its removal is on the ledger and no paid pull can still land on it.
        const closed = current?.status === "available" && current.removeLedger !== null && current.removeLedger <= validated && ![...state.orders.values()].some((o) => o.price === current.price && o.status === "paid" && (o.ledger ?? 0) < (current.removeLedger as number));
        if (current && current.status !== "removed" && !closed) return no("already_listed", `${a.nftId} is already in a pool.`);
        // The buyer registers what it buys, on the terms it logged. A second set of terms would fail the public replay for good.
        if ([...state.buys.values()].some((b) => b.nftId === a.nftId && b.status !== "ended" && b.status !== "registered")) return no("being_bought", `${a.nftId} is being bought, and goes in by itself.`);
        lots.push({ ...a, price, lot: `${a.nftId.slice(-12)}-${state.head + lots.length + 1}` });
      }
      // Taking a lot out can't leave a band short of the places already held.
      const holds = holdsFor(state, price);
      const stock = sellableStock(state, price, validated);
      for (const id of removes) {
        const l = state.lots.get(id);
        if (!l || l.status !== "available" || l.price !== price) return no("not_available", `${id} can't be removed.`);
        stock[l.band] -= 1;
        if (stock[l.band] < holds) return no("holds", "Open orders still need that band.");
      }
      const id = `p${state.head + 1}-${price}`;
      const ok = await commit([{ type: "pool_change", data: { id, price, adds: lots, removes, root: poolRootV2(price, lots, removes), v: 2 } }]);
      return ok ? { ok: true, id } : no("busy", "Try again.");
    },

    /** Open an order and hold a place on the pack. Nothing is charged until the wallet's payment is on the ledger. */
    async createOrder(address: string, price: NftPrice, xrpUsd: number | null = null, opts: { unproven?: boolean } = {}): Promise<OrderQuote | Refusal> {
      const unproven = !!opts.unproven;
      await assertNetwork();
      if (deps.shelf && !deps.shelf.includes(price)) return no("not_open", "This pack isn't open yet.");
      for (let tries = 0; tries < 8; tries++) {
        await pause(tries);
        await sync();
        const validated = await deps.chain.validatedLedger();
        // One wallet can't sit on the stock: a repeat tap gets its open order back, and open orders are capped.
        const mine = [...state.orders.values()].filter((o) => o.address === address && o.status === "quoted" && !o.bundle && o.lastLedger > validated + 20);
        const same = mine.find((o) => o.price === price);
        if (same) return { ok: true, order: same, tx: paymentTx(same) };
        if (!unproven && mine.filter((o) => !o.unproven).length + openOf(address, validated).proven >= MAX_OPEN_ORDERS) return no("too_many", "Finish or wait out your open checkouts first.");
        const can = canSell(price, validated, xrpUsd);
        if (!can.ok) return can;
        const basis = state.head;
        const season = state.seasons.get(can.season) as SeasonState;
        // A launch's word takes only so many places, and never the last one: a buyer with a signature behind them can always still get in.
        if (unproven && ([...state.orders.values()].filter((o) => o.unproven && o.status === "quoted" && o.price === price).length >= MAX_LAUNCH_HOLDS || !stockCovers(sellableStock(state, price, validated), holdsFor(state, price) + 1, season.bandBps, season.prizeTable, season.emptyBand))) return confirmFirst();
        const refused = await walletRefusal(address, can.priceDrops, validated, unproven);
        if (refused) return refused;
        const gate = await prizeGate(price, season, validated);
        if (gate) return gate;
        if (unproven && (await prizeGate(price, season, validated, 2))) return confirmFirst();
        // The same on any other pack that can sell: a hold on a launch's word can't be what closes it for someone signed in.
        if (unproven && deps.multi) {
          const info = await deps.chain.account(treasury);
          const free = info ? BigInt(info.balance) - treasuryOwed(state, relayOn()) - floor : -1n;
          if (packsOpenElsewhere(price, validated, free).some((p) => free < xrpCoverNeed(price, 1, p))) return confirmFirst();
        }
        const id = newId();
        const ok = await commit([{ type: "order_created", data: { id, season: can.season, price, address, invoice: invoiceOf(id), drops: can.priceDrops, lastLedger: validated + ORDER_LEDGERS, createdLedger: validated, ...(unproven ? { unproven } : {}) } }], basis);
        if (ok) {
          const order = state.orders.get(id) as OrderState;
          return { ok: true, order, tx: paymentTx(order) };
        }
      }
      return no("busy", "Try again.");
    },

    /** The switch, for routes and pages. Null while it's off. */
    multi: deps.multi ?? null,

    /** The most packs one order on this NFT pack can take right now. Reads the ledger each time: an order asks this once, and pages ask quantityRooms. */
    async quantityRoom(price: NftPrice, xrpUsd: number | null = null): Promise<Room> {
      await assertNetwork();
      await sync();
      return roomFor(price, await deps.chain.validatedLedger(), xrpUsd);
    },

    /**
     * The same for every open pack, for pages. It rests on closedPacks, which already asked everything a checkout asks, so this adds one treasury read per
     * validated ledger and log position, however many people have a page open.
     */
    async quantityRooms(validated: number, rate: () => Promise<number | null>): Promise<Readonly<Record<string, number>>> {
      const closed = await this.closedPacks(validated, rate);
      const key = `${validated}:${state.head}`;
      if (roomCache?.key === key) return roomCache.rooms;
      let read: Promise<bigint | null> | null = null;
      const balance = () => (read ??= deps.chain.account(treasury).then((info) => (info ? BigInt(info.balance) : null)));
      const rooms: Record<string, number> = {};
      for (const price of state.activeSeason.keys()) rooms[String(price)] = closed.has(price) ? 0 : (await roomFor(price, validated, null, { gated: true, balance })).max;
      roomCache = { key, rooms };
      return rooms;
    },

    /** Open a multi order and hold its places. One payment, the exact total, and nothing is charged until it's on the ledger. */
    async createBundle(address: string, price: NftPrice, qty: number, xrpUsd: number | null = null, opts: { unproven?: boolean } = {}): Promise<BundleQuote | Refusal | TooMany> {
      const unproven = !!opts.unproven;
      if (!deps.multi) return no("multi_off", "That isn't available.");
      await assertNetwork();
      if (deps.shelf && !deps.shelf.includes(price)) return no("not_open", "This pack isn't open yet.");
      if (!Number.isInteger(qty) || qty < 2 || qty > MULTI_HARD_MAX) return no("bad_qty", "That isn't a quantity we can sell.");
      for (let tries = 0; tries < 8; tries++) {
        await pause(tries);
        await sync();
        const validated = await deps.chain.validatedLedger();
        const open = openOf(address, validated);
        const same = open.bundles.find((b) => b.price === price && b.qty === qty);
        if (same) return { ok: true, bundle: same, tx: bundlePaymentTx(same) };
        if (unproven ? open.holding : open.holdingProven) return no("open_checkout", OPEN_CHECKOUT);
        if (!unproven && open.singles >= MAX_OPEN_ORDERS) return no("too_many", "Finish or wait out your open checkouts first.");
        const basis = state.head;
        const room = await roomFor(price, validated, xrpUsd);
        if (room.refusal) return room.refusal;
        // A launch's word takes only so many places on a pack, counted place by place, so a bundle can't carry more than the singles could. Past that the player confirms and buys as ever.
        // The last place of stock or XRP cover is already kept back in the room, for everyone.
        if (unproven && [...state.orders.values()].filter((o) => o.unproven && o.status === "quoted" && o.price === price).length + qty > MAX_LAUNCH_HOLDS) return confirmFirst();
        if (qty > room.max) return { ok: false, code: "qty_too_high", message: `Only ${room.max} ${room.max === 1 ? "pack is" : "packs are"} available in one order right now. Nothing was charged.`, max: room.max };
        const season = state.seasons.get(state.activeSeason.get(price) as string) as SeasonState;
        const total = (BigInt(season.priceDrops) * BigInt(qty)).toString();
        const refused = await walletRefusal(address, total, validated, unproven, qty);
        if (refused) return refused;
        const id = newId();
        const children = Array.from({ length: qty }, () => newId());
        const ok = await commit([{ type: "bundle_created", data: { id, season: season.season, price, address, invoice: invoiceOf(id), each: season.priceDrops, drops: total, qty, children, lastLedger: validated + BUNDLE_LEDGERS, createdLedger: validated, ...(unproven ? { unproven } : {}) } }], basis);
        if (ok) {
          const bundle = state.bundles.get(id) as BundleState;
          return { ok: true, bundle, tx: bundlePaymentTx(bundle) };
        }
      }
      return no("busy", "Try again.");
    },

    /** The most packs one order on this card pack can take: what custody's USDC can pay for, after every card order already open. */
    async cardRoom(code: string): Promise<{ max: number }> {
      if (!deps.gateway || !deps.multi || deps.multi.cardMax <= 1) return { max: 1 };
      const held = cardRooms.get(code);
      if (held && nowMs() - held.at < CARD_ROOM_MS) return { max: held.max };
      const machine = await deps.gateway.machine(code);
      if (!machine || !(machine.usd > 0)) return { max: 0 };
      const float = await deps.gateway.floatMicro();
      await sync();
      const open = [...state.cards.values()].filter((c) => ["quoted", "paid", "funding", "generating", "generated", "signed"].includes(c.status)).reduce((sum, c) => sum + BigInt(Math.round(c.usd * 1e6)), 0n);
      const free = float - open;
      const fits = await cardFits(free, BigInt(Math.round(machine.usd * 1e6)));
      const unpaid = [...state.bundles.values()].filter((b) => b.code === code && b.status === "quoted").reduce((a, b) => a + b.qty, 0);
      const max = fits < 1 ? 0 : Math.max(1, Math.min(deps.multi.cardMax, deps.multi.cardMax * UNPAID_ORDERS - unpaid, fits - 1));
      cardRooms.set(code, { at: nowMs(), max });
      return { max };
    },

    /** A multi order of card packs at today's rate. Each card takes its own way from here, and each can come back whole on its own. */
    async createCardBundle(address: string, code: string, qty: number, xrpUsd: number | null, opts: { unproven?: boolean } = {}): Promise<BundleQuote | Refusal | TooMany> {
      const unproven = !!opts.unproven;
      if (!deps.multi) return no("multi_off", "That isn't available.");
      await assertNetwork();
      if (!deps.gateway) return no("card_off", "Card packs aren't open yet.");
      if (!xrpUsd || xrpUsd <= 0) return no("no_rate", "XRP's price isn't available right now.");
      if (!Number.isInteger(qty) || qty < 2 || qty > MULTI_HARD_MAX) return no("bad_qty", "That isn't a quantity we can sell.");
      const machine = await deps.gateway.machine(code);
      if (!machine || !(machine.usd > 0)) return no("no_machine", "That pack isn't available.");
      const float = await deps.gateway.floatMicro();
      for (let tries = 0; tries < 8; tries++) {
        await pause(tries);
        await sync();
        const validated = await deps.chain.validatedLedger();
        const mine = openOf(address, validated);
        const same = mine.bundles.find((b) => b.code === code && b.qty === qty);
        if (same) return { ok: true, bundle: same, tx: bundlePaymentTx(same) };
        if (unproven ? mine.holding : mine.holdingProven) return no("open_checkout", OPEN_CHECKOUT);
        if (!unproven && mine.singles >= MAX_OPEN_ORDERS) return no("too_many", "Finish or wait out your open checkouts first.");
        const usd = BigInt(Math.round(machine.usd * 1e6));
        const open = [...state.cards.values()].filter((c) => ["quoted", "paid", "funding", "generating", "generated", "signed"].includes(c.status)).reduce((sum, c) => sum + BigInt(Math.round(c.usd * 1e6)), 0n);
        const unpaid = [...state.bundles.values()].filter((b) => b.code === code && b.status === "quoted").reduce((a, b) => a + b.qty, 0);
        const fits = await cardFits(float - open, usd);
        if (fits < 1) return no("restocking", "This pack is restocking. Try again soon.");
        // The same limit on free holds as an NFT pack: a place left for one, and no more held unpaid than two orders could.
        const max = Math.max(1, Math.min(deps.multi.cardMax, deps.multi.cardMax * UNPAID_ORDERS - unpaid, fits - 1));
        if (qty > max) return { ok: false, code: "qty_too_high", message: `Only ${max} ${max === 1 ? "pack is" : "packs are"} available in one order right now. Nothing was charged.`, max };
        // As on an NFT pack: only so many places on a launch's word, and the last of the float is already kept back.
        if (unproven && [...state.cards.values()].filter((c) => c.unproven && c.status === "quoted").length + qty > MAX_LAUNCH_HOLDS) return confirmFirst();
        const raw = (usd * 1_000_000n) / BigInt(Math.round(xrpUsd * 1e6));
        // Each card takes its own way, so each is priced as a single is: with the switch on, any of them may have to swap.
        const each = ((((raw * (10_000n + (relayOn() ? PASSTHROUGH_RATE_ROOM_BPS : CARD_RATE_ROOM_BPS))) / 10_000n) + 9_999n) / 10_000n) * 10_000n;
        const total = (each * BigInt(qty)).toString();
        const basis = state.head;
        const refused = await walletRefusal(address, total, validated, unproven, qty);
        if (refused) return refused;
        const id = newId();
        const children = Array.from({ length: qty }, () => newId());
        const cursor: RipEventBody[] = state.cursors.has(treasury) ? [] : [{ type: "scan_cursor", data: { account: treasury, ledger: validated } }];
        const ok = await commit([...cursor, { type: "card_bundle_created", data: { id, code, name: machine.name, usd: machine.usd, xrpUsd, address, invoice: invoiceOf(id), each: each.toString(), drops: total, qty, children, lastLedger: validated + BUNDLE_LEDGERS, createdLedger: validated, gateway: deps.gateway.label, ...(unproven ? { unproven } : {}) } }], basis);
        if (ok) {
          const bundle = state.bundles.get(id) as BundleState;
          return { ok: true, bundle, tx: bundlePaymentTx(bundle) };
        }
      }
      return no("busy", "Try again.");
    },

    /** The multi order this wallet can still pay, if it has one. */
    async openBundle(address: string, want: { price?: number; code?: string; provenOnly?: boolean } = {}): Promise<{ bundle: BundleState; tx: Readonly<Record<string, unknown>> } | null> {
      await sync();
      const validated = await deps.chain.validatedLedger();
      // This pack's order before any other, and a signature's before a launch's: a launch can name anyone, so its order is never the one to point the owner at first.
      const here = (b: BundleState) => (want.price !== undefined && b.price === want.price) || (want.code !== undefined && b.code === want.code);
      const rank = (b: BundleState) => (here(b) ? 0 : 2) + (b.unproven ? 1 : 0);
      const list = openOf(address, validated).bundles.filter((b) => !want.provenOnly || !b.unproven);
      const b = [...list].sort((x, y) => rank(x) - rank(y))[0];
      return b ? { bundle: b, tx: bundlePaymentTx(b) } : null;
    },

    /** What paying these out would pay, item by item, and in all. NFTs at their fixed quote, SEAL at the live price, XRP at its face and with no fee. */
    async quotePayout(address: string, ids: readonly string[]): Promise<{ ok: true; items: PayoutItem[]; total: Drops } | Refusal> {
      if (!deps.multi) return no("multi_off", "That isn't available.");
      await assertNetwork();
      await sync();
      if (ids.length > MULTI_HARD_MAX) return no("too_many_items", `Choose up to ${MULTI_HARD_MAX} at a time.`);
      if (new Set(ids).size !== ids.length) return no("duplicate", "The same item is listed twice.");
      const items: PayoutItem[] = [];
      for (const id of ids) {
        const o = state.orders.get(id);
        if (!o || o.address !== address) return no("not_yours", "That isn't yours.");
        if (o.pull !== "stashed") return no("not_stashed", "Only something in your stash can be sold.");
        if (o.prize?.token === XRP_TOKEN) {
          items.push({ order: id, action: "redeem", drops: o.prize.amount });
          continue;
        }
        const quote = o.prize ? await prizeSellQuote(o) : sellPrice(address, id);
        if (!quote.ok) return quote;
        items.push({ order: id, action: "sell", drops: quote.drops });
      }
      return { ok: true, items, total: items.reduce((a, i) => a + BigInt(i.drops), 0n).toString() };
    },

    /**
     * Pay out several items in one XRP payment, at the prices the player agreed to. All of it or none of it: anything that's changed, is someone
     * else's or isn't in the stash refuses the lot, and nothing moves. The same items asked for again get the same answer.
     */
    async requestPayout(address: string, items: readonly PayoutItem[]): Promise<{ ok: true; id: string } | Refusal> {
      if (!deps.multi) return no("multi_off", "That isn't available.");
      await assertNetwork();
      if (!items.length) return no("nothing", "Choose something first.");
      if (items.length > MULTI_HARD_MAX) return no("too_many_items", `Choose up to ${MULTI_HARD_MAX} at a time.`);
      if (new Set(items.map((i) => i.order)).size !== items.length) return no("duplicate", "The same item is listed twice.");
      for (const i of items) if (!/^[1-9][0-9]{0,17}$/.test(String(i.drops)) || (i.action !== "sell" && i.action !== "redeem")) return no("price_changed", "The price changed. Check the new one.");
      for (let tries = 0; tries < 4; tries++) {
        await pause(tries);
        await sync();
        const basis = state.head;
        const orders = items.map((i) => state.orders.get(i.order));
        if (!orders.every((o) => o?.address === address)) return no("not_yours", "That isn't yours.");
        // A double tap, or a retry after a dropped connection.
        const already = (orders[0] as OrderState).payout;
        if (already && state.payouts.get(already)?.items.length === items.length && orders.every((o) => o?.payout === already)) return { ok: true, id: already };
        let sells = 0n;
        for (const [n, i] of items.entries()) {
          const o = orders[n] as OrderState;
          if (o.pull !== "stashed") return no("not_stashed", "Only something in your stash can be sold.");
          const wait = await payoutWait(o);
          if (wait) return wait;
          if (o.prize?.token === XRP_TOKEN) {
            if (i.action !== "redeem" || i.drops !== o.prize.amount) return no("price_changed", "The price changed. Check the new one.");
            continue;
          }
          if (i.action !== "sell") return no("use_redeem", "Redeem this prize on its own page.");
          const quote = o.prize ? await prizeSellQuote(o) : sellPrice(address, o.id);
          if (!quote.ok) return quote;
          // An NFT's price is fixed by its mark. A token's moves every ledger, so it pays what the player agreed to, if the market still covers it.
          if (o.prize ? BigInt(i.drops) > BigInt(quote.drops) : i.drops !== quote.drops) return no("price_changed", "The price changed. Check the new one.");
          sells += BigInt(i.drops);
        }
        if (orders.some((o) => o?.lot)) {
          // The ledger has the last word: pay only for NFTs still in the vault.
          const held = new Set((await deps.chain.accountNfts(vault)).map((n) => n.nftId));
          if (!orders.every((o) => !o?.lot || held.has(o.nftId as string))) return no("not_stashed", "One of those NFTs isn't in your stash anymore.");
        }
        // An XRP prize is already owed from the day it was struck. A sale is new money, and it can't spend what a paid pull's draw might need.
        if (sells > 0n) {
          const info = await deps.chain.account(treasury);
          if (!info || BigInt(info.balance) - treasuryOwed(state, relayOn()) - xrpHeldForPaidPulls() - floor < sells) return no("sell_short", "That's more than we can pay out in one go right now. Everything is safe in your stash. Pick fewer, or try again soon.");
        }
        const id = newId();
        const total = items.reduce((a, i) => a + BigInt(i.drops), 0n).toString();
        if (await commit([{ type: "payout_requested", data: { id, address, total, items: items.map((i) => ({ order: i.order, action: i.action, drops: i.drops })) } }], basis)) return { ok: true, id };
      }
      return no("busy", "Try again.");
    },

    sellPrice,

    /** What selling this would pay right now. An NFT's price is fixed by its mark; a token's comes off the ledger. */
    async quoteSell(address: string, orderId: string): Promise<{ ok: true; drops: Drops } | Refusal> {
      await assertNetwork();
      await sync();
      const o = state.orders.get(orderId);
      if (!o || o.address !== address) return no("not_yours", "That isn't yours.");
      if (o.prize) return o.pull === "stashed" ? prizeSellQuote(o) : no("not_stashed", "Only something in your stash can be sold.");
      return sellPrice(address, orderId);
    },

    /**
     * The SEAL float against what the open packs want, for the admin page and the low-float alert. `pauses` names the packs
     * that are closed right now because the float can't cover their biggest prize.
     */
    async sealFloatStatus(): Promise<SealFloatStatus | null> {
      await assertNetwork();
      await sync();
      if (deps.sealOff) return null;
      const open = [...state.seasons.values()].filter((s) => s.live && state.activeSeason.get(s.price) === s.season && s.tokens.length && deps.shelf?.includes(s.price) !== false);
      const spec = open.flatMap((s) => s.tokens).find((t) => t.id !== XRP_TOKEN);
      if (!spec) return null;
      const validated = await deps.chain.validatedLedger();
      const [{ check, reads }, line] = await Promise.all([livePrice(spec, validated), deps.chain.trustLine?.(treasury, spec).catch(() => null) ?? null]);
      const held = line ? BigInt(line.balanceMicro) / 1_000_000n : 0n;
      const owed = tokenOwed(state, spec.id);
      const free = held - owed;
      const low = open.reduce((a, s) => a + NFT_LADDERS[s.price].sealFloat.lowXrp, 0);
      const start = open.reduce((a, s) => a + NFT_LADDERS[s.price].sealFloat.startXrp, 0);
      const refill = Math.max(0, ...open.map((s) => NFT_LADDERS[s.price].sealFloat.refillXrp));
      // Valued at the price a strike would use: what this float can actually pay out.
      const freeXrp = check.ok ? Number((free > 0n ? free : 0n) * BigInt(check.strike.xrpDrops) * 1_000_000n / BigInt(check.strike.tokenMicro)) / 1e6 : null;
      // The same tests the gate runs, so this names exactly the packs it would refuse over SEAL.
      const pauses = check.ok && reads
        ? open.filter((s) => {
            const biggest = maxValueOf(s.prizeTable, spec.id);
            return biggest > 0n && (prizeTooBig(biggest.toString(), reads.now.xrpDrops) || sealShort(s.prizeTable, spec, check.strike, free));
          }).map((s) => s.price)
        : open.map((s) => s.price);
      return { token: spec.id, held: held.toString(), owed: owed.toString(), free: free.toString(), freeXrp, lowXrp: low, startXrp: start, refillXrp: refill, priceOk: check.ok, priceCode: check.ok ? null : check.code, low: freeXrp !== null && freeXrp < low, pauses };
    },

    /**
     * The open packs a checkout would refuse right now, for the shelf: everything createOrder asks before it holds a place.
     * One set of reads per validated ledger and log position, however many people have the page open.
     */
    async closedPacks(validated: number, rate: () => Promise<number | null>): Promise<ReadonlySet<NftPrice>> {
      await assertNetwork();
      await sync();
      const key = `${validated}:${state.head}`;
      if (closedCache?.key === key) return closedCache.closed;
      const xrpUsd = deps.rateGuardBps === undefined ? null : await rate();
      const closed = new Set<NftPrice>();
      for (const price of state.activeSeason.keys()) {
        const can = canSell(price, validated, xrpUsd);
        if (!can.ok || (await prizeGate(price, state.seasons.get(can.season) as SeasonState, validated))) closed.add(price);
      }
      closedCache = { key, closed };
      return closed;
    },

    /**
     * What a person should hear about, besides SEAL: the XRP float, refunds stuck, pulls not drawing, payouts not settling. These
     * stop money moving without an error anyone sees. `code` is stable, so one problem is one alert however its numbers move.
     */
    async opsAlerts(): Promise<readonly { code: string; text: string }[]> {
      await assertNetwork();
      await sync();
      const validated = await deps.chain.validatedLedger();
      const out: { code: string; text: string }[] = [];
      const open = [...state.seasons.values()].filter((s) => s.live && state.activeSeason.get(s.price) === s.season && deps.shelf?.includes(s.price) !== false);
      const biggest = open.reduce((m, s) => (maxRowValue(s.prizeTable) > m ? maxRowValue(s.prizeTable) : m), 0n);
      const info = await deps.chain.account(treasury);
      const free = info ? BigInt(info.balance) - treasuryOwed(state, relayOn()) - xrpHeldForPaidPulls() - floor : null;
      // The gate's own test, so a pack closed over the places held is one the owner hears about.
      const gateFree = info ? BigInt(info.balance) - treasuryOwed(state, relayOn()) - floor : null;
      const closedXrp = gateFree === null ? [] : open.filter((s) => maxRowValue(s.prizeTable) > 0n && gateFree < xrpCoverNeed(s.price)).map((s) => s.price);
      if (biggest > 0n && (free === null || free < biggest)) out.push({ code: "xrp_float", text: `XRP float: ${free === null ? "treasury unreadable" : `${Number(free) / 1e6} XRP free`}, under the biggest prize of ${Number(biggest) / 1e6} XRP. Packs close and sales pause until it's topped up.` });
      else if (closedXrp.length) out.push({ code: "xrp_float", text: `XRP float: ${Number(free) / 1e6} XRP free, too little for the places held. Closed: ${closedXrp.map((p) => `$${p}`).join(", ")}. They reopen when it's topped up or those places lapse.` });
      // The sell-back line closes a pack with nothing else to say so: as a band's cheaper NFTs are kept, what's left averages more than its odds were cut for.
      // Only a person can reopen it, by taking the dearest out or adding cheaper ones. Per-item odds keep 5-6 under it on any pool.
      const overLine = open.filter((s) => sellBackShare(state, s, validated) > MAX_SELL_BACK_SHARE).map((s) => s.price);
      // Per-item odds: a band whose NFTs together add more over its ladder than the season allows draws them all at 0% (on a band that commits no
      // excess, one NFT dearer than its ladder can do it). They sit in the pool and nobody can pull them until a person takes the dear one out.
      const zeroed: string[] = [];
      for (const s of open) {
        const odds = s.nftOdds;
        if (!odds) continue;
        BANDS.forEach((name, band) => {
          const marks = poolAt(state, s.price, band, validated).filter((l) => l.removeLedger === null).map((l) => l.markDrops);
          if (marks.length && (odds.kDrops[band] ?? 0) > 0 && itemWeights(odds, s.prizeTable, band, marks, s.sellBps, s.priceDrops).every((w) => w === 0)) zeroed.push(`$${s.price} ${name}`);
        });
      }
      if (zeroed.length) out.push({ code: "nft_odds_zero", text: `NFTs nobody can pull: every NFT in ${zeroed.join(", ")} draws at 0%, because one is too dear for what the season lets that band's NFTs add over its XRP prizes. Take the dearest out (scripts/rip-admin.mjs remove) and the rest draw again.` });
      if (overLine.length) out.push({ code: "sell_line", text: `Closed on the sell-back line: ${overLine.map((p) => `$${p}`).join(", ")}. What's left in its pool is worth more than its odds were cut for. Take the dearest NFTs out of the band or add cheaper ones; scripts/rip-admin.mjs status lists the pool.` });
      // A prize struck or waiting with no XRP to pay it. It goes out by itself once the treasury has it, and only the owner can make that happen.
      if (info) {
        const waiting = [...state.orders.values()].filter((o) => o.pull === "redeeming" && o.prize?.token === XRP_TOKEN && BigInt(info.balance) - floor < BigInt(o.prize.amount));
        if (waiting.length) {
          const total = waiting.reduce((a, o) => a + BigInt(o.prize?.amount ?? 0), 0n);
          const shortBy = treasuryOwed(state, relayOn()) + floor - BigInt(info.balance);
          out.push({ code: "prizes_owed", text: `${waiting.length} prize(s) owed to players, ${Number(total) / 1e6} XRP, and the treasury can't pay yet. Top it up by at least ${Number(shortBy) / 1e6} XRP. They pay by themselves once it's there.` });
        }
      }
      if (info) {
        const waitingPay = [...state.payouts.values()].filter((p) => p.status === "due" && BigInt(info.balance) - floor < BigInt(p.total));
        if (waitingPay.length) out.push({ code: "payouts_waiting", text: `${waitingPay.length} sale(s) paying out together, ${Number(waitingPay.reduce((a, p) => a + BigInt(p.total), 0n)) / 1e6} XRP, and the treasury can't pay yet. They pay by themselves once it's topped up.` });
      }
      // A sale is refused when the treasury can't pay it, however it's asked. The owner should hear before a player does.
      if (info) {
        let top = 0n;
        for (const o of state.orders.values()) {
          if (o.pull !== "stashed" || !o.lot) continue;
          const lot = state.lots.get(o.lot);
          const season = state.seasons.get(o.season);
          if (lot && season && sellQuote(lot.markDrops, season.sellBps) > top) top = sellQuote(lot.markDrops, season.sellBps);
        }
        if (top > 0n && free !== null && free < top) out.push({ code: "sell_cover", text: `A stashed NFT would sell back for ${Number(top) / 1e6} XRP and the treasury has ${Number(free) / 1e6} XRP free. That sale pauses until it's topped up.` });
      }
      if (deps.restock) {
        const held = [...state.restockHolds.values()];
        if (held.length) out.push({ code: "relist_held", text: `${held.length} sold-back NFT(s) held out of their pools, waiting on you: ${[...new Set(held.map((h) => HOLD_WORDS[h.reason] ?? h.reason))].join("; ")}. scripts/rip-admin.mjs status lists them.` });
        const limits = deps.restock.autobuy;
        if (limits) {
          if (state.autobuyOff) out.push({ code: "autobuy_stopped", text: `Buying is switched off by ${state.autobuyOff.by}${state.autobuyOff.why ? `: ${state.autobuyOff.why}` : ""}. scripts/rip-admin.mjs autobuy-on turns it back on.` });
          const spendable = await vaultSpendable().catch(() => null);
          if (spendable !== null && spendable < limits.lowVaultDrops) {
            const spare = await treasurySpare().catch(() => 0n);
            out.push({ code: "vault_low", text: `The vault can spend ${Number(spendable) / 1e6} XRP, under the ${Number(limits.lowVaultDrops) / 1e6} XRP it should keep for buying. Top it up from your own wallet. The treasury has ${Number(spare > 0n ? spare : 0n) / 1e6} XRP spare after every sale, prize and cover it could be asked for; the engine never moves XRP between them.` });
          }
        }
      }
      const lost = [...state.buys.values()].filter((b) => b.status === "filled" && validated - b.createdLedger > STRIKE_WAIT_LEDGERS).length;
      if (lost) out.push({ code: "buy_unseen", text: `${lost} NFT(s) the vault paid for aren't showing in the vault yet, so they aren't in a pool. Look it up before buying more.` });
      const stuck = [...state.refunds.values()].filter((r) => r.status === "stuck").length;
      if (stuck) out.push({ code: "refunds_stuck", text: `${stuck} refund(s) stuck. See /admin.` });
      // Stray payments of a whole XRP or more each get a refund, one at a time, and three log entries. A long queue is a flood.
      const due = [...state.refunds.values()].filter((r) => r.status === "due").length;
      if (due > 50) out.push({ code: "refunds_backlog", text: `${due} refunds waiting. That many stray payments is a flood, and it grows the log every server has to read.` });
      const undrawn = [...state.orders.values()].filter((o) => o.status === "paid" && validated - (o.entropyLedger ?? validated) > STRIKE_WAIT_LEDGERS).length;
      if (undrawn) out.push({ code: "pulls_undrawn", text: `${undrawn} paid pull(s) haven't drawn. The ledger server may be missing history.` });
      const unsettled = [...state.intents.values()].filter((i) => validated - i.lastLedger > STRIKE_WAIT_LEDGERS).length;
      if (unsettled) out.push({ code: "tx_unsettled", text: `${unsettled} transaction(s) past their last ledger with no result. Nothing else leaves that wallet until a person looks: see /admin.` });
      if (deps.gateway) {
        const review = [...state.cards.values()].filter((c) => c.status === "review").length;
        if (review) out.push({ code: "cards_review", text: `${review} card(s) waiting on a person. A player's XRP or card is on hold until it's settled: see /admin.` });
        if (info && !relayOn()) {
          const waiting = [...state.cards.values()].filter((c) => c.hold === "selling" && c.status !== "review" && BigInt(info.balance) - floor < BigInt(c.exit?.drops ?? 0));
          if (waiting.length) out.push({ code: "card_payout_waiting", text: `${waiting.length} sold card(s) with XRP owed and a treasury that can't pay yet. Top it up by at least ${Number(waiting.reduce((a, c) => a + BigInt(c.exit?.drops ?? 0), 0n) + floor - BigInt(info.balance)) / 1e6} XRP. They pay by themselves once it's there.` });
        }
        // A card worth selling that the treasury can't pay for: its sale is refused, and Collector Crypt's window is about 72 hours.
        if (gateFree !== null && !relayOn()) {
          const uncovered = [...state.cards.values()].filter((c) => c.status === "held" && (c.hold === "stashed" || c.hold === "offered" || c.hold === "mirrored") && c.insuredMicro && now().getTime() - Date.parse(c.createdAt) < 72 * 3600_000 && (cardSellMicro(c.insuredMicro, c.instantBuybackPct) * 1_000_000n) / BigInt(Math.round(c.xrpUsd * 1e6)) > gateFree);
          if (uncovered.length) out.push({ code: "card_sale_uncovered", text: `${uncovered.length} card(s) worth more than the treasury can pay for a sale. Their sales are refused until it's topped up, and the sale offer ends about 72 hours after the pull.` });
        }
        const custody = await this.custodyStatus().catch(() => null);
        if (custody && !relayOn() && BigInt(custody.usdcMicro) < CARD_FLOAT_LOW_MICRO) out.push({ code: "card_float", text: `USDC float: $${Number(custody.usdcMicro) / 1e6} on custody, under the cheapest pack. Card packs read as restocking until it's topped up. A Solana server that isn't answering reads the same.` });
        if (custody?.lamports && BigInt(custody.lamports) < CUSTODY_SOL_LOW_LAMPORTS) out.push({ code: "custody_sol", text: `Custody holds ${Number(custody.lamports) / 1e9} SOL. Top it up, or a pack's payment can fail to land and go back as a refund.` });
        // Off with nothing of Relay's ever out, a site reads exactly as it did before the passthrough.
        if (deps.relay && (relayOn() || state.swaps.size > 0 || state.relayArrivals.size > 0)) {
          const stalled = [...state.swaps.values()].filter((x) => x.status === "deposited" && nowMs() - Date.parse(x.movedAt) > SWAP_STALL_MS);
          if (stalled.length) out.push({ code: "swap_stalled", text: `${stalled.length} Relay swap(s) past ten minutes with no delivery: ${stalled.map((x) => x.requestId).slice(0, 3).join(", ")}. Check them at relay.link. A person can settle one at /admin.` });
          const unmatched = [...state.relayArrivals.values()].filter((a) => !a.swap && ![...state.swaps.values()].some((x) => liveSwap(x) && x.orderId === a.memo));
          if (unmatched.length) out.push({ code: "relay_unmatched", text: `${unmatched.length} payment(s) from Relay that match no swap of ours. They stayed in the treasury, and nothing counted them.` });
          const held = [...state.cards.values()].filter((c) => c.hold === "selling" && c.status !== "review" && nowMs() - Date.parse(c.movedAt) > SWAP_STALL_MS);
          // Off, the alert above already says this in its own words.
          if (held.length && relayOn()) out.push({ code: "card_payout_waiting", text: `${held.length} sold card(s) with XRP owed for over ten minutes. Top up the treasury to pay them now, or they pay when Relay delivers.` });
          // Owed money with the last try failed: the house is short on one side until it goes. Nobody's payout depends on it.
          const owed = [...state.accruals.values()].filter((a) => a.status === "owed");
          const refills = [...state.swaps.values()].filter((x) => x.purpose === "refill");
          const lastRefill = refills[refills.length - 1];
          const failing = owed.length && (lastRefill?.status === "dead" || lastRefill?.status === "refunded" || (notes.has("refill_failed") && nowMs() - (notes.get("refill_failed")?.at ?? 0) < NOTE_LIFE_MS) || (notes.has("relay_down") && nowMs() - (notes.get("relay_down")?.at ?? 0) < NOTE_LIFE_MS));
          if (failing) out.push({ code: "refill_failing", text: `${owed.length} refill(s) aren't going through. The house is carrying the difference until they do, and they keep retrying. Players are unaffected.` });
          for (const [code, n] of notes) {
            if (code !== "refill_failed" && nowMs() - n.at < NOTE_LIFE_MS) out.push({ code, text: n.text });
          }
        }
        if (minter) {
          const [m, r] = await Promise.all([deps.chain.account(minter), deps.chain.reserves()]).catch(() => [null, null]);
          if (r && (!m || BigInt(m.balance) - BigInt(r.base) - BigInt(m.ownerCount) * BigInt(r.inc) < MINTER_SPARE_DROPS)) out.push({ code: "minter_low", text: `The mirror minter has under ${Number(MINTER_SPARE_DROPS) / 1e6} XRP above its reserve. Top it up, or card claims fail and wait.` });
        }
      }
      return out;
    },

    /** Custody's USDC and SOL, for the sweep and the admin page. Null for what can't be read right now. */
    async custodyStatus(): Promise<{ usdcMicro: string; lamports: string | null }> {
      if (!deps.gateway) return { usdcMicro: "0", lamports: null };
      const [usdc, gas] = await Promise.all([deps.gateway.floatMicro(), deps.gateway.gasLamports().catch(() => null)]);
      return { usdcMicro: usdc.toString(), lamports: gas === null ? null : gas.toString() };
    },

    /** Would this prize need a trust line first? What the page asks before it offers to redeem. */
    async redeemNeeds(address: string, orderId: string): Promise<{ ok: true; tx: Readonly<Record<string, unknown>> | null } | Refusal> {
      await assertNetwork();
      await sync();
      const o = state.orders.get(orderId);
      if (!o?.prize || o.address !== address) return no("not_yours", "That isn't yours.");
      if (o.prize.token === XRP_TOKEN) return { ok: true, tx: null };
      const spec = seasonToken(state, o.season, o.prize.token);
      if (!spec) return no("redeem_paused", "Redeeming is paused for a moment. Your prize is safe in your stash.");
      const need = BigInt(o.prize.amount) * 1_000_000n;
      const line = await deps.chain.trustLine?.(address, spec);
      return { ok: true, tx: !line || BigInt(line.limitMicro) - BigInt(line.balanceMicro) < need ? trustSetTx(address, spec, BigInt(o.prize.amount)) : null };
    },

    /**
     * Send a token prize to the player's own wallet, once. A wallet with no trust line gets the transaction to set one up,
     * and nothing changes until it can actually receive. Declining leaves the prize in the stash, with nothing lost.
     */
    async redeem(address: string, orderId: string): Promise<{ ok: true } | Refusal | NeedsTrustLine> {
      await assertNetwork();
      for (let tries = 0; tries < 4; tries++) {
        await sync();
        const basis = state.head;
        const o = state.orders.get(orderId);
        if (!o?.prize || o.address !== address) return no("not_yours", "That isn't yours.");
        if (o.pull === "redeeming" || o.pull === "redeemed") return { ok: true };
        if (o.pull !== "stashed") return no("not_stashed", "Only something in your stash can be redeemed.");
        const wait = await payoutWait(o);
        if (wait) return wait;
        if (o.prize.token !== XRP_TOKEN) {
          const spec = seasonToken(state, o.season, o.prize.token);
          if (!spec) return no("redeem_paused", "Redeeming is paused for a moment. Your prize is safe in your stash.");
          const need = BigInt(o.prize.amount) * 1_000_000n;
          let line;
          try {
            line = await deps.chain.trustLine?.(address, spec);
          } catch {
            return no("redeem_paused", "Redeeming is paused for a moment. Your prize is safe in your stash.");
          }
          if (line?.frozen) return no("redeem_paused", "Your wallet's line for this token is frozen. Your prize is safe in your stash.");
          if (!line || BigInt(line.limitMicro) - BigInt(line.balanceMicro) < need) return { ok: false, code: "needs_trustline", message: "Your wallet needs a trust line for this token first. Your prize is safe in your stash.", tx: trustSetTx(address, spec, BigInt(o.prize.amount)) };
        }
        if (await commit([{ type: "redeem_requested", data: { order: orderId, address } }], basis)) return { ok: true };
      }
      return no("busy", "Try again.");
    },

    /** Accept a sell. The treasury must be able to pay it on top of everything it already owes. */
    async sell(address: string, orderId: string, drops: Drops): Promise<{ ok: true } | Refusal> {
      await assertNetwork();
      for (let tries = 0; tries < 4; tries++) {
        await sync();
        const basis = state.head;
        const o = state.orders.get(orderId);
        if (o?.pull === "selling" || o?.pull === "sold") return o.address === address ? { ok: true } : no("not_yours", "That isn't yours.");
        if (o?.address === address && o.pull === "stashed") {
          const wait = await payoutWait(o);
          if (wait) return wait;
        }
        if (o?.prize) {
          if (o.address !== address) return no("not_yours", "That isn't yours.");
          if (o.pull !== "stashed") return no("not_stashed", "Only something in your stash can be sold.");
          const live = await prizeSellQuote(o);
          if (!live.ok) return live;
          // A token's price moves every ledger. The sale pays what the player agreed to, and only if the market still covers it.
          if (!/^[1-9][0-9]*$/.test(drops) || BigInt(drops) > BigInt(live.drops)) return no("price_changed", "The price changed. Check the new one.");
        } else {
          const price = sellPrice(address, orderId);
          if (!price.ok) return price;
          if (price.drops !== drops) return no("price_changed", "The price changed. Check the new one.");
          // The ledger has the last word: pay only for an NFT that is still in the vault.
          if (!(await deps.chain.accountNfts(vault)).some((n) => n.nftId === o?.nftId)) return no("not_stashed", "That NFT isn't in your stash anymore.");
        }
        const info = await deps.chain.account(treasury);
        // A paid pull's draw comes first: a sale can't spend the XRP its prize might need.
        if (!info || BigInt(info.balance) - treasuryOwed(state, relayOn()) - xrpHeldForPaidPulls() - floor < BigInt(drops)) return no("sell_paused", `Selling is paused for a moment. Your ${o?.prize ? "prize" : "NFT"} is safe in your stash.`);
        if (await commit([{ type: "sell_requested", data: { order: orderId, address, drops } }], basis)) return { ok: true };
      }
      return no("busy", "Try again.");
    },

    /** `proven` is whether a signature stands behind `address`. Making an offer spends the vault's reserve with no transaction from the wallet, so it takes one. */
    async claim(address: string, orderId: string, proven = true): Promise<{ ok: true } | Refusal> {
      await assertNetwork();
      for (let tries = 0; tries < 4; tries++) {
        await sync();
        const o = state.orders.get(orderId);
        if (!o || o.address !== address) return no("not_yours", "That isn't yours.");
        if (o.prize) return no("use_redeem", "Redeem this prize instead.");
        if (o.pull === "offering" || o.pull === "offered" || o.pull === "claimed") return { ok: true };
        if (o.pull !== "stashed") return no("not_stashed", "Only something in your stash can be claimed.");
        if (!proven) return confirmFirst();
        if (o.claimCancelLedger !== null && (await deps.chain.validatedLedger()) - o.claimCancelLedger < RETRY_WAIT_LEDGERS) return no("try_later", o.claimRefused ? "That offer didn't go through. If your wallet turns away NFT offers, check its settings. You can sell it now, or claim it again in a few minutes." : "You just took this offer back. You can sell it now, or claim it again in a few minutes.");
        if (await commit([{ type: "claim_requested", data: { order: orderId, address } }])) return { ok: true };
      }
      return no("busy", "Try again.");
    },

    /** Take back an unaccepted offer, so the NFT can be sold instead. */
    async cancelClaim(address: string, orderId: string): Promise<{ ok: true } | Refusal> {
      await assertNetwork();
      for (let tries = 0; tries < 4; tries++) {
        await sync();
        const o = state.orders.get(orderId);
        if (!o || o.address !== address) return no("not_yours", "That isn't yours.");
        if (o.pull === "cancelling" || o.pull === "stashed") return { ok: true };
        if (o.pull !== "offered") return no("no_offer", "There's no open offer to cancel.");
        if (await commit([{ type: "claim_cancel_requested", data: { order: orderId, address } }])) return { ok: true };
      }
      return no("busy", "Try again.");
    },

    /** Admin: send a stuck refund again once its cause is fixed. */
    async retryRefund(id: string, by: string) {
      await sync();
      if (state.refunds.get(id)?.status !== "stuck") return false;
      return commit([{ type: "refund_retry", data: { id, by } }]);
    },

    /** Open a card order at today's rate. The float must cover it and every other card order already open, or with the switch on, Relay must be able to bring the rest. */
    async createCardOrder(address: string, code: string, xrpUsd: number | null, opts: { unproven?: boolean } = {}): Promise<{ ok: true; order: CardState; tx: Readonly<Record<string, unknown>> } | Refusal> {
      const unproven = !!opts.unproven;
      await assertNetwork();
      if (!deps.gateway) return no("card_off", "Card packs aren't open yet.");
      if (!xrpUsd || xrpUsd <= 0) return no("no_rate", "XRP's price isn't available right now.");
      const machine = await deps.gateway.machine(code);
      if (!machine || !(machine.usd > 0)) return no("no_machine", "That pack isn't available.");
      const float = await deps.gateway.floatMicro();
      const room = relayOn() ? PASSTHROUGH_RATE_ROOM_BPS : CARD_RATE_ROOM_BPS;
      for (let tries = 0; tries < 8; tries++) {
        await pause(tries);
        await sync();
        const validated = await deps.chain.validatedLedger();
        const open = [...state.cards.values()].filter((c) => ["quoted", "paid", "funding", "generating", "generated", "signed"].includes(c.status));
        const same = open.find((c) => c.address === address && c.code === code && c.status === "quoted" && !c.bundle && c.lastLedger > validated + 20);
        if (same) return { ok: true, order: same, tx: cardPaymentTx(same) };
        if (!unproven && open.filter((c) => c.address === address && c.status === "quoted" && !c.bundle && !c.unproven).length + openOf(address, validated).proven >= MAX_OPEN_ORDERS) return no("too_many", "Finish or wait out your open checkouts first.");
        const need = BigInt(Math.round(machine.usd * 1e6)) + open.reduce((sum, c) => sum + BigInt(Math.round(c.usd * 1e6)), 0n);
        // Short of USDC, a pack still sells if Relay can bring it. Nothing is promised until the wallet pays, and what can't swap goes back whole.
        if (float < need && !(relayOn() && (await relayCanBring(need - float, microOf(machine.usd))))) return no("restocking", "This pack is restocking. Try again soon.");
        // As on a pack: only so many, and never the last of the float.
        if (unproven && (open.filter((c) => c.unproven && c.status === "quoted").length >= MAX_LAUNCH_HOLDS || float < need + BigInt(Math.round(machine.usd * 1e6)))) return confirmFirst();
        const id = newId();
        const raw = (BigInt(Math.round(machine.usd * 1e6)) * 1_000_000n) / BigInt(Math.round(xrpUsd * 1e6));
        const drops = (raw * (10_000n + room)) / 10_000n;
        // Round up to a whole 0.01 XRP so a wallet shows a clean figure.
        const clean = ((drops + 9_999n) / 10_000n) * 10_000n;
        const basis = state.head;
        const refused = await walletRefusal(address, clean.toString(), validated, unproven);
        if (refused) return refused;
        const cursor: RipEventBody[] = state.cursors.has(treasury) ? [] : [{ type: "scan_cursor", data: { account: treasury, ledger: validated } }];
        const ok = await commit([...cursor, { type: "card_order_created", data: { id, code, name: machine.name, usd: machine.usd, drops: clean.toString(), xrpUsd, address, invoice: invoiceOf(id), lastLedger: validated + ORDER_LEDGERS, createdLedger: validated, gateway: deps.gateway.label, ...(unproven ? { unproven } : {}) } }], basis);
        if (ok) {
          const order = state.cards.get(id) as CardState;
          return { ok: true, order, tx: cardPaymentTx(order) };
        }
      }
      return no("busy", "Try again.");
    },

    /** Whoever may act on this card right now: the buyer until a mirror is accepted, then the wallet holding the mirror. */
    /** Who may act on a card, for routes that must check before they store anything. */
    async cardAuthority(address: string, orderId: string): Promise<{ ok: true; card: CardState } | Refusal> {
      await sync();
      const c = state.cards.get(orderId);
      if (!c) return no("not_yours", "That isn't yours.");
      if (c.mirror?.accepted) {
        // The ledger decides who holds it. A former holder is refused, even with a live session.
        const held = await deps.chain.accountNfts(address);
        if (!held.some((n) => n.nftId === c.mirror?.nftId)) return no("not_yours", "This wallet doesn't hold that mirror.");
        return { ok: true, card: c };
      }
      return c.address === address ? { ok: true, card: c } : no("not_yours", "That isn't yours.");
    },

    /**
     * Take back an open offer on a card's mirror, so the player never has to accept it to keep their card. The burn is the same one a
     * sale or a shipment does, signed by the minter, which holds the NFT until it's accepted: an accept that lands first makes the burn
     * fail on the ledger, and one that comes after finds no offer. Either way there's one NFT or none, and the card stays theirs.
     */
    async takeBackCard(address: string, orderId: string): Promise<{ ok: true } | Refusal> {
      if (!minter) return no("card_off", "Taking an offer back is paused for a moment. Your card is safe.");
      await assertNetwork();
      for (let tries = 0; tries < 4; tries++) {
        await sync();
        const c = state.cards.get(orderId);
        if (!c || c.address !== address) return no("not_yours", "That isn't yours.");
        if (c.status !== "held") return no("not_stashed", "We're checking on this card. It's safe, and you'll see it here.");
        if (c.hold === "stashed" || (c.hold === "exit_burn" && c.exit?.kind === "back")) return { ok: true };
        if (c.hold !== "offered" || !c.mirror || c.mirror.accepted) return no("no_offer", "There's no open offer to take back.");
        const wait = await mirrorWait(c, BURN_FAILED);
        if (wait) return wait;
        if (await commit([{ type: "mirror_take_back_requested", data: { order: orderId, address } }])) return { ok: true };
      }
      return no("busy", "Try again.");
    },

    /** Claim a card as a mirror NFT. Custody is proven again right here: no mirror without the card behind it. `proven` as in `claim`: a mint spends the minter's reserve. */
    async claimCard(address: string, orderId: string, proven = true): Promise<{ ok: true } | Refusal> {
      return retryBusy<{ ok: true; code?: undefined } | Refusal>(() => this.claimCardOnce(address, orderId, proven));
    },

    async claimCardOnce(address: string, orderId: string, proven = true): Promise<{ ok: true } | Refusal> {
      if (!deps.gateway || !minter) return no("card_off", "Mirrors aren't open yet.");
      const auth = await this.cardAuthority(address, orderId);
      if (!auth.ok) return auth;
      const c = auth.card;
      if (c.status !== "held") return no("not_stashed", "We're checking on this card. It's safe, and you'll see it here.");
      if (c.hold === "minting" || c.hold === "offered" || c.hold === "mirrored") return { ok: true };
      if (c.hold !== "stashed" || !c.mint) return no("not_stashed", "Only something in your stash can be claimed.");
      if (!proven) return confirmFirst();
      const wait = await mirrorWait(c, c.takenBack ? "You just took this offer back. Your card is safe in your stash: you can sell or ship it now, or claim it again in a few minutes." : "That offer didn't go through. If your wallet turns away NFT offers, check its settings. Your card is safe in your stash: you can sell it now, or claim it again in a few minutes.");
      if (wait) return wait;
      const proof = await deps.gateway.prove(c.mint).catch(() => null);
      // A read that failed says nothing about the card. It's only a question for a person when the chain answers and it isn't there.
      if (!proof) return no("custody", "We can't check on this card just now. It's safe, so try again in a moment.");
      if (!proof.held) {
        await commit([{ type: "card_review", data: { order: c.id, reason: "custody_check_failed" } }]);
        return no("custody", "We're checking on this card. It's safe, and you'll see it here.");
      }
      const ok = await commit([{ type: "mirror_requested", data: { order: c.id, address, slot: proof.slot, proof: proof.proof } }]);
      return ok ? { ok: true } : no("busy", "Try again.");
    },

    /** A quote for selling this card back, in XRP, at the rate given. */
    async cardSellPrice(address: string, orderId: string, xrpUsd: number | null): Promise<{ ok: true; drops: Drops; usdMicro: string } | Refusal> {
      if (!deps.gateway) return no("card_off", "Card packs aren't open yet.");
      const auth = await this.cardAuthority(address, orderId);
      if (!auth.ok) return auth;
      const c = auth.card;
      if (c.status !== "held" || (c.hold !== "stashed" && c.hold !== "offered" && c.hold !== "mirrored") || !c.mint || !c.insuredMicro) return no("not_stashed", "Only something in your stash can be sold.");
      if (!xrpUsd || xrpUsd <= 0) return no("no_rate", "XRP's price isn't available right now.");
      // Their window closes about 72 hours after the pull, and they can always say no. That's an answer, not a server error.
      const quote = await deps.gateway.sellQuote(c.mint, c.insuredMicro, c.instantBuybackPct).catch(() => null);
      if (!quote) return no("no_buyback", "There's no instant sell price for this card right now. It's safe in your stash, and you can still ship it.");
      const { usdMicro } = quote;
      return { ok: true, usdMicro: usdMicro.toString(), drops: ((usdMicro * 1_000_000n) / BigInt(Math.round(xrpUsd * 1e6))).toString() };
    },

    /** Sell, at exactly the quoted XRP. A mirror is retired first, then the card goes back, then the XRP is paid. */
    async sellCard(address: string, orderId: string, quote: { drops: Drops; usdMicro: string }): Promise<{ ok: true } | Refusal> {
      return retryBusy<{ ok: true; code?: undefined } | Refusal>(() => this.sellCardOnce(address, orderId, quote));
    },

    async sellCardOnce(address: string, orderId: string, quote: { drops: Drops; usdMicro: string }): Promise<{ ok: true } | Refusal> {
      const auth = await this.cardAuthority(address, orderId);
      if (!auth.ok) return auth;
      const c = auth.card;
      if (c.exit?.kind === "sell") return { ok: true };
      if (c.status !== "held") return no("not_stashed", "We're checking on this card. It's safe, and you'll see it here.");
      if (c.hold !== "stashed" && c.hold !== "offered" && c.hold !== "mirrored") return no("not_stashed", "Only something in your stash can be sold.");
      const wait = c.mirror ? await mirrorWait(c, BURN_FAILED) : null;
      if (wait) return wait;
      const info = await deps.chain.account(treasury);
      if (!relayOn()) {
        if (!info || BigInt(info.balance) - treasuryOwed(state, relayOn()) - xrpHeldForPaidPulls() - floor < BigInt(quote.drops)) return no("sell_paused", "Selling is paused for a moment. Your card is safe in your stash.");
      } else if (!info || treasuryFree(BigInt(info.balance)) < BigInt(quote.drops)) {
        // The sale pays for itself, so what the treasury holds is no reason to refuse it. But a card sold while Relay can't bring the XRP leaves a player
        // waiting with nothing in hand. A card can always wait: it's safe, and a moment's pause beats a sale that can't pay.
        const gross = (BigInt(quote.usdMicro) * 100n) / BigInt(100 - SELL_FEE_PERCENT);
        const cap = deps.relay as RelayRails;
        if (gross <= cap.policy.maxSwapMicro && !(await sellCanLand(gross, BigInt(quote.drops)))) return no("sell_paused", "Selling is paused for a moment. Your card is safe in your stash.");
      }
      const ok = await commit([{ type: "card_exit_requested", data: { order: c.id, kind: "sell", by: address, drops: quote.drops, usdMicro: quote.usdMicro, addressHash: null, ...(relayOn() ? { passthrough: true as const } : {}) } }]);
      return ok ? { ok: true } : no("busy", "Try again.");
    },

    /**
     * What the wallet with this card has to sign before it ships. A session alone isn't enough to send a card to an address,
     * so nothing moves until this is on the ledger. `fromLedger` is where to look for it.
     */
    async shipAuthorization(address: string, orderId: string, addressHash: string): Promise<{ ok: true; tx: Readonly<Record<string, unknown>>; fromLedger: number } | Refusal> {
      const auth = await this.cardAuthority(address, orderId);
      if (!auth.ok) return auth;
      const c = auth.card;
      if (c.status !== "held") return no("not_stashed", "We're checking on this card. It's safe, and you'll see it here.");
      if (c.hold !== "stashed" && c.hold !== "offered" && c.hold !== "mirrored") return no("not_stashed", "Only something in your stash can be shipped.");
      const wait = c.mirror ? await mirrorWait(c, BURN_FAILED) : null;
      if (wait) return wait;
      const validated = await deps.chain.validatedLedger();
      return { ok: true, fromLedger: validated, tx: { TransactionType: "AccountSet", Account: address, LastLedgerSequence: validated + ORDER_LEDGERS, Memos: shipMemos(orderId, addressHash) } };
    },

    /** Ship: the wallet's signature is read off the ledger, the mirror is retired, then the card joins the operator's shipping queue. The address itself stays off the log. */
    async shipCard(address: string, orderId: string, addressHash: string, fromLedger: number): Promise<{ ok: true } | Refusal> {
      return retryBusy<{ ok: true; code?: undefined } | Refusal>(() => this.shipCardOnce(address, orderId, addressHash, fromLedger));
    },

    async shipCardOnce(address: string, orderId: string, addressHash: string, fromLedger: number): Promise<{ ok: true } | Refusal> {
      const auth = await this.cardAuthority(address, orderId);
      if (!auth.ok) return auth;
      const c = auth.card;
      if (c.exit?.kind === "ship") return c.exit.addressHash === addressHash ? { ok: true } : no("not_stashed", "This card is already on its way to another address.");
      if (c.status !== "held") return no("not_stashed", "We're checking on this card. It's safe, and you'll see it here.");
      if (c.hold !== "stashed" && c.hold !== "offered" && c.hold !== "mirrored") return no("not_stashed", "Only something in your stash can be shipped.");
      const wait = c.mirror ? await mirrorWait(c, BURN_FAILED) : null;
      if (wait) return wait;
      const unsigned = no("ship_unsigned", "Your wallet's approval isn't on the ledger yet. Once you've approved it, this takes a few seconds.");
      const history = await deps.chain.accountTx(address, fromLedger).catch(() => null);
      const signed = history?.find((t) => t.tx.Account === address && t.tx.TransactionType === "AccountSet" && t.result === "tesSUCCESS" && namesShipment(t.tx.Memos, orderId, addressHash));
      if (!signed) return unsigned;
      const ok = await commit([{ type: "card_exit_requested", data: { order: c.id, kind: "ship", by: address, drops: null, usdMicro: null, addressHash, shipTx: signed.hash, shipLedger: signed.ledger } }]);
      return ok ? { ok: true } : no("busy", "Try again.");
    },

    /** Operator: the card is on its way. */
    async markShipped(orderId: string, by: string, ref: string) {
      await sync();
      if (state.cards.get(orderId)?.hold !== "ship_queue") return false;
      return commit([{ type: "card_shipped", data: { order: orderId, by, ref } }]);
    },

    /**
     * Operator: settle a card held for review, after checking the provider by memo. "refund" gives the XRP back whole.
     * "restash" takes back a sale the provider never took, and puts the card in the stash of the wallet that asked to sell.
     */
    async resolveCard(orderId: string, by: string, action: "resume" | "refund" | "restash") {
      await sync();
      const c = state.cards.get(orderId);
      if (!c || c.status !== "review") return false;
      // A live mirror stands for the card, a mint in flight may have made one, and a card on its way out is owed to whoever
      // asked: its holder may not be the first buyer and the card may be gone. In each, the XRP can't go back to the first buyer.
      if (action === "refund" && (c.mirror || c.exit || (c.hold !== null && c.hold !== "stashed"))) return false;
      if (action === "restash") {
        if (c.hold !== "exit_source" || !c.exit || !c.mint) return false;
        // The last sale we signed can still land until its blockhash dies, so the card has to stay put for that long first.
        if (now().getTime() - Date.parse(c.movedAt) < RESTASH_WAIT_MS) return false;
        if (deps.gateway && !(await deps.gateway.prove(c.mint)).held) return false;
        return commit([{ type: "card_resolved", data: { order: orderId, by, action } }]);
      }
      return commit(action === "resume" ? [{ type: "card_resolved", data: { order: orderId, by, action } }] : [{ type: "card_resolved", data: { order: orderId, by, action } }, { type: "card_refund_due", data: { id: `card:${c.id}`, order: c.id, to: c.address, drops: c.drops, reason: "operator_refund" } }]);
    },

    /**
     * Operator: settle a swap Relay has stopped answering for, after checking it at relay.link. "released" means it will never deliver, and what it
     * moved is free to go again. "landed" means it did, by a route the checks here can't see.
     */
    async resolveSwap(id: string, by: string, action: "landed" | "released", amount?: string) {
      await sync();
      const x = state.swaps.get(id);
      if (!x || x.status !== "deposited" || nowMs() - Date.parse(x.movedAt) < SWAP_STALL_MS) return false;
      return commit([{ type: "swap_resolved", data: { id, by, action, ...(amount ? { amount } : {}) } }]);
    },

    paymentTx,
    cardPaymentTx,
    bundlePaymentTx,
    prices: () => NFT_PRICES,
  };
}

export type RipEngine = ReturnType<typeof createEngine>;
