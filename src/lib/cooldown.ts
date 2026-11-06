/**
 * Backs off from an upstream that just failed. Failures are never cached, so without this each page regeneration would
 * retry at once, and against xrpl.to's keyless limit a repeated 429 is the thing its policy asks us not to do.
 */
export function createCooldown(windowMs: number, now: () => number = Date.now) {
  const until = new Map<string, number>();
  return {
    resting: (key: string) => (until.get(key) ?? 0) > now(),
    failed: (key: string) => void until.set(key, now() + windowMs),
    ok: (key: string) => void until.delete(key),
  };
}
