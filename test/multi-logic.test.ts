import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { QTY_PRESETS, cashOutLabel, cashOutTotal, checkoutQty, clampQty, outcomeOf, outcomeText, parseQty, payoutText, presetsFor, rarestFirst, roomNote, sellLine, sellTotal } from "../src/lib/live/multi.ts";
import { holdsCheckout } from "../src/lib/live/restock.ts";
import { TIER_NAMES } from "../src/lib/tiers.ts";

test("a quantity from a link or a tap is always a whole number from 1 to what's allowed", () => {
  fc.assert(fc.property(fc.double(), fc.integer({ min: -5, max: 30 }), (q, max) => {
    const n = clampQty(q, max);
    return Number.isInteger(n) && n >= 1 && n <= Math.max(1, max);
  }));
  for (const bad of [null, undefined, "", "0", "-1", "1.5", "abc", "100", "1e1", " 3"]) assert.equal(parseQty(bad), 1, String(bad));
  assert.equal(parseQty("20"), 20);
});

test("an open order keeps its own size at checkout, whatever the room has fallen to", () => {
  assert.equal(checkoutQty({ made: 3, held: null, on: true, wanted: 5, max: 1 }), 3);
  assert.equal(checkoutQty({ made: null, held: 3, on: true, wanted: 1, max: 1 }), 3, "room is 1 and the order holds 3");
  assert.equal(checkoutQty({ made: null, held: 3, on: true, wanted: 1, max: 0 }), 3, "a closed pack still lets it be paid");
  assert.equal(checkoutQty({ made: null, held: null, on: true, wanted: 5, max: 3 }), 3);
  assert.equal(checkoutQty({ made: null, held: null, on: false, wanted: 5, max: 3 }), 1, "off is one");
  assert.equal(checkoutQty({ made: null, held: null, on: true, wanted: 2, max: null }), 1, "unknown room is one");
});

test("presets never pass the env's cap, and 1 is always there", () => {
  assert.deepEqual([...QTY_PRESETS], [1, 3, 5, 10, 20]);
  assert.deepEqual(presetsFor(3), [1, 3]);
  assert.deepEqual(presetsFor(20), [1, 3, 5, 10, 20]);
  assert.deepEqual(presetsFor(0), [1]);
  assert.deepEqual(presetsFor(10), [1, 3, 5, 10], "the owner's planned cap of 10");
  fc.assert(fc.property(fc.integer({ min: -3, max: 40 }), (cap) => {
    const p = presetsFor(cap);
    assert.equal(p[0], 1);
    assert.ok(p.every((n, i) => n <= Math.max(1, cap) && (i === 0 || n > p[i - 1])));
  }));
});

test("a picker that stops short of the cap says why in plain words, and one that doesn't says nothing", () => {
  fc.assert(fc.property(fc.option(fc.integer({ min: -2, max: 25 }), { nil: null }), fc.integer({ min: 1, max: 20 }), (max, cap) => {
    const note = roomNote(max, cap);
    if (max === null || max < 1 || max >= cap) return assert.equal(note, null);
    assert.ok(note);
    assert.match(note, max === 1 ? /^Only 1 pack fits/ : new RegExp(`^Up to ${max} packs fit`));
    assert.match(note, /NFTs left in this pack/);
    assert.match(note, /XRP set aside/);
  }));
});

test("each pull's sell line is the server's quote: NFTs sell, XRP prizes send, anything moved on shows none", () => {
  assert.deepEqual(sellLine({ pull: "stashed", sellXrp: 3.2, prize: null }), { label: "Sells back for", value: "3.20 XRP", line: "Sells back for 3.20 XRP" });
  assert.deepEqual(sellLine({ pull: "stashed", sellXrp: null, prize: { token: "XRP", valueXrp: 4 } }), { label: "Cash out to your wallet", value: "4 XRP", line: "Cash out: 4 XRP to your wallet" });
  assert.equal(sellLine({ pull: "stashed", sellXrp: null, prize: { token: "SEAL", valueXrp: 4 } }), null);
  assert.equal(sellLine({ pull: "sold", sellXrp: 3.2, prize: null }), null);
  assert.equal(sellLine({ pull: "stashed", sellXrp: 0, prize: null }), null);
  const rowArb = fc.record({ pull: fc.constantFrom("stashed", "sold", "selling", "claimed", null), sellXrp: fc.option(fc.double({ min: 0, max: 500, noNaN: true }), { nil: null }), prize: fc.option(fc.record({ token: fc.constantFrom("XRP", "SEAL"), valueXrp: fc.double({ min: 0, max: 50, noNaN: true }) }), { nil: null }) });
  fc.assert(fc.property(fc.array(rowArb, { maxLength: 20 }), (rows) => {
    const sum = rows.reduce((a, o) => (o.pull === "stashed" && !o.prize && o.sellXrp !== null && o.sellXrp > 0 ? a + o.sellXrp : a), 0);
    const total = sellTotal(rows);
    if (Math.round(sum * 1e6) <= 0) assert.equal(total, null);
    else assert.ok(total?.endsWith(" XRP"));
    for (const o of rows) if (o.pull !== "stashed") assert.equal(sellLine(o), null);
  }));
});

const cashRow = fc.record({ pull: fc.constantFrom("stashed", "sold", "selling", "claimed", "redeemed", null), sellXrp: fc.option(fc.integer({ min: 0, max: 500_000_000 }).map((d) => d / 1e6), { nil: null }), prize: fc.option(fc.record({ token: fc.constantFrom("XRP", "SEAL"), valueXrp: fc.integer({ min: 1, max: 50_000_000 }).map((d) => d / 1e6) }), { nil: null }) });

test("cash out, property: the total is every stashed XRP prize plus every stashed NFT's sell-back quote, in exact drops, and nothing else", () => {
  fc.assert(fc.property(fc.array(cashRow, { maxLength: 20 }), (rows) => {
    const t = cashOutTotal(rows);
    const stashed = rows.filter((o) => o.pull === "stashed");
    assert.equal(t.count, stashed.length);
    const drops = stashed.reduce((a, o) => a + BigInt(Math.round((o.prize ? (o.prize.token === "XRP" ? o.prize.valueXrp : 0) : (o.sellXrp ?? 0)) * 1e6)), 0n);
    assert.equal(BigInt(Math.round(t.xrp * 1e6)), drops);
    // A token prize or an NFT with no quote means the sheet prices it: no figure on the button, never a wrong one.
    const unknown = stashed.some((o) => (o.prize ? o.prize.token !== "XRP" : !(o.sellXrp !== null && o.sellXrp > 0)));
    assert.equal(t.priced, !unknown);
    const label = cashOutLabel(t, true);
    if (t.priced && t.xrp > 0) assert.match(label, /^Cash out all · \d+(\.\d\d)? XRP$/);
    else assert.equal(label, "Cash out all");
  }));
});

test("cash out: whatever moved on (sold, being sold, claimed, redeemed) is never in the total", () => {
  fc.assert(fc.property(fc.array(cashRow, { maxLength: 20 }), (rows) => {
    const gone = rows.map((o) => (o.pull === "stashed" ? { ...o, pull: "sold" } : o));
    assert.deepEqual(cashOutTotal(gone), { xrp: 0, count: 0, priced: true });
  }));
  assert.equal(cashOutLabel({ xrp: 10.897115, count: 2, priced: true }, false), "Cash out 2 · 10.90 XRP");
  assert.equal(cashOutLabel({ xrp: 8, count: 1, priced: true }, true), "Cash out all · 8 XRP");
});

test("rarest first, and the sort loses nothing and gives the same order every time", () => {
  const row = fc.record({ id: fc.uuid(), award: fc.record({ tier: fc.constantFrom(...TIER_NAMES), value: fc.double({ min: 0, max: 1000, noNaN: true }) }) });
  fc.assert(fc.property(fc.uniqueArray(row, { selector: (r) => r.id, maxLength: 20 }), (rows) => {
    const sorted = rarestFirst(rows);
    assert.equal(sorted.length, rows.length);
    assert.deepEqual(new Set(sorted.map((r) => r.id)), new Set(rows.map((r) => r.id)));
    assert.deepEqual(rarestFirst([...rows].reverse()), sorted);
    for (let i = 1; i < sorted.length; i++) assert.ok(TIER_NAMES.indexOf(sorted[i - 1].award.tier) >= TIER_NAMES.indexOf(sorted[i].award.tier));
  }));
});

test("partial outcomes in plain words, with the real figures, and nothing said when all is well", () => {
  assert.equal(outcomeText(outcomeOf(["ready", "ready"], 4)), null);
  assert.equal(outcomeText(outcomeOf(["ready", "back", "back"], 4)), "1 of 3 came through. We couldn't deliver 2 packs, so 8 XRP is going back to your wallet, whole.");
  assert.match(outcomeText(outcomeOf(["ready", "waiting"], 4)) ?? "", /1 of 2 are ready and 1 is on the way/);
  assert.match(outcomeText(outcomeOf(["ready", "checking"], 4)) ?? "", /Don't pay again/);
  assert.match(payoutText("done", 12.5, 3), /^Paid: 12\.50 XRP for 3 items, in one payment/);
  assert.match(payoutText("failed", 12.5, 3), /back in your stash/);
  assert.match(payoutText("sent", 2, 1), /1 item is|for 1 item/);
});

test("a multi order counts as an open checkout on its own pack, and only there", () => {
  const open = { nft: [], cards: [], bundles: [{ id: "a", qty: 5, price: 5 }] };
  assert.equal(holdsCheckout(open, { kind: "nft", price: 5 }), true);
  assert.equal(holdsCheckout(open, { kind: "nft", price: 10 }), false);
  assert.equal(holdsCheckout(open, { kind: "card", code: "x" }), false);
  assert.equal(holdsCheckout({ nft: [], cards: [] }, { kind: "nft", price: 5 }), false);
});

const root = new URL("../src/", import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

test("copy rules on everything this adds: no returns, no profit, no urgency, US spelling", () => {
  const files = ["components/MultiReveal.tsx", "components/DemoMulti.tsx", "components/live/MultiOpen.tsx", "components/live/BulkSheet.tsx", "components/live/QtyPicker.tsx", "lib/live/multi.ts"].map((f) => join(root, f));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/\bRTP\b|house edge|expected value|return to player|\b(your|a|the) return\b|returns? (of|on)\b|profit|guarantee|\bhurry\b|\bonly \d+ left\b|running out|last chance|don't miss|limited time|best value|\bdeal\b/i.test(text), f);
    assert.ok(!/colour|centre|licence|favour/i.test(text), f);
  }
  assert.ok(walk(root).length > 10);
});
