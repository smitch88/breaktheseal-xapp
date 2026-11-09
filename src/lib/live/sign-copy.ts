/**
 * What each wallet sheet says before its request can open: what the player is signing, why, and every cost, in plain words. Pure, so
 * tests read exactly what players and Xaman's reviewers will. The network fee is the XRP Ledger's own, set by the wallet and paid to the
 * network, not to us; it's a tiny amount, well under the figure given here. The reserve is XRP the ledger sets aside in the player's own
 * wallet while it owns something more, and it comes back when that's gone.
 */
export const NETWORK_FEE = "under 0.001 XRP";
export const OWNER_RESERVE = "0.2 XRP";

/** The payment for one pack, or for several in one order. */
export function payIntro(p: { readonly xrp: string | null; readonly name: string; readonly qty: number; readonly testnet: boolean }): string {
  const amount = p.xrp === null ? "Your payment" : `${p.xrp} XRP`;
  const what = p.qty > 1 ? `${p.qty} x ${p.name}, in one payment. You sign once.` : `one ${p.name}.`;
  return `${amount} to Break the Seal for ${what}${p.testnet ? " Testnet XRP only." : ""} No service fee: the XRP Ledger's network fee, ${NETWORK_FEE}, is the only other cost. This page moves on as soon as the ledger has it.`;
}

/**
 * Where a payment's sheet stands. Xaman's review asked that nothing says "waiting" before the sign request has really opened:
 * - ready: the sheet is up and nothing has been sent to Xaman yet.
 * - opening: the player pressed Continue and Xaman hasn't taken the request yet.
 * - open: Xaman opened the request (its SDK took it, or its socket said the request was opened on the phone).
 * - signed: Xaman says it was signed. Only the ledger moves the order on.
 * - ended: declined, expired, or turned down by the ledger. Nothing was charged; a new request is the only way on.
 */
export type PayStep = "ready" | "opening" | "open" | "signed" | "ended";

export const READY_TO_PAY = "Ready to pay";
export const CONTINUE_TO_PAYMENT = "Continue to payment";
export const WAITING_CONFIRMATION = "Waiting for payment confirmation";

export function payStep(s: { readonly opening: boolean; readonly opened: boolean; readonly signed: boolean; readonly ended: boolean }): PayStep {
  if (s.ended) return "ended";
  if (s.signed) return "signed";
  if (s.opened) return "open";
  return s.opening ? "opening" : "ready";
}

/** What a payment's sheet says at each step: its heading, its button (null for none), and the line with a spinner (null for none). */
export interface PayCopy {
  readonly title: string;
  readonly action: string | null;
  readonly status: string | null;
}

export function payCopy(step: PayStep): PayCopy {
  switch (step) {
    case "ready":
      return { title: READY_TO_PAY, action: CONTINUE_TO_PAYMENT, status: null };
    case "opening":
      return { title: READY_TO_PAY, action: "Opening Xaman…", status: null };
    case "open":
      return { title: WAITING_CONFIRMATION, action: "Show the request again", status: "Approve the payment in Xaman" };
    case "signed":
      return { title: WAITING_CONFIRMATION, action: null, status: "Signed. Checking the ledger" };
    case "ended":
      return { title: READY_TO_PAY, action: "Try again", status: null };
  }
}

/** A trust line for a token prize, before it can be sent. */
export function trustIntro(issuer: string | null | undefined): string {
  return `Your wallet needs a trust line before it can hold SEAL. Check the issuer, since other tokens use the same name: ${issuer ?? ""}. A trust line sends nothing. Your wallet keeps ${OWNER_RESERVE} in reserve while it's open, and the network fee is ${NETWORK_FEE}. Say no and your prize stays in your stash.`;
}

/** Accepting the free offer that claims an NFT to the player's wallet. */
export function acceptIntro(testnet: boolean): string {
  return `This offer is free and only your wallet can take it.${testnet ? " Testnet only." : ""} Accepting costs only the network fee, ${NETWORK_FEE}, and your wallet may hold ${OWNER_RESERVE} in reserve while you own the NFT.`;
}

/** Approving where a card ships. */
export const SHIP_INTRO = `This isn't a payment. Approving says this card ships to the address you just entered. We charge nothing to ship it, and approving costs only the network fee, ${NETWORK_FEE}. Your card doesn't move until the approval is on the ledger.`;
