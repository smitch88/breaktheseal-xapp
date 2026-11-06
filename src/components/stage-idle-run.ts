import { GAZE, HERO_BOX, HERO_DRIPS, SEAL_PX } from "@/lib/hero-art";
import { approach, makeIdle, seeded } from "@/lib/hero-idle";
import { depthShift, gazeToward, glintShift, pointerIn, raysAngle, type Vec } from "@/lib/stage-idle";
import { run } from "./bite-run.ts";
import { openEyes, paintPack, paintSeal, type PackEls, type SealEls } from "./idle-seal.tsx";

export type EyeGlints = { far: HTMLElement | null; near: HTMLElement | null };

export type StageIdleEls = {
  readonly zone: HTMLElement | null;
  readonly rays: HTMLElement | null;
  readonly cam: HTMLElement | null;
  readonly anchor: HTMLElement | null;
  readonly pack: PackEls;
  readonly seal: SealEls;
  readonly glints: EyeGlints;
};

const FAR_PX = { x: (HERO_BOX.lidFar[2] / 100) * SEAL_PX.w, y: (HERO_BOX.lidFar[3] / 100) * SEAL_PX.h };
const NEAR_PX = { x: (HERO_BOX.lidNear[2] / 100) * SEAL_PX.w, y: (HERO_BOX.lidNear[3] / 100) * SEAL_PX.h };
/** How long the layers take to come back to where the bite expects them: done before its first hit. */
const SETTLE_MS = 110;
/** Where the eyes are on the sprite, as a share of it. */
const HEAD = { x: 0.3, y: 0.28 };
const ZERO: Vec = { x: 0, y: 0 };

const px = (v: Vec) => `${v.x.toFixed(2)}px ${v.y.toFixed(2)}px`;

/**
 * The stage's idle while it waits for a bite: the hero's own pose on the seal and the pack, plus a slow turn of the rays and
 * a small response to the pointer. One loop writing transforms and opacity to plain images. It pauses in a hidden tab, and
 * `settle` stops it where it stands and hands every layer it moved back to the bite within SETTLE_MS, so the bite starts on time from a clean pose.
 */
export function startStageIdle(els: StageIdleEls, sheenLayers: number) {
  const idle = makeIdle(seeded((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0), { sheenLayers, drips: HERO_DRIPS.length, lift: false });
  const lids = { lids: "" };
  let raf = 0;
  let last = 0;
  let clock = 0;
  let spriteH = 0;
  let short = 0;
  let reach = 0;
  let rect = { left: 0, top: 0, width: 0, height: 0 };
  let head: Vec = ZERO;
  let pointer: Vec | null = null;
  let lean = ZERO;
  let gaze = ZERO;
  let nudge = 0;

  const measure = () => {
    const z = els.zone?.getBoundingClientRect();
    if (z) rect = { left: z.left, top: z.top, width: z.width, height: z.height };
    short = Math.min(rect.width, rect.height);
    reach = short * 0.42;
    const b = els.seal.breath;
    spriteH = b?.offsetHeight ?? 0;
    const s = b?.getBoundingClientRect();
    if (s) head = { x: s.left + s.width * HEAD.x, y: s.top + s.height * HEAD.y };
  };

  const write = (el: HTMLElement | null, value: string) => {
    if (el && el.style.translate !== value) el.style.translate = value;
  };

  const frame = (now: number) => {
    const dt = last ? Math.min(now - last, 50) : 16;
    last = now;
    clock += dt;
    const towards = pointer ? pointerIn(pointer.x, pointer.y, rect) : ZERO;
    lean = { x: approach(lean.x, towards.x, dt, 320), y: approach(lean.y, towards.y, dt, 320) };
    const looking = pointer ? gazeToward(pointer, head, reach) : ZERO;
    gaze = { x: approach(gaze.x, looking.x, dt, 110), y: approach(gaze.y, looking.y, dt, 110) };
    nudge = approach(nudge, pointer ? 1 : 0, dt);
    const p = idle.at(clock, nudge);
    paintPack(els.pack, p);
    paintSeal(els.seal, p, spriteH, lids);
    const shift = depthShift(lean, short);
    if (els.rays) els.rays.style.transform = `translate3d(${shift.rays.x.toFixed(2)}px,${shift.rays.y.toFixed(2)}px,0) rotate(${raysAngle(clock, lean.x).toFixed(3)}deg)`;
    write(els.cam, px(shift.pack));
    write(els.anchor, px(shift.seal));
    const far = glintShift(gaze, GAZE.far, FAR_PX);
    const near = glintShift(gaze, GAZE.near, NEAR_PX);
    if (els.glints.far) els.glints.far.style.transform = `translate3d(${far.x.toFixed(2)}%,${far.y.toFixed(2)}%,0)`;
    if (els.glints.near) els.glints.near.style.transform = `translate3d(${near.x.toFixed(2)}%,${near.y.toFixed(2)}%,0)`;
    raf = requestAnimationFrame(frame);
  };

  const sync = () => {
    if (!document.hidden && !raf) {
      last = 0;
      measure();
      raf = requestAnimationFrame(frame);
    } else if (document.hidden && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const onPoint = (e: PointerEvent) => {
    if (e.isPrimary) pointer = { x: e.clientX, y: e.clientY };
  };
  // A finger that lifts is gone; a mouse stays where it was.
  const onLift = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") pointer = null;
  };
  const onLeave = () => {
    pointer = null;
  };
  const page = document.documentElement;
  window.addEventListener("pointermove", onPoint, { passive: true });
  window.addEventListener("pointerdown", onPoint, { passive: true });
  window.addEventListener("pointerup", onLift, { passive: true });
  window.addEventListener("pointercancel", onLift, { passive: true });
  page.addEventListener("pointerleave", onLeave);
  window.addEventListener("resize", measure);
  document.addEventListener("visibilitychange", sync);
  sync();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("pointermove", onPoint);
    window.removeEventListener("pointerdown", onPoint);
    window.removeEventListener("pointerup", onLift);
    window.removeEventListener("pointercancel", onLift);
    page.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("resize", measure);
    document.removeEventListener("visibilitychange", sync);
  };

  /** The moment of the bite. The rays stop where they are, under the room heating up. The seal's own pose holds until the bite swaps its sprite. */
  const settle = () => {
    if (stopped) return;
    stop();
    openEyes(els.seal, lids);
    for (const el of [...els.seal.drips, ...els.pack.sheens]) {
      if (el && el.style.opacity !== "0") run(el, [{ opacity: el.style.opacity }, { opacity: 0 }], SETTLE_MS);
    }
    for (const el of [els.pack.whole, els.pack.wax]) {
      if (!el) continue;
      // A tap during the ready shake: that shake is already moving the pack and ends at rest by itself.
      if (!el.getAnimations().length) run(el, [{ transform: el.style.transform || "none" }, { transform: "none" }], SETTLE_MS, "ease-out");
      el.style.transform = "";
    }
    for (const el of [els.cam, els.anchor]) {
      if (!el) continue;
      run(el, [{ translate: el.style.translate || "0px 0px" }, { translate: "0px 0px" }], SETTLE_MS, "ease-out");
      el.style.translate = "";
    }
  };

  return { settle, stop };
}
