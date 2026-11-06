/**
 * The pack-opening screen's background while it waits for a bite, as math. The seal and the pack run the home hero's idle
 * (hero-idle.ts); this is only what the pointer adds on top. Nothing here touches the page.
 */
export type Vec = { readonly x: number; readonly y: number };

export const STAGE_MOTION = {
  /** One turn of the rays, the same pace as the rays behind the reveal. */
  raysTurnMs: 120000,
  /** How far the pointer leans the rays' angle, in degrees, and how far each depth shifts, as a share of the zone's short side. */
  raysLean: 4,
  rays: 0.022,
  pack: 0.006,
  seal: 0.012,
} as const;

const clamp1 = (v: number) => Math.min(1, Math.max(-1, v));

/** The pointer in the zone: -1 to 1 on each axis, 0 at the center, and it stays at the edge once it's past it. */
export function pointerIn(x: number, y: number, zone: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): Vec {
  if (!(zone.width > 0) || !(zone.height > 0)) return { x: 0, y: 0 };
  return { x: clamp1(((x - zone.left) / zone.width) * 2 - 1), y: clamp1(((y - zone.top) / zone.height) * 2 - 1) };
}

/** The rays' angle: a slow steady turn, leaned a little by the pointer. */
export const raysAngle = (t: number, lean: number) => (t / STAGE_MOTION.raysTurnMs) * 360 + STAGE_MOTION.raysLean * clamp1(lean);

/** Pixels for each depth. The rays follow the pointer like a light; the pack, then the nearer seal, shift the other way. */
export function depthShift(p: Vec, short: number) {
  const at = (k: number): Vec => ({ x: k * short * clamp1(p.x), y: k * short * clamp1(p.y) });
  return { rays: at(STAGE_MOTION.rays), pack: at(-STAGE_MOTION.pack), seal: at(-STAGE_MOTION.seal) };
}

/** Where the seal looks: the way to the pointer inside the unit circle. It reaches the rim at `reach` pixels from the head. */
export function gazeToward(pointer: Vec, head: Vec, reach: number): Vec {
  if (!(reach > 0)) return { x: 0, y: 0 };
  const x = (pointer.x - head.x) / reach;
  const y = (pointer.y - head.y) / reach;
  const len = Math.hypot(x, y);
  return len > 1 ? { x: x / len, y: y / len } : { x, y };
}

/** A gaze as an eye highlight's offset, in percent of its own box. `limit` is in sprite pixels: see GAZE in hero-art.ts. */
export const glintShift = (gaze: Vec, limit: Vec, boxPx: Vec): Vec => ({ x: (gaze.x * limit.x * 100) / boxPx.x, y: (gaze.y * limit.y * 100) / boxPx.y });
