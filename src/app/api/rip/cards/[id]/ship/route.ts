import { createHash, randomBytes } from "node:crypto";
import { guard, json, walletRequest } from "@/lib/rip/server";
import { shipInstruction } from "@/lib/rip/ship";
import { publicCard } from "@/lib/rip/views";

export const dynamic = "force-dynamic";

/**
 * Ship, in two steps. With the address: it goes to private storage, and the answer is what the wallet has to sign, which names
 * this card and the address's hash. With `confirm` and that hash: the signature is read off the ledger, and only then does the
 * card start to move. A session alone can't send a card anywhere: a sign-in can be relayed from another site, and a stolen
 * session could otherwise name its own address. The address stays off the public log, and the mirror is retired first.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req);
  if (g instanceof Response) return g;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { confirm?: unknown; name?: unknown; street?: unknown; city?: unknown; region?: unknown; zip?: unknown; country?: unknown } | null;
  const { engine } = g.rails;
  if (typeof body?.confirm === "string") {
    const unsigned = () => json({ error: "Your wallet's approval isn't on the ledger yet. Once you've approved it, this takes a few seconds.", code: "ship_unsigned" }, 409);
    const auth = await engine.cardAuthority(g.address, id);
    if (!auth.ok) return json({ error: auth.message, code: auth.code }, 409);
    const asked = /^[0-9a-f]{64}$/.test(body.confirm) ? await g.rails.secrets.get(`shipauth:${id}:${body.confirm}`).catch(() => null) : null;
    if (!asked) return unsigned();
    const { by, fromLedger } = JSON.parse(asked) as { by: string; fromLedger: number };
    // Whoever asked has to be who signs. A mirror that changed hands since then starts over with its new holder.
    if (by !== g.address) return unsigned();
    const done = await engine.shipCard(g.address, id, body.confirm, fromLedger);
    if (!done.ok) return json({ error: done.message, code: done.code }, 409);
    await engine.advance({ minGapMs: 500 }).catch(() => {});
    return json({ order: publicCard(engine.state.cards.get(id)!) });
  }
  const fields = [body?.name, body?.street, body?.city, body?.zip];
  if (!fields.every((f) => typeof f === "string" && f.trim().length > 0 && f.length < 200)) return json({ error: "Fill in the whole address." }, 400);
  if (![body?.region, body?.country].every((f) => f === undefined || (typeof f === "string" && f.length < 200))) return json({ error: "Fill in the whole address." }, 400);
  // The salt keeps the public hash from confirming a guessed address.
  const place = { name: String(body?.name), street: String(body?.street), city: String(body?.city), region: String(body?.region ?? "").slice(0, 200), zip: String(body?.zip), country: String(body?.country ?? "US").slice(0, 200) };
  const address = JSON.stringify({ salt: randomBytes(16).toString("hex"), ...place });
  // Authorize before storing anything, and key the address by its hash, so a stranger can't overwrite a real one.
  const auth = await engine.cardAuthority(g.address, id);
  if (!auth.ok) return json({ error: auth.message, code: auth.code }, 409);
  const hash = createHash("sha256").update(address).digest("hex");
  const made = await engine.shipAuthorization(g.address, id, hash);
  if (!made.ok) return json({ error: made.message, code: made.code }, 409);
  await g.rails.secrets.put(`ship:${id}:${hash}`, address);
  await g.rails.secrets.put(`shipauth:${id}:${hash}`, JSON.stringify({ by: g.address, fromLedger: made.fromLedger }));
  const wallet = await walletRequest(req, g, made.tx, shipInstruction(place), `ship-${id}`, `/collection/card_${id}`);
  return json({ order: publicCard(auth.card), tx: made.tx, wallet, hash });
}
