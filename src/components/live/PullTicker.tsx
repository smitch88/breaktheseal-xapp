"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { noOrphan } from "@/lib/format";
import { useRecentPulls } from "@/lib/live/hooks";
import { loops, placeArrivals, timeAgo } from "@/lib/live/ticker";
import { XRP_PRIZE_ART, XRP_PRIZE_COIN } from "@/lib/prize-art";
import type { PullFeed, RecentPull } from "@/lib/rip/recent-pulls";
import { TIER_SYMBOL } from "@/lib/tiers";
import { CardArt } from "../CardArt.tsx";
import { DetailSheet } from "../DetailSheet.tsx";
import { NftImg } from "../NftImg.tsx";
import { Slab } from "../Slab.tsx";
import { TierLabel } from "../ui.tsx";

const SPEED = 34;
const NO_ART = "/assets/nft-no-picture.svg";
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

function PullCard({ pull, now, cls, copy, onOpen }: { pull: RecentPull; now: number; cls: string; copy?: boolean; onOpen: (p: RecentPull) => void }) {
  const [src, setSrc] = useState(pull.img);
  const ago = timeAgo(pull.at, now);
  return (
    <button type="button" className={`tkc g-${pull.tier}${cls}`} tabIndex={copy ? -1 : undefined} aria-hidden={copy || undefined} aria-label={`${pull.tier}: ${pull.name}${pull.value ? `, ${pull.value}` : ""}, ${ago}`} onClick={() => onOpen({ ...pull, img: src })}>
      <span className="tka">
        {pull.kind === "card" ? (
          <Slab src={pull.img} alt="" width={66} height={92} sizes="66px" onFail="placeholder" />
        ) : pull.kind === "nft" ? (
          <NftImg src={pull.img} alt="" sizes="66px" loading="lazy" draggable={false} />
        ) : (
          // A picture that failed before this page woke up never fires onError, so the ref looks too.
          /* eslint-disable-next-line @next/next/no-img-element */
          <img ref={(el) => void (el?.complete && !el.naturalWidth && setSrc(NO_ART))} src={src} alt="" loading="lazy" draggable={false} onError={() => setSrc(NO_ART)} />
        )}
      </span>
      <span className="tkt">
        <span className={`tier t-${pull.tier}`}>
          {TIER_SYMBOL[pull.tier]} {pull.tier}
        </span>
        <span className="tkn">{noOrphan(pull.name)}</span>
        <span className="tkm">
          {pull.value ? <b>{pull.value}</b> : null}
          <small>{ago}</small>
        </span>
      </span>
    </button>
  );
}

/** What the public feed says about one pull, and the pack it came from. It leaves out the pull's own page, whose ledger links lead to the wallet that paid. */
function PullSheet({ pull, now, onClose }: { pull: RecentPull; now: number; onClose: () => void }) {
  return (
    <DetailSheet label={pull.name} onClose={onClose}>
      <div className="dart">
        {pull.kind === "prize" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={pull.img === XRP_PRIZE_COIN ? XRP_PRIZE_ART : pull.img} alt={pull.name} />
        ) : (
          <CardArt name={pull.name} front={pull.img} nft={pull.kind === "nft"} sizes="(min-width:760px) 380px, 80vw" />
        )}
      </div>
      <div className="dinfo">
        <TierLabel tier={pull.tier} />
        <h3>{pull.name}</h3>
        <dl className="dl">
          {pull.value ? (
            <div>
              <dt>Value</dt>
              <dd>{pull.value}</dd>
            </div>
          ) : null}
          {pull.grade ? (
            <div>
              <dt>Grade</dt>
              <dd>{pull.grade}</dd>
            </div>
          ) : null}
          <div>
            <dt>From</dt>
            <dd>{pull.pack}</dd>
          </div>
          <div>
            <dt>Pulled</dt>
            <dd>{timeAgo(pull.at, now)}</dd>
          </div>
        </dl>
        <div className="acts">
          <Link className="btn ol full" href={pull.href}>
            See this pack <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </DetailSheet>
  );
}

/** Recent real pulls under the hero. No pulls, no strip. A few sit still; only more than a screen of them scrolls. */
export function PullTicker({ first, testnet }: { first: PullFeed; testnet: boolean }) {
  const feed = useRecentPulls(true);
  const [ring, setRing] = useState<readonly RecentPull[]>(first.pulls);
  const [now, setNow] = useState(first.asOf);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [bumps, setBumps] = useState(0);
  const [open, setOpen] = useState<RecentPull | null>(null);
  const [box, setBox] = useState({ pitch: 0, view: 0 });
  const [motion, setMotion] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  const offset = useRef(0);
  const held = useRef({ hover: false, focus: false, drag: false });
  const dragFrom = useRef<{ x: number; offset: number; moved: boolean } | null>(null);
  const noClick = useRef(false);
  const late = useRef(!first.pulls.length);

  const looping = motion && loops(ring.length, box.pitch, box.view);
  const setW = ring.length * box.pitch;
  const some = ring.length > 0;

  /** Where the moving row is right now. */
  const sample = () => {
    const t = anim.current?.currentTime;
    if (t !== null && t !== undefined && setW) offset.current = (Number(t) * SPEED) / 1000 % setW;
  };
  const holdOrGo = () => {
    const h = held.current;
    if (!anim.current) return;
    if (h.hover || h.focus || h.drag || open) anim.current.pause();
    else anim.current.play();
  };

  useEffect(() => {
    setNow(Date.now());
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setMotion(!rm.matches);
    set();
    rm.addEventListener("change", set);
    return () => rm.removeEventListener("change", set);
  }, []);

  useEffect(() => {
    if (!some) return;
    const measure = () => {
      const card = trackRef.current?.firstElementChild as HTMLElement | null;
      const view = viewRef.current?.clientWidth ?? 0;
      if (card) setBox({ pitch: card.offsetWidth + parseFloat(getComputedStyle(card).marginRight), view });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (viewRef.current) ro.observe(viewRef.current);
    return () => ro.disconnect();
  }, [some]);

  useEffect(() => {
    if (!feed) return;
    setNow(Date.now());
    sample();
    const placed = placeArrivals(ring, feed.pulls, { offset: offset.current, pitch: box.pitch, view: box.view, looping });
    if (!placed.fresh.length) return;
    offset.current = placed.offset;
    setRing(placed.ring);
    // The first pulls a page hears about aren't news to it. Everything after is.
    if (ring.length) {
      setFresh(new Set(placed.fresh));
      setBumps((b) => b + 1);
    }
    // Only a new read brings anything in; the rest is read as it stands then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // A compositor animation, so a phone moves the row without running a line of script per frame. Rebuilt before paint when the ring changes, from where it was.
  useBeforePaint(() => {
    const track = trackRef.current;
    if (!looping || !track) return;
    const a = track.animate([{ transform: "translate3d(0,0,0)" }, { transform: `translate3d(${-setW}px,0,0)` }], { duration: (setW / SPEED) * 1000, iterations: Infinity });
    a.currentTime = ((offset.current % setW) / SPEED) * 1000;
    anim.current = a;
    holdOrGo();
    return () => {
      a.cancel();
      anim.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looping, setW]);

  useEffect(holdOrGo);

  if (!some) return null;

  const cls = (p: RecentPull) => (fresh.has(p.key) ? (looping ? " fresh" : " fresh in") : "");
  return (
    <>
      <section className={`tk${looping ? "" : " few"}${late.current ? " late" : ""}`} aria-label="Recent pulls">
        <span key={bumps} className={`tkl${bumps ? " bump" : ""}`}>
          <i className="tkd" aria-hidden="true" />
          <span>
            {testnet ? "Testnet" : "Recent"} <br />
            pulls
          </span>
        </span>
        <div
          ref={viewRef}
          className={`tkv${looping ? " loop" : ""}`}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") held.current.hover = true;
            holdOrGo();
          }}
          onPointerLeave={() => {
            // A sheet closed with Esc hands focus back to a card under the mouse, so leaving lets go of that too.
            held.current.hover = false;
            held.current.focus = false;
            holdOrGo();
          }}
          onFocus={(e) => {
            held.current.focus = e.target.matches(":focus-visible");
            holdOrGo();
          }}
          onBlur={(e) => {
            if (viewRef.current?.contains(e.relatedTarget)) return;
            held.current.focus = false;
            // Tabbing can scroll the row by itself. Its motion is all in the animation, so that goes back.
            if (looping && viewRef.current) viewRef.current.scrollLeft = 0;
            holdOrGo();
          }}
          onPointerDown={(e) => {
            noClick.current = false;
            if (!looping) return;
            sample();
            dragFrom.current = { x: e.clientX, offset: offset.current, moved: false };
            held.current.drag = true;
            holdOrGo();
          }}
          onPointerMove={(e) => {
            const d = dragFrom.current;
            if (!d || !anim.current) return;
            const dx = e.clientX - d.x;
            if (!d.moved && Math.abs(dx) < 6) return;
            if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
            d.moved = true;
            noClick.current = true;
            anim.current.currentTime = ((((d.offset - dx) % setW) + setW) % setW) / SPEED * 1000;
          }}
          onPointerUp={() => {
            dragFrom.current = null;
            held.current.drag = false;
            holdOrGo();
          }}
          onPointerCancel={() => {
            dragFrom.current = null;
            held.current.drag = false;
            holdOrGo();
          }}
          onClickCapture={(e) => {
            if (!noClick.current) return;
            noClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div ref={trackRef} className="tkr">
            {ring.map((p) => (
              <PullCard key={p.key} pull={p} now={now} cls={cls(p)} onOpen={setOpen} />
            ))}
            {looping ? ring.map((p) => <PullCard key={`again-${p.key}`} pull={p} now={now} cls={cls(p)} copy onOpen={setOpen} />) : null}
          </div>
        </div>
      </section>
      {open ? <PullSheet pull={open} now={now} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
