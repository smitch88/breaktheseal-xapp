import { trustInstruction } from "@/lib/rip/instructions";
import { guard, json, walletRequest } from "@/lib/rip/server";
import { publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/**
 * Redeem a token prize to the player's own wallet. The treasury pays it once, however often this is called. A wallet with no
 * trust line gets the one transaction that sets it up, for its wallet to sign, and nothing else happens: decline it and the
 * prize stays in the stash. Call again once it's signed. `poll` asks the same thing without opening a new request: an open sheet
 * uses it to move on by itself when the trust line shows up on the ledger.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { purpose: (b) => (b?.poll === true ? "read" : "act") });
  if (g instanceof Response) return g;
  const { id } = await params;
  const { engine } = g.rails;
  const body = (await req.json().catch(() => null)) as { poll?: unknown } | null;
  const done = await engine.redeem(g.address, id);
  if (!done.ok) {
    if (done.code === "needs_trustline" && "tx" in done) {
      if (body?.poll === true) return json({ needsTrustLine: true, tx: done.tx, code: done.code });
      const order = engine.state.orders.get(id);
      const token = order?.prize?.token ?? "this token";
      const wallet = await walletRequest(req, g, done.tx, trustInstruction(token), `trust-${id}`, `/collection/rip_${id}`);
      return json({ needsTrustLine: true, tx: done.tx, wallet, error: done.message, code: done.code });
    }
    return json({ error: done.message, code: done.code }, 409);
  }
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  return json({ order: publicOrder(engine.state, engine.state.orders.get(id)!) });
}
