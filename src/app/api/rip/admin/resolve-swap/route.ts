import { sameOrigin } from "@/lib/auth/server";
import { isAdmin, json, off, rails, sessionAddress } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** Settle a Relay swap that has stopped answering, after checking it at relay.link. */
export async function POST(req: Request) {
  const r = rails();
  if (!r || !(await isAdmin())) return off();
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const body = (await req.json().catch(() => null)) as { id?: unknown; action?: unknown; amount?: unknown } | null;
  if (typeof body?.id !== "string" || (body.action !== "landed" && body.action !== "released")) return json({ error: "Which swap, and landed or released?" }, 400);
  if (body.amount !== undefined && !(typeof body.amount === "string" && /^[1-9][0-9]{0,20}$/.test(body.amount))) return json({ error: "The amount is in drops or USDC micros." }, 400);
  const ok = await r.engine.resolveSwap(body.id, (await sessionAddress()) as string, body.action, body.amount as string | undefined);
  return ok ? json({ ok: true }) : json({ error: "That swap isn't waiting on a decision." }, 409);
}
