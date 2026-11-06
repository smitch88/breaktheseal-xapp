import { DemoMultiOpen } from "@/components/DemoMulti";
import { LiveOpenFlow } from "@/components/live/LiveOpen";
import { LiveMultiOpen } from "@/components/live/MultiOpen";
import { OpenFlow } from "@/components/OpenFlow";
import { DEMO_MULTI, LIVE_MULTI, parseLiveId } from "@/lib/live/client";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.open);

export default async function OpenPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (orderId.startsWith(LIVE_MULTI)) return <LiveMultiOpen rawId={orderId} />;
  if (orderId.startsWith(DEMO_MULTI)) return <DemoMultiOpen rawId={orderId} />;
  return parseLiveId(orderId) ? <LiveOpenFlow rawId={orderId} /> : <OpenFlow orderId={orderId} />;
}
