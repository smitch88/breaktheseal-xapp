import { json, off, rails, viewerAddress } from "@/lib/rip/server";
import { publicCard } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Where a card pull stands. Looking moves it forward, so a poll is also the crash recovery. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = rails();
  // Not tied to cardsOn: a card someone holds keeps its page after card packs close.
  if (!r) return off();
  const { id } = await params;
  await r.engine.advance({ minGapMs: 1500 }).catch(() => {});
  const c = r.engine.state.cards.get(id);
  if (!c) return json({ error: "Not found." }, 404);
  // A wrong payment leaves the order open, so the refund for it shows here.
  const refund = c.refundId ? r.engine.state.refunds.get(c.refundId) : [...r.engine.state.refunds.values()].find((x) => x.order === c.id);
  return json({ order: { ...publicCard(c), refund: refund ? { reason: refund.reason, status: refund.status, txHash: refund.txHash } : null }, mine: c.address === (await viewerAddress()) || !!c.mirror?.accepted });
}
