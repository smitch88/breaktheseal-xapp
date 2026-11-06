import { allowed, clientIp } from "@/lib/auth/server";
import { serveArt } from "@/lib/rip/art-proxy";
import { rails } from "@/lib/rip/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Pictures don't change: only NFTs whose art can't change go in a pool. A miss is asked again in a few minutes, so a gateway outage heals by itself. */
const KEEP = "public, max-age=86400, s-maxage=31536000, immutable";
const MISS = "public, max-age=60, s-maxage=600";
// Served from this site, so whatever it holds can never run: a picture opened on its own gets no script, no requests and no forms.
// next.config.mjs sets the same for this path, since its own CSP for every page would otherwise replace this one.
const SANDBOX = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";

const none = () => new Response("No picture.", { status: 404, headers: { "Cache-Control": MISS, "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" } });

/** An NFT's own picture, for an NFT in the public log whose picture this site has no saved copy of. The page shows "picture not available" on a 404. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const r = rails();
  if (!r) return none();
  if (!allowed(`art:${clientIp(req)}`, 240, 60_000)) return new Response("Too many tries. Wait a minute.", { status: 429, headers: { "Cache-Control": "no-store" } });
  const { key } = await params;
  await r.engine.sync();
  const nftInfo = r.engine.chain.nftInfo?.bind(r.engine.chain);
  const art = await serveArt(key, { state: r.engine.state, nftUri: nftInfo });
  if (art.kind === "saved") return new Response(null, { status: 308, headers: { Location: art.path, "Cache-Control": KEEP } });
  if (art.kind === "none") return none();
  return new Response(new Uint8Array(art.body), { status: 200, headers: { "Content-Type": art.type, "Content-Length": String(art.body.length), "Cache-Control": KEEP, "Content-Security-Policy": SANDBOX, "X-Robots-Tag": "noindex, nofollow" } });
}
