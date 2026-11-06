"use client";

import { SELL_FEE_PERCENT } from "@/lib/sellback";
import { useEffect, useState } from "react";
import { usd2 } from "@/lib/format";
import { api, type LiveRef, networkLabel, xrpText } from "@/lib/live/client";
import { useConfirmAccount, useRails, useXrpUsd } from "../Providers.tsx";
import { Sheet } from "../Sheet.tsx";

/** Sell on real rails: the server names the price, and the sale only goes through at exactly that price. */
export function LiveSellSheet({ item, onClose, onSold }: { item: LiveRef; onClose: () => void; onSold: () => void }) {
  const xrpUsd = useXrpUsd();
  const { mode } = useRails();
  const [drops, setDrops] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `${item.api}/sell`;
  const confirm = useConfirmAccount();

  useEffect(() => {
    let live = true;
    void api<{ drops: string }>(url, {}).then((r) => {
      if (!live) return;
      if (r.ok) setDrops(r.body.drops);
      else setProblem(r.body.error ?? "We couldn't get a price just now.");
    });
    return () => {
      live = false;
    };
  }, [url]);

  const xrp = drops ? Number(drops) / 1e6 : null;
  const sell = async () => {
    if (!drops) return;
    setBusy(true);
    setProblem(null);
    const r = await api<{ drops?: string }>(url, { drops });
    setBusy(false);
    if (r.ok) onSold();
    else if (r.body.code === "confirm_account") confirm(() => void sell(), true);
    else if (r.body.code === "price_changed" && r.body.drops) {
      const lower = BigInt(r.body.drops) < BigInt(drops);
      setDrops(r.body.drops);
      setProblem(lower ? `XRP's rate moved, so the price is lower now: ${xrpText(Number(r.body.drops) / 1e6)} XRP. Nothing was sold.` : "The price moved. Here's the new one. Nothing was sold.");
    } else setProblem(r.body.error ?? "That didn't go through. Your item is still in your stash.");
  };

  return (
    <Sheet top onClose={onClose} label="Sell">
      <h3>{xrp === null ? "Getting a price" : `Sell for ${xrpText(xrp)} XRP?`}</h3>
      {xrp !== null ? (
        <div className="kv">
          <span>Paid to your wallet</span>
          <b>
            {xrpText(xrp)} XRP{mode === "testnet" ? " (testnet)" : ""}
          </b>
        </div>
      ) : null}
      {xrp !== null && mode !== "testnet" ? (
        <div className="kv fine">
          <span>About</span>
          <span>{usd2(xrp * xrpUsd)}</span>
        </div>
      ) : null}
      {xrp !== null ? <p className="fine">{item.kind === "card" ? <>The third-party card vault buys the card back, and we pay you in XRP. </> : null}Includes our {SELL_FEE_PERCENT}% sell&nbsp;fee.</p> : null}
      {problem ? <p className="freshness">{problem}</p> : null}
      <p className="fine">{networkLabel(mode) ? "Paid on the testnet ledger. " : ""}A sale can&apos;t be&nbsp;undone.</p>
      <div className="two">
        <button className="btn ol" onClick={onClose}>
          Not now
        </button>
        <button className="btn" disabled={!drops || busy} onClick={() => confirm(() => void sell())}>
          {busy ? "Selling…" : "Sell"}
        </button>
      </div>
    </Sheet>
  );
}
