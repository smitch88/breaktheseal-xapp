import { json, off, rails, viewerAddress } from "@/lib/rip/server";
import { publicBundle } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Where a multi order stands. Looking is what moves it forward, as with one pull. Not tied to the switch: one already bought keeps its page after the switch goes off. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = rails();
  if (!r) return off();
  const { id } = await params;
  await r.engine.advance({ minGapMs: 1500 }).catch(() => {});
  const b = r.engine.state.bundles.get(id);
  if (!b) return json({ error: "Not found." }, 404);
  return json({ bundle: publicBundle(r.engine.state, b), mine: b.address === (await viewerAddress()) });
}
