import { LegalDoc } from "@/components/LegalDoc";
import { XappSupport } from "@/components/XappShell";
import { SUPPORT } from "@/lib/legal/content";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.support);

export default function SupportPage() {
  return <LegalDoc doc={SUPPORT} top={<XappSupport />} />;
}
