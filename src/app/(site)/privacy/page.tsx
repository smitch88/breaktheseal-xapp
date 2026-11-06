import { LegalDoc } from "@/components/LegalDoc";
import { PRIVACY } from "@/lib/legal/content";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.privacy);

export default function PrivacyPage() {
  return <LegalDoc doc={PRIVACY} />;
}
