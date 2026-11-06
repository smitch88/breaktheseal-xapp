"use client";

import type UniversalProvider from "@walletconnect/universal-provider";
import type { SentEntry, SentLog, SignerTransport } from "./send.ts";
import { detectExtension, extensionTransport, type JoeyExtension, type SignInApi } from "./joey-extension.ts";
import { JOEY_OPEN, mobileTransport, sessionLive, type JoeySession, type WcProvider } from "./joey-mobile.ts";

/** The browser side of Joey. This whole file loads only when someone picks Joey or is signed in with it. */
const VIA_KEY = "seal.joey.via";
const LOG_KEY = "seal.wallet.sent";
const LOG_LIFE_MS = 15 * 60_000;

export type JoeyVia = "extension" | "mobile";

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const rememberVia = (via: JoeyVia) => storage()?.setItem(VIA_KEY, via);
export const rememberedVia = (): JoeyVia | null => {
  const v = storage()?.getItem(VIA_KEY);
  return v === "extension" || v === "mobile" ? v : null;
};

/**
 * Joey's own in-app browser. It injects no wallet and says nothing about itself, so this is the best sign there is: a native
 * app's webview that isn't Xaman's. A wrong guess only skips the wallet picker, and the Joey sheet has a way back to it.
 */
export const inJoeyBrowser = () => typeof window !== "undefined" && typeof (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView !== "undefined" && !/xumm|xaman/i.test(navigator.userAgent);

export const isPhone = () => /Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Kept in this browser, so a phone that reloads after approving doesn't get offered a second payment. Holds no secrets. */
export function browserSentLog(): SentLog {
  const read = (): Record<string, SentEntry> => {
    try {
      return JSON.parse(storage()?.getItem(LOG_KEY) ?? "{}") as Record<string, SentEntry>;
    } catch {
      return {};
    }
  };
  const write = (all: Record<string, SentEntry>) => {
    try {
      const now = Date.now();
      storage()?.setItem(LOG_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).filter(([, e]) => now - e.at < LOG_LIFE_MS))));
    } catch {
      /* A private window: the log still holds for this page, through the in-flight check. */
    }
  };
  return {
    get: (k) => read()[k] ?? null,
    put: (k, e) => write({ ...read(), [k]: e }),
    clear: (k) => {
      const all = read();
      delete all[k];
      write(all);
    },
  };
}

const json = async <T,>(url: string, body?: unknown): Promise<T> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), cache: "no-store" });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? "That didn't go through. Try again.");
  return parsed;
};

const session = (body: { session?: { address: string } }) => ({ address: body.session?.address as string });

export const signInApi: SignInApi & { legacyChallenge(address: string): Promise<unknown>; legacyVerify(signed: unknown): Promise<{ address: string }> } = {
  nonce: () => json("/api/auth/joey/nonce"),
  verify: async (proof) => session(await json("/api/auth/joey/signin", proof)),
  legacyChallenge: async (address) => (await json<{ tx: unknown }>("/api/auth/joey/challenge", { address })).tx,
  legacyVerify: async (signed) => session(await json("/api/auth/joey/verify", signed)),
};

let shared: Promise<UniversalProvider> | null = null;
let sharedId: string | null = null;

/** The one WalletConnect client on this page. Starting it restores a stored session, so a reload keeps the phone connected. */
export function wcProvider(projectId: string): Promise<UniversalProvider> {
  if (shared && sharedId === projectId) return shared;
  sharedId = projectId;
  shared = (async () => {
    const { default: Provider } = await import("@walletconnect/universal-provider");
    const origin = window.location.origin;
    return Provider.init({
      projectId,
      logger: "silent",
      metadata: { name: "Break the Seal", description: "Real collectibles on the XRP Ledger", url: origin, icons: [`${origin}/assets/icon-512.png`], redirect: { universal: origin } },
    });
  })().catch((e) => {
    shared = null;
    throw e;
  });
  return shared;
}

export type Route =
  | { readonly kind: "ready"; readonly via: JoeyVia; readonly transport: SignerTransport; readonly joey?: JoeyExtension; readonly provider?: WcProvider }
  /** No wallet connection that can sign for this account. The player reconnects, and nothing has been signed. */
  | { readonly kind: "reconnect"; readonly extension: boolean; readonly note?: string };

/** After a request goes out on a phone, bring Joey to the front. The visible button still does it if the browser blocks this. */
const openJoeySoon = () =>
  window.setTimeout(() => {
    if (isPhone() && !inJoeyBrowser()) window.location.href = JOEY_OPEN;
  }, 700);

/**
 * Which connection can sign for this account right now. Whichever the player used last goes first, and an extension that has
 * this account shared goes next. A session on some other account or network isn't used here: `sendTx` says so before signing.
 */
export async function findRoute(input: { address: string; chain: string; reownProjectId: string | null }): Promise<Route> {
  const via = rememberedVia();
  const extension = isPhone() ? null : await detectExtension();
  const tryExtension = async (): Promise<Route | null> => {
    if (!extension) return null;
    const granted = await extension.getAccounts().catch(() => [] as string[]);
    if (!granted.includes(input.address)) return null;
    return { kind: "ready", via: "extension", transport: extensionTransport(extension), joey: extension };
  };
  const tryMobile = async (): Promise<Route | null> => {
    if (!input.reownProjectId) return null;
    const provider = await wcProvider(input.reownProjectId).catch(() => null);
    if (!provider || !sessionLive(provider.session as unknown as JoeySession | undefined)) return null;
    return { kind: "ready", via: "mobile", transport: mobileTransport(provider as unknown as WcProvider, { onAsked: openJoeySoon }), provider: provider as unknown as WcProvider };
  };
  const order = via === "mobile" ? [tryMobile, tryExtension] : [tryExtension, tryMobile];
  for (const attempt of order) {
    const route = await attempt();
    if (route) return route;
  }
  return { kind: "reconnect", extension: !!extension };
}

/** Sign out means sign out: the wallet connection goes too. Fire and forget, because the cookie is what counts. */
export async function forgetJoey(reownProjectId: string | null) {
  const extension = isPhone() ? null : await detectExtension(300);
  await extension?.disconnect().catch(() => {});
  if (reownProjectId) {
    const provider = await wcProvider(reownProjectId).catch(() => null);
    if (provider?.session) await provider.disconnect().catch(() => {});
  }
  try {
    window.localStorage.removeItem(VIA_KEY);
  } catch {
    /* Nothing to clear. */
  }
}
