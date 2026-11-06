import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ITEMS_TTL_S, CATALOG_TTL_S, FAN_TTL_S, SOURCE_ORIGIN, assertReadRoute, createCatalogSource, type CachedGet, type CatalogSnapshot } from "../src/lib/catalog/source.ts";
import { createCooldown } from "../src/lib/cooldown.ts";
import { parseFloors, parseXrpUsd, readMarket, COLLECTIONS_URL } from "../src/lib/nft/source.ts";
import type { Item, Machine } from "../src/lib/catalog/types.ts";
import type { NftSnapshot } from "../src/lib/nft/view.ts";

const item = (id: string, rarity: Item["rarity"] = "epic", code = "pokemon_25"): Item => ({ id, name: `Card ${id}`, rarity, ins: 100, grade: "PSA 10", img: `https://d1xpxki1g4htqu.cloudfront.net/${id}`, code });
const machine = (code: string, o: Partial<Machine> = {}): Machine => ({ code, name: code, cat: "Pokémon", price: 25, bb: 85, rates: [75, 20, 4, 1], stock: 10, fan: [item(`snap-${code}`, "epic", code)], ...o });
const snapshot: CatalogSnapshot = { asOf: "2026-11-01T00:00:00.000Z", machines: [machine("pokemon_25"), machine("gone_50", { price: 50 })] };

const liveMachines = { machines: [{ code: "pokemon_25", name: "Starter Pokémon Gacha Pack", price: 30, instantBuyback: 90, odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 }, stock: { common: 5 } }] };
const liveNft = (id: string, rarity = "epic") => ({ id, description: `Card ${id}`, rarity, image: `https://d1xpxki1g4htqu.cloudfront.net/${id}`, insured_value: 10 });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

test("live data wins and the copy is marked fresh", async () => {
  const src = createCatalogSource(async () => ok(liveMachines), snapshot);
  const view = await src.catalog();
  assert.equal(view.stale, false);
  assert.equal(view.machines.length, 1);
  assert.equal(view.machines[0].price, 30);
  assert.equal(view.machines[0].bb, 90);
  assert.equal(view.machines[0].fan[0].id, "snap-pokemon_25");
});

for (const [label, get] of [
  ["a thrown network error", async () => { throw new Error("down"); }],
  ["a 500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
  ["a 429", async () => ({ ok: false, status: 429, json: async () => ({}) })],
  ["HTML at 200", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("<html>"); } })],
  ["an empty list at 200", async () => ok({ machines: [] })],
  ["a wrong shape at 200", async () => ok({ nope: 1 })],
] as [string, CachedGet][]) {
  test(`the catalog survives ${label}: snapshot served, flagged stale`, async () => {
    const view = await createCatalogSource(get, snapshot).catalog();
    assert.equal(view.stale, true);
    assert.equal(view.asOf, snapshot.asOf);
    assert.deepEqual(view.machines.map((m) => m.code), ["pokemon_25", "gone_50"]);
  });

  test(`items survive ${label}: snapshot fan for that tier, flagged stale`, async () => {
    const src = createCatalogSource(get, snapshot);
    const epic = await src.items("pokemon_25", "epic");
    assert.equal(epic.stale, true);
    assert.deepEqual(epic.items.map((i) => i.id), ["snap-pokemon_25"]);
    const pool = await src.pool("pokemon_25");
    assert.equal(pool.stale, true);
    assert.deepEqual(pool.items.map((i) => i.id), ["snap-pokemon_25"]);
  });
}

test("no failure pattern can make the catalog throw or come back empty", async () => {
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.constant("throw"), fc.integer({ min: 300, max: 599 }), fc.anything()), async (mode) => {
      const get: CachedGet = async () => {
        if (mode === "throw") throw new Error("down");
        if (typeof mode === "number") return { ok: false, status: mode, json: async () => ({}) };
        return ok(mode);
      };
      const view = await createCatalogSource(get, snapshot).catalog();
      assert.ok(view.machines.length > 0);
    }),
  );
});

test("reads use the canonical parameter order and the right cache window", async () => {
  const calls: [string, number][] = [];
  const get: CachedGet = async (url, ttl) => {
    calls.push([url, ttl]);
    return ok(url.includes("machines") ? liveMachines : { nfts: [liveNft("a")] });
  };
  const src = createCatalogSource(get, snapshot);
  await src.catalog();
  await src.items("pokemon_25", "rare");
  await src.withFans([machine("pokemon_25")]);
  assert.deepEqual(calls, [
    [`${SOURCE_ORIGIN}/api/machines`, CATALOG_TTL_S],
    [`${SOURCE_ORIGIN}/api/getNfts?code=pokemon_25&rarity=rare&limit=12`, ITEMS_TTL_S],
    [`${SOURCE_ORIGIN}/api/getNfts?code=pokemon_25&limit=3`, FAN_TTL_S],
  ]);
});

test("only the two read routes can ever be requested", () => {
  assert.doesNotThrow(() => assertReadRoute(`${SOURCE_ORIGIN}/api/machines`));
  assert.doesNotThrow(() => assertReadRoute(`${SOURCE_ORIGIN}/api/getNfts?code=x`));
  for (const route of ["/api/generatePack", "/api/submitTransaction", "/api/openPack", "/api/buyback", "/api/status"]) assert.throws(() => assertReadRoute(SOURCE_ORIGIN + route));
  assert.throws(() => assertReadRoute("https://evil.example/api/machines"));
});

test("a bad machine code never reaches the source", async () => {
  let calls = 0;
  const src = createCatalogSource(async () => { calls++; return ok({ nfts: [] }); }, snapshot);
  assert.deepEqual((await src.items("../../x", "epic")).items, []);
  assert.equal(calls, 0);
});

test("fans: live items replace the snapshot, sold-out packs make no call, a failure keeps the snapshot fan", async () => {
  const seen: string[] = [];
  const get: CachedGet = async (url) => {
    seen.push(url);
    if (url.includes("broken_25")) throw new Error("down");
    return ok({ nfts: [liveNft("a"), liveNft("b"), liveNft("c"), liveNft("d")] });
  };
  const rows = await createCatalogSource(get, snapshot).withFans([machine("pokemon_25"), machine("broken_25"), machine("out_25", { stock: 0 })]);
  assert.deepEqual(rows[0].fan.map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(rows[1].fan.map((i) => i.id), ["snap-broken_25"]);
  assert.equal(seen.some((u) => u.includes("out_25")), false);
});

test("fans: at most six calls at once, and a slow source can't hold a page past the deadline", async () => {
  let open = 0;
  let peak = 0;
  const get: CachedGet = async () => {
    open++;
    peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, 40));
    open--;
    return ok({ nfts: [liveNft("a")] });
  };
  const started = Date.now();
  const rows = await createCatalogSource(get, snapshot).withFans(Array.from({ length: 60 }, (_, i) => machine(`m_${i}`)), 100);
  assert.ok(Date.now() - started < 400);
  assert.ok(peak <= 6, `peak ${peak}`);
  assert.equal(rows.length, 60);
  assert.equal(rows[59].fan[0].id, "snap-m_59");
});

const collection = (slug: string, floor: number) => ({ slug, name: slug, floor, items: 10, samples: [{ id: "1", name: "1", img: `/nfts/${slug}/1.webp` }] });
const nftSnap: NftSnapshot = { asOf: "2026-11-01T00:00:00.000Z", xrpUsd: 1.25, collections: { a: collection("a", 10), b: collection("b", 20) } };

test("XRP rate reads xrpl.to's exch.USD as XRP per dollar", () => {
  assert.ok(Math.abs((parseXrpUsd({ exch: { USD: 0.8 } }) as number) - 1.25) < 1e-9);
  for (const bad of [null, {}, { exch: {} }, { exch: { USD: 0 } }, { exch: { USD: -1 } }, { exch: { USD: "x" } }, { exch: { USD: 1e-9 } }]) assert.equal(parseXrpUsd(bad), null);
});

test("floors read numbers or {amount} and ignore junk", () => {
  const f = parseFloors({ collections: [{ slug: "a", floor: 5 }, { slug: "b", floor: { amount: 7 } }, { slug: "c", floor: 0 }, { slug: 3, floor: 3 }, null] });
  assert.deepEqual([...f.entries()], [["a", 5], ["b", 7]]);
  assert.equal(parseFloors({ success: false, error: "Rate limit exceeded" }).size, 0);
});

test("market overlays live floors and keeps the snapshot art", async () => {
  const get: CachedGet = async (url) => ok(url === COLLECTIONS_URL ? { collections: [{ slug: "a", floor: 99 }, { slug: "b", floor: 50 }] } : { exch: { USD: 0.5 } });
  const m = await readMarket(get, nftSnap, ["a", "b"]);
  assert.equal(m.collections.a.floor, 99);
  assert.equal(m.collections.a.samples[0].img, "/nfts/a/1.webp");
  assert.equal(m.xrpUsd, 2);
  assert.equal(m.stale, false);
});

test("market falls back to the snapshot when xrpl.to fails, and says so", async () => {
  const m = await readMarket(async () => { throw new Error("rate limited"); }, nftSnap, ["a", "b"]);
  assert.equal(m.stale, true);
  assert.equal(m.collections.b.floor, 20);
  assert.equal(m.xrpUsd, 1.25);
});

test("a picked collection missing from the live list keeps its snapshot floor and marks the view stale", async () => {
  const get: CachedGet = async (url) => ok(url === COLLECTIONS_URL ? { collections: [{ slug: "a", floor: 99 }] } : { exch: { USD: 0.8 } });
  const m = await readMarket(get, nftSnap, ["a", "b"]);
  assert.equal(m.collections.a.floor, 99);
  assert.equal(m.collections.b.floor, 20);
  assert.equal(m.stale, true);
});

test("a failed upstream rests for its window, then gets one more try", () => {
  let now = 0;
  const c = createCooldown(1000, () => now);
  assert.equal(c.resting("a"), false);
  c.failed("a");
  assert.equal(c.resting("a"), true);
  assert.equal(c.resting("b"), false);
  now = 999;
  assert.equal(c.resting("a"), true);
  now = 1000;
  assert.equal(c.resting("a"), false);
  c.failed("a");
  c.ok("a");
  assert.equal(c.resting("a"), false);
});

test("market reads never overlap, so they stay inside the per-second limit", async () => {
  let open = 0;
  let peak = 0;
  const get: CachedGet = async (url) => {
    open++;
    peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, 5));
    open--;
    return ok(url === COLLECTIONS_URL ? { collections: [] } : { exch: { USD: 0.8 } });
  };
  await readMarket(get, nftSnap, []);
  assert.equal(peak, 1);
});
