import { encodeForSigning } from "xrpl-binary-codec-prerelease";
import { deriveAddress, verify } from "ripple-keypairs";
import { isAddress, type ProofResult } from "./xrpl.ts";

/**
 * The two answers Joey gives to a sign-in. A software account in the extension signs a CAIP-122 message that Joey itself binds
 * to the site's origin and the network. A Ledger account, and the phone app's one-screen sign-in, sign a transaction that can
 * never apply (`challenge-v1`). Nothing here trusts what a browser says: the session goes to whoever the signature proves.
 */
export const JOEY_STATEMENT = "Sign in to Break the Seal. This moves no funds.";
/** How old a signed message can be, and how far ahead a wallet's clock can run. The nonce is the real limit on replay. */
const MAX_AGE_S = 300;
const MAX_AHEAD_S = 120;
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export interface Caip122Expectation {
  readonly host: string;
  readonly origin: string;
  readonly chain: string;
  readonly nonce: string;
  readonly nowS: number;
  /** The statement the message must carry. Only the real signature pinned in test/joey-proof.test.ts, made under the old name, needs another. */
  readonly statement?: string;
}

/** Rebuilds the message from what we expect, so any line added, moved or changed fails. Joey's format is pinned by a real signature in the tests. */
export function verifyCaip122(proof: unknown, want: Caip122Expectation): ProofResult {
  const p = (proof ?? {}) as { address?: unknown; publicKey?: unknown; signature?: unknown; message?: unknown };
  if (!isAddress(p.address)) return { ok: false, reason: "no address" };
  if (typeof p.publicKey !== "string" || typeof p.signature !== "string" || typeof p.message !== "string") return { ok: false, reason: "incomplete proof" };
  const issued = /\nIssued At: ([^\n]+)$/.exec(p.message)?.[1] ?? "";
  if (!ISSUED_AT.test(issued)) return { ok: false, reason: "no issue time" };
  const issuedS = Date.parse(issued) / 1000;
  if (!(issuedS <= want.nowS + MAX_AHEAD_S) || !(issuedS >= want.nowS - MAX_AGE_S)) return { ok: false, reason: "message too old" };
  const expected = [`${want.host} wants you to sign in with your XRPL account:`, p.address, "", want.statement ?? JOEY_STATEMENT, "", `URI: ${want.origin}`, "Version: 1", `Chain ID: ${want.chain}`, `Nonce: ${want.nonce}`, `Issued At: ${issued}`].join("\n");
  if (p.message !== expected) return { ok: false, reason: "message differs from what we asked for" };
  try {
    if (deriveAddress(p.publicKey) !== p.address) return { ok: false, reason: "key doesn't match the address" };
    if (!verify(Buffer.from(p.message, "utf8").toString("hex"), p.signature, p.publicKey)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, address: p.address };
}

const NOT_SIGNED = new Set(["TxnSignature", "hash"]);

const memoChallenges = (tx: Record<string, unknown>): string[] => {
  if (!Array.isArray(tx.Memos)) return [];
  return tx.Memos.flatMap((m: { Memo?: { MemoData?: unknown } }) => {
    if (typeof m?.Memo?.MemoData !== "string") return [];
    try {
      const body = JSON.parse(Buffer.from(m.Memo.MemoData, "hex").toString("utf8")) as { wallet?: unknown; challenge?: unknown };
      return body.wallet === "joey" && typeof body.challenge === "string" ? [body.challenge] : [];
    } catch {
      return [];
    }
  });
};

/**
 * Joey's sign-in transaction: a 1-drop Payment with Sequence 0, which no ledger can apply, whose memo carries our challenge.
 * `challenges` are the exact strings this sign-in could have sent. Only the account that actually signed gets a session.
 */
export function verifyChallengeV1(signed: unknown, challenges: readonly string[]): ProofResult {
  let tx: Record<string, unknown>;
  try {
    tx = (typeof signed === "string" ? JSON.parse(signed) : signed) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "unreadable signed transaction" };
  }
  if (!tx || typeof tx !== "object") return { ok: false, reason: "no signed transaction" };
  if (tx.TransactionType !== "Payment" || tx.Amount !== "1" || tx.Sequence !== 0 || tx.TicketSequence !== undefined) return { ok: false, reason: "not a sign-in transaction" };
  if (!isAddress(tx.Account) || !isAddress(tx.Destination)) return { ok: false, reason: "no address" };
  if (!memoChallenges(tx).some((c) => challenges.includes(c))) return { ok: false, reason: "memo differs from the challenge" };
  const pub = tx.SigningPubKey;
  const sig = tx.TxnSignature;
  if (typeof pub !== "string" || !pub || typeof sig !== "string" || !sig) return { ok: false, reason: "not signed" };
  try {
    if (deriveAddress(pub) !== tx.Account) return { ok: false, reason: "signed by a different account" };
    const canonical = Object.fromEntries(Object.entries(tx).filter(([k]) => !NOT_SIGNED.has(k)));
    if (!verify(encodeForSigning(canonical), sig, pub)) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, address: tx.Account };
}
