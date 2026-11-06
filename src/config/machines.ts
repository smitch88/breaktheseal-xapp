/**
 * Which pack machines the site shows. Reads need no API key. A partner key's adopted machines can replace these later
 * without code changes elsewhere: set SEAL_MACHINE_CODES to a comma-separated allowlist, and the featured lists below
 * skip any code that is not live.
 */
export const FEATURED_CODES: readonly string[] = ["pokemon_25", "onepiece_50", "anime_75", "sports_100", "basketball_100", "baseball_100", "comic_50", "ewatch_250", "lorcana_50", "dragonball_100", "ghost_50", "riftbound_100"];
export const SHOWCASE_CODES: readonly string[] = ["pokemon_25", "onepiece_50", "basketball_100", "ewatch_250", "dragonball_100", "comic_50", "lorcana_50", "sports_100"];

/** A comma-separated allowlist, or null to show every live machine. */
export function parseAllowlist(raw: string | undefined | null): ReadonlySet<string> | null {
  const codes = (raw ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  return codes.length ? new Set(codes) : null;
}

/**
 * May this machine be bought? On mainnet only a pack on the list can be: an empty or missing list closes the card line rather
 * than opening every machine Collector Crypt has. Testnet's simulated source has no list to keep.
 */
export const machineOnSale = (raw: string | undefined | null, mainnet: boolean, code: string): boolean => {
  const allow = parseAllowlist(raw);
  return allow ? allow.has(code) : !mainnet;
};
