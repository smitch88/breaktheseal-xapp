import { isNftPrice, isOffered } from "@/config/nft-packs";
import { payInstruction } from "@/lib/rip/instructions";
import { CONFIRM_ACCOUNT } from "@/lib/rip/engine";
import { guard, json, liveRate, needsProof, off, orderRefusal, rails, recordTerms, viewerAddress, walletRequest } from "@/lib/rip/server";
import { openCheckouts, publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** The checkouts the signed-in wallet can still pay. A pack that closes doesn't take away an order already held, so a closed page asks this. */
export async function GET() {
  const r = rails();
  if (!r) return off();
  const address = await viewerAddress();
  if (!address) return json({ error: "Connect a wallet first." }, 401);
  await r.engine.advance({ minGapMs: 2000 }).catch(() => {});
  const validated = await r.engine.chain.validatedLedger().catch(() => null);
  if (validated === null) return json({ error: "That didn't go through. Try again.", code: "unavailable" }, 503);
  return json({ open: openCheckouts(r.engine.state, address, validated) });
}

/** Open an order: holds a place on the pack and returns the one payment to sign. Nothing is charged here. */
export async function POST(req: Request) {
  const g = await guard(req, { launch: true });
  if (g instanceof Response) return g;
  const body = (await req.json().catch(() => null)) as { price?: unknown; acceptedTerms?: unknown } | null;
  const refused = orderRefusal(req, body?.acceptedTerms);
  if (refused) return refused;
  const price = Number(body?.price);
  if (!isNftPrice(price) || !isOffered(price)) return json({ error: "That isn't a pack." }, 400);
  const { engine } = g.rails;
  // The ledger or the log can't be read. Nothing has been offered to sign, so nothing can be charged.
  const made = await engine.createOrder(g.address, price, g.rails.mode === "mainnet" ? await liveRate(g.rails) : null, { unproven: !g.proven }).catch(() => null);
  if (!made) return json({ error: "That didn't go through. Nothing was charged. Try again.", code: "unavailable" }, 503);
  if (!made.ok) return made.code === CONFIRM_ACCOUNT ? needsProof() : json({ error: made.message, code: made.code }, 409);
  const unrecorded = await recordTerms(g.rails, "order", made.order.id, g.address, g.proven, !!engine.multi);
  if (unrecorded) return unrecorded;
  await engine.advance({ minGapMs: 2000 }).catch(() => {});
  const wallet = await walletRequest(req, g, made.tx, payInstruction(String(made.tx.Amount), "nft", g.rails.mode), made.order.id, `/open/rip_${made.order.id}`);
  return json({ order: publicOrder(engine.state, made.order), tx: made.tx, wallet });
}
