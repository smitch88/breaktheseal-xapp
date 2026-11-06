import { NextResponse } from "next/server";
import { allowed, authService, challengeCookieOptions, clientIp, safeReturnPath, sameOrigin, siteOrigin, walletConfig } from "@/lib/auth/server";
import { CHALLENGE_COOKIE } from "@/lib/auth/service";

/** Create a real Xaman SignIn request. Returns the QR and the phone link; the secret stays here. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  if (!allowed(clientIp(req))) return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429 });
  const service = authService();
  if (!service || !walletConfig().xaman) return NextResponse.json({ error: "Xaman sign-in isn't set up yet." }, { status: 503 });
  try {
    const body = (await req.json().catch(() => null)) as { to?: unknown; phone?: unknown } | null;
    const { cookie, ...started } = await service.startXaman(siteOrigin(req), safeReturnPath(body?.to), { phone: body?.phone === true });
    const res = NextResponse.json(started, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(CHALLENGE_COOKIE, cookie, challengeCookieOptions(req));
    return res;
  } catch {
    return NextResponse.json({ error: "Xaman didn't answer. Try again." }, { status: 502 });
  }
}
