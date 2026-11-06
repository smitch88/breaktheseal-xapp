import { NotFoundBody } from "@/components/NotFoundBody";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.notFound);

// notFound() from any (site) page (/admin for a non-admin, a bad /nft or /packs code) renders inside the (site) layout, which already draws
// the header and footer. Without this file Next falls back to the root not-found, which draws them again.
export default function SiteNotFound() {
  return <NotFoundBody />;
}
