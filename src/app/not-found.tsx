import { NotFoundBody } from "@/components/NotFoundBody";
import { SiteChrome } from "@/components/SiteChrome";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.notFound);

// Unknown URLs (and notFound() outside the (site) group, e.g. /xapp with the xApp off) render here, inside the root layout only, so this
// one draws the chrome. notFound() thrown under (site) lands on (site)/not-found.tsx instead, which is already inside SiteChrome.
export default function NotFound() {
  return (
    <SiteChrome>
      <NotFoundBody />
    </SiteChrome>
  );
}
