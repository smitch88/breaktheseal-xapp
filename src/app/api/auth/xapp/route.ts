import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowed, authService, challengeCookieOptions, clientIp, sameOrigin, clearCookie } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, SESSION_COOKIE } from "@/lib/auth/service";
import { XAPP_COOKIE } from "@/lib/auth/xapp";
import { currentXappNetwork, xappCookieOptions, xappService } from "@/lib/auth/xapp-server";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const off = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });

/** A new launch we can't confirm: whoever an older cookie names may not be who is holding this phone now. */
function unconfirmed(req: Request, res: NextResponse, token: unknown) {
  if (token !== undefined && token !== null) {
    res.cookies.set(XAPP_COOKIE, "", clearCookie(req));
    res.cookies.set(SESSION_COOKIE, "", clearCookie(req));
    res.cookies.set(CHALLENGE_COOKIE, "", clearCookie(req));
  }
  return res;
}

/** Whether this browser holds a launch Xaman confirmed, and whether a signature backs it. Every payment is checked on its own. */
export async function GET() {
  const service = xappService();
  if (!service) return off();
  const jar = await cookies();
  const account = service.account(jar.get(XAPP_COOKIE)?.value);
  const proven = !!account && authService()?.readSession(jar.get(SESSION_COOKIE)?.value)?.address === account;
  return NextResponse.json({ xapp: !!account, account, proven, network: account ? currentXappNetwork() : null }, { headers: noStore });
}

/**
 * With a token: a launch, spent with Xaman here once. It answers with the account and asks for no signature, and never makes a
 * session. Without one: the player pressed to confirm their account, and what comes back is a SignIn to approve in Xaman.
 */
export async function POST(req: Request) {
  const service = xappService();
  if (!service) return off();
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403, headers: noStore });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = body?.token;
  if (!allowed(`xapp:${clientIp(req)}`, 30)) return unconfirmed(req, NextResponse.json({ state: "busy" }, { status: 429, headers: noStore }), token);
  const jar = await cookies();
  const result = await service.start({ token, marker: jar.get(XAPP_COOKIE)?.value, session: jar.get(SESSION_COOKIE)?.value });

  if (result.state === "ready") {
    const res = NextResponse.json({ state: "ready", account: result.account, proven: !!result.session }, { headers: noStore });
    if (result.marker) res.cookies.set(XAPP_COOKIE, result.marker, xappCookieOptions(req));
    // A session for this very account stands. Whatever else is here belongs to some other account.
    if (!result.session) res.cookies.set(SESSION_COOKIE, "", clearCookie(req));
    return res;
  }
  if (result.state === "signed" || result.state === "sign" || result.state === "retry") {
    const res = NextResponse.json(result.state === "signed" ? { state: "signed", session: result.session } : result.state === "sign" ? { state: "sign", uuid: result.uuid } : { state: "retry" }, { headers: noStore });
    if (result.state === "sign") res.cookies.set(CHALLENGE_COOKIE, result.challenge, challengeCookieOptions(req));
    // A session for this very account would have come back as "signed", so whatever is here belongs to some other account.
    if (result.state !== "signed") res.cookies.set(SESSION_COOKIE, "", clearCookie(req));
    return res;
  }
  return unconfirmed(req, NextResponse.json({ state: result.state }, { status: result.state === "unavailable" ? 502 : 403, headers: noStore }), token);
}
