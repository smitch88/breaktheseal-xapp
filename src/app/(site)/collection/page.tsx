import { SHOWCASE_CODES } from "@/config/machines";
import { CollectionView } from "@/components/CollectionViews";
import { catalogSource, getCatalog } from "@/lib/catalog/server";
import type { Item, Machine } from "@/lib/catalog/types";
import { SEO, pageMeta } from "@/lib/seo";

export const revalidate = 300;
export const metadata = pageMeta(SEO.collection);

export default async function Collection() {
  const catalog = await getCatalog();
  const source = await catalogSource.withFans(SHOWCASE_CODES.map((c) => catalog.machines.find((m) => m.code === c)).filter((m): m is Machine => !!m));
  const examples: Item[] = source.flatMap((m) => m.fan.slice(0, 2));
  return <CollectionView examples={[...new Map(examples.map((e) => [e.id, e])).values()]} />;
}
