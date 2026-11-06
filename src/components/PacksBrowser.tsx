"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { noOrphan } from "@/lib/format";
import { useRipConfig } from "@/lib/live/hooks";
import type { Machine } from "@/lib/catalog/types";
import type { NftPackView } from "@/lib/nft/view";
import { ALL, DEFAULT_SORT, NEXT_SORT, NFT_CATEGORY, SORT_LABEL, activeFilters, filterNftPacks, filterPacks, shownCount, type PackSort } from "@/lib/pack-filter";
import { chipList } from "./chip-list.ts";
import { Sheet } from "./Sheet.tsx";
import { NftCard, PackCard } from "./ui.tsx";
import { useXapp } from "./XappHost.tsx";

type NftRow = Pick<NftPackView, "price" | "name" | "shortName" | "art"> & { xrp: string };
const SORTS = Object.keys(SORT_LABEL) as PackSort[];
const FILTER_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M7 12h10M10 17h4" />
  </svg>
);
const SORT_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />
  </svg>
);

export function PacksBrowser({ machines, nft }: { machines: readonly Machine[]; nft: readonly NftRow[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const cats = useMemo(() => chipList(machines.map((m) => m.cat)), [machines]);
  const requested = params?.get("cat") ?? ALL;
  const cat = cats.includes(requested) ? requested : ALL;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PackSort>(DEFAULT_SORT);
  const [sheet, setSheet] = useState(false);
  const [sorting, setSorting] = useState(false);
  // Inside Xaman the shelf is only what can be bought today, so there's nothing to search. Filters and Sort get a bar of their own.
  const { shell } = useXapp();
  const cardsOn = useRipConfig(shell)?.cardsOn;
  const cardsShown = cat !== NFT_CATEGORY && !(shell && !cardsOn);

  // In the xApp the sheet picks a draft and Show applies it, so the phone's Back can close the sheet without the page's address changing under it.
  const [draft, setDraft] = useState<string>(ALL);
  const applying = useRef<string | null>(null);

  const list = useMemo(() => filterPacks(machines, { cat, query, sort }), [machines, cat, query, sort]);
  const nftList = useMemo(() => filterNftPacks(nft, { cat, query, sort }), [nft, cat, query, sort]);
  const count = activeFilters({ cat, sort }, shell);
  const sheetCat = shell ? draft : cat;
  const total = useMemo(() => {
    const shown = sheetCat !== NFT_CATEGORY && !(shell && !cardsOn);
    return shownCount(filterNftPacks(nft, { cat: sheetCat, query, sort }).length, filterPacks(machines, { cat: sheetCat, query, sort }).length, shown);
  }, [nft, machines, sheetCat, query, sort, shell, cardsOn]);
  const setCat = (c: string) => router.replace(c === ALL ? "/packs" : `/packs?cat=${encodeURIComponent(c)}`, { scroll: false });
  const filterLabel = count ? `Filters, ${count} active` : "Filters";
  const openFilters = () => {
    setDraft(cat);
    setSheet(true);
  };
  const closeFilters = () => {
    setSheet(false);
    const next = applying.current;
    applying.current = null;
    if (next !== null && next !== cat) setCat(next);
  };

  return (
    <>
      {/* The website's tools, and the xApp's bar. Both render, and CSS keyed to Xaman's user agent shows one, so neither flashes in. */}
      <div className="tools">
        <input className="srch" type="search" placeholder="Search packs" aria-label="Search packs" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="fchip fbtn" aria-haspopup="dialog" aria-label={filterLabel} onClick={() => setSheet(true)}>
          {FILTER_ICON}
          Filters
          {count ? <b className="fcount">{count}</b> : null}
        </button>
        <button className="fchip only-wide" onClick={() => setSort(NEXT_SORT[sort])}>
          Sort: {SORT_LABEL[sort].toLowerCase()}
        </button>
      </div>
      <div className="filters only-wide-grid" role="group" aria-label="Filter pack categories">
        {cats.map((c) => (
          <button key={c} className="fchip" aria-pressed={cat === c} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="xptop" role="group" aria-label="Filter and sort packs">
        <button type="button" className="xpbtn xpfilter" aria-haspopup="dialog" aria-label={filterLabel} onClick={openFilters}>
          {FILTER_ICON}
          <span>Filters</span>
          {count ? <b className="fcount">{count}</b> : null}
        </button>
        <button type="button" className="xpbtn xpsort" aria-haspopup="dialog" aria-label={`Sort, ${SORT_LABEL[sort]}`} onClick={() => setSorting(true)}>
          {SORT_ICON}
          <span>{SORT_LABEL[sort]}</span>
        </button>
      </div>
      {nftList.length ? (
        <>
          <h3 className="sub">XRPL NFT packs</h3>
          <div className="pgrid five">
            {nftList.map((n) => (
              <NftCard key={n.price} pack={n} xrp={n.xrp} />
            ))}
          </div>
        </>
      ) : null}
      {cardsShown ? (
        <>
          <h3 className="sub">Graded cards and collectibles</h3>
          <div className="pgrid">
            {list.length ? list.map((m) => <PackCard key={m.code} m={m} />) : <div className="empty">No packs match.</div>}
          </div>
        </>
      ) : null}
      {sheet ? (
        <Sheet label="Filter packs" onClose={closeFilters} backCloses={shell}>
          {(close) => (
          <>
          <h3>Filters</h3>
          {shell ? null : (
            <>
              <span className="lb">Sort by</span>
              <div className="fgrid" role="group" aria-label="Sort packs">
                {SORTS.map((s) => (
                  <button key={s} className="fchip" aria-pressed={sort === s} onClick={() => setSort(s)}>
                    {SORT_LABEL[s]}
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="lb">Category</span>
          <div className="fgrid" role="group" aria-label="Filter pack categories">
            {cats.map((c) => (
              <button key={c} className="fchip" aria-pressed={sheetCat === c} onClick={() => (shell ? setDraft(c) : setCat(c))}>
                {c}
              </button>
            ))}
          </div>
          <div className="fact">
            <button
              className="btn ol"
              disabled={shell ? draft === ALL : !count}
              onClick={() => {
                if (shell) return setDraft(ALL);
                setSort(DEFAULT_SORT);
                setCat(ALL);
              }}
            >
              Clear
            </button>
            <button
              className="btn"
              onClick={() => {
                applying.current = shell ? draft : null;
                close();
              }}
            >
              Show {total} {total === 1 ? "pack" : "packs"}
            </button>
          </div>
          </>
          )}
        </Sheet>
      ) : null}
      {sorting ? (
        <Sheet label="Sort packs" onClose={() => setSorting(false)} backCloses={shell}>
          {(close) => (
          <>
          <h3>Sort</h3>
          <div className="xsortlist" role="group" aria-label="Sort packs">
            {SORTS.map((s) => (
              <button
                key={s}
                type="button"
                className="xsortrow"
                aria-pressed={sort === s}
                onClick={() => {
                  setSort(s);
                  close();
                }}
              >
                <span>{SORT_LABEL[s]}</span>
                <span className="xsortmark" aria-hidden="true">
                  {sort === s ? "✓" : ""}
                </span>
              </button>
            ))}
          </div>
          <p className="fine">{noOrphan("NFT packs have no stock count, so Most in stock keeps them in price order.")}</p>
          </>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
