"use client";

import { useEffect, useRef, useState } from "react";
import { noOrphan } from "@/lib/format";
import { TIER_SYMBOL } from "@/lib/tiers";
import type { TierName } from "@/lib/rails/types";

/** A tile's rarity, with its odds a hover, a focus or a tap away. A screen reader gets the odds as the button's own name. */
export function OddsBadge({ tier, odds }: { tier: TierName; odds: string }) {
  const [open, setOpen] = useState(false);
  const me = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!me.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={me} className={open ? "tileodds open" : "tileodds"}>
      <button type="button" className={`oddsb t-${tier}`} aria-label={odds} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{TIER_SYMBOL[tier]}</span>
      </button>
      <span className="oddstip" aria-hidden="true">
        {noOrphan(odds)}
      </span>
    </span>
  );
}
