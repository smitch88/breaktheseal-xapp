import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { encodeAccountID, isValidClassicAddress } from "ripple-address-codec";
import { parseToml } from "./support-toml.ts";

const FILE = new URL("../public/.well-known/xrp-ledger.toml", import.meta.url);

// The four house accounts and the names the owner's Bithomp page uses (pinned: an edit to either fails here).
const EXPECTED = [
  ["rLixKPQ3jGk4yYhAt3ybAwdrC8tvTLLvG", "Break the Seal treasury: pack payments and sales payouts"],
  ["rPdknMvaDqzSxUpH5bvNbbxNWNk2kHNvTX", "Break the Seal vault: holds the NFTs in packs"],
  ["rMQk9e6x9jwi5wTvz1vW3hLC6JRcpL854K", "Break the Seal minter: mints card NFTs and creates offers"],
  ["rpMMt3bVhnkEC9AFQMNmYyiKRFvySt4QWT", "Break the Seal NFT issuer: the issuer on Break the Seal card NFTs"],
];

test("public/.well-known/xrp-ledger.toml parses and lists exactly the house accounts, on mainnet, and nothing else", () => {
  const t = parseToml(readFileSync(FILE, "utf8"));
  assert.deepEqual(Object.keys(t).sort(), ["ACCOUNTS", "METADATA"], "no PRINCIPALS, ISSUERS, TOKENS or anything else");
  const meta = t.METADATA as Record<string, unknown>;
  assert.deepEqual(Object.keys(meta), ["modified"]);
  assert.ok(meta.modified instanceof Date && meta.modified.getTime() <= Date.now(), "modified is a date-time, not in the future");
  const accounts = t.ACCOUNTS as Record<string, unknown>[];
  assert.deepEqual(accounts, EXPECTED.map(([address, desc]) => ({ address, network: "main", desc })));
  for (const a of accounts) assert.ok(isValidClassicAddress(String(a.address)), String(a.address));
});

test("the TOML is served to any origin as text", async () => {
  const config = (await import("../next.config.mjs")).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
  const rule = (await config.headers()).find((r) => r.source === "/.well-known/xrp-ledger.toml");
  const h = Object.fromEntries((rule?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
  assert.equal(h["access-control-allow-origin"], "*");
  assert.match(h["content-type"] ?? "", /^text\/plain/);
});

const plain = [...Array(95)].map((_, i) => String.fromCharCode(32 + i)).filter((c) => c !== '"' && c !== "\\");
test("property: the parser reads back any accounts list written in this file's shape", () => {
  const account = fc.record({ address: fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => encodeAccountID(Buffer.from(b))), desc: fc.stringOf(fc.constantFrom(...plain), { minLength: 1, maxLength: 80 }) });
  fc.assert(fc.property(fc.array(account, { maxLength: 6 }), (list) => {
    const text = ["[METADATA]", "modified = 2026-11-05T13:45:00.000Z", ...list.flatMap((a) => ["", "[[ACCOUNTS]]", `address = "${a.address}"`, 'network = "main"', `desc = "${a.desc}"`])].join("\n");
    const t = parseToml(text);
    assert.deepEqual(t.ACCOUNTS ?? [], list.map((a) => ({ address: a.address, network: "main", desc: a.desc })));
  }), { numRuns: 200 });
});
