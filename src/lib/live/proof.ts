import { allowedImage, vaultName } from "../catalog/parse.ts";
import type { Award } from "../rails/types.ts";
import { accountUrl, nftUrl, txUrl, verifyHref, xrpText, type LiveCard, type LiveOrder, type RailsMode } from "./client.ts";

/** Where a player can check a prize for themselves. Every link is a real page for this network, or it isn't listed. */
export interface ProofRow {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  readonly href: string;
}

const isMint = (v: unknown): v is string => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

/** xrp.cafe lists mainnet NFTs only. */
export const marketUrl = (mode: RailsMode, id: string) => (mode === "mainnet" ? `https://xrp.cafe/nft/${id}` : null);
/** A card's on-chain record on Solana: the asset itself and who holds it. The vault's own site is never linked. */
export const cardRecordUrl = (mint: string) => `https://solscan.io/account/${encodeURIComponent(mint)}`;

/** The grader's own cert page, for a grader with one a number can link to. Others show the number alone. */
export function certUrl(grader: string | null | undefined, cert: string | null | undefined): string | null {
  if (!grader || !cert || !/^[0-9A-Za-z-]{1,30}$/.test(cert)) return null;
  const who = grader.trim().toUpperCase();
  if (who === "PSA") return `https://www.psacard.com/cert/${cert}`;
  if (who === "CGC") return `https://www.cgccards.com/certlookup/${cert}/`;
  return null;
}

export interface CardDetails {
  readonly name: string | null;
  readonly category: string | null;
  readonly year: number | null;
  readonly set: string | null;
  readonly number: string | null;
  readonly grader: string | null;
  readonly grade: string | null;
  readonly cert: string | null;
  readonly language: string | null;
  readonly vault: string | null;
  readonly front: string | null;
  readonly back: string | null;
  readonly holder: string | null;
}

const text = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
};

/** One card out of Collector Crypt's marketplace answer, and only the card with this mint. Its answers are untrusted, so anything odd is left out. */
export function parseCardDetails(payload: unknown, mint: string): CardDetails | null {
  const rows = (payload as { filterNFtCard?: unknown } | null | undefined)?.filterNFtCard;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r) => (r as { nftAddress?: unknown } | null)?.nftAddress === mint) as Record<string, unknown> | undefined;
  if (!row) return null;
  // Originals sit on several hosts, some behind redirects to one-off addresses, so only the known host's are used. Every card
  // sampled also has resized copies on it: `frontM` is about 680 px wide, and `backS`, the only back copy, about 340.
  const copies = (row.images ?? {}) as Record<string, unknown>;
  const front = allowedImage(row.frontImage) ? row.frontImage : allowedImage(copies.frontM) ? copies.frontM : null;
  const backPick = allowedImage(row.backImage) ? row.backImage : allowedImage(copies.backS) ? copies.backS : null;
  const back = backPick !== front ? backPick : null;
  const holder = (row.owner as { wallet?: unknown } | null | undefined)?.wallet;
  return {
    name: text(row.itemName, 300),
    category: text(row.category, 60),
    year: typeof row.year === "number" && Number.isInteger(row.year) && row.year >= 1800 && row.year <= 2200 ? row.year : null,
    set: text(row.set),
    number: text(row.serial, 40),
    grader: text(row.gradingCompany, 40),
    grade: text(row.grade, 60),
    cert: text(row.gradingID, 60),
    language: text(row.language, 60),
    vault: vaultName(text(row.vault, 80)) ?? null,
    front,
    back,
    holder: isMint(holder) ? holder : null,
  };
}

/** The award as the card's own record tells it: on-chain names stop at 32 characters, and Collector Crypt keeps the whole one. */
export const withDetails = (award: Award, d: CardDetails | null): Award => (d ? { ...award, name: d.name ?? award.name, img: d.front ?? award.img } : award);

const tx = (mode: RailsMode, key: string, label: string, hash: string | null | undefined, text_ = "View transaction"): ProofRow[] => (hash ? [{ key, label, text: text_, href: txUrl(mode, hash) }] : []);

export function nftProofs(o: LiveOrder, mode: RailsMode): readonly ProofRow[] {
  const inWallet = o.pull === "claimed" && o.nft ? marketUrl(mode, o.nft.id) : null;
  return [
    ...(o.nft ? [{ key: "nft", label: "This NFT", text: "View on the explorer", href: nftUrl(mode, o.nft.id) }] : []),
    ...(inWallet ? [{ key: "market", label: "On the market", text: "View on xrp.cafe", href: inWallet }] : []),
    ...tx(mode, "pay", "Your payment", o.paymentTx),
    ...(o.index !== null ? [{ key: "draw", label: "The draw", text: "Verify this pull", href: verifyHref(o.season, o.index) }] : []),
    ...tx(mode, "accept", "Your accept", o.claimTx),
    ...tx(mode, "redeem", "Sent to your wallet", o.prize?.redeemTx),
    ...tx(mode, "sale", "Your sale", o.sellTx),
    ...tx(mode, "refund", "Your refund", (o.refund as { txHash?: string | null } | null)?.txHash),
  ];
}

export function cardProofs(c: LiveCard, mode: RailsMode): readonly ProofRow[] {
  const m = c.mirror;
  const market = m?.accepted ? marketUrl(mode, m.nftId) : null;
  return [
    ...(m ? [{ key: "nft", label: "This card's NFT", text: "View on the explorer", href: nftUrl(mode, m.nftId) }] : []),
    ...(market ? [{ key: "market", label: "On the market", text: "View on xrp.cafe", href: market }] : []),
    ...tx(mode, "pay", "Your payment", c.paymentTx),
    ...tx(mode, "mint", "NFT made", m?.mintTx),
    ...tx(mode, "accept", "Your accept", m?.acceptTx),
    ...tx(mode, "sale", "Your sale", c.sellTx),
    ...tx(mode, "refund", "Your refund", c.refund?.txHash),
  ];
}

/** What the reveal says, whatever size the screen: what you got and what happens next. */
/** A dust prize is money, not a collectible: it's a line in the redemptions list, never a tile or a count in the collection. */
export function splitDust<T extends { readonly award: { readonly token?: unknown }; readonly status: string }>(rows: readonly T[], waiting: string): { readonly lines: readonly T[]; readonly items: readonly T[] } {
  const isLine = (h: T) => !!h.award.token && h.status !== waiting;
  return { lines: rows.filter(isLine), items: rows.filter((h) => !isLine(h)) };
}

/** One step of a sale's money trail. No href means it hasn't happened yet. */
export interface TrailStep {
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  readonly text: string;
  readonly href: string | null;
}

/**
 * Everything public about a sold pull, in the order the money moved, then where it all is now. A step shows only when there's a
 * real page to open, except the payout, which shows while it's on its way. A testnet NFT has no Solana or Collector Crypt leg.
 */
export function soldTrail(input: {
  readonly nft: LiveOrder | null;
  readonly card: LiveCard | null;
  readonly mode: RailsMode;
  readonly treasury?: string | null;
  /** The signed-in owner's wallet. Anyone else viewing the page doesn't get this step. */
  readonly wallet?: string | null;
}): readonly TrailStep[] {
  const { nft: o, card: c, mode } = input;
  // Only a real classic address gets a link: anything else opens the explorer's "Invalid XRPL address" page.
  const account = (a: string | null | undefined) => (a && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a) ? a : null);
  const treasury = account(input.treasury);
  const wallet = account(input.wallet);
  const item = (key: string, label: string, detail: string | null, text: string, href: string | null): TrailStep => ({ key, label, detail, text, href });
  const onLedger = (key: string, label: string, detail: string | null, hash: string | null | undefined) => (hash ? [item(key, label, detail, "View transaction", txUrl(mode, hash))] : []);
  const hash = o?.sellTx ?? c?.sellTx ?? null;
  const paid = o ? o.sellXrp : c?.exit?.drops ? Number(c.exit.drops) / 1e6 : null;
  // Sold with others: the transaction is one payment for all of them, so say so, or its amount would read wrong.
  const together = o?.payout && o.payout.count > 1 && paid !== null ? `${xrpText(paid)} XRP, in one payment of ${xrpText(o.payout.totalXrp)} XRP for ${o.payout.count} items` : null;
  const payout = item("sale", hash ? "Paid out" : "Paying out", together ?? (paid !== null ? `${xrpText(paid)} XRP` : null), hash ? "View transaction" : "On its way", hash ? txUrl(mode, hash) : null);
  const ends = [
    ...(treasury ? [item("treasury", "Paid from", "Our public treasury", "View wallet", accountUrl(mode, treasury))] : []),
    ...(hash && wallet ? [item("wallet", "Your wallet now", null, "See your balance", accountUrl(mode, wallet))] : []),
  ];
  if (o) {
    return [
      ...onLedger("pay", "You paid", `${xrpText(o.xrp)} XRP`, o.paymentTx),
      ...(o.index !== null ? [item("draw", "The draw", null, "Verify this pull", verifyHref(o.season, o.index))] : []),
      ...onLedger("accept", "Accepted in your wallet", null, o.claimTx),
      payout,
      ...(o.nft ? [item("nft", "Where the NFT is now", null, "View its owner", nftUrl(mode, o.nft.id))] : []),
      ...ends,
    ];
  }
  if (!c) return [];
  return [
    ...onLedger("pay", "You paid", `${xrpText(c.xrp)} XRP`, c.paymentTx),
    ...(c.sourceTx ? [item("source", "The pack, bought on Solana", null, "View transaction", `https://solscan.io/tx/${encodeURIComponent(c.sourceTx)}`)] : []),
    ...onLedger("mint", "Its NFT made", null, c.mirror?.mintTx),
    ...onLedger("accept", "Accepted in your wallet", null, c.mirror?.acceptTx),
    payout,
    ...(c.source === "vault" && c.card?.mint ? [item("card", "Where the card is now", null, "View card", cardRecordUrl(c.card.mint))] : []),
    ...ends,
  ];
}

/**
 * The one short line under a reveal's title. The name is already in the title and in Details, and stash, ship and sell are the buttons, so it
 * only says where the prize is held. A demo says it's an example. Each one fits a 360 px phone on one line.
 */
export function revealNext(award: Pick<Award, "kind">, prize: { readonly token: string } | null | undefined, demo = false): string {
  if (demo) return "Demo: an example you don't own.";
  if (prize) return prize.token === "XRP" ? "Yours, fixed until you cash it out." : "Yours, at a fixed amount.";
  if (award.kind === "nft") return "Yours, held until you claim it.";
  return "Yours, held in a graded card vault.";
}
