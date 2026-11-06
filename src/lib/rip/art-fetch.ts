import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { mediaUrls } from "../nft/media.ts";

/**
 * Fetching NFT art and metadata for the server. Every URL here came from an NFT's metadata, which anyone can mint, so nothing is fetched
 * unless it is https on port 443 to a public name, every address that name resolves to is public (checked as the socket connects, so a
 * second answer can't point it inside), each redirect is checked the same way, and the body stays under a size limit and a deadline.
 */

/** Why this URL is never fetched, or null when it may be. */
export function artUrlRefusal(raw: string): string | null {
  if (raw.length > 2048) return "too long";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "not https";
  if (u.username || u.password) return "carries a login";
  if (u.port && u.port !== "443") return "not port 443";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) return "an address, not a name";
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|arpa|test|invalid)$/.test(host)) return "not a public name";
  return null;
}

function v4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number);
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b < 128) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b < 32) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Eight 16-bit groups, or null. Takes "::" and a dotted IPv4 tail. */
function v6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const q = v4(tail[1]);
    if (!q) return null;
    s = s.slice(0, -tail[1].length) + `${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  return [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
}

/** Is this an address on the public internet? Private, loopback, link-local, carrier, multicast, documentation and reserved ranges aren't, nor IPv6 that wraps one. */
export function isPublicAddress(ip: string): boolean {
  const a = v4(ip);
  if (a) return publicV4(a);
  const g = v6(ip);
  if (!g) return false;
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(embedded);
  // Only global unicast, less the blocks that carry or document something else: 2001::/23 (Teredo and friends), 2001:db8::/32, 2002::/16 (6to4).
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] < 0x200 || g[1] === 0xdb8)) return false;
  if (g[0] === 0x2002) return false;
  return true;
}

type Resolve = (host: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup for the socket itself that refuses a name with any non-public address. The check is on the address the socket connects to. */
export function guardedLookup(resolve: Resolve = dnsLookup as unknown as Resolve) {
  return (host: string, opts: { all?: boolean } | number | undefined, cb: LookupCb) => {
    resolve(host, { all: true }, (err, addresses) => {
      if (err) return cb(err, []);
      if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) return cb(Object.assign(new Error(`${host} resolves to an address that isn't public`), { code: "ENOTPUBLIC" }), []);
      if (typeof opts === "object" && opts?.all) return cb(null, addresses);
      cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface Got {
  readonly status: number;
  readonly type: string;
  readonly body: Buffer;
}
export interface GetOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}
export type ArtGet = (url: string, opts?: GetOptions) => Promise<Got | null>;

const MAX_HOPS = 3;

function once(url: string, maxBytes: number, timeoutMs: number): Promise<(Got & { location?: string }) | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: (Got & { location?: string }) | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(v);
    };
    const req = request(url, { method: "GET", agent: false, lookup: guardedLookup() as never, timeout: timeoutMs, headers: { "user-agent": "seal-rips/0.1", accept: "image/*,application/json;q=0.9,*/*;q=0.5" } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        return finish({ status, type: "", body: Buffer.alloc(0), location });
      }
      if (status !== 200 || Number(res.headers["content-length"] ?? 0) > maxBytes) {
        req.destroy();
        return finish({ status: status === 200 ? 413 : status, type: "", body: Buffer.alloc(0) });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          finish({ status: 413, type: "", body: Buffer.alloc(0) });
        } else chunks.push(c);
      });
      res.on("end", () => finish({ status, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
      res.on("error", () => finish(null));
    });
    // A whole-request deadline: a server that sends a byte a second can't hold it open.
    const deadline = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeoutMs);
    req.on("timeout", () => req.destroy());
    req.on("error", () => finish(null));
    req.end();
  });
}

/** One GET under every rule above. Null when it was refused or never answered; otherwise the status and, for a 200, the body. */
export const safeGet: ArtGet = async (url, opts = {}) => {
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const timeoutMs = opts.timeoutMs ?? 8000;
  let at = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (artUrlRefusal(at)) return null;
    const got = await once(at, maxBytes, timeoutMs);
    if (!got?.location) return got;
    try {
      at = new URL(got.location, at).href;
    } catch {
      return null;
    }
  }
  return null;
};

/** The same, shaped like fetch, for code that takes a fetch. A refusal reads as a network error. */
export function safeFetch(get: ArtGet = safeGet, opts: GetOptions = { maxBytes: 12 * 1024 * 1024 }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const got = await get(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, opts);
    if (!got) throw new TypeError("fetch refused or failed");
    return new Response(got.status === 200 ? new Uint8Array(got.body) : null, { status: got.status >= 200 && got.status <= 599 ? got.status : 502, headers: got.type ? { "content-type": got.type } : {} });
  }) as typeof fetch;
}

/** What a picture really is, read from its first bytes, whatever its server called it. Null for anything that isn't one of these. */
export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/svg+xml" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  const text = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return "image/svg+xml";
  return null;
}

export interface NftMeta {
  readonly name: string | null;
  readonly media: string;
}

/** An NFT's metadata from its on-ledger URI: the picture it names and its name. A URI that points straight at a picture is its own media, with no name. */
export async function readNftMeta(uri: string, get: ArtGet = safeGet): Promise<NftMeta | null> {
  const pick = (meta: Record<string, unknown>): NftMeta | null => {
    const media = [meta.image, meta.image_url, meta.imageUrl].find((m): m is string => typeof m === "string" && !!m.trim());
    return media ? { media: media.trim(), name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : null } : null;
  };
  const inline = /^data:application\/json[^,]*,(.*)$/s.exec(uri);
  if (inline) {
    try {
      return pick(JSON.parse(decodeURIComponent(inline[1])));
    } catch {
      return null;
    }
  }
  for (const url of mediaUrls(uri)) {
    const got = await get(url, { maxBytes: 512 * 1024, timeoutMs: 6000 });
    if (got?.status !== 200) continue;
    if (sniffImage(got.body)) return { media: uri, name: null };
    try {
      const meta = pick(JSON.parse(got.body.toString("utf8")));
      if (meta) return meta;
    } catch {
      // The next gateway may answer with the real thing.
    }
  }
  return null;
}
