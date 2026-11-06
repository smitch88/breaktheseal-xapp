import type { poolView, publicBundle, publicCard, publicOrder, tierView } from "../rip/views.ts";
import { nftTitle } from "../nft/view.ts";
import { XRP_PRIZE_ART } from "../prize-art.ts";
import type { Award } from "../rails/types.ts";
import type { TierName } from "../rails/types.ts";

/** What real-rails pages get from the API. Types only: nothing here can reach a key. */
export type RailsMode = "demo" | "testnet" | "mainnet";
export type LiveOrder = ReturnType<typeof publicOrder>;
export type LivePool = NonNullable<ReturnType<typeof poolView>>;
export type LiveCardBase = ReturnType<typeof publicCard>;
export type LiveRefund = { reason: string; status: string; txHash: string | null } | null;
export type LiveCard = LiveCardBase & { refund?: LiveRefund };
export type TierStatus = ReturnType<typeof tierView>;
export type LiveBundle = ReturnType<typeof publicBundle>;
export interface RipConfig {
  readonly mode: RailsMode;
  readonly treasury?: string;
  readonly vault?: string;
  readonly cardsOn?: boolean;
  readonly tiers: readonly TierStatus[];
  /** Only with SEAL_MULTI_QTY on: the env's caps, and the most each NFT pack can take in one order right now. */
  readonly multi?: { readonly max: number; readonly cardMax: number; readonly room: Readonly<Record<string, number>> };
}
export interface WalletLink {
  readonly uuid: string;
  readonly open: string;
  readonly qr: string;
  readonly ws: string;
  /** Xaman says it sent this request to the player's phone by itself. */
  readonly pushed?: boolean;
}

/** Rip again is redeem, then a normal checkout: packs are paid from the wallet, so a prize never pays for a pack directly. */
export const ripAgainHref = (price: number) => `/checkout?nft=${price}`;

export const LIVE_NFT = "rip_";
export const LIVE_CARD = "card_";
/** A real multi order. Its own pages show all of it, and each thing in it keeps the page it would have alone. */
export const LIVE_MULTI = "multi_";
/** A demo multi order, on this device: `dm_<id>_<qty>`. */
export const DEMO_MULTI = "dm_";

export const multiApi = (id: string) => `/api/rip/bundles/${encodeURIComponent(id)}`;

export type LiveRef = { readonly kind: "nft" | "card"; readonly id: string; readonly api: string };

/** `rip_<id>` is a real NFT pull and `card_<id>` a real card pull. Anything else is a demo order on this device. */
export function parseLiveId(raw: string): LiveRef | null {
  if (raw.startsWith(LIVE_NFT)) return { kind: "nft", id: raw.slice(LIVE_NFT.length), api: `/api/rip/orders/${encodeURIComponent(raw.slice(LIVE_NFT.length))}` };
  if (raw.startsWith(LIVE_CARD)) return { kind: "card", id: raw.slice(LIVE_CARD.length), api: `/api/rip/cards/${encodeURIComponent(raw.slice(LIVE_CARD.length))}` };
  return null;
}

const explorerBase = (mode: RailsMode) => (mode === "mainnet" ? "https://livenet.xrpl.org" : "https://testnet.xrpl.org");
export const txUrl = (mode: RailsMode, hash: string) => `${explorerBase(mode)}/transactions/${hash}`;
export const nftUrl = (mode: RailsMode, id: string) => `${explorerBase(mode)}/nft/${id}`;
export const accountUrl = (mode: RailsMode, a: string) => `${explorerBase(mode)}/accounts/${a}`;

/** The label a pull screen carries, so no one mistakes play XRP for the real thing. Empty on mainnet. */
export const networkLabel = (mode: RailsMode) => (mode === "testnet" ? "TESTNET" : "");
export const xrpText = (xrp: number) => (Number.isInteger(xrp) ? String(xrp) : xrp.toFixed(xrp >= 100 ? 2 : Math.min(6, Math.max(2, String(xrp).split(".")[1]?.length ?? 2))));
/** For a button: two decimals at most. The sell sheet shows the exact figure. */
export const xrpShort = (xrp: number) => (Number.isInteger(xrp) ? String(xrp) : xrp.toFixed(2));
/** For a confirm sheet: exact to four decimals, never fewer than two. The ledger amount is still the one paid. */
export const xrpSheet = (xrp: number) => (Number.isInteger(xrp) ? String(xrp) : xrp.toFixed(4).replace(/0{1,2}$/, ""));
export const dropsToXrp = (drops: string) => Number(drops) / 1e6;
export const verifyHref = (season: string, index: number) => `/fair#pull-${season}-${index}`;

/** A real NFT pull as the stage and the reveal show it. The mark in XRP is the figure; dollars are an estimate. */
export function nftAward(o: Omit<LiveOrder, "refund">, xrpUsd: number): Award | null {
  if (o.prize && o.tier) {
    return {
      kind: "nft",
      provenance: "server",
      tier: o.tier as TierName,
      name: o.prize.name,
      img: o.prize.token === "XRP" ? XRP_PRIZE_ART : "/assets/prize-seal.svg",
      value: o.prize.valueXrp * xrpUsd,
      grade: `about ${xrpText(o.prize.valueXrp)} XRP`,
      sell: 0,
      sourceId: o.id,
      token: o.prize.token,
    };
  }
  if (!o.nft || !o.tier) return null;
  return {
    kind: "nft",
    provenance: "server",
    tier: o.tier as TierName,
    name: nftTitle(o.nft.collection, o.nft.name),
    img: o.nft.img,
    value: o.nft.markXrp * xrpUsd,
    grade: `${xrpText(o.nft.markXrp)} XRP`,
    sell: (o.sellXrp ?? 0) * xrpUsd,
    sourceId: o.nft.id,
  };
}

export const CARD_TIERS: Readonly<Record<string, TierName>> = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", chase: "Chase" };

export function cardAward(c: LiveCard, sellUsd = 0): Award | null {
  if (!c.card) return null;
  return {
    kind: "card",
    provenance: "server",
    tier: CARD_TIERS[String(c.card.rarity).toLowerCase()] ?? "Common",
    name: String(c.card.name),
    img: String(c.card.img),
    value: c.card.insuredUsd,
    grade: String(c.card.grade),
    sell: sellUsd,
    sourceId: c.card.mint,
  };
}

/** What a pull's state reads as on a player's page. Stashing moves nothing, so stashed is the resting state. */
export function nftStatusLabel(o: Pick<LiveOrder, "status" | "pull"> & { readonly prize?: { readonly owed?: boolean } | null }): string {
  if (o.status === "refund_due") return "Refund on its way";
  if (o.status === "refunded") return "Refunded";
  if (o.status === "paid") return "Waiting on the ledger";
  if (o.pull === "redeeming" && o.prize?.owed) return "Owed to you";
  switch (o.pull) {
    case "selling":
      return "Selling";
    case "sold":
      return "Sold";
    case "offering":
      return "Making your offer";
    case "offered":
      return "Waiting for you to accept";
    case "cancelling":
      return "Taking back the offer";
    case "claimed":
      return "In your wallet";
    case "redeeming":
      return "Redeeming";
    case "redeemed":
      return "In your wallet";
    default:
      return "In your stash";
  }
}

export function cardStatusLabel(c: Pick<LiveCard, "status" | "hold" | "exit">): string {
  if (c.status === "review") return "Checking";
  if (c.status === "refund_due") return "Refund on its way";
  if (c.status === "refunded") return "Refunded";
  if (c.status !== "held") return "Opening";
  switch (c.hold) {
    case "minting":
      return "Making your NFT";
    case "offered":
      return "Waiting for you to accept";
    case "mirrored":
      return "In your wallet";
    case "exit_burn":
      return c.exit?.kind === "ship" ? "Shipping" : c.exit?.kind === "back" ? "Taking back the offer" : "Selling";
    case "exit_source":
    case "selling":
      return "Selling";
    case "sold":
      return "Sold";
    case "ship_queue":
    case "shipped":
      return "Shipping";
    default:
      return "In your stash";
  }
}

/** A prize won while our wallet was short. It's a debt, it isn't going anywhere, and the player doesn't have to do a thing. */
export const owedPrizeText = (name: string) => `You won ${name}, and it's owed to you. Our wallet is short right now, so we'll send it to your wallet as soon as we top up. You don't need to do anything.`;

export const REFUND_REASONS: Readonly<Record<string, string>> = {
  wrong_amount: "That payment wasn't the exact amount, so it's going back to your wallet, whole.",
  wrong_wallet: "That payment came from a different wallet than this order, so it's going back, whole.",
  late: "That payment landed after the order ended, so it's going back to your wallet, whole.",
  already_paid: "This order was already paid. The extra payment is going back to your wallet, whole.",
  no_order: "That payment didn't match any order, so it's going back to your wallet, whole.",
  band_empty: "We couldn't deliver this pull, so your XRP is going back to your wallet, whole.",
  slot_empty: "Your pull landed on an NFT someone already pulled, in a band with no XRP prize to pay instead, so your XRP is going back to your wallet, whole.",
  // Only an older pull can show this: a short wallet now strikes the prize as owed.
  machine_changed: "That pack closed before it could open, so your XRP is going back to your wallet, whole.",
  relay_timeout: "This pack took too long to open, so your XRP is going back to your wallet, whole.",
  relay_unavailable: "This pack couldn't open just now, so your XRP is going back to your wallet, whole.",
  relay_refunded: "This pack couldn't open just now, so your XRP is going back to your wallet, whole.",
  relay_partial: "This pack couldn't open just now, so your XRP is going back to your wallet, whole.",
  relay_cap: "This pack couldn't open just now, so your XRP is going back to your wallet, whole.",
  rate_moved: "XRP moved too far while this pack was opening, so your XRP is going back to your wallet, whole.",
  float_short: "We couldn't cover this prize just now, so your XRP is going back to your wallet, whole.",
  source_refused: "The pack couldn't be bought right now, so your XRP is going back to your wallet, whole.",
  source_payment_invalid: "The pack couldn't be bought right now, so your XRP is going back to your wallet, whole.",
  source_unknown: "The pack couldn't be bought right now, so your XRP is going back to your wallet, whole.",
  source_failed: "The pack couldn't be bought right now, so your XRP is going back to your wallet, whole.",
  source_expired: "The pack couldn't be bought right now, so your XRP is going back to your wallet, whole.",
  operator_refund: "Your XRP is going back to your wallet, whole.",
};

export interface ApiAnswer<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T & { error?: string; code?: string };
}

/**
 * What a checkout does after a look, while the order isn't paid. A wrong payment comes back and leaves the order open, so a
 * refund is told once: repeating it would close the wallet sheet the moment the player tries again.
 */
export function afterLook(status: string, refundReason: string | null | undefined, told: ReadonlySet<string>): "refund" | "ended" | "wait" {
  if (refundReason && !told.has(refundReason)) return "refund";
  return status === "expired" ? "ended" : "wait";
}

/**
 * Whether a pull's page should say its XRP is coming back. A wrong or extra payment can be refunded while the order itself
 * goes on to be paid and drawn: that pull is real, and its stage still has to play.
 */
export function pullComesBack(o: Pick<LiveOrder, "status" | "refund">): boolean {
  if (o.status === "paid" || o.status === "drawn") return false;
  return !!o.refund || o.status === "refund_due" || o.status === "refunded";
}

export interface LiveHoldings {
  readonly nfts: readonly LiveOrder[];
  readonly cards: readonly LiveCard[];
  readonly loaded: boolean;
}

/** A failed poll keeps what's on screen, so a blip can't make someone's items vanish. A 401 means they're signed out. */
export function nextHoldings(prev: LiveHoldings, a: ApiAnswer<{ orders: LiveOrder[] }>, b: ApiAnswer<{ cards: LiveCard[] }>): LiveHoldings {
  const pick = <T,>(ok: boolean, status: number, fresh: () => readonly T[], old: readonly T[]) => (ok ? fresh() : status === 401 ? [] : old);
  return { nfts: pick(a.ok, a.status, () => a.body.orders, prev.nfts), cards: pick(b.ok, b.status, () => b.body.cards, prev.cards), loaded: true };
}

export async function api<T>(url: string, body?: unknown): Promise<ApiAnswer<T>> {
  const res = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { ok: res.ok, status: res.status, body: parsed };
}
