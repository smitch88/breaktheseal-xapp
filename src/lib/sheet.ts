/** Bottom-sheet gesture math. Progress runs from 0 (open) to 1 (collapsed). */
export type SheetSnap = "open" | "collapsed";

/** A press that moves less than this is a tap, in pixels. */
export const TAP_SLOP = 8;
/** A release faster than this settles the way it was moving, in pixels per millisecond. */
export const FLICK = 0.45;

export const snapProgress = (snap: SheetSnap) => (snap === "open" ? 0 : 1);

/** Where a drag has taken the sheet. Moving down collapses it, and it never leaves its track. */
export function dragProgress(start: number, dy: number, range: number): number {
  const p = range > 0 ? start + dy / range : start;
  return Math.min(1, Math.max(0, p));
}

/** Where the sheet rests after a release: a flick wins, otherwise the nearer end. */
export function settle(progress: number, velocity: number): SheetSnap {
  if (velocity >= FLICK) return "collapsed";
  if (velocity <= -FLICK) return "open";
  return progress >= 0.5 ? "collapsed" : "open";
}
