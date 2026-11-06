"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bandTotal, mergePage, showingText, type BandFilter } from "@/lib/catalog/browse";
import { CARD_TIERS, type BandCounts, type Item, type ItemsPage } from "@/lib/catalog/types";
import { noOrphan } from "@/lib/format";
import { api } from "@/lib/live/client";
import { capitalize } from "@/lib/tiers";
import { cardOdds } from "@/lib/live/pool-tiles";
import type { TierName } from "@/lib/rails/types";
import { OddsBadge } from "./OddsBadge.tsx";
import { PackCardSheet } from "./PackCardSheet.tsx";
import { ItemCard } from "./ui.tsx";

type List = { readonly items: readonly Item[]; readonly next: string | null; readonly loaded: boolean };
const EMPTY: List = { items: [], next: null, loaded: false };

/**
 * What's really in a pack, a page at a time, highest value first. That's the only order Collector Crypt's list has: lowest first would mean
 * reading the whole machine, up to 218 calls for the biggest ones, so there's no sort to offer. Totals are the machine's own stock.
 */
export function PackItems({ code, first, stock, bands, rates }: { code: string; first: ItemsPage | null; stock: number; bands?: BandCounts; rates: readonly [number, number, number, number] }) {
  const [filter, setFilter] = useState<BandFilter>("All");
  const [lists, setLists] = useState<Partial<Record<BandFilter, List>>>(first ? { All: { items: first.items, next: first.nextCursor, loaded: true } } : {});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const asking = useRef<string | null>(null);
  const list = lists[filter] ?? EMPTY;

  const read = useCallback(
    async (band: BandFilter, cursor: string | null) => {
      const key = `${band}:${cursor ?? ""}`;
      if (asking.current === key) return;
      asking.current = key;
      setBusy(true);
      setProblem(null);
      const params = new URLSearchParams({ ...(band === "All" ? {} : { rarity: band }), ...(cursor ? { cursor } : {}) });
      const r = await api<ItemsPage>(`/api/packs/${encodeURIComponent(code)}/browse${params.size ? `?${params}` : ""}`).catch(() => null);
      if (asking.current !== key) return;
      asking.current = null;
      setBusy(false);
      if (!r?.ok) {
        setProblem(r?.body.error ?? "We couldn't read this pack's list just now.");
        return;
      }
      setLists((all) => ({ ...all, [band]: { items: mergePage(cursor ? all[band]?.items ?? [] : [], r.body.items), next: r.body.nextCursor, loaded: true } }));
    },
    [code],
  );

  useEffect(() => {
    if (!list.loaded) void read(filter, null);
  }, [filter, list.loaded, read]);

  const total = bandTotal({ stock, bands }, filter);
  const chips: readonly BandFilter[] = ["All", ...CARD_TIERS.filter((t) => !bands || bands[t] > 0)];
  const label = (f: BandFilter) => {
    const n = bandTotal({ stock, bands }, f);
    const name = f === "All" ? "All" : capitalize(f);
    return n === null ? name : `${name} ${n.toLocaleString("en-US")}`;
  };
  return (
    <>
      <div className="filters">
        {chips.map((t) => (
          <button key={t} className="fchip" aria-pressed={filter === t} onClick={() => setFilter(t)}>
            {label(t)}
          </button>
        ))}
      </div>
      <div className="igrid">
        {list.items.map((c) => (
          <ItemCard key={c.id} item={c} onOpen={() => setOpen(c)} badge={<OddsBadge tier={capitalize(c.rarity) as TierName} odds={cardOdds(capitalize(c.rarity), rates[CARD_TIERS.indexOf(c.rarity)])} />} />
        ))}
        {!list.items.length && list.loaded ? <div className="empty">None of this tier in the pack right now.</div> : null}
      </div>
      {!list.loaded && busy ? (
        <div className="waitrow" role="status">
          <i className="spin" aria-hidden="true" /> Reading this pack&apos;s list
        </div>
      ) : null}
      {problem ? (
        <div className="morerow">
          <p className="freshness">{noOrphan(problem)}</p>
          <button className="btn ol" onClick={() => void read(filter, list.next)}>
            Try again
          </button>
        </div>
      ) : null}
      {list.loaded && list.items.length ? (
        <div className="morerow">
          <p className="fine" role="status">
            {showingText(list.items.length, total, !!list.next)}
          </p>
          {list.next && !problem ? (
            <button className="btn ol" disabled={busy} onClick={() => void read(filter, list.next)}>
              {busy ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      ) : null}
      {open ? <PackCardSheet item={open} code={code} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
