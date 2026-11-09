import type { Metadata } from "next";
import { railsConfig } from "./rip/mode.ts";
import { sealTokenSpec } from "./rip/tokens.ts";
import { OFFICIAL_DOMAIN, SITE_NAME, cardRailsSet, publicOrigin } from "./site.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Bump after changing any image in public/assets/og, so X and Discord fetch it again. They cache by URL. */
export const OG_VERSION = 1;
export const ogImage = (slug: string) => `/assets/og/${slug}.jpg?v=${OG_VERSION}`;
/** A card machine's preview, drawn from its live name: see src/app/og/pack/[code]/route.tsx. */
export const machineOgImage = (code: string) => `/og/pack/${encodeURIComponent(code)}?v=${OG_VERSION}`;
export const X_HANDLE = "@sealonxrp";

/** Only the live site goes in search. Previews and the testnet stay out. */
export const indexable = (env: Env) => publicOrigin(env) === `https://${OFFICIAL_DOMAIN}`;

/**
 * Private pages stay crawlable on purpose: their noindex can only be read by a crawler let in, and X won't draw a link card for a
 * page robots.txt shuts out. Other people's NFT art stays out of image search.
 */
export function robotsRules(env: Env) {
  if (!indexable(env)) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/admin", "/nfts/", "/_next/image"] }], sitemap: `https://${OFFICIAL_DOMAIN}/sitemap.xml` };
}

const PUBLIC_PATHS = ["/", "/packs", "/try", "/how", "/rates", "/fair", "/support", "/terms", "/privacy"];

/** What goes in the sitemap: the public pages, the shelf and, once the card line is open, its machines. */
export function sitemapPaths(env: Env, shelf: readonly number[], machineCodes: readonly string[]): string[] {
  if (!indexable(env)) return [];
  return [...PUBLIC_PATHS, ...shelf.map((p) => `/nft/${p}`), ...(cardRailsSet(env) ? machineCodes.map((c) => `/packs/${encodeURIComponent(c)}`) : [])];
}

/** Says only what this deploy really offers: a demo says so, and SEAL is named only while SEAL prizes are on. */
export function siteDescription(env: Env): string {
  if (railsConfig(env).mode === "demo") return "XRPL NFT packs and XRP and SEAL prizes, one bite at a time. Preview: every pull is a demo.";
  return sealTokenSpec(env) ? "XRPL NFT packs and XRP and SEAL prizes, one bite at a time." : "XRPL NFT packs and XRP prizes, one bite at a time.";
}

export interface PageSeo {
  /** Where the page lives, with no player's id in it. Private views name their section, so a shared link's preview says nothing about whose it is. */
  readonly path: string;
  /** Null for the home page, which is just the site's name. */
  readonly title: string | null;
  readonly description: string;
  /** Site-relative image URL, from ogImage or machineOgImage. */
  readonly image: string;
  readonly alt: string;
  /** Public and searchable. Everything else is noindex, with no canonical. */
  readonly open?: boolean;
}

export function pageMeta(p: PageSeo, env: Env = process.env): Metadata {
  const title = p.title ? `${p.title} · ${SITE_NAME}` : SITE_NAME;
  const search = !!p.open && indexable(env);
  return {
    title: p.title ?? { absolute: SITE_NAME },
    description: p.description,
    ...(p.open ? { alternates: { canonical: p.path } } : {}),
    robots: search ? { index: true, follow: true } : { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "en_US",
      url: p.path,
      title,
      description: p.description,
      images: [{ url: p.image, width: 1200, height: 630, alt: p.alt, type: p.image.includes(".jpg") ? "image/jpeg" : "image/png" }],
    },
    twitter: { card: "summary_large_image", site: X_HANDLE, title, description: p.description, images: [{ url: p.image, alt: p.alt }] },
  };
}

const page = (path: string, title: string, description: string, slug: string, alt: string, open = false): PageSeo => ({ path, title, description, image: ogImage(slug), alt, open });

/** Every fixed page. test/seo.test.ts checks this against the routes on disk and the images in public/assets/og. */
export const SEO = {
  home: (env: Env = process.env): PageSeo => ({ path: "/", title: null, description: siteDescription(env), image: ogImage("home"), alt: "Break the Seal: a seal bites into a foil pack and cracks its red wax seal", open: true }),
  packs: page("/packs", "Packs", "Browse the packs on the shelf. See what's in each one and its rarity rates, then open one or try it for free.", "packs", "Foil packs on a comic burst, under the Break the Seal logo", true),
  try: page("/try", "Try the bite", "Try a pack for free. Nothing is drawn or paid, and you don't own what it shows.", "try", "A foil pack between a seal's fangs", true),
  how: page("/how", "How packs work", "How a pack works, from picking one to what you can do with your prize.", "how", "Three comic panels: pick a pack, the bite, the reveal", true),
  rates: page("/rates", "Rarity rates", "The rarity rates for every pack, in one place.", "rates", "A seal with a magnifying glass looks over a row of five gems", true),
  fair: page("/fair", "How the draw works", "How an NFT pack's draw is committed on the XRP Ledger, and how to check a pull yourself.", "fair", "A seal with a magnifying glass inspects a chain with one gold link", true),
  terms: page("/terms", "Terms", "The terms for using Break the Seal and opening packs.", "terms", "A parchment scroll closed with a red wax seal", true),
  privacy: page("/privacy", "Privacy", "What Break the Seal collects, who it goes to and how long it stays.", "privacy", "An envelope closed with a red wax seal", true),
  support: page("/support", "Support", "Help with an order, a refund, a prize or a wallet, and how to spot a scam.", "support", "A seal in a headset waves hello", true),
  collection: page("/collection", "Collection", "Your stash on Break the Seal. Connect your wallet to see it.", "collection", "A seal guards a vault door"),
  item: page("/collection", "Your prize", "A prize in a Break the Seal stash. Connect the wallet that holds it to see it.", "collection", "A seal guards a vault door"),
  sell: page("/sell", "Sell back", "Sell a prize from your stash back for XRP. Connect your wallet to see it.", "sell", "A seal in a pile of silver coins"),
  ship: page("/ship", "Ship", "Ship a prize from your stash. Connect your wallet to see it.", "ship", "A seal with a parcel on a hand truck"),
  checkout: page("/checkout", "Checkout", "One pack, paid from your wallet.", "checkout", "Three foil packs on a comic burst"),
  open: page("/packs", "Opening a pack", "A pack, between the fangs.", "open", "A foil pack between a seal's fangs"),
  reveal: page("/packs", "The reveal", "Break the seal and see.", "reveal", "A seal with foil in its teeth holds up a graded slab"),
  profile: page("/profile", "Profile", "Your wallet on Break the Seal. Connect it to see it.", "profile", "A seal looks into an empty locker"),
  admin: page("/admin", "Admin", "Operators only.", "home", "The Break the Seal logo"),
  signingIn: page("/", "Signing in", "Finishing your wallet sign-in.", "home", "The Break the Seal logo"),
  xapp: page("/", "Opening", "Opening Break the Seal in Xaman.", "home", "The Break the Seal logo"),
  notFound: page("/", "Page not found", "That page got eaten. The packs are still here.", "home", "The Break the Seal logo"),
} as const;

/** One of our own NFT packs. Its name and art never change, and it says nothing about price, stock or restocking. */
export const nftPackSeo = (price: number, name: string): PageSeo => page(`/nft/${price}`, name, `${name}: see what's in it and its rarity rates, then open one or try it for free.`, `nft-${price}`, `The ${name}, sealed with red wax, on a comic burst`, true);

/**
 * A card machine, by its live name. It goes in search only while the card line is open: until then its page sells nothing.
 * The name stands in for what's in the pack and the image is our own foil pack, so no brand is the picture's subject.
 */
export const machineSeo = (code: string, name: string, onSale: boolean): PageSeo => ({
  path: `/packs/${encodeURIComponent(code)}`,
  title: name,
  description: `${name}: one collectible in every pack. See its rarity rates, or try it for free.`,
  image: machineOgImage(code),
  alt: "A sealed silver foil pack with a red wax seal",
  open: onSale,
});
