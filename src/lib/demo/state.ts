import { newOrder, transition, type Order, type OrderEvent } from "../rails/order.ts";
import type { Award } from "../rails/types.ts";
import { usd2 } from "../format.ts";

/** Everything the demo remembers, per browser. It holds examples, never real items, and nothing here reaches a server. */
export type HoldingStatus = "Stashed" | "Shipping";

export interface Holding {
  readonly id: string;
  readonly award: Award;
  readonly status: HoldingStatus;
}

export interface HistoryRow {
  readonly label: string;
  readonly amount: string;
}

export type WalletName = "demo" | "xaman" | "joey";

export interface DemoState {
  readonly signed: boolean;
  readonly address: string | null;
  /** "demo" is the labeled demo wallet. "xaman" and "joey" mean the server verified a real sign-in. */
  readonly wallet: WalletName | null;
  readonly holdings: readonly Holding[];
  readonly history: readonly HistoryRow[];
  readonly orders: Readonly<Record<string, Order>>;
}

export const EMPTY: DemoState = { signed: false, address: null, wallet: null, holdings: [], history: [], orders: {} };

export type DemoAction =
  | { readonly type: "connect"; readonly address: string; readonly wallet: WalletName }
  | { readonly type: "signout" }
  | { readonly type: "disconnect" }
  | { readonly type: "order_new"; readonly order: Parameters<typeof newOrder>[0] }
  | { readonly type: "order_event"; readonly id: string; readonly event: OrderEvent }
  | { readonly type: "stash"; readonly orderId: string }
  | { readonly type: "sell_order"; readonly orderId: string }
  | { readonly type: "sell"; readonly holdingId: string }
  | { readonly type: "ship"; readonly holdingId: string }
  | { readonly type: "claim"; readonly holdingId: string };

const short = (s: string) => s.slice(0, 40);

/** Pure. An action that doesn't apply returns the state unchanged, so a double tap can't sell or stash twice. */
export function reduce(s: DemoState, a: DemoAction): DemoState {
  switch (a.type) {
    case "connect":
      return { ...s, signed: true, address: a.address, wallet: a.wallet };
    case "signout":
      return { ...s, signed: false, address: null, wallet: null };
    case "disconnect":
      return EMPTY;
    case "order_new":
      return { ...s, orders: { ...s.orders, [a.order.id]: newOrder(a.order) } };
    case "order_event": {
      const order = s.orders[a.id];
      if (!order) return s;
      let next: Order;
      try {
        next = transition(order, a.event);
      } catch {
        return s;
      }
      const history = a.event.type === "reveal" ? [{ label: `Demo pull: ${order.name}`, amount: "Nothing paid" }, ...s.history] : s.history;
      return { ...s, history, orders: { ...s.orders, [a.id]: next } };
    }
    case "stash": {
      const order = s.orders[a.orderId];
      if (!order?.award || order.state !== "revealed") return s;
      const holding: Holding = { id: order.id, award: order.award, status: "Stashed" };
      return { ...s, holdings: [holding, ...s.holdings], orders: { ...s.orders, [order.id]: transition(order, { type: "stash" }) } };
    }
    case "sell_order": {
      const order = s.orders[a.orderId];
      if (!order?.award || order.state !== "revealed") return s;
      return { ...s, history: [{ label: `Demo sale: ${short(order.award.name)}`, amount: `${usd2(order.award.sell)} example` }, ...s.history], orders: { ...s.orders, [order.id]: transition(order, { type: "sell" }) } };
    }
    case "sell": {
      const h = s.holdings.find((x) => x.id === a.holdingId);
      if (!h || h.status !== "Stashed") return s;
      return { ...s, holdings: s.holdings.filter((x) => x !== h), history: [{ label: `Demo sale: ${short(h.award.name)}`, amount: `${usd2(h.award.sell)} example` }, ...s.history] };
    }
    case "ship":
      return { ...s, holdings: s.holdings.map((x) => (x.id === a.holdingId && x.status === "Stashed" && x.award.kind === "card" ? { ...x, status: "Shipping" as const } : x)) };
    case "claim": {
      const h = s.holdings.find((x) => x.id === a.holdingId);
      if (!h || h.status !== "Stashed" || h.award.kind !== "nft") return s;
      return { ...s, holdings: s.holdings.filter((x) => x !== h), history: [{ label: `Demo claim: ${short(h.award.name)}`, amount: "Nothing moved" }, ...s.history] };
    }
  }
}

/** Anything unreadable from storage starts clean rather than crashing a page. */
export function revive(raw: string | null): DemoState {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<DemoState>;
    if (typeof v !== "object" || v === null) return EMPTY;
    return {
      signed: v.signed === true,
      address: typeof v.address === "string" ? v.address : null,
      wallet: v.wallet === "demo" || v.wallet === "xaman" || v.wallet === "joey" ? v.wallet : null,
      holdings: Array.isArray(v.holdings) ? v.holdings : [],
      history: Array.isArray(v.history) ? v.history : [],
      orders: v.orders && typeof v.orders === "object" ? v.orders : {},
    };
  } catch {
    return EMPTY;
  }
}
