import { NextResponse } from "next/server";
import { JOEY_STATEMENT } from "@/lib/auth/joey-proof";
import { allowed, authService, challengeCookieOptions, clientIp, sameOrigin, siteOrigin } from "@/lib/auth/server";
import { CHALLENGE_COOKIE, joeyChallenge } from "@/lib/auth/service";
import { railsConfig } from "@/lib/rip/mode";
import { chainForMode } from "@/lib/wallet/chain";

/** A one-time nonce for Joey's sign-in, and what the wallet has to sign it under. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  if (!allowed(clientIp(req))) return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429 });
  const service = authService();
  if (!service) return NextResponse.json({ error: "Joey sign-in isn't set up yet." }, { status: 503 });
  const { nonce, cookie } = service.joeySignInStart();
  const res = NextResponse.json({ nonce, statement: JOEY_STATEMENT, challenge: joeyChallenge(new URL(siteOrigin(req)).host, nonce), chain: chainForMode(railsConfig(process.env).mode) }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(CHALLENGE_COOKIE, cookie, challengeCookieOptions(req));
  return res;
}
