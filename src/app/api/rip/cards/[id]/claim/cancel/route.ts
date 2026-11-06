import { guard, json } from "@/lib/rip/server";
import { publicCard } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Take back an offer the wallet hasn't accepted: the card's NFT is retired and the card goes back in the stash. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req);
  if (g instanceof Response) return g;
  const { id } = await params;
  const { engine } = g.rails;
  const done = await engine.takeBackCard(g.address, id);
  if (!done.ok) return json({ error: done.message, code: done.code }, 409);
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  return json({ order: publicCard(engine.state.cards.get(id)!) });
}
