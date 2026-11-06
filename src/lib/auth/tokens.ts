import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring tokens for the two httpOnly cookies. `k` separates their purposes, so a challenge can never be read
 * as a session and a Joey challenge can never be spent on a Xaman sign-in.
 */
export type WalletKind = "xaman" | "joey";

export type ChallengeToken =
  | { readonly k: "xaman"; readonly n: string; readonly u: string; readonly exp: number }
  | { readonly k: "joey"; readonly n: string; readonly a: string; readonly exp: number }
  /** A Joey sign-in that doesn't yet know its address. The signature decides who it is for. */
  | { readonly k: "joey-signin"; readonly n: string; readonly exp: number };

export type SessionToken = { readonly k: "session"; readonly a: string; readonly w: WalletKind; readonly exp: number };

/** A launch inside Xaman that Xaman's API confirmed. It names an account and a spent token. It is not a session and signs no one in. */
export type XappToken = { readonly k: "xapp"; readonly a: string; readonly h: string; readonly exp: number; readonly j?: string };

export type Token = ChallengeToken | SessionToken | XappToken;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest();

export function signToken(token: Token, secret: string): string {
  const body = b64(JSON.stringify(token));
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/** The token if it is ours, of the wanted kind and unexpired. Otherwise null. `nowS` is in seconds. */
export function readToken<K extends Token["k"]>(raw: string | null | undefined, secret: string, kinds: readonly K[], nowS: number): Extract<Token, { k: K }> | null {
  if (typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  const want = mac(body, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let token: Token;
  try {
    token = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!token || !(kinds as readonly string[]).includes(token.k)) return null;
  if (typeof token.exp !== "number" || token.exp <= nowS) return null;
  return token as Extract<Token, { k: K }>;
}
