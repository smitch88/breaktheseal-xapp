/**
 * Running as an xApp, and Xaman's color style there. Both are layout only, never trust: who is signed in is decided on the server, from
 * the launch token Xaman issued.
 *
 * Xaman's own webview sends a `xumm/xapp` user agent. Xaman's sandbox and its xAppBuilder can show the app inside a frame of their own,
 * where neither that user agent nor React Native's bridge can be counted on, but every launch address carries `xAppToken`. Either one
 * makes this tab the xApp, and the tab keeps that for its session, since the launch page drops its query right away. Joey's in-app
 * browser has neither, so it gets the website.
 *
 * Xaman puts the palette the player picked on the launch address as `xAppStyle`: LIGHT, DARK, MOONLIGHT or ROYAL. Anything else, or
 * nothing, is the app's own dark.
 */
export const XAPP_STYLES = ["light", "dark", "moonlight", "royal"] as const;
export type XappStyle = (typeof XAPP_STYLES)[number];
export const XAPP_STYLE_KEY = "seal:xstyle";
/** This tab was opened as the xApp. Session storage, so it ends when Xaman closes the xApp. */
export const XAPP_MARK_KEY = "seal:xapp";
/** Xaman's launch tokens are UUID v4, the mock one its SDK uses for app store review included. */
const LAUNCH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function xappStyle(raw: string | null | undefined): XappStyle {
  const s = (raw ?? "").trim().toLowerCase();
  return (XAPP_STYLES as readonly string[]).includes(s) ? (s as XappStyle) : "dark";
}

/** Whether a page is the xApp: Xaman's user agent, a launch address, or a tab that was opened as the xApp earlier in its session. */
export function xappMarked(input: { readonly userAgent: string; readonly search: string; readonly stored: string | null }): boolean {
  if (input.userAgent.toLowerCase().includes("xumm/xapp")) return true;
  if (input.stored === "1") return true;
  let token: string | null = null;
  try {
    token = new URLSearchParams(input.search).get("xAppToken");
  } catch {
    token = null;
  }
  return !!token && LAUNCH_TOKEN.test(token.trim());
}

/**
 * The root layout's first script, before anything paints: the same decision as `xappMarked`. It marks <html> for the xApp's own shell
 * (transparent html and body, no site header or footer), sets the style, and holds the page unshown (`xpending`) until the launch is
 * known, when XappHost calls Xaman's ready() and lets it show. Storage can throw in a webview, and then the address and the user agent
 * alone decide.
 */
export const XAPP_HEAD_SCRIPT = `(function(){var d=document.documentElement,u=String(navigator.userAgent).toLowerCase(),q=null,m=null,s=null,t=null;try{q=new URLSearchParams(location.search)}catch(e){}t=q&&q.get("xAppToken");try{m=sessionStorage.getItem(${JSON.stringify(XAPP_MARK_KEY)})}catch(e){}if(!(u.indexOf("xumm/xapp")>=0||m==="1"||(t&&${LAUNCH_TOKEN.toString()}.test(t.trim()))))return;d.dataset.xapp="1";d.dataset.xpending="1";try{sessionStorage.setItem(${JSON.stringify(XAPP_MARK_KEY)},"1")}catch(e){}try{s=q&&q.get("xAppStyle");if(s)sessionStorage.setItem(${JSON.stringify(XAPP_STYLE_KEY)},s);else s=sessionStorage.getItem(${JSON.stringify(XAPP_STYLE_KEY)})}catch(e){}s=(s||"").trim().toLowerCase();d.dataset.xstyle=${JSON.stringify(XAPP_STYLES)}.indexOf(s)>=0?s:"dark"})()`;

const kept = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The style this tab's session holds, for a page the head script never ran on. */
export function storedXappStyle(): XappStyle {
  return xappStyle(kept(XAPP_STYLE_KEY));
}

/**
 * Where this browser keeps the little it remembers. Inside the xApp that is the tab's session storage, so nothing about a player outlives
 * Xaman closing the app: their stash lives on our server, under the account Xaman's launch names. The website keeps the device's own.
 */
export function deviceStore(): Storage {
  return inXapp() ? window.sessionStorage : window.localStorage;
}

/**
 * This page is the xApp. The head script's mark, or, on a page it never ran on (a dynamic 404 is an error document without it), the
 * same decision made again, which then marks the page. Browser only.
 */
export function inXapp(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const d = document.documentElement;
  if (d.dataset.xapp === "1") return true;
  if (!xappMarked({ userAgent: navigator.userAgent, search: window.location.search, stored: kept(XAPP_MARK_KEY) })) return false;
  d.dataset.xapp = "1";
  d.dataset.xstyle ??= storedXappStyle();
  try {
    sessionStorage.setItem(XAPP_MARK_KEY, "1");
  } catch {
    /* The address or the user agent still says so on the next page. */
  }
  return true;
}
