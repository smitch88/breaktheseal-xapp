import { LegalDoc } from "@/components/LegalDoc";
import { TERMS, TERMS_WITH_MULTI } from "@/lib/legal/content";
import { multiConfig } from "@/lib/rip/mode";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.terms);

export default function TermsPage() {
  if (multiConfig(process.env)) return <LegalDoc doc={TERMS_WITH_MULTI} />;
  return <LegalDoc doc={TERMS} />;
}
