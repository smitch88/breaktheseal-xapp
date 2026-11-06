import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authService, sameOrigin, sessionCookieOptions, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";

/** Verify Joey's signature over the challenge. It is checked and thrown away, and never submitted. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const service = authService();
  if (!service) return NextResponse.json({ error: "Joey sign-in isn't set up yet." }, { status: 503 });
  const jar = await cookies();
  const body = await req.json().catch(() => null);
  const result = await service.joeyVerify(jar.get(CHALLENGE_COOKIE)?.value, body);
  if (!result.ok) return NextResponse.json({ error: "That signature didn't check out. Try again." }, { status: 401 });
  const res = NextResponse.json({ session: result.session }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, result.cookie, sessionCookieOptions(req));
  res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
  return res;
}
