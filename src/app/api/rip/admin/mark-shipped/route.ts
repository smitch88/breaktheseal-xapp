import { sameOrigin } from "@/lib/auth/server";
import { isAdmin, json, off, rails, sessionAddress } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** The card is on its way. */
export async function POST(req: Request) {
  const r = rails();
  if (!r || !(await isAdmin())) return off();
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const body = (await req.json().catch(() => null)) as { id?: unknown; ref?: unknown } | null;
  if (typeof body?.id !== "string" || typeof body.ref !== "string" || !body.ref.trim()) return json({ error: "Which card, and what tracking number?" }, 400);
  const ok = await r.engine.markShipped(body.id, (await sessionAddress()) as string, body.ref.trim().slice(0, 120));
  return ok ? json({ ok: true }) : json({ error: "Try again." }, 409);
}
