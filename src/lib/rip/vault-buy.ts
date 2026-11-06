/**
 * How the vault reads a listing and what it will pay, in one place: the owner's deploy/11-vault-buy.mjs and the engine's own buyer both come here.
 * Nothing in this file touches a network or a key.
 */

/**
 * The marketplaces whose listings the vault can buy from a script, with what they charge on top of the list price. A listing's Destination
 * is the only account that can accept it, so a broker that's not here is a listing the vault can't buy.
 *   xrp.cafe: 1.589%, its published fee. 101 of its last 123 sales filled 2 ledgers after the buy offer, 8 of them from outside its site.
 *   BIDDS (onXRP): 0.01%, read from its last 50 sales. Its site's offers and Bithomp's fill in 2 to 3 ledgers. No untagged offer has yet.
 */
export const BROKERS: Readonly<Record<string, { readonly name: string; readonly per100k: number }>> = {
  rpx9JThQ2y37FaGeeJP7PXDUVEXY3PHZSC: { name: "xrp.cafe", per100k: 1589 },
  rpZqTPC8GvrSvEfFsUuHkmPCg29GdQuXhC: { name: "BIDDS", per100k: 10 },
};

const RIPPLE_EPOCH = 946684800;
export const rippleTime = (ms = Date.now()) => Math.floor(ms / 1000) - RIPPLE_EPOCH;

/** What a buyer pays for a listing: rounded up, because the broker's fee has to fit. A drop or two over goes to the seller, never to the broker. */
export const allInDrops = (listDrops: string | number, destination: string | null | undefined) => {
  const list = Number(listDrops);
  return destination ? list + Math.ceil((list * BROKERS[destination].per100k) / 100000) : list;
};

/** One sell offer, as the ledger's nft_sell_offers reports it. */
export interface SellOffer {
  readonly nft_offer_index?: string;
  readonly amount?: unknown;
  readonly owner?: string;
  readonly destination?: string;
  readonly expiration?: number;
}

export interface Listing {
  readonly offerIndex: string | undefined;
  readonly listDrops: number;
  readonly allInDrops: number;
  readonly route: "direct" | "broker";
  readonly broker: string | null;
  readonly via: string;
  readonly seller: string | null;
}

/**
 * The listing to buy, from every sell offer on an NFT. Only the holder's offers count: a sell offer outlives a sale, so an old owner's can
 * sit there at any price and can never fill. Null when nothing can be bought. `manual` is a live listing behind a broker the vault can't use.
 */
export function bestListing(offers: readonly SellOffer[] | null | undefined, holder: string | null | undefined, buyer: string, nowRipple = rippleTime()): { best: Listing | null; manual: { listDrops: number; destination: string | undefined } | null; stale: number } {
  const live = (offers ?? []).filter((o) => typeof o.amount === "string" && Number(o.amount) > 0 && (!holder || !o.owner || o.owner === holder) && !(o.expiration && o.expiration <= nowRipple + 60));
  const stale = (offers ?? []).filter((o) => typeof o.amount === "string" && Number(o.amount) > 0 && holder && o.owner && o.owner !== holder).length;
  const can = live.filter((o) => !o.destination || o.destination === buyer || BROKERS[o.destination]);
  const shape = (o: SellOffer): Listing => {
    const destination = o.destination && o.destination !== buyer ? o.destination : null;
    return { offerIndex: o.nft_offer_index, listDrops: Number(o.amount), allInDrops: allInDrops(o.amount as string, destination), route: destination ? "broker" : "direct", broker: destination, via: destination ? BROKERS[destination].name : "direct", seller: o.owner ?? holder ?? null };
  };
  const best = can.map(shape).sort((a, b) => a.allInDrops - b.allInDrops)[0] ?? null;
  const other = live.filter((o) => !can.includes(o)).sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  return { best, manual: other ? { listDrops: Number(other.amount), destination: other.destination } : null, stale };
}

/** The stop-buying rule on one listing: "STOP" past the line, "ok" under it, nothing if it can't be priced. `still` is 06's "12.5 XRP". */
export function stopVerdict(still: unknown, listedXrp: number, stopPct: number): string {
  const m = /^([0-9.]+) XRP$/.exec(String(still));
  if (!m || !(listedXrp > 0)) return "";
  const over = (Number(m[1]) / listedXrp - 1) * 100;
  return over > stopPct ? `STOP +${over.toFixed(1)}%` : "ok";
}

/** Why the vault won't pay this, or null. The stop line is on the list price against the plan's, as 06 reads it; the caps are on what's really paid. */
export function buyRefusal({ listDrops, allIn, plannedXrp, stopPct, capXrp = null, maxXrp = null }: { listDrops: number; allIn: number; plannedXrp: number; stopPct: number; capXrp?: number | null; maxXrp?: number | null }): string | null {
  const paid = allIn / 1e6;
  if (capXrp !== null && paid > capXrp) return `${paid} XRP is over this NFT's cap of ${capXrp}`;
  if (maxXrp !== null && paid > maxXrp) return `${paid} XRP is over --max-xrp ${maxXrp}`;
  const verdict = stopVerdict(`${listDrops / 1e6} XRP`, plannedXrp, stopPct);
  return verdict.startsWith("STOP") ? `${listDrops / 1e6} XRP listed against ${plannedXrp} planned: ${verdict}, past the stop line` : null;
}
