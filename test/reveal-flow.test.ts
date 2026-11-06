import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { SUMMARY, encodeStep, fromSeen, nextLabel, nextStep, packCount, parseStep, resumeStep, skipStep, type FlowStep } from "../src/lib/reveal-flow.ts";

const stepArb = (max: number): fc.Arbitrary<FlowStep> =>
  fc.oneof(fc.constant(SUMMARY), fc.record({ view: fc.constantFrom<"bite" | "reveal">("bite", "reveal"), at: fc.integer({ min: 0, max }) }));

test("Next alone walks every pack in order, bite then reveal, and ends on the results", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), (total) => {
      // The first pack's bite plays on the open page, so the run here starts on its reveal.
      let step = resumeStep(null, total);
      const seen: FlowStep[] = [step];
      for (let i = 0; i < 4 * total && step.view !== "summary"; i++) {
        step = nextStep(step, total);
        seen.push(step);
      }
      assert.deepEqual(step, SUMMARY);
      const reveals = seen.filter((s) => s.view === "reveal").map((s) => (s as { at: number }).at);
      assert.deepEqual(reveals, Array.from({ length: total }, (_, i) => i), "each pack is revealed once, in order");
      const bites = seen.filter((s) => s.view === "bite").map((s) => (s as { at: number }).at);
      assert.deepEqual(bites, Array.from({ length: total - 1 }, (_, i) => i + 1), "every pack after the first gets its own bite");
      // Every reveal but the last was followed by the next pack's bite.
      for (let i = 0; i < seen.length - 1; i++) if (seen[i].view === "reveal") assert.ok(seen[i + 1].view === "bite" || (seen[i + 1].view === "summary" && (seen[i] as { at: number }).at === total - 1));
    }),
  );
});

test("Skip goes straight to the results from anywhere, and the results stay put", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), stepArb(25), (total, step) => {
      assert.deepEqual(skipStep(), SUMMARY);
      assert.deepEqual(nextStep(SUMMARY, total), SUMMARY);
      assert.deepEqual(resumeStep(SUMMARY, total), SUMMARY);
      // Next never jumps a pack and never goes back.
      const next = nextStep(step, total);
      if (step.view !== "summary" && next.view !== "summary") assert.ok(next.at === step.at || next.at === step.at + 1);
    }),
  );
});

test("a refresh picks up where it was, or on the results, and never points past the packs there are", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 20 }), fc.option(stepArb(30), { nil: null }), (total, saved) => {
      const at = resumeStep(saved, total);
      if (total === 0) return assert.deepEqual(at, SUMMARY);
      if (!saved) return assert.deepEqual(at, { view: "reveal", at: 0 });
      if (saved.view === "summary" || saved.at >= total) return assert.deepEqual(at, SUMMARY);
      assert.deepEqual(at, saved, "a place inside the run is kept as it was");
    }),
  );
  assert.deepEqual(resumeStep({ view: "reveal", at: -1 }, 5), { view: "reveal", at: 0 });
  assert.deepEqual(resumeStep({ view: "bite", at: 1.5 }, 5), { view: "reveal", at: 0 });
});

test("a saved place reads back exactly, and anything else reads as nothing saved", () => {
  fc.assert(fc.property(stepArb(999), (step) => assert.deepEqual(parseStep(encodeStep(step)), step)));
  for (const bad of [null, undefined, "", "reveal", "reveal:", "reveal:-1", "bite:1.5", "open:2", "reveal:1000", " summary", "summary "]) assert.equal(parseStep(bad), null, String(bad));
  fc.assert(fc.property(fc.string(), (raw) => {
    const step = parseStep(raw);
    if (step) assert.equal(encodeStep(step), raw);
  }));
});

test("a visit from the earlier quick run picks up on the last pull it showed", () => {
  assert.equal(fromSeen(0), null);
  assert.equal(fromSeen(Number.NaN), null);
  assert.equal(fromSeen(-3), null);
  assert.deepEqual(fromSeen(1), { view: "reveal", at: 0 });
  assert.deepEqual(fromSeen(4), { view: "reveal", at: 3 });
  assert.deepEqual(fromSeen(1000), SUMMARY);
});

test("the main button names the next pack and its place, and the last one says results", () => {
  assert.equal(nextLabel({ view: "reveal", at: 0 }, 10), "Next pack (2 of 10)");
  assert.equal(nextLabel({ view: "reveal", at: 8 }, 10), "Next pack (10 of 10)");
  assert.equal(nextLabel({ view: "reveal", at: 9 }, 10), "See results");
  assert.equal(packCount(0, 10), "PACK 1 OF 10");
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.nat(19), (total, i) => {
      fc.pre(i < total);
      const label = nextLabel({ view: "reveal", at: i }, total);
      if (i + 1 < total) assert.equal(label, `Next pack (${i + 2} of ${total})`);
      else assert.equal(label, "See results");
    }),
  );
});
