/** The ticker's arithmetic. Every card is the same width, so a position is just a slot number times the pitch. */
export const RING_CAP = 36;

/** "3m ago", "2h ago", "5d ago". */
export function timeAgo(at: string, now: number): string {
  const min = Math.floor((now - Date.parse(at)) / 60_000);
  if (!(min >= 1)) return "1m ago";
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}

/** Scroll only when there's more than a screen of real pulls. A few sit still, and a pull never shows twice at once, so the row can't pass for busier than it is. */
export const loops = (count: number, pitch: number, view: number) => pitch > 0 && view > 0 && count * pitch >= view + pitch;

export interface RingView {
  readonly offset: number;
  readonly pitch: number;
  readonly view: number;
  readonly looping: boolean;
}

/**
 * Bring a new read of the feed into what's on screen, without moving any card someone can see. A still row takes a new pull at the front. A moving row is the
 * pulls twice over, so a new pull goes in the slot just past the right edge, and comes into view next. If that slot is in the second copy, everything on screen
 * shifts by one slot together, and so does the offset. Pulls already there stay, however old: the ring never drops one that's on screen.
 */
export function placeArrivals<T extends { readonly key: string }>(ring: readonly T[], feed: readonly T[], at: RingView): { ring: T[]; offset: number; fresh: string[] } {
  const known = new Set(ring.map((p) => p.key));
  const fresh = feed.filter((p) => !known.has(p.key));
  const next = [...ring];
  let offset = at.offset;
  for (const p of [...fresh].reverse()) {
    if (!at.looping) {
      next.unshift(p);
      if (next.length > RING_CAP) next.pop();
      continue;
    }
    const slot = Math.ceil((offset + at.view) / at.pitch);
    const n = next.length;
    if (n >= RING_CAP) next[slot % n] = p;
    else if (slot <= n) next.splice(slot, 0, p);
    else {
      next.splice(slot - n, 0, p);
      offset += at.pitch;
    }
  }
  return { ring: next, offset, fresh: fresh.map((p) => p.key) };
}
