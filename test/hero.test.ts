import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { HERO_FILES, HERO_PACK } from "../src/lib/hero-art.ts";
import { EXCLUDED_COLLECTIONS } from "../src/config/nft-packs.ts";
import { heroSamples, nextSample, sampleSrc, shelfCollections, shortSampleName, withLiveNfts } from "../src/lib/hero-samples.ts";
import { POSE_LIMITS, approach, dripAt, idleRuns, jawAt, lidsAt, makeIdle, nextDrip, nextEyeBeat, nextTwitch, sampleNext, seeded, waxAt, nextTremble, type SampleEvent, type SampleState } from "../src/lib/hero-idle.ts";
import { winMultiple } from "../src/lib/format.ts";

const here = (rel: string) => new URL(rel, import.meta.url);
const seed = fc.integer({ min: 0, max: 0xffffffff });

test("every layer the hero can show is a real file", () => {
  for (const src of HERO_FILES) assert.ok(existsSync(here(`../public${src}`)), src);
});

test("the pack keeps slab proportions without its stand", () => {
  const ratio = HERO_PACK.w / HERO_PACK.h;
  assert.ok(ratio > 0.68 && ratio < 0.8, String(ratio));
  assert.ok(HERO_PACK.tear > HERO_PACK.wy && HERO_PACK.tear < 50);
});

test("blinks come at irregular gaps, never on a fixed count", () => {
  fc.assert(
    fc.property(seed, (s) => {
      const rng = seeded(s);
      const gaps = new Set<number>();
      let t = 0;
      for (let i = 0; i < 12; i++) {
        const beat = nextEyeBeat(rng, t);
        const gap = beat.at - t;
        assert.ok(gap >= 1800 && gap <= 7000, String(gap));
        assert.ok(beat.end > beat.at);
        gaps.add(Math.round(gap));
        t = beat.end;
      }
      assert.ok(gaps.size >= 10);
    }),
  );
});

test("a wink shuts one eye and leaves the other open; a blink shuts both; outside a beat both are open", () => {
  fc.assert(
    fc.property(seed, (s) => {
      const beat = nextEyeBeat(seeded(s), 0);
      assert.deepEqual(lidsAt(beat, beat.at - 1), { far: 0, near: 0 });
      assert.deepEqual(lidsAt(beat, beat.end), { far: 0, near: 0 });
      let shutFar = false;
      let shutNear = false;
      for (let t = beat.at; t < beat.end; t += 5) {
        const l = lidsAt(beat, t);
        shutFar ||= l.far === 2;
        shutNear ||= l.near === 2;
        if (beat.kind === "wink-far") assert.equal(l.near, 0);
        if (beat.kind === "wink-near") assert.equal(l.far, 0);
      }
      if (beat.kind === "wink-far") assert.ok(shutFar && !shutNear);
      else if (beat.kind === "wink-near") assert.ok(shutNear && !shutFar);
      else assert.ok(shutFar && shutNear);
    }),
  );
});

test("a drop swells, stretches, falls and fades, in that order, and only ever moves down", () => {
  fc.assert(
    fc.property(seed, (s) => {
      const d = nextDrip(seeded(s), 0);
      const order = ["wait", "swell", "stretch", "fall", "wait"];
      let at = 0;
      let lastDrop = 0;
      for (let t = 0; t < d.end + 50; t += 7) {
        const p = dripAt(d, t);
        while (order[at] !== p.phase) {
          at++;
          assert.ok(at < order.length, `${p.phase} out of order`);
        }
        assert.ok(p.opacity >= 0 && p.opacity <= 1);
        if (p.phase !== "wait") {
          assert.ok(p.drop >= lastDrop - 1e-9);
          lastDrop = p.drop;
          assert.ok(p.drop <= 1);
          assert.ok(p.sx > 0 && p.sy > 0);
        }
      }
      assert.ok(at >= 3);
      assert.ok(dripAt(d, d.fall - 1).opacity < 0.1, "fades before it ends");
    }),
  );
});

test("the idle stays inside its limits, forever and from any seed", () => {
  fc.assert(
    fc.property(seed, fc.array(fc.integer({ min: 1, max: 900 }), { minLength: 40, maxLength: 200 }), fc.double({ min: 0, max: 1, noNaN: true }), (s, steps, nudge) => {
      const idle = makeIdle(seeded(s), { sheenLayers: 4, drips: 3 });
      let t = 0;
      for (const dt of steps) {
        t += dt;
        const p = idle.at(t, nudge);
        assert.ok(Math.abs(p.pack.turn) <= POSE_LIMITS.packTurn + 1e-9);
        assert.ok(Math.abs(p.pack.scale - 1) <= POSE_LIMITS.packScale + 1e-9);
        assert.ok(Math.abs(p.pack.lift) <= POSE_LIMITS.packLift + 1e-9);
        assert.ok(Math.abs(p.seal.turn) <= POSE_LIMITS.sealTurn + 1e-9);
        assert.ok(Math.abs(p.seal.sy - 1) <= POSE_LIMITS.sealSquash + 1e-9);
        assert.ok(p.jaw >= 0 && p.jaw <= POSE_LIMITS.jaw + 1e-9);
        assert.equal(p.sheen.length, 4);
        for (const o of p.sheen) assert.ok(o >= 0 && o <= 1);
        assert.equal(p.drips.length, 3);
        // House rule: no bobbing. The pose has no vertical offset for the seal to use.
        assert.deepEqual(Object.keys(p.seal).sort(), ["sx", "sy", "turn"]);
      }
    }),
  );
});

test("the wax never shrinks below the copy it sits on", () => {
  fc.assert(
    fc.property(seed, fc.integer({ min: 0, max: 60000 }), (s, t) => {
      const w = waxAt(nextTremble(seeded(s), 0), t);
      assert.ok(w.scale >= 1 && w.scale <= 1 + POSE_LIMITS.waxScale + 1e-9);
      assert.ok(Math.abs(w.turn) <= POSE_LIMITS.waxTurn + 1e-9);
    }),
  );
});

test("the jaw only opens, and closes again by the end of a twitch", () => {
  fc.assert(
    fc.property(seed, (s) => {
      const tw = nextTwitch(seeded(s), 0);
      assert.equal(jawAt(tw, tw.at - 1), 0);
      assert.equal(jawAt(tw, tw.end), 0);
      for (let t = tw.at; t < tw.end; t += 11) assert.ok(jawAt(tw, t) >= 0);
    }),
  );
});

test("approach moves toward its target and never past it", () => {
  fc.assert(
    fc.property(fc.double({ min: -5, max: 5, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true }), fc.integer({ min: 0, max: 2000 }), (from, to, ms) => {
      const v = approach(from, to, ms);
      assert.ok(Math.abs(v - to) <= Math.abs(from - to) + 1e-9);
    }),
  );
});

const EVENTS: readonly SampleEvent[] = ["tap", "armed", "failed", "played", "release", "returned"];

test("a sample plays through and ends ready to play again, as many times as you like", () => {
  let s: SampleState = "idle";
  for (let i = 0; i < 5; i++) {
    for (const [e, want] of [["tap", "arming"], ["armed", "playing"], ["played", "holding"], ["release", "returning"], ["returned", "idle"]] as const) {
      s = sampleNext(s, e);
      assert.equal(s, want);
    }
  }
});

test("a tap only starts a play from idle, so a double tap can't stack two bites", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...EVENTS), { maxLength: 40 }), (events) => {
      let s: SampleState = "idle";
      for (const e of events) {
        const next = sampleNext(s, e);
        if (e === "tap" && s !== "idle") assert.equal(next, s);
        s = next;
      }
    }),
  );
});

test("layers that can't load send the tap back to idle instead of playing with a part missing", () => {
  assert.equal(sampleNext("arming", "failed"), "idle");
  assert.equal(sampleNext("idle", "armed"), "idle");
});

test("the idle pauses off screen, in a hidden tab, during a bite and under reduced motion", () => {
  fc.assert(
    fc.property(fc.constantFrom<SampleState>("idle", "arming", "playing", "holding", "returning"), fc.boolean(), fc.boolean(), fc.boolean(), (state, on, vis, reduced) => {
      assert.equal(idleRuns(state, on, vis, reduced), (state === "idle" || state === "arming") && on && vis && !reduced);
    }),
  );
});

test("the hero's sample draws nothing and calls nothing", () => {
  const src = ["../src/components/HeroStage.tsx", "../src/components/bite-run.ts", "../src/lib/hero-idle.ts", "../src/lib/hero-art.ts", "../src/components/idle-seal.tsx"].map((f) => readFileSync(here(f), "utf8")).join("\n");
  for (const banned of ["demoDraw", "fetch(", "/api/", "lib/rails", "lib/demo", "dispatch(", "Award"]) assert.ok(!src.includes(banned), banned);
});

test("the reveal's multiple is one decimal and an x", () => {
  fc.assert(
    fc.property(fc.double({ min: 0.01, max: 1e6, noNaN: true }), fc.double({ min: 0.01, max: 1e4, noNaN: true }), (value, paid) => {
      const m = winMultiple(value, paid);
      assert.ok(m);
      assert.match(m, /^[\d,]+\.\dx$/);
      const shown = Number(m.replace(/[,x]/g, ""));
      const ratio = value / paid;
      assert.ok(shown >= 0.1);
      assert.ok(Math.abs(shown - ratio) <= 0.05 + 1e-6 || (ratio < 0.05 && shown === 0.1), `${value}/${paid} shown ${m}`);
    }),
  );
});

test("the multiple rises with the value and falls with the price", () => {
  const num = (m: string | null) => Number(m?.replace(/[,x]/g, ""));
  fc.assert(
    fc.property(fc.double({ min: 0.01, max: 1e5, noNaN: true }), fc.double({ min: 0, max: 1e5, noNaN: true }), fc.double({ min: 1, max: 1000, noNaN: true }), (v, more, paid) => {
      assert.ok(num(winMultiple(v + more, paid)) >= num(winMultiple(v, paid)));
      assert.ok(num(winMultiple(v, paid + more)) <= num(winMultiple(v, paid)));
    }),
  );
});

test("the multiple's examples, and no number when there isn't an honest one", () => {
  assert.equal(winMultiple(85, 25), "3.4x");
  assert.equal(winMultiple(15, 25), "0.6x");
  assert.equal(winMultiple(25, 25), "1.0x");
  assert.equal(winMultiple(0.001, 100), "0.1x");
  assert.equal(winMultiple(12345, 10), "1,234.5x");
  for (const [v, p] of [[0, 25], [25, 0], [-1, 25], [25, -1], [NaN, 25], [25, NaN], [Infinity, 25], [1e308, 1e-308]]) assert.equal(winMultiple(v, p), null, `${v}/${p}`);
});

const col = (slug: string, names: readonly string[]) => ({ slug, name: slug, floor: 1, items: 10, samples: names.map((n, i) => ({ id: `${slug}${i}`, name: n, img: `/nfts/${slug}/${i}.webp` })) });

test("hero samples are real cards and NFTs from the shelf, in turn", () => {
  const shelf = shelfCollections();
  assert.ok(shelf.length > 0);
  const collections = Object.fromEntries(shelf.map((s) => [s, col(s, ["1", "2", "3"])]));
  const cards = [1, 2, 3].map((i) => ({ img: `https://d1xpxki1g4htqu.cloudfront.net/${i}.jpg`, name: `Card ${i}` }));
  const out = heroSamples({ cards, collections });
  assert.deepEqual(out.slice(0, 4).map((s) => s.kind), ["card", "nft", "card", "nft"]);
  assert.ok(out.length <= 16);
  assert.equal(new Set(out.map((s) => s.img)).size, out.length);
  assert.ok(out.filter((s) => s.kind === "nft").every((s) => s.img.startsWith("/nfts/")));
});

test("hero samples never show an excluded collection or the withheld SEAL #449", () => {
  const collections = { ...Object.fromEntries(EXCLUDED_COLLECTIONS.map((s) => [s, col(s, ["1"])])), ...Object.fromEntries(shelfCollections().map((s) => [s, col(s, ["449", "SEAL #449", "1449", "7"])])) };
  const out = heroSamples({ cards: [], collections });
  assert.ok(out.length > 0);
  for (const s of out) {
    assert.doesNotMatch(s.name, /(^|[^0-9])449([^0-9]|$)/);
    assert.ok(!EXCLUDED_COLLECTIONS.some((x) => s.img.startsWith(`/nfts/${x}/`)));
  }
});

test("hero samples with nothing to show leave the sealed slab", () => {
  assert.deepEqual(heroSamples({ cards: [], collections: {} }), []);
  assert.equal(nextSample(0, -1), -1);
});

test("the next sample goes through the whole list before any repeat", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 30 }), (count) => {
      const seen = new Set<number>();
      let at = -1;
      for (let i = 0; i < count; i++) {
        const n = nextSample(count, at);
        assert.notEqual(n, at);
        seen.add(n);
        at = n;
      }
      assert.equal(seen.size, count);
    }),
  );
});

test("a slab photo goes through the image route, an NFT's own file doesn't", () => {
  assert.equal(sampleSrc({ kind: "nft", img: "/nfts/x/1.webp" }), "/nfts/x/1.webp");
  assert.equal(sampleSrc({ kind: "nft", img: "/api/rip/art/0123456789abcdef0123456789abcdef01234567" }), "/_next/image?url=%2Fapi%2Frip%2Fart%2F0123456789abcdef0123456789abcdef01234567&w=640&q=75");
  assert.equal(sampleSrc({ kind: "card", img: "https://d1xpxki1g4htqu.cloudfront.net/a b.jpg" }), "/_next/image?url=https%3A%2F%2Fd1xpxki1g4htqu.cloudfront.net%2Fa%20b.jpg&w=640&q=75");
});

test("a long slab name is cut on a word for the status line, a short one stays whole", () => {
  assert.equal(shortSampleName("XPUNKS #909"), "XPUNKS #909");
  assert.equal(shortSampleName("2026 #OP13016 Monkey.D.Garp R/(Treasure Cup March '26 Top 64 Prize) BGS 10"), "2026 #OP13016 Monkey.D.Garp R/(Treasure Cup…");
  fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => { assert.ok(shortSampleName(s).length <= 45); }));
});

test("with rails on, every NFT in the hero is one from the live pool, each once, cards still in turn", () => {
  const cards = [{ kind: "card" as const, img: "c1", name: "Card 1" }, { kind: "card" as const, img: "c2", name: "Card 2" }];
  fc.assert(
    fc.property(fc.array(fc.record({ img: fc.string({ minLength: 1 }), name: fc.string() })), (live) => {
      const out = withLiveNfts(cards, live);
      const pool = new Set(live.map((n) => n.img));
      const nfts = out.filter((s) => s.kind === "nft");
      for (const n of nfts) assert.ok(pool.has(n.img));
      assert.equal(new Set(nfts.map((n) => n.img)).size, nfts.length);
      assert.ok(out.length <= 16);
      assert.deepEqual(out.filter((s) => s.kind === "card"), cards);
    }),
  );
  // No pool yet: no NFT at all, rather than one from the plan.
  assert.deepEqual(withLiveNfts(cards, []), cards);
});
