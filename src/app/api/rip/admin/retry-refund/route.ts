import { sameOrigin } from "@/lib/auth/server";
import { isAdmin, json, off, rails, sessionAddress } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** Send a stuck refund again, once its cause is fixed. */
export async function POST(req: Request) {
  const r = rails();
  if (!r || !(await isAdmin())) return off();
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string") return json({ error: "Which refund?" }, 400);
  const ok = await r.engine.retryRefund(body.id, (await sessionAddress()) as string);
  return ok ? json({ ok: true }) : json({ error: "Try again." }, 409);
}
