import type { ReactNode } from "react";
import { HERO_ART, HERO_BOX, HERO_DRIPS } from "@/lib/hero-art";
import type { IdlePose, Lid } from "@/lib/hero-idle";

/** The seal's living layers and the pose writer, shared by the home hero and the pack-opening screen so the two can't drift. */
export type SealEls = {
  breath: HTMLDivElement | null;
  jaw: HTMLImageElement | null;
  lids: Partial<Record<"farHalf" | "farShut" | "nearHalf" | "nearShut", HTMLImageElement | null>>;
  drips: (HTMLDivElement | null)[];
};
export type PackEls = { whole: HTMLElement | null; wax: HTMLImageElement | null; sheens: (HTMLImageElement | null)[] };

export const newSealEls = (): SealEls => ({ breath: null, jaw: null, lids: {}, drips: [] });
export const newPackEls = (): PackEls => ({ whole: null, wax: null, sheens: [] });

export const box = ([left, top, width, height]: readonly number[]) => ({ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` });
export const origin = ([x, y]: readonly number[]) => `${x}% ${y}%`;

const lid = (half: HTMLImageElement | null | undefined, shut: HTMLImageElement | null | undefined, l: Lid) => {
  if (half) half.style.visibility = l === 1 ? "visible" : "hidden";
  if (shut) shut.style.visibility = l === 2 ? "visible" : "hidden";
};

/** Writes one pose to plain images, by transform and opacity. `mem` keeps the lids from being rewritten every frame. */
export function paintSeal(els: SealEls, p: IdlePose, spriteH: number, mem: { lids: string }) {
  if (els.breath) els.breath.style.transform = `rotate(${p.seal.turn.toFixed(3)}deg) scale(${p.seal.sx.toFixed(4)},${p.seal.sy.toFixed(4)})`;
  if (els.jaw) els.jaw.style.transform = p.jaw ? `rotate(${(-p.jaw).toFixed(3)}deg)` : "";
  p.drips.forEach((d, i) => {
    const el = els.drips[i];
    if (!el) return;
    el.dataset.phase = d.phase;
    el.style.opacity = d.opacity.toFixed(3);
    if (d.opacity > 0) el.style.transform = `translate3d(-50%,${(d.drop * HERO_DRIPS[i].fall * spriteH).toFixed(2)}px,0) scale(${d.sx.toFixed(3)},${d.sy.toFixed(3)})`;
  });
  const key = `${p.lids.far}${p.lids.near}`;
  if (key !== mem.lids) {
    mem.lids = key;
    lid(els.lids.farHalf, els.lids.farShut, p.lids.far);
    lid(els.lids.nearHalf, els.lids.nearShut, p.lids.near);
  }
}

export function paintPack(els: PackEls, p: IdlePose) {
  if (els.whole) els.whole.style.transform = `translate3d(0,${p.pack.lift.toFixed(3)}%,0) rotate(${p.pack.turn.toFixed(3)}deg) scale(${p.pack.scale.toFixed(4)})`;
  if (els.wax) els.wax.style.transform = `rotate(${p.wax.turn.toFixed(3)}deg) scale(${p.wax.scale.toFixed(4)})`;
  p.sheen.forEach((o, i) => {
    const el = els.sheens[i];
    if (el) el.style.opacity = o < 0.004 ? "0" : o.toFixed(3);
  });
}

/** Eyes open. A lid has to be hidden by itself: one left visible would stay on screen after the bite hides the seal around it. */
export function openEyes(els: SealEls, mem: { lids: string }) {
  for (const el of Object.values(els.lids)) if (el) el.style.visibility = "hidden";
  mem.lids = "";
}

export function restSeal(els: SealEls, mem: { lids: string }) {
  for (const el of [els.breath, els.jaw]) if (el) el.style.transform = "";
  for (const el of els.drips) if (el) el.style.opacity = "0";
  openEyes(els, mem);
}

export function restPack(els: PackEls) {
  for (const el of [els.whole, els.wax]) if (el) el.style.transform = "";
  for (const el of els.sheens) if (el) el.style.opacity = "0";
}

const LIDS = [
  ["farHalf", HERO_ART.lid.far.half, HERO_BOX.lidFar],
  ["farShut", HERO_ART.lid.far.shut, HERO_BOX.lidFar],
  ["nearHalf", HERO_ART.lid.near.half, HERO_BOX.lidNear],
  ["nearShut", HERO_ART.lid.near.shut, HERO_BOX.lidNear],
] as const;

/** Everything that sits on the seal's sprite and moves with its breathing. `eyes` goes under the lids, so a blink covers it. */
export function SealLayers({ els, eyes }: { els: { current: SealEls }; eyes?: ReactNode }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="hjaw"
        ref={(el) => {
          els.current.jaw = el;
        }}
        src={HERO_ART.jaw}
        style={{ ...box(HERO_BOX.jaw), transformOrigin: origin(HERO_BOX.jawPivot) }}
        alt=""
      />
      {eyes}
      {LIDS.map(([key, s, b]) => (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          key={key}
          className="hlid"
          ref={(el) => {
            els.current.lids[key] = el;
          }}
          src={s}
          style={box(b)}
          alt=""
        />
      ))}
      {HERO_DRIPS.map((d, i) => (
        <div
          key={i}
          className="hdrip"
          data-phase="wait"
          ref={(el) => {
            els.current.drips[i] = el;
          }}
          style={{ left: `${d.x}%`, top: `${d.y}%` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="d-swell" src={HERO_ART.drop.bead} alt="" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="d-stretch" src={HERO_ART.drop.long} alt="" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="d-fall" src={HERO_ART.drop.tear} alt="" />
        </div>
      ))}
    </>
  );
}

/** The foil's light, one image per band. */
export function SheenLayers({ els, srcs }: { els: { current: PackEls }; srcs: readonly string[] }) {
  return (
    <>
      {srcs.map((s, i) => (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          key={s}
          className="pk hsheen"
          ref={(el) => {
            els.current.sheens[i] = el;
          }}
          src={s}
          alt=""
        />
      ))}
    </>
  );
}
