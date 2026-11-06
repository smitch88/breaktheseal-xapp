"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usd2, xrpOf } from "@/lib/format";
import type { PullMultiple } from "@/lib/pull-multiple";
import type { Award } from "@/lib/rails/types";
import { TAP_SLOP, dragProgress, settle, snapProgress } from "@/lib/sheet";
import { TIER_BG, TIER_SYMBOL } from "@/lib/tiers";
import { CardArt } from "./CardArt.tsx";
import { REVEAL_SIZES } from "./Stage.tsx";
import { useXrpUsd } from "./Providers.tsx";
import { Attribution, MultBadge, TierLabel } from "./ui.tsx";

/**
 * The payoff screen. It only displays what it's given. On phones the whole slab comes first: a one-line title bar and
 * the actions sit under it, and the bar opens into a sheet with the details. From 761 px up it's the two-column page.
 * `multiple` is what this pull gets back now against its pack's price, worked out by the caller from the numbers it has, or nothing yet.
 */
export function RevealView({ award, back, packName, multiple, onClose, actions, foot, tag, count }: { award: Award; back?: string | null; packName: string; multiple?: PullMultiple | null; onClose: () => void; actions: React.ReactNode; foot?: React.ReactNode; tag?: string; count?: string }) {
  const xrpUsd = useXrpUsd();
  const nft = award.kind === "nft";
  const real = award.provenance === "server";
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const cta = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; start: number; range: number; moved: boolean; lastY: number; lastT: number; v: number } | null>(null);
  const dragged = useRef(false);

  const place = useCallback((p: number) => root.current?.style.setProperty("--p", String(p)), []);

  useLayoutEffect(() => place(snapProgress(open ? "open" : "collapsed")), [open, place]);

  // The sheet may fill the room above the actions and no more. Long names scroll inside it.
  useLayoutEffect(() => {
    const measure = () => {
      if (root.current && cta.current) root.current.style.setProperty("--rmax", `${root.current.clientHeight - cta.current.offsetHeight - 8}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = sheet.current;
    if (!el) return;
    const bar = 60;
    drag.current = { y: e.clientY, start: snapProgress(open ? "open" : "collapsed"), range: el.offsetHeight - bar, moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) < TAP_SLOP) return;
    if (!d.moved) root.current?.classList.add("drag");
    d.moved = true;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    place(dragProgress(d.start, dy, d.range));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    dragged.current = true;
    root.current?.classList.remove("drag");
    const snap = settle(dragProgress(d.start, e.clientY - d.y, d.range), d.v);
    place(snapProgress(snap));
    setOpen(snap === "open");
  };

  return (
    <div className="stage">
      <div className="stop one">
        <div className="tl">
          <button className="sq" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="hint rpack">{[packName, real ? tag : "", count].filter(Boolean).join(" · ")}</div>
        <span />
      </div>
      <div className="reveal" ref={root} data-open={open}>
        <div className="art" style={{ background: TIER_BG[award.tier] }}>
          {award.token ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className="pop nftart" src={award.img} alt={award.name} />
          ) : (
            <CardArt name={award.name} front={award.img} back={back} nft={nft} className={nft ? "pop nftart" : "pop"} sizes={REVEAL_SIZES} priority />
          )}
        </div>
        <div className="rscrim" onClick={() => setOpen(false)} />
        <div className="inf">
          <div className="rspace" />
          <div className="rsheet" ref={sheet}>
            <button
              className="rbar"
              aria-expanded={open}
              aria-controls="reveal-details"
              aria-label={`${open ? "Hide" : "Show"} details for ${award.name}${multiple ? `, ${multiple.text} the pack price` : ""}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onClick={() => {
                if (dragged.current) dragged.current = false;
                else setOpen((o) => !o);
              }}
            >
              <i className="rgrip" aria-hidden="true" />
              <span className="rline">
                {open ? (
                  <span className="rmore">Item details</span>
                ) : (
                  <>
                    <span className={`rsym t-${award.tier}`} aria-hidden="true">
                      {TIER_SYMBOL[award.tier]}
                    </span>
                    <span className="rtitle">{award.name}</span>
                    <MultBadge m={multiple} />
                  </>
                )}
                <span className="rtoggle" aria-hidden="true">
                  {open ? "Close" : "Details"}
                  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={open ? "M2 4l4 4 4-4" : "M2 8l4-4 4 4"} />
                  </svg>
                </span>
              </span>
            </button>
            <div className="rbody" id="reveal-details">
              <div className="tagrow">
                <TierLabel tier={award.tier} />
                <MultBadge m={multiple} />
              </div>
              <h2>{award.name}</h2>
              <dl className="dl">
                <div>
                  <dt>{award.token ? "Worth" : nft ? (real ? "Marked value" : "Floor") : "Listed value"}</dt>
                  <dd>{nft && real ? award.grade : usd2(award.value)}</dd>
                </div>
                <div>
                  <dt>{award.token ? "Set when you pulled" : nft ? (real ? "About" : "Collection floor") : "Grade"}</dt>
                  <dd>{nft && real ? usd2(award.value) : award.grade}</dd>
                </div>
                {award.sell > 0 ? (
                  <div>
                    <dt>Sell-back quote</dt>
                    <dd>
                      {xrpOf(award.sell, xrpUsd)} XRP · {usd2(award.sell)}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="rfoot">
                {foot}
                {nft && !award.token ? <Attribution /> : null}
              </div>
            </div>
          </div>
          <div className="rcta" ref={cta}>
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}
