import { NextResponse } from "next/server";
import { allowed, clientIp } from "@/lib/auth/server";
import { MACHINE_CODE } from "@/lib/catalog/parse";
import { getCatalog } from "@/lib/catalog/server";
import { cardDetailsFor } from "@/lib/rip/card-details";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** What the list row leaves out, such as set and card number, from the card's public record. Read when someone opens it, then shared. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string; mint: string }> }) {
  const { code, mint } = await params;
  if (!MACHINE_CODE.test(code) || !MINT.test(mint)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await getCatalog()).machines.some((m) => m.code === code)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!allowed(`card:${clientIp(req)}`, 60, 60_000)) return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  const details = await cardDetailsFor({ gateway: "collector-crypt", mint });
  return NextResponse.json({ details }, { headers: { "Cache-Control": details ? "public, s-maxage=3600, stale-while-revalidate=86400" : "no-store" } });
}
