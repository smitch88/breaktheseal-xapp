import { ItemView } from "@/components/CollectionViews";
import { LiveItemView } from "@/components/live/LiveItem";
import { parseLiveId } from "@/lib/live/client";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.item);

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return parseLiveId(id) ? <LiveItemView rawId={id} /> : <ItemView id={id} />;
}
