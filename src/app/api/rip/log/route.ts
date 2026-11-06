import { allowed, clientIp } from "@/lib/auth/server";
import { json, off, rails } from "@/lib/rip/server";
import { publicEvents } from "@/lib/rip/verify";

export const dynamic = "force-dynamic";

/** The public record: every commitment, pool change, payment and pull, enough to replay all of it. */
export async function GET(req: Request) {
  const r = rails();
  if (!r) return off();
  // The whole log, with no sign-in. Fine to read, not fine to hammer: every read is paid for.
  if (!allowed(`log:${clientIp(req)}`, 20, 60_000)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  const events = await r.store.readFrom(Number.isInteger(after) && after >= 0 ? after : 0);
  return json({ network: r.mode, treasury: r.treasury, vault: r.vault, events: publicEvents(events) });
}
