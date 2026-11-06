/**
 * Xaman's color style, inside the xApp. Xaman puts the palette the player picked on the launch address as `xAppStyle`: LIGHT, DARK,
 * MOONLIGHT or ROYAL. The launch page drops its query right away, so the style is kept for the webview's session and every later page
 * reads it from there. Anything else, or nothing, is the app's own dark.
 */
export const XAPP_STYLES = ["light", "dark", "moonlight", "royal"] as const;
export type XappStyle = (typeof XAPP_STYLES)[number];
export const XAPP_STYLE_KEY = "seal:xstyle";

export function xappStyle(raw: string | null | undefined): XappStyle {
  const s = (raw ?? "").trim().toLowerCase();
  return (XAPP_STYLES as readonly string[]).includes(s) ? (s as XappStyle) : "dark";
}

/**
 * The root layout's first script, before anything paints, and only in Xaman's webview: it marks <html> for the xApp's own shell and
 * sets the style. Storage can throw in a webview, and then the address alone decides.
 */
export const XAPP_HEAD_SCRIPT = `(function(){if(navigator.userAgent.toLowerCase().indexOf("xumm/xapp")<0)return;var d=document.documentElement,s=null;d.dataset.xapp="1";try{s=new URLSearchParams(location.search).get("xAppStyle");if(s)sessionStorage.setItem(${JSON.stringify(XAPP_STYLE_KEY)},s);else s=sessionStorage.getItem(${JSON.stringify(XAPP_STYLE_KEY)})}catch(e){}s=(s||"").trim().toLowerCase();d.dataset.xstyle=${JSON.stringify(XAPP_STYLES)}.indexOf(s)>=0?s:"dark"})()`;

/** The style this webview's session holds, for a page the head script never ran on. */
export function storedXappStyle(): XappStyle {
  try {
    return xappStyle(sessionStorage.getItem(XAPP_STYLE_KEY));
  } catch {
    return "dark";
  }
}
