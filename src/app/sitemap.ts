import type { MetadataRoute } from "next";
import { SHELF_PRICES } from "@/config/nft-packs";
import { getCatalog } from "@/lib/catalog/server";
import { sitemapPaths } from "@/lib/seo";
import { OFFICIAL_DOMAIN, cardRailsSet } from "@/lib/site";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const machines = cardRailsSet(process.env) ? (await getCatalog()).machines.map((m) => m.code) : [];
  return sitemapPaths(process.env, SHELF_PRICES, machines).map((path) => ({ url: `https://${OFFICIAL_DOMAIN}${path === "/" ? "" : path}` }));
}
