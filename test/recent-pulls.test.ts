import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fc from "fast-check";
import { FEED_SIZE, REVEAL_HOLD_MS, recentPulls, type RecentPull } from "../src/lib/rip/recent-pulls.ts";
import { apply, type CardState, type OrderState, type RipState } from "../src/lib/rip/state.ts";
import { RING_CAP, loops, placeArrivals, timeAgo } from "../src/lib/live/ticker.ts";
import { simulatedGateway } from "../src/lib/rip/card-gateway.ts";
import { addressOf, world } from "./support-routes.ts";

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const WALLET = "rhmkE8WgE7f8GksH3YXE7bt7KJ22RiMzF2";
const iso = (ms: number) => new Date(ms).toISOString();

const order = (i: number, status: OrderState["status"], ageMs: number, prize: boolean): OrderState =>
  ({ id: `order${i}id`, season: "5-1", price: 5, address: WALLET, status, band: i % 5, lot: prize ? null : `lot${i}`, nftId: prize ? null : `NFTID${i}XX`, txHash: `TXHASH${i}XX`, drawnAt: status === "drawn" ? iso(T0 - ageMs) : null, prize: prize ? { token: "XRP", amount: "2500000", valueDrops: "2500000", reads: null, note: null, owed: false, redeemTx: null } : null }) as unknown as OrderState;

const card = (i: number, status: CardState["status"], gateway: string, ageMs: number): CardState =>
  ({ id: `card${i}id`, code: "pokemon_25", packName: "Starter Pokémon Gacha Pack", usd: 25, address: WALLET, gateway, status, txHash: `CARDTX${i}XX`, signature: `SIG${i}XX`, mint: `MINT${i}XX`, name: `Zekrom ${i}`, img: "https://nft.collectorcrypt.com/front/1", grade: "PSA 9", insuredMicro: "25000000", rarity: "Epic", proof: `PROOF${i}XX`, heldAt: status === "held" ? iso(T0 - ageMs) : null }) as unknown as CardState;

const stateOf = (orders: readonly OrderState[], cards: readonly CardState[]): RipState => {
  const lots = new Map(orders.filter((o) => o.lot).map((o) => [o.lot as string, { lot: o.lot, nftId: o.nftId, price: 5, band: o.band, collection: "Bear Champ", name: "76", img: `/nfts/x/${o.lot}.webp`, costDrops: "9", markDrops: "3000000", status: "awarded" }]));
  return { genesis: { networkId: 1 }, orders: new Map(orders.map((o) => [o.id, o])), cards: new Map(cards.map((c) => [c.id, c])), lots } as unknown as RipState;
};

const age = fc.integer({ min: 0, max: 90 * 24 * 3_600_000 });
const anyOrder = fc.tuple(fc.nat(10_000), fc.constantFrom<OrderState["status"]>("quoted", "paid", "drawn", "expired", "refund_due", "refunded"), age, fc.boolean());
const anyCard = fc.tuple(fc.nat(10_000), fc.constantFrom<CardState["status"]>("quoted", "paid", "signed", "source_paid", "opened", "held", "review", "refund_due", "refunded"), fc.constantFrom("collector-crypt", "simulated"), age);
const anyWorld = fc.tuple(fc.uniqueArray(anyOrder, { selector: (o) => o[0], maxLength: 60 }), fc.uniqueArray(anyCard, { selector: (c) => c[0], maxLength: 60 }));

test("only real, final pulls past the hold, newest first, and at most a feed's worth: no state of the log makes up or leaks one", () => {
  fc.assert(
    fc.property(anyWorld, ([os, cs]) => {
      const orders = os.map(([i, st, a, p]) => order(i, st, a, p));
      const cards = cs.map(([i, st, g, a]) => card(i, st, g, a));
      const pulls = recentPulls(stateOf(orders, cards), T0);
      const final = [...orders.filter((o) => o.status === "drawn" && Date.parse(o.drawnAt as string) + REVEAL_HOLD_MS <= T0), ...cards.filter((c) => c.status === "held" && c.gateway !== "simulated" && Date.parse(c.heldAt as string) + REVEAL_HOLD_MS <= T0)];
      assert.equal(pulls.length, Math.min(final.length, FEED_SIZE));
      assert.equal(new Set(pulls.map((p) => p.key)).size, pulls.length);
      for (let i = 1; i < pulls.length; i++) assert.ok(Date.parse(pulls[i - 1].at) >= Date.parse(pulls[i].at));
      const sent = JSON.stringify(pulls);
      for (const needle of [WALLET, "TXHASH", "CARDTX", "SIG", "MINT", "PROOF", "NFTID", "costDrops", "address"]) assert.ok(!sent.includes(needle), needle);
      assert.doesNotMatch(sent, /order\d+id|card\d+id/);
      for (const p of pulls) assert.deepEqual(Object.keys(p).sort(), ["at", "grade", "href", "img", "key", "kind", "name", "pack", "tier", "value"]);
    }),
  );
});

test("no pulls is an empty feed, and the hold's edge is exact", () => {
  assert.deepEqual(recentPulls(stateOf([], []), T0), []);
  assert.equal(recentPulls(stateOf([order(1, "drawn", REVEAL_HOLD_MS - 1, false)], []), T0).length, 0);
  assert.equal(recentPulls(stateOf([order(1, "drawn", REVEAL_HOLD_MS, false)], []), T0).length, 1);
  assert.equal(recentPulls(stateOf([], [card(1, "held", "collector-crypt", REVEAL_HOLD_MS - 1)]), T0).length, 0);
  assert.equal(recentPulls(stateOf([], [card(1, "held", "collector-crypt", REVEAL_HOLD_MS)]), T0).length, 1);
});

test("what each kind of pull shows", () => {
  const [nft] = recentPulls(stateOf([order(3, "drawn", REVEAL_HOLD_MS, false)], []), T0);
  assert.deepEqual([nft.kind, nft.tier, nft.name, nft.value, nft.href], ["nft", "Epic", "Bear Champ #76", "3 XRP", "/nft/5"]);
  const [dust] = recentPulls(stateOf([order(0, "drawn", REVEAL_HOLD_MS, true)], []), T0);
  assert.deepEqual([dust.kind, dust.tier, dust.name, dust.img, dust.value], ["prize", "Common", "2.5 XRP", "/assets/xrp-coin.svg", null]);
  const [slab] = recentPulls(stateOf([], [card(1, "held", "collector-crypt", REVEAL_HOLD_MS)]), T0);
  assert.deepEqual([slab.kind, slab.tier, slab.value, slab.grade, slab.pack, slab.href], ["card", "Epic", "$25", "PSA 9", "Starter Pokémon Pack", "/packs/pokemon_25"]);
  const elsewhere = { ...card(1, "held", "collector-crypt", REVEAL_HOLD_MS), img: "https://other.example/x.png" };
  assert.equal(recentPulls(stateOf([], [elsewhere]), T0)[0].img, "/assets/stage-pack.webp", "a host next/image refuses would crash the page");
});

test("a card's time is when it reached custody: later custody readings don't make it new again", () => {
  const s = stateOf([], [{ ...card(1, "opened", "collector-crypt", 0), hold: null, proofAt: null } as CardState]);
  apply(s, { type: "card_held", seq: 1, at: iso(T0 - 3_600_000), prev: "", hash: "", data: { order: "card1id", mint: "m", slot: 1, proof: "p" } });
  assert.equal(s.cards.get("card1id")?.heldAt, iso(T0 - 3_600_000));
  apply(s, { type: "mirror_requested", seq: 2, at: iso(T0), prev: "", hash: "", data: { order: "card1id", address: WALLET, slot: 2, proof: "q" } });
  assert.equal(recentPulls(s, T0)[0].at, iso(T0 - 3_600_000));
});

test("time ago reads plainly and never goes negative", () => {
  assert.equal(timeAgo(iso(T0), T0 - 5000), "1m ago");
  assert.equal(timeAgo(iso(T0 - 3 * 60_000), T0), "3m ago");
  assert.equal(timeAgo(iso(T0 - 3 * 3_600_000), T0), "3h ago");
  assert.equal(timeAgo(iso(T0 - 72 * 3_600_000), T0), "3d ago");
});

const P = (key: string) => ({ key });
const onScreen = (ring: readonly { key: string }[], offset: number, pitch: number, view: number) => {
  const seen = new Map<string, number>();
  for (let slot = 0; slot < ring.length * 2; slot++) {
    const x = slot * pitch - offset;
    if (x + pitch > 0 && x < view) seen.set(`${ring[slot % ring.length].key}@${slot < ring.length ? "a" : "b"}`, Math.round(x * 1000) / 1000);
  }
  return [...seen.entries()].map(([k, x]) => [k.split("@")[0], x] as const).sort((a, b) => a[1] - b[1]);
};
const moving = fc
  .record({ n: fc.integer({ min: 3, max: RING_CAP - 4 }), pitch: fc.integer({ min: 100, max: 260 }), viewSlots: fc.double({ min: 0.5, max: 6, noNaN: true }), at: fc.double({ min: 0, max: 0.999, noNaN: true }), news: fc.integer({ min: 1, max: 3 }) })
  .map((c) => ({ ...c, view: Math.floor(c.viewSlots * c.pitch) }))
  .filter((c) => loops(c.n, c.pitch, c.view));

test("a new pull in a moving row: nothing on screen moves, nothing is lost, and it's next in from the right", () => {
  fc.assert(
    fc.property(moving, ({ n, pitch, view, at, news }) => {
      const ring = Array.from({ length: n }, (_, i) => P(`r${i}`));
      const offset = at * n * pitch;
      const fresh = Array.from({ length: news }, (_, i) => P(`new${i}`));
      const placed = placeArrivals(ring, [...fresh, ...ring], { offset, pitch, view, looping: true });
      assert.deepEqual(onScreen(placed.ring, placed.offset, pitch, view), onScreen(ring, offset, pitch, view));
      assert.deepEqual([...placed.ring.map((p) => p.key)].sort(), [...ring, ...fresh].map((p) => p.key).sort());
      assert.deepEqual(placed.fresh, fresh.map((p) => p.key));
      assert.ok(placed.offset >= 0 && placed.offset < placed.ring.length * pitch);
      const slot = Math.ceil((placed.offset + view) / pitch);
      assert.equal(placed.ring[slot % placed.ring.length].key, "new0", "the newest comes into view first");
    }),
  );
});

test("a read with nothing new changes nothing, and a still row takes new pulls at the front", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 30 }), fc.nat(5000), (n, offset) => {
      const ring = Array.from({ length: n }, (_, i) => P(`r${i}`));
      const same = placeArrivals(ring, ring, { offset, pitch: 200, view: 390, looping: n > 3 });
      assert.deepEqual(same, { ring, offset, fresh: [] });
    }),
  );
  const still = placeArrivals([P("a")], [P("c"), P("b"), P("a")], { offset: 0, pitch: 200, view: 1200, looping: false });
  assert.deepEqual(still.ring.map((p) => p.key), ["c", "b", "a"]);
});

test("a full ring stays full: it swaps the next card in, so it can't grow for as long as a page stays open", () => {
  const ring = Array.from({ length: RING_CAP }, (_, i) => P(`r${i}`));
  const placed = placeArrivals(ring, [P("new")], { offset: 400, pitch: 200, view: 390, looping: true });
  assert.equal(placed.ring.length, RING_CAP);
  assert.equal(placed.offset, 400);
  assert.ok(placed.ring.some((p) => p.key === "new"));
  assert.deepEqual(onScreen(placed.ring, placed.offset, 200, 390), onScreen(ring, 400, 200, 390));
  assert.equal(placeArrivals(ring, [P("n")], { offset: 0, pitch: 200, view: 390, looping: false }).ring.length, RING_CAP);
});

test("the row only moves with more than a screen of pulls, so a pull is never on screen twice", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 100, max: 300 }), fc.integer({ min: 200, max: 3000 }), (n, pitch, view) => {
      if (!loops(n, pitch, view)) return;
      const ring = Array.from({ length: n }, (_, i) => P(`r${i}`));
      for (let o = 0; o < n * pitch; o += pitch / 3) {
        const keys = onScreen(ring, o, pitch, view).map(([k]) => k);
        assert.equal(new Set(keys).size, keys.length);
      }
    }),
  );
  assert.equal(loops(1, 254, 1100), false);
  assert.equal(loops(5, 254, 1100), false);
  assert.equal(loops(0, 0, 0), false);
});

/** The same real handler, the same real log, later. */
const later = (t: TestContext, ms: number) => {
  const real = Date.now.bind(Date);
  t.mock.method(Date, "now", () => real() + ms);
};

test("by route: an NFT pull waits out the hold, then shows with nothing about who pulled it, and the feed reads no ledger", async (t) => {
  const w = await world();
  await w.open();
  const me = w.client(addressOf(1));
  w.fund(me);
  const before = await w.call("GET", "/api/rip/pulls");
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.pulls, []);
  const id = await w.pull(me);
  const order = w.orderOf(id);
  assert.equal(order?.status, "drawn");
  later(t, 20_000);
  assert.deepEqual((await w.call("GET", "/api/rip/pulls")).body.pulls, [], "drawn, but the player may still be on the stage");
  t.mock.restoreAll();
  later(t, REVEAL_HOLD_MS + 20_000);
  const seen = await w.call("GET", "/api/rip/pulls");
  assert.equal(seen.body.pulls.length, 1);
  const sent = JSON.stringify(seen.body);
  for (const secret of [addressOf(1), id, order?.txHash, order?.nftId, order?.lot]) assert.ok(secret && !sent.includes(secret), "no way back to the wallet");
  assert.doesNotMatch(sent, /costDrops|bandBps|rtp|edge|odds/i);
  const after = seen.body.pulls[0] as RecentPull;
  assert.equal(after.at, order?.drawnAt);

  // A real read: one log read a window, however many ask, and the ledger never hears about it.
  t.mock.restoreAll();
  later(t, REVEAL_HOLD_MS + 40_000);
  let reads = 0;
  const readFrom = w.store.readFrom.bind(w.store);
  w.store.readFrom = async (n: number) => (reads++, readFrom(n));
  let ledgerCalls = 0;
  for (const k of Object.keys(w.chain)) {
    const fn = (w.chain as unknown as Record<string, unknown>)[k];
    if (typeof fn === "function") (w.chain as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => (ledgerCalls++, (fn as (...b: unknown[]) => unknown)(...a));
  }
  await Promise.all(Array.from({ length: 25 }, () => w.call("GET", "/api/rip/pulls")));
  assert.equal(reads, 1);
  assert.equal(ledgerCalls, 0);
});

test("by route: a card shows once it's in custody; a simulated card never does", async (t) => {
  const realName = { ...simulatedGateway(), label: "collector-crypt" as const };
  const w = await world({ cards: true, gateway: realName });
  const me = w.client(addressOf(1));
  w.fund(me);
  const id = await w.cardPull(me);
  assert.equal(w.cardOf(id)?.status, "held");
  later(t, REVEAL_HOLD_MS + 20_000);
  const r = await w.call("GET", "/api/rip/pulls");
  assert.equal(r.body.pulls.length, 1);
  assert.equal(r.body.pulls[0].kind, "card");
  const sent = JSON.stringify(r.body);
  for (const secret of [addressOf(1), id, w.cardOf(id)?.mint, w.cardOf(id)?.txHash]) assert.ok(secret && !sent.includes(secret));

  const sim = await world({ cards: true });
  const you = sim.client(addressOf(2));
  sim.fund(you);
  await sim.cardPull(you);
  t.mock.restoreAll();
  later(t, REVEAL_HOLD_MS + 40_000);
  assert.deepEqual((await sim.call("GET", "/api/rip/pulls")).body.pulls, []);
});

test("the feed's route: off with the rails, and cacheable by the CDN, not by a browser", async () => {
  const off = await world({ off: true } as never);
  assert.equal((await off.call("GET", "/api/rip/pulls")).status, 404);
  const w = await world();
  const r = await w.call("GET", "/api/rip/pulls");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control") ?? "", /public.*max-age=0.*s-maxage=15/);
  assert.equal(r.headers.get("set-cookie"), null);
});
