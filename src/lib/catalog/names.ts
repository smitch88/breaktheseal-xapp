/**
 * Plain display names and categories for pack machines. The source hands us raw codes and other brands' names on many
 * machines. This keeps the rules from the approved concept (build_data.py): a raw code or a foreign brand becomes
 * "<Category> Select $<price>", the rest only lose the "Gacha" wording, and duplicates get "No. 2".
 */
const CATEGORY_RULES: readonly (readonly [string, string])[] = [
  ["watch", "Watches"], ["comic", "Comics"], ["edc_", "Comics"], ["espider", "Comics"], ["lorcana", "Lorcana"], ["riftbound", "Riftbound"],
  ["dragonball", "Dragon Ball"], ["onepiece", "One Piece"], ["_op", "One Piece"], ["one piece", "One Piece"], ["basketball", "Basketball"],
  ["baseball", "Baseball"], ["football", "Football"], ["soccer", "Soccer"], ["sports", "Sports"], ["sealed", "Sealed"], ["anime", "Anime"],
  ["spook", "Halloween"], ["ghost", "Halloween"], ["halloween", "Halloween"], ["poke", "Pokémon"], ["gengar", "Pokémon"], ["e10_", "Pokémon"],
  ["charizard", "Pokémon"], ["pika", "Pokémon"], ["mew", "Pokémon"], ["lugia", "Pokémon"], ["eevee", "Pokémon"], ["rayquaza", "Pokémon"],
  ["goldstar", "Pokémon"], ["trainer", "Pokémon"], ["japanese", "Pokémon"], ["electric", "Pokémon"], ["fire", "Pokémon"], ["water", "Pokémon"],
  ["pinkblue", "Pokémon"], ["vintage", "Pokémon"], ["v90s", "Pokémon"], ["solana", "Exclusive"], ["degen", "Exclusive"], ["multisports", "Sports"],
];

/** Category chip order, from the concept. */
export const CATEGORY_ORDER = ["Pokémon", "One Piece", "Anime", "Dragon Ball", "Lorcana", "Riftbound", "Sports", "Basketball", "Baseball", "Football", "Soccer", "Comics", "Watches", "Halloween", "Sealed", "Exclusive"] as const;

export function categoryOf(code: string, rawName: string): string {
  const s = `${code} ${rawName}`.toLowerCase();
  for (const [needle, cat] of CATEGORY_RULES) if (s.includes(needle)) return cat;
  return "Exclusive";
}

/** Other brands' names never reach the page, and neither do names that talk about "EV". */
export const FOREIGN_NAME = /(infinex|solflare|rarible|jup|fee builder|primate|dboy|\bsns\b|\bev\b)/i;
const RAW_CODE = /^(bf_|fb_|ejup|espooky|pokewatch|ewatches_|eopoke)/;

export function isRawName(code: string, rawName: string): boolean {
  return RAW_CODE.test(code) || rawName === code || FOREIGN_NAME.test(rawName);
}

export function displayName(code: string, rawName: string, price: number): string {
  const raw = (rawName || code).trim();
  const cat = categoryOf(code, raw);
  const base = isRawName(code, raw) ? `${cat} Select $${price}` : raw;
  const clean = base.replace(/\s+/g, " ").replace("Gacha Pack", "Pack").replace(/ Gacha/g, "").replace(/\bexclusive /, "Exclusive ").replace(/vintange/i, "vintage").trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Give each repeated name a stable "No. n". Order is by price then code, so API row order cannot swap the numbers. */
export function uniqueNames<T extends { code: string; name: string; price: number }>(rows: readonly T[]): T[] {
  const ordered = [...rows].sort((a, b) => a.price - b.price || (a.code < b.code ? -1 : 1));
  const taken = new Set<string>();
  const counts = new Map<string, number>();
  const renamed = new Map<string, string>();
  for (const row of ordered) {
    const n = (counts.get(row.name) ?? 0) + 1;
    counts.set(row.name, n);
    let name = n === 1 ? row.name : `${row.name} No. ${n}`;
    for (let i = n + 1; taken.has(name); i++) name = `${row.name} No. ${i}`;
    taken.add(name);
    renamed.set(row.code, name);
  }
  return rows.map((row) => ({ ...row, name: renamed.get(row.code) ?? row.name }));
}
