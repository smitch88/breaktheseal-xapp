import { NextResponse } from "next/server";
import { json, off, pullFeed, rails } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** The ticker's feed: the same for everyone, so the CDN answers nearly all of it. It reads the log and no ledger, and never asks who's reading. */
export async function GET() {
  const r = rails();
  if (!r) return off();
  try {
    return NextResponse.json(await pullFeed(r), { headers: { "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=30" } });
  } catch {
    return json({ error: "Try again in a moment." }, 503);
  }
}
