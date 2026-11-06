import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowed, clientIp, sameOrigin } from "@/lib/auth/server";
import { XAPP_COOKIE } from "@/lib/auth/xapp";
import { xappService } from "@/lib/auth/xapp-server";
import { createUserstore } from "@/lib/auth/xapp-userstore";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * The first-launch info sheet inside Xaman: whether this player has read it, kept in Xaman's userstore with the JWT from their own
 * launch. With no launch, no JWT or no answer from Xaman, it shows. Nothing here can sign anyone in or change what an account can do.
 */
export async function GET(req: Request) {
  const service = xappService();
  if (!service) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  if (!allowed(`xapp-info:${clientIp(req)}`, 60)) return NextResponse.json({ show: true }, { headers: noStore });
  const jwt = service.userstoreJwt((await cookies()).get(XAPP_COOKIE)?.value);
  const seen = await createUserstore().infoSeen(jwt);
  return NextResponse.json({ show: !seen }, { headers: noStore });
}

/** "Got it": remembered in Xaman's userstore for this player. */
export async function POST(req: Request) {
  const service = xappService();
  if (!service) return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403, headers: noStore });
  if (!allowed(`xapp-info:${clientIp(req)}`, 60)) return NextResponse.json({ saved: false }, { status: 429, headers: noStore });
  const jwt = service.userstoreJwt((await cookies()).get(XAPP_COOKIE)?.value);
  return NextResponse.json({ saved: await createUserstore().markInfoSeen(jwt) }, { headers: noStore });
}
