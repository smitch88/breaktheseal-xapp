import { NextResponse } from "next/server";
import { isOffered } from "@/config/nft-packs";
import { getMarket } from "@/lib/nft/server";
import { livePack, nftPack, parseNftPrice } from "@/lib/nft/view";
import { learnArt, rails } from "@/lib/rip/server";
import { poolView } from "@/lib/rip/views";

export async function GET(_req: Request, { params }: { params: Promise<{ price: string }> }) {
  const { price } = await params;
  const p = parseNftPrice(price);
  if (!p || !isOffered(p)) return NextResponse.json({ error: "unknown pack" }, { status: 404 });
  const market = await getMarket();
  // Rails on, the free demo shows only what a real pull could land on. Rails off, it's the shelf's samples.
  const r = rails();
  if (r) {
    await r.engine.sync();
    await learnArt(r);
    return NextResponse.json({ pack: livePack(nftPack(p, {}), poolView(r.engine.state, p)), xrpUsd: market.xrpUsd, stale: market.stale }, { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=25" } });
  }
  return NextResponse.json({ pack: nftPack(p, market.collections), xrpUsd: market.xrpUsd, stale: market.stale }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=1800" } });
}
