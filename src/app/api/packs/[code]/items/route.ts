import { NextResponse } from "next/server";
import { MACHINE_CODE } from "@/lib/catalog/parse";
import { catalogSource, getCatalog } from "@/lib/catalog/server";

const CACHE = "public, s-maxage=120, stale-while-revalidate=600";

/** A pack's facts and real items for the stage. Only codes in the live catalog pass, and the CDN holds each answer. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!MACHINE_CODE.test(code)) return NextResponse.json({ error: "unknown pack" }, { status: 404 });
  const catalog = await getCatalog();
  const machine = catalog.machines.find((m) => m.code === code);
  if (!machine) return NextResponse.json({ error: "unknown pack" }, { status: 404 });
  const pool = await catalogSource.pool(code);
  const items = pool.items.length ? pool.items : machine.fan;
  return NextResponse.json(
    { code, name: machine.name, price: machine.price, rates: machine.rates, bb: machine.bb, stock: machine.stock, items, stale: pool.stale || catalog.stale },
    { headers: { "Cache-Control": CACHE } },
  );
}
