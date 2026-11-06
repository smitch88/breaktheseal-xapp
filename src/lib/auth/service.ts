import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyCaip122, verifyChallengeV1 } from "./joey-proof.ts";
import type { NonceStore } from "./nonces.ts";
import { readToken, signToken, type WalletKind } from "./tokens.ts";
import { isUserToken } from "../rip/xaman.ts";
import { challengeTx, isAddress, readXamanPayload, verifyChallengeProof, type ChallengeTx, type XamanPayloadResult } from "./xrpl.ts";

export const CHALLENGE_TTL_S = 300;
export const SESSION_TTL_S = 2 * 3600;
/** A spent id stays spent well past when its token could still be read. */
const SPENT_TTL_S = CHALLENGE_TTL_S + 120;
export const SESSION_COOKIE = "seal_session";
export const CHALLENGE_COOKIE = "seal_challenge";
/** How long after approving a return link can still finish a sign-in, and how long after the request was made. */
export const RETURN_WINDOW_S = 600;
const RETURN_MADE_WINDOW_S = 900;
const LINK_SPENT_TTL_S = RETURN_MADE_WINDOW_S + 300;

export interface XamanCreated {
  readonly uuid: string;
  readonly open: string;
  readonly qr: string;
  readonly ws: string;
}

/** The Xaman platform API. Sign-in only: the one payload it can create is SignIn, which can never be submitted. */
export interface XamanClient {
  createSignIn(input: { nonce: string; returnUrl: string }): Promise<XamanCreated>;
  getPayload(uuid: string): Promise<XamanPayloadResult>;
}

export interface AuthDeps {
  readonly secret: string;
  readonly store: NonceStore;
  readonly xaman: XamanClient | null;
  readonly nowS?: () => number;
  readonly newNonce?: () => string;
}

export interface Session {
  readonly address: string;
  readonly wallet: WalletKind;
}

export type XamanStatus =
  | { readonly state: "pending" | "declined" | "expired" | "used" | "invalid" }
  /** `userToken` is for the server to store. It never goes in a reply or a cookie. */
  | { readonly state: "signed"; readonly session: Session; readonly cookie: string; readonly userToken?: string };

/** Where a phone stands when Xaman sends it back. `cookie` is a new session to set; a held one needs nothing set. */
export type XamanReturn =
  | { readonly state: "signed"; readonly session: Session; readonly cookie?: string; readonly spentChallenge?: boolean; readonly userToken?: string }
  | { readonly state: "other-account"; readonly session: Session; readonly wanted: string }
  | { readonly state: "pending" | "declined" | "expired" | "used" | "gone" };

export type JoeyVerifyResult = { readonly ok: true; readonly session: Session; readonly cookie: string } | { readonly ok: false; readonly reason: string };

/** Read only from a payload whose signature was just checked. */
const pushToken = (p: XamanPayloadResult) => (isUserToken(p.application?.issued_user_token) ? { userToken: p.application.issued_user_token as string } : {});
const UUID = /^[0-9a-f-]{8,64}$/i;
const secondsOf = (at: unknown): number | null => {
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms / 1000 : null;
};

/** What the phone app signs for a sign-in. It names the site, so anyone who reads it can see where a signature is meant to go. */
export const joeyChallenge = (host: string, nonce: string) => `${host}:${nonce}`;

export function createAuthService(deps: AuthDeps) {
  const now = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  const nonce = deps.newNonce ?? (() => randomBytes(16).toString("hex"));
  const returnKey = (n: string) => createHmac("sha256", deps.secret).update(`xaman-return:${n}`).digest("hex");
  const keyFits = (given: string, n: string) => {
    const want = Buffer.from(returnKey(n));
    const got = Buffer.from(given);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const issue = (address: string, wallet: WalletKind) => ({
    session: { address, wallet },
    cookie: signToken({ k: "session", a: address, w: wallet, exp: now() + SESSION_TTL_S }, deps.secret),
  });

  return {
    readSession(raw: string | null | undefined): Session | null {
      const t = readToken(raw, deps.secret, ["session"], now());
      return t && isAddress(t.a) ? { address: t.a, wallet: t.w } : null;
    },

    /**
     * `to` is a path on this site to come back to, already checked, so a phone returns to the place it left. A phone's link can also
     * finish the sign-in itself, because Xaman opens it in the phone's default browser, which may not be the one that started.
     * It carries a key only a sign-in started on a phone gets. A desktop's QR shows the request's id to anyone looking at the screen,
     * and that screen finishes the sign-in by itself, so its link can do nothing.
     */
    async startXaman(origin: string, to?: string | null, opts: { phone?: boolean } = {}) {
      if (!deps.xaman) throw new Error("Xaman is not configured");
      const n = nonce();
      const params = [...(opts.phone ? ["xp={id}", `k=${returnKey(n)}`] : ["qr=1"]), ...(to ? [`to=${encodeURIComponent(to)}`] : [])];
      const created = await deps.xaman.createSignIn({ nonce: n, returnUrl: `${origin}/auth/return?${params.join("&")}` });
      return { qr: created.qr, open: created.open, ws: created.ws, cookie: signToken({ k: "xaman", n, u: created.uuid, exp: now() + CHALLENGE_TTL_S + 60 }, deps.secret) };
    },

    async xamanStatus(rawChallenge: string | null | undefined): Promise<XamanStatus> {
      if (!deps.xaman) return { state: "invalid" };
      const t = readToken(rawChallenge, deps.secret, ["xaman"], now());
      if (!t) return { state: "expired" };
      const payload = await deps.xaman.getPayload(t.u);
      const read = readXamanPayload(payload, t.n);
      if (read.state !== "signed") return { state: read.state };
      if (!(await deps.store.consume(`xaman:${t.u}`, SPENT_TTL_S))) return { state: "used" };
      return { state: "signed", ...issue(read.address, "xaman"), ...pushToken(payload) };
    },

    /**
     * A phone back from Xaman. Whichever browser opened the link, this ends in a session if the sign-in really happened.
     *  - The browser that started has its cookie, and that goes through the same check as ever.
     *  - That browser may already have finished, in another tab: its session cookie says so.
     *  - Any other browser has the link. Xaman, asked with our key, says the request is ours and signed; we check the signature, its
     *    nonce against the link's key, and its age, and spend the link. The session goes to whoever the signature proves.
     * The cookie and the link are spent apart, so a sleeping first tab and the return browser can't strand each other. One approval
     * can therefore sign in the two browsers involved, and no more. A browser signed in as someone else isn't changed without a press,
     * because the link could have been sent by anybody who signed it.
     */
    async xamanReturn(input: { challenge?: string | null; session?: string | null; uuid?: unknown; key?: unknown; replace?: boolean }): Promise<XamanReturn> {
      if (!deps.xaman) return { state: "gone" };
      const t = readToken(input.session, deps.secret, ["session"], now());
      const held: Session | null = t && isAddress(t.a) ? { address: t.a, wallet: t.w } : null;
      const finished = (): XamanReturn => (held ? { state: "signed", session: held } : { state: "gone" });
      const link = typeof input.uuid === "string" && UUID.test(input.uuid) && typeof input.key === "string" && input.key ? { uuid: input.uuid, key: input.key } : null;
      const started = readToken(input.challenge, deps.secret, ["xaman"], now());
      if (started && (!link || started.u === link.uuid)) {
        const payload = await deps.xaman.getPayload(started.u);
        const read = readXamanPayload(payload, started.n);
        if (read.state === "pending" || read.state === "declined") return { state: read.state };
        if (read.state === "signed" && (await deps.store.consume(`xaman:${started.u}`, SPENT_TTL_S))) return { state: "signed", ...issue(read.address, "xaman"), spentChallenge: true, ...pushToken(payload) };
      }
      if (!link) return finished();
      const p = await deps.xaman.getPayload(link.uuid);
      const n = p.custom_meta?.identifier;
      if (typeof n !== "string" || !n || !keyFits(link.key, n)) return finished();
      const read = readXamanPayload(p, n);
      if (read.state === "invalid") return finished();
      if (read.state !== "signed") return { state: read.state };
      const signedAt = secondsOf(p.response?.resolved_at);
      const madeAt = secondsOf(p.payload?.created_at);
      if (signedAt === null || madeAt === null || now() - signedAt > RETURN_WINDOW_S || now() - madeAt > RETURN_MADE_WINDOW_S) return held?.address === read.address ? finished() : { state: "expired" };
      if (held?.address === read.address) return finished();
      if (held && !input.replace) return { state: "other-account", session: held, wanted: read.address };
      if (!(await deps.store.consume(`xaman-link:${link.uuid}`, LINK_SPENT_TTL_S))) return { state: "used" };
      return { state: "signed", ...issue(read.address, "xaman"), ...pushToken(p) };
    },

    /** A challenge for this address, and the cookie that holds it for the verify step. */
    joeyChallenge(address: unknown): { tx: ChallengeTx; cookie: string } | null {
      if (!isAddress(address)) return null;
      const n = nonce();
      const exp = now() + CHALLENGE_TTL_S;
      return { tx: challengeTx(address, n, exp), cookie: signToken({ k: "joey", n, a: address, exp }, deps.secret) };
    },

    async joeyVerify(rawChallenge: string | null | undefined, signed: unknown): Promise<JoeyVerifyResult> {
      const t = readToken(rawChallenge, deps.secret, ["joey"], now());
      if (!t) return { ok: false, reason: "challenge expired" };
      const proof = verifyChallengeProof(signed, challengeTx(t.a, t.n, t.exp));
      if (!proof.ok) return proof;
      if (!(await deps.store.consume(`joey:${t.n}`, SPENT_TTL_S))) return { ok: false, reason: "challenge already used" };
      return { ok: true, ...issue(proof.address, "joey") };
    },

    /** A one-time nonce for Joey's own sign-in, in the extension or the phone app. The cookie holds it for the next step. */
    joeySignInStart(): { nonce: string; cookie: string } {
      const n = nonce();
      return { nonce: n, cookie: signToken({ k: "joey-signin", n, exp: now() + CHALLENGE_TTL_S }, deps.secret) };
    },

    /** Verify either answer Joey gives. Host, origin and network come from this server, never from the caller. */
    async joeySignIn(rawChallenge: string | null | undefined, proof: unknown, site: { host: string; origin: string; chain: string }): Promise<JoeyVerifyResult> {
      const t = readToken(rawChallenge, deps.secret, ["joey-signin"], now());
      if (!t) return { ok: false, reason: "challenge expired" };
      const p = (proof ?? {}) as { mode?: unknown; signedTx?: unknown };
      const checked = p.mode === "challenge-v1" ? verifyChallengeV1(p.signedTx, [joeyChallenge(site.host, t.n), t.n]) : verifyCaip122(proof, { host: site.host, origin: site.origin, chain: site.chain, nonce: t.n, nowS: now() });
      if (!checked.ok) return checked;
      if (!(await deps.store.consume(`joey:${t.n}`, SPENT_TTL_S))) return { ok: false, reason: "challenge already used" };
      return { ok: true, ...issue(checked.address, "joey") };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
