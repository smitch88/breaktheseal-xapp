import { guard, json } from "@/lib/rip/server";
import { readRequest } from "@/lib/rip/xaman";
import { readRequestState, requestFailure } from "@/lib/wallet/xaman-socket";

export const dynamic = "force-dynamic";

/**
 * Where one Xaman request stands, for a phone coming back from Xaman with its status socket gone. It says what to show, and moves
 * nothing: an order is paid when the ledger says so. A request for some other account reads as not found.
 */
export async function POST(req: Request) {
  const g = await guard(req, { launch: true, purpose: "read" });
  if (g instanceof Response) return g;
  const apiKey = process.env.XAMAN_API_KEY;
  const apiSecret = process.env.XAMAN_API_SECRET;
  const body = (await req.json().catch(() => null)) as { uuid?: unknown } | null;
  const uuid = body?.uuid;
  if (!apiKey || !apiSecret || typeof uuid !== "string" || !/^[0-9a-f-]{8,64}$/i.test(uuid)) return json({ error: "Not found." }, 404);
  const read = (await readRequest({ apiKey, apiSecret, uuid }).catch(() => null)) as { payload?: { request_json?: { Account?: unknown } } } | null;
  if (!read) return json({ state: "pending" });
  if (read.payload?.request_json?.Account !== g.address) return json({ error: "Not found." }, 404);
  const failure = requestFailure(read as never);
  return json({ state: readRequestState(read as never), ...(failure ? { failure } : {}) });
}
