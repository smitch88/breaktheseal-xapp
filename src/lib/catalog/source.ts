import { MACHINE_CODE, parseItems, parseItemsPage, parseMachines, sortMachines } from "./parse.ts";
import { CARD_TIERS, type CardRarity, type CatalogView, type Item, type ItemsPage, type ItemsView, type Machine } from "./types.ts";

/**
 * Read-only source for the public pack API. It only knows two GET routes, and the wiring in server.ts gives every
 * request a shared cache (Next data cache: stale copy served at once, one background refresh per window), so a page
 * view never turns into a call to the source. When the source is down we serve the checked-in snapshot and say so.
 */
export const SOURCE_ORIGIN = "https://gacha.collectorcrypt.com";
export const READ_ROUTES = ["/api/machines", "/api/getNfts"] as const;

export const CATALOG_TTL_S = 60;
export const ITEMS_TTL_S = 300;
export const FAN_TTL_S = 6 * 3600;
export const PAGE_SIZE = 24;

/** A cached GET. `ttl` is how long a copy counts as fresh. */
export type CachedGet = (url: string, ttl: number) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CatalogSnapshot {
  readonly asOf: string;
  readonly machines: readonly Machine[];
}

export interface CatalogSource {
  catalog(): Promise<CatalogView>;
  machine(code: string): Promise<{ machine: Machine | null; stale: boolean; asOf: string }>;
  /** Live items in one tier of a pack, falling back to the snapshot fan. */
  items(code: string, rarity: CardRarity, limit?: number): Promise<ItemsView>;
  /** One page of what's really in a pack, highest value first, the only order the source has. A failure throws: no saved list stands in for it. */
  page(code: string, rarity: CardRarity | null, cursor: string | null): Promise<ItemsPage>;
  /** Every tier of a pack. */
  pool(code: string): Promise<ItemsView>;
  /** Top three real items for each machine's fan, in the time allowed; the rest keep their snapshot fan. */
  withFans(machines: readonly Machine[], deadlineMs?: number): Promise<Machine[]>;
}

export function assertReadRoute(url: string): void {
  const u = new URL(url);
  if (u.origin !== SOURCE_ORIGIN || !(READ_ROUTES as readonly string[]).includes(u.pathname)) throw new Error(`Refusing non-read route ${u.pathname}`);
}

export function createCatalogSource(get: CachedGet, snapshot: CatalogSnapshot, allow: ReadonlySet<string> | null = null): CatalogSource {
  const allowed = (m: Machine) => !allow || allow.has(m.code);
  const snapMachine = (code: string) => snapshot.machines.find((m) => m.code === code) ?? null;
  const read = async (url: string, ttl: number): Promise<unknown> => {
    assertReadRoute(url);
    const res = await get(url, ttl);
    if (!res.ok) throw new Error(`source ${res.status}`);
    return res.json();
  };

  const catalog = async (): Promise<CatalogView> => {
    try {
      const rows = parseMachines(await read(`${SOURCE_ORIGIN}/api/machines`, CATALOG_TTL_S));
      const machines = rows.map((m) => ({ ...m, fan: snapMachine(m.code)?.fan ?? [] }));
      return { machines: machines.filter(allowed), stale: false, asOf: snapshot.asOf };
    } catch {
      return { machines: sortMachines(snapshot.machines).filter(allowed), stale: true, asOf: snapshot.asOf };
    }
  };

  const items = async (code: string, rarity: CardRarity, limit = 12): Promise<ItemsView> => {
    const fallback = (snapMachine(code)?.fan ?? []).filter((i) => i.rarity === rarity);
    if (!MACHINE_CODE.test(code)) return { items: [], stale: false };
    try {
      // The source's canonical order is code, rarity, limit. Any other order costs a redirect.
      const params = new URLSearchParams({ code, rarity, limit: String(limit) });
      const parsed = parseItems(await read(`${SOURCE_ORIGIN}/api/getNfts?${params}`, ITEMS_TTL_S), code);
      return { items: parsed, stale: false };
    } catch {
      return { items: fallback, stale: true };
    }
  };

  const fanFor = async (machine: Machine): Promise<Machine> => {
    try {
      const params = new URLSearchParams({ code: machine.code, limit: "3" });
      const parsed = parseItems(await read(`${SOURCE_ORIGIN}/api/getNfts?${params}`, FAN_TTL_S), machine.code);
      return parsed.length ? { ...machine, fan: parsed.slice(0, 3) } : machine;
    } catch {
      return machine;
    }
  };

  return {
    catalog,
    items,
    async page(code, rarity, cursor) {
      if (!MACHINE_CODE.test(code)) throw new Error("not a machine");
      // In the source's own order for these, so a page never costs a redirect. 24 is one of the limits it serves as sent.
      const params = new URLSearchParams({ code, ...(rarity ? { rarity } : {}), limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
      return parseItemsPage(await read(`${SOURCE_ORIGIN}/api/getNfts?${params}`, ITEMS_TTL_S), code);
    },
    async machine(code) {
      const view = await catalog();
      return { machine: view.machines.find((m) => m.code === code) ?? null, stale: view.stale, asOf: view.asOf };
    },
    async pool(code) {
      const views = await Promise.all(CARD_TIERS.map((t) => items(code, t)));
      return { items: dedupe(views.flatMap((v) => v.items as Item[])), stale: views.some((v) => v.stale) };
    },
    async withFans(machines, deadlineMs = 6000) {
      const results = [...machines];
      const started = Date.now();
      let next = 0;
      const worker = async () => {
        while (next < results.length && Date.now() - started < deadlineMs) {
          const i = next++;
          if (results[i].stock > 0) results[i] = await fanFor(results[i]);
        }
      };
      // Six at a time, stopping at the deadline. Cached copies return at once, so only a cold cache ever waits.
      await Promise.race([Promise.all(Array.from({ length: 6 }, worker)), new Promise((r) => setTimeout(r, deadlineMs))]);
      return [...results];
    },
  };
}

const dedupe = (items: readonly Item[]) => [...new Map(items.map((i) => [i.id, i])).values()];
