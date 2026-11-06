import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { AGAIN, againHref, buyState, cameAgain, keptQty, packHref, pullPack, qtyKey, shellBack } from "../src/lib/again.ts";
import { revealNext } from "../src/lib/live/proof.ts";
import { awardBack, multipleText, orderBackXrp, pullMultiple, totalMultiple } from "../src/lib/pull-multiple.ts";
import { sellWindowLine } from "../src/lib/sellback.ts";

const num = (text: string) => Number(text.replace(/[<×,]/g, ""));

test("the multiple is what you get back over what that one pack cost, rounded down", () => {
  // The owner's example: a card that sells back for 28.67 XRP from a 20 XRP pack.
  assert.deepEqual(pullMultiple(28.67, 20), { ratio: 1.4335, text: "1.43×", up: true });
  assert.equal(pullMultiple(17, 20)?.text, "0.85×");
  assert.equal(pullMultiple(17, 20)?.up, false);
  assert.equal(pullMultiple(20, 20)?.text, "1.00×");
  assert.equal(pullMultiple(20, 20)?.up, true);
  // XRP from drops divides exactly: 1.43 isn't floored to 1.42 by float noise, and exactly the price is never under 1×.
  assert.equal(pullMultiple(1.43, 1)?.text, "1.43×");
  assert.equal(pullMultiple(0.1 + 0.2, 0.3)?.up, true);
  assert.equal(pullMultiple(249.99, 20)?.text, "12.4×");
  assert.equal(pullMultiple(2800, 20)?.text, "140×");
  assert.equal(pullMultiple(30000, 20)?.text, "1,500×");
  assert.equal(pullMultiple(0.05, 20)?.text, "<0.01×");
  assert.equal(multipleText(9.999), "9.99×");
  assert.equal(multipleText(99.99), "99.9×");
});

test("no number, no badge: still drawing, no sell-back offer, or nothing paid", () => {
  for (const [back, paid] of [[null, 20], [undefined, 20], [28.67, null], [28.67, undefined], [0, 20], [28.67, 0], [-1, 20], [28.67, -5], [NaN, 20], [28.67, NaN], [Infinity, 20], [28.67, Infinity]] as const) {
    assert.equal(pullMultiple(back, paid), null, `${back}/${paid}`);
  }
});

test("the badge never says more than you'd get, and is positive exactly at or over the price", () => {
  const drops = fc.integer({ min: 1, max: 10_000_000_000 });
  fc.assert(
    fc.property(drops, drops, (b, p) => {
      const m = pullMultiple(b / 1e6, p / 1e6);
      assert.ok(m);
      assert.equal(m.up, b >= p);
      const exact = b / p;
      const shown = num(m.text);
      if (m.text.startsWith("<")) assert.ok(exact < 0.01);
      else {
        assert.ok(shown <= exact + 1e-9, `${m.text} over ${exact}`);
        const step = exact < 10 ? 0.01 : exact < 100 ? 0.1 : 1;
        assert.ok(exact - shown < step + 1e-9, `${m.text} too far under ${exact}`);
      }
      // Up and the shown figure agree: a positive badge never reads under 1, a quiet one never reads 1 or more.
      if (!m.text.startsWith("<")) assert.equal(shown >= 1, m.up);
    }),
  );
});

test("more back or a cheaper pack never shows a smaller multiple", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 1, max: 1e9 }), (b, more, p) => {
      const base = pullMultiple(b / 1e6, p / 1e6)!.ratio;
      assert.ok(pullMultiple((b + more) / 1e6, p / 1e6)!.ratio >= base);
      assert.ok(pullMultiple(b / 1e6, (p + more) / 1e6)!.ratio <= base);
    }),
  );
});

test("a multi order counts each pull against the per-pack price, and its total only once every pull is priced", () => {
  // Three 20 XRP packs, bought as one 60 XRP payment: each pull is against 20, not 60.
  const each = 20;
  assert.equal(pullMultiple(28.67, each)?.text, "1.43×");
  assert.equal(totalMultiple([28.67, 10, 21.33], each)?.text, "1.00×");
  assert.equal(totalMultiple([28.67, 10, 21.33], each)?.up, true);
  assert.equal(totalMultiple([10, 10, 10], each)?.text, "0.50×");
  assert.equal(totalMultiple([28.67, null, 21.33], each), null);
  assert.equal(totalMultiple([28.67, 0, 21.33], each), null);
  assert.equal(totalMultiple([], each), null);
  assert.equal(totalMultiple([28.67], null), null);
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 1, max: 1e10 }), { minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 1e9 }), (backs, e) => {
      const t = totalMultiple(backs.map((d) => d / 1e6), e / 1e6)!;
      const sum = backs.reduce((a, d) => a + d, 0);
      assert.equal(t.up, sum >= e * backs.length);
      // The total sits between the worst and the best pull.
      const ratios = backs.map((d) => d / e);
      assert.ok(t.ratio >= Math.min(...ratios) - 1e-9 && t.ratio <= Math.max(...ratios) + 1e-9);
    }),
  );
});

test("what a pull gets back: the sell-back offer for NFTs and cards, the XRP itself for an XRP prize", () => {
  assert.equal(orderBackXrp({ sellXrp: 18.4, prize: null }), 18.4);
  assert.equal(orderBackXrp({ sellXrp: null, prize: null }), null);
  assert.equal(orderBackXrp({ sellXrp: null, prize: { token: "XRP", valueXrp: 25 } }), 25);
  assert.equal(orderBackXrp({ sellXrp: 3.2, prize: { token: "SEAL", valueXrp: 4 } }), 3.2);
  assert.equal(orderBackXrp({ sellXrp: null, prize: { token: "SEAL", valueXrp: 4 } }), null);
  // The demo's own units: dollars back over dollars paid.
  assert.equal(awardBack({ value: 40, sell: 33 }), 33);
  assert.equal(awardBack({ value: 40, sell: 0 }), null);
  assert.equal(awardBack({ token: "XRP", value: 12, sell: 0 }), 12);
  assert.equal(awardBack({ token: "SEAL", value: 12, sell: 11.4 }), 11.4);
});

test("the sell-back line is one short muted line, open or closed", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const until = new Date(now + (2 * 24 + 23) * 3600_000 + 5 * 60_000).toISOString();
  assert.equal(sellWindowLine(until, now, true), "Sell-back closes in 2d 23h");
  assert.equal(sellWindowLine(new Date(now + 30_000).toISOString(), now, true), "Sell-back closes in under a minute");
  assert.equal(sellWindowLine(new Date(now - 1).toISOString(), now, true), null);
  assert.equal(sellWindowLine(new Date(now - 1).toISOString(), now, false), "Sell-back closed. You can still ship it.");
  assert.equal(sellWindowLine(null, now, false), null);
  fc.assert(
    fc.property(fc.integer({ min: -1e9, max: 72 * 3600_000 }), fc.boolean(), (ms, priced) => {
      const line = sellWindowLine(new Date(now + ms).toISOString(), now, priced);
      if (line) assert.ok(line.length <= 40 && !/Collector Crypt/.test(line), line);
    }),
  );
});

test("every reveal line, real or demo, is short and never names odds or a partner", () => {
  assert.equal(revealNext({ kind: "card" }, null, true), "Demo: an example you don't own.");
  for (const kind of ["card", "nft"] as const) for (const prize of [null, { token: "XRP" }, { token: "SEAL" }]) for (const demo of [false, true]) {
    const t = revealNext({ kind }, prize, demo);
    assert.ok(t.length <= 36, t);
    assert.doesNotMatch(t, /RTP|house edge|partner|odds|expected/i);
  }
});

test("Open another goes to the pack the prize came from", () => {
  assert.equal(packHref({ kind: "nft", price: 5 }), "/nft/5");
  assert.equal(packHref({ kind: "card", code: "pokemon_50" }), "/packs/pokemon_50");
  assert.equal(againHref({ kind: "nft", price: 25 }), `/nft/25?${AGAIN}=1`);
  assert.equal(againHref({ kind: "card", code: "bf_poke25" }), "/packs/bf_poke25?again=1");
  assert.equal(againHref(null), "/packs");
  assert.equal(againHref(undefined), "/packs");
  // An NFT order names its price; a card names its pack's code; a multi order names one or the other.
  assert.deepEqual(pullPack({ price: 5, code: null }), { kind: "nft", price: 5 });
  assert.deepEqual(pullPack({ price: null, code: "bf_poke25" }), { kind: "card", code: "bf_poke25" });
  assert.deepEqual(pullPack({ code: "bf_poke25" }), { kind: "card", code: "bf_poke25" });
  assert.equal(pullPack({ price: null, code: null }), null);
  assert.equal(pullPack(null), null);
  fc.assert(
    fc.property(fc.stringMatching(/^[a-z0-9_]{1,24}$/), (code) => {
      const href = againHref(pullPack({ code }));
      assert.equal(href, `/packs/${code}?again=1`);
      assert.ok(cameAgain(new URL(href, "https://x.test").search));
    }),
  );
});

test("Back after Open another goes to the shelf; anywhere else it's ordinary history", () => {
  assert.equal(shellBack("?again=1"), "packs");
  assert.equal(shellBack("?again=1&qty=3"), "packs");
  assert.equal(shellBack(""), "history");
  assert.equal(shellBack("?again=0"), "history");
  assert.equal(shellBack("?nft=5&qty=3"), "history");
});

test("the picker keeps the last choice, within what the pack can take now", () => {
  assert.equal(qtyKey({ kind: "nft", price: 5 }), "seal:qty:n5");
  assert.equal(qtyKey({ kind: "card", code: "bf_poke25" }), "seal:qty:bf_poke25");
  assert.equal(keptQty("3", 20), 3);
  assert.equal(keptQty("1", 20), 1);
  assert.equal(keptQty("10", 4), 4);
  assert.equal(keptQty(null, 20), 1);
  assert.equal(keptQty("0", 20), 1);
  assert.equal(keptQty("-3", 20), 1);
  assert.equal(keptQty("3.5", 20), 1);
  assert.equal(keptQty("lots", 20), 1);
  assert.equal(keptQty("3", null), 1);
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.integer({ min: -50, max: 200 }).map(String)), fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }), (raw, max) => {
      const q = keptQty(raw, max);
      assert.ok(Number.isInteger(q) && q >= 1 && q <= Math.max(1, max ?? 1));
    }),
  );
});

test("a pack that can't be opened says so, and only an open one has a live button", () => {
  const base = { availability: "open" as const, held: false, roomOn: true, roomMax: 5 };
  assert.equal(buyState(base), "open");
  assert.equal(buyState({ ...base, availability: "checking" }), "checking");
  assert.equal(buyState({ ...base, availability: "restocking" }), "restocking");
  assert.equal(buyState({ ...base, availability: "restocking", held: true }), "held");
  assert.equal(buyState({ ...base, soldOut: true }), "soldout");
  assert.equal(buyState({ ...base, disabledLabel: "Coming soon" }), "unavailable");
  assert.equal(buyState({ ...base, roomMax: 0 }), "full");
  assert.equal(buyState({ ...base, roomMax: null }), "open");
  assert.equal(buyState({ ...base, roomOn: false, roomMax: 0 }), "open");
});
