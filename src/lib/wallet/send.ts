import { shortAddress } from "../format.ts";
import { wrongNetworkText } from "./chain.ts";

/**
 * Sending one server-made transaction through a wallet. This file only decides what to tell the player. Nothing it reports
 * moves money state: the engine advances from what it reads on the ledger, whatever a wallet says here. What it does do is
 * refuse to ask at all when the wallet is on the wrong account or network, and refuse to ask twice for one transaction.
 *
 * Every wallet signs and submits in one approval, on purpose. The wallet talks to the ledger from the phone or the extension,
 * so a browser tab that dies after approving can't strand a signed payment, and the ledger still tells this site what happened.
 */
export type Tx = Readonly<Record<string, unknown>>;

export interface SubmitAnswer {
  readonly hash?: string | null;
  /** The first answer from a server. It can still change, which is why it never moves money state. */
  readonly engineResult?: string | null;
  /** The transaction as signed, when the wallet hands it back. */
  readonly signed?: Readonly<Record<string, unknown>> | null;
}

export interface SignerTransport {
  readonly kind: "extension" | "mobile";
  accounts(): Promise<readonly string[]>;
  network(): Promise<string | null>;
  signAndSubmit(req: { tx: Tx; account: string; chain: string }): Promise<SubmitAnswer>;
  /** Told when the account, network or connection changes. Returns how to stop listening. */
  onChange(fn: (what: "account" | "network" | "disconnect") => void): () => void;
}

export type RefusalCode = "wrong_account" | "wrong_network" | "not_connected" | "locked" | "too_many" | "bad_tx" | "unreachable" | "expired";

export type SendOutcome =
  | { readonly state: "sent"; readonly hash: string | null; readonly already?: boolean }
  /** We already asked, and the wallet may still be holding the request. Only a press sends another. */
  | { readonly state: "asked" }
  | { readonly state: "declined" }
  | { readonly state: "refused"; readonly code: RefusalCode; readonly text: string }
  /** The wallet says it didn't land. Preliminary, so the page keeps watching the ledger too. */
  | { readonly state: "failed"; readonly code: string; readonly text: string }
  /** The wallet can't say. It may have landed, so asking again waits. */
  | { readonly state: "unknown"; readonly text: string };

export interface SentEntry {
  readonly state: "asked" | "sent" | "failed";
  readonly at: number;
  readonly hash: string | null;
}

/** Remembers what was asked for each transaction, across a reload, so a returning phone doesn't send a second payment. */
export interface SentLog {
  get(key: string): SentEntry | null;
  put(key: string, entry: SentEntry): void;
  clear(key: string): void;
}

/** How long a request a wallet may still be showing counts: Joey drops approvals after 5 minutes. */
export const ASKED_MS = 5 * 60_000;
/** How long after a submit we refuse to send again. A payment that landed shows on the ledger well inside this. */
export const SENT_LOCK_MS = 30_000;
/** A failed submit gets a beat to turn out otherwise before another can go. */
export const FAILED_LOCK_MS = 8_000;

export function memorySentLog(): SentLog {
  const m = new Map<string, SentEntry>();
  return { get: (k) => m.get(k) ?? null, put: (k, e) => void m.set(k, e), clear: (k) => void m.delete(k) };
}

/** The identity of a transaction: one order, one offer or one trust line is one key, whatever a wallet fills in around it. */
export function txKey(tx: Tx): string {
  const limit = tx.LimitAmount as { currency?: unknown; issuer?: unknown } | undefined;
  const id = tx.InvoiceID ?? tx.NFTokenSellOffer ?? (limit ? `${String(limit.currency)}.${String(limit.issuer)}` : JSON.stringify(tx));
  return `${String(tx.TransactionType)}:${String(tx.Account)}:${String(id)}`;
}

/** What may happen now for this transaction. `waitMs` is how long until another send is allowed. */
export function gate(entry: SentEntry | null, now: number): { readonly open: boolean; readonly waitMs: number; readonly hash: string | null } {
  if (!entry) return { open: true, waitMs: 0, hash: null };
  const age = now - entry.at;
  const hold = entry.state === "sent" ? SENT_LOCK_MS : entry.state === "failed" ? FAILED_LOCK_MS : 0;
  return age < hold ? { open: false, waitMs: hold - age, hash: entry.hash } : { open: true, waitMs: 0, hash: entry.hash };
}

const FIELDS = ["TransactionType", "Account", "Destination", "Amount", "InvoiceID", "NFTokenSellOffer", "LimitAmount"] as const;

/** What a wallet handed back has to be what it was asked to sign. It can only add the fee, sequence and signature around it. */
export function signedMatches(tx: Tx, signed: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (!signed) return true;
  return FIELDS.every((f) => tx[f] === undefined || JSON.stringify(tx[f]) === JSON.stringify(signed[f]) || (f === "InvoiceID" && String(tx[f]).toUpperCase() === String(signed[f]).toUpperCase()));
}

const ENGINE_TEXT: Readonly<Record<string, string>> = {
  tecUNFUNDED_PAYMENT: "Your wallet doesn't have enough XRP for this, after its reserve. Nothing moved except a tiny network fee.",
  tecINSUFFICIENT_RESERVE: "Your wallet needs a little more XRP to hold this: about 0.2 XRP in reserve. Nothing moved except a tiny network fee.",
  tecNO_ENTRY: "That offer isn't open anymore. Nothing moved except a tiny network fee.",
  tecOBJECT_NOT_FOUND: "That offer isn't open anymore. Nothing moved except a tiny network fee.",
  tecEXPIRED: "That offer isn't open anymore. Nothing moved except a tiny network fee.",
};

/** A wallet's first answer, read honestly. `tes` and `ter` may still land; anything else is said plainly, and the ledger has the last word. */
export function readEngineResult(code: string | null | undefined, hash: string | null): SendOutcome {
  if (!code) return { state: "sent", hash };
  if (/^(tes|ter)/.test(code)) return { state: "sent", hash };
  if (code === "tefALREADY") return { state: "sent", hash, already: true };
  if (/^tec/.test(code)) return { state: "failed", code, text: ENGINE_TEXT[code] ?? `The ledger turned this down (${code}). Nothing moved except a tiny network fee.` };
  if (/^(tef|tel|tem)/.test(code)) return { state: "failed", code, text: `Your wallet couldn't send this (${code}). Nothing moved. If the ledger takes it after all, this page moves on by itself.` };
  return { state: "unknown", text: UNKNOWN_TEXT };
}

const UNKNOWN_TEXT = "We can't tell if that went through. Don't send it again yet: this page moves on by itself if the ledger has it.";

/** A thrown wallet error, in plain words. Anything we can't place may have landed, so it reads as unknown, never as failed. */
export function readWalletError(kind: SignerTransport["kind"], err: unknown): SendOutcome {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof e.code === "number" ? e.code : null;
  const message = typeof e.message === "string" ? e.message : "";
  if (code === 4001 || code === 5000 || /reject|declin|denied|cancel/i.test(message)) return { state: "declined" };
  if (code === 4901 || code === 5100) return { state: "refused", code: "wrong_network", text: "Joey's network changed, so this wasn't signed. Switch back in Joey, then try again." };
  if (code === 5103) return { state: "refused", code: "wrong_account", text: "Joey is on a different account than the one you signed in with. Switch back in Joey, then try again. Nothing was signed." };
  if (code === 4100) return { state: "refused", code: "not_connected", text: "Joey isn't connected to this site, or that account isn't shared with it. Connect again. Nothing was signed." };
  if (code === 4300) return { state: "refused", code: "locked", text: "Joey is locked. Unlock it, then try again. Nothing was signed." };
  if (code === 4900) return { state: "refused", code: "unreachable", text: "We can't reach Joey. Check that it's on, then try again. Nothing was signed." };
  if (code === -32005) return { state: "refused", code: "too_many", text: "Joey has too many requests open. Wait a moment, then try again." };
  if (code === 8000) return { state: "refused", code: "expired", text: "That request ended before Joey saw it. Try again." };
  if (code === -32602 || code === -32000) return { state: "refused", code: "bad_tx", text: `Joey wouldn't take this request: ${message || "it said the request was invalid"}. Nothing was signed.` };
  // Joey's phone app, when the wallet signed and submitted and the ledger said no or never said.
  if (code === -32003) return readEngineResult(message || null, null).state === "sent" ? { state: "unknown", text: UNKNOWN_TEXT } : readEngineResult(message, null);
  if (kind === "mobile" && /no matching key|session topic|session.*(expired|not found)|call connect/i.test(message)) return { state: "refused", code: "not_connected", text: "Your connection to Joey ended. Connect again. Nothing was signed." };
  return { state: "unknown", text: UNKNOWN_TEXT };
}

const flights = new Map<string, Promise<SendOutcome>>();

export interface SendContext {
  readonly sessionAddress: string;
  readonly expectedChain: string;
  readonly log: SentLog;
  /** A press on "try again", as against the sheet opening. It can re-ask a request a wallet may have lost, never one just sent. */
  readonly force?: boolean;
  readonly now?: () => number;
  readonly flights?: Map<string, Promise<SendOutcome>>;
}

/** Ask the wallet to sign and submit exactly `tx`. A second call for the same transaction while one is open joins it. */
export function sendTx(t: SignerTransport, tx: Tx, ctx: SendContext): Promise<SendOutcome> {
  const key = txKey(tx);
  const open = ctx.flights ?? flights;
  const running = open.get(key);
  if (running) return running;
  const flight = run(t, tx, key, ctx).finally(() => open.delete(key));
  open.set(key, flight);
  return flight;
}

async function run(t: SignerTransport, tx: Tx, key: string, ctx: SendContext): Promise<SendOutcome> {
  const now = ctx.now ?? Date.now;
  if (tx.Account !== ctx.sessionAddress) return { state: "refused", code: "wrong_account", text: "This request isn't for the account you signed in with. Nothing was signed." };
  if (tx.NetworkID !== undefined) return { state: "refused", code: "bad_tx", text: "This request names a network it shouldn't. Nothing was signed." };
  const before = ctx.log.get(key);
  const held = gate(before, now());
  if (!held.open && before?.state === "sent") return { state: "sent", hash: held.hash, already: true };
  if (!held.open) return { state: "failed", code: "wait", text: "Give it a few seconds, then try again." };
  if (before?.state === "asked" && now() - before.at < ASKED_MS && !ctx.force) return { state: "asked" };

  let accounts: readonly string[];
  let network: string | null;
  try {
    accounts = await t.accounts();
    network = accounts.length ? await t.network() : null;
  } catch (err) {
    const read = readWalletError(t.kind, err);
    return read.state === "unknown" ? { state: "refused", code: "unreachable", text: "We can't reach Joey. Check that it's on, then try again. Nothing was signed." } : read;
  }
  if (!accounts.length) return { state: "refused", code: "not_connected", text: "Joey isn't connected to this site. Connect again. Nothing was signed." };
  if (!accounts.includes(ctx.sessionAddress)) return { state: "refused", code: "wrong_account", text: `Joey is on ${shortAddress(accounts[0])}, but you signed in with ${shortAddress(ctx.sessionAddress)}. Switch accounts in Joey, or sign out and sign in with that one. Nothing was signed.` };
  if (network !== ctx.expectedChain) return { state: "refused", code: "wrong_network", text: wrongNetworkText(network, ctx.expectedChain) };

  ctx.log.put(key, { state: "asked", at: now(), hash: null });
  let answer: SubmitAnswer;
  try {
    answer = await t.signAndSubmit({ tx, account: ctx.sessionAddress, chain: ctx.expectedChain });
  } catch (err) {
    const read = readWalletError(t.kind, err);
    if (read.state === "unknown") ctx.log.put(key, { state: "sent", at: now(), hash: null });
    else if (read.state === "failed") ctx.log.put(key, { state: "failed", at: now(), hash: null });
    else ctx.log.clear(key);
    return read;
  }
  const hash = answer.hash ?? null;
  if (!signedMatches(tx, answer.signed)) {
    ctx.log.put(key, { state: "sent", at: now(), hash });
    return { state: "unknown", text: "Your wallet sent something other than what we asked for. The ledger decides what counts: a wrong payment comes back whole. Don't send it again yet." };
  }
  const read = readEngineResult(answer.engineResult, hash);
  if (read.state === "failed") ctx.log.put(key, { state: "failed", at: now(), hash });
  else ctx.log.put(key, { state: "sent", at: now(), hash });
  return read;
}
