import { chomp, rip, sting } from "@/lib/audio";
import { RIP_ANCHOR } from "@/lib/rip-art";

/**
 * Clamp and Yank, as a timeline over elements someone else renders. The full-screen stage and the home hero's sample both
 * play this one, so the bite can't drift between them. Plain images moved by transform and opacity: no filters, no blend modes.
 */
export type BiteEls = {
  readonly zone: HTMLElement | null;
  readonly hot?: HTMLElement | null;
  readonly star: HTMLElement | null;
  readonly cam: HTMLElement | null;
  readonly rig: HTMLElement | null;
  readonly whole: HTMLElement | null;
  readonly back: HTMLElement | null;
  readonly body: HTMLElement | null;
  readonly top: HTMLElement | null;
  readonly rise: HTMLElement | null;
  readonly yank: HTMLElement | null;
  readonly anchor: HTMLElement | null;
  readonly open: HTMLElement | null;
  readonly clamp: HTMLElement | null;
  readonly pow: HTMLElement | null;
  readonly fx: HTMLElement | null;
};

export type BiteLook = {
  /** The seal's pose beside the pack, the same pose reared back, and the pack's offset before the head arrives. */
  readonly idle: string;
  readonly rear: string;
  readonly rig: string;
  /** How far down the zone the bite lands, as a share of its height. */
  readonly biteY: number;
  /** How much of the zone the item fills when it lands, and where its center ends up. */
  readonly landing: { readonly h: number; readonly w: number; readonly y: number };
  readonly star: { readonly w: number; readonly h: number; readonly y: number };
  /** Extra travel for the torn top, past the zone's edge. */
  readonly exitExtra: () => number;
  /** How long the still frame shows under reduced motion. */
  readonly stillMs: number;
  readonly flash: (color: string, peak: number, ms: number, easing?: string) => void;
};

export const STAGE_POSES = {
  idle: "translate(68%,24%) scale(.62)",
  rear: "translate(78%,20%) scale(.6) rotate(6deg)",
  rig: "translateX(-40%)",
  biteY: 0.34,
  landing: { h: 0.64, w: 0.74, y: 0.62 },
  star: { w: 1.35, h: 0.95, y: 0.2 },
  stillMs: 700,
} as const;

/** From the tap to the moment the item has landed and the star is out. */
export const biteMs = (level: number) => (level >= 3 ? 2050 : 1700);

const EASE_IN = "cubic-bezier(.6,0,1,.5)";
export const EASE_OUT = "cubic-bezier(.1,.8,.25,1)";
export const SNAP = "cubic-bezier(.2,1.4,.4,1)";

/** Atlas cells: nine foil shreds, then wax. Cells 15 and 17 are round drops, which read as balls in the air. */
const FOIL_CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const WAX_CELLS = [9, 10, 11, 12, 13, 14, 16];
const ALL_CELLS = [...FOIL_CELLS, ...WAX_CELLS];

export const run = (el: Element | null | undefined, frames: Keyframe[], duration: number, easing = "linear") => el?.animate(frames, { duration, easing, fill: "forwards" });
const show = (...els: (HTMLElement | null)[]) => els.forEach((e) => e && (e.style.visibility = "visible"));
const hide = (...els: (HTMLElement | null)[]) => els.forEach((e) => e && (e.style.visibility = "hidden"));

export const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/** Foil shreds and wax shards off one atlas: transforms only, a few at a time, and each removes itself. */
function spray(box: HTMLElement | null, x: number, y: number, count: number, kind: "foil" | "wax" | "mixed", reach: number) {
  if (!box) return;
  const fall = box.clientHeight + 120 - y;
  for (let i = 0; i < count; i++) {
    const pool = kind === "foil" ? FOIL_CELLS : kind === "wax" ? WAX_CELLS : ALL_CELLS;
    const cell = pool[Math.floor(Math.random() * pool.length)];
    const d = document.createElement("div");
    d.className = "shr";
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    d.style.setProperty("--s", `${(cell < 9 ? 40 : 24) + Math.random() * (cell < 9 ? 44 : 30)}px`);
    d.style.backgroundPosition = `${(cell % 6) * 20}% ${Math.floor(cell / 6) * 50}%`;
    box.appendChild(d);
    // Mostly up and out, then falling.
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const r = reach * (0.45 + Math.random() * 0.75);
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r;
    const spin = Math.random() * 900 - 450;
    // Thrown fast, then falling off the bottom of the screen, so nothing hangs in the air at the end.
    const anim = d.animate(
      [
        { transform: "translate(-50%,-50%) scale(.5)", easing: "cubic-bezier(.1,.8,.3,1)" },
        { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(${spin * 0.6}deg)`, offset: 0.4, easing: "cubic-bezier(.5,0,.9,.6)" },
        { transform: `translate(calc(-50% + ${dx * 1.15}px),calc(-50% + ${fall}px)) rotate(${spin}deg)` },
      ],
      { duration: 760 + Math.random() * 300, fill: "forwards" },
    );
    anim.onfinish = () => d.remove();
  }
}

/** Where the item and the branded star end up, in the zone's own pixels. */
function measure(els: BiteEls, look: BiteLook) {
  const { zone: z, rig: r, cam: c, rise: s } = els;
  if (!z || !r || !c || !s) return null;
  const zw = z.clientWidth;
  const zh = z.clientHeight;
  const rx = (c.clientWidth - r.offsetWidth) / 2;
  const ry = (c.clientHeight - r.offsetHeight) / 2;
  const scale = Math.min((zh * look.landing.h) / s.offsetHeight, (zw * look.landing.w) / s.offsetWidth);
  const tx = zw / 2 - (rx + s.offsetLeft + s.offsetWidth / 2);
  const ty = zh * look.landing.y - (ry + s.offsetTop + s.offsetHeight / 2);
  return { zw, zh, rx, ry, scale, tx, ty, rw: r.offsetWidth, rh: r.offsetHeight };
}

function placeStar(el: HTMLElement | null, zw: number, zh: number, look: BiteLook) {
  if (!el) return;
  const w = Math.min(zw * look.star.w, zh * look.star.h);
  el.style.width = `${w}px`;
  el.style.left = `${zw / 2 - (w * RIP_ANCHOR.star[0]) / 100}px`;
  el.style.top = `${zh * look.star.y - (w * RIP_ANCHOR.star[1]) / 100}px`;
}

/** The bite. It only shows what it's handed: the caller has already decided what, if anything, is coming out of the pack. */
export function playBite(els: BiteEls, parts: { readonly wx: number; readonly wy: number; readonly tear: number }, level: number, color: string, later: (f: () => void, ms: number) => void, look: BiteLook, onDone: () => void) {
  const m = measure(els, look);
  if (!m) {
    later(onDone, 300);
    return;
  }
  placeStar(els.star, m.zw, m.zh, look);
  const riseAt = `translate(${m.tx}px,${m.ty}px) scale(${m.scale})`;

  if (reducedMotion()) {
    // One still frame, no movement: the opened pack's payoff, then the reveal.
    sting(level, 0);
    hide(els.whole, els.open, els.top, els.back, els.body);
    if (els.hot) els.hot.style.opacity = "1";
    if (els.star) els.star.style.opacity = "1";
    if (els.rise) {
      els.rise.style.visibility = "visible";
      els.rise.style.transform = riseAt;
    }
    if (els.rig) els.rig.style.transform = "none";
    later(onDone, look.stillMs);
    return;
  }

  const waxX = m.rx + (parts.wx / 100) * m.rw;
  const waxY = m.ry + (parts.wy / 100) * m.rh;
  const punch = 1.18;
  const camX = -0.1 * m.zw;
  const camY = look.biteY * m.zh - (m.zh / 2 + (waxY - m.zh / 2) * punch);
  const hitX = m.zw / 2 + (waxX - m.zw / 2) * punch + camX;
  const hitY = look.biteY * m.zh;
  const shake = (ms = 300) => run(els.zone, [{ transform: "none" }, { transform: "translate(-7px,4px)" }, { transform: "translate(6px,-4px)" }, { transform: "translate(-4px,-2px)" }, { transform: "translate(3px,2px)" }, { transform: "none" }], ms);
  // The impact star sits between the pack and the seal, so the teeth stay in front of it.
  const pop = (size: number, y: string, ms: number) => {
    const el = els.pow;
    if (!el) return;
    el.style.width = `${size}%`;
    el.style.top = y;
    run(el, [{ transform: "translate(-50%,-50%) scale(.3) rotate(-14deg)", opacity: 1 }, { transform: "translate(-50%,-50%) scale(1.1) rotate(4deg)", opacity: 1, offset: 0.7 }, { transform: "translate(-50%,-50%) scale(1.16) rotate(6deg)", opacity: 0 }], ms);
  };

  // The room heats up, the seal rears back.
  run(els.hot, [{ opacity: 0 }, { opacity: 1 }], 90);
  run(els.anchor, [{ transform: look.idle }, { transform: look.rear }], 110, "ease-out");

  // Lunge: the camera pushes in on the wax as the head arrives.
  later(() => {
    run(els.rig, [{ transform: look.rig }, { transform: "translateX(0)" }], 120, EASE_IN);
    run(els.cam, [{ transform: "none" }, { transform: `translate(${camX}px,${camY}px) scale(${punch})` }], 120, EASE_IN);
    run(els.anchor, [{ transform: look.rear }, { transform: "translate(0,0) scale(1) rotate(-4deg)" }], 120, EASE_IN);
  }, 110);

  // Clamp: teeth shut on the wax, it cracks.
  later(() => {
    hide(els.open);
    show(els.clamp);
    chomp(0);
    shake();
    pop(190, "var(--wy)", 260);
    spray(els.fx, hitX, hitY, 5, "wax", m.zw * 0.5);
    look.flash("#fff", 0.4, 110);
    // Two hard shakes of the head, pivoting on the bite.
    run(els.anchor, [{ transform: "rotate(-4deg)" }, { transform: "rotate(5deg)", offset: 0.3 }, { transform: "rotate(-6deg)", offset: 0.65 }, { transform: "rotate(-2deg)" }], 320, "ease-in-out");
  }, 230);
  later(() => spray(els.fx, hitX, hitY, 3, "wax", m.zw * 0.4), 390);

  // Rip: the top of the pack goes with the teeth.
  later(() => {
    hide(els.whole);
    show(els.back, els.body, els.top, els.rise);
    rip(0);
    shake(260);
    pop(150, "var(--tear)", 170);
    const seam = hitY + m.rh * ((parts.tear - parts.wy) / 100) * punch;
    spray(els.fx, m.zw / 2 + camX, seam, 10 + level * 2, "foil", m.zw * 0.85);
    spray(els.fx, m.zw / 2 + camX, seam, 5 + level, "wax", m.zw * 0.7);
    const exit = -(m.ry + m.rh * 1.25 + m.zh * 0.2 + look.exitExtra());
    run(els.yank, [{ transform: "none", offset: 0 }, { transform: `translate(${m.rw * 0.16}px,${exit * 0.22}px) rotate(9deg)`, offset: 0.3 }, { transform: `translate(${m.rw * 0.5}px,${exit}px) rotate(24deg)`, offset: 1 }], 300, "cubic-bezier(.3,.1,.6,1)");
  }, 550);

  // The camera lets go, the slab climbs out of the torn foil.
  later(() => {
    run(els.cam, [{ transform: `translate(${camX}px,${camY}px) scale(${punch})` }, { transform: "none" }], 300, EASE_OUT);
    run(els.rise, [{ transform: "translateY(0)" }, { transform: "translateY(-46%)" }], 340, SNAP);
    run(els.body, [{ transform: "none" }, { transform: "translateY(3%)" }], 340, "ease-out");
  }, 640);

  // Payoff: the branded star slams in behind the slab, the empty foil drops away.
  later(() => {
    sting(level, 0);
    shake(240);
    run(els.rise, [{ transform: "translateY(-46%)" }, { transform: riseAt }], 220, SNAP);
    run(els.star, [{ transform: "scale(.2) rotate(-10deg)", opacity: 1 }, { transform: "scale(1.08) rotate(2deg)", opacity: 1, offset: 0.7 }, { transform: "none", opacity: 1 }], 240, EASE_OUT);
    run(els.body, [{ transform: "translateY(3%)" }, { transform: `translateY(${m.zh}px) rotate(7deg)` }], 300, EASE_IN);
    run(els.back, [{ transform: "none" }, { transform: `translateY(${m.zh}px) rotate(-6deg)` }], 300, EASE_IN);
    look.flash(color, 0.6, 220, "ease-out");
    spray(els.fx, m.zw / 2, m.zh * 0.5, 8 + level * 3, "mixed", m.zw * 0.8);
  }, 1040);

  // The rare tiers land twice.
  if (level >= 3) {
    later(() => {
      chomp(0);
      shake(240);
      run(els.star, [{ transform: "none" }, { transform: "scale(1.14)", offset: 0.4 }, { transform: "none" }], 260, SNAP);
      look.flash(color, 0.65, 220, "ease-out");
      spray(els.fx, m.zw / 2, m.zh * 0.5, 16, "mixed", m.zw * 0.9);
    }, 1420);
  }
  later(onDone, biteMs(level));
}
