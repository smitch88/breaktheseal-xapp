import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authService } from "@/lib/auth/server";
import { SESSION_COOKIE } from "@/lib/auth/service";
import { xappAccount } from "@/lib/auth/xapp-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const jar = await cookies();
  const held = authService()?.readSession(jar.get(SESSION_COOKIE)?.value) ?? null;
  // Inside Xaman the account comes from the launch, so it shows without a sign-in. What it can do is decided route by route.
  const account = held ? null : await xappAccount();
  const session = held ?? (account ? { address: account, wallet: "xaman" as const } : null);
  return NextResponse.json({ session }, { headers: { "Cache-Control": "no-store" } });
}
