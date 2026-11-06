/**
 * The home hero's idle, as math. Nothing here touches the page: the component asks for a pose at a time and writes it to
 * plain images with transform and opacity. Every beat draws its own gap from the random source, so nothing repeats on a
 * fixed count. The seal stays grounded: it breathes and leans from the base of the hoodie and never moves up or down.
 */
export type Rng = () => number;

/** A small seeded source, so a whole idle can be replayed in a test. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const wave = (t: number, ms: number, phase = 0) => Math.sin((t / ms) * Math.PI * 2 + phase);

export const POSE_LIMITS = { packTurn: 0.95, packScale: 0.007, packLift: 0.7, sealTurn: 1.15, sealSquash: 0.014, jaw: 2.4, waxScale: 0.036, waxTurn: 1.2 } as const;

/** 0 open, 1 half shut, 2 shut. */
export type Lid = 0 | 1 | 2;
export type Lids = { readonly far: Lid; readonly near: Lid };

type LidStep = { readonly ms: number; readonly lids: Lids };
export type EyeBeat = { readonly kind: "blink" | "double" | "wink-far" | "wink-near"; readonly at: number; readonly steps: readonly LidStep[]; readonly end: number };

const both = (l: Lid): Lids => ({ far: l, near: l });
const blinkSteps: readonly LidStep[] = [
  { ms: 50, lids: both(1) },
  { ms: 80, lids: both(2) },
  { ms: 60, lids: both(1) },
];
const winkSteps = (eye: "far" | "near"): readonly LidStep[] => {
  const one = (l: Lid): Lids => (eye === "far" ? { far: l, near: 0 } : { far: 0, near: l });
  return [
    { ms: 70, lids: one(1) },
    { ms: 430, lids: one(2) },
    { ms: 90, lids: one(1) },
  ];
};

/** The next blink or wink after `after`: mostly short gaps, now and then a long stare. */
export function nextEyeBeat(rng: Rng, after: number): EyeBeat {
  const at = after + 1800 + 5200 * Math.pow(rng(), 1.7);
  const roll = rng();
  const kind: EyeBeat["kind"] = roll < 0.14 ? "double" : roll < 0.24 ? "wink-near" : roll < 0.3 ? "wink-far" : "blink";
  const steps = kind === "double" ? [...blinkSteps, { ms: 110, lids: both(0) }, ...blinkSteps] : kind === "blink" ? blinkSteps : winkSteps(kind === "wink-far" ? "far" : "near");
  return { kind, at, steps, end: at + steps.reduce((n, s) => n + s.ms, 0) };
}

export function lidsAt(beat: EyeBeat, t: number): Lids {
  if (t < beat.at || t >= beat.end) return both(0);
  let edge = beat.at;
  for (const s of beat.steps) {
    edge += s.ms;
    if (t < edge) return s.lids;
  }
  return both(0);
}

/** A short hungry snap of the jaw, one to three chatters. */
export type Twitch = { readonly at: number; readonly end: number; readonly count: number; readonly amp: number };

export function nextTwitch(rng: Rng, after: number): Twitch {
  const at = after + between(rng, 3800, 10500);
  const roll = rng();
  const count = roll < 0.55 ? 1 : roll < 0.9 ? 2 : 3;
  return { at, end: at + count * TWITCH_MS, count, amp: between(rng, 0.55, 1) };
}

const TWITCH_MS = 210;

export function jawAt(tw: Twitch, t: number): number {
  if (t < tw.at || t >= tw.end) return 0;
  const p = ((t - tw.at) % TWITCH_MS) / TWITCH_MS;
  return POSE_LIMITS.jaw * tw.amp * Math.sin(p * Math.PI);
}

/** The wax throbbing like something is pushing behind it, with the odd tremble. */
export type Tremble = { readonly at: number; readonly end: number; readonly amp: number };

export function nextTremble(rng: Rng, after: number): Tremble {
  const at = after + between(rng, 4200, 11500);
  return { at, end: at + between(rng, 380, 720), amp: between(rng, 0.6, 1) };
}

/** Only ever grows from its rest size: the wax sits on a copy of itself, so it must never shrink below that copy. */
export function waxAt(tr: Tremble, t: number): { readonly scale: number; readonly turn: number } {
  const throb = 0.5 + 0.5 * wave(t, 2300) * wave(t, 3700, 0.8);
  const env = t >= tr.at && t < tr.end ? tr.amp * Math.sin(((t - tr.at) / (tr.end - tr.at)) * Math.PI) : 0;
  return {
    scale: 1 + POSE_LIMITS.waxScale * (0.42 * clamp01(throb) + 0.58 * env),
    turn: POSE_LIMITS.waxTurn * env * wave(t, 74),
  };
}

/** Light crossing the foil: each layer holds one diagonal band of the pack's own highlights, and they fade up in order. */
export type Sweep = { readonly at: number; readonly end: number; readonly peak: number };

export function nextSweep(rng: Rng, after: number): Sweep {
  const at = after + between(rng, 1400, 5200);
  return { at, end: at + between(rng, 2100, 3900), peak: between(rng, 0.6, 1) };
}

export function sheenAt(sw: Sweep, t: number, layers: number): readonly number[] {
  const p = clamp01((t - sw.at) / (sw.end - sw.at));
  const head = t < sw.at || t >= sw.end ? -9 : p * (layers + 1) - 1;
  return Array.from({ length: layers }, (_, i) => {
    const d = (head - i) / 0.9;
    return sw.peak * Math.exp(-d * d);
  });
}

/** One saliva drop's life at one lip: it swells, stretches on its neck, lets go and fades on the way down. */
export type Drip = { readonly start: number; readonly swell: number; readonly stretch: number; readonly fall: number; readonly end: number; readonly size: number };
export type DripPose = { readonly opacity: number; readonly sx: number; readonly sy: number; readonly drop: number; readonly phase: "wait" | "swell" | "stretch" | "fall" };

export function nextDrip(rng: Rng, after: number): Drip {
  const start = after + between(rng, 500, 5200);
  const swell = start + between(rng, 950, 2100);
  const stretch = swell + between(rng, 240, 460);
  const fall = stretch + between(rng, 380, 520);
  return { start, swell, stretch, fall, end: fall, size: between(rng, 0.78, 1.1) };
}

export function dripAt(d: Drip, t: number): DripPose {
  if (t < d.start || t >= d.end) return { opacity: 0, sx: 1, sy: 1, drop: 0, phase: "wait" };
  if (t < d.swell) {
    const p = (t - d.start) / (d.swell - d.start);
    const s = d.size * (0.18 + 0.82 * (1 - (1 - p) * (1 - p)));
    return { opacity: 1, sx: s, sy: s, drop: 0, phase: "swell" };
  }
  if (t < d.stretch) {
    const p = (t - d.swell) / (d.stretch - d.swell);
    return { opacity: 1, sx: d.size * (1 - 0.2 * p), sy: d.size * (1 + 0.75 * p), drop: 0.05 * p, phase: "stretch" };
  }
  const p = (t - d.stretch) / (d.fall - d.stretch);
  return { opacity: p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4, sx: d.size * (0.8 + 0.12 * p), sy: d.size * (1.75 - 0.75 * p), drop: 0.05 + 0.95 * p * p, phase: "fall" };
}

export type IdlePose = {
  readonly pack: { readonly turn: number; readonly scale: number; readonly lift: number };
  readonly sheen: readonly number[];
  readonly wax: { readonly scale: number; readonly turn: number };
  /** `lean` is the seal's turn toward the pack. There is deliberately no vertical offset. */
  readonly seal: { readonly sx: number; readonly sy: number; readonly turn: number };
  readonly jaw: number;
  readonly lids: Lids;
  readonly drips: readonly DripPose[];
};

/** The whole idle. Beats are drawn as they run out, so it can run forever without storing a schedule. `at` needs rising times. `lift: false` keeps the pack from drifting up and down at all. */
export function makeIdle(rng: Rng, opts: { sheenLayers: number; drips: number; lift?: boolean }) {
  let eye = nextEyeBeat(rng, 0);
  let twitch = nextTwitch(rng, 0);
  let tremble = nextTremble(rng, 0);
  let sweep = nextSweep(rng, 0);
  const drips = Array.from({ length: opts.drips }, () => nextDrip(rng, 0));
  return {
    at(t: number, nudge = 0): IdlePose {
      if (t >= eye.end) eye = nextEyeBeat(rng, Math.max(eye.end, t));
      if (t >= twitch.end) twitch = nextTwitch(rng, Math.max(twitch.end, t));
      if (t >= tremble.end) tremble = nextTremble(rng, Math.max(tremble.end, t));
      if (t >= sweep.end) sweep = nextSweep(rng, Math.max(sweep.end, t));
      for (let i = 0; i < drips.length; i++) if (t >= drips[i].end) drips[i] = nextDrip(rng, Math.max(drips[i].end, t));
      const breath = 0.72 * wave(t, 3700) + 0.28 * wave(t, 5300, 1.1);
      const jaw = jawAt(twitch, t);
      const lean = jaw / POSE_LIMITS.jaw;
      const sway = 0.68 * wave(t, 4300, 0.4) + 0.32 * wave(t, 2700, 2.1);
      return {
        pack: {
          turn: POSE_LIMITS.packTurn * sway,
          scale: 1 + POSE_LIMITS.packScale * (0.6 * wave(t, 3100, 1.7) + 0.4 * wave(t, 1900)),
          lift: opts.lift === false ? 0 : POSE_LIMITS.packLift * (0.55 * wave(t, 3900, 2.6) + 0.45 * wave(t, 6100)),
        },
        sheen: sheenAt(sweep, t, opts.sheenLayers),
        wax: waxAt(tremble, t),
        seal: {
          sx: 1 + (POSE_LIMITS.sealSquash / 2) * breath,
          sy: 1 + POSE_LIMITS.sealSquash * breath,
          turn: Math.max(-POSE_LIMITS.sealTurn, Math.min(POSE_LIMITS.sealTurn, 0.34 * wave(t, 6700, 0.9) - 0.42 * lean - 0.72 * clamp01(nudge))),
        },
        jaw,
        lids: lidsAt(eye, t),
        drips: drips.map((d) => dripAt(d, t)),
      };
    },
  };
}

/** Eases a value toward a target at a rate that doesn't depend on the frame rate. */
export const approach = (from: number, to: number, ms: number, tau = 140) => to + (from - to) * Math.exp(-Math.max(0, ms) / tau);

/**
 * The tap's life. Taps during a play change nothing, so a double tap can't stack two bites, and each run ends back at
 * idle ready for the next one. `arming` waits for the bite's layers to decode, so it can never start with one missing.
 */
export type SampleState = "idle" | "arming" | "playing" | "holding" | "returning";
export type SampleEvent = "tap" | "armed" | "failed" | "played" | "release" | "returned";

const SAMPLE: Readonly<Record<SampleState, Partial<Record<SampleEvent, SampleState>>>> = {
  idle: { tap: "arming" },
  arming: { armed: "playing", failed: "idle" },
  playing: { played: "holding" },
  holding: { release: "returning" },
  returning: { returned: "idle" },
};

export const sampleNext = (state: SampleState, event: SampleEvent): SampleState => SAMPLE[state][event] ?? state;

/** The idle only runs while nothing else is moving the layers. */
export const idleRuns = (state: SampleState, onScreen: boolean, tabVisible: boolean, reducedMotion: boolean) => (state === "idle" || state === "arming") && onScreen && tabVisible && !reducedMotion;
