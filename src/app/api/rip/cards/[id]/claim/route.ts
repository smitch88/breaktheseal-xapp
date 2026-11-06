import { acceptInstruction } from "@/lib/rip/instructions";
import { CONFIRM_ACCOUNT } from "@/lib/rip/engine";
import { guard, json, needsProof, offerGone, walletRequest } from "@/lib/rip/server";
import { publicCard } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Claim as a mirror NFT. Custody is re-proven, then one transaction mints it with a free offer only this wallet can take. A launch alone can only accept one already open. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { launch: true });
  if (g instanceof Response) return g;
  const { id } = await params;
  const { engine } = g.rails;
  const done = await engine.claimCard(g.address, id, g.proven);
  if (!done.ok) return done.code === CONFIRM_ACCOUNT ? needsProof() : json({ error: done.message, code: done.code }, 409);
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  const c = engine.state.cards.get(id)!;
  if (c.hold !== "offered" || !c.mirror) return json({ order: publicCard(c), tx: null, wallet: null });
  if (await offerGone(g.rails, c.mirror.offerId)) {
    const { nftId } = c.mirror;
    const held = await engine.chain.accountNfts(g.address).catch(() => []);
    if (held.some((n) => n.nftId === nftId)) return json({ order: publicCard(c), tx: null, wallet: null });
    return json({ error: "That offer isn't on the ledger anymore, so there's nothing to accept. Your card is safe: take it back into your stash, or sell or ship it.", code: "offer_gone" }, 409);
  }
  const tx = { TransactionType: "NFTokenAcceptOffer", Account: g.address, NFTokenSellOffer: c.mirror.offerId };
  const wallet = await walletRequest(req, g, tx, acceptInstruction("card", g.rails.mode), `mirror-${id}`, `/collection/card_${id}`);
  return json({ order: publicCard(c), tx, wallet });
}
