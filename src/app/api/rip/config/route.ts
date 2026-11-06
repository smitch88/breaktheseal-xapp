import { SHELF_PRICES } from "@/config/nft-packs";
import { json, liveRate, rails, railsMode, recentLedger } from "@/lib/rip/server";
import { tierView } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/** Which rails are on and which packs can be opened. In demo mode it says so and nothing else. */
export async function GET() {
  const r = rails();
  if (!r) return json({ mode: railsMode(), tiers: [] });
  await r.engine.advance({ minGapMs: 3000 }).catch(() => {});
  // A node error reads as closed: every pack shows closed until a read works again.
  const ledger = await recentLedger(r).catch(() => null);
  // A pack a checkout would refuse doesn't read as open, and neither does one that can't be checked.
  const closed = ledger === null ? undefined : await r.engine.closedPacks(ledger, () => liveRate(r)).catch(() => new Set(SHELF_PRICES));
  // Only with the switch on: with it off, this answer is what it always was.
  const rooms = r.engine.multi && ledger !== null ? await r.engine.quantityRooms(ledger, () => liveRate(r)).catch(() => ({} as Readonly<Record<string, number>>)) : null;
  const multi = r.engine.multi && rooms ? { max: r.engine.multi.max, cardMax: r.engine.multi.cardMax, room: Object.fromEntries(SHELF_PRICES.map((p) => [p, rooms[String(p)] ?? 0])) } : null;
  return json({ mode: r.mode, treasury: r.treasury, vault: r.vault, cardsOn: r.cardsOn, tiers: SHELF_PRICES.map((p) => tierView(r.engine.state, p, ledger, closed)), ...(multi ? { multi } : {}) });
}
