import { guard, json } from "@/lib/rip/server";
import { publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Take back an offer the wallet hasn't accepted, so the NFT goes back in the stash. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req);
  if (g instanceof Response) return g;
  const { id } = await params;
  const { engine } = g.rails;
  const done = await engine.cancelClaim(g.address, id);
  if (!done.ok) return json({ error: done.message, code: done.code }, 409);
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  return json({ order: publicOrder(engine.state, engine.state.orders.get(id)!) });
}
