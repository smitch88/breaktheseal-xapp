/** Where a card sits in the viewer. Only numbers, so each move can be checked on its own. */
export interface Camera {
  readonly rx: number;
  readonly ry: number;
  readonly zoom: number;
  readonly px: number;
  readonly py: number;
}
export type Face = "front" | "back";
export interface Size {
  readonly w: number;
  readonly h: number;
}

export const HOME: Camera = { rx: 0, ry: 0, zoom: 1, px: 0, py: 0 };
const MAX_ZOOM = 5;
const MAX_TILT = 30;
/** A photo with no back only ever tilts, so it can't turn to show nothing. */
const ONE_SIDED_TURN = 25;
/** Half a turn for a 360 px drag. */
const DEGREES_PER_PX = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const faceOf = (ry: number): Face => (Math.cos((ry * Math.PI) / 180) < 0 ? "back" : "front");

export function rotateBy(c: Camera, dx: number, dy: number, twoSided: boolean): Camera {
  const ry = c.ry + dx * DEGREES_PER_PX;
  return { ...c, ry: twoSided ? ry : clamp(ry, -ONE_SIDED_TURN, ONE_SIDED_TURN), rx: clamp(c.rx - dy * DEGREES_PER_PX, -MAX_TILT, MAX_TILT) };
}

/** Square on a side, by the shortest way round from wherever it is. */
export function toFace(c: Camera, side: Face): Camera {
  const offset = side === "back" ? 180 : 0;
  return { ...c, rx: 0, ry: Math.round((c.ry - offset) / 360) * 360 + offset };
}

const atZoom = (c: Camera, zoom: number): Camera => {
  const z = clamp(zoom, 1, MAX_ZOOM);
  // At 1 there's nothing left to pan. Zooming out pulls the view back in step, so the card never drifts off.
  if (z <= 1) return { ...c, zoom: 1, px: 0, py: 0 };
  const k = Math.min((z - 1) / Math.max(c.zoom - 1, 1e-6), 1);
  return { ...c, zoom: z, px: c.px * k, py: c.py * k };
};

export const wheelBy = (c: Camera, deltaY: number) => atZoom(c, c.zoom * Math.exp(-deltaY * 0.002));
export const pinchTo = (c: Camera, startZoom: number, startGap: number, gap: number) => atZoom(c, startZoom * (gap / Math.max(startGap, 1)));

export function panBy(c: Camera, dx: number, dy: number, size: Size): Camera {
  const x = ((c.zoom - 1) * size.w) / 2;
  const y = ((c.zoom - 1) * size.h) / 2;
  return { ...c, px: clamp(c.px + dx, -x, x), py: clamp(c.py + dy, -y, y) };
}

/** What a key does. Zoomed in, arrows move around the picture. Otherwise they turn it. */
export function nudge(c: Camera, key: string, twoSided: boolean, size: Size): Camera {
  const arrow: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const a = arrow[key];
  if (a) return c.zoom > 1 ? panBy(c, -a[0] * 40, -a[1] * 40, size) : rotateBy(c, a[0] * 40, a[1] * 40, twoSided);
  if (key === "+" || key === "=") return atZoom(c, c.zoom * 1.25);
  if (key === "-") return atZoom(c, c.zoom / 1.25);
  if (key === "0") return HOME;
  if ((key === "f" || key === "F") && twoSided) return toFace(c, faceOf(c.ry) === "front" ? "back" : "front");
  return c;
}
