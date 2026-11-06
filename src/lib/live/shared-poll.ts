/** What a shared poll needs from the page. A test passes its own clock. */
export interface PollDeps {
  now(): number;
  after(ms: number, fn: () => void): () => void;
  visible(): boolean;
}

const pageDeps: PollDeps = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
};

/**
 * One read for a whole page, however many things on it want the answer. It runs at the shortest interval anyone asked for and
 * only while someone is listening and the tab is on screen. A newcomer gets the last answer at once. A failed read keeps it.
 */
export function sharedPoll<T>(read: () => Promise<T | null>, deps: PollDeps = pageDeps) {
  const listeners = new Map<(value: T) => void, number>();
  let value: T | null = null;
  let lastLook = Number.NEGATIVE_INFINITY;
  let reading = false;
  let cancel: (() => void) | null = null;

  const plan = () => {
    cancel?.();
    cancel = null;
    if (!listeners.size || reading || !deps.visible()) return;
    cancel = deps.after(Math.max(0, lastLook + Math.min(...listeners.values()) - deps.now()), () => void look());
  };

  const look = async () => {
    cancel = null;
    if (!deps.visible()) return;
    reading = true;
    try {
      const next = await read();
      if (next !== null) {
        value = next;
        for (const listen of listeners.keys()) listen(next);
      }
    } catch {
      /* A failed look is just a look that comes around again. */
    }
    reading = false;
    lastLook = deps.now();
    plan();
  };

  return {
    subscribe(listen: (value: T) => void, ms: number): () => void {
      listeners.set(listen, ms);
      if (value !== null) listen(value);
      plan();
      return () => {
        listeners.delete(listen);
        plan();
      };
    },
    /** The tab came back: read now if an answer is due. */
    wake: plan,
  };
}
