/**
 * What a wallet signs before a physical card leaves custody. A session only says a wallet signed in somewhere, and a sign-in
 * can be relayed from another site, so a session can't be what sends a card to an address. The signature names the card and
 * the address's salted hash, lands on the ledger like every other action here, and moves nothing but the network fee.
 */
export const SHIP_MEMO_TYPE = "seal-rips/ship";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

/**
 * Public, so the address itself never goes in. It opens with the warning for a wallet that shows a memo.
 * On the ledger, and verify.ts rebuilds it byte for byte to check a shipment in the public log, so the old name in it stays.
 */
export const shipMemoText = (cardId: string, addressHash: string) => `This isn't a sign-in. Approving ships a SEAL Rips card out of custody. Decline unless you asked for it. card ${cardId} address ${addressHash}`;

export const shipMemos = (cardId: string, addressHash: string) => [{ Memo: { MemoType: hex(SHIP_MEMO_TYPE), MemoData: hex(shipMemoText(cardId, addressHash)) } }];

/** Does this transaction's memo say exactly this? Servers can differ on the case of hex, and nothing else. */
export function namesShipment(memos: unknown, cardId: string, addressHash: string): boolean {
  const want = shipMemos(cardId, addressHash)[0].Memo;
  const got = Array.isArray(memos) && memos.length === 1 ? (memos[0] as { Memo?: { MemoType?: unknown; MemoData?: unknown } }).Memo : null;
  return String(got?.MemoType).toUpperCase() === want.MemoType && String(got?.MemoData).toUpperCase() === want.MemoData;
}

/**
 * What Xaman shows above the transaction, kept off the ledger. The warning comes first and the address is whatever someone
 * typed, so no address can push the warning off the screen or pass itself off as a sign-in. Xaman's limit is 280 characters.
 */
export function shipInstruction(a: { name: string; street: string; city: string; region?: string; zip: string; country?: string }): string {
  const where = [a.name, a.street, a.city, a.region, a.zip, a.country].filter(Boolean).join(", ");
  return `This isn't a sign-in. Approve only to ship your Break the Seal card to: ${where}`.slice(0, 280);
}
