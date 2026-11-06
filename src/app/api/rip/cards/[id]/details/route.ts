import { cardDetailsFor } from "@/lib/rip/card-details";
import { json, off, rails } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** What Collector Crypt says this card is: public facts, read at view time and cached, so the log and its replay stay as they were. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = rails();
  if (!r) return off();
  const { id } = await params;
  await r.engine.sync();
  const c = r.engine.state.cards.get(id);
  if (!c?.mint) return json({ error: "Not found." }, 404);
  return json({ details: await cardDetailsFor(c) });
}
