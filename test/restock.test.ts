import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { RESTOCK_LINE, checkoutView, holdsCheckout, packAvailability, readRefusal, shelfRestocking, type PackAvailability } from "../src/lib/live/restock.ts";
import { sharedPoll, type PollDeps } from "../src/lib/live/shared-poll.ts";
import { SUPPORT } from "../src/lib/legal/content.ts";
import { poolRoot, sealEvents } from "../src/lib/rip/log.ts";
import { addressOf, world } from "./support-routes.ts";

const PLAYER = addressOf(1);
const tiers = (open: Record<number, boolean>) => ({ tiers: Object.entries(open).map(([price, o]) => ({ price: Number(price), open: o })) }) as never;

test("the server's config decides the pack: closed reads restocking, open reads open, and a reopen clears on the next read", () => {
  assert.equal(packAvailability("mainnet", tiers({ 5: true, 10: false }), 5), "open");
  assert.equal(packAvailability("mainnet", tiers({ 5: true, 10: false }), 10), "restocking");
  assert.equal(packAvailability("mainnet", tiers({ 5: true, 10: true }), 10), "open");
  // Not on the shelf the server described: it can't be bought.
  assert.equal(packAvailability("mainnet", tiers({ 5: true }), 10), "restocking");
  // No answer yet isn't a closed pack.
  assert.equal(packAvailability("mainnet", null, 10), "checking");
});

test("demo mode never closes anything, whatever config says", () => {
  fc.assert(fc.property(fc.boolean(), fc.constantFrom(5, 10, 25), (open, price) => {
    assert.equal(packAvailability("demo", tiers({ [price]: open }), price), "open");
    assert.equal(packAvailability("demo", null, price), "open");
    assert.equal(shelfRestocking("demo", tiers({ [price]: open }), [price]), false);
  }));
});

test("the hero is stamped only when nothing on the shelf can be bought", () => {
  assert.equal(shelfRestocking("mainnet", tiers({ 5: true, 10: false }), [5, 10]), false);
  assert.equal(shelfRestocking("mainnet", tiers({ 5: false, 10: false }), [5, 10]), true);
  assert.equal(shelfRestocking("mainnet", null, [5, 10]), false);
  assert.equal(shelfRestocking("mainnet", tiers({}), []), false);
});

test("every refusal that closes a pack reads as the one plain line, and other refusals keep their own words", () => {
  for (const code of ["restocking", "not_open", "season_full", "no_rate", "rate_moved", "prize_paused"]) assert.deepEqual(readRefusal({ status: 409, body: { code, error: "the engine's own words" } }), { kind: "restocking" }, code);
  for (const code of ["too_many", "busy", "terms_required", "place_restricted"]) assert.deepEqual(readRefusal({ status: 409, body: { code, error: "own words" } }), { kind: "problem", text: "own words" }, code);
  // The launch allowlist turning a wallet away isn't a closed pack.
  assert.equal(readRefusal({ status: 403, body: { code: "not_open", error: "Packs aren't open yet." } }).kind, "problem");
  assert.equal(readRefusal({ status: 401, body: {} }).kind, "problem");
  assert.equal(readRefusal({ status: 503, body: {} }).kind, "problem");
});

test("the words a player sees about a closed pack never give a reason", () => {
  const paused = SUPPORT.sections.find((s) => s.id === "paused");
  const items = paused?.blocks.flatMap((b) => (typeof b === "object" && "items" in b ? b.items : [])) ?? [];
  const restock = items.filter((t) => /restocking/i.test(t));
  assert.equal(restock.length, 1);
  for (const words of [RESTOCK_LINE, ...restock]) assert.doesNotMatch(words, /treasury|float|wallet is|short|low|funds|price|rtp|edge/i, words);
  assert.ok(restock[0].startsWith(RESTOCK_LINE));
});

test("an order on screen or held always gets to pay, and a refusal outranks one we only remember", () => {
  const state = fc.record({ availability: fc.constantFrom<PackAvailability>("checking", "open", "restocking"), refused: fc.boolean(), held: fc.boolean() });
  fc.assert(fc.property(state, (s) => assert.equal(checkoutView({ ...s, showing: true }), "pay")));
  fc.assert(fc.property(state, (s) => {
    const view = checkoutView({ ...s, showing: false });
    if (s.refused) assert.equal(view, "restocking");
    else if (s.held) assert.equal(view, "pay");
    else assert.equal(view, s.availability === "open" ? "pay" : s.availability);
  }));
  assert.equal(holdsCheckout({ nft: [10], cards: ["a"] }, { kind: "nft", price: 10 }), true);
  assert.equal(holdsCheckout({ nft: [10], cards: ["a"] }, { kind: "nft", price: 5 }), false);
  assert.equal(holdsCheckout({ nft: [10], cards: ["a"] }, { kind: "card", code: "a" }), true);
  assert.equal(holdsCheckout(null, { kind: "card", code: "a" }), false);
});

/** A page's clock: timers run only when the test says time passed. */
function page() {
  let now = 0;
  let visible = true;
  let timers: { at: number; fn: () => void }[] = [];
  const deps: PollDeps = {
    now: () => now,
    after: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => void (timers = timers.filter((x) => x !== t));
    },
    visible: () => visible,
  };
  const pass = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now);
      if (!due.length) break;
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.fn());
      await new Promise((r) => setImmediate(r));
    }
  };
  return { deps, pass, hide: (h: boolean) => (visible = !h), pending: () => timers.length };
}

test("however many things on a page want the config, it's one read, at the shortest interval anyone asked for", async () => {
  const p = page();
  let reads = 0;
  const poll = sharedPoll(async () => ++reads, p.deps);
  const heard: number[][] = [[], [], [], [], []];
  const off = heard.map((list, i) => poll.subscribe((v) => list.push(v), i === 0 ? 20_000 : 60_000));
  await p.pass(0);
  assert.equal(reads, 1);
  assert.ok(heard.every((l) => l.length === 1));
  await p.pass(20_000);
  assert.equal(reads, 2);
  await p.pass(60_000);
  assert.equal(reads, 3);
  // A newcomer hears the last answer at once and costs no read while one isn't due.
  const late: number[] = [];
  const offLate = poll.subscribe((v) => late.push(v), 60_000);
  assert.deepEqual(late, [3]);
  await p.pass(0);
  assert.equal(reads, 3);
  offLate();
  off.forEach((f) => f());
  assert.equal(p.pending(), 0);
  await p.pass(600_000);
  assert.equal(reads, 3);
});

test("a hidden tab reads nothing and catches up when it comes back", async () => {
  const p = page();
  let reads = 0;
  const poll = sharedPoll(async () => ++reads, p.deps);
  poll.subscribe(() => {}, 60_000);
  await p.pass(0);
  p.hide(true);
  await p.pass(600_000);
  assert.equal(reads, 1);
  p.hide(false);
  poll.wake();
  await p.pass(0);
  assert.equal(reads, 2);
});

test("a failed read keeps the last answer, and a pack reopening reaches the page with no reload", async () => {
  const p = page();
  const answers: (string | null | Error)[] = ["closed", null, new Error("rpc"), "open"];
  const poll = sharedPoll(async () => {
    const a = answers.shift() as string | null | Error;
    if (a instanceof Error) throw a;
    return a;
  }, p.deps);
  const heard: string[] = [];
  poll.subscribe((v) => heard.push(v), 20_000);
  await p.pass(0);
  await p.pass(20_000);
  await p.pass(20_000);
  assert.deepEqual(heard, ["closed"]);
  await p.pass(20_000);
  assert.deepEqual(heard, ["closed", "open"]);
});

test("by route: a thin pack reads closed in config, and the order it refuses shows the same plain line, with no order made", async () => {
  const w = await world();
  const me = w.client(PLAYER);
  w.fund(me);
  await w.open(5, "4000000", [1, 1, 1, 1, 0]);
  const config = await w.call("GET", "/api/rip/config");
  assert.equal(packAvailability("mainnet", config.body as never, 5), "restocking");
  const refused = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(refused.body.code, "restocking");
  assert.equal(refused.status, 409);
  assert.deepEqual(readRefusal(refused), { kind: "restocking" });
  assert.deepEqual((await w.call("GET", "/api/rip/orders", { as: me })).body.open, { nft: [], cards: [] });
});

test("by route: a pack that closes on an open order still lets that wallet pay it, and no one else gets in", async () => {
  const w = await world();
  const me = w.client(PLAYER);
  const other = w.client(addressOf(2));
  w.fund(me);
  w.fund(other);
  await w.open(5);
  const made = await w.newOrder(me);
  assert.deepEqual((await w.call("GET", "/api/rip/orders", { as: me })).body.open, { nft: [5], cards: [] });
  // Close the pack from under the order: every lot leaves the pool. The stock rule stops the engine doing this itself, so it's forced at the log.
  await w.engine.sync();
  const removes = [...w.engine.state.lots.values()].filter((l) => l.price === 5 && l.status === "available").map((l) => l.lot);
  assert.ok(removes.length > 0);
  assert.ok(await w.store.append(w.engine.state.head, sealEvents(w.engine.state.head, w.engine.state.headHash, [{ type: "pool_change", data: { id: "force-empty", price: 5, adds: [], removes, root: poolRoot(5, [], removes) } }], new Date().toISOString())));
  w.ledger.close();
  await w.pump(4);
  assert.equal(packAvailability("mainnet", (await w.call("GET", "/api/rip/config")).body as never, 5), "restocking");
  // The wallet that holds it is told so, and Pay hands back the very same order.
  assert.deepEqual((await w.call("GET", "/api/rip/orders", { as: me })).body.open.nft, [5]);
  const again = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(again.status, 200);
  assert.equal(again.body.order.id, made.order.id);
  // Anyone else sees a closed pack.
  assert.deepEqual((await w.call("GET", "/api/rip/orders", { as: other })).body.open.nft, []);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: other, body: { price: 5 } })).status, 409);
});

test("the open-checkouts read is the wallet's own and needs a sign-in", async () => {
  const w = await world();
  await w.open(5);
  assert.equal((await w.call("GET", "/api/rip/orders")).status, 401);
});
