import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXCLUDED_COLLECTIONS, NFT_LADDERS, NFT_PRICES, isDustBand, picksOf } from "../src/config/nft-packs.ts";
import { NFT_RATES } from "../src/lib/nft/bands.ts";
import { BAND_BPS } from "../src/lib/rip/draw.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const code = walk(join(root, "src")).filter((f) => /\.(ts|tsx|css)$/.test(f));
const snapshot = JSON.parse(readFileSync(join(root, "src/data/nft-snapshot.json"), "utf8"));

test("every pack has five bands with at least one collection, whole-XRP prices, and the rates the real draw uses", () => {
  assert.deepEqual(NFT_RATES.map((r) => r * 100), [...BAND_BPS]);
  for (const p of NFT_PRICES) {
    assert.equal(NFT_LADDERS[p].bands.length, NFT_RATES.length);
    for (const [i, band] of NFT_LADDERS[p].bands.entries()) {
      assert.ok(band.length > 0 || isDustBand(NFT_LADDERS[p], i), "a band holds NFTs or pays only dust");
      assert.equal(new Set(band).size, band.length, "a collection listed twice in a band");
    }
    assert.ok(Number.isInteger(NFT_LADDERS[p].xrp) && NFT_LADDERS[p].xrp > 0);
  }
});

test("no pack uses SEAL V1, and the ladder holds SEAL V2 and JC Rivera's Bear Champ", () => {
  const picks = NFT_PRICES.flatMap((p) => picksOf(NFT_LADDERS[p]));
  const all = NFT_PRICES.flatMap((p) => NFT_LADDERS[p].bands.flat());
  assert.deepEqual(EXCLUDED_COLLECTIONS, ["seals", "seal-scrolls"]);
  for (const bad of EXCLUDED_COLLECTIONS) assert.ok(!all.includes(bad));
  for (const need of ["seal-on-xrpl-cto", "bearchamp", "bearchampdaf", "bearchampgf"]) assert.ok(picks.includes(need), need);
  // Its NFTs can be burned by its issuer, so it never fronts a band.
  assert.ok(!picks.includes("flippypfp"));
});

test("every band's primary has real NFT art on disk and a real floor", () => {
  for (const p of NFT_PRICES) {
    for (const slug of picksOf(NFT_LADDERS[p])) {
      const c = snapshot.collections[slug];
      assert.ok(c, `${slug} is not in the snapshot: run pnpm snapshot:nfts`);
      assert.ok(c.floor > 0, `${slug} has no floor`);
      assert.ok(c.samples.length > 0, `${slug} has no art`);
      for (const s of c.samples) {
        assert.ok(String(s.img).startsWith(`/nfts/${slug}/`), s.img);
        assert.ok(existsSync(join(root, "public", s.img)), s.img);
      }
    }
  }
  assert.ok(snapshot.xrpUsd > 0);
});

test("signing and money routes live only in the rails folder, behind the flag: nothing else signs or sends", () => {
  const banned = /generatePack|submitTransaction|openPack|\/api\/buyback|from "xrpl"|sendTransaction|method: "submit"|submit: true|autofill: true/i;
  const rails = (f: string) => f.includes("/src/lib/rip/");
  // Asking a player's own wallet to sign and submit, in the browser, is the one send outside the rails. It can't touch a key or the pack API.
  const walletAsk = (f: string) => /\/src\/lib\/wallet\/joey-(extension|mobile)\.ts$/.test(f);
  for (const f of code) if (!rails(f)) assert.ok(!(walletAsk(f) ? /generatePack|openPack|\/api\/buyback|from "xrpl"|method: "submit"/i : banned).test(readFileSync(f, "utf8")), f);
  // One file holds keys. Only the gateway talks to the pack API's money routes.
  for (const f of code.filter(rails)) {
    const text = readFileSync(f, "utf8");
    if (/from "xrpl"/.test(text)) assert.ok(f.endsWith("/signer.ts"), f);
    if (/generatePack|submitTransaction|\/api\/buyback/.test(text)) assert.ok(f.endsWith("/cc-gateway.ts"), f);
  }
  // Wallet code signs in and nothing else: the only Xaman payload it can create is SignIn.
  const xaman = readFileSync(join(root, "src/lib/auth/xaman-client.ts"), "utf8");
  assert.deepEqual([...xaman.matchAll(/TransactionType: "(\w+)"/g)].map((m) => m[1]), ["SignIn"]);
  // Joey's fallback sign-in request is sign-only. Sends are the player's, in the wallet, and only `send.ts` makes them.
  const joey = readFileSync(join(root, "src/lib/wallet/joey-mobile.ts"), "utf8");
  assert.ok(/autofill: false, submit: false/.test(joey));
});

test("a client bundle can't reach a key: browser code never imports the signer, the factory or the server module", () => {
  for (const f of code.filter((x) => /\.tsx?$/.test(x))) {
    const text = readFileSync(f, "utf8");
    if (!/^"use client"/.test(text)) continue;
    assert.ok(!/lib\/rip\/(signer|factory|server|engine|cc-gateway|store)/.test(text), `${f} imports server rails`);
  }
});

test("copy rules: rarity rates only, no partner talk, US English", () => {
  for (const f of code) {
    if (f.includes("/data/")) continue;
    const text = readFileSync(f, "utf8");
    assert.ok(!/\bRTP\b|house edge|expected value/i.test(text), `${f}: says RTP or house edge`);
    assert.ok(!/collector crypt[^.\n]{0,40}partner|partner[^.\n]{0,40}collector crypt/i.test(text), `${f}: calls Collector Crypt a partner`);
    assert.ok(!/\b(colour|centre|licence|favour)\b/i.test(text), `${f}: not US English`);
  }
  // The card source's name and logo are gone from every page: see test/no-source-brand.test.ts.
});

test("the XRP coin carries the XRP Ledger Brand Kit's symbol, its path untouched, in the kit's black", () => {
  const coin = readFileSync(join(root, "public/assets/xrp-coin.svg"), "utf8");
  const symbol = "M135.007 43.7415C127.265 51.6966 117.426 56.0898 105.496 56.0898C93.5668 56.0898 83.7273 51.6966 75.9853 43.7415L34.1255 0H0.00763497L57.7784 57.7678C70.5469 70.5356 87.2893 78.6966 105.504 78.6966C123.718 78.6966 140.461 70.5356 153.229 57.7678L211 0H176.882L135.022 43.7415H135.007ZM176.874 180H210.992L153.222 122.232C140.453 109.464 123.711 101.303 105.496 101.303C87.2817 101.303 70.5393 109.464 57.7708 122.232L0 180H34.1179L75.9777 136.258C83.7196 128.303 93.5591 123.91 105.489 123.91C117.418 123.91 127.258 128.303 134.999 136.258L176.859 180H176.874Z";
  assert.ok(coin.includes(`<path d="${symbol}" fill="#141414"/>`));
  assert.ok(existsSync(join(root, "public/assets/prize-xrp.webp")));
});

test("sprites are never mirrored and idle characters never bob", () => {
  for (const f of code) {
    // The one allowed half-turn: the back photo of a two-sided card in the viewer, which the card's own turn brings round the right way.
    const text = readFileSync(f, "utf8").replace(".cvback{transform:rotateY(180deg)}", "");
    assert.ok(!/scaleX\(\s*-1|scale\(\s*-1|rotateY\(\s*180/.test(text), `${f}: mirrors a sprite`);
    assert.ok(!/@keyframes\s+\w*bob/i.test(text), `${f}: bobbing`);
  }
});

test("a real card's picture can load: Collector Crypt's image host is allowed", () => {
  const config = readFileSync(new URL("../next.config.mjs", import.meta.url), "utf8");
  assert.match(config, /hostname: "nft\.collectorcrypt\.com"/);
});
