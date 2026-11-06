import { machineOnSale } from "@/config/machines";
import { payInstruction } from "@/lib/rip/instructions";
import { CONFIRM_ACCOUNT } from "@/lib/rip/engine";
import { guard, json, liveRate, needsProof, orderRefusal, recordTerms, walletRequest } from "@/lib/rip/server";
import { publicCard } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Open a card order. Priced in XRP at today's rate with a little room, and held for about five minutes. */
export async function POST(req: Request) {
  const g = await guard(req, { launch: true });
  if (g instanceof Response) return g;
  if (!g.rails.cardsOn) return json({ error: "Card packs aren't open yet.", code: "card_off" }, 409);
  const body = (await req.json().catch(() => null)) as { code?: unknown; acceptedTerms?: unknown } | null;
  const refused = orderRefusal(req, body?.acceptedTerms);
  if (refused) return refused;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^[a-z0-9_-]{1,60}$/i.test(code)) return json({ error: "That isn't a pack." }, 400);
  // The allowlist decides what's for sale, and not only what the shelf shows: a hidden pack can't be bought by naming it.
  if (!machineOnSale(process.env.SEAL_MACHINE_CODES, g.rails.mode === "mainnet", code)) return json({ error: "That pack isn't available.", code: "no_machine" }, 409);
  // The ledger or the log can't be read. Nothing has been offered to sign, so nothing can be charged.
  const made = await g.rails.engine.createCardOrder(g.address, code, await liveRate(g.rails), { unproven: !g.proven }).catch(() => null);
  if (!made) return json({ error: "That didn't go through. Nothing was charged. Try again.", code: "unavailable" }, 503);
  if (!made.ok) return made.code === CONFIRM_ACCOUNT ? needsProof() : json({ error: made.message, code: made.code }, 409);
  const unrecorded = await recordTerms(g.rails, "card", made.order.id, g.address, g.proven, !!g.rails.engine.multi);
  if (unrecorded) return unrecorded;
  const wallet = await walletRequest(req, g, made.tx, payInstruction(String(made.tx.Amount), "card", g.rails.mode), made.order.id, `/open/card_${made.order.id}`);
  return json({ order: publicCard(made.order), tx: made.tx, wallet });
}

/** The signed-in wallet's cards: everything it bought, plus any whose mirror it now holds. */
export async function GET(req: Request) {
  // A GET carries no Origin, so this one reads as same-site. It keeps the caller's own address for the rate limit.
  const g = await guard(new Request(req.url, { headers: { origin: new URL(req.url).origin, host: new URL(req.url).host, "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "" } }), { launch: true });
  if (g instanceof Response) return g;
  const { engine } = g.rails;
  await engine.advance({ minGapMs: 2000 }).catch(() => {});
  const held = new Set((await engine.chain.accountNfts(g.address).catch(() => [])).map((n) => n.nftId));
  const mine = [...engine.state.cards.values()].filter((c) => (c.mirror?.accepted ? held.has(c.mirror.nftId) : c.address === g.address) && c.status !== "quoted" && c.status !== "expired");
  return json({ cards: mine.reverse().map(publicCard) });
}
