import "server-only";
import { publicOrigin } from "../site.ts";
import { clearedCookie, cookieAttrs } from "./cookie-attrs.ts";
import { getCache } from "@vercel/functions";
import { memoryNonceStore, type NonceStore } from "./nonces.ts";
import { CHALLENGE_TTL_S, SESSION_TTL_S, createAuthService, type AuthService } from "./service.ts";
import { createXamanClient } from "./xaman-client.ts";
import { pushTokenKey } from "../rip/xaman.ts";

/**
 * Replay protection across function instances: Vercel's runtime cache, with a per-instance list in front of it. It has
 * no atomic set-if-absent, so two simultaneous replays could both pass inside one read-write gap; a replay also needs
 * the httpOnly challenge cookie. This is the demo's store. Real rails replace it with a unique insert in Postgres.
 */
function sharedNonceStore(): NonceStore {
  const local = memoryNonceStore();
  return {
    async consume(id, ttlSeconds) {
      if (!(await local.consume(id, ttlSeconds))) return false;
      const cache = getCache({ namespace: "seal-rips-auth" });
      if (await cache.get(id)) return false;
      await cache.set(id, 1, { ttl: ttlSeconds });
      return true;
    },
  };
}

const fallback = sharedNonceStore();
/** With real rails on, sign-ins spend their nonce in the same database as everything else, which is atomic. */
export const nonceStore: NonceStore = {
  consume: async (id, ttl) => ((await once()) ?? fallback).consume(id, ttl),
};
let builtOnce: Promise<NonceStore | null> | undefined;
/** Loaded only when rails are on, so wallet sign-in in demo mode never touches any of that code. */
function once(): Promise<NonceStore | null> {
  builtOnce ??= privateRails().then((r) => r?.once ?? null);
  return builtOnce;
}
const privateRails = async () => (process.env.SEAL_RAILS_MODE === "testnet" || process.env.SEAL_RAILS_MODE === "mainnet" ? (await import("../rip/factory.ts")).buildRails(process.env) : null);

/** Keep a player's Xaman push token, or clear it at sign-out. A store that fails only costs the push: a sign-in never depends on it. */
export async function savePushToken(address: string, token: string): Promise<void> {
  await privateRails()
    .then((r) => r?.secrets.put(pushTokenKey(address), token))
    .catch(() => {});
}

export const reownProjectId = () => process.env.REOWN_PROJECT_ID?.trim() || null;

/**
 * Which real wallets are set up. Without the credentials the sheet says so and offers the demo wallet. Joey's extension
 * needs only the session secret; its phone app also needs a Reown project id.
 */
export function walletConfig() {
  const secret = !!process.env.SEAL_SESSION_SECRET;
  return { xaman: secret && !!process.env.XAMAN_API_KEY && !!process.env.XAMAN_API_SECRET, joey: secret, joeyMobile: secret && !!reownProjectId(), reownProjectId: secret ? reownProjectId() : null };
}

export function authService(): AuthService | null {
  const secret = process.env.SEAL_SESSION_SECRET;
  if (!secret) return null;
  const key = process.env.XAMAN_API_KEY;
  const apiSecret = process.env.XAMAN_API_SECRET;
  return createAuthService({ secret, store: nonceStore, xaman: key && apiSecret ? createXamanClient(key, apiSecret) : null });
}

const prod = () => process.env.NODE_ENV === "production";
/** The cookie attributes for whoever sent this request: framed inside Xaman, or any other browser. See cookie-attrs.ts. */
export const cookieBase = (req: Request) => cookieAttrs(req.headers.get("user-agent"), prod());
export const sessionCookieOptions = (req: Request) => ({ ...cookieBase(req), maxAge: SESSION_TTL_S });
export const challengeCookieOptions = (req: Request) => ({ ...cookieBase(req), maxAge: CHALLENGE_TTL_S + 60 });
/** Options that remove a cookie from the same jar this request's cookies were set in. */
export const clearCookie = (req: Request) => clearedCookie(req.headers.get("user-agent"), prod());

/** Rough per-instance brake on the routes that cost a wallet-API call. */
const hits = new Map<string, number[]>();
export function allowed(ip: string, limit = 20, windowMs = 600_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}

/** POST guard: the call must come from this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** A path on this site to come back to, or null. Never another host, however it's written. */
export function safeReturnPath(to: unknown): string | null {
  if (typeof to !== "string" || to.length > 200 || !/^\/(?![/\\])[^\s\\]*$/.test(to)) return null;
  return to.startsWith("/auth/") ? null : to;
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

/** Where a wallet comes back to. The configured address when there is one, so a Xaman return always lands on the real site. */
export function siteOrigin(req: Request): string {
  const configured = publicOrigin(process.env);
  if (configured) return configured;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
