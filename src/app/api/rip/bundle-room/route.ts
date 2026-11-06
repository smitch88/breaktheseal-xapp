import { machineOnSale } from "@/config/machines";
import { allowed, clientIp } from "@/lib/auth/server";
import { json, off, rails } from "@/lib/rip/server";

export const dynamic = "force-dynamic";

/** The most of one card pack an order can take, from what custody's USDC can pay for. It costs reads elsewhere, so each pack's answer is kept a little while. */
export async function GET(req: Request) {
  const r = rails();
  if (!r?.engine.multi || !r.cardsOn) return off();
  if (!allowed(`room:${clientIp(req)}`, 30, 60_000)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const code = new URL(req.url).searchParams.get("code") ?? "";
  if (!/^[a-z0-9_-]{1,60}$/i.test(code) || !machineOnSale(process.env.SEAL_MACHINE_CODES, r.mode === "mainnet", code)) return json({ max: 0 });
  const room = await r.engine.cardRoom(code).catch(() => ({ max: 0 }));
  return json({ max: room.max });
}
