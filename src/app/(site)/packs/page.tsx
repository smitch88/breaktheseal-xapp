import { Suspense } from "react";
import { SHELF_PRICES } from "@/config/nft-packs";
import { PacksBrowser } from "@/components/PacksBrowser";
import { SecHead, StaleNote } from "@/components/ui";
import { catalogSource, getCatalog } from "@/lib/catalog/server";
import { xrpOf } from "@/lib/format";
import { getMarket } from "@/lib/nft/server";
import { nftPack } from "@/lib/nft/view";
import { SEO, pageMeta } from "@/lib/seo";

export const revalidate = 60;
export const metadata = pageMeta(SEO.packs);

/** Inside Xaman the pack cards say what you get, and the footer under every page says who runs this and the risk. */
export default async function Packs() {
  const [catalog, market] = await Promise.all([getCatalog(), getMarket()]);
  const machines = await catalogSource.withFans(catalog.machines);
  const nft = SHELF_PRICES.map((p) => {
    const { price, name, shortName, art } = nftPack(p, market.collections);
    return { price, name, shortName, art, xrp: xrpOf(p, market.xrpUsd) };
  });
  return (
    <main className="pg">
      <section className="s packs-top">
        <SecHead title="Packs" />
        {catalog.stale ? <StaleNote asOf={catalog.asOf} /> : null}
        <Suspense>
          <PacksBrowser machines={machines} nft={nft} />
        </Suspense>
      </section>
    </main>
  );
}
