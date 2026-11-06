import { followUpSoon } from "@/lib/rip/alerts";
import { quoteUnless } from "@/lib/rip/limits";
import { guard, json, needsProof } from "@/lib/rip/server";
import { publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Sell at the quoted price, and only that price. Selling is paid from the treasury, once, however often this is called. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { launch: true, purpose: quoteUnless("drops") });
  if (g instanceof Response) return g;
  if (process.env.SEAL_SELLBACK_PAUSED === "1") return json({ error: "Selling is paused for a moment. Your NFT is safe in your stash.", code: "sell_paused" }, 409);
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { drops?: unknown } | null;
  const { engine } = g.rails;
  const quote = await engine.quoteSell(g.address, id);
  if (body?.drops === undefined) return quote.ok ? json({ drops: quote.drops }) : json({ error: quote.message, code: quote.code }, 409);
  // The treasury pays a sale with no signature from the wallet, so the launch's word for whose it is isn't enough.
  if (!g.proven) return needsProof();
  const done = await engine.sell(g.address, id, String(body.drops));
  if (!done.ok) {
    // A token's price moves every ledger, so a stale quote gets the live one back to confirm.
    const fresh = done.code === "price_changed" ? await engine.quoteSell(g.address, id) : null;
    return json({ error: done.message, code: done.code, ...(fresh?.ok ? { drops: fresh.drops } : {}) }, 409);
  }
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  // The NFT goes back in its pool seconds after the sale settles, not at the next cron.
  followUpSoon(g.rails);
  return json({ order: publicOrder(engine.state, engine.state.orders.get(id)!) });
}
