import { FairView } from "@/components/live/FairView";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.fair);

export default function FairPage() {
  return <FairView />;
}
