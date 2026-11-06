import { ListView } from "@/components/CollectionViews";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.sell);

export default function SellPage() {
  return <ListView kind="sell" />;
}
