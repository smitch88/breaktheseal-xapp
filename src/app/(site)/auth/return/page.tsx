import { AuthReturn } from "@/components/AuthReturn";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.signingIn);

export default function AuthReturnPage() {
  return <AuthReturn />;
}
