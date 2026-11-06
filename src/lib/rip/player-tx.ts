/**
 * The only transactions a player is ever asked to sign, and the one shape each may take:
 *
 *   Payment             paying for a pack, or several in one order
 *   NFTokenAcceptOffer  taking the free offer that claims an NFT to their wallet
 *   TrustSet            the SEAL trust line a token prize needs, with rippling left off and nothing else set
 *   AccountSet          a memo only, approving where a card ships: it changes no setting on the account
 *
 * Nothing that changes who controls an account (SetRegularKey, SignerListSet, a delegation) or ends one (AccountDelete) is ever on the
 * list, and Xaman's xApp rules forbid asking for those. A request for anything else is refused before it reaches Xaman. Pure.
 */
export const PLAYER_TX_TYPES = ["Payment", "NFTokenAcceptOffer", "TrustSet", "AccountSet"] as const;

/** Fields that hand control of an account to someone else, whatever transaction they ride on. */
const CONTROL_FIELDS = ["RegularKey", "SignerEntries", "SignerQuorum", "Permissions", "Authorize", "NFTokenMinter", "Delegate"];
/** An AccountSet that approves a shipment carries its memos and nothing that changes a setting. */
const ACCOUNT_SET_FIELDS = new Set(["TransactionType", "Account", "Memos", "LastLedgerSequence", "Fee", "Sequence", "SigningPubKey"]);
/** tfSetNoRipple, the one flag our trust line sets. */
const TF_SET_NO_RIPPLE = 0x00020000;

export function playerTxRefusal(tx: Readonly<Record<string, unknown>>): string | null {
  const type = tx.TransactionType;
  if (typeof type !== "string" || !(PLAYER_TX_TYPES as readonly string[]).includes(type)) return `a ${String(type)} transaction is never asked of a player`;
  const control = CONTROL_FIELDS.find((f) => f in tx);
  if (control) return `${control} is never asked of a player`;
  if (type === "AccountSet") {
    const extra = Object.keys(tx).find((k) => !ACCOUNT_SET_FIELDS.has(k));
    if (extra) return `an AccountSet that sets ${extra} is never asked of a player`;
  }
  if (type === "TrustSet" && tx.Flags !== undefined && tx.Flags !== 0 && tx.Flags !== TF_SET_NO_RIPPLE) return "a trust line with flags other than no-ripple is never asked of a player";
  return null;
}
