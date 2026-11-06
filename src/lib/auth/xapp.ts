import { createHash, randomBytes } from "node:crypto";
import type { NonceStore } from "./nonces.ts";
import { CHALLENGE_TTL_S, type AuthService, type Session } from "./service.ts";
import { readToken, signToken } from "./tokens.ts";
import { isAddress } from "./xrpl.ts";

/**
 * Running inside Xaman as an xApp. A launch token (OTT) says which account Xaman's app is showing, and Xaman asks that an xApp
 * use it and never ask for a login. But Xaman's open source client puts `account` and `accountaccess` in its launch request
 * itself, so a patched app could name anyone. So the launch is a weaker thing than a session. It's enough to show that account's
 * items, to ask it to pay or accept, which is its own proof, and to hold a place on a pack, within limits of its own. It never makes
 * a session: anything else the server does with no signature (a sale, a redeem, an offer made or cancelled, an address stored,
 * admin) still needs one from a checked SignIn, through the same `xamanStatus` as every other Xaman sign-in, only for that account,
 * and only when the player presses for it.
 */
export const XAPP_COOKIE = "seal_xapp";
/** How long a launch is remembered, so a sign-in can be asked for again without a new token. Same as Xaman's own xApp JWT. */
export const XAPP_TTL_S = 24 * 3600;
const OTT_SPENT_TTL_S = 24 * 3600;
/** A cookie holds about 4 KB, and Xaman's JWTs are well under this. A longer one isn't kept: the info sheet then just shows again. */
const MAX_JWT = 2048;
/** The token the SDK treats as a browser pretending to be an xApp ("e.g. Apple review"). Never ours to accept. */
const MOCK_OTT = "00000000-1337-4000-9000-000000000000";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type XappNetwork = "MAINNET" | "TESTNET";

/** Exactly "on". Anything else, and no xApp route or client code runs. */
export const xappEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SEAL_XAPP?.trim() === "on";
export const xappNetwork = (railsMode: string): XappNetwork => (railsMode === "testnet" ? "TESTNET" : "MAINNET");

export interface XappXaman {
  /** `jwt`: Xaman's JWT for this player and app, when the token was resolved where Xaman issues one. Only ever used for their userstore. */
  getOtt(token: string): Promise<{ readonly kind: "refused" } | { readonly kind: "data"; readonly data: unknown; readonly jwt?: string | null }>;
  createSignIn(input: { nonce: string; account: string; network: XappNetwork }): Promise<{ readonly uuid: string }>;
}

export interface XappDeps {
  readonly secret: string;
  readonly store: NonceStore;
  readonly auth: AuthService;
  readonly xaman: XappXaman | null;
  readonly network: XappNetwork;
  readonly nowS?: () => number;
  readonly newNonce?: () => string;
}

export type OttRefusal = "wrong-network" | "no-account" | "read-only";

/**
 * What an answered token may be used for. Read-only comes back as `accountaccess`: anyone can add any address to Xaman to
 * watch it, so anything short of "FULL" is refused. Xaman's app has been seen sending "Full", so the case is ignored. `nodetype` can be steered by a link's query parameters, so it
 * only sorts honest launches; `force_network` on every request is what actually pins the network.
 */
export function readOtt(data: unknown, network: XappNetwork): { readonly ok: true; readonly account: string } | { readonly ok: false; readonly state: OttRefusal } {
  const o = (data ?? {}) as { account?: unknown; accountaccess?: unknown; nodetype?: unknown };
  if (o.nodetype !== network) return { ok: false, state: "wrong-network" };
  if (!isAddress(o.account)) return { ok: false, state: "no-account" };
  if (typeof o.accountaccess !== "string" || o.accountaccess.toUpperCase() !== "FULL") return { ok: false, state: "read-only" };
  return { ok: true, account: o.account };
}

export const ottShape = (token: unknown): token is string => typeof token === "string" && token.toLowerCase() !== MOCK_OTT && UUID_V4.test(token.toLowerCase());
const ottHash = (token: string) => createHash("sha256").update(token.toLowerCase()).digest("base64url");

export type XappStart =
  /** A launch Xaman confirmed. No sign request was made: the app opens on this account straight away. */
  | { readonly state: "ready"; readonly account: string; readonly session: Session | null; readonly marker?: string }
  | { readonly state: "signed"; readonly session: Session; readonly marker?: string }
  | { readonly state: "sign"; readonly uuid: string; readonly challenge: string; readonly marker?: string }
  | { readonly state: "retry"; readonly marker?: string }
  | { readonly state: "invalid" | "used" | "unavailable" | OttRefusal };

export type XappStatus = { readonly state: "pending" | "declined" | "expired" | "used" | "invalid" | "wrong-account" } | { readonly state: "signed"; readonly session: Session; readonly cookie: string };

export function createXappService(deps: XappDeps) {
  const now = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  const nonce = deps.newNonce ?? (() => randomBytes(16).toString("hex"));
  const readMarker = (raw: string | null | undefined) => {
    const t = readToken(raw, deps.secret, ["xapp"], now());
    return t && isAddress(t.a) ? t : null;
  };

  /** An existing session for this very account is already a checked signature, so it stands. Anything else needs a new one. */
  const askFor = async (account: string, rawSession: string | null | undefined): Promise<XappStart> => {
    const held = deps.auth.readSession(rawSession);
    if (held?.address === account) return { state: "signed", session: held };
    if (!deps.xaman) return { state: "retry" };
    const n = nonce();
    const made = await deps.xaman.createSignIn({ nonce: n, account, network: deps.network }).catch(() => null);
    if (!made) return { state: "retry" };
    return { state: "sign", uuid: made.uuid, challenge: signToken({ k: "xaman", n, u: made.uuid, exp: now() + CHALLENGE_TTL_S + 60 }, deps.secret) };
  };
  const ready = (account: string, rawSession: string | null | undefined, marker?: string): XappStart => {
    const held = deps.auth.readSession(rawSession);
    return { state: "ready", account, session: held?.address === account ? held : null, marker };
  };

  return {
    /** The account of a launch Xaman confirmed for this browser, or null. Only ever from the signed cookie. */
    account(rawMarker: string | null | undefined): string | null {
      return readMarker(rawMarker)?.a ?? null;
    },

    /** Xaman's JWT for this launch's player, for their userstore, or null. */
    userstoreJwt(rawMarker: string | null | undefined): string | null {
      return readMarker(rawMarker)?.j ?? null;
    },

    /** With a token: a new launch, and no sign request. Without one: the player pressed to confirm, so ask the account this browser's launch named. */
    async start(input: { token?: unknown; marker?: string | null; session?: string | null }): Promise<XappStart> {
      const known = readMarker(input.marker);
      if (input.token === undefined || input.token === null) return known ? askFor(known.a, input.session) : { state: "invalid" };
      if (!ottShape(input.token)) return { state: "invalid" };
      const token = input.token.toLowerCase();
      // The same page loaded again. Nothing new is learned or granted: it is the launch this cookie already holds.
      if (known?.h === ottHash(token)) return ready(known.a, input.session);
      if (!deps.xaman) return { state: "unavailable" };
      const answer = await deps.xaman.getOtt(token).catch(() => null);
      if (!answer) return { state: "unavailable" };
      if (answer.kind === "refused") return { state: "invalid" };
      const fresh = await deps.store.consume(`xapp-ott:${token}`, OTT_SPENT_TTL_S).catch(() => null);
      if (fresh === null) return { state: "unavailable" };
      if (!fresh) return { state: "used" };
      const read = readOtt(answer.data, deps.network);
      if (!read.ok) return { state: read.state };
      // Xaman's JWT rides in the signed, httpOnly launch cookie, for the userstore only. It never decides who anyone is.
      const jwt = typeof answer.jwt === "string" && answer.jwt.length <= MAX_JWT ? answer.jwt : null;
      return ready(read.account, input.session, signToken({ k: "xapp", a: read.account, h: ottHash(token), exp: now() + XAPP_TTL_S, ...(jwt ? { j: jwt } : {}) }, deps.secret));
    },

    /** Today's check, untouched, plus one rule: the signature must be from the account this launch named. */
    async status(rawChallenge: string | null | undefined, rawMarker: string | null | undefined): Promise<XappStatus> {
      const known = readMarker(rawMarker);
      if (!known) return { state: "expired" };
      const status = await deps.auth.xamanStatus(rawChallenge);
      if (status.state !== "signed") return { state: status.state };
      return status.session.address === known.a ? status : { state: "wrong-account" };
    },
  };
}

export type XappService = ReturnType<typeof createXappService>;
