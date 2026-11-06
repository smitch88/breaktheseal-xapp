// Next matches `has` values as a plain RegExp, with no flags, so the case is spelled out.
const XAMAN_UA = { type: "header", key: "user-agent", value: ".*[Xx][Uu][Mm][Mm]/[Xx][Aa][Pp][Pp].*" };

/** @type {import('next').NextConfig} */
const config = {
  devIndicators: false,
  agentRules: false,
  poweredByHeader: false,
  // Nothing is left external: this app's own lockfile leaves pnpm symlinks Vercel's tracer can't follow, so server code bundles.
  // Next leaves `pg` external by default; listing it here is what bundles it.
  transpilePackages: ["pg"],
  images: {
    // Slab photos come from the pack API's image host. Items on any other host are dropped by the parser, so this
    // list and ALLOWED_IMAGE_HOSTS in src/lib/catalog/parse.ts stay in step.
    remotePatterns: [
      { protocol: "https", hostname: "d1xpxki1g4htqu.cloudfront.net", pathname: "/**" },
      { protocol: "https", hostname: "nft.collectorcrypt.com", pathname: "/**" },
    ],
    minimumCacheTTL: 60 * 60 * 24 * 7,
    deviceSizes: [640, 828, 1200, 1920],
    imageSizes: [96, 128, 256, 384],
    formats: ["image/webp"],
  },
  // Xaman opens the xApp on its launch URL, /xapp, with the launch token and style in the query. A launch that lands on any other page
  // (the console's xApp URL set to the site's root, say) goes to /xapp with its query kept, so the account still comes from the token
  // and the website's wallet chooser never shows inside Xaman.
  async redirects() {
    const launch = [{ type: "query", key: "xAppToken" }];
    return [
      { source: "/", has: launch, destination: "/xapp", permanent: false },
      { source: "/:path((?!xapp$|api/|_next/).+)", has: launch, destination: "/xapp", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      // Xaman shows an xApp inside a frame and asks the host to allow framing and CORS from any origin. Only its own webview
      // sends `xumm/xapp`, and no page can change a visitor's user agent, so every other browser still refuses to be framed.
      { source: "/:path*", missing: [XAMAN_UA], headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }] },
      { source: "/:path*", has: [XAMAN_UA], headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] },
      // NFT art fetched for players from other people's servers. Whatever it holds can never run here, even opened on its own: no script, no requests, no forms.
      { source: "/api/rip/art/:path*", headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'" }] },
      // Pages say for themselves whether they go in search (src/lib/seo.ts). These have no page to say it, and the NFT art is other people's.
      ...["/api/:path*", "/nfts/:path*", "/_next/image"].map((source) => ({ source, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] })),
      { source: "/assets/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
      { source: "/nfts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
      // The XRP Ledger domain file (xrpl.org xrp-ledger.toml): Bithomp and Xaman check the house accounts against it. Any origin reads it, as text.
      { source: "/.well-known/xrp-ledger.toml", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Content-Type", value: "text/plain; charset=utf-8" }, { key: "Cache-Control", value: "public, max-age=3600" }] },
    ];
  },
};

export default config;
