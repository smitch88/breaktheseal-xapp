import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowed, clientIp, sameOrigin, sessionCookieOptions, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";
import { XAPP_COOKIE } from "@/lib/auth/xapp";
import { xappService } from "@/lib/auth/xapp-server";

const noStore = { "Cache-Control": "no-store" };

/** Where the SignIn opened inside Xaman stands. Xaman's event only says when to ask; the signature is checked here. */
export async function POST(req: Request) {
  const service = xappService();
  if (!service) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403, headers: noStore });
  if (!allowed(`xapp-status:${clientIp(req)}`, 120)) return NextResponse.json({ state: "pending" }, { status: 429, headers: noStore });
  const jar = await cookies();
  try {
    const status = await service.status(jar.get(CHALLENGE_COOKIE)?.value, jar.get(XAPP_COOKIE)?.value);
    if (status.state !== "signed") {
      const res = NextResponse.json({ state: status.state }, { headers: noStore });
      if (status.state === "wrong-account") res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
      return res;
    }
    const res = NextResponse.json({ state: "signed", session: status.session }, { headers: noStore });
    res.cookies.set(SESSION_COOKIE, status.cookie, sessionCookieOptions(req));
    res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
    return res;
  } catch {
    return NextResponse.json({ state: "pending" }, { headers: noStore });
  }
}
