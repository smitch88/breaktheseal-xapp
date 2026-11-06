import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { MACHINE_CODE } from "@/lib/catalog/parse";
import { getCatalog } from "@/lib/catalog/server";
import { ogImage } from "@/lib/seo";

export const dynamic = "force-dynamic";

const OG_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

const bytes = async (url: URL) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.pathname} ${r.status}`);
  return r.arrayBuffer();
};

/**
 * A card machine's link preview: our foil pack (baked in the plate) with the machine's live name set on it. The name is read when
 * this is drawn, so a name carrying a price is never older than the catalog. Stock, odds and restocking never go on it, and
 * a crawler asks once a day at most, from the cache. If anything can't be read, the plain card-pack image stands in.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const fallback = () => NextResponse.redirect(new URL(ogImage("machine"), req.url), 302);
  if (!MACHINE_CODE.test(code)) return fallback();
  try {
    const machine = (await getCatalog()).machines.find((m) => m.code === code);
    if (!machine) return fallback();
    const [plate, font] = await Promise.all([bytes(new URL("/assets/og/machine-plate.png", req.url)), bytes(new URL("/assets/og/anton-latin.ttf", req.url))]);
    const name = machine.name.toUpperCase();
    const size = name.length <= 14 ? 76 : name.length <= 24 ? 62 : 48;
    return new ImageResponse(
      <div style={{ width: 1200, height: 630, display: "flex", position: "relative", fontFamily: "Anton" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/png;base64,${Buffer.from(plate).toString("base64")}`} width={1200} height={630} alt="" style={{ position: "absolute", left: 0, top: 0 }} />
        <div style={{ position: "absolute", left: 46, top: 268, width: 500, height: 230, display: "flex", alignItems: "flex-start", color: "#f7f7f2", fontSize: size, lineHeight: 1.22 }}>{name}</div>
      </div>,
      { width: 1200, height: 630, fonts: [{ name: "Anton", data: font, weight: 400, style: "normal" }], headers: { "Cache-Control": OG_CACHE } },
    );
  } catch {
    return fallback();
  }
}
