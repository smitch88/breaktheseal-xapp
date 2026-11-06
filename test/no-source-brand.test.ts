import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { LEGAL_DOCUMENTS } from "../src/lib/legal/content.ts";
import { howCopy } from "../src/lib/legal/how.ts";
import { vaultName } from "../src/lib/catalog/parse.ts";
import { cardProofs, parseCardDetails, revealNext, soldTrail } from "../src/lib/live/proof.ts";

/**
 * The card source's API-key terms: no name and no logo of theirs anywhere in the product. The source and the public assets are
 * scanned, comments aside, since a comment never reaches a page. What may stay is plumbing a player never reads: the API and
 * image hosts on their subdomains, and the "collector-crypt" label the log was written with, which a replay has to match.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
}) : []);

/**
 * Their name as a page could show it. The joined spelling and `CC` are case-sensitive: hosts are lower case, identifiers start
 * lower case, and env names like SEAL_CC_ are joined by underscores.
 */
const names = (text: string) => /collector\s+crypt/i.test(text) || /\bCollectorCrypt\b|\bCC\b/.test(text);
/** Their storefront, as a link. `api.`, `gacha.` and `nft.` are hosts the server reads or images load from. */
const STOREFRONT = /(?<![\w.-])collectorcrypt\.com/i;
/** A logo file goes by their name, and a page uses one by that file name. */
const LOGO_FILE = /collector[\s_-]*crypt|(^|[/_-])cc[_-]?(logo|mark|badge)/i;
const LOGO_USE = /collector[\s_-]*crypt[\w-]*\.(svg|png|webp|jpe?g|gif|avif)|(^|[/_-])cc[_-]?(logo|mark|badge)/i;
const TEXT = /\.(tsx?|mjs|cjs|js|jsx|json|css|svg|html?|txt|md|webmanifest|xml)$/i;

/** Block and line comments out, string contents and line numbers kept: `https://` survives because `//` after a colon isn't a comment. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

test("no file in the app's source or public assets names the card source or carries its logo", () => {
  const files = [...walk(join(root, "src")), ...walk(join(root, "public"))];
  assert.ok(files.length > 100, "the scan found the app");
  const found: string[] = [];
  for (const f of files) {
    const rel = relative(root, f);
    if (LOGO_FILE.test(rel)) found.push(`${rel}: a logo file`);
    if (!TEXT.test(f)) continue;
    const raw = readFileSync(f, "utf8");
    const text = /\.(tsx?|mjs|cjs|jsx?|css)$/.test(f) ? code(raw) : raw;
    text.split("\n").forEach((line, i) => {
      if (names(line)) found.push(`${rel}:${i + 1}: names it`);
      if (STOREFRONT.test(line)) found.push(`${rel}:${i + 1}: links its site`);
      if (LOGO_USE.test(line)) found.push(`${rel}:${i + 1}: uses its logo`);
    });
  }
  assert.deepEqual(found, []);
});

test("the scan itself catches the name, the storefront and the logo, and lets the plumbing through", () => {
  assert.ok(names(code(`const a = "Kept in the vault of Collector Crypt";`)));
  assert.ok(names(code(`const a = "View on CC";`)));
  assert.ok(!names(code(`// Collector Crypt's own copy\nconst a = 1;`)));
  assert.ok(!names(code(`/** What Collector Crypt says */ const a = 1;`)));
  assert.ok(!names("SEAL_CC_RECIPIENT_TOKEN_ACCOUNTS"));
  assert.ok(!names(`label: "collector-crypt"`), "the log's own label is plumbing");
  assert.ok(STOREFRONT.test(code(`href="https://collectorcrypt.com/assets/solana/x"`)));
  for (const host of ["https://api.collectorcrypt.com/marketplace", "https://gacha.collectorcrypt.com", "https://nft.collectorcrypt.com/front/x"]) assert.ok(!STOREFRONT.test(code(`"${host}"`)), host);
  assert.ok(LOGO_FILE.test("public/assets/collector-crypt-logo.svg"));
  assert.ok(LOGO_FILE.test("public/assets/cc-logo.png"));
  assert.ok(!LOGO_FILE.test("public/nfts/xrpmf/ccb2a14a051f154a.webp"));
  assert.ok(LOGO_USE.test(`<img src="/assets/collector-crypt-logo.svg" />`));
  assert.ok(LOGO_USE.test(`src="/assets/cc-logo.png"`));
  assert.ok(!LOGO_USE.test(`if (c.gateway !== "collector-crypt") return null;`), "the label isn't a logo");
});

test("every player-facing word about a card's custody stays generic", () => {
  const legal = JSON.stringify(LEGAL_DOCUMENTS);
  assert.ok(!names(legal));
  assert.match(legal, /third-party graded card vault/);
  assert.doesNotMatch(legal, /partner/i, "the vault is never called a partner");
  for (const mode of ["mainnet", "testnet", "demo"] as const) for (const cards of [true, false]) for (const seal of [true, false]) assert.ok(!names(JSON.stringify(howCopy(mode, cards, seal))));
  assert.equal(revealNext({ kind: "card" }, null), "Yours, held in a graded card vault.");
});

test("a card's links go to the ledgers, never the vault's site, whatever the card", () => {
  const mint = fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  fc.assert(fc.property(mint, fc.constantFrom("vault", "simulated"), fc.constantFrom("mainnet" as const, "testnet" as const), fc.boolean(), (m, source, mode, sold) => {
    const card = {
      id: "c", kind: "card", code: "x", packName: "p", usd: 25, xrp: 20, status: "held", hold: sold ? "sold" : "stashed", source,
      card: { mint: m, name: "Zekrom", img: "https://x/y", grade: "PSA 9", insuredUsd: 25, rarity: "Common", proof: "d2", proofSlot: 1, proofAt: null },
      sourceTx: source === "vault" ? "5sig" : null, mirror: null, exit: sold ? { kind: "sell", drops: "1000000" } : null, sellTx: sold ? "AB" : null, shipRef: null, paymentTx: "PAY", lastLedger: 1,
    } as never;
    const rows = [...cardProofs(card, mode), ...soldTrail({ nft: null, card, mode })];
    for (const r of rows) {
      assert.ok(!r.href || !/collectorcrypt/i.test(r.href), r.href ?? "");
      assert.ok(!names(`${r.label} ${r.text}`), r.text);
    }
    const where = rows.find((r) => r.key === "card");
    if (source === "vault") assert.equal(where?.text, "View card");
    else assert.equal(where, undefined, "a simulated card has no real record to open");
  }));
});

test("a vault named after the card source is left out of a card's details, and any other vault reads as given", () => {
  assert.equal(vaultName("Collector Crypt Vault"), undefined);
  assert.equal(vaultName("collector  crypt"), undefined);
  assert.equal(vaultName("Wristcheck"), "Wristcheck");
  assert.equal(vaultName(null), undefined);
  const MINT = "2rDAEoeZCGWULRuZfpCEYf7Ycx5aQwF3gX2NBENHWWnW";
  const row = (vault: string) => ({ filterNFtCard: [{ nftAddress: MINT, itemName: "Zekrom", vault }] });
  assert.equal(parseCardDetails(row("Collector Crypt"), MINT)?.vault, null);
  assert.equal(parseCardDetails(row("OmniVault"), MINT)?.vault, "OmniVault");
  fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
    const v = vaultName(`${a}Collector Crypt${b}`);
    assert.equal(v, undefined);
  }));
});
