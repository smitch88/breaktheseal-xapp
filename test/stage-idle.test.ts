import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { GAZE, HERO_ART, HERO_BOX, SEAL_PX } from "../src/lib/hero-art.ts";
import { makeIdle, seeded } from "../src/lib/hero-idle.ts";
import { RIP_ART, RIP_LAYERS, RIP_RAYS, ripParts } from "../src/lib/rip-art.ts";
import { STAGE_MOTION, depthShift, gazeToward, glintShift, pointerIn, raysAngle } from "../src/lib/stage-idle.ts";

const here = (rel: string) => new URL(rel, import.meta.url);
const coord = fc.double({ min: -5000, max: 5000, noNaN: true });
const size = fc.double({ min: 1, max: 4000, noNaN: true });

test("the pointer in the zone stays between -1 and 1 and is 0 at the center", () => {
  fc.assert(
    fc.property(coord, coord, coord, coord, size, size, (x, y, left, top, width, height) => {
      const p = pointerIn(x, y, { left, top, width, height });
      assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1);
      const c = pointerIn(left + width / 2, top + height / 2, { left, top, width, height });
      assert.ok(Math.abs(c.x) < 1e-6 && Math.abs(c.y) < 1e-6);
    }),
  );
  assert.deepEqual(pointerIn(10, 10, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0 });
});

test("the depths shift by a few pixels at most, with the rays against the nearer seal against the pack, and not at all at rest", () => {
  fc.assert(
    fc.property(coord, coord, size, (x, y, short) => {
      const s = depthShift({ x, y }, short);
      for (const [v, k] of [[s.rays, STAGE_MOTION.rays], [s.pack, STAGE_MOTION.pack], [s.seal, STAGE_MOTION.seal]] as const) {
        assert.ok(Math.abs(v.x) <= k * short + 1e-9 && Math.abs(v.y) <= k * short + 1e-9);
      }
      assert.ok(s.rays.x * s.seal.x <= 0 && s.rays.y * s.seal.y <= 0, "the rays and the seal go opposite ways");
      assert.ok(Math.abs(s.seal.x) >= Math.abs(s.pack.x), "the nearer layer moves more");
    }),
  );
  const rest = depthShift({ x: 0, y: 0 }, 800);
  assert.deepEqual([rest.rays.x, rest.pack.x, rest.seal.y].map(Math.abs), [0, 0, 0]);
  // Restrained on the biggest screen this runs on: under 25px for the rays, under 15px for the seal.
  const wide = depthShift({ x: 1, y: 1 }, 1100);
  assert.ok(wide.rays.x < 25 && Math.abs(wide.seal.x) < 15);
});

test("the rays only ever turn one way, and the pointer leans them by a few degrees at most", () => {
  fc.assert(
    fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), fc.double({ min: 1, max: 1e5, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), (t, dt, lean) => {
      assert.ok(raysAngle(t + dt, lean) > raysAngle(t, lean));
      assert.ok(Math.abs(raysAngle(t, lean) - raysAngle(t, 0)) <= STAGE_MOTION.raysLean + 1e-9);
    }),
  );
});

test("the gaze stays in the unit circle and points at the pointer", () => {
  fc.assert(
    fc.property(coord, coord, coord, coord, size, (px, py, hx, hy, reach) => {
      const g = gazeToward({ x: px, y: py }, { x: hx, y: hy }, reach);
      assert.ok(Math.hypot(g.x, g.y) <= 1 + 1e-9);
      assert.ok(g.x * (px - hx) >= 0 && g.y * (py - hy) >= 0);
    }),
  );
  assert.deepEqual(gazeToward({ x: 5, y: 5 }, { x: 1, y: 1 }, 0), { x: 0, y: 0 });
});

test("a highlight stays inside the limit the bake checked against the art, on both eyes, for any gaze", () => {
  const eyes = [
    [GAZE.far, HERO_BOX.lidFar],
    [GAZE.near, HERO_BOX.lidNear],
  ] as const;
  fc.assert(
    fc.property(coord, coord, coord, coord, size, (px, py, hx, hy, reach) => {
      const g = gazeToward({ x: px, y: py }, { x: hx, y: hy }, reach);
      for (const [limit, b] of eyes) {
        const boxPx = { x: (b[2] / 100) * SEAL_PX.w, y: (b[3] / 100) * SEAL_PX.h };
        const s = glintShift(g, limit, boxPx);
        const dx = (s.x / 100) * boxPx.x;
        const dy = (s.y / 100) * boxPx.y;
        assert.ok((dx / limit.x) ** 2 + (dy / limit.y) ** 2 <= 1 + 1e-9);
      }
    }),
  );
});

test("without lift the pack never moves up or down, and the rest of the idle is the hero's own", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 0xffffffff }), (s) => {
      const opts = { sheenLayers: 4, drips: 3 };
      const grounded = makeIdle(seeded(s), { ...opts, lift: false });
      const hero = makeIdle(seeded(s), opts);
      for (let t = 0; t < 40000; t += 613) {
        const a = grounded.at(t);
        const b = hero.at(t);
        assert.equal(a.pack.lift, 0);
        assert.deepEqual({ ...a, pack: { ...a.pack, lift: 0 } }, { ...b, pack: { ...b.pack, lift: 0 } });
      }
    }),
    { numRuns: 30 },
  );
});

test("every layer the stage's idle shows is a real file, on every pack", () => {
  const on = (src: string) => existsSync(here(`../public${src}`));
  assert.ok(on(RIP_RAYS));
  for (const e of Object.values(HERO_ART.eye)) for (const src of Object.values(e)) assert.ok(on(src), src);
  for (const art of Object.keys(RIP_ART)) {
    const p = ripParts(art);
    assert.equal(p.sheen.length, 4, art);
    for (const src of p.sheen) assert.ok(on(src), src);
    if (p.wax) assert.ok(on(p.wax), p.wax);
  }
});

test("only the card pack, which is the hero's own art, wears the hero's light and wax", () => {
  assert.deepEqual(ripParts("/assets/stage-pack.webp").sheen, HERO_ART.sheen);
  assert.equal(ripParts("/assets/stage-pack.webp").wax, HERO_ART.wax);
  for (const key of Object.keys(RIP_ART).filter((k) => k !== "/assets/stage-pack.webp")) {
    assert.equal(ripParts(key).wax, null, key);
    for (const s of ripParts(key).sheen) assert.ok(!HERO_ART.sheen.includes(s), s);
  }
});

test("the bite is gated on the seal the idle uses", () => {
  assert.ok(RIP_LAYERS.includes(HERO_ART.seal));
  assert.ok(!RIP_LAYERS.some((s) => s.includes("seal-open")));
});

test("the stage's idle moves pictures and nothing else: no calls, no draw, no ledger, no filters or blend modes", () => {
  const src = ["../src/components/stage-idle-run.ts", "../src/components/idle-seal.tsx", "../src/lib/stage-idle.ts"].map((f) => readFileSync(here(f), "utf8")).join("\n");
  for (const banned of ["demoDraw", "fetch(", "/api/", "lib/rails", "lib/demo", "dispatch(", "Award", "filter:", "mix-blend", "mask"]) assert.ok(!src.includes(banned), banned);
});
