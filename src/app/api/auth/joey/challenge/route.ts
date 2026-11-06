import { NextResponse } from "next/server";
import { allowed, authService, challengeCookieOptions, clientIp, sameOrigin, walletConfig } from "@/lib/auth/server";
import { CHALLENGE_COOKIE } from "@/lib/auth/service";

/** A one-time challenge for the connected address: a transaction built so it can never apply. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  if (!allowed(clientIp(req))) return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429 });
  const service = authService();
  if (!service || !walletConfig().joeyMobile) return NextResponse.json({ error: "Joey sign-in isn't set up yet." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { address?: unknown } | null;
  const out = service.joeyChallenge(body?.address);
  if (!out) return NextResponse.json({ error: "That isn't an XRPL address." }, { status: 400 });
  const res = NextResponse.json({ tx: out.tx }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(CHALLENGE_COOKIE, out.cookie, challengeCookieOptions(req));
  return res;
}
