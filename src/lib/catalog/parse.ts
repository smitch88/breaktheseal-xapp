import { displayName, categoryOf, uniqueNames } from "./names.ts";
import { CARD_TIERS, type BandCounts, type CardRarity, type Item, type ItemsPage, type Machine } from "./types.ts";
import { tidy } from "../format.ts";

/** Hosts next.config.mjs lets next/image load. Anything else is dropped here, so a host change cannot crash a page. */
export const ALLOWED_IMAGE_HOSTS: readonly string[] = ["d1xpxki1g4htqu.cloudfront.net"];
export const MACHINE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

export class SourceFormatError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

function parseMachine(row: unknown): Omit<Machine, "fan"> | null {
  if (!isRecord(row)) return null;
  const code = typeof row.code === "string" ? row.code : "";
  if (!MACHINE_CODE.test(code)) return null;
  const price = num(row.price);
  if (price === null || price <= 0) return null;
  if (!isRecord(row.odds)) return null;
  const odds = row.odds;
  const parts = CARD_TIERS.map((t) => num(odds[t]) ?? 0);
  if (parts.some((p) => p < 0)) return null;
  const sum = parts.reduce((a, b) => a + b, 0);
  // A machine without usable rarity rates cannot be shown honestly.
  if (sum < 0.99 || sum > 1.01) return null;
  const stockIn = isRecord(row.stock) ? row.stock : {};
  const stock = Object.values(stockIn).reduce<number>((a, v) => a + Math.max(0, num(v) ?? 0), 0);
  const bands = Object.fromEntries(CARD_TIERS.map((t) => [t, Math.max(0, num(stockIn[t]) ?? 0)])) as unknown as BandCounts;
  const rawName = typeof row.name === "string" && row.name.trim() ? row.name.trim() : code;
  const bb = num(row.instantBuyback);
  return {
    code,
    name: displayName(code, rawName, price),
    cat: categoryOf(code, rawName),
    price,
    bb: bb !== null && bb > 0 && bb <= 100 ? bb : 85,
    rates: [round2(parts[0] * 100), round2(parts[1] * 100), round2(parts[2] * 100), round2(parts[3] * 100)],
    stock,
    bands,
  };
}

/** Sold-out packs last, then lowest price first. */
export function sortMachines<T extends { stock: number; price: number; name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(a.stock === 0) - Number(b.stock === 0) || a.price - b.price || a.name.localeCompare(b.name));
}

/** Parse GET /api/machines. Bad rows are skipped. A payload with no usable row at all is an error, never an empty store. */
export function parseMachines(payload: unknown): Omit<Machine, "fan">[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) ? payload.machines : null;
  if (!Array.isArray(rows)) throw new SourceFormatError("machines: not a list");
  const parsed = rows.map(parseMachine).filter((m): m is Omit<Machine, "fan"> => m !== null);
  if (!parsed.length) throw new SourceFormatError("machines: no usable rows");
  const seen = new Set<string>();
  const unique = parsed.filter((m) => !seen.has(m.code) && seen.add(m.code));
  return sortMachines(uniqueNames(unique));
}

/** The card source's own name never shows on a page: a vault that carries it is left out, and so is its row. Any other vault reads as given. */
export const vaultName = (v: string | null | undefined): string | undefined => (v && !/collector\s*crypt/i.test(v) ? v : undefined);

export function allowedImage(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_IMAGE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function parseItem(row: unknown, code: string): Item | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : typeof row.nft_address === "string" ? row.nft_address : "";
  if (!id) return null;
  const rarity = row.rarity as CardRarity;
  if (!CARD_TIERS.includes(rarity)) return null;
  if (!allowedImage(row.image)) return null;
  const attrs = new Map<string, unknown>();
  if (Array.isArray(row.attributes)) for (const a of row.attributes) if (isRecord(a) && typeof a.trait_type === "string") attrs.set(a.trait_type, a.value);
  const ins = num(row.insured_value) ?? num(attrs.get("Insured Value"));
  if (ins === null || ins <= 0) return null;
  const text = typeof row.description === "string" && row.description.trim() ? row.description : typeof row.name === "string" ? row.name : "";
  const name = tidy(text);
  if (!name) return null;
  const grade = tidy(`${attrs.get("Grading Company") ?? ""} ${attrs.get("The Grade") ?? ""}`);
  const said = (v: unknown) => (typeof v === "string" && v.trim() ? tidy(v) : undefined);
  const files = isRecord(row.content) && Array.isArray(row.content.files) ? row.content.files : [];
  const backFile = isRecord(files[1]) ? files[1].cc_cdn : undefined;
  const extras = {
    back: allowedImage(backFile) && backFile !== row.image ? backFile : undefined,
    grader: said(attrs.get("Grading Company")),
    gradeName: said(attrs.get("The Grade")),
    cert: said(attrs.get("Grading ID")),
    category: said(attrs.get("Category")),
    year: said(attrs.get("Year")) ?? said(row.cardYear),
    parallel: said(row.parallel),
    population: num(row.gradePopulation) ?? undefined,
    vault: vaultName(said(attrs.get("Vault"))),
  };
  return { id, name, rarity, ins, grade: grade || "Not graded", img: row.image, code, ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)) };
}

/** One page of GET /api/getNfts. The cursor is the source's own, opaque and passed back as it came. */
export function parseItemsPage(payload: unknown, code: string): ItemsPage {
  const items = parseItems(payload, code);
  const { hasMore, nextCursor } = payload as { hasMore?: unknown; nextCursor?: unknown };
  return { items, nextCursor: hasMore === true && typeof nextCursor === "string" && nextCursor ? nextCursor : null };
}

/** Parse GET /api/getNfts. Rows missing identity, tier, a value or an allowed image are skipped. */
export function parseItems(payload: unknown, code: string): Item[] {
  if (!isRecord(payload) || !Array.isArray(payload.nfts)) throw new SourceFormatError("getNfts: not a list");
  const items = payload.nfts.map((n) => parseItem(n, code)).filter((i): i is Item => i !== null);
  return [...new Map(items.map((i) => [i.id, i])).values()];
}
