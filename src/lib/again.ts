import type { PackRef } from "./rails/types.ts";
import { clampQty, parseQty } from "./live/multi.ts";

/**
 * Open another: back to the same pack's page, ready to buy again. Nothing here buys anything. The pack page still needs the player's tap,
 * and the wallet still needs their signature.
 */

/** A pack's own page: /nft/<price> for an NFT pack, /packs/<code> for a card pack. */
export const packHref = (pack: PackRef): string => (pack.kind === "nft" ? `/nft/${pack.price}` : `/packs/${encodeURIComponent(pack.code)}`);

/** Marks a pack page as reached from Open another: the buy area comes into view, and Back goes to Packs. */
export const AGAIN = "again";

/** Where Open another goes for a pull from this pack. With no pack known, the shelf. */
export const againHref = (pack: PackRef | null | undefined): string => (pack ? `${packHref(pack)}?${AGAIN}=1` : "/packs");

/** The pack a pull came from, out of what an order or a card says about itself. */
export function pullPack(o: { readonly price?: number | null; readonly code?: string | null } | null | undefined): PackRef | null {
  if (!o) return null;
  if (typeof o.price === "number" && o.price > 0) return { kind: "nft", price: o.price as Extract<PackRef, { kind: "nft" }>["price"] };
  if (typeof o.code === "string" && o.code) return { kind: "card", code: o.code };
  return null;
}

/** Whether a page's query says it was reached from Open another. */
export const cameAgain = (search: string): boolean => new URLSearchParams(search).get(AGAIN) === "1";

/** Back from a pack page reached by Open another goes to the shelf, not into the sale that came before it. */
export const shellBack = (search: string): "packs" | "history" => (cameAgain(search) ? "packs" : "history");

/** The quantity picker's remembered choice for one pack, on this device for this session. */
export const qtyKey = (pack: PackRef): string => `seal:qty:${pack.kind === "nft" ? `n${pack.price}` : pack.code}`;

/** A remembered choice, read back: anything odd is 1, and it never reaches past what the pack can take right now. */
export const keptQty = (raw: string | null | undefined, max: number | null): number => clampQty(parseQty(raw), max ?? 1);

/** The wallet whose terms consent this session already holds. */
export const TERMS_KEY = "seal:terms";

/**
 * Whether checkout can go straight to the wallet's request. Only inside Xaman, only from the pack page's Open (`go`), only for the signed-in
 * account that ticked the 18+ and terms box earlier this session, and only once. Anything else shows checkout as it always has.
 */
export function quickStart(s: { readonly go: boolean; readonly shell: boolean; readonly address: string | null; readonly agreedBy: string | null; readonly started: boolean }): boolean {
  return s.go && s.shell && !s.started && !!s.address && s.agreedBy === s.address;
}

/** Where a pack's buy button would be, when it can't be pressed. Each one gets plain words and a way back to the shelf. */
export type BuyState = "open" | "checking" | "held" | "restocking" | "soldout" | "unavailable" | "full";
export function buyState(s: { readonly availability: "open" | "checking" | "restocking"; readonly held: boolean; readonly soldOut?: boolean; readonly disabledLabel?: string; readonly roomOn: boolean; readonly roomMax: number | null }): BuyState {
  if (s.availability === "restocking") return s.held ? "held" : "restocking";
  if (s.soldOut) return "soldout";
  if (s.disabledLabel) return "unavailable";
  if (s.availability === "checking") return "checking";
  if (s.roomOn && s.roomMax !== null && s.roomMax < 1) return "full";
  return "open";
}

/** This session's storage, which can be missing or refuse (a private window, a locked-down webview): what it keeps is only a convenience. */
export const session = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      /* nothing to keep */
    }
  },
};
