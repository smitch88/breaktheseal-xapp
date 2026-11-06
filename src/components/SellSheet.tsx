"use client";

import { usd2, xrpOf } from "@/lib/format";
import { useXrpUsd } from "./Providers.tsx";
import { Sheet } from "./Sheet.tsx";

export function SellSheet({ usd, onCancel, onSell }: { usd: number; onCancel: () => void; onSell: () => void }) {
  const xrpUsd = useXrpUsd();
  return (
    <Sheet top onClose={onCancel} label={`Sell for ${usd2(usd)}`}>
      <h3>Sell for {usd2(usd)}?</h3>
      <div className="kv">
        <span>Paid to your wallet</span>
        <b>{xrpOf(usd, xrpUsd)} XRP</b>
      </div>
      <div className="kv fine">
        <span>Offer held for</span>
        <span>5:00</span>
      </div>
      <p className="fine">Demo sale, so nothing is paid. A real sale can&apos;t be&nbsp;undone.</p>
      <div className="two">
        <button className="btn ol" onClick={onCancel}>
          Not now
        </button>
        <button className="btn" onClick={onSell}>
          Sell
        </button>
      </div>
    </Sheet>
  );
}
