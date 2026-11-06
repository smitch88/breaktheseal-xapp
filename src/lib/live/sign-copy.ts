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
