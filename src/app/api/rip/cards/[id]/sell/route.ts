import { quoteUnless } from "@/lib/rip/limits";
import { guard, json, liveRate, needsProof } from "@/lib/rip/server";
import { publicCard } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** With no body fields, a quote. With the quote's drops, the sale: mirror burned, card sold back, XRP paid, each once. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { launch: true, purpose: quoteUnless("drops") });
  if (g instanceof Response) return g;
  if (process.env.SEAL_SELLBACK_PAUSED === "1") return json({ error: "Selling is paused for a moment. Your card is safe in your stash.", code: "sell_paused" }, 409);
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { drops?: unknown; usdMicro?: unknown } | null;
  const { engine } = g.rails;
  const rate = await liveRate(g.rails);
  if (body?.drops === undefined) {
    const q = await engine.cardSellPrice(g.address, id, rate);
    return q.ok ? json({ drops: q.drops, usdMicro: q.usdMicro }) : json({ error: q.message, code: q.code }, 409);
  }
  // The treasury pays a sale with no signature from the wallet, so the launch's word for whose it is isn't enough.
  if (!g.proven) return needsProof();
  // The quote is recomputed: a client can't name its own price, and a moved rate gets a new quote, not a surprise.
  const q = await engine.cardSellPrice(g.address, id, rate);
  if (!q.ok) {
    const c = engine.state.cards.get(id);
    if (c?.exit?.kind === "sell") return json({ order: publicCard(c) });
    return json({ error: q.message, code: q.code }, 409);
  }
  // The player accepted a figure. Pay it if today's price has risen a little past it, and never pay more than today's price: a figure
  // above that gets today's price back to confirm, so the sale is never for less than the sheet said without the sheet saying so first.
  const accepted = BigInt(String(body.drops).match(/^\d+$/)?.[0] ?? "0");
  const today = BigInt(q.drops);
  if (accepted <= 0n || accepted > today || accepted < (today * 995n) / 1000n) return json({ error: "The price changed. Check the new one.", code: "price_changed", drops: q.drops }, 409);
  const done = await engine.sellCard(g.address, id, { ...q, drops: accepted.toString() });
  if (!done.ok) return json({ error: done.message, code: done.code }, 409);
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  return json({ order: publicCard(engine.state.cards.get(id)!) });
}
