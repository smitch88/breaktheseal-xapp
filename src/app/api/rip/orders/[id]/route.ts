import { json, learnArt, rails, viewerAddress } from "@/lib/rip/server";
import { off } from "@/lib/rip/server";
import { publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Where a pull stands. Looking is what moves things forward, so a poll is also the crash recovery. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = rails();
  if (!r) return off();
  const { id } = await params;
  await r.engine.advance({ minGapMs: 1500 }).catch(() => {});
  const order = r.engine.state.orders.get(id);
  if (!order) return json({ error: "Not found." }, 404);
  await learnArt(r);
  return json({ order: publicOrder(r.engine.state, order), mine: order.address === (await viewerAddress()) });
}
