import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { REFUND_REASONS, afterLook, cardAward, pullComesBack, cardStatusLabel, nextHoldings, nftAward, nftStatusLabel, parseLiveId, xrpShort, xrpText } from "../src/lib/live/client.ts";

const src = new URL("../src/", import.meta.url).pathname;
const source = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? source(p) : /\.tsx?$/.test(n) ? [readFileSync(p, "utf8")] : [];
  });

test("every refund reason the engine can write has words a player can read", () => {
  const engine = readFileSync(join(src, "lib/rip/engine.ts"), "utf8");
  const reasons = new Set<string>();
  for (const m of engine.matchAll(/(?:refund|back)\(\s*"([a-z_]+)"\s*\)/g)) reasons.add(m[1]);
  for (const m of engine.matchAll(/refund\(c,\s*"([a-z_]+)"\)/g)) reasons.add(m[1]);
  for (const m of engine.matchAll(/reason: "([a-z_]+)", to:/g)) reasons.add(m[1]);
  assert.ok(reasons.size >= 8, [...reasons].join());
  for (const r of reasons) assert.ok(REFUND_REASONS[r], `no words for ${r}`);
});

test("every order state reads as something a player understands", () => {
  const statuses = ["quoted", "paid", "drawn", "expired", "refund_due", "refunded"] as const;
  const pulls = ["stashed", "selling", "sold", "offering", "offered", "claimed", "cancelling", null] as const;
  for (const status of statuses) for (const pull of pulls) assert.match(nftStatusLabel({ status, pull }), /^[A-Z][a-z ]+[a-z]$/, `${status}/${pull}`);
  assert.equal(nftStatusLabel({ status: "drawn", pull: "stashed" }), "In your stash");
  assert.equal(nftStatusLabel({ status: "refund_due", pull: null }), "Refund on its way");
});

test("every card state reads as something a player understands, and a person's review never reads as an error", () => {
  const statuses = ["quoted", "expired", "paid", "generating", "generated", "signed", "source_paid", "opened", "held", "review", "refund_due", "refunded"] as const;
  const holds = ["stashed", "minting", "offered", "mirrored", "exit_burn", "exit_source", "selling", "sold", "ship_queue", "shipped", null] as const;
  for (const status of statuses) for (const hold of holds) for (const exit of [null, { kind: "sell" as const, drops: "1" }, { kind: "ship" as const, drops: null }]) assert.match(cardStatusLabel({ status, hold, exit }), /^[A-Z][A-Za-z ]+[A-Za-z]$/);
  assert.equal(cardStatusLabel({ status: "review", hold: "stashed", exit: null }), "Checking");
  assert.equal(cardStatusLabel({ status: "held", hold: "exit_burn", exit: { kind: "ship", drops: null } }), "Shipping");
  assert.equal(cardStatusLabel({ status: "held", hold: "exit_burn", exit: { kind: "sell", drops: "1" } }), "Selling");
});

test("a page id is a real pull only with its prefix, and any id is encoded for the API", () => {
  assert.equal(parseLiveId("order_abc"), null);
  assert.equal(parseLiveId("abc"), null);
  assert.deepEqual(parseLiveId("rip_abc"), { kind: "nft", id: "abc", api: "/api/rip/orders/abc" });
  assert.deepEqual(parseLiveId("card_abc"), { kind: "card", id: "abc", api: "/api/rip/cards/abc" });
  fc.assert(
    fc.property(fc.string(), (s) => {
      const ref = parseLiveId(`rip_${s}`);
      assert.ok(ref);
      assert.ok(!ref.api.slice("/api/rip/orders/".length).includes("/"));
    }),
  );
});

test("XRP figures round the way a wallet would show them", () => {
  assert.equal(xrpText(4), "4");
  assert.equal(xrpText(2.55), "2.55");
  assert.equal(xrpText(1234.5678), "1234.57");
  assert.equal(xrpShort(9.070221), "9.07");
  fc.assert(fc.property(fc.double({ min: 0.000001, max: 1e6, noNaN: true }), (x) => !Number.isNaN(Number(xrpText(x)))));
});

test("an award is shown only once the server has named the prize", () => {
  const base = { nft: null, tier: null, sellXrp: null } as never;
  assert.equal(nftAward(base, 1.25), null);
  assert.equal(cardAward({ card: null } as never), null);
  const won = nftAward({ nft: { id: "x", name: "n", collection: "c", img: "/x.webp", markXrp: 3 }, tier: "Rare", sellXrp: 2.55 } as never, 2);
  assert.equal(won?.value, 6);
  assert.equal(won?.sell, 5.1);
  assert.equal(won?.provenance, "server");
  assert.equal(cardAward({ card: { rarity: "unknown thing", name: "c", img: "/i", insuredUsd: 9, grade: "g", mint: "m" } } as never)?.tier, "Common");
});

test("a failed poll keeps what the collection already shows: a blip can't make someone's items vanish", () => {
  const nfts = [{ id: "a" }] as never[];
  const cards = [{ id: "b" }] as never[];
  const first = nextHoldings({ nfts: [], cards: [], loaded: false }, { ok: true, status: 200, body: { orders: nfts } } as never, { ok: true, status: 200, body: { cards } } as never);
  assert.deepEqual(first, { nfts, cards, loaded: true });
  const failed = { ok: false, status: 429, body: {} } as never;
  assert.deepEqual(nextHoldings(first, failed, failed), first);
  assert.deepEqual(nextHoldings(first, { ok: true, status: 200, body: { orders: [] } } as never, failed), { nfts: [], cards, loaded: true });
  // Signed out on the server: the wallet's items aren't this browser's to show anymore.
  const out = { ok: false, status: 401, body: {} } as never;
  assert.deepEqual(nextHoldings(first, out, out), { nfts: [], cards: [], loaded: true });
});

test("copy rules hold on every live screen: no RTP or house edge, stash, ship and sell, Collector Crypt never a partner", () => {
  const text = source(join(src, "components/live")).concat(source(join(src, "app/api"))).join("\n");
  for (const banned of [/\bRTP\b/, /house edge/i, /return to player/i, /partner/i, /\bcolour\b/i, /\bcentre\b/i, /\blicence\b/i]) assert.ok(!banned.test(text), String(banned));
});

test("a wrong payment is told once and leaves the checkout usable: the player can pay the order they still have", () => {
  const told = new Set<string>();
  assert.equal(afterLook("quoted", null, told), "wait");
  assert.equal(afterLook("quoted", "wrong_amount", told), "refund");
  told.add("wrong_amount");
  assert.equal(afterLook("quoted", "wrong_amount", told), "wait");
  assert.equal(afterLook("quoted", "wrong_wallet", told), "refund");
  assert.equal(afterLook("expired", "wrong_amount", told), "ended");
  assert.equal(afterLook("expired", "late", told), "refund");
  assert.equal(afterLook("expired", null, new Set()), "ended");
});

test("a pull that was paid and drawn plays its stage, even with a stray payment's refund on the same order", () => {
  const refund = { reason: "already_paid" } as never;
  assert.equal(pullComesBack({ status: "drawn", refund }), false);
  assert.equal(pullComesBack({ status: "paid", refund }), false);
  assert.equal(pullComesBack({ status: "expired", refund }), true);
  assert.equal(pullComesBack({ status: "quoted", refund }), true);
  assert.equal(pullComesBack({ status: "refund_due", refund: null }), true);
  assert.equal(pullComesBack({ status: "refunded", refund: null }), true);
  assert.equal(pullComesBack({ status: "drawn", refund: null }), false);
});
