import { followUpSoon } from "@/lib/rip/alerts";
import { quoteUnless } from "@/lib/rip/limits";
import { guard, json, needsProof, off, rails } from "@/lib/rip/server";
import type { PayoutItem } from "@/lib/rip/types";

export const dynamic = "force-dynamic";

const LONGEST = 20;
const clean = (v: unknown): PayoutItem[] | null => {
  if (!Array.isArray(v) || v.length > LONGEST) return null;
  const out: PayoutItem[] = [];
  for (const x of v as { order?: unknown; action?: unknown; drops?: unknown }[]) {
    if (typeof x?.order !== "string" || (x.action !== "sell" && x.action !== "redeem") || typeof x.drops !== "string") return null;
    out.push({ order: x.order, action: x.action, drops: x.drops });
  }
  return out;
};

/**
 * Sell or send several prizes in one payment. `ids` asks what it would pay. `items` says yes to those prices, and the server takes them only if they still hold.
 * Every item is paid once, however often this is called. Where the payment stands shows on each item, so a reload or a dropped connection loses nothing.
 */
export async function POST(req: Request) {
  if (!rails()?.engine.multi) return off();
  // A launch may ask what it would pay, as with one sale. Paying takes a signature behind the account: the treasury sends this with none from the wallet.
  const g = await guard(req, { launch: true, purpose: quoteUnless("items") });
  if (g instanceof Response) return g;
  const body = (await req.json().catch(() => null)) as { ids?: unknown; items?: unknown } | null;
  const { engine } = g.rails;
  const paused = process.env.SEAL_SELLBACK_PAUSED === "1";
  if (body?.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.length > LONGEST || !body.ids.every((i) => typeof i === "string")) return json({ error: "That list isn't right.", code: "bad_list" }, 400);
    const quote = await engine.quotePayout(g.address, body.ids as string[]).catch(() => null);
    if (!quote) return json({ error: "That didn't go through. Nothing moved. Try again.", code: "unavailable" }, 503);
    if (!quote.ok) return json({ error: quote.message, code: quote.code }, 409);
    if (paused && quote.items.some((i) => i.action === "sell")) return json({ error: "Selling is paused for a moment. Your items are safe in your stash.", code: "sell_paused" }, 409);
    return json({ items: quote.items, total: quote.total });
  }
  if (!g.proven) return needsProof();
  const items = clean(body?.items);
  if (!items) return json({ error: "That list isn't right.", code: "bad_list" }, 400);
  if (paused && items.some((i) => i.action === "sell")) return json({ error: "Selling is paused for a moment. Your items are safe in your stash.", code: "sell_paused" }, 409);
  const done = await engine.requestPayout(g.address, items).catch(() => null);
  if (!done) return json({ error: "That didn't go through. Nothing moved. Try again.", code: "unavailable" }, 503);
  if (!done.ok) {
    // A token's price moves every ledger, so a stale quote gets the live one back to confirm.
    const fresh = done.code === "price_changed" ? await engine.quotePayout(g.address, items.map((i) => i.order)).catch(() => null) : null;
    return json({ error: done.message, code: done.code, ...(fresh?.ok ? { items: fresh.items, total: fresh.total } : {}) }, 409);
  }
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  followUpSoon(g.rails);
  return json({ id: done.id });
}
