import "server-only";
import { unstable_cache } from "next/cache";
import type { CachedGet } from "./catalog/source.ts";
import { createCooldown } from "./cooldown.ts";

const UA = "seal-rips/0.1";
const TIMEOUT_MS = 8000;

/**
 * Shared server cache for upstream reads, across every function instance. A copy past its window is still served at once
 * while one background refresh runs. Failures throw and are never stored, including the HTTP 200 `success: false`
 * bodies xrpl.to sends when it rate-limits, so a bad answer can't stick for the whole window and the last good copy stays.
 */
const cooldown = createCooldown(5 * 60_000);

async function load(url: string): Promise<unknown> {
  const host = new URL(url).host;
  // A build runs many workers at once, which would spend xrpl.to's keyless budget and trip its limit. Pages start from
  // the snapshot and read live floors on their first regeneration.
  if (host === "api.xrpl.to" && process.env.NEXT_PHASE === "phase-production-build") throw new Error("skipped during build");
  if (cooldown.resting(host)) throw new Error("upstream cooling down");
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body: unknown = await res.json();
    if ((body as { success?: unknown } | null)?.success === false) throw new Error("upstream refused");
    cooldown.ok(host);
    return body;
  } catch (e) {
    cooldown.failed(host);
    throw e;
  }
}

const byTtl = new Map<number, (url: string) => Promise<unknown>>();
const cachedFor = (ttl: number) => {
  let fn = byTtl.get(ttl);
  if (!fn) {
    fn = unstable_cache(load, ["seal-rips-upstream", String(ttl)], { revalidate: ttl });
    byTtl.set(ttl, fn);
  }
  return fn;
};

export const cachedGet: CachedGet = async (url, ttl) => {
  const body = await cachedFor(ttl)(url);
  return { ok: true, status: 200, json: async () => body };
};
