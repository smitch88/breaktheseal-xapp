/**
 * The way through a multi order, one pack at a time, away from any page: each pack gets its bite, then its reveal, then the next one,
 * and Skip goes straight to the results. It only moves a pointer over prizes the server already fixed, so leaving at any point loses
 * nothing. Where it stands is kept per device; losing that only means landing on the results sooner, or seeing a pull again.
 */
export type FlowStep = { readonly view: "bite" | "reveal"; readonly at: number } | { readonly view: "summary" };

export const SUMMARY: FlowStep = { view: "summary" };

/**
 * Where to pick up, from what was saved. The first pack's bite plays on the open page, so a fresh start is its reveal. A saved place past
 * the packs there are is the results: a pack that came back as XRP leaves the run shorter than it began.
 */
export function resumeStep(saved: FlowStep | null, total: number): FlowStep {
  if (total <= 0 || saved?.view === "summary") return SUMMARY;
  if (!saved || !Number.isInteger(saved.at) || saved.at < 0) return { view: "reveal", at: 0 };
  return saved.at >= total ? SUMMARY : saved;
}

/** One tap on. A bite ends on its pack's reveal, a reveal goes to the next pack's bite, and the last reveal goes to the results. */
export function nextStep(step: FlowStep, total: number): FlowStep {
  if (step.view === "summary") return SUMMARY;
  if (step.view === "bite") return step.at < total ? { view: "reveal", at: step.at } : SUMMARY;
  return step.at + 1 < total ? { view: "bite", at: step.at + 1 } : SUMMARY;
}

/** Skip shows every result at once, from anywhere. */
export const skipStep = (): FlowStep => SUMMARY;

/** The main button under a reveal. */
export function nextLabel(step: FlowStep, total: number): string {
  if (step.view !== "reveal" || step.at + 1 >= total) return "See results";
  return `Next pack (${step.at + 2} of ${total})`;
}

/** The pack on the stage, for the stage's hint line. */
export const packCount = (at: number, total: number) => `PACK ${at + 1} OF ${total}`;

/** As kept on a device. */
export const encodeStep = (step: FlowStep): string => (step.view === "summary" ? "summary" : `${step.view}:${step.at}`);

export function parseStep(raw: string | null | undefined): FlowStep | null {
  if (raw === "summary") return SUMMARY;
  const m = raw ? /^(bite|reveal):(0|[1-9]\d{0,2})$/.exec(raw) : null;
  return m ? { view: m[1] as "bite" | "reveal", at: Number(m[2]) } : null;
}

/**
 * The count the earlier quick run kept: how many it had shown, 1000 once everything had. A visit from before this flow picks up on the
 * last one it showed.
 */
export function fromSeen(seen: number): FlowStep | null {
  if (!Number.isInteger(seen) || seen <= 0) return null;
  return seen >= 1000 ? SUMMARY : { view: "reveal", at: seen - 1 };
}

const flowKey = (id: string) => `seal-rips-flow-${id}`;
const seenKey = (id: string) => `seal-rips-opened-${id}`;

/** What this device saved for an order, the newer key first. Storage can be missing or throw: then there's nothing saved. */
export function readStep(id: string): FlowStep | null {
  try {
    return parseStep(window.localStorage.getItem(flowKey(id))) ?? fromSeen(Number(window.localStorage.getItem(seenKey(id))));
  } catch {
    return null;
  }
}

export function writeStep(id: string, step: FlowStep): void {
  try {
    window.localStorage.setItem(flowKey(id), encodeStep(step));
  } catch {
    /* Private window or full storage: this visit still works. */
  }
}
