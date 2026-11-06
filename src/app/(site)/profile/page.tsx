import { ProfileView } from "@/components/CollectionViews";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.profile);

export default function ProfilePage() {
  return <ProfileView />;
}
