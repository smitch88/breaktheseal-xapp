import { sameOrigin } from "@/lib/auth/server";
import { isAdmin, json, off, rails, sessionAddress } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** Settle a card held for review, after checking the provider by memo. */
export async function POST(req: Request) {
  const r = rails();
  if (!r || !(await isAdmin())) return off();
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const body = (await req.json().catch(() => null)) as { id?: unknown; action?: unknown } | null;
  if (typeof body?.id !== "string" || (body.action !== "resume" && body.action !== "refund" && body.action !== "restash")) return json({ error: "Which card, and resume, refund or restash?" }, 400);
  const ok = await r.engine.resolveCard(body.id, (await sessionAddress()) as string, body.action);
  return ok ? json({ ok: true }) : json({ error: "That card isn't waiting on a decision." }, 409);
}
