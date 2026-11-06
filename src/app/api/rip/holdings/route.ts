import { json, learnArt, off, rails, viewerAddress } from "@/lib/rip/server";
import { publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** The signed-in wallet's pulls. */
export async function GET() {
  const r = rails();
  if (!r) return off();
  const address = await viewerAddress();
  if (!address) return json({ error: "Connect a wallet first." }, 401);
  await r.engine.advance({ minGapMs: 2000 }).catch(() => {});
  await learnArt(r);
  const orders = [...r.engine.state.orders.values()].filter((o) => o.address === address && (o.status === "drawn" || o.status === "paid" || o.status === "refund_due" || o.status === "refunded"));
  return json({ orders: orders.reverse().map((o) => publicOrder(r.engine.state, o)) });
}
