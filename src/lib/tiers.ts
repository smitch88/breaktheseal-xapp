import type { TierName } from "./rails/types.ts";

export const TIER_NAMES: readonly TierName[] = ["Common", "Uncommon", "Rare", "Epic", "Chase"];
export const TIER_SYMBOL: Record<TierName, string> = { Common: "○", Uncommon: "●", Rare: "▲", Epic: "◆", Chase: "★" };
export const TIER_COLOR: Record<TierName, string> = { Common: "#dfe5ec", Uncommon: "#8fd8ff", Rare: "#ff7a1a", Epic: "#5df2b4", Chase: "#ffd91a" };
export const TIER_BG: Record<TierName, string> = { Common: "#a8d7f5", Uncommon: "#123a6b", Rare: "#d9391a", Epic: "#0c5f49", Chase: "#b98a00" };
export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
