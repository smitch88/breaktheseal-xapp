import type { NftPrice } from "../../config/nft-packs.ts";
import type { EmptyBand, ItemOdds, PrizeRow } from "./draw.ts";
import type { PoolRead, TokenSpec } from "./tokens.ts";
import type { SellOffer } from "./vault-buy.ts";

/** XRP in drops, as a decimal string, because JSON has no bigint and a float would round real money. */
export type Drops = string;

/** One NFT in one pool. A lot is one stay in the pool: an NFT sold back comes back as a new lot. */
export interface Lot {
  readonly lot: string;
  readonly nftId: string;
  readonly price: NftPrice;
  readonly band: number;
  readonly collection: string;
  readonly name: string;
  readonly img: string;
  /** What we paid in drops. Internal, and part of the public log only as the basis of the sell-back mark. */
  readonly costDrops: Drops;
  /** The value sell-backs are quoted from. */
  readonly markDrops: Drops;
}

export type TxKind = "anchor" | "refund" | "sellback" | "claim_offer" | "claim_cancel" | "mirror_mint" | "mirror_burn" | "card_sellback" | "prize_redeem" | "payout" | "vault_buy" | "vault_buy_cancel" | "relay_deposit";

/** One item in one payout: an NFT or SEAL prize sold, or an XRP prize sent as it is. `drops` is what it adds to the payment. */
export interface PayoutItem {
  readonly order: string;
  readonly action: "sell" | "redeem";
  readonly drops: Drops;
}

/** The two pool reads a token prize was struck from, kept in the log so the strike replays. */
export interface StrikeReads {
  readonly now: PoolRead;
  readonly prior: PoolRead;
}

export type RipEventBody =
  /** The first event of every log. It ties the log to one network and one treasury, so a database can't be reused by accident. */
  | { readonly type: "log_genesis"; readonly data: { networkId: number; treasury: string; vault: string } }
  | { readonly type: "season_open"; readonly data: { season: string; price: NftPrice; priceDrops: Drops; bandBps: readonly number[]; commit: string; length: number; sellBps: number; usdAtOpen: number | null; drawVersion: string; prizeTable?: readonly PrizeRow[]; tokens?: readonly TokenSpec[]; emptyBand?: EmptyBand; nftOdds?: ItemOdds } }
  /** `v: 2` means `root` commits each lot's mark. Older events have no `v`, and their root commits only lots, NFTs and bands. */
  | { readonly type: "pool_change"; readonly data: { id: string; price: NftPrice; adds: readonly Lot[]; removes: readonly string[]; root: string; v?: 2 } }
  /** A sold-back NFT kept out of its pool until a person looks. Nothing moved: it's in the vault, or the reason says it isn't. */
  | { readonly type: "restock_hold"; readonly data: { lot: string; nftId: string; reason: string } }
  /**
   * The buyer's whole decision, logged before anything is signed, so a rerun or a second server sees it. Nothing here is paid until the ledger says so, and
   * `offeredDrops` is exactly what's paid: a sell offer's price is fixed by its index, and a buyer pays a broker match its whole buy offer.
   */
  | { readonly type: "restock_buy_planned"; readonly data: { id: string; nftId: string; price: NftPrice; band: number; slug: string; collection: string; name: string; img: string; route: "direct" | "broker"; offerIndex: string | null; broker: string | null; seller: string; listDrops: Drops; offeredDrops: Drops; markDrops: Drops; createdLedger: number } }
  | { readonly type: "restock_buy_cancel"; readonly data: { id: string } }
  | { readonly type: "restock_buy_filled"; readonly data: { id: string; ledger: number } }
  | { readonly type: "restock_buy_ended"; readonly data: { id: string; why: string } }
  /** The kill switch. Off stays off, across restarts and deploys, until a person turns it on. */
  | { readonly type: "restock_switch"; readonly data: { on: boolean; by: string; why: string | null } }
  | { readonly type: "order_created"; readonly data: { id: string; season: string; price: NftPrice; address: string; invoice: string; drops: Drops; lastLedger: number; createdLedger: number; unproven?: boolean } }
  /**
   * Several packs for one payment. The children are ordinary pulls from here on, each with its own seed, its own draw and its own page.
   * The invoice is the only thing anyone can pay: a child has no invoice of its own, so it can't be paid alone.
   * `unproven` is a hold on a launch's word alone, under the same limits as one pack's.
   */
  | { readonly type: "bundle_created"; readonly data: { id: string; season: string; price: NftPrice; address: string; invoice: string; each: Drops; drops: Drops; qty: number; children: readonly string[]; lastLedger: number; createdLedger: number; unproven?: boolean } }
  | { readonly type: "card_bundle_created"; readonly data: { id: string; code: string; name: string; usd: number; xrpUsd: number; address: string; invoice: string; each: Drops; drops: Drops; qty: number; children: readonly string[]; lastLedger: number; createdLedger: number; gateway: string; unproven?: boolean } }
  /** The one payment, in full. Its children's pull_paid or card_paid follow straight after, in order, with nothing between. */
  | { readonly type: "bundle_paid"; readonly data: { bundle: string; txHash: string; ledger: number; txIndex: number; address: string; drops: Drops } }
  | { readonly type: "order_expired"; readonly data: { id: string } }
  | { readonly type: "pull_paid"; readonly data: { order: string; season: string; index: number; txHash: string; ledger: number; txIndex: number; address: string; drops: Drops; entropyLedger: number } }
  | { readonly type: "payment_refund_due"; readonly data: { id: string; txHash: string; ledger: number; txIndex: number; from: string; drops: Drops; reason: string; order: string | null; sourceTag: number | null } }
  | { readonly type: "payment_ignored"; readonly data: { txHash: string; ledger: number; txIndex: number; from: string; reason: string } }
  | { readonly type: "pull_drawn"; readonly data: { order: string; season: string; index: number; seed: string; txHash: string; ledgerHash: string; entropyLedger: number; address: string; digest: string; band: number; poolSize: number; pick: number; lot: string; nftId: string } }
  /**
   * A pull that landed on a token prize instead of an NFT. `amount` is fixed from here on: drops for XRP, whole tokens otherwise.
   * `paidInXrp` is set when the roll said a token but its amount couldn't be set fairly: the row pays its value in XRP, and `code` says why.
   * `owed` is set when the treasury couldn't cover it at the draw: the win stands, and the XRP goes out as soon as the treasury has it.
   */
  | { readonly type: "pull_prize_drawn"; readonly data: { order: string; season: string; index: number; seed: string; txHash: string; ledgerHash: string; entropyLedger: number; address: string; digest: string; band: number; token: string; valueDrops: Drops; amount: string; reads: StrikeReads | null; paidInXrp?: { token: string; code: string }; owed?: true } }
  | { readonly type: "pull_refund_due"; readonly data: { id: string; order: string; seed: string; ledgerHash: string; digest: string; band: number; reason: string; to: string; drops: Drops } }
  | { readonly type: "redeem_requested"; readonly data: { order: string; address: string } }
  /** Back in the stash before anything moved: the wallet can't take it yet. */
  | { readonly type: "redeem_returned"; readonly data: { order: string; reason: string } }
  | { readonly type: "tx_intent"; readonly data: { id: string; kind: TxKind; ref: string; account: string; sequence: number; lastLedger: number; hash: string; tx: Readonly<Record<string, unknown>>; blob: string } }
  | { readonly type: "tx_final"; readonly data: { id: string; hash: string; result: string; ledger: number | null; offerId?: string; nftId?: string; stillHeld?: boolean } }
  | { readonly type: "sell_requested"; readonly data: { order: string; address: string; drops: Drops } }
  /** Several items paid out in one XRP payment, all or nothing, so a sale of twenty takes one of the treasury's transactions and not twenty. */
  | { readonly type: "payout_requested"; readonly data: { id: string; address: string; total: Drops; items: readonly PayoutItem[] } }
  | { readonly type: "claim_requested"; readonly data: { order: string; address: string } }
  | { readonly type: "claim_accepted"; readonly data: { order: string; txHash: string; ledger: number; offerId: string } }
  | { readonly type: "claim_cancel_requested"; readonly data: { order: string; address: string } }
  | { readonly type: "refund_retry"; readonly data: { id: string; by: string } }
  | { readonly type: "card_order_created"; readonly data: { id: string; code: string; name: string; usd: number; drops: Drops; xrpUsd: number; address: string; invoice: string; lastLedger: number; createdLedger: number; gateway: string; unproven?: boolean } }
  | { readonly type: "card_paid"; readonly data: { order: string; txHash: string; ledger: number; txIndex: number; address: string; drops: Drops } }
  /** Logged before the provider is asked for a pack, so a lost answer is seen as unknown and never buys a second one. */
  | { readonly type: "card_generating"; readonly data: { order: string } }
  | { readonly type: "card_generated"; readonly data: { order: string; memo: string; transaction: string } }
  /** The signed source payment, before it is sent. Resending these same bytes can't pay twice. */
  | { readonly type: "card_signed"; readonly data: { order: string; signature: string; bytes: string } }
  | { readonly type: "card_source_paid"; readonly data: { order: string; signature: string } }
  | { readonly type: "card_opened"; readonly data: { order: string; mint: string; name: string; img: string; grade: string; insuredMicro: string; rarity: string; instantBuybackPct: number } }
  /** The custody proof: the original is in custody at this slot. Nothing can be minted before this. */
  | { readonly type: "card_held"; readonly data: { order: string; mint: string; slot: number; proof: string } }
  | { readonly type: "card_review"; readonly data: { order: string; reason: string } }
  | { readonly type: "card_resolved"; readonly data: { order: string; by: string; action: "resume" | "refund" | "restash" } }
  | { readonly type: "card_refund_due"; readonly data: { id: string; order: string; to: string; drops: Drops; reason: string } }
  | { readonly type: "mirror_requested"; readonly data: { order: string; address: string; slot: number; proof: string } }
  | { readonly type: "mirror_accepted"; readonly data: { order: string; txHash: string; ledger: number; offerId: string } }
  /** The buyer takes back an open offer on a card's mirror. Its burn kills the offer, and the card goes back in the stash. */
  | { readonly type: "mirror_take_back_requested"; readonly data: { order: string; address: string } }
  | { readonly type: "card_exit_requested"; readonly data: { order: string; kind: "sell" | "ship"; by: string; drops: Drops | null; usdMicro: string | null; addressHash: string | null; shipTx?: string | null; shipLedger?: number | null; passthrough?: true } }
  /** Logged only after custody was read and the card was there. From here on, the card leaving means the sale landed. */
  | { readonly type: "card_sell_started"; readonly data: { order: string } }
  | { readonly type: "card_sold_source"; readonly data: { order: string; usdMicro: string; ref: string } }
  | { readonly type: "card_shipped"; readonly data: { order: string; by: string; ref: string } }
  | { readonly type: "scan_cursor"; readonly data: { account: string; ledger: number } }
  /** How a paid card's USDC is found: custody already holds it, or it swaps its own XRP first. */
  | { readonly type: "card_funding"; readonly data: { order: string; via: "float" | "swap" } }
  /** A payment into the treasury from Relay's solver. It's never a stray. It counts for a swap only once matched to one. */
  | { readonly type: "relay_arrival"; readonly data: { txHash: string; ledger: number; txIndex: number; from: string; drops: Drops; memo: string | null } }
  /** A checked quote, logged before anything is signed. `accruals` are the orders whose money this moves. */
  | { readonly type: "swap_opened"; readonly data: { id: string; dir: "xrp_to_usdc" | "usdc_to_xrp"; purpose: "buy_first" | "sell_first" | "refund_back" | "refill"; card: string | null; accruals: readonly string[]; requestId: string; orderId: string; depository: string; inAmount: string; outMin: string; outExpected: string; deadline: number; usdMicro: string } }
  /** The signed Solana deposit, before it is sent. Resending these same bytes can't spend twice. */
  | { readonly type: "swap_signed"; readonly data: { id: string; signature: string; bytes: string } }
  | { readonly type: "swap_deposited"; readonly data: { id: string; signature: string } }
  /** What actually arrived, proven on the ledger (`txHash`) or on Solana (`signature`). */
  | { readonly type: "swap_landed"; readonly data: { id: string; amount: string; txHash?: string; signature?: string } }
  /** Relay gave the input back, proven the same way. What it moved is free to move again. */
  | { readonly type: "swap_refunded"; readonly data: { id: string; amount: string; txHash?: string; signature?: string } }
  /** It can never land: never sent, failed, or expired. What it moved is free to move again. */
  | { readonly type: "swap_dead"; readonly data: { id: string; reason: string } }
  | { readonly type: "swap_resolved"; readonly data: { id: string; by: string; action: "landed" | "released"; amount?: string } };

export type RipEventType = RipEventBody["type"];

/** An event as stored. `hash` chains it to the one before, so the log can't be edited after the fact. */
export type RipEvent = RipEventBody & { readonly seq: number; readonly at: string; readonly prev: string; readonly hash: string };

export interface ChainTx {
  readonly hash: string;
  readonly ledger: number;
  readonly txIndex: number;
  readonly result: string;
  readonly tx: Readonly<Record<string, unknown>>;
  /** Exactly what the ledger delivered: a drops string, or an object for a token. Never read Amount, which partial payments fake. */
  readonly delivered: unknown;
  /** The NFTokenOffer this transaction created, if any. */
  readonly offerId: string | null;
  /** The NFT this transaction minted, if any. */
  readonly nftId?: string | null;
  /** NFTokenOffers this transaction actually removed. NFTokenCancelOffer succeeds even on an offer already gone. */
  readonly deletedOffers?: readonly string[];
}

/** `definite` is true only if a server holding every ledger in the range looked and the transaction isn't there. */
export type TxLookup = { readonly found: false; readonly definite: boolean } | { readonly found: true; readonly validated: boolean; readonly tx: ChainTx };

/** What the engine needs from a ledger. `rpcChain` is the real one; the tests run a small ledger with the same rules. */
export interface Chain {
  networkId(): Promise<number>;
  validatedLedger(): Promise<number>;
  ledgerHash(seq: number): Promise<string>;
  /** Validated transactions touching the account from `fromLedger` on, oldest first. */
  accountTx(account: string, fromLedger: number): Promise<readonly ChainTx[]>;
  tx(hash: string, range: { account: string; minLedger: number; maxLedger: number }): Promise<TxLookup>;
  /** Payments into an account's own price feed: best XRP/RLUSD bid and ask on the ledger, in USD per XRP. Null if there is no book. */
  xrpUsd?(): Promise<number | null>;
  submit(blob: string): Promise<{ engineResult: string }>;
  /** At a past ledger if one is given. Throws if the server can't answer for that ledger. */
  account(address: string, atLedger?: number): Promise<{ balance: Drops; sequence: number; ownerCount: number } | null>;
  /** Whether an offer is on the validated ledger. Read once per press, only for a player about to be asked to accept it. Throws if the server can't say. */
  offerOpen?(offerId: string): Promise<boolean>;
  /** At a past ledger if one is given. */
  accountNfts(address: string, atLedger?: number): Promise<readonly { nftId: string; issuer: string; taxon: number; flags: number; transferFee: number; uri: string | null }[]>;
  /** Every sell offer on one NFT, an old owner's included, as the ledger reports them. Only the vault's buyer reads this. */
  nftSellOffers?(nftId: string): Promise<readonly SellOffer[]>;
  /** Who holds an NFT and its URI. Throws if no server can say, which the buyer reads as "don't buy". */
  nftInfo?(nftId: string): Promise<{ owner: string | null; burned: boolean; uri: string | null }>;
  reserves(): Promise<{ base: Drops; inc: Drops }>;
  fee(): Promise<Drops>;
  /** An XRP/token AMM pool as it stood at a ledger. Null if there's no such pool. Throws if the server can't say. */
  ammPool?(spec: Pick<TokenSpec, "currency" | "issuer">, atLedger: number): Promise<PoolRead | null>;
  /** One account's trust line to a token's issuer, in millionths. Null if it has none. */
  trustLine?(account: string, spec: Pick<TokenSpec, "currency" | "issuer">): Promise<{ balanceMicro: string; limitMicro: string; frozen: boolean } | null>;
  /** What an issuer can do to its token. */
  issuerState?(issuer: string): Promise<{ globalFreeze: boolean; transferRate: number; clawback: boolean } | null>;
}

export type Role = "treasury" | "vault" | "minter";

/** Holds the keys. Signing is all it does; only the engine decides what gets signed, and only after logging its intent. */
export interface Signer {
  address(role: Role): string;
  sign(role: Role, tx: Readonly<Record<string, unknown>>): { blob: string; hash: string };
}
