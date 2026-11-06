import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authService, sameOrigin, savePushToken, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";
import { XAPP_COOKIE } from "@/lib/auth/xapp";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  // Signed out means no more requests landing on that phone, so the push token goes with the session.
  const session = authService()?.readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session?.wallet === "xaman") await savePushToken(session.address, "");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", clearCookie(req));
  res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
  res.cookies.set(XAPP_COOKIE, "", clearCookie(req));
  return res;
}
