import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import sharp from "sharp";
import { IPFS_GATEWAYS } from "../src/lib/nft/media.ts";
import { artUrlRefusal, guardedLookup, isPublicAddress, readNftMeta, safeFetch, safeGet, sniffImage, type ArtGet } from "../src/lib/rip/art-fetch.ts";
import { ART_OUT_MAX, serveArt } from "../src/lib/rip/art-proxy.ts";
import { MAINNET_ID } from "../src/lib/rip/chain.ts";
import { NFT_ART, artKey, artProxy, fallbackName, prizeTitle } from "../src/lib/rip/nft-art.ts";
import { forgetMeta, learnNames, nftMeta, unnamedLots } from "../src/lib/rip/nft-meta.ts";
import type { RipState } from "../src/lib/rip/state.ts";
import { world } from "./support-routes.ts";

const hexId = fc.string({ unit: fc.constantFrom(..."0123456789ABCDEF"), minLength: 64, maxLength: 64 });
const octet = fc.integer({ min: 0, max: 255 });
const PNG = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#c33" } }).png().toBuffer();
const TEDDY_CID = "bafybeigqi2l2rwpgptevf2nur3yvfjnnye3zgpbb4gt5ab4jwjmcr2ez4u";
const TEDDY = `https://ipfs.io/ipfs/${TEDDY_CID}/teddy1160.png`;
const BETZY = "https://art.thejumpoff.xyz/sexy-betzy-c88a63/v52/1483.png";
const got = (body: Buffer | string, status = 200, type = "image/png") => ({ status, type, body: Buffer.from(body) });

/** A state with these lots in it, on mainnet: all the art route and the name reader look at. */
function stateWith(lots: { nftId: string; img: string; name?: string; collection?: string }[], networkId = MAINNET_ID): RipState {
  const s = { genesis: { networkId }, head: lots.length, lots: new Map(), nftLot: new Map() } as unknown as RipState;
  lots.forEach((l, i) => {
    const lot = `lot-${i}`;
    s.lots.set(lot, { lot, nftId: l.nftId, price: 5, band: 1, collection: l.collection ?? "Teddy BG", name: l.name ?? fallbackName(l.collection ?? "Teddy BG", l.nftId), img: l.img, costDrops: "1", markDrops: "1", status: "available" } as never);
    s.nftLot.set(l.nftId, lot);
  });
  return s;
}

/** A fake internet: each URL answers what the map says, or not at all. Every ask is written down. */
function net(answers: Record<string, ReturnType<typeof got> | null>) {
  const asked: string[] = [];
  const get: ArtGet = async (url) => {
    asked.push(url);
    return answers[url] ?? null;
  };
  return { get, asked };
}

// ---------------------------------------- What may be fetched at all

test("only https to a public name on port 443 is ever fetched: other schemes, logins, ports, addresses and local names are refused", () => {
  const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}\.(com|xyz|io|link|cloud)$/);
  fc.assert(
    fc.property(name, fc.webPath(), (host, path) => {
      assert.equal(artUrlRefusal(`https://${host}${path}`), null);
      assert.equal(artUrlRefusal(`https://${host}:443${path}`), null);
      for (const scheme of ["http", "ftp", "file", "gopher", "data", "javascript", "ws"]) assert.notEqual(artUrlRefusal(`${scheme}://${host}${path}`), null, scheme);
      assert.notEqual(artUrlRefusal(`https://user:pass@${host}${path}`), null);
      assert.notEqual(artUrlRefusal(`https://${host}:8443${path}`), null);
      assert.notEqual(artUrlRefusal(`https://${host}:80${path}`), null);
    }),
  );
  fc.assert(
    fc.property(octet, octet, octet, octet, (a, b, c, d) => {
      // Every address, public or not, written as an address: a name is required, so DNS and the socket check decide.
      for (const host of [`${a}.${b}.${c}.${d}`, `[::ffff:${a}.${b}.${c}.${d}]`, `${(a << 24) + (b << 16) + (c << 8) + d}`, `0x${a.toString(16)}.${b}.${c}.${d}`]) assert.notEqual(artUrlRefusal(`https://${host}/x.png`), null, host);
    }),
  );
  for (const bad of ["https://localhost/x", "https://foo.localhost/x", "https://printer.local/x", "https://metadata.internal/x", "https://router/x", "https://[::1]/x", "https://[fe80::1]/x", "https://a.test/x", "not a url", `https://x.com/${"a".repeat(2100)}`]) assert.notEqual(artUrlRefusal(bad), null, bad);
});

test("an address is public only outside every private, loopback, link-local, carrier, multicast, reserved and documentation range, in IPv4 and IPv6", () => {
  const inRange = (base: [number, number], bits: number) => fc.tuple(octet, octet, octet, octet).map(([, , c, d]) => {
    const n = (((base[0] << 24) | (base[1] << 16)) >>> 0) + (((c << 8) | d) & (2 ** (32 - bits) - 1));
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  });
  const privateV4 = fc.oneof(inRange([10, 0], 8), inRange([127, 0], 8), inRange([169, 254], 16), inRange([172, 16], 12), inRange([192, 168], 16), inRange([100, 64], 10), inRange([0, 0], 8), inRange([224, 0], 4), inRange([240, 0], 4), inRange([198, 18], 15));
  fc.assert(
    fc.property(privateV4, (ip) => {
      assert.equal(isPublicAddress(ip), false, ip);
      assert.equal(isPublicAddress(`::ffff:${ip}`), false, `mapped ${ip}`);
      assert.equal(isPublicAddress(`64:ff9b::${ip}`), false, `NAT64 ${ip}`);
    }),
  );
  for (const ip of ["8.8.8.8", "1.1.1.1", "104.16.0.1", "151.101.1.140", "::ffff:8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2002:a00:1::1", "2001::1", "192.0.2.1", "198.51.100.7", "203.0.113.9", "192.88.99.1", "255.255.255.255", "nonsense", "1.2.3", "1:2:3"]) assert.equal(isPublicAddress(ip), false, ip);
});

test("the socket's own DNS lookup refuses a name with any address that isn't public, so a second answer can't point it inside", async () => {
  const lookupWith = (addresses: string[]) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
      guardedLookup((_h, _o, cb) => cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))))("art.example", { all: true }, (err, address) => resolve({ err, address })),
    );
  assert.equal((await lookupWith(["93.184.216.34"])).err, null);
  assert.equal((await lookupWith(["10.0.0.7"])).err?.code, "ENOTPUBLIC");
  assert.equal((await lookupWith(["93.184.216.34", "169.254.169.254"])).err?.code, "ENOTPUBLIC", "one bad address is enough");
  assert.equal((await lookupWith(["::1"])).err?.code, "ENOTPUBLIC");
  assert.equal((await lookupWith([])).err?.code, "ENOTPUBLIC");
  // Asked for one address, it hands one back.
  const one = await new Promise<unknown[]>((resolve) => guardedLookup((_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]))("art.example", {}, (...a) => resolve(a)));
  assert.deepEqual(one, [null, "93.184.216.34", 4]);
});

test("a refused URL never leaves the server: no request, a null answer, and fetch's shape throws as a network error would", async () => {
  for (const url of ["http://example.com/x.png", "https://127.0.0.1/x.png", "https://localhost/x.png", "https://[::1]/", "https://169.254.169.254/latest/meta-data/"]) assert.equal(await safeGet(url, { timeoutMs: 500 }), null, url);
  await assert.rejects(safeFetch()("http://example.com/x.png"));
});

test("a picture is what its first bytes say, whatever its server called it, and anything else is not one", () => {
  const tail = fc.uint8Array({ maxLength: 64 });
  const heads: [string, number[]][] = [["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], ["image/jpeg", [0xff, 0xd8, 0xff]], ["image/gif", [...Buffer.from("GIF89a")]], ["image/webp", [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP")]], ["image/avif", [0, 0, 0, 0x1c, ...Buffer.from("ftypavif")]]];
  fc.assert(
    fc.property(fc.constantFrom(...heads), tail, ([type, head], rest) => {
      assert.equal(sniffImage(Uint8Array.from([...head, ...rest])), type);
    }),
  );
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?>\n<!-- art --><svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
  assert.equal(sniffImage(Buffer.from("﻿  <svg viewBox='0 0 1 1'/>")), "image/svg+xml");
  for (const not of ["<!doctype html><html>gateway says no</html>", '{"name":"Teddy1160"}', "Too Many Requests", "", "<svgx>"]) assert.equal(sniffImage(Buffer.from(not)), null, not);
});

// ---------------------------------------- Reading metadata

test("metadata: inline JSON, then each gateway in turn until one answers with JSON; a URI that is a picture is its own media with no name", async () => {
  const inline = `data:application/json,${encodeURIComponent(JSON.stringify({ name: " Teddy1160 ", image: "ipfs://cid/teddy1160.png" }))}`;
  assert.deepEqual(await readNftMeta(inline, net({}).get), { name: "Teddy1160", media: "ipfs://cid/teddy1160.png" });
  const uri = `ipfs://${TEDDY_CID}/Teddy1160.json`;
  const [first, second, third] = IPFS_GATEWAYS.map((g) => `${g}${TEDDY_CID}/Teddy1160.json`);
  const n = net({ [first]: got("This IPFS gateway is switching to a service worker gateway only", 403, "text/plain"), [second]: got("<html>rate limited</html>", 200, "text/html"), [third]: got(JSON.stringify({ name: "Teddy1160", image_url: "ipfs://x/teddy1160.png" }), 200, "application/json") });
  assert.deepEqual(await readNftMeta(uri, n.get), { name: "Teddy1160", media: "ipfs://x/teddy1160.png" });
  assert.deepEqual(n.asked, [first, second, third]);
  assert.deepEqual(await readNftMeta(BETZY, net({ [BETZY]: got(PNG) }).get), { name: null, media: BETZY });
  assert.equal(await readNftMeta("https://meta.example/1.json", net({ "https://meta.example/1.json": got(JSON.stringify({ description: "no picture" }), 200, "application/json") }).get), null);
  assert.equal(await readNftMeta("data:application/json,{broken", net({}).get), null);
});

// ---------------------------------------- The art route's choice of picture

test("the art route serves only NFTs in the log, by their key: anything else is no picture, and nothing is fetched for it", async () => {
  const id = hexIdOf(30);
  const s = stateWith([{ nftId: id, img: TEDDY }]);
  const n = net({});
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.string(), hexId, fc.stringMatching(/^[0-9a-f]{40}$/)), async (key) => {
      fc.pre(key !== artKey(id));
      assert.deepEqual(await serveArt(key, { state: s, get: n.get, shrink: null, nftUri: async () => ({ uri: "https://meta.example/x.json" }) }), { kind: "none" });
    }),
    { numRuns: 60 },
  );
  assert.deepEqual(n.asked, []);
  // The NFT id itself isn't a key either: a feed can't be matched to it that way.
  assert.deepEqual(await serveArt(id, { state: s, get: n.get, shrink: null }), { kind: "none" });
});

test("an ipfs.io link that a browser can't load: the route walks the gateways, rests one that says 429, and serves a real picture", async () => {
  const id = hexIdOf(31);
  const s = stateWith([{ nftId: id, img: TEDDY }]);
  const urls = IPFS_GATEWAYS.map((g) => `${g}${TEDDY_CID}/teddy1160.png`);
  const n = net({ [urls[0]]: got("switching to a service worker gateway", 403, "text/plain"), [urls[1]]: got("slow down", 429, "text/plain"), [urls[2]]: got(PNG) });
  const art = await serveArt(artKey(id), { state: s, get: n.get, shrink: null });
  assert.equal(art.kind, "picture");
  assert.equal(art.kind === "picture" && art.type, "image/png");
  assert.deepEqual(n.asked, urls.slice(0, 3));
  // Asked again within the minute, the gateway that said 429 is left alone.
  n.asked.length = 0;
  await serveArt(artKey(id), { state: s, get: n.get, shrink: null });
  assert.deepEqual(n.asked, [urls[0], urls[2]]);
});

test("a picture on its own host, like art.thejumpoff.xyz, is fetched as it is, and with sharp to hand comes back as a small webp", async () => {
  const id = hexIdOf(32);
  const s = stateWith([{ nftId: id, img: BETZY, collection: "Sexy Betzy" }]);
  const art = await serveArt(artKey(id), { state: s, get: net({ [BETZY]: got(PNG) }).get });
  assert.equal(art.kind, "picture");
  if (art.kind !== "picture") return;
  assert.equal(art.type, "image/webp");
  const meta = await sharp(art.body).metadata();
  assert.equal(meta.format, "webp");
  assert.ok((meta.width as number) <= 840);
});

test("what isn't a picture is never served: an HTML page called image/png, a picture too big to send, a host that never answers", async () => {
  const id = hexIdOf(1);
  const s = stateWith([{ nftId: id, img: BETZY }]);
  const html = await serveArt(artKey(id), { state: s, get: net({ [BETZY]: got("<html>error</html>", 200, "image/png") }).get, shrink: null });
  assert.deepEqual(html, { kind: "none" });
  const huge = Buffer.concat([PNG, Buffer.alloc(ART_OUT_MAX)]);
  assert.deepEqual(await serveArt(artKey(id), { state: s, get: net({ [BETZY]: got(huge) }).get, shrink: null }), { kind: "none" }, "too big to send as it is");
  assert.equal((await serveArt(artKey(id), { state: s, get: net({ [BETZY]: got(huge) }).get, shrink: async () => PNG })).kind, "picture", "fine once shrunk");
  assert.deepEqual(await serveArt(artKey(id), { state: s, get: net({}).get, shrink: null }), { kind: "none" }, "unreachable: the page shows no-picture");
});

test("no link of its own in the log (the placeholder, another NFT's sample): the route reads the NFT's metadata off the ledger and serves its picture", async () => {
  forgetMeta();
  const id = hexIdOf(2);
  const s = stateWith([{ nftId: id, img: "/assets/testnet-nft.webp" }]);
  const meta = "https://meta.example/2.json";
  const pic = "https://cdn.example/2.png";
  const n = net({ [meta]: got(JSON.stringify({ name: "Two", image: pic }), 200, "application/json"), [pic]: got(PNG) });
  const art = await serveArt(artKey(id), { state: s, get: n.get, shrink: null, nftUri: async () => ({ uri: meta }) });
  assert.equal(art.kind, "picture");
  assert.deepEqual(n.asked, [meta, pic]);
  // A saved copy short-cuts all of it.
  const saved = Object.keys(NFT_ART)[0];
  assert.deepEqual(await serveArt(artKey(saved), { state: stateWith([{ nftId: saved, img: "https://x.example/y.png" }]), get: net({}).get, shrink: null }), { kind: "saved", path: NFT_ART[saved].img });
});

function hexIdOf(n: number) {
  return `00081388${n.toString(16).toUpperCase().padStart(8, "0")}${"AB".repeat(24)}`;
}

// ---------------------------------------- Names from metadata

test("an NFT registered under an id-made name shows its metadata's name once read; one with no name keeps it; a failed read isn't asked again for an hour", async () => {
  forgetMeta();
  const named = hexIdOf(10);
  const nameless = hexIdOf(11);
  const broken = hexIdOf(12);
  const kept = hexIdOf(13);
  const s = stateWith([{ nftId: named, img: TEDDY }, { nftId: nameless, img: TEDDY }, { nftId: broken, img: TEDDY }, { nftId: kept, img: TEDDY, name: "Already Real" }]);
  assert.deepEqual(unnamedLots(s).sort(), [named, nameless, broken].sort(), "a real registered name needs no read");
  assert.deepEqual(unnamedLots(stateWith([{ nftId: named, img: TEDDY }], 1)), [], "testnet shows the log's names");
  const uris: Record<string, string> = { [named]: "https://meta.example/10.json", [nameless]: "https://meta.example/11.json" };
  const n = net({ "https://meta.example/10.json": got(JSON.stringify({ name: "Teddy1160 <script>", image: "ipfs://x/1.png" }), 200, "application/json"), "https://meta.example/11.json": got(JSON.stringify({ image: "ipfs://x/2.png" }), 200, "application/json") });
  let ledgerReads = 0;
  const nftUri = async (id: string) => (ledgerReads++, { uri: uris[id] ?? null });
  await learnNames(s, nftUri, { get: n.get });
  const title = (id: string) => prizeTitle([...s.lots.values()].find((l) => l.nftId === id)!, MAINNET_ID);
  assert.equal(title(named), "Teddy1160 script");
  assert.equal(title(nameless), fallbackName("Teddy BG", nameless));
  assert.equal(title(broken), fallbackName("Teddy BG", broken));
  assert.equal(title(kept), "Already Real");
  assert.equal(ledgerReads, 3);
  await learnNames(s, nftUri, { get: n.get });
  assert.equal(ledgerReads, 3, "read once; a failure waits an hour");
  assert.equal(await nftMeta(broken, nftUri, n.get, Date.now() + 61 * 60_000), null);
  assert.equal(ledgerReads, 4, "and is asked again after it");
});

test("reading names never holds a page up longer than its budget, and what comes back later is shown next time", async () => {
  forgetMeta();
  const id = hexIdOf(20);
  const s = stateWith([{ nftId: id, img: TEDDY }]);
  let release: () => void = () => {};
  const slow = async () => (await new Promise<void>((r) => (release = r)), { uri: "https://meta.example/20.json" });
  const started = Date.now();
  await learnNames(s, slow, { budgetMs: 50, get: net({ "https://meta.example/20.json": got(JSON.stringify({ name: "Late", image: "ipfs://x/3.png" }), 200, "application/json") }).get });
  assert.ok(Date.now() - started < 1000);
  assert.equal(prizeTitle([...s.lots.values()][0], MAINNET_ID), fallbackName("Teddy BG", id));
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(prizeTitle([...s.lots.values()][0], MAINNET_ID), "Late");
});

// ---------------------------------------- The route itself

test("by route: an unknown key or an NFT with no picture anywhere is a 404 the CDN keeps a few minutes, and the pool's own art addresses lead here", async () => {
  forgetMeta();
  const w = await world();
  await w.open(5, "4000000");
  const pool = (await w.call("GET", "/api/rip/pool/5")).body.pool as { bands: { nfts: { id: string; img: string }[] }[] };
  const nft = pool.bands.flatMap((b) => b.nfts)[0];
  assert.equal(nft.img, artProxy(nft.id));
  // The test ledger names no URI and the log's picture is a local file, so there's nothing to fetch: no network is touched.
  const r = await w.call("GET", nft.img);
  assert.equal(r.status, 404);
  assert.match(r.headers.get("cache-control") ?? "", /s-maxage=600/);
  for (const bad of ["nope", "A".repeat(64), "0".repeat(40)]) assert.equal((await w.call("GET", `/api/rip/art/${bad}`)).status, 404, bad);
  const off = await world({ off: true } as never);
  assert.equal((await off.call("GET", nft.img)).status, 404);
});
