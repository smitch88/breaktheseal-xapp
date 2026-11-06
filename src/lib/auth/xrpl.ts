import { decode, encodeForSigning } from "xrpl-binary-codec-prerelease";
import { isValidClassicAddress } from "ripple-address-codec";
import { deriveAddress, verify } from "ripple-keypairs";
import { verifySignature } from "verify-xrpl-signature";

/** Sign-in proofs only. Nothing in this app can submit a transaction: there is no submit call anywhere. */
export const isAddress = (a: unknown): a is string => typeof a === "string" && isValidClassicAddress(a);

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
export const MEMO_TYPE = hex("seal-rips/sign-in");

export interface ChallengeTx {
  readonly TransactionType: "AccountSet";
  readonly Account: string;
  readonly Fee: "0";
  readonly Sequence: 1;
  readonly LastLedgerSequence: 1;
  readonly SigningPubKey: "";
  readonly Memos: readonly [{ readonly Memo: { readonly MemoType: string; readonly MemoData: string } }];
}

/**
 * What Joey is asked to sign. Joey only offers transaction signing, so this is built to be useless on the ledger, three
 * times over: AccountSet with no fields changes nothing and moves nothing, LastLedgerSequence 1 passed years ago so
 * validators reject it for good, and a zero fee is below the minimum. The memo carries the server's nonce and expiry.
 */
export function challengeTx(address: string, nonce: string, expS: number): ChallengeTx {
  return {
    TransactionType: "AccountSet",
    Account: address,
    Fee: "0",
    Sequence: 1,
    LastLedgerSequence: 1,
    SigningPubKey: "",
    Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: hex(`Sign in to Break the Seal. This is never submitted and moves no funds. ${nonce} ${expS}`) } }],
  };
}

const ALLOWED_EXTRA = new Set(["SigningPubKey", "TxnSignature", "Flags", "hash", "NetworkID"]);
const NOT_SIGNED = new Set(["TxnSignature", "hash"]);

export type ProofResult = { readonly ok: true; readonly address: string } | { readonly ok: false; readonly reason: string };

const memoOf = (tx: Record<string, unknown>) => JSON.stringify(tx.Memos);

/** Check a wallet's signed answer against the exact challenge it was sent. Takes tx_json, or a signed blob as hex. */
export function verifyChallengeProof(signed: unknown, expected: ChallengeTx): ProofResult {
  let tx: Record<string, unknown>;
  try {
    const raw = (typeof signed === "string" ? { hex: signed } : signed) as { tx_json?: unknown; hex?: unknown; tx_blob?: unknown } | null;
    const blob = typeof raw?.hex === "string" ? raw.hex : typeof raw?.tx_blob === "string" ? raw.tx_blob : null;
    if (blob) tx = decode(blob) as Record<string, unknown>;
    else tx = (raw?.tx_json ?? raw) as Record<string, unknown>;
    if (!tx || typeof tx !== "object") return { ok: false, reason: "no signed transaction" };
  } catch {
    return { ok: false, reason: "unreadable signed transaction" };
  }
  for (const key of ["TransactionType", "Account", "Fee", "Sequence", "LastLedgerSequence"] as const) {
    if (tx[key] !== expected[key]) return { ok: false, reason: `${key} differs from the challenge` };
  }
  if (memoOf(tx) !== memoOf(expected as unknown as Record<string, unknown>)) return { ok: false, reason: "memo differs from the challenge" };
  for (const key of Object.keys(tx)) {
    if (!(key in expected) && !ALLOWED_EXTRA.has(key)) return { ok: false, reason: `unexpected field ${key}` };
  }
  const flags = tx.Flags ?? 0;
  if (flags !== 0 && flags !== 2147483648) return { ok: false, reason: "unexpected flags" };
  const pub = tx.SigningPubKey;
  const sig = tx.TxnSignature;
  if (typeof pub !== "string" || !pub || typeof sig !== "string" || !sig) return { ok: false, reason: "not signed" };
  try {
    if (deriveAddress(pub) !== expected.Account) return { ok: false, reason: "signed by a different account" };
    const canonical = Object.fromEntries(Object.entries(tx).filter(([k]) => !NOT_SIGNED.has(k)));
    if (!verify(encodeForSigning(canonical), sig, pub)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, address: expected.Account };
}

/** The Xaman payload fields we rely on. */
export interface XamanPayloadResult {
  readonly meta?: { readonly exists?: boolean; readonly resolved?: boolean; readonly signed?: boolean; readonly cancelled?: boolean; readonly expired?: boolean };
  readonly payload?: { readonly tx_type?: string; readonly created_at?: string | null };
  readonly custom_meta?: { readonly identifier?: string | null };
  readonly response?: { readonly hex?: string | null; readonly account?: string | null; readonly resolved_at?: string | null };
  /** Xaman's push token for this user and our API key. Only ever read after the signature checks out. */
  readonly application?: { readonly issued_user_token?: string | null };
}

export type XamanState = { readonly state: "pending" } | { readonly state: "declined" } | { readonly state: "expired" } | { readonly state: "signed"; readonly address: string } | { readonly state: "invalid"; readonly reason: string };

/** Decide a SignIn payload's state. A signature is only believed after checking it ourselves, as Xaman's docs advise. */
export function readXamanPayload(p: XamanPayloadResult, nonce: string): XamanState {
  const meta = p.meta ?? {};
  if (meta.exists === false || meta.expired || meta.cancelled) return { state: "expired" };
  if (!meta.resolved) return { state: "pending" };
  if (!meta.signed) return { state: "declined" };
  if (p.payload?.tx_type !== "SignIn") return { state: "invalid", reason: "not a SignIn" };
  if (p.custom_meta?.identifier !== nonce) return { state: "invalid", reason: "nonce differs" };
  const account = p.response?.account;
  const blob = p.response?.hex;
  if (!isAddress(account) || typeof blob !== "string" || !blob) return { state: "invalid", reason: "no signature" };
  try {
    const result = verifySignature(blob);
    if (!result.signatureValid) return { state: "invalid", reason: "bad signature" };
    if (result.signedBy !== account) return { state: "invalid", reason: "signed by a different account" };
  } catch {
    return { state: "invalid", reason: "unreadable signature" };
  }
  return { state: "signed", address: account };
}
