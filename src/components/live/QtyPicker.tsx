"use client";

import { useEffect, useState } from "react";
import { noOrphan, usd2 } from "@/lib/format";
import { api, xrpText } from "@/lib/live/client";
import { useRipConfig } from "@/lib/live/hooks";
import { clampQty, presetsFor, roomNote } from "@/lib/live/multi";
import type { PackRef } from "@/lib/rails/types";
import { useRails } from "../Providers.tsx";

/** The most a demo can show. Nothing is held and nothing moves, so no stock or cover applies. */
const DEMO_MAX = 20;

/**
 * Whether this pack offers more than one at a time, and how many it can take right now. The server's figure, always: the page only shows it,
 * and the order route checks it again. `max` is null until it answers. Off, this reads nothing at all.
 */
export function useQtyRoom(pack: PackRef | null): { on: boolean; max: number | null; cap: number } {
  const { mode, multi } = useRails();
  const live = mode !== "demo";
  const isCard = pack?.kind === "card";
  const config = useRipConfig(!!multi && live && !!pack);
  const code = pack?.kind === "card" ? pack.code : null;
  const asksCard = !!multi && live && isCard && multi.cardMax > 1 && !!config?.cardsOn;
  const [cardMax, setCardMax] = useState<number | null>(null);
  useEffect(() => {
    if (!asksCard || !code) return;
    let on = true;
    void api<{ max: number }>(`/api/rip/bundle-room?code=${encodeURIComponent(code)}`).then((r) => {
      if (on) setCardMax(r.ok ? r.body.max : 1);
    });
    return () => {
      on = false;
    };
  }, [asksCard, code]);
  if (!multi || !pack) return { on: false, max: 1, cap: 1 };
  if (!live) return { on: true, max: DEMO_MAX, cap: DEMO_MAX };
  // Card packs on a site whose card line is off are demos, and they get a demo's picker.
  if (isCard && config && !config.cardsOn) return { on: true, max: DEMO_MAX, cap: DEMO_MAX };
  if (isCard) return multi.cardMax > 1 ? { on: true, max: cardMax, cap: multi.cardMax } : { on: false, max: 1, cap: 1 };
  if (multi.max <= 1) return { on: false, max: 1, cap: 1 };
  const room = pack.kind === "nft" ? config?.multi?.room[String(pack.price)] : undefined;
  return { on: true, max: room === undefined ? null : room, cap: multi.max };
}

/** How many, in equal controls. 1 is where it starts, and nothing here nudges anyone past that. */
/** `brief`: at checkout, where the "Up to N right now" label says enough and the Details row carries the total, so no explainer under it. */
export function QtyPicker({ qty, onChange, max, cap, eachXrp, eachUsd, about, demo, brief }: { qty: number; onChange: (n: number) => void; max: number | null; cap: number; eachXrp: number | null; eachUsd: number; about?: boolean; demo?: boolean; brief?: boolean }) {
  const limit = Math.max(1, max ?? 1);
  const total = eachXrp === null ? null : eachXrp * qty;
  const short = roomNote(max, cap);
  return (
    <div className="qty" role="group" aria-label="How many packs">
      <div className="qtyhead">
        <span className="lb">How many</span>
        {short ? <span className="lb">Up to {max} right now</span> : null}
      </div>
      <div className="qtyrow">
        {presetsFor(cap).map((n) => (
          <button key={n} type="button" className={n === qty ? "qtyb on" : "qtyb"} aria-pressed={n === qty} disabled={n > limit} onClick={() => onChange(n)}>
            {n}
          </button>
        ))}
      </div>
      <div className="qtystep">
        <button type="button" className="qtyb" aria-label="One fewer" disabled={qty <= 1} onClick={() => onChange(clampQty(qty - 1, limit))}>
          −
        </button>
        <output aria-live="polite">{qty === 1 ? "1 pack" : `${qty} packs`}</output>
        <button type="button" className="qtyb" aria-label="One more" disabled={qty >= limit} onClick={() => onChange(clampQty(qty + 1, limit))}>
          +
        </button>
      </div>
      {short && !brief ? <p className="fine qtyroom">{noOrphan(short)}</p> : null}
      {qty > 1 ? (
        <div className="qtytotal">
          <span>{demo ? "Total (demo)" : about ? "Total, about" : "Total"}</span>
          <b>
            {total === null ? "…" : `${xrpText(Number(total.toFixed(6)))} XRP`} · {usd2(eachUsd * qty)}
          </b>
        </div>
      ) : null}
    </div>
  );
}
