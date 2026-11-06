"use client";

import { useEffect, useRef, useState } from "react";
import { SELL_FEE_PERCENT } from "@/lib/sellback";
import { usd2 } from "@/lib/format";
import { api, networkLabel, xrpSheet, type ApiAnswer } from "@/lib/live/client";
import type { PayoutItem } from "@/lib/rip/types";
import { useConfirmAccount, useRails, useXrpUsd } from "../Providers.tsx";
import { Sheet } from "../Sheet.tsx";

const toXrp = (drops: bigint) => Number(drops) / 1e6;
const BUSY_WAIT_S = 5;

/**
 * Cash out several prizes in one payment: NFTs sold back, XRP prizes sent. The server names every price and takes them only if they still
 * hold. It shows the total and the fee before anything can be confirmed, and once it's confirmed, where the payment stands lives on the
 * items themselves, so nothing here has to survive a reload. It asks for a price once per opening. A busy answer did nothing, so it waits
 * a few seconds and asks once more by itself; the same items asked twice are the same payout, so that can never pay twice.
 */
export function BulkSheet({ ids, onClose, onDone }: { ids: readonly string[]; onClose: () => void; onDone: () => void }) {
  const { mode } = useRails();
  const xrpUsd = useXrpUsd();
  const [items, setItems] = useState<readonly PayoutItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState<number | null>(null);
  const proveFirst = useConfirmAccount();
  const key = ids.join(",");
  const sending = useRef(false);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  /** One call, and if the server was busy, one more after a short countdown. Nothing was done by a busy answer. */
  const once = async <T,>(call: () => Promise<ApiAnswer<T>>): Promise<ApiAnswer<T>> => {
    const first = await call();
    if (first.status !== 429 || !open.current) return first;
    for (let s = BUSY_WAIT_S; s > 0 && open.current; s--) {
      setWait(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setWait(null);
    return open.current ? call() : first;
  };

  useEffect(() => {
    let live = true;
    void once(() => api<{ items: PayoutItem[] }>("/api/rip/payouts", { ids: key.split(",") })).then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.body.items);
      else setProblem(r.body.error ?? "We couldn't get a price just now. Everything is safe in your stash.");
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const sells = (items ?? []).filter((i) => i.action === "sell");
  const sends = (items ?? []).filter((i) => i.action === "redeem");
  const sum = (list: readonly PayoutItem[]) => list.reduce((a, i) => a + BigInt(i.drops), 0n);
  const sold = sum(sells);
  const sent = sum(sends);
  const total = toXrp(sold + sent);
  // What's quoted is already net of the fee, so this is the fee on what the same sale would be before it.
  const fee = sold ? (toXrp(sold) * SELL_FEE_PERCENT) / (100 - SELL_FEE_PERCENT) : 0;

  const confirm = async () => {
    // One press is one request, however fast the taps.
    if (!items || sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    const r = await once(() => api<{ id?: string; items?: PayoutItem[] }>("/api/rip/payouts", { items }));
    sending.current = false;
    setBusy(false);
    if (r.ok) onDone();
    else if (r.body.code === "confirm_account") proveFirst(() => void confirm(), true);
    else if (r.body.code === "price_changed" && r.body.items) {
      setItems(r.body.items);
      setProblem("The price moved, so here's the new total. Nothing was sold.");
    } else setProblem(r.status === 429 ? "Still busy. Nothing moved, and everything is safe in your stash. Try again in a minute." : (r.body.error ?? "That didn't go through. Everything is still in your stash."));
  };

  const heading = items === null ? "Getting a price" : `Cash out ${xrpSheet(total)} XRP?`;
  return (
    <Sheet top onClose={onClose} label="Cash out">
      <h3>{heading}</h3>
      {items ? (
        <>
          {sells.length ? (
            <div className="kv">
              <span>{sells.length === 1 ? "1 sold back" : `${sells.length} sold back`}</span>
              <b>{xrpSheet(toXrp(sold))} XRP</b>
            </div>
          ) : null}
          {sold ? (
            <div className="kv fine">
              <span>Our {SELL_FEE_PERCENT}% sell fee, already off that</span>
              <span className="nw">about {xrpSheet(Number(fee.toFixed(2)))} XRP</span>
            </div>
          ) : null}
          {sends.length ? (
            <div className="kv">
              <span>{sends.length === 1 ? "1 XRP prize, no fee" : `${sends.length} XRP prizes, no fee`}</span>
              <b>{xrpSheet(toXrp(sent))} XRP</b>
            </div>
          ) : null}
          <div className="kv mtot">
            <span>One payment to your wallet</span>
            <b className="nw">
              {xrpSheet(total)} XRP{mode === "testnet" ? " (testnet)" : ""}
            </b>
          </div>
          {mode !== "testnet" ? (
            <div className="kv fine">
              <span>About</span>
              <span>{usd2(total * xrpUsd)}</span>
            </div>
          ) : null}
        </>
      ) : null}
      {wait !== null ? (
        <p className="freshness" role="status">
          Busy for a moment. Trying again in {wait}s.
        </p>
      ) : null}
      {problem ? <p className="freshness">{problem}</p> : null}
      <p className="fine">
        {networkLabel(mode) ? "Paid on the testnet ledger. " : ""}
        {sells.length ? "You sign nothing. A sale can't be undone." : "You sign nothing, and it can't be undone."}
      </p>
      <div className="two">
        <button className="btn ol" onClick={onClose}>
          Not now
        </button>
        <button className="btn" disabled={!items || busy || wait !== null} onClick={() => proveFirst(() => void confirm())}>
          {busy ? "Sending…" : "Cash out"}
        </button>
      </div>
    </Sheet>
  );
}
