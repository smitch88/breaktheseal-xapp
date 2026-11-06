import type { MetadataRoute } from "next";
import { siteDescription } from "@/lib/seo";
import { SITE_NAME } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: siteDescription(process.env),
    start_url: "/",
    display: "standalone",
    background_color: "#08080d",
    theme_color: "#08080d",
    icons: [
      { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
