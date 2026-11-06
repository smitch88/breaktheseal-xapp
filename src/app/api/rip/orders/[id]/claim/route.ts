import { acceptInstruction } from "@/lib/rip/instructions";
import { CONFIRM_ACCOUNT } from "@/lib/rip/engine";
import { guard, json, needsProof, offerGone, walletRequest } from "@/lib/rip/server";
import { publicOrder } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/**
 * Claim: the vault makes a free offer that only this wallet can take, then the wallet accepts it. Call again once the
 * offer is on the ledger to get the transaction to sign. A launch alone can only get that transaction: the vault makes an offer
 * with no signature from the wallet, so starting one takes a confirmed account.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { launch: true });
  if (g instanceof Response) return g;
  const { id } = await params;
  const { engine } = g.rails;
  const done = await engine.claim(g.address, id, g.proven);
  if (!done.ok) return done.code === CONFIRM_ACCOUNT ? needsProof() : json({ error: done.message, code: done.code }, 409);
  await engine.advance({ minGapMs: 500 }).catch(() => {});
  const order = engine.state.orders.get(id)!;
  if (order.pull !== "offered" || !order.offerId) return json({ order: publicOrder(engine.state, order), tx: null, wallet: null });
  if (await offerGone(g.rails, order.offerId)) {
    // Gone because the wallet just took it: the next look at the ledger says so. Otherwise it was cancelled, and only taking it back gets it home.
    const held = await engine.chain.accountNfts(g.address).catch(() => []);
    if (order.nftId && held.some((n) => n.nftId === order.nftId)) return json({ order: publicOrder(engine.state, order), tx: null, wallet: null });
    return json({ error: "That offer isn't on the ledger anymore, so there's nothing to accept. Take it back and it goes back in your stash.", code: "offer_gone" }, 409);
  }
  const tx = { TransactionType: "NFTokenAcceptOffer", Account: g.address, NFTokenSellOffer: order.offerId };
  const wallet = await walletRequest(req, g, tx, acceptInstruction("nft", g.rails.mode), `claim-${id}`, `/collection/rip_${id}`);
  return json({ order: publicOrder(engine.state, order), tx, wallet });
}
