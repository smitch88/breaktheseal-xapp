import { ListView } from "@/components/CollectionViews";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.ship);

export default function ShipPage() {
  return <ListView kind="ship" />;
}
