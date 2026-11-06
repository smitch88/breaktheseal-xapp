/** What the Packs page shows for a category, a search and a sort. */
export type PackSort = "price" | "high" | "stock";
export const DEFAULT_SORT: PackSort = "price";
export const ALL = "All";
export const NFT_CATEGORY = "NFT Packs";
export const SORT_LABEL: Record<PackSort, string> = { price: "Lowest price", high: "Highest price", stock: "Most in stock" };
export const NEXT_SORT: Record<PackSort, PackSort> = { price: "high", high: "stock", stock: "price" };

type Row = { readonly name: string; readonly cat: string; readonly price: number; readonly stock: number };
export type PackFilter = { readonly cat: string; readonly query: string; readonly sort: PackSort };

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const hit = (haystack: string, query: string) => norm(haystack).includes(norm(query.trim()));

export function filterPacks<T extends Row>(rows: readonly T[], { cat, query, sort }: PackFilter): readonly T[] {
  if (cat === NFT_CATEGORY) return [];
  const kept = rows.filter((m) => (cat === ALL || m.cat === cat) && hit(`${m.name} ${m.cat}`, query));
  if (sort === "high") return [...kept].sort((a, b) => b.price - a.price);
  if (sort === "stock") return [...kept].sort((a, b) => b.stock - a.stock);
  return kept;
}

/** NFT packs come cheapest first. They have no stock count to sort on, so Most in stock leaves them in price order. */
export function filterNftPacks<T extends { readonly name: string; readonly price?: number }>(rows: readonly T[], { cat, query, sort }: PackFilter): readonly T[] {
  if (cat !== ALL && cat !== NFT_CATEGORY) return [];
  const kept = rows.filter((n) => hit(`${n.name} XRPL NFT`, query));
  return sort === "high" ? [...kept].sort((a, b) => (b.price ?? 0) - (a.price ?? 0)) : kept;
}

/**
 * The number on the phone's Filters button. A search has its own field, so it doesn't count. Where Sort has its own button beside
 * Filters, as in the xApp, the sort doesn't count either: that button already says it.
 */
export const activeFilters = ({ cat, sort }: Pick<PackFilter, "cat" | "sort">, sortApart = false) => (cat === ALL ? 0 : 1) + (sortApart || sort === DEFAULT_SORT ? 0 : 1);
/** The packs a filter shows, NFT and card together, for the sheet's "Show N packs". Card packs aren't counted where they aren't on the shelf. */
export const shownCount = (nft: number, cards: number, cardsShown: boolean) => nft + (cardsShown ? cards : 0);
