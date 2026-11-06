import { NextResponse } from "next/server";
import { allowed, clientIp } from "@/lib/auth/server";
import { MACHINE_CODE } from "@/lib/catalog/parse";
import { catalogSource, getCatalog } from "@/lib/catalog/server";
import { CARD_TIERS, type CardRarity } from "@/lib/catalog/types";

/** The source's cursor is opaque, so this only checks it's safe to pass along. */
const CURSOR = /^[\w.~-]{1,200}$/;

/** One page of what's really in a pack. Cached per page here and by the CDN, so visitors browsing share one read of the source. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!MACHINE_CODE.test(code)) return NextResponse.json({ error: "unknown pack" }, { status: 404 });
  const url = new URL(req.url);
  const rarity = url.searchParams.get("rarity");
  const cursor = url.searchParams.get("cursor");
  if ((rarity !== null && !(CARD_TIERS as readonly string[]).includes(rarity)) || (cursor !== null && !CURSOR.test(cursor))) return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (!(await getCatalog()).machines.some((m) => m.code === code)) return NextResponse.json({ error: "unknown pack" }, { status: 404 });
  // A made-up cursor misses every cache and costs one read of the source, so one visitor can only ask so often.
  if (!allowed(`browse:${clientIp(req)}`, 120, 60_000)) return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  try {
    const page = await catalogSource.page(code, rarity as CardRarity | null, cursor);
    return NextResponse.json(page, { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } });
  } catch {
    return NextResponse.json({ error: "We couldn't read this pack's list just now." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
