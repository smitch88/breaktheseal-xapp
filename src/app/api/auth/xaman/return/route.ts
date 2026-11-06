import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowed, authService, clientIp, sameOrigin, savePushToken, sessionCookieOptions, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";

const noStore = { "Cache-Control": "no-store" };

/** A phone landing back from Xaman, in whichever browser its operating system picked. See `xamanReturn` for what has to be true. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const service = authService();
  if (!service) return NextResponse.json({ state: "gone" }, { status: 503, headers: noStore });
  if (!allowed(`xaman-return:${clientIp(req)}`, 60)) return NextResponse.json({ state: "pending" }, { status: 429, headers: noStore });
  const body = (await req.json().catch(() => null)) as { xp?: unknown; k?: unknown; replace?: unknown } | null;
  const jar = await cookies();
  try {
    const out = await service.xamanReturn({ challenge: jar.get(CHALLENGE_COOKIE)?.value, session: jar.get(SESSION_COOKIE)?.value, uuid: body?.xp, key: body?.k, replace: body?.replace === true });
    if (out.state === "other-account") return NextResponse.json({ state: out.state, session: out.session, wanted: out.wanted }, { headers: noStore });
    if (out.state !== "signed") return NextResponse.json({ state: out.state }, { headers: noStore });
    if (out.userToken) await savePushToken(out.session.address, out.userToken);
    const res = NextResponse.json({ state: "signed", session: out.session }, { headers: noStore });
    if (out.cookie) res.cookies.set(SESSION_COOKIE, out.cookie, sessionCookieOptions(req));
    if (out.spentChallenge) res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
    return res;
  } catch {
    // Xaman didn't answer. That isn't a no, so the page keeps asking for a little while.
    return NextResponse.json({ state: "pending" }, { headers: noStore });
  }
}
