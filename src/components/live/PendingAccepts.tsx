"use client";

import Link from "next/link";
import { noOrphan, tidy } from "@/lib/format";
import { parseLiveId, type LiveRef } from "@/lib/live/client";
import type { Award } from "@/lib/rails/types";
import { Slab } from "../Slab.tsx";
import { NftImg } from "../NftImg.tsx";
import { useAccept } from "./AcceptOffer.tsx";

function PendingRow({ id, award, onChange }: { id: string; award: Award; onChange: () => void }) {
  const { claiming, problem, claim, sheet } = useAccept(parseLiveId(id) as LiveRef, onChange);
  return (
    <div className="pendrow">
      <Link className="pendart" href={`/collection/${id}`} aria-label={`See ${award.name}`}>
        {award.kind === "nft" ? (
          <NftImg src={award.img} alt="" sizes="72px" />
        ) : (
          <Slab src={award.img} alt="" width={72} height={100} sizes="72px" onFail="placeholder" />
        )}
      </Link>
      <div className="pendinfo">
        <Link href={`/collection/${id}`}>{tidy(award.name).slice(0, 72)}</Link>
        {problem ? <p className="freshness">{noOrphan(problem)}</p> : null}
      </div>
      <button className="btn" disabled={claiming} onClick={() => void claim()}>
        Accept in wallet
      </button>
      {sheet}
    </div>
  );
}

/** Offers waiting on this wallet, first thing in the collection, so one can't get lost. Taking one is never required. */
export function PendingAccepts({ rows, onChange }: { rows: readonly { readonly id: string; readonly award: Award }[]; onChange: () => void }) {
  if (!rows.length) return null;
  return (
    <section className="s pending" aria-label="Waiting for you to accept">
      <h2>Waiting for you to accept</h2>
      <p className="fine">{noOrphan("A free offer is open for each of these. It waits for you, and you don't have to take it: open a prize to take the offer back and keep it in your stash.")}</p>
      {rows.map((h) => (
        <PendingRow key={h.id} id={h.id} award={h.award} onChange={onChange} />
      ))}
    </section>
  );
}
