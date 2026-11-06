import type { Award } from "../rails/types.ts";
import { TIER_NAMES } from "../tiers.ts";

/**
 * The arithmetic and the words of a multi order, away from any page. The server decides everything that matters: these only say what it decided.
 */
export const QTY_PRESETS = [1, 3, 5, 10, 20] as const;
/** Shown only up to the largest quantity the env allows, so a low cap doesn't show buttons that can never work. */
export const presetsFor = (cap: number): number[] => QTY_PRESETS.filter((n) => n <= Math.max(1, cap));
/**
 * Why the picker stops short of the env's cap, in plain words, or null when it doesn't. The server only says how many fit, not which
 * rule stopped it, so this names both rules it could be. The order route checks the same figure again.
 */
export function roomNote(max: number | null, cap: number): string | null {
  // At 0 the pack itself is closed, and the page says so where the buy button would be.
  if (max === null || max < 1 || max >= cap) return null;
  const fits = max === 1 ? "Only 1 pack fits in one order right now." : `Up to ${max} packs fit in one order right now.`;
  return `${fits} How many depends on the NFTs left in this pack and the XRP set aside to pay its prizes, so it goes back up as packs sell and restock.`;
}
export const clampQty = (qty: number, max: number): number => {
  const whole = Number.isFinite(qty) ? Math.floor(qty) : 1;
  return Math.max(1, Math.min(whole, Math.max(1, max)));
};
/** How many packs a checkout is for. An order already open keeps its size, whatever the room has fallen to: it can still be paid. */
export const checkoutQty = (s: { readonly made: number | null; readonly held: number | null; readonly on: boolean; readonly wanted: number; readonly max: number | null }): number => s.made ?? s.held ?? (s.on ? clampQty(s.wanted, s.max ?? 1) : 1);
/** A quantity in a link or a remembered page. Anything odd is 1, the responsible default. */
export const parseQty = (raw: string | null | undefined): number => (raw && /^[1-9][0-9]?$/.test(raw) ? Number(raw) : 1);

const RANK = new Map(TIER_NAMES.map((t, i) => [t, i]));
/** Rarest first. Within a tier the most valuable first, and the same two pulls always land in the same order. */
export function rarestFirst<T extends { readonly id: string; readonly award: Pick<Award, "tier" | "value"> }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (RANK.get(b.award.tier) ?? 0) - (RANK.get(a.award.tier) ?? 0) || b.award.value - a.award.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type ChildState = "waiting" | "ready" | "back" | "checking";
export interface Outcome {
  readonly total: number;
  readonly ready: number;
  readonly waiting: number;
  readonly back: number;
  readonly checking: number;
  readonly backXrp: number;
}

export function outcomeOf(children: readonly ChildState[], eachXrp: number): Outcome {
  const n = (s: ChildState) => children.filter((c) => c === s).length;
  return { total: children.length, ready: n("ready"), waiting: n("waiting"), back: n("back"), checking: n("checking"), backXrp: n("back") * eachXrp };
}

const packs = (n: number) => (n === 1 ? "1 pack" : `${n} packs`);
const xrpWords = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

/** A multi order's state in plain words. Null when everything simply came through, since the grid already says so. */
export function outcomeText(o: Outcome): string | null {
  const lines: string[] = [];
  if (o.waiting) lines.push(`${o.ready} of ${o.total} are ready and ${o.waiting} ${o.waiting === 1 ? "is" : "are"} on the way. You can leave this page: they keep going and they'll be in your collection.`);
  else if (o.back || o.checking) lines.push(`${o.ready} of ${o.total} came through.`);
  if (o.back) lines.push(`We couldn't deliver ${packs(o.back)}, so ${xrpWords(o.backXrp)} XRP is going back to your wallet, whole.`);
  if (o.checking) lines.push(`We're checking on ${packs(o.checking)}. Don't pay again: it's safe, and it stays in your collection while we sort it out.`);
  return lines.length ? lines.join(" ") : null;
}

/** What a payout's progress reads as, on any page that shows it. */
export type PayoutStatus = "due" | "sent" | "done" | "failed";
export function payoutText(status: PayoutStatus, totalXrp: number, count: number): string {
  const size = `${xrpWords(totalXrp)} XRP for ${count === 1 ? "1 item" : `${count} items`}`;
  if (status === "done") return `Paid: ${size}, in one payment to your wallet.`;
  if (status === "failed") return "Your wallet refused a payment, so what it covered is back in your stash, and nothing moved. Check your wallet's settings, then try again.";
  return `One payment of ${size} is on its way to your wallet. It takes a few seconds, and you can leave this page.`;
}

const xrpFig = (x: number) => `${Number.isInteger(x) ? x : x.toFixed(2)} XRP`;

/**
 * What one pull in a results grid is worth to sell back, or what it sends, from the server's own quote. Null once it has moved on, or
 * where there's no figure to show here: a token prize other than XRP is redeemed or sold from its own page.
 */
export function sellLine(o: { readonly pull: string | null; readonly sellXrp: number | null; readonly prize: { readonly token: string; readonly valueXrp: number } | null }): { label: string; value: string; line: string } | null {
  if (o.pull !== "stashed") return null;
  if (o.prize) return o.prize.token === "XRP" ? { label: "Cash out to your wallet", value: xrpFig(o.prize.valueXrp), line: `Cash out: ${xrpFig(o.prize.valueXrp)} to your wallet` } : null;
  return o.sellXrp !== null && o.sellXrp > 0 ? { label: "Sells back for", value: xrpFig(o.sellXrp), line: `Sells back for ${xrpFig(o.sellXrp)}` } : null;
}

type CashRow = { readonly pull: string | null; readonly sellXrp: number | null; readonly prize: { readonly token: string; readonly valueXrp: number } | null };

/**
 * What one Cash out pays for these pulls: each XRP prize still in the stash at its amount, and each NFT at its sell-back quote, in one payment.
 * Only what's in the stash counts. A token prize's price moves every ledger, so with one in the lot `priced` is false and only the sheet,
 * which asks the server, has the figure. Added in drops, so no float drift.
 */
export function cashOutTotal(rows: readonly CashRow[]): { xrp: number; count: number; priced: boolean } {
  let drops = 0;
  let count = 0;
  let priced = true;
  for (const o of rows) {
    if (o.pull !== "stashed") continue;
    count++;
    const each = o.prize ? (o.prize.token === "XRP" ? o.prize.valueXrp : null) : o.sellXrp !== null && o.sellXrp > 0 ? o.sellXrp : null;
    if (each === null) priced = false;
    else drops += Math.round(each * 1e6);
  }
  return { xrp: drops / 1e6, count, priced };
}

/** The bar's button: the total at two decimals when every figure is known, and plain words when the sheet has to price something first. */
export function cashOutLabel(t: { readonly xrp: number; readonly count: number; readonly priced: boolean }, all: boolean): string {
  const what = all ? "Cash out all" : `Cash out ${t.count}`;
  return t.priced && t.xrp > 0 ? `${what} · ${xrpFig(t.xrp)}` : what;
}

/** The sell-back quotes of NFTs still in the stash, added up. XRP prizes send rather than sell, so they aren't in it. Null with nothing to sell. */
export function sellTotal(rows: readonly { readonly pull: string | null; readonly sellXrp: number | null; readonly prize: unknown }[]): string | null {
  const sum = rows.reduce((a, o) => (o.pull === "stashed" && !o.prize && o.sellXrp !== null && o.sellXrp > 0 ? a + o.sellXrp : a), 0);
  const drops = Math.round(sum * 1e6);
  return drops > 0 ? xrpFig(drops / 1e6) : null;
}
