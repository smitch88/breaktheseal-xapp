import { sameOrigin } from "@/lib/auth/server";
import { isAdmin, json, off, rails, sessionAddress } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** The buyer's kill switch. Off takes effect on the next sweep, from anywhere the owner can sign in, with no deploy. */
export async function POST(req: Request) {
  const r = rails();
  if (!r || !(await isAdmin())) return off();
  if (!sameOrigin(req)) return json({ error: "bad origin" }, 403);
  const body = (await req.json().catch(() => null)) as { on?: unknown; why?: unknown } | null;
  if (typeof body?.on !== "boolean") return json({ error: "On or off?" }, 400);
  const ok = await r.engine.setAutobuy(body.on, (await sessionAddress()) as string, typeof body.why === "string" ? body.why.slice(0, 200) : null);
  return ok ? json({ ok: true, off: r.engine.state.autobuyOff }) : json({ error: "Try again." }, 409);
}
