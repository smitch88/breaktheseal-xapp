"use client";

import { useEffect, useState } from "react";
import { noOrphan } from "@/lib/format";
import { sellWindowLeft, sellWindowLine } from "@/lib/sellback";

const useNow = () => {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  return now;
};

/** Under a card's sell button, one short muted line. Past the window it only says so if there's truly no price: Collector Crypt's answer is what counts. */
export function SellWindow({ until, priced }: { until: string | null | undefined; priced: boolean }) {
  const now = useNow();
  if (!until || now === null) return null;
  const line = sellWindowLine(until, now, priced);
  return line ? <p className="sellwin">{noOrphan(line)}</p> : null;
}

/** The same clock, small, on a card in the collection. Nothing once it has closed. */
export function SellBadge({ until }: { until: string | null | undefined }) {
  const now = useNow();
  const left = until && now !== null ? sellWindowLeft(until, now) : null;
  if (!left) return null;
  const soon = Date.parse(until as string) - (now as number) < 6 * 60 * 60 * 1000;
  return (
    <span className={`sellbadge ${soon ? "soon" : ""}`} title="Time left to sell this card back instantly">
      Sell {left}
    </span>
  );
}
