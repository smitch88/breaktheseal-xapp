import { SHELF_PRICES, type NftPrice } from "@/config/nft-packs";
import { allowed, clientIp } from "@/lib/auth/server";
import { json, learnArt, off, rails } from "@/lib/rip/server";
import { poolView } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** A pack's live pool for its page: rates, token prizes and NFTs, all from the public log. It reads the log and no ledger. */
export async function GET(req: Request, { params }: { params: Promise<{ price: string }> }) {
  const r = rails();
  if (!r) return off();
  const { price } = await params;
  const p = Number(price);
  if (!SHELF_PRICES.includes(p as NftPrice)) return off();
  if (!allowed(`pool:${clientIp(req)}`, 60, 60_000)) return json({ error: "Too many tries. Wait a minute." }, 429);
  await r.engine.sync();
  await learnArt(r);
  return json({ pool: poolView(r.engine.state, p as NftPrice) });
}
