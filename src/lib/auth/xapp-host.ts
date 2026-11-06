/**
 * The browser side of running in Xaman. Only Xaman's own webview has both `ReactNativeWebView` and its `xumm/xapp` user agent;
 * Joey's in-app browser has the first and not the second. This check is not trust: it keeps every other browser from running
 * any of this, including on a link someone crafted with their own token. Who is signed in is decided on the server, and the
 * SDK is only loaded here, so the site outside Xaman never fetches it.
 */
export type SignOutcome = "signed" | "declined";

interface XappSdk {
  ready(): unknown;
  close(options?: { refreshEvents?: boolean }): unknown;
  openBrowser(options: { url: string }): unknown;
  openSignRequest(options: { uuid: string }): unknown;
  on(event: "payload", fn: (data: unknown) => void): unknown;
  off(event: "payload", fn: (data: unknown) => void): unknown;
}

export const isXamanHost = (bridge: unknown, userAgent: string) => typeof bridge !== "undefined" && /xumm\/xapp/i.test(userAgent);
export const inXamanWebview = () => typeof window !== "undefined" && isXamanHost((window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView, navigator.userAgent);

/**
 * Xaman silently drops any message from an xApp under 1500ms after the last one it took, and the SDK still reports success. A
 * sign request sent right after `ready` never opens. So every command waits its turn here, and `ready` goes once per page.
 */
export const HOST_GAP_MS = 1700;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function pacedHost(sdk: XappSdk, now: () => number = Date.now, wait: (ms: number) => Promise<void> = pause): XappSdk {
  let tail: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  const send = (command: () => unknown) => {
    const run = tail.then(async () => {
      const left = last + HOST_GAP_MS - now();
      if (left > 0) await wait(left);
      try {
        return await command();
      } finally {
        last = now();
      }
    });
    tail = run.catch(() => {});
    return run;
  };
  let readied: Promise<unknown> | undefined;
  return {
    ready: () => (readied ??= send(() => sdk.ready())),
    close: (options) => send(() => sdk.close(options)),
    openBrowser: (options) => send(() => sdk.openBrowser(options)),
    openSignRequest: (options) => send(() => sdk.openSignRequest(options)),
    on: (event, fn) => sdk.on(event, fn),
    off: (event, fn) => sdk.off(event, fn),
  };
}

let loaded: Promise<XappSdk> | undefined;
export function xappSdk(): Promise<XappSdk> | null {
  if (!inXamanWebview()) return null;
  loaded ??= import("xumm-xapp-sdk").then((m) => pacedHost(new m.xApp() as unknown as XappSdk));
  return loaded;
}

/** What a `payload` event means for the request we opened. It says when to look, never what happened: only the server knows that. */
export function outcomeOf(event: unknown, uuid: string): SignOutcome | null {
  const e = (event ?? {}) as { uuid?: unknown; reason?: unknown };
  if (e.uuid !== uuid) return null;
  return e.reason === "SIGNED" ? "signed" : e.reason === "DECLINED" ? "declined" : null;
}

/** Open a sign request inside Xaman and wait for it to be resolved. The app's own sheet stays on screen beneath it. */
export async function signInXaman(uuid: string): Promise<SignOutcome> {
  const sdk = await xappSdk();
  if (!sdk) throw new Error("not in Xaman");
  return new Promise<SignOutcome>((resolve, reject) => {
    const listen = (event: unknown) => {
      const outcome = outcomeOf(event, uuid);
      if (!outcome) return;
      sdk.off("payload", listen);
      resolve(outcome);
    };
    sdk.on("payload", listen);
    // The SDK reports a host it can't reach by returning an Error, not by rejecting.
    void Promise.resolve(sdk.openSignRequest({ uuid })).then(
      (r) => {
        if (r instanceof Error) {
          sdk.off("payload", listen);
          reject(r);
        }
      },
      (e) => {
        sdk.off("payload", listen);
        reject(e);
      },
    );
  });
}

/** Open a request that is already waiting, when the first try never showed. The `signInXaman` that is listening hears the answer. */
export async function reopenInXaman(uuid: string): Promise<void> {
  await (await xappSdk())?.openSignRequest({ uuid });
}

/** What a wallet request's sheet shows. A request that ended can't be signed, in the xApp or out of it, so only a new one is offered. */
export type SheetMode = "joey" | "ended" | "xapp" | "link" | "manual";
export const sheetMode = (i: { signedWith?: string | null; inXapp: boolean; hasWallet: boolean; ended: "declined" | "expired" | null }): SheetMode => (i.signedWith === "joey" ? "joey" : i.hasWallet && i.ended ? "ended" : i.inXapp ? "xapp" : i.hasWallet ? "link" : "manual");

/**
 * The launch token. Xaman puts it in the page's address, and since 5.4 also in the webview's user agent for this site's own
 * requests (`xumm/xapp:<build> (ott:<token>)`). Either is fine: the server still spends it once with Xaman before believing it.
 */
export function launchToken(search: string, userAgent: string): string {
  const fromUrl = new URLSearchParams(search).get("xAppToken");
  if (fromUrl) return fromUrl;
  return /xumm\/xapp:[^ ]+.*ott:([0-9a-f-]{36})/i.exec(userAgent)?.[1] ?? "";
}

/** A link leaving this site. A webview can't come back from one, so these go to the phone's browser. */
export function externalUrl(href: string | null | undefined, origin: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, origin);
    return /^https?:$/.test(url.protocol) && url.origin !== origin ? url.href : null;
  } catch {
    return null;
  }
}

/** Where a tapped link has to go instead of this webview: leaving the site, opening a window, or an email. A plain link inside the app stays in it. */
export function xappLink(href: string | null | undefined, target: string | null | undefined, origin: string): string | null {
  if (!href) return null;
  if (/^mailto:/i.test(href)) return href;
  const out = externalUrl(href, origin);
  if (out || target !== "_blank") return out;
  try {
    const url = new URL(href, origin);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** What the player reads when a launch can't go on. Closing and opening the xApp is what gets a new token from Xaman. */
export function refusalText(state: string | undefined, network: "MAINNET" | "TESTNET" = "MAINNET"): string {
  switch (state) {
    case "wrong-network":
      return `Break the Seal runs on XRPL ${network === "TESTNET" ? "Testnet" : "Mainnet"}. Switch networks in Xaman, then open it again.`;
    case "read-only":
      return "This account is read-only in Xaman, so it can't sign. Switch to an account you can sign with, then open it again.";
    case "no-account":
      return "Xaman didn't share an account. Add or pick one in Xaman, then open it again.";
    case "wrong-account":
      return "That signature came from a different account than the one open in Xaman. Nothing changed.";
    case "unavailable":
      return "Xaman didn't answer. Close this and open it again.";
    default:
      return "This session has ended. Close Break the Seal and open it again from Xaman.";
  }
}
