import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { CARD_TIERS, type Item } from "../src/lib/catalog/types.ts";
import { EMPTY, reduce, revive, type DemoAction, type DemoState } from "../src/lib/demo/state.ts";
import { nftPack, nftTitle, parseNftPrice, shortCollection, type NftSnapshot } from "../src/lib/nft/view.ts";
import { demoCardAward, demoNftAward, mockXaman, pickTier } from "../src/lib/rails/demo.ts";
import { IllegalTransition, newOrder, transition, type Order, type OrderEvent } from "../src/lib/rails/order.ts";
import type { Award } from "../src/lib/rails/types.ts";
import { cardSellBack } from "../src/lib/sellback.ts";

const award: Award = { kind: "card", provenance: "demo", tier: "Rare", name: "Card", img: "https://d1xpxki1g4htqu.cloudfront.net/a", value: 14, grade: "PSA 10", sell: 11.3, sourceId: "a" };
const base = { id: "o1", pack: { kind: "card" as const, code: "x" }, name: "Pack", price: 25, art: "/a.webp", back: "/packs/x", quote: { usd: 25, maxXrp: 20, xrpUsd: 1.25 } };
const eventArb: fc.Arbitrary<OrderEvent> = fc.oneof(
  ...(["request_signature", "decline", "expire", "payment_confirmed", "payment_failed", "reveal", "stash", "sell", "ship", "claim"] as const).map((type) => fc.constant({ type } as OrderEvent)),
  fc.constant<OrderEvent>({ type: "signed", txRef: "t" }),
  fc.constant<OrderEvent>({ type: "award", award }),
  fc.constant<OrderEvent>({ type: "award", award: { ...award, name: "Other" } }),
);

test("the happy path runs quote to stash to sold", () => {
  let o: Order = newOrder(base);
  for (const e of [{ type: "request_signature" }, { type: "signed", txRef: "t" }, { type: "payment_confirmed" }, { type: "award", award }, { type: "reveal" }, { type: "stash" }, { type: "sell" }] as OrderEvent[]) o = transition(o, e);
  assert.equal(o.state, "sold");
  assert.equal(o.award?.name, "Card");
});

test("declining or a failed payment never reaches an award", () => {
  const signed = transition(transition(newOrder(base), { type: "request_signature" }), { type: "signed", txRef: "t" });
  assert.equal(transition(signed, { type: "payment_failed" }).state, "failed");
  const asked = transition(newOrder(base), { type: "request_signature" });
  assert.equal(transition(asked, { type: "decline" }).state, "declined");
  assert.throws(() => transition(asked, { type: "award", award }), IllegalTransition);
});

test("whatever events arrive: no award before payment, an award never changes, and settled orders stay settled", () => {
  fc.assert(
    fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
      let o: Order = newOrder(base);
      let confirmed = false;
      let first: Award | null = null;
      for (const e of events) {
        const before = o;
        try {
          o = transition(o, e);
        } catch (err) {
          assert.ok(err instanceof IllegalTransition);
          assert.equal(o, before);
          continue;
        }
        if (e.type === "payment_confirmed") confirmed = true;
        if (o.award) {
          assert.ok(confirmed, "award without a confirmed payment");
          first = first ?? o.award;
          assert.equal(o.award, first);
        }
        if (["declined", "expired", "failed"].includes(before.state)) assert.fail("left a terminal state");
        if (e.type === "reveal") assert.equal(o.award, before.award);
      }
    }),
  );
});

const item = (id: string, rarity: Item["rarity"], ins = 10): Item => ({ id, name: id, rarity, ins, grade: "PSA 10", img: `https://d1xpxki1g4htqu.cloudfront.net/${id}`, code: "x" });
const machine = { rates: [75, 20, 4, 1] as [number, number, number, number], bb: 85 };

test("tier picks follow the machine's rates", () => {
  const n = 40000;
  const counts = [0, 0, 0, 0];
  let x = 0.123456;
  const rng = () => (x = (x * 9301.1 + 0.49297) % 1);
  for (let i = 0; i < n; i++) counts[pickTier(machine.rates, [true, true, true, true], rng)]++;
  machine.rates.forEach((r, i) => assert.ok(Math.abs((counts[i] / n) * 100 - r) < 1.5, `tier ${i}: ${(counts[i] / n) * 100}`));
});

test("a demo card award's label, value and sell-back always match the real item it drew", () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ id: fc.uuid(), rarity: fc.constantFrom(...CARD_TIERS), ins: fc.integer({ min: 1, max: 100000 }) }), { maxLength: 30 }),
      fc.array(fc.double({ min: 0, max: 0.9999999, noNaN: true }), { minLength: 4, maxLength: 4 }),
      (rows, rolls) => {
        const pool = rows.map((r) => item(r.id, r.rarity, r.ins));
        let i = 0;
        const a = demoCardAward(machine, pool, () => rolls[i++ % rolls.length]);
        if (!pool.length) return assert.equal(a, null);
        assert.ok(a);
        const drawn = pool.find((p) => p.id === a.sourceId);
        assert.ok(drawn);
        assert.equal(a.tier.toLowerCase(), drawn.rarity);
        assert.equal(a.value, drawn.ins);
        assert.equal(a.sell, cardSellBack(drawn.ins, machine.bb));
        assert.equal(a.provenance, "demo");
      },
    ),
  );
});

const snap: NftSnapshot["collections"] = Object.fromEntries(
  ["parc", "animal-fam", "seal-cto-scrolls", "bearchampgf", "bearchamp"].map((slug, i) => [slug, { slug, name: slug === "seal-cto-scrolls" ? "The Bear Champ - Dead As Fuck" : slug, floor: (i + 1) * 10, items: 100, samples: [{ id: `${slug}-1`, name: "76", img: `/nfts/${slug}/1.webp` }] }]),
);

test("a demo NFT award uses real art and the floor of its drawn tier", () => {
  const pack = nftPack(100, snap);
  fc.assert(
    fc.property(fc.double({ min: 0, max: 0.9999999, noNaN: true }), (r) => {
      const out = demoNftAward(pack, 1.25, () => r);
      assert.ok(out);
      assert.match(out.img, /^\/nfts\//);
      const tier = pack.tiers.find((t) => t.tier === out.tier);
      assert.equal(out.value, (tier?.collection?.floor ?? 0) * 1.25);
      assert.equal(out.provenance, "demo");
    }),
  );
});

test("demo NFT pulls roll the published rates on every pull, the same as real rails: there is no deck", () => {
  const pack = nftPack(100, snap);
  const counts: Record<string, number> = {};
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const draws = 40000;
  for (let i = 0; i < draws; i++) {
    const a = demoNftAward(pack, 1.25, rng);
    assert.ok(a);
    counts[a.tier] = (counts[a.tier] ?? 0) + 1;
  }
  for (const [tier, rate] of [["Common", 0.66], ["Uncommon", 0.24], ["Rare", 0.07], ["Epic", 0.02], ["Chase", 0.01]] as const) {
    assert.ok(Math.abs((counts[tier] ?? 0) - draws * rate) < 5 * Math.sqrt(draws * rate * (1 - rate)), `${tier}: ${counts[tier]}`);
  }
});

test("a collection with no real art never produces an award", () => {
  const noArt = { ...snap, parc: { ...snap.parc, samples: [] } };
  assert.equal(demoNftAward(nftPack(100, noArt), 1.25, () => 0), null);
  const missing = { ...snap };
  delete (missing as Record<string, unknown>).parc;
  assert.equal(demoNftAward(nftPack(100, missing), 1.25, () => 0), null);
});

test("NFT names read cleanly", () => {
  assert.equal(shortCollection("The Bear Champ - Dead As Fuck"), "Bear Champ DAF");
  assert.equal(shortCollection("The Bear Champ GF"), "Bear Champ GF");
  assert.equal(nftTitle("Bear Champ", "76"), "Bear Champ #76");
  assert.equal(nftTitle("Anti-Social Media", "Anti-Social #5101"), "Anti-Social #5101");
  assert.equal(nftTitle("Bear Champ", ""), "Bear Champ");
  for (const bad of ["4", "abc", "5.5", "", "05x", "1000"]) assert.equal(parseNftPrice(bad), null);
  assert.equal(parseNftPrice("25"), 25);
});

test("the mock wallet answers locally and only with demo references", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => assert.fail("mock wallet touched the network")) as typeof fetch;
  try {
    assert.equal(mockXaman.kind, "mock-xaman");
    assert.match((await mockXaman.connect()).address, /DEMO/);
    const r = await mockXaman.requestPayment({ orderId: "o", quote: base.quote, destinationLabel: "x" });
    assert.equal(r.status, "signed");
    assert.match((await mockXaman.payout({ exitId: "e", usd: 1 })).txRef, /^demo-/);
    assert.match((await mockXaman.offerNft({ exitId: "e", sourceId: "s" })).offerRef, /^demo-/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const paidOrder = (state: DemoState, id: string): DemoState => {
  let s = reduce(state, { type: "order_new", order: { ...base, id } });
  for (const event of [{ type: "request_signature" }, { type: "signed", txRef: "t" }, { type: "payment_confirmed" }, { type: "award", award }, { type: "reveal" }] as OrderEvent[]) s = reduce(s, { type: "order_event", id, event });
  return s;
};

test("stash, then sell: the demo flow end to end, and repeat taps do nothing", () => {
  let s = paidOrder(EMPTY, "o1");
  assert.equal(s.orders.o1.state, "revealed");
  s = reduce(s, { type: "stash", orderId: "o1" });
  s = reduce(s, { type: "stash", orderId: "o1" });
  assert.equal(s.holdings.length, 1);
  s = reduce(s, { type: "ship", holdingId: "o1" });
  assert.equal(s.holdings[0].status, "Shipping");
  const shipped = reduce(s, { type: "sell", holdingId: "o1" });
  assert.equal(shipped.holdings.length, 1, "a shipping item can't be sold");
});

test("selling at the reveal settles the order once", () => {
  let s = paidOrder(EMPTY, "o1");
  s = reduce(s, { type: "sell_order", orderId: "o1" });
  const rows = s.history.length;
  s = reduce(s, { type: "sell_order", orderId: "o1" });
  s = reduce(s, { type: "stash", orderId: "o1" });
  assert.equal(s.orders.o1.state, "sold");
  assert.equal(s.history.length, rows);
  assert.equal(s.holdings.length, 0);
});

test("only NFTs can be claimed and only cards can ship", () => {
  let s = paidOrder(EMPTY, "c");
  s = reduce(s, { type: "stash", orderId: "c" });
  assert.equal(reduce(s, { type: "claim", holdingId: "c" }).holdings.length, 1);
});

test("any action sequence leaves the store sane, and holdings never duplicate", () => {
  const actionArb: fc.Arbitrary<DemoAction> = fc.oneof(
    fc.constantFrom<DemoAction>({ type: "stash", orderId: "o1" }, { type: "sell_order", orderId: "o1" }, { type: "sell", holdingId: "o1" }, { type: "ship", holdingId: "o1" }, { type: "claim", holdingId: "o1" }, { type: "connect", address: "r", wallet: "demo" }, { type: "signout" }),
    eventArb.map((event) => ({ type: "order_event" as const, id: "o1", event })),
  );
  fc.assert(
    fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
      let s = reduce(EMPTY, { type: "order_new", order: base });
      for (const a of actions) s = reduce(s, a);
      assert.ok(s.holdings.length <= 1);
      if (s.holdings.length) assert.equal(s.holdings[0].award.provenance, "demo");
    }),
  );
});

test("unreadable storage starts clean", () => {
  for (const raw of [null, "", "{", "null", "7", "[]", '{"holdings":3,"orders":"x"}']) {
    const s = revive(raw);
    assert.equal(s.signed, false);
    assert.ok(Array.isArray(s.holdings));
  }
  fc.assert(fc.property(fc.string(), (raw) => assert.ok(Array.isArray(revive(raw).history))));
});
