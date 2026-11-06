import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DRAW_VERSION, invoiceOf } from "../src/lib/rip/draw.ts";
import { MEMO_TYPE } from "../src/lib/auth/xrpl.ts";
import { JOEY_STATEMENT } from "../src/lib/auth/joey-proof.ts";
import { howCopy } from "../src/lib/legal/how.ts";
import { LEGAL_DOCUMENTS, PRIVACY } from "../src/lib/legal/content.ts";
import { MAINNET_CONFIRMATION } from "../src/lib/rip/mode.ts";
import { acceptInstruction, payInstruction } from "../src/lib/rip/instructions.ts";
import { PLACE_REFUSAL } from "../src/lib/rip/places.ts";
import { SHIP_MEMO_TYPE, shipInstruction, shipMemoText } from "../src/lib/rip/ship.ts";
import { sha256Hex } from "../src/lib/rip/draw.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const OLD_NAME = /seal[\s_-]?rips/gi;

/**
 * The old spelling that stays, each for a reason. Memo types, cache keys and the draw version are on the ledger or in stored
 * data, the confirmation is compared with the live deploy's env, and the ship memo is rebuilt byte for byte to check old logs.
 */
const STAYS: readonly RegExp[] = [
  /seal-rips\/[a-z0-9.-]+/g, // memo types, the UA string, and the build info path
  /seal-rips-[a-z0-9-]+/g, // the draw version, invoice and season hash inputs, cache namespaces, the demo storage key
  /seal-rips:/g, // server log lines
  /the seal rips the pack open/g, // a sentence, not the name
  /the owner turned on real XRP for SEAL Rips/g,
  /Approving ships a SEAL Rips card out of custody/g,
  /@bearish-af\/seal-rips/g,
];

const leftovers = (text: string) => {
  const rest = STAYS.reduce((t, re) => t.replace(re, ""), text);
  return rest.match(OLD_NAME) ?? [];
};

test("nothing a person can read says the old name: every source file, once the identifiers that must stay are set aside", () => {
  const files = walk(join(root, "src")).filter((f) => /\.(ts|tsx|css)$/.test(f) && !f.includes("/src/data/"));
  assert.ok(files.length > 100);
  for (const f of files) assert.deepEqual(leftovers(readFileSync(f, "utf8")), [], relative(root, f));
  for (const f of ["package.json"]) assert.deepEqual(leftovers(JSON.parse(readFileSync(join(root, f), "utf8")).description), [], f);
});

test("the words a player reads name Break the Seal", () => {
  for (const doc of LEGAL_DOCUMENTS) assert.deepEqual(leftovers(JSON.stringify(doc).replace("`seal-rips-demo-v1`", "")), [], doc.path);
  const about = howCopy("mainnet", true, true).about;
  assert.match(about, /^Break the Seal is/);
  assert.match(JOEY_STATEMENT, /^Sign in to Break the Seal\./);
  assert.match(PLACE_REFUSAL, /^Break the Seal isn't available/);
  assert.match(shipInstruction({ name: "Pat", street: "1 Main", city: "X", zip: "1" }), /your Break the Seal card/);
  assert.match(readFileSync(join(root, "src/lib/auth/xaman-client.ts"), "utf8"), /instruction: "Sign in to Break the Seal\. This moves no funds\."/);
  assert.match(readFileSync(join(root, "src/lib/auth/xapp-client.ts"), "utf8"), /instruction: "[^"]*Break the Seal/);
  assert.match(payInstruction("1000000", "nft", "mainnet"), /to Break the Seal/);
  assert.match(acceptInstruction("nft", "mainnet"), /from Break the Seal/);
  assert.match(readFileSync(join(root, "src/app/api/mirror/[id]/route.ts"), "utf8"), /collection: \{ name: "Break the Seal Cards", family: "Break the Seal" \}/);
  assert.match(readFileSync(join(root, "src/components/Footer.tsx"), "utf8"), /© 2026 Break the Seal\./);
  assert.match(readFileSync(join(root, "src/lib/site.ts"), "utf8"), /name: "Seal on XRP"/);
});

test("what's on the ledger and in the live env is unchanged, so old logs still verify and real money stays on", () => {
  assert.equal(DRAW_VERSION, "seal-rips-draw-v1");
  assert.equal(invoiceOf("x"), sha256Hex("seal-rips-invoice|x").toUpperCase());
  assert.equal(SHIP_MEMO_TYPE, "seal-rips/ship");
  assert.equal(Buffer.from(MEMO_TYPE, "hex").toString("utf8"), "seal-rips/sign-in");
  assert.equal(MAINNET_CONFIRMATION, "the owner turned on real XRP for SEAL Rips");
  assert.equal(shipMemoText("c", "h"), "This isn't a sign-in. Approving ships a SEAL Rips card out of custody. Decline unless you asked for it. card c address h");
  const engine = readFileSync(join(root, "src/lib/rip/engine.ts"), "utf8");
  for (const t of ["seal-rips/pack", "seal-rips/card-pack", "seal-rips/redeem", "seal-rips/sell", "seal-rips/card-sell", "seal-rips/commit", "seal-rips/pool", "seal-rips/refund", "seal-rips/retire"]) assert.ok(engine.includes(`"${t}"`), t);
  assert.match(readFileSync(join(root, "src/lib/rip/engine.ts"), "utf8"), /seal-rips-season\|/);
});

test("Privacy names no infrastructure vendor, and still says what's collected and who it goes to", () => {
  const all = LEGAL_DOCUMENTS.map((d) => JSON.stringify(d)).join("\n");
  assert.doesNotMatch(all, /\b(neon|vercel|railway|postgres\w*|alchemy|helius|quicknode|upstash|redis|supabase|aws|cloudflare|cloudfront)\b/i);
  assert.doesNotMatch(JSON.stringify(PRIVACY), /\bdatabase\b/i);
  const privacy = JSON.stringify(PRIVACY);
  for (const must of ["service providers that host the site", "Xaman", "Joey", "card vault", "carrier", "Your wallet address", "Shipping details", "Your internet address", "our web host"]) assert.ok(privacy.includes(must), must);
});

test("changing the terms' words can't touch an open order: their fingerprint is only ever written down, never compared", () => {
  const files = walk(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("/src/data/"));
  const users = files.filter((f) => readFileSync(f, "utf8").includes("TERMS_VERSION")).map((f) => relative(root, f)).sort();
  assert.deepEqual(users, ["src/lib/legal/content.ts", "src/lib/rip/server.ts"]);
  const server = readFileSync(join(root, "src/lib/rip/server.ts"), "utf8");
  assert.equal(server.match(/TERMS_VERSION/g)?.length, 2, "its import and the one record it goes in");
  assert.doesNotMatch(server, /\.version\b/, "nothing reads a stored version back");
});
