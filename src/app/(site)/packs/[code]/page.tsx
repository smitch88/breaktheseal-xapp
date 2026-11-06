import { XappText } from "@/components/XappHost";
import { SELL_FEE_PERCENT } from "@/lib/sellback";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PackBuy } from "@/components/PackBuy";
import { PackItems } from "@/components/PackItems";
import { SimCarousel } from "@/components/SimCarousel";
import { Fan, PackPanels, RatesGrid, SecHead, StaleNote } from "@/components/ui";
import { totalLine } from "@/lib/catalog/browse";
import { MACHINE_CODE } from "@/lib/catalog/parse";
import { catalogSource, getCatalog } from "@/lib/catalog/server";
import { noOrphan, usd, usd2, xrpOf } from "@/lib/format";
import { getMarket } from "@/lib/nft/server";
import { SEO, machineSeo, pageMeta } from "@/lib/seo";
import { cardRailsSet } from "@/lib/site";

/** Pages render on first visit and are served from the shared cache after that, so a pack page never hits the source per view. */
export const revalidate = 120;
export const dynamicParams = true;
export const generateStaticParams = () => [];

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const catalog = await getCatalog();
  const found = catalog.machines.find((m) => m.code === code);
  return found ? pageMeta(machineSeo(found.code, found.name, cardRailsSet(process.env))) : pageMeta(SEO.notFound);
}

export default async function PackPage({ params }: Props) {
  const { code } = await params;
  if (!MACHINE_CODE.test(code)) notFound();
  const [catalog, market] = await Promise.all([getCatalog(), getMarket()]);
  const found = catalog.machines.find((m) => m.code === code);
  if (!found) notFound();
  // The first page of the real list. If the source can't say, nothing stands in for it: the page asks again from the browser.
  const [[m], first] = await Promise.all([catalogSource.withFans([found]), catalogSource.page(code, null, null).catch(() => null)]);
  const similar = await catalogSource.withFans(
    catalog.machines
      .filter((x) => x.cat === m.cat && x.code !== m.code && x.stock)
      .sort((a, b) => Math.abs(a.price - m.price) - Math.abs(b.price - m.price))
      .slice(0, 8),
  );
  const rates = [
    { tier: "Epic" as const, rate: m.rates[3] },
    { tier: "Rare" as const, rate: m.rates[2] },
    { tier: "Uncommon" as const, rate: m.rates[1] },
    { tier: "Common" as const, rate: m.rates[0] },
  ];
  const cards = cardRailsSet(process.env);
  return (
    <main className="pg packp">
      <div className="crumb">
        <Link href="/packs">packs</Link> / {m.name}
      </div>
      {catalog.stale ? <StaleNote asOf={catalog.asOf} /> : null}
      <div className="split">
        <div className="pstage">
          <Fan machine={m} big />
        </div>
        <div className="pcopy">
          <h1>
            {noOrphan(m.name)}
            <em>.</em>
          </h1>
          <div className="price">{usd2(m.price)}</div>
          <span className="lb">per pack · about {xrpOf(m.price, market.xrpUsd)} XRP</span>
          <dl className="dl">
            <div>
              <dt>In the pack</dt>
              <dd>1 collectible</dd>
            </div>
            {cards ? (
              <div>
                <dt><XappText web="Instant sell-back" app="Sell-back price" /></dt>
                <dd>{m.bb}% of listed value</dd>
              </div>
            ) : null}
            {cards ? (
              <div>
                <dt>Sell fee</dt>
                <dd>{SELL_FEE_PERCENT}%</dd>
              </div>
            ) : null}
            <div>
              <dt>In stock</dt>
              <dd>{m.stock.toLocaleString("en-US")}</dd>
            </div>
          </dl>
          <PackBuy href={`/checkout?pack=${encodeURIComponent(m.code)}`} tryHref={`/try?pack=${encodeURIComponent(m.code)}`} price={m.price} soldOut={m.stock === 0} cardCode={m.code} eachXrp={Math.ceil((m.price / market.xrpUsd) * 1.005 * 100) / 100} />
        </div>
      </div>
      <PackPanels
        rates={
          <>
            <SecHead title="Rarity rates" />
            <RatesGrid rows={rates} />
          </>
        }
        similar={
          similar.length ? (
            <SimCarousel label="Similar packs">
              {similar.map((s) => (
                <Link className="simc" key={s.code} href={`/packs/${s.code}`} prefetch={false}>
                  <Fan machine={s} />
                  <h3>{noOrphan(s.name)}</h3>
                  <strong>{usd(s.price)}</strong>
                  <span className="lb">
                    {cards ? `${s.bb}% sell-back · ` : ""}{s.stock.toLocaleString("en-US")} in stock
                  </span>
                </Link>
              ))}
            </SimCarousel>
          ) : undefined
        }
      />
      <section className="s">
        <SecHead title="In this pack" right={totalLine(m.stock)} />
        <PackItems code={m.code} first={first} stock={m.stock} bands={m.bands} rates={m.rates} />
        <p className="fine">{noOrphan("This list comes straight from the graded card vault that holds these cards, highest value first, read within the last few minutes. Each item is one possible pull, and it leaves the list once someone pulls it.")}</p>
      </section>
    </main>
  );
}
