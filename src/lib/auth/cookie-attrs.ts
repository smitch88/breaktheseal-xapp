/**
 * Xaman shows an xApp inside a frame, and a browser holds back a SameSite=Lax cookie from a page framed by another site. So a
 * request from Xaman (its `xumm/xapp` user agent) gets cookies marked SameSite=None and Partitioned: kept only for pages framed
 * under that same top-level site, and still sent nowhere else. Every other browser gets the same Lax cookies as before.
 */
export const fromXaman = (userAgent: string | null | undefined) => /xumm\/xapp/i.test(userAgent ?? "");

export type CookieAttrs = { httpOnly: true; secure: boolean; sameSite: "lax" | "none"; path: "/"; partitioned?: true };

export function cookieAttrs(userAgent: string | null | undefined, production: boolean): CookieAttrs {
  if (fromXaman(userAgent)) return { httpOnly: true, secure: true, sameSite: "none", path: "/", partitioned: true };
  return { httpOnly: true, secure: production, sameSite: "lax", path: "/" };
}

/** Removing a cookie only reaches the jar it was set in, so it goes out with the same attributes it was set with. */
export const clearedCookie = (userAgent: string | null | undefined, production: boolean) => ({ ...cookieAttrs(userAgent, production), maxAge: 0 });
