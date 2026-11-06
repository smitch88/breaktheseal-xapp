import { json, off, rails, viewerAddress } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** How many offers are waiting on this wallet. Read from the log alone, with no ledger call, so a header can ask on every page. */
export async function GET() {
  const r = rails();
  if (!r) return off();
  const address = await viewerAddress();
  if (!address) return json({ error: "Connect a wallet first." }, 401);
  await r.engine.sync();
  const { orders, cards } = r.engine.state;
  const count = [...orders.values()].filter((o) => o.address === address && o.pull === "offered").length + [...cards.values()].filter((c) => c.address === address && c.hold === "offered").length;
  return json({ count });
}
