import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authService, clientIp, sameOrigin, siteOrigin } from "../auth/server.ts";
import { RETRY_AFTER_S, accountBucket, createLimiter, ipBucket, type PurposeOf } from "./limits.ts";
import { SESSION_COOKIE } from "../auth/service.ts";
import { xappAccount } from "../auth/xapp-server.ts";
import { getMarket } from "../nft/server.ts";
import { TERMS_MULTI_VERSION, TERMS_VERSION } from "../legal/content.ts";
import { buildRails, type Rails } from "./factory.ts";
import { recentPulls, type PullFeed } from "./recent-pulls.ts";
import { learnNames } from "./nft-meta.ts";
import { adminAddresses, allowedWallets, isHouseWallet, railsConfig } from "./mode.ts";
import { PLACE_REFUSAL, checkPlace, restrictedPlaces } from "./places.ts";
import { isUserToken, pushTokenKey, readRequest, requestPlayerSignature, type WalletRequest } from "./xaman.ts";
import { readRequestState } from "../wallet/xaman-socket.ts";
import type { WalletKind } from "../auth/tokens.ts";

let cached: Rails | null | undefined;

/** The rails, or null when the flag is off. One per function instance, since all truth is in the log. */
export function rails(): Rails | null {
  if (cached === undefined) cached = buildRails(process.env);
  return cached;
}

/**
 * Whether the offer a wallet is about to be asked to accept is really still there. A player can cancel their own offer on the ledger, and
 * then a wallet request can only fail. One read per press, and a read that fails says nothing, so the player still gets to ask.
 */
export async function offerGone(r: Rails, offerId: string): Promise<boolean> {
  return (await r.engine.chain.offerOpen?.(offerId).catch(() => true)) === false;
}

/** Before a page shows NFT names: any NFT registered under an id-made name gets its metadata read, once, so the page shows its real name. */
export const learnArt = (r: Rails) => learnNames(r.engine.state, r.engine.chain.nftInfo?.bind(r.engine.chain)).catch(() => {});

export const railsMode = () => railsConfig(process.env).mode;

/** A public page can ask as often as it likes, and a ledger closes about every four seconds. A failed read isn't kept. */
const LEDGER_READ_MS = 2000;
let ledgerRead: { rails: Rails; head: number; at: number; ledger: number } | null = null;
export async function recentLedger(r: Rails): Promise<number> {
  const head = r.engine.state.head;
  if (ledgerRead && ledgerRead.rails === r && ledgerRead.head === head && Date.now() - ledgerRead.at < (r.ledgerReadMs ?? LEDGER_READ_MS)) return ledgerRead.ledger;
  const ledger = await r.engine.chain.validatedLedger();
  ledgerRead = { rails: r, head, at: Date.now(), ledger };
  return ledger;
}

/** One log read per function instance per window, however many people have the homepage open. It reads the log and no ledger. A failed read isn't kept. */
const PULLS_MS = 15_000;
let pullsRead: { rails: Rails; at: number; feed: Promise<PullFeed> } | null = null;
export function pullFeed(r: Rails): Promise<PullFeed> {
  if (pullsRead && pullsRead.rails === r && Date.now() - pullsRead.at < PULLS_MS) return pullsRead.feed;
  const feed = r.engine.sync().then(() => learnArt(r)).then(() => ({ pulls: recentPulls(r.engine.state, Date.now()), asOf: Date.now() }));
  const read = { rails: r, at: Date.now(), feed };
  pullsRead = read;
  feed.catch(() => {
    if (pullsRead === read) pullsRead = null;
  });
  return feed;
}

/** The feed for the homepage's own render, so the strip is in the page or not before it paints. A build reads no database, and a failed read shows no strip. */
export async function firstPulls(): Promise<PullFeed> {
  const none = { pulls: [], asOf: Date.now() };
  if (process.env.NEXT_PHASE === "phase-production-build") return none;
  try {
    const r = rails();
    return r ? await pullFeed(r) : none;
  } catch {
    return none;
  }
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
/** With the flag off these routes don't exist. */
export const off = () => json({ error: "Not found." }, 404);

export async function currentSession() {
  const jar = await cookies();
  return authService()?.readSession(jar.get(SESSION_COOKIE)?.value) ?? null;
}

export const sessionAddress = async (): Promise<string | null> => (await currentSession())?.address ?? null;

/** Who's looking: a signed-in wallet, or inside Xaman the launch's account. For reading only, and only what the public log already shows. */
export const viewerAddress = async (): Promise<string | null> => (await sessionAddress()) ?? (await xappAccount());

/** Said when a route needs a signature behind the account, and the launch alone isn't one. */
export const needsProof = () => json({ error: "Confirm your account in Xaman first. Nothing moved.", code: "confirm_account" }, 401);

const limiter = createLimiter();
/** Nothing was done. The sheet that sent it waits this long and asks once more by itself. */
const busy = () => NextResponse.json({ error: "Busy for a moment. Nothing moved.", code: "rate_limited", retryAfter: RETRY_AFTER_S }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(RETRY_AFTER_S) } });

/**
 * Everything a state-changing route has to pass: rails on, same site, signed in, under the rate limit.
 *
 * `launch` also lets in the account of a launch Xaman confirmed, which is unproven: a patched app could name anyone, any victim. So
 * it's only for a route where that stranger gets nothing: a read, or asking the account to sign something that already stands. Anything the
 * server does on its own account (a sale, a redeem, an offer made or cancelled, an address stored) leaves it out or checks `proven`
 * before it acts, and a hold on a pack passes `proven` on, because a hold is the one thing a launch may open and it has its own limits.
 */
export async function guard(req: Request, opts?: { readonly launch?: boolean; readonly purpose?: PurposeOf }): Promise<{ rails: Rails; address: string; wallet: WalletKind; proven: boolean } | NextResponse> {
  const r = rails();
  if (!r) return off();
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const ip = clientIp(req);
  if (!limiter.take([ipBucket(ip)])) return busy();
  const session = await currentSession();
  const launched = session ? null : await xappAccount();
  if (!session && launched && !opts?.launch) return needsProof();
  const who = session ?? (launched ? { address: launched, wallet: "xaman" as const } : null);
  if (!who) return json({ error: "Connect a wallet first." }, 401);
  const { address, wallet } = who;
  // A quote or a status look has its own budget, so it never spends the one press a player made. The route reads its body as usual.
  const purpose = typeof opts?.purpose === "function" ? opts.purpose((await req.clone().json().catch(() => null)) as Record<string, unknown> | null) : (opts?.purpose ?? "act");
  if (!limiter.take([accountBucket(ip, { address, proven: !!session }, purpose)])) return busy();
  // The mainnet check runs with this set to the owner's own wallets, so no one else can buy before the flag is flipped.
  const allowed_ = allowedWallets(process.env);
  if (allowed_.length && !allowed_.includes(address)) return json({ error: "Packs aren't open yet.", code: "not_open" }, 403);
  if (isHouseWallet(process.env, address)) return json({ error: "This is one of the site's own wallets. It can look around, but it can't buy or act here.", code: "house_wallet" }, 403);
  return { rails: r, address, wallet, proven: !!session };
}

/**
 * Asked before an order opens: is this connection in a restricted place, and did the buyer accept the terms? Nothing has been
 * charged at this point, and nothing is. A request with no location is allowed, and the log says so.
 */
export function orderRefusal(req: Request, accepted: unknown): NextResponse | null {
  const place = checkPlace(req.headers, restrictedPlaces(process.env));
  if (!place.ok) {
    console.warn(`seal-rips: order refused, restricted place ${place.place}`);
    return json({ error: PLACE_REFUSAL, code: "place_restricted" }, 403);
  }
  if (!place.known) console.warn("seal-rips: order allowed with no location header");
  if (accepted !== true) return json({ error: "Accept the terms first. Nothing was charged.", code: "terms_required" }, 400);
  return null;
}

/**
 * The terms this order was opened under, kept privately against the order, so the checkbox isn't the only record. A failure
 * here means no payment is offered: the hold lapses by itself and nothing is charged.
 */
export async function recordTerms(r: Rails, kind: "order" | "card", id: string, address: string, proven: boolean, multi = false): Promise<NextResponse | null> {
  try {
    // A hold can come back to whoever names its wallet, and a launch's word never replaces what's already on record.
    if (!proven && (await r.secrets.get(`terms:${kind}:${id}`))) return null;
    await r.secrets.put(`terms:${kind}:${id}`, JSON.stringify({ version: multi ? TERMS_MULTI_VERSION : TERMS_VERSION, at: new Date().toISOString(), address, proven }));
    return null;
  } catch {
    return json({ error: "That didn't go through. Nothing was charged. Try again.", code: "terms_unrecorded" }, 503);
  }
}

export async function isAdmin(): Promise<boolean> {
  const address = await sessionAddress();
  return !!address && adminAddresses(process.env).includes(address);
}

/**
 * USD per XRP for anything that moves money. Mainnet reads the XRP/RLUSD book off the ledger for every quote, so a stale
 * or dead feed can't misprice a sale: no price means no quote. Testnet has no such market, so it uses the display rate.
 */
export async function liveRate(r: Rails): Promise<number | null> {
  if (r.mode === "mainnet") return (await r.engine.chain.xrpUsd?.().catch(() => null)) ?? null;
  return (await getMarket()).xrpUsd;
}

/** One Xaman request for one transaction, across presses and across servers. A second press must not make a second live request. */
const REQUEST_LIFE_MS = 4 * 60_000;
const requestKey = (txjson: Readonly<Record<string, unknown>>) => `xaman-request:${createHash("sha256").update(JSON.stringify(txjson)).digest("hex")}`;

/**
 * A Xaman request for this transaction, for a Xaman player. A Joey player signs in Joey, and gets none. Null too if Xaman isn't
 * configured, in which case the player can use any wallet. The same transaction gets the same request back until Xaman says it
 * ended, so two presses can't leave two live requests for one order. Whatever the answer, money follows the ledger.
 */
export async function walletRequest(req: Request, g: { rails: Rails; address: string; wallet: WalletKind }, txjson: Readonly<Record<string, unknown>>, instruction: string, identifier: string, path: string): Promise<WalletRequest | null> {
  const r = g.rails;
  if (g.wallet === "joey") return null;
  const apiKey = process.env.XAMAN_API_KEY;
  const apiSecret = process.env.XAMAN_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const inXapp = (await xappAccount()) !== null;
  const key = requestKey(txjson);
  const held = await r.secrets.get(key).catch(() => null);
  if (held) {
    try {
      const { request, at, xapp } = JSON.parse(held) as { request: WalletRequest; at: number; xapp: boolean };
      if (Date.now() - at < REQUEST_LIFE_MS && xapp === inXapp) {
        const state = readRequestState((await readRequest({ apiKey, apiSecret, uuid: request.uuid })) as never);
        if (state === "pending" || state === "signed") return request;
      }
    } catch {
      /* Can't tell. A new request is the honest answer, and the ledger still refunds a second payment. */
    }
  }
  const ask = { apiKey, apiSecret, txjson, instruction, identifier, returnUrl: inXapp ? null : `${siteOrigin(req)}${path}`, network: r.mode === "mainnet" ? "MAINNET" : "TESTNET" } as const;
  // Inside Xaman the request opens by itself. Anywhere else, one made with the player's own token also lands on their phone. The token
  // only ever goes to Xaman, and if Xaman won't take it the plain link still works: that's the whole fallback.
  const stored = inXapp || txjson.Account !== g.address || txjson.TransactionType === "AccountSet" ? null : await r.secrets.get(pushTokenKey(g.address)).catch(() => null);
  const userToken = isUserToken(stored) ? stored : null;
  const made = (await requestPlayerSignature({ ...ask, userToken }).catch(() => null)) ?? (userToken ? await requestPlayerSignature(ask).catch(() => null) : null);
  if (made) await r.secrets.put(key, JSON.stringify({ request: made, at: Date.now(), xapp: inXapp })).catch(() => {});
  return made;
}
