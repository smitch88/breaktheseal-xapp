import { DemoMultiReveal } from "@/components/DemoMulti";
import { LiveRevealFlow } from "@/components/live/LiveOpen";
import { LiveMultiReveal } from "@/components/live/MultiOpen";
import { RevealFlow } from "@/components/RevealFlow";
import { DEMO_MULTI, LIVE_MULTI, parseLiveId } from "@/lib/live/client";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.reveal);

export default async function RevealPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (orderId.startsWith(LIVE_MULTI)) return <LiveMultiReveal rawId={orderId} />;
  if (orderId.startsWith(DEMO_MULTI)) return <DemoMultiReveal rawId={orderId} />;
  return parseLiveId(orderId) ? <LiveRevealFlow rawId={orderId} /> : <RevealFlow orderId={orderId} />;
}
