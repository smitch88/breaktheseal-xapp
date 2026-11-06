import { NextResponse } from "next/server";
import { walletConfig } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(walletConfig(), { headers: { "Cache-Control": "no-store" } });
}
