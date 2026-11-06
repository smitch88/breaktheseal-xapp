import type { Item } from "../catalog/types.ts";
import type { NftPrice } from "../../config/nft-packs.ts";

/** Which pack an order is for. */
export type PackRef = { readonly kind: "card"; readonly code: string } | { readonly kind: "nft"; readonly price: NftPrice };

export type TierName = "Common" | "Uncommon" | "Rare" | "Epic" | "Chase";

/**
 * What a pull produced. Decided before the opening stage runs and handed to it read-only: the bite only shows an award,
 * it never picks one. `provenance` says who decided: "demo" runs in the browser and moves no money;
 * "server" is the only value real rails may produce.
 */
export interface Award {
  readonly kind: "card" | "nft";
  readonly provenance: "demo" | "server";
  readonly tier: TierName;
  readonly name: string;
  readonly img: string;
  /** Listed value, or floor in USD for an NFT. */
  readonly value: number;
  /** Grade, or "<floor> XRP floor". */
  readonly grade: string;
  /** Sell-back quote in USD. */
  readonly sell: number;
  readonly sourceId: string;
  /** Set when the prize is a token rather than an NFT or a card: XRP or SEAL. */
  readonly token?: string;
}

export interface Quote {
  readonly usd: number;
  /** Most the wallet can be asked for, in XRP. */
  readonly maxXrp: number;
  readonly xrpUsd: number;
}

export type PaymentRequest = { readonly orderId: string; readonly quote: Quote; readonly destinationLabel: string };
export type PaymentResult = { readonly status: "signed"; readonly txRef: string } | { readonly status: "declined" };
export type PaymentStatus = "pending" | "confirmed" | "failed";

/**
 * The XRPL leg. MockXamanAdapter is the only implementation in phase one and touches no network. A real adapter wraps
 * Xaman's sign-in and payment payloads and the ledger, and every method must be idempotent on its order or exit id.
 */
export interface ChainAdapter {
  readonly kind: "mock-xaman" | "xaman";
  connect(): Promise<{ address: string; label: string }>;
  requestPayment(request: PaymentRequest): Promise<PaymentResult>;
  paymentStatus(input: { orderId: string; txRef: string }): Promise<PaymentStatus>;
  /** Pay a sell-back out to the holder. */
  payout(input: { exitId: string; usd: number }): Promise<{ txRef: string }>;
  /** Offer a stashed NFT to the holder's wallet. */
  offerNft(input: { exitId: string; sourceId: string }): Promise<{ offerRef: string }>;
}

/** Decides the outcome of a pull. Real mode must be ServerOutcomeSource: the browser only ever receives the answer. */
export interface OutcomeSource {
  readonly mode: "demo" | "server";
  draw(input: { orderId: string; pack: PackRef }): Promise<Award>;
}

export type CardPool = readonly Item[];
