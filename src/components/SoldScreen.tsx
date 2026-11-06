"use client";

import Link from "next/link";
import { usd2, xrpOf } from "@/lib/format";
import { useXrpUsd } from "./Providers.tsx";

/** A demo sale. Open another goes back to the pack it came from, ready to open again, or to the shelf when that isn't known. */
export function SoldScreen({ usd, again = "/packs" }: { usd: number; again?: string }) {
  const xrpUsd = useXrpUsd();
  return (
    <div className="stage sold">
      <div className="emptyc">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/sell.webp" alt="A happy seal in a pile of coins" />
        <h2 style={{ font: "400 44px var(--d)", textTransform: "uppercase" }}>Sold</h2>
        <p>
          Demo sale: {usd2(usd)} is about {xrpOf(usd, xrpUsd)} XRP. Nothing was&nbsp;paid.
        </p>
        <Link className="btn" href={again}>
          Open another
        </Link>
      </div>
    </div>
  );
}
