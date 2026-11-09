import { readEngineResult } from "./send.ts";

/**
 * What a Xaman status socket said, or null for chatter. The socket only ever says when to look: the server still reads the
 * ledger, and a sign-in's signature is still checked on the server.
 */
export type XamanSignal = "signed" | "declined" | "expired";

export function readXamanSocket(raw: unknown): XamanSignal | null {
  let m: { signed?: unknown; expired?: unknown; expires_in_seconds?: unknown };
  try {
    m = JSON.parse(String(raw)) as typeof m;
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  if (m.signed === true) return "signed";
  if (m.signed === false) return "declined";
  if (m.expired === true || (typeof m.expires_in_seconds === "number" && m.expires_in_seconds <= 0)) return "expired";
  return null;
}

/** Xaman's socket saying the request was opened on the phone: from then on the sheet may say it's waiting for the payment's confirmation. */
export function socketOpened(raw: unknown): boolean {
  try {
    const m = JSON.parse(String(raw)) as { opened?: unknown } | null;
    return !!m && typeof m === "object" && m.opened === true;
  } catch {
    return false;
  }
}

/** What a read of a payload says about one sign request. A signed request whose submit failed is over: nothing moved. */
export type XamanRequestState = "pending" | "signed" | "declined" | "expired";

export function readRequestState(p: { meta?: { exists?: boolean; resolved?: boolean; signed?: boolean; cancelled?: boolean; expired?: boolean }; response?: { dispatched_result?: string | null } } | null | undefined): XamanRequestState {
  const meta = p?.meta ?? {};
  if (meta.exists === false || meta.expired || meta.cancelled) return "expired";
  if (!meta.resolved) return "pending";
  if (!meta.signed) return "declined";
  const result = p?.response?.dispatched_result;
  return result && !/^(tes|ter|tefALREADY)/.test(result) ? "declined" : "signed";
}

/** The ledger's code when a request was signed and the ledger turned it down. Null for a plain no, a request still open, or one that worked. */
export function requestFailure(p: { meta?: { resolved?: boolean; signed?: boolean }; response?: { dispatched_result?: string | null } } | null | undefined): string | null {
  const result = p?.response?.dispatched_result;
  return p?.meta?.resolved && p.meta.signed && result && !/^(tes|ter|tefALREADY)/.test(result) ? result : null;
}

/** That code in plain words. Whatever it was, it didn't land, so nothing moved. */
export function failureText(code: string): string {
  const read = readEngineResult(code, null);
  return read.state === "failed" ? read.text : "The ledger didn't take that. Nothing moved.";
}
