import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authService, sameOrigin, savePushToken, sessionCookieOptions, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";

/** Ask Xaman where this browser's sign-in stands. When it's signed, verify it here and issue the session. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const service = authService();
  if (!service) return NextResponse.json({ state: "invalid" }, { status: 503 });
  const jar = await cookies();
  try {
    const status = await service.xamanStatus(jar.get(CHALLENGE_COOKIE)?.value);
    if (status.state !== "signed") return NextResponse.json({ state: status.state }, { headers: { "Cache-Control": "no-store" } });
    if (status.userToken) await savePushToken(status.session.address, status.userToken);
    const res = NextResponse.json({ state: "signed", session: status.session }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, status.cookie, sessionCookieOptions(req));
    res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
    return res;
  } catch {
    return NextResponse.json({ state: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }
}
