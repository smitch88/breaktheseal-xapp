import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { XappBoot } from "@/components/XappBoot";
import { currentXappNetwork, xappOn } from "@/lib/auth/xapp-server";
import { sealTokenSpec } from "@/lib/rip/tokens";
import { SEO, pageMeta } from "@/lib/seo";
import { cardRailsSet } from "@/lib/site";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMeta(SEO.xapp);

export default function XappPage() {
  if (!xappOn()) notFound();
  return <XappBoot network={currentXappNetwork()} seal={!!sealTokenSpec(process.env)} cards={cardRailsSet(process.env)} />;
}
