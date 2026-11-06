import { CATEGORY_ORDER } from "../lib/catalog/names.ts";

export const chipList = (cats: readonly string[]) => ["All", "NFT Packs", ...CATEGORY_ORDER.filter((k) => cats.includes(k))];
