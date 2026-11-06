import Link from "next/link";
import { isNftPrice, isOffered, type NftPrice } from "@/config/nft-packs";
import { CheckoutFlow } from "@/components/CheckoutFlow";
import { Fan } from "@/components/ui";
import { MACHINE_CODE } from "@/lib/catalog/parse";
import { catalogSource, getCatalog } from "@/lib/catalog/server";
import { getMarket } from "@/lib/nft/server";
import { nftPack } from "@/lib/nft/view";
import { parseQty } from "@/lib/live/multi";
import { multiConfig } from "@/lib/rip/mode";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.checkout);

type Props = { searchParams: Promise<{ pack?: string; nft?: string; qty?: string; go?: string }> };

function PickFirst() {
  return (
    <main className="pg">
      <div className="emptyc">
        <h3>Pick a pack first</h3>
        <Link className="btn" href="/packs">
          Explore packs
        </Link>
      </div>
    </main>
  );
}

export default async function CheckoutPage({ searchParams }: Props) {
  const { pack, nft, qty: qtyRaw, go: goRaw } = await searchParams;
  // Only a hint from the pack page's Open: checkout itself decides whether it may skip to the wallet's request.
  const go = goRaw === "1";
  // A quantity in a link is only ever what to show first. The server decides what it can sell, and with the switch off there is no such thing.
  const qty = multiConfig(process.env) ? parseQty(qtyRaw) : 1;
  const market = await getMarket();
  if (nft) {
    const n = Number(nft);
    if (!isNftPrice(n) || !isOffered(n)) return <PickFirst />;
    const view = nftPack(n as NftPrice, market.collections);
    return (
      <CheckoutFlow
        pack={{ kind: "nft", price: view.price }}
        name={view.name}
        price={view.price}
        art={view.art}
        back={`/nft/${view.price}`}
        xrpUsd={market.xrpUsd}
        qty={qty}
        go={go}
        stage={
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className="solo" src={view.art} alt="" />
        }
      />
    );
  }
  if (!pack || !MACHINE_CODE.test(pack)) return <PickFirst />;
  const catalog = await getCatalog();
  const found = catalog.machines.find((m) => m.code === pack);
  if (!found || found.stock === 0) return <PickFirst />;
  const [m] = await catalogSource.withFans([found]);
  return <CheckoutFlow pack={{ kind: "card", code: m.code }} name={m.name} price={m.price} art="/assets/stage-pack.webp" back={`/packs/${m.code}`} xrpUsd={market.xrpUsd} qty={qty} go={go} stage={<Fan machine={m} big />} />;
}
