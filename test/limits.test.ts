import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { ACT_LIMIT, IP_LIMIT, READ_LIMIT, RATE_WINDOW_MS, accountBucket, createLimiter, ipBucket, quoteUnless, type Purpose } from "../src/lib/rip/limits.ts";

const who = (address: string, proven = true) => ({ address, proven });

test("limits, property: within one window a bucket lets through exactly its limit, and refused tries spend nothing", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 120 }), (limit, tries) => {
      const lim = createLimiter();
      const b = [{ key: "k", limit }];
      let ok = 0;
      for (let i = 0; i < tries; i++) if (lim.take(b, 1000 + i)) ok++;
      assert.equal(ok, Math.min(limit, tries));
      // A full window later, it has room again however many were refused.
      assert.equal(lim.take(b, 1000 + tries + RATE_WINDOW_MS), true);
    }),
  );
});

test("limits, property: quotes and status looks can never use up an account's presses, and the other way round", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom<Purpose>("read", "act"), { maxLength: 400 }), (seq) => {
      const lim = createLimiter();
      const used = { read: 0, act: 0 };
      for (const [i, p] of seq.entries()) if (lim.take([accountBucket("1.2.3.4", who("rA"), p)], i)) used[p]++;
      const asked = { read: seq.filter((p) => p === "read").length, act: seq.filter((p) => p === "act").length };
      assert.equal(used.read, Math.min(asked.read, READ_LIMIT));
      assert.equal(used.act, Math.min(asked.act, ACT_LIMIT));
    }),
  );
});

test("limits: a page that spends every quote still leaves the sale it was pressed for", () => {
  const lim = createLimiter();
  for (let i = 0; i < READ_LIMIT + 50; i++) lim.take([accountBucket("1.2.3.4", who("rA"), "read")], i);
  assert.equal(lim.take([accountBucket("1.2.3.4", who("rA"), "act")], 500), true);
});

test("limits, property: accounts sharing one connection each get their own budget, up to the connection's flood ceiling", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 30 }), (people) => {
      const lim = createLimiter();
      let passed = 0;
      for (let p = 0; p < people; p++) for (let i = 0; i < ACT_LIMIT; i++) if (lim.take([ipBucket("10.0.0.1")], i) && lim.take([accountBucket("10.0.0.1", who(`r${p}`), "act")], i)) passed++;
      assert.equal(passed, Math.min(people * ACT_LIMIT, IP_LIMIT));
    }),
  );
});

test("limits, property: an unproven launch naming someone's account can't spend that account's own budget", () => {
  fc.assert(
    fc.property(fc.ipV4(), fc.ipV4(), (a, b) => {
      fc.pre(a !== b);
      const lim = createLimiter();
      for (let i = 0; i < ACT_LIMIT * 2; i++) lim.take([accountBucket(a, who("rVictim", false), "act")], i);
      assert.equal(lim.take([accountBucket(b, who("rVictim", true), "act")], 10), true, "the real owner, signed in");
      assert.equal(lim.take([accountBucket(b, who("rVictim", false), "act")], 10), true, "the owner's own launch, elsewhere");
    }),
  );
});

test("limits: a body says what a call is for; with no body, or without the deciding field, it's a quote", () => {
  const sell = quoteUnless("drops") as (b: Record<string, unknown> | null) => Purpose;
  assert.equal(sell(null), "read");
  assert.equal(sell({}), "read");
  assert.equal(sell({ drops: "100" }), "act");
  const payouts = quoteUnless("items") as (b: Record<string, unknown> | null) => Purpose;
  assert.equal(payouts({ ids: ["a"] }), "read");
  assert.equal(payouts({ items: [] }), "act");
});

test("every guarded quote and status look says so, and everything else spends from presses", () => {
  const route = (p: string) => readFileSync(new URL(`../src/app/api/rip/${p}/route.ts`, import.meta.url), "utf8");
  assert.match(route("wallet-request"), /purpose: "read"/);
  assert.match(route("orders/[id]/sell"), /purpose: quoteUnless\("drops"\)/);
  assert.match(route("cards/[id]/sell"), /purpose: quoteUnless\("drops"\)/);
  assert.match(route("payouts"), /purpose: quoteUnless\("items"\)/);
  assert.match(route("orders/[id]/redeem"), /b\?\.poll === true \? "read" : "act"/);
  for (const p of ["orders", "cards", "bundles", "orders/[id]/claim", "cards/[id]/claim", "cards/[id]/ship"]) assert.doesNotMatch(route(p), /purpose:/, p);
});
