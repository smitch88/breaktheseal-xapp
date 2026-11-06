import { NFT_SELL_PERCENT, SELL_FEE_PERCENT } from "@/lib/sellback";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SHELF_PRICES, isOffered, type NftPrice } from "@/config/nft-packs";
import { LivePoolSections } from "@/components/live/LivePool";
import { NftRateCopy } from "@/components/live/NftRateCopy";
import { LiveInPack, NftRates, PoolFacts } from "@/components/live/PoolFacts";
import { RestockStamp } from "@/components/live/Restock";
import { PackBuy } from "@/components/PackBuy";
import { SimCarousel } from "@/components/SimCarousel";
import { Attribution, NftTierCard, PackPanels, SecHead } from "@/components/ui";
import { XappText } from "@/components/XappHost";
import { noOrphan, shortDate } from "@/lib/format";
import { NFT_TIERS } from "@/lib/nft/bands";
import { getMarket } from "@/lib/nft/server";
import { nftPack, parseNftPrice } from "@/lib/nft/view";
import { railsConfig } from "@/lib/rip/mode";
import { nftPackSeo, pageMeta } from "@/lib/seo";

export const revalidate = 300;
export const dynamicParams = false;
export const generateStaticParams = () => SHELF_PRICES.map((p) => ({ price: String(p) }));

type Props = { params: Promise<{ price: string }> };

/** Chase collections the snapshot doesn't name yet. */
const CHASE_NAMES: Readonly<Record<string, string>> = {
  "xrp-army-og-collection": "XRP ARMY OG Collection",
  teddybg: "Teddy BG",
  "bearableguyclub-genesis-i": "BearableGuyClub Genesis I",
  "seal-cto-scrolls": "SEAL on XRPL CTO Scrolls",
  tessera: "Tessera",
  hydros: "Hydros",
  bearxrpl: "BEAR Ultra Rare Collection",
  bottlechamp: "Bear Champ Corrupted Bottle",
  cultorigin: "Cultist",
  fuzzybears: "Fuzzybears",
};
const chaseLabel = (slug: string) => CHASE_NAMES[slug] ?? slug;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { price } = await params;
  const p = parseNftPrice(price);
  return p ? pageMeta(nftPackSeo(p, nftPack(p, {}).name)) : { title: "NFT pack" };
}

export default async function NftPackPage({ params }: Props) {
  const { price } = await params;
  const p: NftPrice | null = parseNftPrice(price);
  if (!p || !isOffered(p)) notFound();
  const market = await getMarket();
  const pack = nftPack(p, market.collections);
  const artReady = pack.tiers.every((t) => t.dustXrp || (t.collection && t.collection.samples.length > 0));
  const live = railsConfig(process.env).mode !== "demo";
  const others = SHELF_PRICES.filter((x) => x !== p).map((x) => nftPack(x, market.collections));
  const similar = others.length ? (
    <SimCarousel label="Similar packs">
      {others.map((o) => (
        <Link className="simc" key={o.price} href={`/nft/${o.price}`}>
          <div className="stack one s">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img loading="lazy" src={o.art} alt="" />
            <RestockStamp price={o.price} ms={20000} />
          </div>
          <h3>{o.shortName}</h3>
          <strong>${o.price}</strong>
          <span className="lb">{o.xrp} XRP</span>
        </Link>
      ))}
    </SimCarousel>
  ) : undefined;
  return (
    <main className="pg packp">
      <div className="crumb">
        <Link href="/packs">packs</Link> / {pack.name}
      </div>
      <div className="split">
        <div className="pstage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="solo" src={pack.art} alt={pack.name} />
          <RestockStamp price={p} ms={20000} />
        </div>
        <div className="pcopy">
          <h1>
            {pack.name}
            <em>.</em>
          </h1>
          <div className="price">${p}.00</div>
          <span className="lb">per pack · {pack.xrp} XRP</span>
          <dl className="dl">
            {live ? (
              <LiveInPack price={p} />
            ) : (
              <div>
                <dt>In the pack</dt>
                <dd>{pack.tokenPrizes.length ? "One prize: XRP, SEAL or an XRPL NFT" : "1 XRPL NFT"}</dd>
              </div>
            )}
            <div>
              <dt><XappText web="Instant sell-back" app="Sell-back price" /></dt>
              <dd>{NFT_SELL_PERCENT}% of marked value</dd>
            </div>
            <div>
              <dt>Sell fee</dt>
              <dd>{SELL_FEE_PERCENT}%</dd>
            </div>
            <PoolFacts price={p} />
          </dl>
          <PackBuy href={`/checkout?nft=${p}`} tryHref={`/try?pack=n${p}`} price={p} nftPrice={p} eachXrp={pack.xrp} disabledLabel={artReady ? undefined : "Coming soon"} />
        </div>
      </div>
      {live ? (
        <LivePoolSections price={p} similar={similar} />
      ) : (
        <>
          <PackPanels
            similar={similar}
            rates={
              <>
                <SecHead title="Rarity rates" />
                <NftRates price={p} />
                <p className="fine"><NftRateCopy /> <Link href="/fair">How the draw works</Link>.</p>
              </>
            }
          />
          <section className="s">
            <SecHead
              title="In this pack"
              right={
                <>
                  {market.stale ? `Floors from ${shortDate(market.asOf)}, prices that move · ` : "Live floors, prices that move · "}
                  <Attribution />
                </>
              }
            />
            <div className="igrid five">
              {pack.tiers.map((t) => (
                <NftTierCard key={t.tier} view={t} xrpUsd={market.xrpUsd} />
              ))}
            </div>
            {pack.tiers[0]?.dustXrp ? (
              <p className="fine">Each pull lands on a band at its rarity rate. Most pulls land on Common, which pays a small XRP or SEAL prize you can put toward another pack. Higher bands can pay a real NFT, picked fairly from everything in that band, across collections. Every prize sits in a public wallet you can check on the&nbsp;ledger.</p>
            ) : (
              <p className="fine">Each pull lands on a band at its rarity rate. Most pulls land on Common, which pays an XRP or SEAL prize or a real NFT. Every band can pay a real NFT, picked fairly from everything in that band, across collections. Every prize sits in a public wallet you can check on the&nbsp;ledger.</p>
            )}
          </section>
          {pack.fiftyUpPct ? (
            <section className="s">
              <SecHead title="$50 and up" />
              <p>{noOrphan(`${pack.fiftyUpPct}% of pulls land on a prize worth $50 or more at today's floors.`)}</p>
              <p className="fine">{noOrphan(`On the Chase band: ${pack.chase.map((s) => market.collections[s]?.name ?? chaseLabel(s)).join(", ")}.`)}</p>
            </section>
          ) : null}
          {pack.tokenPrizes.length ? (
            <section className="s">
              <SecHead title="XRP and SEAL prizes" />
              <dl className="dl wide">
                {pack.tokenPrizes.map((r) => (
                  <div key={`${r.band}-${r.xrp}`}>
                    <dt>{NFT_TIERS[r.band]}</dt>
                    <dd>{noOrphan(`${r.bps / 100}% of ${NFT_TIERS[r.band]} pulls pay ${r.xrp} XRP, or SEAL worth the same`)}</dd>
                  </div>
                ))}
              </dl>
              <p className="fine">{noOrphan("A SEAL prize is a fixed amount set when you pull, shown on your reveal. Stash it, redeem it to your wallet or sell it. XRP goes straight to your wallet when you redeem it. A Common prize pays XRP if your wallet has no SEAL trust line, so there's nothing to set up.")}</p>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
