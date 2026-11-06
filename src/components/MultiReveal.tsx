"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { noOrphan, tidy, usd2 } from "@/lib/format";
import type { PullMultiple } from "@/lib/pull-multiple";
import { rarestFirst } from "@/lib/live/multi";
import type { Award } from "@/lib/rails/types";
import { SUMMARY, nextLabel, nextStep, packCount, readStep, resumeStep, writeStep, type FlowStep } from "@/lib/reveal-flow";
import { useBackClose, useTopSheet } from "@/lib/sheet-stack";
import { SellBadge } from "./live/SellWindow.tsx";
import { RevealView } from "./RevealView.tsx";
import { Slab } from "./Slab.tsx";
import { NftImg } from "./NftImg.tsx";
import { Stage, type StageMode } from "./Stage.tsx";
import { MultBadge, TierLabel } from "./ui.tsx";

export interface MultiRow {
  readonly id: string;
  readonly award: Award;
  /** Where it stands, in the same words the collection uses. */
  readonly status?: string;
  /** Its own page, where every action a single pull has still lives. */
  readonly href?: string;
  readonly selectable?: boolean;
  /** A card's instant sell-back window, while it's in the stash. */
  readonly sellUntil?: string | null;
  /** What it's worth to sell back, or what it sends, as the server quoted it. `line` is the same as one sentence, for the phone list. */
  readonly sell?: { readonly label: string; readonly value: string; readonly line?: string } | null;
  /** Why it can't be picked for a cash out right now, in a few words. */
  readonly why?: string | null;
  /** Where anyone can check this pull. */
  readonly proof?: string | null;
  /** What it gets back now against its one pack's price. Absent until both are known. */
  readonly multiple?: PullMultiple | null;
}

/** A pack in an order that has no prize to show yet, or won't have one: still drawing, being checked, or coming back as XRP. */
export interface PendingTile {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

/** One pack of a multi order, in the order they open. A pack still drawing has no row yet, and the stage waits for it. */
export interface FlowPack {
  readonly id: string;
  readonly row: MultiRow | null;
}

function AwardArt({ award, sizes = "(min-width:1000px) 220px, 45vw" }: { award: Award; sizes?: string }) {
  if (award.kind === "card" && !award.token) return <Slab src={award.img} alt="" width={200} height={270} sizes={sizes} onFail="placeholder" />;
  if (award.kind === "nft" && !award.token) return <NftImg src={award.img} alt="" sizes={sizes} />;
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={award.img} alt="" />;
}

/** Where this device left an order, once it's been read. Null until then, so nothing flashes the wrong step first. */
function useFlowStep(flowId: string | null, total: number) {
  const [step, setStep] = useState<FlowStep | null>(null);
  useEffect(() => {
    setStep((s) => s ?? resumeStep(flowId ? readStep(flowId) : null, total));
  }, [flowId, total]);
  const go = useCallback(
    (s: FlowStep) => {
      setStep(s);
      if (flowId) writeStep(flowId, s);
    },
    [flowId],
  );
  // A run can only get shorter (a pack that comes back as XRP leaves it), and a place past its end is the results.
  return { step: step === null ? null : resumeStep(step, total), go };
}

/**
 * A paid multi order, one pack at a time: the same bite and reveal as a single pack, then Next or Skip to results. It only shows prizes the
 * server already fixed, and a pack still drawing waits on the stage, so leaving at any point loses nothing. Back, from the phone or the
 * browser, goes to the results rather than out of the order.
 */
export function MultiFlow({ flowId, packs, art, packName, tag, stageMode, waitSteps, onClose, revealFoot, summary }: { flowId: string | null; packs: readonly FlowPack[]; art: string; packName: string; tag?: string; stageMode: StageMode; waitSteps?: readonly { readonly done: boolean; readonly wait: string; readonly yes: string }[]; onClose: () => void; revealFoot?: (row: MultiRow) => React.ReactNode; summary: React.ReactNode }) {
  const total = packs.length;
  const { step, go } = useFlowStep(flowId, total);
  const inFlow = !!step && step.view !== "summary";
  const isTop = useTopSheet();
  const toResults = useBackClose(inFlow, () => go(SUMMARY), isTop);

  if (!step) return <div className="stage" />;
  if (step.view === "summary") return <>{summary}</>;
  const pack = packs[step.at];
  const count = packCount(step.at, total);
  const skip = (
    <button type="button" className="linky" onClick={toResults}>
      Skip to results
    </button>
  );
  if (step.view === "bite" || !pack.row) {
    return <Stage key={`bite-${pack.id}`} art={art} award={pack.row?.award ?? null} error={null} mode={stageMode} held count={count} networkTag={tag} steps={waitSteps} waitingOn={skip} onClose={onClose} onReveal={() => go(nextStep({ view: "bite", at: step.at }, total))} />;
  }
  const last = step.at + 1 >= total;
  return (
    <RevealView
      key={`reveal-${pack.id}`}
      award={pack.row.award}
      packName={packName}
      multiple={pack.row.multiple}
      tag={tag}
      count={count}
      onClose={onClose}
      actions={
        <div className="mnext">
          <button type="button" className="btn" onClick={last ? toResults : () => go(nextStep(step, total))}>
            {noOrphan(nextLabel(step, total))}
          </button>
          {last ? null : (
            <button type="button" className="btn ol" onClick={toResults}>
              Skip to results
            </button>
          )}
        </div>
      }
      foot={revealFoot?.(pack.row)}
    />
  );
}

const NARROW = "(max-width:760px)";
const narrowNow = () => window.matchMedia(NARROW).matches;
const onNarrow = (cb: () => void) => {
  const q = window.matchMedia(NARROW);
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
};
/** Phones get the list, wider screens the cards. Only ever read after hydration, so the first paint never guesses. */
const useNarrow = () => useSyncExternalStore(onNarrow, narrowNow, () => false);

const chevron = (
  <svg className="mrchev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

/** Every pull in a multi order, rarest first, with what each sells back for and where to check it. Selection is only ever for a bulk action the server has already said is possible. */
/**
 * `total` is the whole order's multiple, only once every pull in it is priced. On a phone the pulls are a compact list, one row each, and
 * a row opens that pull's page; `tools` sits on the list's header row and `foot` closes the list. Wider screens keep the cards.
 */
export function MultiGrid({ rows, pending, packArt, title, tag, notes, actions, selecting, selected, onToggle, total: multiple, onClose, sellTotal, sellLabel = "Sells back for", tools, foot, barNote }: { rows: readonly MultiRow[]; pending?: readonly PendingTile[]; packArt?: string; title: string; tag?: string; notes?: React.ReactNode; actions?: React.ReactNode; selecting?: boolean; selected?: ReadonlySet<string>; onToggle?: (id: string) => void; total?: PullMultiple | null; onClose: () => void; sellTotal?: string | null; sellLabel?: string; tools?: React.ReactNode; foot?: React.ReactNode; barNote?: React.ReactNode }) {
  const sorted = rarestFirst(rows);
  const total = rows.reduce((a, r) => a + r.award.value, 0);
  const narrow = useNarrow();
  return (
    <div className="stage mgrid">
      <div className="stop one">
        <div className="tl">
          <button className="sq" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="hint rpack">{tag ?? "YOURS"}</div>
        <span />
      </div>
      <div className="mscroll">
        <div className="mhead">
          <div className="mtitle">
            <h1 className="sm">
              {title}
              <em>.</em>
            </h1>
            <MultBadge m={multiple} label="what these packs cost" />
          </div>
          {rows.length ? (
            <div className="mtotals">
              <div className="mtotal">
                <span className="lb">Total value</span>
                <strong>{usd2(total)}</strong>
              </div>
              {sellTotal ? (
                <div className="mtotal">
                  <span className="lb">{sellLabel}</span>
                  <strong>{sellTotal}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {notes}
        {tools ? <div className="mtools">{tools}</div> : null}
        {narrow ? (
          <ul className="mlist">
            {sorted.map((r) => {
              const on = !!selected?.has(r.id);
              const inner = (
                <>
                  {selecting ? (
                    <span className={on ? "mbox on" : "mbox"} aria-hidden="true">
                      {on ? "✓" : ""}
                    </span>
                  ) : null}
                  <span className="mthumb">
                    <AwardArt award={r.award} sizes="48px" />
                  </span>
                  <span className="mrmain">
                    <span className="mrname">{tidy(r.award.name).slice(0, 72)}</span>
                    <span className="mrmeta">
                      <TierLabel tier={r.award.tier} />
                      {r.status ? <span>{r.status}</span> : null}
                    </span>
                    {selecting && !r.selectable ? <span className="mrwhy">{r.why ?? "Not part of a cash out"}</span> : r.sell ? <span className="mrcash">{r.sell.line ?? `${r.sell.label} ${r.sell.value}`}</span> : null}
                  </span>
                  <span className="mrside">
                    <MultBadge m={r.multiple} />
                    <strong>{usd2(r.award.value)}</strong>
                  </span>
                </>
              );
              return (
                <li key={r.id}>
                  {selecting ? (
                    <button type="button" className={on ? "mrow sel on" : "mrow sel"} disabled={!r.selectable} aria-pressed={on} onClick={() => onToggle?.(r.id)}>
                      {inner}
                    </button>
                  ) : r.href ? (
                    <Link className="mrow" href={r.href} aria-label={`${tidy(r.award.name)}, ${r.award.tier}, ${usd2(r.award.value)}. See it`}>
                      {inner}
                      {chevron}
                    </Link>
                  ) : (
                    <div className="mrow">{inner}</div>
                  )}
                </li>
              );
            })}
            {(pending ?? []).map((p) => (
              <li key={p.id} role="status">
                <div className="mrow mrpend">
                  <span className="mthumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {packArt ? <img src={packArt} alt="" /> : null}
                  </span>
                  <span className="mrmain">
                    <span className="mrname">{p.title}</span>
                    <span className="mrcash">{noOrphan(p.detail)}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="igrid mtiles">
            {sorted.map((r) => {
              const on = !!selected?.has(r.id);
              const body = (
                <>
                  <div className="ia">
                    <AwardArt award={r.award} />
                    {r.sellUntil ? <SellBadge until={r.sellUntil} /> : null}
                  </div>
                  <div className="mtags">
                    <TierLabel tier={r.award.tier} />
                    <MultBadge m={r.multiple} />
                  </div>
                  <h3>{tidy(r.award.name).slice(0, 72)}</h3>
                  <div className="mr">
                    <div>
                      <span className="lb">{r.award.token ? "Worth" : r.award.kind === "nft" ? "Marked value" : "Listed value"}</span>
                      <strong>{usd2(r.award.value)}</strong>
                    </div>
                    {r.status ? <small>{r.status}</small> : null}
                  </div>
                  {selecting && !r.selectable ? (
                    <p className="fine mwhy">{r.why ?? "Not part of a cash out"}</p>
                  ) : r.sell ? (
                    <div className="msell">
                      <span className="lb">{r.sell.label}</span>
                      <strong>{r.sell.value}</strong>
                    </div>
                  ) : null}
                </>
              );
              if (selecting) {
                return (
                  <button key={r.id} type="button" className={on ? "item mtile on" : "item mtile"} disabled={!r.selectable} aria-pressed={on} onClick={() => onToggle?.(r.id)}>
                    <span className="mcheck" aria-hidden="true">
                      {on ? "✓" : ""}
                    </span>
                    {body}
                  </button>
                );
              }
              return (
                <div key={r.id} className="item mtile">
                  {r.href ? (
                    <Link className="mtilelink" href={r.href} aria-label={`See ${tidy(r.award.name)}`}>
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                  {r.href || r.proof ? (
                    <div className="mlinks">
                      {r.href ? <Link href={r.href}>Details</Link> : null}
                      {r.proof ? <Link href={r.proof}>Proof</Link> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {(pending ?? []).map((p) => (
              <div key={p.id} className="item mtile mpend" role="status">
                <div className="ia">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {packArt ? <img src={packArt} alt="" /> : null}
                </div>
                <h3>{p.title}</h3>
                <p className="fine">{noOrphan(p.detail)}</p>
              </div>
            ))}
          </div>
        )}
        {foot}
      </div>
      {actions ? (
        <div className="mbar">
          {barNote ? <p className="fine mbarnote">{barNote}</p> : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
