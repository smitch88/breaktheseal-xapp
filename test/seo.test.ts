import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import sharp from "sharp";
import { NFT_LADDERS, NFT_PRICES, SHELF_PRICES } from "../src/config/nft-packs.ts";
import { OG_VERSION, SEO, indexable, machineSeo, nftPackSeo, ogImage, pageMeta, robotsRules, sitemapPaths, type PageSeo } from "../src/lib/seo.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const routeOf = (file: string) => "/" + relative(join(root, "src/app"), file).replace(/(^|\/)page\.tsx$/, "").replace(/\([^)]+\)\/?/g, "").replace(/\/$/, "");
const pages = new Map(walk(join(root, "src/app")).filter((f) => f.endsWith("/page.tsx")).map((f) => [routeOf(f), readFileSync(f, "utf8")]));

const PUBLIC = ["/", "/packs", "/nft/[price]", "/packs/[code]", "/try", "/how", "/rates", "/fair", "/support", "/terms", "/privacy"];
/** A player's own views: a shared link gets a generic preview and search never sees them. */
const PRIVATE = ["/collection", "/collection/[id]", "/sell", "/ship", "/checkout", "/profile", "/admin", "/auth/return", "/open/[orderId]", "/reveal/[orderId]", "/xapp"];
const LIVE = { SEAL_PUBLIC_ORIGIN: "https://breaktheseal.rip" };

const fixed = (): PageSeo[] => Object.values(SEO).map((v) => (typeof v === "function" ? v(LIVE) : v));
const packs = () => NFT_PRICES.map((p) => nftPackSeo(p, NFT_LADDERS[p].name));

test("every route on disk has been placed as public or private, and says so through pageMeta", () => {
  assert.deepEqual([...pages.keys()].sort(), [...PUBLIC, ...PRIVATE].sort());
  for (const [route, text] of pages) assert.match(text, /pageMeta\(/, `${route} has no preview`);
});

test("a private route with a player's id in its address can't put it in its metadata: its metadata is fixed", () => {
  for (const route of PRIVATE.filter((r) => r.includes("["))) assert.doesNotMatch(pages.get(route)!, /generateMetadata/, route);
  for (const seo of [SEO.item, SEO.open, SEO.reveal]) {
    const text = JSON.stringify(pageMeta(seo, LIVE));
    assert.doesNotMatch(text, /\/collection\/|\/open\/|\/reveal\/|rip_|card_/, seo.path);
    assert.equal(pageMeta(seo, LIVE).alternates, undefined, "no canonical to name it");
  }
});

test("every public page carries a title, description, canonical, Open Graph and Twitter card on the right image", () => {
  for (const seo of [...fixed().filter((s) => s.open), ...packs(), machineSeo("pokemon_25", "Starter Pack", true)]) {
    const m = pageMeta(seo, LIVE);
    const og = m.openGraph as { title: string; description: string; url: string; siteName: string; images: { url: string; width: number; height: number; alt: string }[] };
    const tw = m.twitter as { card: string; title: string; images: { url: string }[] };
    assert.ok(m.title && m.description, seo.path);
    assert.equal((m.alternates as { canonical: string }).canonical, seo.path);
    assert.equal(og.url, seo.path);
    assert.equal(og.siteName, "Break the Seal");
    assert.match(og.title, /Break the Seal$/);
    assert.equal(tw.card, "summary_large_image");
    assert.equal(tw.title, og.title);
    assert.deepEqual([og.images[0].url, og.images[0].width, og.images[0].height], [seo.image, 1200, 630]);
    assert.equal(tw.images[0].url, seo.image);
    assert.ok(og.images[0].alt.length > 8);
    assert.match(seo.image, new RegExp(`[?&]v=${OG_VERSION}$`), "a versioned URL, so X and Discord refetch");
    assert.match(seo.path, /^\/(?!\/)/);
  }
});

test("every baked preview is a real 1200x630 JPEG, about 300 KB at most", async () => {
  for (const seo of [...fixed(), ...packs(), { image: ogImage("machine") } as PageSeo]) {
    const file = join(root, "public", seo.image.split("?")[0]);
    const { format, width, height } = await sharp(file).metadata();
    assert.deepEqual([format, width, height], ["jpeg", 1200, 630], file);
    assert.ok(statSync(file).size <= 300 * 1024, `${file} is ${statSync(file).size} bytes`);
  }
});

test("search only sees public pages on the live domain, and any other deploy stays out", () => {
  fc.assert(
    fc.property(fc.webUrl(), fc.boolean(), (origin, open) => {
      const env = { SEAL_PUBLIC_ORIGIN: origin };
      const robots = pageMeta({ path: "/x", title: "x", description: "x", image: "/x", alt: "x", open }, env).robots as { index: boolean };
      assert.equal(robots.index, open && indexable(env));
      if (origin.replace(/\/$/, "") !== "https://breaktheseal.rip") assert.equal(robots.index, false);
    }),
  );
  assert.equal(indexable({ VERCEL_ENV: "production" }), true);
  for (const env of [{}, { VERCEL_ENV: "preview" }, { SEAL_PUBLIC_ORIGIN: "https://seal-rips-testnet.vercel.app", VERCEL_ENV: "production" }]) {
    assert.equal(indexable(env), false);
    assert.deepEqual(robotsRules(env), { rules: [{ userAgent: "*", disallow: "/" }] });
    assert.deepEqual(sitemapPaths(env, SHELF_PRICES, ["a"]), []);
  }
  for (const seo of fixed().filter((s) => !s.open)) assert.equal((pageMeta(seo, LIVE).robots as { index: boolean }).index, false, seo.path);
  for (const seo of fixed().filter((s) => s.open)) assert.equal((pageMeta(seo, LIVE).robots as { index: boolean }).index, true, seo.path);
});

test("robots.txt lets a crawler read every page's card and image, and shuts out only the API, admin and other people's art", () => {
  const { disallow } = robotsRules(LIVE).rules[0] as { disallow: string[] };
  const blocked = (path: string) => disallow.some((d) => path.startsWith(d));
  for (const seo of fixed().filter((s) => s.path !== "/admin")) {
    assert.ok(!blocked(seo.path), seo.path);
    assert.ok(!blocked(seo.image), seo.image);
  }
  assert.ok(!blocked("/collection/rip_abc"), "a private page's noindex and generic card still have to be readable");
  assert.ok(!blocked(machineSeo("a", "A", false).image));
  for (const p of ["/api/mirror/1", "/admin", "/nfts/x/1.webp", "/_next/image"]) assert.ok(blocked(p), p);
  // A site-wide noindex header would undo all of this.
  const config = readFileSync(join(root, "next.config.mjs"), "utf8");
  const pageHeaders = config.slice(config.indexOf('source: "/:path*"'), config.indexOf('"/api/:path*"'));
  assert.doesNotMatch(pageHeaders, /X-Robots-Tag/);
});

test("the sitemap holds the public pages and the shelf, and card machines only while the card line is open", () => {
  const off = sitemapPaths(LIVE, SHELF_PRICES, ["pokemon_25"]);
  for (const p of ["/", "/packs", "/try", "/how", "/rates", "/fair", "/support", "/terms", "/privacy", ...SHELF_PRICES.map((x) => `/nft/${x}`)]) assert.ok(off.includes(p), p);
  assert.ok(!off.some((p) => p.startsWith("/packs/")));
  assert.ok(sitemapPaths({ ...LIVE, SEAL_CARD_RAILS: "on" }, SHELF_PRICES, ["pokemon_25"]).includes("/packs/pokemon_25"));
  for (const p of off) assert.ok(!PRIVATE.some((r) => p === r), p);
  assert.equal((pageMeta(machineSeo("a", "A", false), LIVE).robots as { index: boolean }).index, false, "a machine that sells nothing stays out of search");
});

test("no preview says anything about odds, returns or investing, and no copy promises a win", () => {
  for (const seo of [...fixed(), ...packs(), machineSeo("a", "A Pack", true)]) {
    const text = `${seo.title} ${seo.description} ${seo.alt}`;
    assert.doesNotMatch(text, /\b(odds|RTP|returns?|profit|invest\w*|guarantee\w*|jackpot|win|winner|sold out|restocking)\b|\d+\s*%/i, text);
  }
  // The price in a machine's name comes only from the name: nothing else about it reaches the preview.
  const m = pageMeta(machineSeo("pokemon_25", "Starter Pack", true), LIVE);
  assert.doesNotMatch(JSON.stringify(m), /\$|XRP|stock/);
});
