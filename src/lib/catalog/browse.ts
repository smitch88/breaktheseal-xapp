import type { BandCounts, CardRarity, Item } from "./types.ts";

export type BandFilter = "All" | CardRarity;

const n = (v: number) => v.toLocaleString("en-US");

/** The real count for a filter, from the machine's own stock. Null if a saved copy doesn't say. */
export function bandTotal(m: { readonly stock: number; readonly bands?: BandCounts }, filter: BandFilter): number | null {
  return filter === "All" ? m.stock : m.bands?.[filter] ?? null;
}

export const totalLine = (total: number) => (total === 0 ? "No cards in this pack right now" : `${n(total)} ${total === 1 ? "card" : "cards"} in this pack`);

/** A page can repeat a card if the list moved between reads, as packs open. Each shows once, where it first came. */
export function mergePage<T extends Pick<Item, "id">>(have: readonly T[], page: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...have, ...page].filter((i) => !seen.has(i.id) && seen.add(i.id));
}

/**
 * The count and the list are read apart, so they can differ by a card or two, and a row we can't show is left out. This says what's on
 * the screen against the source's own count, and it never reads as more of them than there are.
 */
export function showingText(shown: number, total: number | null, more: boolean): string {
  if (more) return total !== null && shown <= total ? `Showing ${n(shown)} of ${n(total)}` : `Showing ${n(shown)}`;
  if (total !== null && shown < total * 0.9) return `That's all ${n(shown)} we can read right now`;
  return `That's all ${n(shown)}`;
}
