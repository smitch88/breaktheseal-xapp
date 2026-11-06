"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { noOrphan } from "@/lib/format";
import { LegalLinks } from "./LegalLinks.tsx";

/**
 * What a checkout says up front: the pack, then one Details row with the total. On a phone the rest folds away under it, closed until
 * tapped. From 761px the fold is always open and the Details row isn't drawn, so a desktop checkout reads as one list.
 */
export function CheckoutDetails({ pack, total, note, children }: { pack: string; total: string; note?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="codetails">
      <dl className="dl copack">
        <div>
          <dt>Pack</dt>
          <dd>{pack}</dd>
        </div>
      </dl>
      <button type="button" className="cosum" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>Details</span>
        <b>{total}</b>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div id={id} className={open ? "cofold open" : "cofold"}>
        <div>
          <dl className="dl">{children}</dl>
          {note ? <p className="fine conote">{note}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** The one line the terms box needs, with the terms a tap away. */
export function Consent({ agreed, onChange }: { agreed: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="consent">
      <input type="checkbox" checked={agreed} onChange={(e) => onChange(e.target.checked)} />{" "}
      <span>
        I&apos;m 18+ and accept the{" "}
        <Link href="/terms" style={{ textDecoration: "underline" }}>
          terms
        </Link>
        .
      </span>
    </label>
  );
}

/** The responsible-play line, kept to one short sentence right above Pay. */
export const RISK_LINE = noOrphan("Prizes are random and can be worth less.");

/**
 * Terms box, the risk line and Pay. On a phone it's pinned to the bottom like the pack page's buy bar, above the xApp's tabs, and the page
 * keeps room under its content for exactly the bar's height. Terms, privacy and support stay on desktop; phones have them in the footer.
 */
export function CheckoutBar({ agreed, onAgree, problem, children }: { agreed: boolean; onAgree: (v: boolean) => void; problem?: string | null; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = ref.current;
    const root = document.documentElement;
    if (!bar || typeof ResizeObserver === "undefined") return;
    // Room only while the bar is pinned: on a wide screen it sits in the page and needs none.
    const fit = () => root.style.setProperty("--cobar", getComputedStyle(bar).position === "fixed" ? `${Math.ceil(bar.getBoundingClientRect().height)}px` : "0px");
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
      root.style.removeProperty("--cobar");
    };
  }, []);
  return (
    <>
      <div ref={ref} className="cobar">
        <Consent agreed={agreed} onChange={onAgree} />
        <p className="fine corisk">{RISK_LINE}</p>
        {problem ? <p className="freshness coproblem">{problem}</p> : null}
        {children}
      </div>
      <div className="colinks">
        <LegalLinks />
      </div>
    </>
  );
}
