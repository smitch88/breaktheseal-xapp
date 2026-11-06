import { NFT_LADDERS, SHELF_PRICES } from "@/config/nft-packs";
import { PackRates } from "@/components/live/PoolFacts";
import { StaleNote } from "@/components/ui";
import { getCatalog } from "@/lib/catalog/server";
import { SEO, pageMeta } from "@/lib/seo";

export const revalidate = 300;
export const metadata = pageMeta(SEO.rates);

export default async function RatesPage() {
  const catalog = await getCatalog();
  const groups = new Map<string, number>();
  for (const m of catalog.machines) {
    const k = m.rates.join("/");
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          Rarity rates<em>.</em>
        </h1>
      </div>
      {catalog.stale ? <StaleNote asOf={catalog.asOf} /> : null}
      <dl className="dl wide">
        {[...groups.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => {
            const r = k.split("/");
            return (
              <div key={k} className="cardrate">
                <dt>
                  {n} card {n === 1 ? "pack" : "packs"}
                </dt>
                <dd>
                  Common {r[0]}% · Uncommon {r[1]}% · Rare {r[2]}% · Epic {r[3]}%
                </dd>
              </div>
            );
          })}
        {SHELF_PRICES.map((p) => (
          <div key={p}>
            <dt>{NFT_LADDERS[p].name}</dt>
            <dd>
              <PackRates price={p} />
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
