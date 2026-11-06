import { Suspense } from "react";
import { SHELF_PRICES } from "@/config/nft-packs";
import { TryFlow, type TryOption } from "@/components/TryFlow";
import { getCatalog } from "@/lib/catalog/server";
import { packLabel } from "@/lib/format";
import { getMarket } from "@/lib/nft/server";
import { nftPack } from "@/lib/nft/view";
import { SEO, pageMeta } from "@/lib/seo";

export const revalidate = 300;
export const metadata = pageMeta(SEO.try);

export default async function TryPage() {
  const [catalog, market] = await Promise.all([getCatalog(), getMarket()]);
  const options: TryOption[] = [
    ...SHELF_PRICES.map((p) => {
      const pack = nftPack(p, market.collections);
      return { value: `n${p}`, label: packLabel(pack.name, p), name: pack.name, price: p, art: pack.art, pack: { kind: "nft" as const, price: p } };
    }),
    ...catalog.machines.filter((m) => m.stock).map((m) => ({ value: m.code, label: packLabel(m.name, m.price), name: m.name, price: m.price, art: "/assets/stage-pack.webp", pack: { kind: "card" as const, code: m.code } })),
  ];
  return (
    <Suspense fallback={<div className="stage" />}>
      <TryFlow options={options} />
    </Suspense>
  );
}
