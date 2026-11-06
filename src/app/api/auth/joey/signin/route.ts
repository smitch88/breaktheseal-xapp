import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authService, sameOrigin, sessionCookieOptions, siteOrigin, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";
import { railsConfig } from "@/lib/rip/mode";
import { chainForMode } from "@/lib/wallet/chain";

/** Check Joey's signature against the nonce in this browser's cookie. It proves an address and is never submitted. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const service = authService();
  if (!service) return NextResponse.json({ error: "Joey sign-in isn't set up yet." }, { status: 503 });
  const jar = await cookies();
  const body = await req.json().catch(() => null);
  const origin = siteOrigin(req);
  const result = await service.joeySignIn(jar.get(CHALLENGE_COOKIE)?.value, body, { host: new URL(origin).host, origin, chain: chainForMode(railsConfig(process.env).mode) });
  if (!result.ok) return NextResponse.json({ error: "That signature didn't check out. Try again." }, { status: 401 });
  const res = NextResponse.json({ session: result.session }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, result.cookie, sessionCookieOptions(req));
  res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
  return res;
}
