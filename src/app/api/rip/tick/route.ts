import { timingSafeEqual } from "node:crypto";
import type { SealFloatStatus } from "@/lib/rip/engine";
import { followUpSoon, notify } from "@/lib/rip/alerts";
import { json, off, rails } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

let lastAlert = "";

/** The owner refills by hand and watches nothing, so this is how they hear about it: one line a state, to a webhook if one is set. */
async function alert(float: SealFloatStatus | null, ops: readonly { code: string; text: string }[]) {
  const seal = float && (float.low || float.pauses.length) ? `${float.low}:${float.pauses.join(",")}` : "";
  const state = [seal, ...ops.map((o) => o.code)].filter(Boolean).join("|");
  if (state === lastAlert) return;
  lastAlert = state;
  if (!state) return;
  const lines = ops.map((o) => `Break the Seal: ${o.text}`);
  if (seal && float) lines.unshift(`Break the Seal: SEAL float is low. ${float.freeXrp === null ? "No live price." : `${Math.round(float.freeXrp)} XRP free, alert under ${float.lowXrp}.`} ${float.pauses.length ? `Paused: ${float.pauses.map((p) => `$${p}`).join(", ")}.` : "Packs still open."} Refill ${float.refillXrp} XRP at a time with deploy/09-seal-float.mjs.`);
  const text = lines.join("\n");
  console.warn(text);
  const hook = process.env.SEAL_ALERT_WEBHOOK;
  if (hook) await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }), signal: AbortSignal.timeout(5000) }).catch(() => {});
}

const matches = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The sweep: finishes anything stuck when no one is looking. Called by a cron with CRON_SECRET. */
export async function GET(req: Request) {
  const r = rails();
  if (!r) return off();
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !matches(given, secret)) return json({ error: "Not allowed." }, 401);
  // A sweep that can't run is the one thing nobody would otherwise hear about.
  const failed = await r.engine.sweep().then(async ({ notices }) => {
    await notify(notices);
    return null;
  }, (e: unknown) => ({ code: "sweep_failed", text: `The sweep failed: ${e instanceof Error ? e.message : "unknown error"}.` }));
  const float = await r.engine.sealFloatStatus().catch(() => null);
  const ops = await r.engine.opsAlerts().catch(() => [{ code: "ops_unreadable", text: "The ledger server isn't answering." }]);
  await alert(float, failed ? [failed, ...ops] : ops);
  // A buy that went out on this sweep, or an NFT sent back, lands in a ledger or two: see it into its pool now rather than next minute.
  followUpSoon(r);
  return json({ head: r.engine.state.head, sealFloatLow: float?.low ?? false, packsPaused: float?.pauses ?? [], alerts: [...(failed ? [failed.code] : []), ...ops.map((o) => o.code)] });
}
