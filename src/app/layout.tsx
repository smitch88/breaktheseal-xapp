import type { Metadata, Viewport } from "next";
import { Anton, Atkinson_Hyperlegible, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import { xappEnabled } from "@/lib/auth/xapp";
import { getMarket } from "@/lib/nft/server";
import { multiConfig, railsConfig } from "@/lib/rip/mode";
import { X_HANDLE, ogImage, siteDescription } from "@/lib/seo";
import { OFFICIAL_DOMAIN, SITE_NAME, publicOrigin } from "@/lib/site";
import { XAPP_HEAD_SCRIPT } from "@/lib/xapp-style";
import "./globals.css";
import "./xapp.css";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton", display: "swap" });
const atkinson = Atkinson_Hyperlegible({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-atkinson", display: "swap" });
const mono = JetBrains_Mono({ weight: ["500", "700"], subsets: ["latin"], variable: "--font-mono", display: "swap" });

export function generateMetadata(): Metadata {
  const description = siteDescription(process.env);
  const images = [{ url: ogImage("home"), width: 1200, height: 630, alt: `${SITE_NAME}: a seal bites into a foil pack and cracks its red wax seal`, type: "image/jpeg" }];
  return {
    metadataBase: new URL(publicOrigin(process.env) ?? `https://${OFFICIAL_DOMAIN}`),
    applicationName: SITE_NAME,
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description,
    // A page opts in to search through pageMeta. Anything that forgets to stays out, and never names itself.
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", title: SITE_NAME, description, images },
    twitter: { card: "summary_large_image", site: X_HANDLE, title: SITE_NAME, description, images },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#08080d" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const market = await getMarket();
  const xapp = xappEnabled(process.env);
  const multi = multiConfig(process.env);
  return (
    <html lang="en" className={`${anton.variable} ${atkinson.variable} ${mono.variable}`} suppressHydrationWarning={xapp}>
      {/* Xaman's rule: html and body are transparent from the first frame. This runs before anything paints, only matches Xaman's own user agent, and sets Xaman's color style. */}
      {xapp ? (
        <head>
          <script dangerouslySetInnerHTML={{ __html: XAPP_HEAD_SCRIPT }} />
        </head>
      ) : null}
      <body>
        <Providers xrpUsd={market.xrpUsd} rails={{ mode: railsConfig(process.env).mode, ...(multi ? { multi } : {}) }} xapp={xapp}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
