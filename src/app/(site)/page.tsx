import Link from "next/link";
import { FEATURED_CODES, SHOWCASE_CODES } from "@/config/machines";
import { SHELF_PRICES } from "@/config/nft-packs";
import { NftCard, ItemCard, PackCard, SecHead, StaleNote } from "@/components/ui";
import { CategoryChips } from "@/components/CategoryChips";
import { HeroStage } from "@/components/HeroStage";
import { PullTicker } from "@/components/live/PullTicker";
import { catalogSource, getCatalog } from "@/lib/catalog/server";
import type { Item, Machine } from "@/lib/catalog/types";
import { noOrphan, xrpOf } from "@/lib/format";
import { howCopy } from "@/lib/legal/how";
import { heroSamples } from "@/lib/hero-samples";
import { getMarket } from "@/lib/nft/server";
import { nftPack } from "@/lib/nft/view";
import { railsConfig } from "@/lib/rip/mode";
import { firstPulls } from "@/lib/rip/server";
import { sealTokenSpec } from "@/lib/rip/tokens";
import { SEO, pageMeta } from "@/lib/seo";
import { OFFICIAL_DOMAIN, SEAL_SITE, SITE_NAME, cardRailsSet } from "@/lib/site";

export const revalidate = 60;
export const metadata = pageMeta(SEO.home());

const pick = (machines: readonly Machine[], codes: readonly string[]) => codes.map((c) => machines.find((m) => m.code === c)).filter((m): m is Machine => !!m);

export default async function Discover() {
  const [catalog, market, pulls] = await Promise.all([getCatalog(), getMarket(), firstPulls()]);
  const feat = await catalogSource.withFans(pick(catalog.machines, FEATURED_CODES));
  const showcaseSource = await catalogSource.withFans(pick(catalog.machines, SHOWCASE_CODES));
  const showcase = showcaseSource.map((m) => m.fan.find((c) => c.rarity === "epic")).filter((c): c is Item => !!c);
  const cats = [...new Set(catalog.machines.map((m) => m.cat))];
  const mode = railsConfig(process.env).mode;
  // Rails on, an NFT in the hero has to be one a pull could really land on: HeroStage reads those from the live pools.
  const samples = heroSamples({ cards: [...showcase, ...feat.flatMap((m) => m.fan)], collections: mode === "demo" ? market.collections : {} });
  return (
    <main className="pg">
      {/* What Google shows as the site's name in results. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME, url: `https://${OFFICIAL_DOMAIN}/` }) }} />
      <section className="hero">
        <div className="hc">
          <h1>
            Break
            <br />
            the <em>seal.</em>
          </h1>
          <p>{noOrphan(howCopy(mode, cardRailsSet(process.env), !!sealTokenSpec(process.env)).hero)}</p>
          <div className="acts">
            <Link className="btn" href="/packs">
              Explore packs <span aria-hidden="true">→</span>
            </Link>
            <Link className="btn ol" href="/try">
              Try the bite
            </Link>
          </div>
          <a className="hpow" href={SEAL_SITE.url} target="_blank" rel="noopener noreferrer">
            Powered by <b>{SEAL_SITE.name}</b> <span aria-hidden="true">↗</span>
          </a>
        </div>
        <HeroStage samples={samples} />
      </section>

      {mode === "demo" ? null : <PullTicker first={pulls} testnet={mode === "testnet"} />}

      <section className="s">
        <SecHead title="XRPL NFT packs" right={mode === "demo" ? "Real XRPL collections, shown as demo pulls" : sealTokenSpec(process.env) ? "XRP, SEAL and real XRPL NFTs" : "XRP and real XRPL NFTs"} />
        <div className="pgrid">
          {SHELF_PRICES.map((p) => (
            <NftCard key={p} pack={nftPack(p, market.collections)} xrp={xrpOf(p, market.xrpUsd)} />
          ))}
        </div>
      </section>

      <section className="s" id="packs-grid">
        <SecHead title="Packs" />
        {catalog.stale ? <StaleNote asOf={catalog.asOf} /> : null}
        <CategoryChips cats={cats} />
        <div className="pgrid">
          {feat.map((m) => (
            <PackCard key={m.code} m={m} />
          ))}
        </div>
        <div className="more">
          <Link className="btn ol" href="/packs">
            See all {catalog.machines.length} packs <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      {showcase.length ? (
        <section className="s">
          <SecHead title="In the packs" />
          <div className="igrid">
            {showcase.map((c) => (
              <ItemCard key={c.id} item={c} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
