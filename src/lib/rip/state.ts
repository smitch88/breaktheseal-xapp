import { BANDS, type EmptyBand, type ItemOdds, type PrizeRow } from "./draw.ts";
import { XRP_TOKEN, type TokenSpec } from "./tokens.ts";
import type { Drops, Lot, PayoutItem, RipEvent, StrikeReads, TxKind } from "./types.ts";
import type { NftPrice } from "../../config/nft-packs.ts";

/** Everything the system believes, computed only by replaying the event log. There is no other source of truth. */
export type LotStatus = "pending" | "available" | "awarded" | "returned" | "removed";
export interface LotState extends Lot {
  status: LotStatus;
  /** Ledger from which pulls may land on this lot, once its anchor is on the ledger. */
  addLedger: number | null;
  removeLedger: number | null;
  awardedTo: string | null;
  /** The ledger its sale settled in, once it's sold back. */
  returnedLedger?: number | null;
}

export type BuyStatus = "planned" | "offered" | "cancelling" | "filled" | "registered" | "ended";
/** One NFT the vault set out to buy. `ended` means nothing was paid. */
export interface BuyState {
  id: string;
  seq: number;
  at: string;
  nftId: string;
  price: NftPrice;
  band: number;
  slug: string;
  collection: string;
  name: string;
  img: string;
  route: "direct" | "broker";
  offerIndex: string | null;
  broker: string | null;
  seller: string;
  listDrops: Drops;
  offeredDrops: Drops;
  markDrops: Drops;
  createdLedger: number;
  status: BuyStatus;
  /** The buy offer on the ledger, for a broker's route. */
  offerId: string | null;
  offerLedger: number | null;
  /** A cancel went out and didn't remove the offer, so it's gone another way: filled, or expired. */
  cancelTried: boolean;
  why: string | null;
  txHash: string | null;
}

export interface SeasonState {
  season: string;
  price: NftPrice;
  priceDrops: Drops;
  bandBps: readonly number[];
  commit: string;
  length: number;
  sellBps: number;
  usdAtOpen: number | null;
  /** Token prizes this season pays, fixed when it opens. Empty means every pull is an NFT. */
  prizeTable: readonly PrizeRow[];
  tokens: readonly TokenSpec[];
  /** What a band's NFT share pays once its pool is empty. Unset: the pull is refunded whole, as on every season before 5-6. */
  emptyBand?: EmptyBand;
  /** Per-item NFT odds: see ItemOdds in draw.ts. Unset: one fair pick across a band's pool, as on every season before 5-6. */
  nftOdds?: ItemOdds;
  /** True once the commitment is on the ledger. Nothing sells before that. */
  live: boolean;
  anchorTx: string | null;
  anchorLedger: number | null;
  nextIndex: number;
}

export type OrderStatus = "quoted" | "paid" | "drawn" | "expired" | "refund_due" | "refunded";
export type PullStatus = "stashed" | "selling" | "sold" | "offering" | "offered" | "claimed" | "cancelling" | "redeeming" | "redeemed";

/** A token prize, struck at the draw and fixed from then on. The token sits in the treasury until it's redeemed or sold. */
export interface OrderPrize {
  token: string;
  /** Drops for XRP, whole tokens for anything else. */
  amount: string;
  valueDrops: Drops;
  reads: StrikeReads | null;
  /** Why the last redemption came back, so a player can be told. */
  note: string | null;
  /** Struck when the treasury was short of XRP. It's the player's, and it goes out by itself once the treasury can pay it. */
  owed: boolean;
  redeemTx: string | null;
}

export interface OrderState {
  id: string;
  /** Opened on a launch's word, with no signature behind the address. It holds a place like any other, and has its own limits. */
  unproven?: boolean;
  season: string;
  price: NftPrice;
  address: string;
  invoice: string;
  drops: Drops;
  lastLedger: number;
  createdLedger: number;
  status: OrderStatus;
  /** Set once paid. */
  txHash: string | null;
  ledger: number | null;
  txIndex: number | null;
  index: number | null;
  entropyLedger: number | null;
  /** Set once drawn. */
  band: number | null;
  lot: string | null;
  nftId: string | null;
  pull: PullStatus | null;
  sellDrops: Drops | null;
  sellTx: string | null;
  offerId: string | null;
  offerLedger: number | null;
  claimTx: string | null;
  refundId: string | null;
  /** The ledger of the last payout this wallet refused, and of the last offer it took back. Each starts a wait. */
  payoutFailLedger: number | null;
  claimCancelLedger: number | null;
  /** That wait came from an offer that failed on the ledger, as when a wallet turns offers away, and not from taking it back. */
  claimRefused: boolean;
  /** Set when the pull landed on a token prize. Lot and NFT are then null. */
  prize: OrderPrize | null;
  createdAt: string;
  paidAt: string | null;
  drawnAt: string | null;
  /** The multi order this pull came from. A pull bought on its own never has one. */
  bundle?: string;
  /** The one payment this pull is being paid out in, while and after it is. Back to null if that payment fails. */
  payout?: string | null;
  /** The last payment of this item that its wallet refused, so a page can say why it's back in the stash. */
  failedPayout?: string | null;
}

/** Several packs for one payment. Each child is an ordinary pull or card, and this only ties them to the payment. */
export interface BundleState {
  id: string;
  kind: "nft" | "card";
  address: string;
  invoice: string;
  /** What the one payment has to be, and what each pack in it costs. */
  drops: Drops;
  each: Drops;
  qty: number;
  children: readonly string[];
  price: NftPrice | null;
  season: string | null;
  code: string | null;
  name: string | null;
  usd: number | null;
  lastLedger: number;
  createdLedger: number;
  status: "quoted" | "paid" | "expired";
  txHash: string | null;
  ledger: number | null;
  txIndex: number | null;
  createdAt: string;
  paidAt: string | null;
  /** Held on a launch's word alone. Its children say so too, so every count of such holds counts them place by place. */
  unproven?: boolean;
}

/** One XRP payment for several items, all or nothing. */
export interface PayoutState {
  id: string;
  address: string;
  total: Drops;
  items: readonly PayoutItem[];
  status: "due" | "sent" | "done" | "failed";
  txHash: string | null;
  result: string | null;
  createdAt: string;
}

export type CardStatus = "quoted" | "expired" | "paid" | "funding" | "generating" | "generated" | "signed" | "source_paid" | "opened" | "held" | "review" | "refund_due" | "refunded";
/** Where a held card stands. "stashed" means kept in custody with no mirror yet. A mirror is only minted when claimed. */
export type CardHold = "stashed" | "minting" | "offered" | "mirrored" | "exit_burn" | "exit_source" | "selling" | "sold" | "ship_queue" | "shipped";

export interface CardState {
  id: string;
  /** As on an order. */
  unproven?: boolean;
  code: string;
  packName: string;
  usd: number;
  drops: Drops;
  xrpUsd: number;
  address: string;
  invoice: string;
  lastLedger: number;
  createdLedger: number;
  gateway: string;
  status: CardStatus;
  review: string | null;
  txHash: string | null;
  ledger: number | null;
  txIndex: number | null;
  memo: string | null;
  transaction: string | null;
  signature: string | null;
  bytes: string | null;
  mint: string | null;
  name: string | null;
  img: string | null;
  grade: string | null;
  insuredMicro: string | null;
  rarity: string | null;
  instantBuybackPct: number;
  proof: string | null;
  proofSlot: number | null;
  /** When that custody reading was logged. Every reading replaces the last, and its hash includes its slot, so each one differs. */
  proofAt?: string | null;
  /** When the card first reached custody, which is when the pull was final. Display only, and it never moves. */
  heldAt?: string | null;
  hold: CardHold | null;
  /** Set for the life of the mirror. Cleared when it is burned. */
  mirror: { nftId: string; offerId: string; mintTx: string; ledger: number; accepted: boolean; acceptTx?: string | null } | null;
  /** The ledger of the last mint or burn that failed on the ledger. Another try on the minter's one slot waits after it. */
  mirrorFailLedger: number | null;
  /** That wait comes from the player taking an offer back, not from anything failing. */
  takenBack?: boolean;
  everMinted: number;
  /** "back" is a player taking back an open offer: the mirror is burned and the card goes back in the stash. */
  /**
   * `passthrough` is a sale paid out of its own USDC: the treasury doesn't owe it until Relay's XRP lands, which sets `funded`.
   * `grossMicro` is what Collector Crypt paid custody for it.
   */
  exit: { kind: "sell" | "ship" | "back"; by: string; drops: Drops | null; usdMicro: string | null; addressHash: string | null; from: CardHold; started?: boolean; passthrough?: boolean; funded?: boolean; grossMicro?: string } | null;
  /** Where this pack's USDC came from: custody already had it, or its own XRP swapped first. Unset when the switch is off. */
  funding?: "float" | "swap" | null;
  /** The live swap this card's waiting on, and what landed for it. */
  fundingSwap?: string | null;
  landedMicro?: string | null;
  /** USDC has left custody for this pack. */
  sourcePaid?: boolean;
  sellTx: string | null;
  shipRef: string | null;
  refundId: string | null;
  createdAt: string;
  /** When we asked the provider for a pack, and when this card last moved a step. */
  generatingAt: string | null;
  movedAt: string;
  /** The multi order this card came from. A card bought on its own never has one. */
  bundle?: string;
}

/** One swap through Relay. Every step of it is in the log, so a crash or a second server can only carry it on. */
export type SwapStatus = "quoted" | "depositing" | "signed" | "deposited" | "landed" | "refunded" | "dead" | "review";
export interface SwapState {
  id: string;
  dir: "xrp_to_usdc" | "usdc_to_xrp";
  purpose: "buy_first" | "sell_first" | "refund_back" | "refill";
  card: string | null;
  accruals: readonly string[];
  requestId: string;
  orderId: string;
  depository: string;
  inAmount: string;
  outMin: string;
  outExpected: string;
  deadline: number;
  /** This swap's size in USDC micros, for the caps. */
  usdMicro: string;
  status: SwapStatus;
  signature: string | null;
  bytes: string | null;
  depositTx: string | null;
  landedAmount: string | null;
  landedProof: string | null;
  deadReason: string | null;
  openedAt: string;
  movedAt: string;
}

/**
 * Money an order brought in that's on the wrong side: XRP in the treasury that paid for a pack out of custody's USDC, or USDC in custody
 * from a sale the treasury paid out. It's a limit as much as a record: a refill moves whole accruals and never more than they add up to.
 */
export interface Accrual {
  id: string;
  order: string;
  dir: "to_custody" | "to_treasury";
  /** Drops to custody; USDC micros to the treasury. */
  amount: string;
  /** What this needs to replace at custody, in USDC micros. */
  usdMicro: string | null;
  reason: "float_pack" | "sale" | "failed_pack" | "late_fill";
  status: "owed" | "moving" | "done" | "void";
  swap: string | null;
  createdAt: string;
}

export interface RefundState {
  id: string;
  to: string;
  drops: Drops;
  reason: string;
  order: string | null;
  sourceTag: number | null;
  status: "due" | "sent" | "done" | "stuck";
  txHash: string | null;
  result: string | null;
  paymentTx: string | null;
}

export interface Intent {
  id: string;
  kind: TxKind;
  ref: string;
  account: string;
  sequence: number;
  lastLedger: number;
  hash: string;
  blob: string;
  tx: Readonly<Record<string, unknown>>;
}

export interface PoolChange {
  id: string;
  price: NftPrice;
  adds: readonly string[];
  removes: readonly string[];
  root: string;
  anchored: boolean;
  anchorTx: string | null;
  ledger: number | null;
  /** The log position of the change, used by the verifier. */
  seq: number;
}

export interface RipState {
  head: number;
  headHash: string;
  seasons: Map<string, SeasonState>;
  activeSeason: Map<NftPrice, string>;
  lots: Map<string, LotState>;
  /** nftId to the lot that currently holds it, so no NFT can sit in two lots. */
  nftLot: Map<string, string>;
  orders: Map<string, OrderState>;
  cards: Map<string, CardState>;
  bundles: Map<string, BundleState>;
  payouts: Map<string, PayoutState>;
  orderByInvoice: Map<string, string>;
  seenTx: Set<string>;
  refunds: Map<string, RefundState>;
  intents: Map<string, Intent>;
  poolChanges: Map<string, PoolChange>;
  cursors: Map<string, number>;
  settled: Map<string, { kind: TxKind; ref: string; hash: string; result: string; ledger: number | null }>;
  genesis: { networkId: number; treasury: string; vault: string } | null;
  /** Which kind of treasury payout went last, so refunds and sell-backs take turns and neither can starve the other. */
  lastTreasuryKind: TxKind | null;
  /** The highest payment ledger a draw has used, per price, so a late anchor shows up in a replay. */
  drawnThrough: Map<NftPrice, number>;
  swaps: Map<string, SwapState>;
  accruals: Map<string, Accrual>;
  relayArrivals: Map<string, { txHash: string; ledger: number; from: string; drops: Drops; memo: string | null; swap: string | null }>;
  /** Every proof a swap has been credited with. A fill counts once, ever. */
  swapProofs: Set<string>;
  buys: Map<string, BuyState>;
  /** Sold-back lots kept out of their pools until a person looks, by lot. */
  restockHolds: Map<string, { nftId: string; reason: string; at: string }>;
  /** Set while the kill switch is off. Unset means whatever the environment says. */
  autobuyOff: { by: string; why: string | null; at: string } | null;
  /** Misses before this don't count toward stopping again. */
  autobuyOnSeq: number;
}

export const GENESIS_HASH = "0".repeat(64);

export const emptyState = (): RipState => ({
  head: 0,
  headHash: GENESIS_HASH,
  seasons: new Map(),
  activeSeason: new Map(),
  lots: new Map(),
  nftLot: new Map(),
  orders: new Map(),
  cards: new Map(),
  bundles: new Map(),
  payouts: new Map(),
  orderByInvoice: new Map(),
  seenTx: new Set(),
  refunds: new Map(),
  intents: new Map(),
  poolChanges: new Map(),
  cursors: new Map(),
  settled: new Map(),
  genesis: null,
  lastTreasuryKind: null,
  drawnThrough: new Map(),
  swaps: new Map(),
  accruals: new Map(),
  relayArrivals: new Map(),
  swapProofs: new Set(),
  buys: new Map(),
  restockHolds: new Map(),
  autobuyOff: null,
  autobuyOnSeq: 0,
});

const accrue = (s: RipState, a: Omit<Accrual, "status" | "swap">) => {
  if (!s.accruals.has(a.id)) s.accruals.set(a.id, { ...a, status: "owed", swap: null });
};

/** What a swap moved goes back to being owed, and a card waiting on it goes back to deciding. */
function releaseSwap(s: RipState, x: SwapState, status: SwapStatus) {
  x.status = status;
  for (const id of x.accruals) {
    const a = s.accruals.get(id);
    if (a?.status === "moving" && a.swap === x.id) {
      a.status = "owed";
      a.swap = null;
    }
  }
  const c = x.card ? s.cards.get(x.card) : null;
  if (c?.status === "funding" && c.fundingSwap === x.id && status === "dead") {
    c.status = "paid";
    c.funding = null;
    c.fundingSwap = null;
  }
}

function landSwap(s: RipState, x: SwapState, amount: string, proof: string | null, at: string) {
  x.status = "landed";
  x.landedAmount = amount;
  x.landedProof = proof;
  x.movedAt = at;
  for (const id of x.accruals) {
    const a = s.accruals.get(id);
    if (a) a.status = "done";
  }
  const c = x.card ? s.cards.get(x.card) : null;
  if (x.dir === "xrp_to_usdc" && x.card) {
    if (c?.status === "funding" && c.fundingSwap === x.id) {
      c.status = "paid";
      c.funding = "swap";
      c.landedMicro = amount;
    } else {
      // The order ended while this was out, so nothing will spend it. It's USDC on the wrong side, and it's marked to come back.
      accrue(s, { id: `late:${x.id}`, order: x.card, dir: "to_treasury", amount, usdMicro: null, reason: "late_fill", createdAt: at });
    }
  }
  if (x.dir === "usdc_to_xrp" && c?.exit?.passthrough && c.exit.drops && BigInt(amount) >= BigInt(c.exit.drops) && x.purpose === "sell_first") c.exit.funded = true;
}

const SUCCESS = "tesSUCCESS";

function settleIntent(s: RipState, e: Extract<RipEvent, { type: "tx_final" }>) {
  const i = s.intents.get(e.data.id);
  if (!i) return;
  s.intents.delete(e.data.id);
  s.settled.set(e.data.id, { kind: i.kind, ref: i.ref, hash: e.data.hash, result: e.data.result, ledger: e.data.ledger });
  const ok = e.data.result === SUCCESS;
  // A transaction that expired unapplied changed nothing, so the work stays due and is signed again. A tec applied and
  // failed, and only a person can tell why, so it goes to the stuck list or back to the player's stash.
  const expired = e.data.result === "expired";
  switch (i.kind) {
    case "anchor": {
      if (!ok) return;
      applyAnchor(s, i.ref, e.data.hash, e.data.ledger ?? 0);
      return;
    }
    case "refund": {
      const r = s.refunds.get(i.ref);
      if (!r) return;
      if (ok) {
        r.status = "done";
        r.txHash = e.data.hash;
        r.result = e.data.result;
        if (r.order) {
          const o = s.orders.get(r.order);
          if (o && o.status === "refund_due" && o.refundId === r.id) o.status = "refunded";
          const c = s.cards.get(r.order);
          if (c && c.status === "refund_due" && c.refundId === r.id) c.status = "refunded";
        }
      } else if (expired) {
        r.status = "due";
      } else {
        r.status = "stuck";
        r.result = e.data.result;
      }
      return;
    }
    case "sellback": {
      const o = s.orders.get(i.ref);
      if (!o || o.pull !== "selling") return;
      if (ok) {
        o.pull = "sold";
        o.sellTx = e.data.hash;
        const l = o.lot ? s.lots.get(o.lot) : null;
        if (l) {
          l.status = "returned";
          l.awardedTo = null;
          l.returnedLedger = e.data.ledger;
        }
      } else if (!expired) {
        // The payout failed and moved nothing: the NFT stays the player's, in the stash.
        o.pull = "stashed";
        o.sellDrops = null;
        o.payoutFailLedger = e.data.ledger;
      }
      return;
    }
    case "prize_redeem": {
      const o = s.orders.get(i.ref);
      if (!o?.prize || o.pull !== "redeeming") return;
      if (ok) {
        o.pull = "redeemed";
        o.prize.redeemTx = e.data.hash;
        o.prize.note = null;
      } else if (!expired) {
        // It applied and failed, so nothing moved: the prize stays the player's, in the stash, and the reason shows.
        o.pull = "stashed";
        o.prize.note = e.data.result;
        o.payoutFailLedger = e.data.ledger;
      }
      return;
    }
    case "payout": {
      const p = s.payouts.get(i.ref);
      if (!p || p.status !== "sent") return;
      p.result = e.data.result;
      // It never applied, so the work is still due and gets signed again. Its items stay where they are.
      if (expired) {
        p.status = "due";
        p.txHash = null;
        return;
      }
      p.status = ok ? "done" : "failed";
      for (const item of p.items) {
        const o = s.orders.get(item.order);
        if (!o) continue;
        if (ok) {
          if (item.action === "sell") {
            o.pull = "sold";
            o.sellTx = e.data.hash;
            const l = o.lot ? s.lots.get(o.lot) : null;
            if (l) {
              l.status = "returned";
              l.awardedTo = null;
              // A bulk sale's NFTs go back by the same clock as a single sale's.
              l.returnedLedger = e.data.ledger;
            }
          } else if (o.prize) {
            o.pull = "redeemed";
            o.prize.redeemTx = e.data.hash;
            o.prize.note = null;
          }
        } else {
          // It applied and failed, so nothing moved: everything stays the player's, in the stash, and each waits like a single refused payout.
          o.pull = "stashed";
          o.sellDrops = null;
          o.payout = null;
          o.failedPayout = p.id;
          o.payoutFailLedger = e.data.ledger;
          if (o.prize && item.action === "redeem") o.prize.note = e.data.result;
        }
      }
      return;
    }
    case "claim_offer": {
      const o = s.orders.get(i.ref);
      if (!o || o.pull !== "offering") return;
      if (ok) {
        // Success always leaves an offer on the ledger. If the id can't be read, selling stays blocked for a person to look.
        o.pull = "offered";
        o.offerId = e.data.offerId ?? null;
        o.offerLedger = e.data.ledger;
      } else if (!expired) {
        // The wallet can turn the offer away (no incoming offers), so this waits like a cancel, or it could loop on the vault's slot.
        o.pull = "stashed";
        o.claimCancelLedger = e.data.ledger;
        o.claimRefused = true;
      }
      return;
    }
    case "mirror_mint": {
      const c = s.cards.get(i.ref);
      if (!c || c.hold !== "minting") return;
      if (ok && e.data.nftId && e.data.offerId) {
        c.hold = "offered";
        c.everMinted += 1;
        c.mirror = { nftId: e.data.nftId, offerId: e.data.offerId, mintTx: e.data.hash, ledger: e.data.ledger ?? 0, accepted: false };
      } else if (ok) {
        // It minted and we can't read what. Minting again would make a second mirror, so this stops for a person.
        c.status = "review";
        c.review = `mint landed without ids: ${e.data.hash}`;
      } else if (!expired) {
        // The wallet can turn the offer away, so this waits, or claiming again could loop on the minter's slot and the log.
        c.hold = "stashed";
        c.mirrorFailLedger = e.data.ledger;
      }
      return;
    }
    case "mirror_burn": {
      const c = s.cards.get(i.ref);
      if (!c || c.hold !== "exit_burn" || !c.exit) return;
      if (ok) {
        c.mirror = null;
        if (c.exit.kind === "back") {
          c.hold = "stashed";
          c.exit = null;
          c.mirrorFailLedger = e.data.ledger;
          c.takenBack = true;
          return;
        }
        c.hold = c.exit.kind === "sell" ? "exit_source" : "ship_queue";
      } else if (!expired) {
        // The holder moved it on, or it isn't burnable from here. The card and the mirror both stay as they were.
        // It waits as well: a holder passing the mirror along each time it's asked to burn could otherwise hold that same slot.
        c.hold = c.exit.from;
        c.exit = null;
        c.mirrorFailLedger = e.data.ledger;
      }
      return;
    }
    case "card_sellback": {
      const c = s.cards.get(i.ref);
      if (!c || c.hold !== "selling") return;
      if (ok) {
        c.hold = "sold";
        c.sellTx = e.data.hash;
      } else if (!expired) {
        // The card has already gone back to the provider, so this payout is owed until it lands.
        c.review = `payout failed: ${e.data.result}`;
        c.status = "review";
      }
      return;
    }
    case "relay_deposit": {
      const x = s.swaps.get(i.ref);
      if (!x) return;
      x.movedAt = e.at;
      if (ok) {
        x.status = "deposited";
        x.depositTx = e.data.hash;
      } else {
        // It expired unapplied or applied and failed: no XRP moved either way, and a new quote gets a new order.
        x.deadReason = e.data.result;
        releaseSwap(s, x, "dead");
      }
      return;
    }
    case "vault_buy": {
      const b = s.buys.get(i.ref);
      if (!b || b.status !== "planned") return;
      if (ok) {
        b.txHash = e.data.hash;
        if (b.route === "direct") b.status = "filled";
        else {
          b.status = "offered";
          b.offerId = e.data.offerId ?? null;
          b.offerLedger = e.data.ledger;
        }
      } else if (!expired) {
        // The ledger said no, usually because someone else bought it first. Nothing was paid.
        b.status = "ended";
        b.why = e.data.result;
      }
      return;
    }
    case "vault_buy_cancel": {
      const b = s.buys.get(i.ref);
      if (!b || b.status !== "cancelling") return;
      // Success doesn't prove the offer was still there. Only its own metadata saying it removed the offer means nothing can fill it now.
      if (ok && e.data.stillHeld === true) {
        b.status = "ended";
        b.why = "unfilled";
      } else if (!expired) {
        b.status = "offered";
        b.cancelTried = true;
      }
      return;
    }
    case "claim_cancel": {
      const o = s.orders.get(i.ref);
      if (!o || o.pull !== "cancelling") return;
      // NFTokenCancelOffer succeeds even if the offer is already gone, so success alone proves nothing. The NFT only goes
      // back in the stash if it's still in the vault. If the player accepted first, the vault scan records that.
      if (ok && e.data.stillHeld === true) {
        o.pull = "stashed";
        o.offerId = null;
        o.claimCancelLedger = e.data.ledger;
        o.claimRefused = false;
      } else if (!expired) {
        o.pull = "offered";
      }
      return;
    }
  }
}

function applyAnchor(s: RipState, ref: string, txHash: string, ledger: number) {
  if (ref.startsWith("season:")) {
    const season = s.seasons.get(ref.slice(7));
    if (!season) return;
    season.live = true;
    season.anchorTx = txHash;
    season.anchorLedger = ledger;
    s.activeSeason.set(season.price, season.season);
    return;
  }
  if (ref.startsWith("pool:")) {
    const p = s.poolChanges.get(ref.slice(5));
    if (!p) return;
    p.anchored = true;
    p.anchorTx = txHash;
    p.ledger = ledger;
    for (const id of p.adds) {
      const l = s.lots.get(id);
      if (l && l.status === "pending") {
        l.status = "available";
        l.addLedger = ledger + 1;
      }
    }
    for (const id of p.removes) {
      const l = s.lots.get(id);
      if (l && l.status === "available") l.removeLedger = ledger + 1;
    }
  }
}

/** Replay one event onto the state. Pure in the sense that the log alone decides the result: no clock, no network. */
export function apply(s: RipState, e: RipEvent): void {
  s.head = e.seq;
  s.headHash = e.hash;
  if (e.type.startsWith("card_") && "order" in e.data) {
    const moved = s.cards.get(e.data.order as string);
    if (moved) moved.movedAt = e.at;
  }
  switch (e.type) {
    case "log_genesis":
      s.genesis = e.data;
      return;
    case "season_open": {
      const d = e.data;
      s.seasons.set(d.season, { season: d.season, price: d.price, priceDrops: d.priceDrops, bandBps: d.bandBps, commit: d.commit, length: d.length, sellBps: d.sellBps, usdAtOpen: d.usdAtOpen, prizeTable: d.prizeTable ?? [], tokens: d.tokens ?? [], ...(d.emptyBand ? { emptyBand: d.emptyBand } : {}), ...(d.nftOdds ? { nftOdds: d.nftOdds } : {}), live: false, anchorTx: null, anchorLedger: null, nextIndex: 0 });
      return;
    }
    case "pool_change": {
      const d = e.data;
      s.poolChanges.set(d.id, { id: d.id, price: d.price, adds: d.adds.map((l) => l.lot), removes: d.removes, root: d.root, anchored: false, anchorTx: null, ledger: null, seq: e.seq });
      for (const lot of d.adds) {
        // An NFT sold back returns as a new lot, and that closes the old one.
        const old = s.lots.get(s.nftLot.get(lot.nftId) ?? "");
        if (old) s.restockHolds.delete(old.lot);
        if (old?.status === "returned" || (old?.status === "available" && old.removeLedger !== null)) old.status = "removed";
        s.lots.set(lot.lot, { ...lot, status: "pending", addLedger: null, removeLedger: null, awardedTo: null, returnedLedger: null });
        s.nftLot.set(lot.nftId, lot.lot);
        for (const b of s.buys.values()) if (b.nftId === lot.nftId && b.status === "filled") b.status = "registered";
      }
      return;
    }
    case "restock_hold":
      s.restockHolds.set(e.data.lot, { nftId: e.data.nftId, reason: e.data.reason, at: e.at });
      return;
    case "restock_buy_planned": {
      const d = e.data;
      if (s.buys.has(d.id)) return;
      s.buys.set(d.id, { ...d, seq: e.seq, at: e.at, status: "planned", offerId: null, offerLedger: null, cancelTried: false, why: null, txHash: null });
      return;
    }
    case "restock_buy_cancel": {
      const b = s.buys.get(e.data.id);
      if (b?.status === "offered") b.status = "cancelling";
      return;
    }
    case "restock_buy_filled": {
      const b = s.buys.get(e.data.id);
      if (b?.status === "offered" || b?.status === "cancelling") b.status = "filled";
      return;
    }
    case "restock_buy_ended": {
      const b = s.buys.get(e.data.id);
      if (b && b.status !== "filled" && b.status !== "registered") {
        b.status = "ended";
        b.why = e.data.why;
      }
      return;
    }
    case "restock_switch":
      s.autobuyOff = e.data.on ? null : { by: e.data.by, why: e.data.why, at: e.at };
      if (e.data.on) s.autobuyOnSeq = e.seq;
      return;
    case "order_created": {
      const d = e.data;
      s.orders.set(d.id, { id: d.id, ...(d.unproven ? { unproven: true } : {}), season: d.season, price: d.price, address: d.address, invoice: d.invoice, drops: d.drops, lastLedger: d.lastLedger, createdLedger: d.createdLedger, status: "quoted", txHash: null, ledger: null, txIndex: null, index: null, entropyLedger: null, band: null, lot: null, nftId: null, pull: null, sellDrops: null, sellTx: null, offerId: null, offerLedger: null, claimTx: null, refundId: null, payoutFailLedger: null, claimCancelLedger: null, claimRefused: false, prize: null, createdAt: e.at, paidAt: null, drawnAt: null });
      s.orderByInvoice.set(d.invoice, d.id);
      return;
    }
    case "bundle_created": {
      const d = e.data;
      s.bundles.set(d.id, { id: d.id, ...(d.unproven ? { unproven: true } : {}), kind: "nft", address: d.address, invoice: d.invoice, drops: d.drops, each: d.each, qty: d.qty, children: d.children, price: d.price, season: d.season, code: null, name: null, usd: null, lastLedger: d.lastLedger, createdLedger: d.createdLedger, status: "quoted", txHash: null, ledger: null, txIndex: null, createdAt: e.at, paidAt: null });
      // Only the bundle's invoice can be paid. Its children sit in the orders like any other, so everything after the payment works the same.
      s.orderByInvoice.set(d.invoice, d.id);
      for (const id of d.children) s.orders.set(id, { id, ...(d.unproven ? { unproven: true } : {}), season: d.season, price: d.price, address: d.address, invoice: d.invoice, drops: d.each, lastLedger: d.lastLedger, createdLedger: d.createdLedger, status: "quoted", txHash: null, ledger: null, txIndex: null, index: null, entropyLedger: null, band: null, lot: null, nftId: null, pull: null, sellDrops: null, sellTx: null, offerId: null, offerLedger: null, claimTx: null, refundId: null, payoutFailLedger: null, claimCancelLedger: null, claimRefused: false, prize: null, createdAt: e.at, paidAt: null, drawnAt: null, bundle: d.id, payout: null });
      return;
    }
    case "card_bundle_created": {
      const d = e.data;
      s.bundles.set(d.id, { id: d.id, ...(d.unproven ? { unproven: true } : {}), kind: "card", address: d.address, invoice: d.invoice, drops: d.drops, each: d.each, qty: d.qty, children: d.children, price: null, season: null, code: d.code, name: d.name, usd: d.usd, lastLedger: d.lastLedger, createdLedger: d.createdLedger, status: "quoted", txHash: null, ledger: null, txIndex: null, createdAt: e.at, paidAt: null });
      s.orderByInvoice.set(d.invoice, d.id);
      for (const id of d.children) s.cards.set(id, { id, ...(d.unproven ? { unproven: true } : {}), code: d.code, packName: d.name, usd: d.usd, drops: d.each, xrpUsd: d.xrpUsd, address: d.address, invoice: d.invoice, lastLedger: d.lastLedger, createdLedger: d.createdLedger, gateway: d.gateway, status: "quoted", review: null, txHash: null, ledger: null, txIndex: null, memo: null, transaction: null, signature: null, bytes: null, mint: null, name: null, img: null, grade: null, insuredMicro: null, rarity: null, instantBuybackPct: 0, proof: null, proofSlot: null, hold: null, mirror: null, mirrorFailLedger: null, everMinted: 0, exit: null, sellTx: null, shipRef: null, refundId: null, createdAt: e.at, generatingAt: null, movedAt: e.at, bundle: d.id });
      return;
    }
    case "bundle_paid": {
      const d = e.data;
      s.seenTx.add(d.txHash);
      const b = s.bundles.get(d.bundle);
      if (b?.status === "quoted") {
        b.status = "paid";
        b.txHash = d.txHash;
        b.ledger = d.ledger;
        b.txIndex = d.txIndex;
        b.paidAt = e.at;
      }
      return;
    }
    case "order_expired": {
      const b = s.bundles.get(e.data.id);
      if (b) {
        if (b.status !== "quoted") return;
        b.status = "expired";
        for (const id of b.children) {
          const child = s.orders.get(id) ?? s.cards.get(id);
          if (child?.status === "quoted") child.status = "expired";
        }
        return;
      }
      const o = s.orders.get(e.data.id) ?? s.cards.get(e.data.id);
      if (o && o.status === "quoted") o.status = "expired";
      return;
    }
    case "pull_paid": {
      const d = e.data;
      s.seenTx.add(d.txHash);
      const o = s.orders.get(d.order);
      if (o?.status === "quoted") {
        o.status = "paid";
        o.txHash = d.txHash;
        o.ledger = d.ledger;
        o.txIndex = d.txIndex;
        o.index = d.index;
        o.entropyLedger = d.entropyLedger;
        o.paidAt = e.at;
      }
      const season = s.seasons.get(d.season);
      if (season && o?.txHash === d.txHash) season.nextIndex = d.index + 1;
      return;
    }
    case "payment_refund_due": {
      const d = e.data;
      s.seenTx.add(d.txHash);
      // A refund exists once. Setting it again would turn one already paid back into one that's due.
      if (s.refunds.has(d.id)) return;
      s.refunds.set(d.id, { id: d.id, to: d.from, drops: d.drops, reason: d.reason, order: d.order, sourceTag: d.sourceTag, status: "due", txHash: null, result: null, paymentTx: d.txHash });
      return;
    }
    case "payment_ignored":
      s.seenTx.add(e.data.txHash);
      return;
    case "pull_drawn": {
      const d = e.data;
      const o = s.orders.get(d.order);
      if (o?.status !== "paid") return;
      o.status = "drawn";
      o.band = d.band;
      o.lot = d.lot;
      o.nftId = d.nftId;
      o.pull = "stashed";
      o.drawnAt = e.at;
      s.drawnThrough.set(o.price, Math.max(s.drawnThrough.get(o.price) ?? 0, o.ledger ?? 0));
      const l = s.lots.get(d.lot);
      if (l) {
        l.status = "awarded";
        l.awardedTo = d.order;
      }
      return;
    }
    case "pull_prize_drawn": {
      const d = e.data;
      const o = s.orders.get(d.order);
      if (o?.status !== "paid") return;
      o.status = "drawn";
      o.band = d.band;
      // An owed prize is already on its way: nobody has to come back and ask for what the treasury couldn't pay at the draw.
      o.pull = d.owed ? "redeeming" : "stashed";
      o.drawnAt = e.at;
      o.prize = { token: d.token, amount: d.amount, valueDrops: d.valueDrops, reads: d.reads, note: null, owed: !!d.owed, redeemTx: null };
      s.drawnThrough.set(o.price, Math.max(s.drawnThrough.get(o.price) ?? 0, o.ledger ?? 0));
      return;
    }
    case "redeem_requested": {
      const o = s.orders.get(e.data.order);
      if (o?.prize && o.pull === "stashed") {
        o.pull = "redeeming";
        o.failedPayout = null;
        o.prize.note = null;
      }
      return;
    }
    case "redeem_returned": {
      const o = s.orders.get(e.data.order);
      if (o?.prize && o.pull === "redeeming") {
        o.pull = "stashed";
        o.prize.note = e.data.reason;
      }
      return;
    }
    case "pull_refund_due": {
      const d = e.data;
      const o = s.orders.get(d.order);
      if (s.refunds.has(d.id)) return;
      if (o) {
        o.status = "refund_due";
        o.refundId = d.id;
      }
      s.refunds.set(d.id, { id: d.id, to: d.to, drops: d.drops, reason: d.reason, order: d.order, sourceTag: null, status: "due", txHash: null, result: null, paymentTx: o?.txHash ?? null });
      return;
    }
    case "tx_intent": {
      const d = e.data;
      s.intents.set(d.id, { id: d.id, kind: d.kind, ref: d.ref, account: d.account, sequence: d.sequence, lastLedger: d.lastLedger, hash: d.hash, blob: d.blob, tx: d.tx });
      if (d.kind === "refund" || d.kind === "sellback" || d.kind === "card_sellback" || d.kind === "prize_redeem" || d.kind === "payout" || d.kind === "relay_deposit") s.lastTreasuryKind = d.kind;
      if (d.kind === "payout") {
        const p = s.payouts.get(d.ref);
        if (p) {
          p.status = "sent";
          p.txHash = d.hash;
        }
      }
      if (d.kind === "relay_deposit") {
        const x = s.swaps.get(d.ref);
        if (x) x.status = "depositing";
      }
      if (d.kind === "refund") {
        const r = s.refunds.get(d.ref);
        if (r) {
          r.status = "sent";
          r.txHash = d.hash;
        }
      }
      return;
    }
    case "tx_final":
      settleIntent(s, e);
      return;
    case "sell_requested": {
      const o = s.orders.get(e.data.order);
      if (o && o.pull === "stashed") {
        o.pull = "selling";
        o.sellDrops = e.data.drops;
        o.failedPayout = null;
      }
      return;
    }
    case "payout_requested": {
      const d = e.data;
      // All or nothing. A stale decision can't take a part of it, and replay refuses a log that has one.
      const orders = d.items.map((i) => s.orders.get(i.order));
      if (s.payouts.has(d.id) || !orders.every((o) => o?.address === d.address && o.pull === "stashed")) return;
      s.payouts.set(d.id, { id: d.id, address: d.address, total: d.total, items: d.items, status: "due", txHash: null, result: null, createdAt: e.at });
      d.items.forEach((item, n) => {
        const o = orders[n] as OrderState;
        o.payout = d.id;
        o.failedPayout = null;
        if (item.action === "sell") {
          o.pull = "selling";
          o.sellDrops = item.drops;
        } else {
          o.pull = "redeeming";
          if (o.prize) o.prize.note = null;
        }
      });
      return;
    }
    case "claim_requested": {
      const o = s.orders.get(e.data.order);
      if (o && o.pull === "stashed") {
        o.pull = "offering";
        o.failedPayout = null;
      }
      return;
    }
    case "claim_accepted": {
      const o = s.orders.get(e.data.order);
      if (o && (o.pull === "offered" || o.pull === "cancelling" || o.pull === "offering")) {
        o.pull = "claimed";
        o.claimTx = e.data.txHash;
        o.offerId = e.data.offerId;
        const l = o.lot ? s.lots.get(o.lot) : null;
        if (l) s.nftLot.delete(l.nftId);
      }
      return;
    }
    case "claim_cancel_requested": {
      const o = s.orders.get(e.data.order);
      if (o && o.pull === "offered") o.pull = "cancelling";
      return;
    }
    case "refund_retry": {
      const r = s.refunds.get(e.data.id);
      if (r && r.status === "stuck") r.status = "due";
      return;
    }
    case "scan_cursor":
      s.cursors.set(e.data.account, e.data.ledger);
      return;
    case "card_order_created": {
      const d = e.data;
      s.cards.set(d.id, { id: d.id, ...(d.unproven ? { unproven: true } : {}), code: d.code, packName: d.name, usd: d.usd, drops: d.drops, xrpUsd: d.xrpUsd, address: d.address, invoice: d.invoice, lastLedger: d.lastLedger, createdLedger: d.createdLedger, gateway: d.gateway, status: "quoted", review: null, txHash: null, ledger: null, txIndex: null, memo: null, transaction: null, signature: null, bytes: null, mint: null, name: null, img: null, grade: null, insuredMicro: null, rarity: null, instantBuybackPct: 0, proof: null, proofSlot: null, hold: null, mirror: null, mirrorFailLedger: null, everMinted: 0, exit: null, sellTx: null, shipRef: null, refundId: null, createdAt: e.at, generatingAt: null, movedAt: e.at });
      s.orderByInvoice.set(d.invoice, d.id);
      return;
    }
    case "card_paid": {
      const d = e.data;
      s.seenTx.add(d.txHash);
      const c = s.cards.get(d.order);
      if (c) {
        c.status = "paid";
        c.txHash = d.txHash;
        c.ledger = d.ledger;
        c.txIndex = d.txIndex;
      }
      return;
    }
    case "card_generating": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "paid") {
        c.status = "generating";
        c.generatingAt = e.at;
      }
      return;
    }
    case "card_generated": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "generating") {
        c.status = "generated";
        c.memo = e.data.memo;
        c.transaction = e.data.transaction;
      }
      return;
    }
    case "card_signed": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "generated") {
        c.status = "signed";
        c.signature = e.data.signature;
        c.bytes = e.data.bytes;
      }
      return;
    }
    case "card_source_paid": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "signed") {
        c.status = "source_paid";
        c.sourcePaid = true;
        if (c.funding === "float") accrue(s, { id: `pack:${c.id}`, order: c.id, dir: "to_custody", amount: c.drops, usdMicro: BigInt(Math.round(c.usd * 1e6)).toString(), reason: "float_pack", createdAt: e.at });
      }
      return;
    }
    case "card_opened": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "source_paid") {
        c.status = "opened";
        c.mint = e.data.mint;
        c.name = e.data.name;
        c.img = e.data.img;
        c.grade = e.data.grade;
        c.insuredMicro = e.data.insuredMicro;
        c.rarity = e.data.rarity;
        c.instantBuybackPct = e.data.instantBuybackPct;
      }
      return;
    }
    case "card_held": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "opened") {
        c.status = "held";
        c.hold = "stashed";
        c.proof = e.data.proof;
        c.proofSlot = e.data.slot;
        c.proofAt = e.at;
        c.heldAt = e.at;
      }
      return;
    }
    case "card_review": {
      const c = s.cards.get(e.data.order);
      // Over is over: a late report can't reopen a card that was refunded, sold or shipped.
      if (c && c.status !== "refund_due" && c.status !== "refunded" && c.hold !== "sold" && c.hold !== "shipped") {
        c.status = "review";
        c.review = e.data.reason;
      }
      return;
    }
    case "card_resolved": {
      const c = s.cards.get(e.data.order);
      if (c && c.status === "review" && e.data.action === "restash" && c.exit) {
        // A sale that never reached the provider. The card goes to whoever asked to sell it, who may not be the first buyer.
        c.review = null;
        c.status = "held";
        c.hold = "stashed";
        c.address = c.exit.by;
        c.exit = null;
      } else if (c && c.status === "review" && e.data.action === "resume") {
        c.review = null;
        c.status = c.hold ? "held" : c.bytes ? "signed" : c.memo ? "generated" : "paid";
      }
      return;
    }
    case "card_refund_due": {
      const d = e.data;
      const c = s.cards.get(d.order);
      if (s.refunds.has(d.id)) return;
      if (c) {
        // This pack isn't being bought, so what it moved has to come back. USDC it swapped for and never spent goes back through Relay.
        const pack = s.accruals.get(`pack:${c.id}`);
        if (pack?.status === "owed") pack.status = "void";
        if (c.funding === "swap" && c.landedMicro && !c.sourcePaid) accrue(s, { id: `back:${c.id}`, order: c.id, dir: "to_treasury", amount: c.landedMicro, usdMicro: null, reason: "failed_pack", createdAt: e.at });
        c.status = "refund_due";
        c.refundId = d.id;
        c.review = null;
        // Refunded means it's over: there's nothing left to sell or ship.
        c.hold = null;
      }
      s.refunds.set(d.id, { id: d.id, to: d.to, drops: d.drops, reason: d.reason, order: d.order, sourceTag: null, status: "due", txHash: null, result: null, paymentTx: c?.txHash ?? null });
      return;
    }
    case "mirror_requested": {
      const c = s.cards.get(e.data.order);
      if (c?.hold === "stashed") {
        c.hold = "minting";
        c.takenBack = false;
        c.proof = e.data.proof;
        c.proofSlot = e.data.slot;
        c.proofAt = e.at;
      }
      return;
    }
    case "mirror_accepted": {
      const c = s.cards.get(e.data.order);
      if (c?.mirror && c.mirror.offerId === e.data.offerId) {
        c.mirror.accepted = true;
        c.mirror.acceptTx = e.data.txHash;
        if (c.hold === "offered") c.hold = "mirrored";
        // A wallet that took the offer while a take-back was on its way wins: the NFT is theirs now, and it's not ours to burn.
        if (c.exit?.kind === "back") {
          c.hold = "mirrored";
          c.exit = null;
          return;
        }
        // An accept that raced an exit's burn: the burn fails on the ledger, and the exit falls back to this state.
        if (c.exit?.from === "offered") c.exit.from = "mirrored";
      }
      return;
    }
    case "mirror_take_back_requested": {
      const c = s.cards.get(e.data.order);
      if (c?.hold === "offered" && c.mirror && !c.mirror.accepted) {
        c.exit = { kind: "back", by: e.data.address, drops: null, usdMicro: null, addressHash: null, from: "offered" };
        c.hold = "exit_burn";
      }
      return;
    }
    case "card_exit_requested": {
      const d = e.data;
      const c = s.cards.get(d.order);
      if (!c || (c.hold !== "stashed" && c.hold !== "offered" && c.hold !== "mirrored")) return;
      c.exit = { kind: d.kind, by: d.by, drops: d.drops, usdMicro: d.usdMicro, addressHash: d.addressHash, from: c.hold, ...(d.passthrough ? { passthrough: true } : {}) };
      c.hold = c.mirror ? "exit_burn" : d.kind === "sell" ? "exit_source" : "ship_queue";
      return;
    }
    case "card_sell_started": {
      const c = s.cards.get(e.data.order);
      if (c?.hold === "exit_source" && c.exit) c.exit.started = true;
      return;
    }
    case "card_sold_source": {
      const c = s.cards.get(e.data.order);
      if (c?.hold === "exit_source") {
        c.hold = "selling";
        if (c.exit?.passthrough) {
          // A re-read after a crash can come back as 0, when the card had already gone. What the player was quoted is the floor of what it paid.
          const gross = BigInt(e.data.usdMicro) > BigInt(c.exit.usdMicro ?? 0) ? e.data.usdMicro : (c.exit.usdMicro as string);
          c.exit.grossMicro = gross;
          accrue(s, { id: `sale:${c.id}`, order: c.id, dir: "to_treasury", amount: gross, usdMicro: null, reason: "sale", createdAt: e.at });
        }
      }
      return;
    }
    case "card_funding": {
      const c = s.cards.get(e.data.order);
      if (c?.status === "paid") {
        c.funding = e.data.via;
        if (e.data.via === "swap") c.status = "funding";
      }
      return;
    }
    case "relay_arrival": {
      const d = e.data;
      s.seenTx.add(d.txHash);
      s.relayArrivals.set(d.txHash, { txHash: d.txHash, ledger: d.ledger, from: d.from, drops: d.drops, memo: d.memo, swap: null });
      return;
    }
    case "swap_opened": {
      const d = e.data;
      s.swaps.set(d.id, { id: d.id, dir: d.dir, purpose: d.purpose, card: d.card, accruals: d.accruals, requestId: d.requestId, orderId: d.orderId, depository: d.depository, inAmount: d.inAmount, outMin: d.outMin, outExpected: d.outExpected, deadline: d.deadline, usdMicro: d.usdMicro, status: "quoted", signature: null, bytes: null, depositTx: null, landedAmount: null, landedProof: null, deadReason: null, openedAt: e.at, movedAt: e.at });
      for (const id of d.accruals) {
        const a = s.accruals.get(id);
        if (a) {
          a.status = "moving";
          a.swap = d.id;
        }
      }
      const c = d.purpose === "buy_first" && d.card ? s.cards.get(d.card) : null;
      if (c) c.fundingSwap = d.id;
      return;
    }
    case "swap_signed": {
      const x = s.swaps.get(e.data.id);
      if (x?.status === "quoted") {
        x.status = "signed";
        x.signature = e.data.signature;
        x.bytes = e.data.bytes;
        x.movedAt = e.at;
      }
      return;
    }
    case "swap_deposited": {
      const x = s.swaps.get(e.data.id);
      if (x?.status === "signed") {
        x.status = "deposited";
        x.depositTx = e.data.signature;
        x.movedAt = e.at;
      }
      return;
    }
    case "swap_landed": {
      const d = e.data;
      const x = s.swaps.get(d.id);
      if (x?.status !== "deposited") return;
      const proof = d.txHash ?? d.signature ?? null;
      if (proof) s.swapProofs.add(proof);
      const arrival = d.txHash ? s.relayArrivals.get(d.txHash) : null;
      if (arrival) arrival.swap = x.id;
      landSwap(s, x, d.amount, proof, e.at);
      return;
    }
    case "swap_refunded": {
      const d = e.data;
      const x = s.swaps.get(d.id);
      if (x?.status !== "deposited") return;
      const proof = d.txHash ?? d.signature ?? null;
      if (proof) s.swapProofs.add(proof);
      const arrival = d.txHash ? s.relayArrivals.get(d.txHash) : null;
      if (arrival) arrival.swap = x.id;
      x.landedAmount = d.amount;
      x.landedProof = proof;
      x.movedAt = e.at;
      releaseSwap(s, x, "refunded");
      return;
    }
    case "swap_dead": {
      const x = s.swaps.get(e.data.id);
      if (x && (x.status === "quoted" || x.status === "signed")) {
        x.deadReason = e.data.reason;
        x.movedAt = e.at;
        releaseSwap(s, x, "dead");
      }
      return;
    }
    case "swap_resolved": {
      const x = s.swaps.get(e.data.id);
      if (!x || x.status !== "deposited") return;
      if (e.data.action === "landed") landSwap(s, x, e.data.amount ?? x.outMin, null, e.at);
      else {
        x.deadReason = `released by ${e.data.by}`;
        x.movedAt = e.at;
        releaseSwap(s, x, "dead");
      }
      return;
    }
    case "card_shipped": {
      const c = s.cards.get(e.data.order);
      if (c?.hold === "ship_queue") {
        c.hold = "shipped";
        c.shipRef = e.data.ref;
      }
      return;
    }
  }
}

/** Lots a pull paid in `ledger` can land on, for one band, sorted by NFT id. Only the log and the ledger number decide. */
export function poolAt(s: RipState, price: NftPrice, band: number, ledger: number): LotState[] {
  const out: LotState[] = [];
  for (const l of s.lots.values()) {
    if (l.price !== price || l.band !== band || l.status !== "available") continue;
    if (l.addLedger === null || l.addLedger > ledger) continue;
    if (l.removeLedger !== null && l.removeLedger <= ledger) continue;
    out.push(l);
  }
  return out.sort((a, b) => (a.nftId < b.nftId ? -1 : a.nftId > b.nftId ? 1 : 0));
}

/** Orders holding a place on a pack: quoted and unpaid, or paid and not drawn. */
export const holdsFor = (s: RipState, price: NftPrice) => {
  let n = 0;
  for (const o of s.orders.values()) if (o.price === price && (o.status === "quoted" || o.status === "paid")) n++;
  return n;
};

/** NFTs ready in each band right now, ignoring holds. */
export const stockOf = (s: RipState, price: NftPrice, ledger: number) => BANDS.map((_, b) => poolAt(s, price, b, ledger).length);

/** Stock that can back a new order: excludes anything on its way out of the pool, anchored or not. */
export function sellableStock(s: RipState, price: NftPrice, ledger: number): number[] {
  const leaving = new Set<string>();
  for (const p of s.poolChanges.values()) if (!p.anchored) p.removes.forEach((id) => leaving.add(id));
  return BANDS.map((_, b) => poolAt(s, price, b, ledger).filter((l) => l.removeLedger === null && !leaving.has(l.lot)).length);
}

/** Drops owed from the treasury and not yet out of it. */
/**
 * XRP the treasury has promised. `relayCovers` is the passthrough switch: on, a sale out of its own USDC isn't the treasury's to cover until its
 * XRP lands. Off, nothing will swap that USDC across, so the treasury owes it like any other sale.
 */
export function treasuryOwed(s: RipState, relayCovers = false): bigint {
  let owed = 0n;
  // A stuck refund is still owed: the payment failed and moved nothing, and a person sends it again once its cause is fixed.
  for (const r of s.refunds.values()) if (r.status === "due" || r.status === "sent" || r.status === "stuck") owed += BigInt(r.drops);
  for (const o of s.orders.values()) if (o.pull === "selling" && o.sellDrops) owed += BigInt(o.sellDrops);
  // An XRP prize is owed from the moment it's struck, stashed or on its way.
  for (const o of s.orders.values()) if (o.prize?.token === XRP_TOKEN && (o.pull === "stashed" || o.pull === "redeeming")) owed += BigInt(o.prize.amount);
  for (const c of s.cards.values()) {
    if (!((c.hold === "exit_burn" || c.hold === "exit_source" || c.hold === "selling") && c.exit?.kind === "sell" && c.exit.drops)) continue;
    // A sale out of its own USDC isn't the treasury's to cover until its XRP has landed or its payout is on its way.
    if (relayCovers && c.exit.passthrough && !c.exit.funded && ![...s.intents.values()].some((i) => i.kind === "card_sellback" && i.ref === c.id)) continue;
    owed += BigInt(c.exit.drops);
  }
  return owed;
}

/**
 * USDC in custody that's already spoken for. A pack on its way to paying, a sale whose USDC its own payout may need, a swap of
 * custody's USDC that hasn't left yet. A finalized balance can't have spent any of these.
 */
export function usdcReserved(s: RipState, except?: string): bigint {
  let held = 0n;
  for (const c of s.cards.values()) {
    if (c.id === except) continue;
    if (c.funding && ["paid", "generating", "generated", "signed"].includes(c.status)) held += BigInt(Math.round(c.usd * 1e6));
    if (c.hold === "selling" && c.exit?.passthrough && c.exit.grossMicro && s.accruals.get(`sale:${c.id}`)?.status === "owed") held += BigInt(c.exit.grossMicro);
  }
  for (const x of s.swaps.values()) if (x.dir === "usdc_to_xrp" && (x.status === "quoted" || x.status === "signed")) held += BigInt(x.inAmount);
  return held;
}

/** USDC micros that swaps have moved in the last 24 hours. Everything that wasn't proven never to have left counts. */
export function swappedSince(s: RipState, sinceMs: number): bigint {
  let total = 0n;
  for (const x of s.swaps.values()) if (x.status !== "dead" && Date.parse(x.openedAt) > sinceMs) total += BigInt(x.usdMicro);
  return total;
}

/** Whole tokens struck and still held for players, stashed or on their way. A sold prize leaves the treasury's token behind, free. */
export function tokenOwed(s: RipState, token: string): bigint {
  let owed = 0n;
  for (const o of s.orders.values()) if (o.prize?.token === token && (o.pull === "stashed" || o.pull === "redeeming" || o.pull === "selling")) owed += BigInt(o.prize.amount);
  return owed;
}

/** The token spec a season committed to. Stashed prizes keep working from this, even if the switch is turned off later. */
export const seasonToken = (s: RipState, season: string, token: string): TokenSpec | null => s.seasons.get(season)?.tokens.find((t) => t.id === token) ?? null;
