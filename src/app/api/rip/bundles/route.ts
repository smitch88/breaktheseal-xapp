import { isNftPrice, isOffered } from "@/config/nft-packs";
import { machineOnSale } from "@/config/machines";
import { CONFIRM_ACCOUNT } from "@/lib/rip/engine";
import { payManyInstruction } from "@/lib/rip/instructions";
import { guard, json, liveRate, needsProof, off, orderRefusal, rails, recordTerms, viewerAddress, walletRequest } from "@/lib/rip/server";
import { publicBundle } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** The multi order this wallet can still pay, if it has one, so a reload or a closed sheet can find its way back to it. Off with the switch. */
export async function GET(req: Request) {
  const r = rails();
  if (!r?.engine.multi) return off();
  const address = await viewerAddress();
  if (!address) return json({ error: "Connect a wallet first." }, 401);
  const q = new URL(req.url).searchParams;
  const price = Number(q.get("price"));
  const code = q.get("code");
  const open = await r.engine.openBundle(address, { ...(Number.isFinite(price) && price > 0 ? { price } : {}), ...(code ? { code } : {}) }).catch(() => null);
  return json({ open: open ? publicBundle(r.engine.state, open.bundle) : null });
}

/**
 * Open a multi order: holds its places and returns the one payment to sign. Nothing is charged here. The server decides how many it can
 * take: over that it says how many, and nothing is held. With the switch off this route doesn't exist. Inside Xaman a launch can open one with no extra step, within the
 * same limits as a single hold, because paying still takes the wallet's own signature. Past them the player confirms their account.
 */
export async function POST(req: Request) {
  if (!rails()?.engine.multi) return off();
  const g = await guard(req, { launch: true });
  if (g instanceof Response) return g;
  const body = (await req.json().catch(() => null)) as { price?: unknown; code?: unknown; qty?: unknown; acceptedTerms?: unknown } | null;
  const refused = orderRefusal(req, body?.acceptedTerms);
  if (refused) return refused;
  const qty = Number(body?.qty);
  const { engine } = g.rails;
  const unproven = !g.proven;
  let made: Awaited<ReturnType<typeof engine.createBundle>> | null;
  if (typeof body?.code === "string") {
    if (!g.rails.cardsOn) return json({ error: "Card packs aren't open yet.", code: "card_off" }, 409);
    const code = body.code;
    if (!/^[a-z0-9_-]{1,60}$/i.test(code)) return json({ error: "That isn't a pack." }, 400);
    if (!machineOnSale(process.env.SEAL_MACHINE_CODES, g.rails.mode === "mainnet", code)) return json({ error: "That pack isn't available.", code: "no_machine" }, 409);
    made = await engine.createCardBundle(g.address, code, qty, await liveRate(g.rails), { unproven }).catch(() => null);
  } else {
    const price = Number(body?.price);
    if (!isNftPrice(price) || !isOffered(price)) return json({ error: "That isn't a pack." }, 400);
    made = await engine.createBundle(g.address, price, qty, g.rails.mode === "mainnet" ? await liveRate(g.rails) : null, { unproven }).catch(() => null);
  }
  // The ledger or the log can't be read. Nothing has been offered to sign, so nothing can be charged.
  if (!made) return json({ error: "That didn't go through. Nothing was charged. Try again.", code: "unavailable" }, 503);
  if (!made.ok) {
    if (made.code === CONFIRM_ACCOUNT) return needsProof();
    // An open checkout is the one thing a player can act on: it comes back with the refusal, so the page can show it and offer to pay it.
    const open = made.code === "open_checkout" ? await engine.openBundle(g.address, { ...(typeof body?.code === "string" ? { code: body.code } : { price: Number(body?.price) }), provenOnly: g.proven }).catch(() => null) : null;
    return json({ error: made.message, code: made.code, ...("max" in made ? { max: made.max } : {}), ...(open ? { open: publicBundle(engine.state, open.bundle) } : {}) }, 409);
  }
  const unrecorded = await recordTerms(g.rails, made.bundle.kind === "nft" ? "order" : "card", made.bundle.id, g.address, g.proven, true);
  if (unrecorded) return unrecorded;
  await engine.advance({ minGapMs: 2000 }).catch(() => {});
  const wallet = await walletRequest(req, g, made.tx, payManyInstruction(made.bundle.drops, made.bundle.qty, made.bundle.kind, g.rails.mode), made.bundle.id, `/open/multi_${made.bundle.id}`);
  return json({ bundle: publicBundle(engine.state, made.bundle), tx: made.tx, wallet });
}
