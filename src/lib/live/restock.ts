import type { RailsMode, RipConfig } from "./client.ts";

/** The one thing a player hears about a pack that can't be bought. It never says why. */
export const RESTOCK_LINE = "Restocking. Check back soon.";

/** How often the shelf looks. A page about one pack looks sooner, and every look on a page is one shared read. */
export const SHELF_LOOK_MS = 60_000;
/** How long a refused checkout stays closed before Pay comes back, for a pack with no shelf reading to reopen it. */
export const REFUSED_HOLD_MS = 30_000;

export type PackAvailability = "checking" | "open" | "restocking";

/** The server's word on one NFT pack. Demo mode has nothing to close, and with no answer yet we don't guess. */
export function packAvailability(mode: RailsMode, config: Pick<RipConfig, "tiers"> | null, price: number): PackAvailability {
  if (mode === "demo") return "open";
  if (!config) return "checking";
  return config.tiers.find((t) => t.price === price)?.open ? "open" : "restocking";
}

/** Nothing on the shelf can be bought. The home hero only says so then: it shows every pack at once. */
export const shelfRestocking = (mode: RailsMode, config: Pick<RipConfig, "tiers"> | null, prices: readonly number[]) => prices.length > 0 && prices.every((p) => packAvailability(mode, config, p) === "restocking");

/** Refusals that mean the pack itself is closed, as opposed to this wallet or this try. All of them read the same to a player. */
const PACK_CLOSED = new Set(["restocking", "not_open", "season_full", "no_rate", "rate_moved", "prize_paused"]);

export type OrderRefusal = { readonly kind: "restocking" } | { readonly kind: "problem"; readonly text: string };

/** What a refused checkout shows. A 403 not_open is the launch allowlist turning away a wallet, and the pack isn't closed for that. */
export function readRefusal(a: { readonly status: number; readonly body: { readonly error?: string; readonly code?: string } }): OrderRefusal {
  if (a.status === 401) return { kind: "problem", text: "Connect your wallet again to keep going." };
  if (a.status === 409 && a.body.code && PACK_CLOSED.has(a.body.code)) return { kind: "restocking" };
  return { kind: "problem", text: a.body.error ?? "That didn't work. Nothing was charged." };
}

export type CheckoutView = "checking" | "pay" | "restocking";

/**
 * What checkout shows. An order this wallet already holds always gets to pay, whatever the shelf says: its place is held, and
 * Pay hands the same order back. A refusal outranks an order we only remember, since the server just said it's gone.
 */
export function checkoutView(s: { readonly availability: PackAvailability; readonly refused: boolean; readonly showing: boolean; readonly held: boolean }): CheckoutView {
  if (s.showing) return "pay";
  if (s.refused) return "restocking";
  if (s.held) return "pay";
  if (s.availability === "restocking") return "restocking";
  return s.availability === "checking" ? "checking" : "pay";
}

export interface OpenCheckouts {
  readonly nft: readonly number[];
  readonly cards: readonly string[];
  /** Multi orders this wallet can still pay. Absent when there are none. */
  readonly bundles?: readonly { readonly id: string; readonly qty: number; readonly price?: number; readonly code?: string }[];
}

export const holdsCheckout = (open: OpenCheckouts | null, pack: { readonly kind: "nft"; readonly price: number } | { readonly kind: "card"; readonly code: string }) => (open ? (pack.kind === "nft" ? open.nft.includes(pack.price) || !!open.bundles?.some((b) => b.price === pack.price) : open.cards.includes(pack.code) || !!open.bundles?.some((b) => b.code === pack.code)) : false);
