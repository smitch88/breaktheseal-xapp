import { cardDetailsFor } from "@/lib/rip/card-details";
import { json, off, rails } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/**
 * A mirror NFT's metadata, the JSON its on-ledger URI points at. It says what the card is, where the original is held and
 * whether this mirror still stands for it. A retired mirror says so.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = rails();
  // Not tied to cardsOn: a card NFT already in a wallet keeps its details after card packs close.
  if (!r) return off();
  const { id } = await params;
  await r.engine.sync();
  const c = r.engine.state.cards.get(id);
  if (!c?.mint) return json({ error: "Not found." }, 404);
  // A mirror that once stood and is gone is retired from the burn on, while the sale or shipment finishes.
  const retired = (!c.mirror && c.everMinted > 0) || c.hold === "sold" || c.hold === "shipped" || c.hold === "ship_queue";
  const details = await cardDetailsFor(c);
  const extra = (trait_type: string, value: string | number | null | undefined) => (value === null || value === undefined ? [] : [{ trait_type, value }]);
  const metadata = json({
    schema: "ipfs://QmNpi8rcXEkohca8iXu7zysKKSJYqCvBJn3xJwga8jXqWU",
    nftType: "art.v0",
    // The on-chain name stops at 32 characters. The card's own record keeps the whole one.
    name: details?.name ?? c.name,
    description: `${details?.name ?? c.name}, ${c.grade}. Held in a third-party graded card vault. This NFT is the claim on the card while it stands: its holder can stash, ship or sell.`,
    // The vault's own direct copy when there is one: `c.img` is a 302, and how far a wallet follows a redirect isn't ours to promise.
    image: details?.front ?? c.img,
    collection: { name: "Break the Seal Cards", family: "Break the Seal" },
    attributes: [
      { trait_type: "Grade", value: c.grade },
      ...extra("Grading company", details?.grader),
      ...extra("Cert number", details?.cert),
      ...extra("Set", details?.set),
      ...extra("Year", details?.year),
      ...extra("Card number", details?.number),
      ...extra("Category", details?.category),
      ...extra("Back image", details?.back),
      { trait_type: "Rarity", value: c.rarity },
      { trait_type: "Listed value USD", value: Number(c.insuredMicro) / 1e6 },
      { trait_type: "Solana original", value: c.mint },
      { trait_type: "Custody proof", value: c.proof },
      ...extra("Custody checked", c.proofAt),
      { trait_type: "Status", value: retired ? "Retired" : "Active" },
    ],
  });
  // Wallets and markets may fetch this from a browser page. It's public, and it's the same to everyone.
  metadata.headers.set("Access-Control-Allow-Origin", "*");
  return metadata;
}
