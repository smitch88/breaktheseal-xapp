"use client";

import { useEffect, useState } from "react";
import type { Item } from "@/lib/catalog/types";
import { tidy, usd } from "@/lib/format";
import { api } from "@/lib/live/client";
import { certUrl, type CardDetails } from "@/lib/live/proof";
import { capitalize } from "@/lib/tiers";
import type { TierName } from "@/lib/rails/types";
import { CardArt } from "./CardArt.tsx";
import { DetailSheet } from "./DetailSheet.tsx";
import { TierLabel } from "./ui.tsx";

/** Everything known about one card in a pack. The list row shows at once, and the card's record fills in the rest. */
export function PackCardSheet({ item, code, onClose }: { item: Item; code: string; onClose: () => void }) {
  const [details, setDetails] = useState<CardDetails | null>(null);
  useEffect(() => {
    let live = true;
    void api<{ details: CardDetails | null }>(`/api/packs/${encodeURIComponent(code)}/card/${encodeURIComponent(item.id)}`)
      .then((r) => {
        if (live && r.ok) setDetails(r.body.details);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, item.id]);
  const name = tidy(details?.name ?? item.name);
  const grader = details?.grader ?? item.grader ?? null;
  const cert = details?.cert ?? item.cert ?? null;
  const certLink = certUrl(grader, cert);
  const fact = (label: string, value: string | number | null | undefined) =>
    value === null || value === undefined || value === "" ? null : (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    );
  return (
    <DetailSheet label={name} onClose={onClose}>
      <div className="dart">
        <CardArt name={name} front={details?.front ?? item.img} back={details?.back ?? item.back} sizes="(min-width:760px) 380px, 80vw" priority />
      </div>
      <div className="dinfo">
        <TierLabel tier={capitalize(item.rarity) as TierName} />
        <h3>{name}</h3>
        <dl className="dl">
          {fact("Listed value", usd(item.ins))}
          {fact("Grade", item.grade)}
          {cert ? (
            <div>
              <dt>Cert number</dt>
              <dd>
                {certLink ? (
                  <a href={certLink} target="_blank" rel="noopener">
                    {cert}
                  </a>
                ) : (
                  cert
                )}
              </dd>
            </div>
          ) : null}
          {fact("Set", details?.set)}
          {fact("Year", details?.year ?? item.year)}
          {fact("Card number", details?.number)}
          {fact("Edition", item.parallel)}
          {fact("Category", details?.category ?? item.category)}
          {fact("Language", details?.language)}
          {fact("Graded at this grade", item.population?.toLocaleString("en-US"))}
          {fact("Kept in", details?.vault ?? item.vault)}
        </dl>
      </div>
    </DetailSheet>
  );
}
