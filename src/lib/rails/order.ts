import type { Award, PackRef, Quote } from "./types.ts";

/**
 * The order state machine. Every path a pull can take lives here so real rails replace the steps, not the flow:
 *
 *   quoted -> awaiting_signature -> payment_pending -> paid -> awarded -> revealed -> stashed | sold | shipping | claimed
 *
 * with declined and expired as the exits that charge nothing, and failed after a payment that did not land.
 * Rules this enforces: no award before payment is confirmed; an award is set once and can never change; revealing
 * cannot touch the award; and a settled order accepts nothing more.
 */
export type OrderState = "quoted" | "awaiting_signature" | "payment_pending" | "paid" | "awarded" | "revealed" | "stashed" | "sold" | "shipping" | "claimed" | "declined" | "expired" | "failed";

export type OrderEvent =
  | { readonly type: "request_signature" }
  | { readonly type: "signed"; readonly txRef: string }
  | { readonly type: "decline" }
  | { readonly type: "expire" }
  | { readonly type: "payment_confirmed" }
  | { readonly type: "payment_failed" }
  | { readonly type: "award"; readonly award: Award }
  | { readonly type: "reveal" }
  | { readonly type: "stash" }
  | { readonly type: "sell" }
  | { readonly type: "ship" }
  | { readonly type: "claim" };

export interface Order {
  readonly id: string;
  readonly pack: PackRef;
  readonly name: string;
  readonly price: number;
  readonly art: string;
  /** Link back to the pack page. */
  readonly back: string;
  readonly quote: Quote;
  readonly state: OrderState;
  readonly txRef: string | null;
  readonly award: Award | null;
}

export class IllegalTransition extends Error {
  constructor(state: OrderState, event: OrderEvent["type"]) {
    super(`${event} is not allowed from ${state}`);
    this.name = "IllegalTransition";
  }
}

const SIMPLE: Partial<Record<OrderState, Partial<Record<OrderEvent["type"], OrderState>>>> = {
  quoted: { request_signature: "awaiting_signature", expire: "expired" },
  awaiting_signature: { decline: "declined", expire: "expired" },
  payment_pending: { payment_confirmed: "paid", payment_failed: "failed" },
  awarded: { reveal: "revealed" },
  revealed: { stash: "stashed", sell: "sold" },
  stashed: { sell: "sold", ship: "shipping", claim: "claimed" },
};

export function transition(order: Order, event: OrderEvent): Order {
  if (event.type === "signed") {
    if (order.state !== "awaiting_signature") throw new IllegalTransition(order.state, event.type);
    return { ...order, state: "payment_pending", txRef: event.txRef };
  }
  if (event.type === "award") {
    if (order.state !== "paid" || order.award) throw new IllegalTransition(order.state, event.type);
    return { ...order, state: "awarded", award: event.award };
  }
  const next = SIMPLE[order.state]?.[event.type];
  if (!next) throw new IllegalTransition(order.state, event.type);
  return { ...order, state: next };
}

export function newOrder(input: { id: string; pack: PackRef; name: string; price: number; art: string; back: string; quote: Quote }): Order {
  return { ...input, state: "quoted", txRef: null, award: null };
}

/** XRP a checkout may ask for at most. Card packs carry 0.5% room for the swap into RLUSD; NFT packs are held in XRP. */
export function quoteFor(pack: PackRef, usd: number, xrpUsd: number): Quote {
  const raw = (usd / xrpUsd) * (pack.kind === "nft" ? 1 : 1.005);
  return { usd, xrpUsd, maxXrp: Math.ceil(raw * 100) / 100 };
}
