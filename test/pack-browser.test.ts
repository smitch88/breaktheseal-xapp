import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { bandTotal, mergePage, showingText, totalLine } from "../src/lib/catalog/browse.ts";
import { parseItems, parseItemsPage, parseMachines } from "../src/lib/catalog/parse.ts";
import { createCatalogSource } from "../src/lib/catalog/source.ts";
import { HOME, faceOf, nudge, panBy, pinchTo, rotateBy, toFace, wheelBy, type Camera } from "../src/lib/card-viewer.ts";
import { parseCardDetails } from "../src/lib/live/proof.ts";
import { addressOf, world } from "./support-routes.ts";

const MINT = "y5oBr3AAfex6SAzNzqPCa39dzRDrrKuAhFSQjmDKRJY";
const CDN = "https://d1xpxki1g4htqu.cloudfront.net";
const trait = (trait_type: string, value: string) => ({ trait_type, value });

/** The shape of a real getNfts row, read from pokemon_25 on 2026-11-02. */
const idOf = (n: number) => `${MINT.slice(0, 38)}${[...String(n).padStart(4, "0")].map((d) => "ABCDEFGHJK"[Number(d)]).join("")}`;
const row = (n: number, rarity = "epic", value = 500 - n) => ({
  nft_address: idOf(n),
  id: idOf(n),
  name: `2019 #181 Full Art/Sabrina's Sug`,
  description: `2019 #181 Full Art/Sabrina's Suggestion PSA 10 Sun & Moon Team Up ${n}`,
  rarity,
  image: `${CDN}/front${n}`,
  insured_value: value,
  attributes: [trait("Type", "Card"), trait("Category", "Pokemon"), trait("Year", "2019"), trait("Insured Value", String(value)), trait("Vault", "OmniVault"), trait("Grading ID", "26831140"), trait("Grading Company", "PSA"), trait("The Grade", "GEM-MT 10")],
  content: { files: [{ cc_cdn: `${CDN}/front${n}` }, { cc_cdn: `${CDN}/back${n}` }] },
  gradePopulation: 543,
  cardYear: "2019",
  parallel: "1st Edition",
});

const MACHINE = { code: "pokemon_25", name: "Starter", price: 25, instantBuyback: 85, odds: { common: 0.7, uncommon: 0.2, rare: 0.08, epic: 0.02 }, stock: { common: 378, uncommon: 215, rare: 216, epic: 200 } };

test("a machine's real stock reads per band, and the total is their sum", () => {
  const [m] = parseMachines({ machines: [MACHINE] });
  assert.deepEqual(m.bands, { common: 378, uncommon: 215, rare: 216, epic: 200 });
  assert.equal(m.stock, 1009);
  assert.equal(bandTotal(m, "All"), 1009);
  assert.equal(bandTotal(m, "common"), 378);
  assert.equal(totalLine(1009), "1,009 cards in this pack");
  assert.equal(totalLine(1), "1 card in this pack");
  assert.equal(totalLine(0), "No cards in this pack right now");
  fc.assert(fc.property(fc.record({ common: fc.nat(), uncommon: fc.nat(), rare: fc.nat(), epic: fc.nat() }), (stock) => {
    const [x] = parseMachines({ machines: [{ ...MACHINE, stock }] });
    assert.equal(x.stock, stock.common + stock.uncommon + stock.rare + stock.epic);
    assert.equal(bandTotal(x, "All"), x.stock);
  }));
});

test("a saved copy with no per-band figures says nothing per band rather than guessing", () => {
  assert.equal(bandTotal({ stock: 10 }, "common"), null);
  assert.equal(bandTotal({ stock: 10 }, "All"), 10);
});

test("a row carries what the details view needs: back photo, grader, cert, year, category, and a watch with no description still reads", () => {
  const [i] = parseItems({ nfts: [row(1)] }, "pokemon_25");
  assert.equal(i.back, `${CDN}/back1`);
  assert.equal(i.grader, "PSA");
  assert.equal(i.gradeName, "GEM-MT 10");
  assert.equal(i.grade, "PSA GEM-MT 10");
  assert.equal(i.cert, "26831140");
  assert.equal(i.category, "Pokemon");
  assert.equal(i.year, "2019");
  assert.equal(i.parallel, "1st Edition");
  assert.equal(i.population, 543);
  assert.equal(i.vault, "OmniVault");
  const [w] = parseItems({ nfts: [{ ...row(2), description: null, name: "Rolex Explorer II", attributes: [trait("Type", "Watch"), trait("Insured Value", "400"), trait("Grading Company", "Wristcheck"), trait("The Grade", "10")] }] }, "ewatch_250");
  assert.equal(w.name, "Rolex Explorer II");
  assert.equal(w.grade, "Wristcheck 10");
  const [off] = parseItems({ nfts: [{ ...row(3), content: { files: [{ cc_cdn: `${CDN}/front3` }, { cc_cdn: "https://evil.test/x.png" }] } }] }, "pokemon_25");
  assert.equal(off.back, undefined, "a back on an unknown host isn't shown");
  const [same] = parseItems({ nfts: [{ ...row(4), content: { files: [{ cc_cdn: `${CDN}/front4` }, { cc_cdn: `${CDN}/front4` }] } }] }, "pokemon_25");
  assert.equal(same.back, undefined, "a back that's the front isn't a back");
  fc.assert(fc.property(fc.anything(), fc.anything(), (content, attributes) => void parseItems({ nfts: [{ ...row(5), content, attributes }] }, "x")));
});

test("a page keeps the source's cursor as it came, and never claims more than the source said", () => {
  assert.deepEqual(parseItemsPage({ nfts: [row(1)], hasMore: true, nextCursor: "475_abc" }, "pokemon_25").nextCursor, "475_abc");
  assert.equal(parseItemsPage({ nfts: [row(1)], hasMore: false, nextCursor: "475_abc" }, "x").nextCursor, null);
  assert.equal(parseItemsPage({ nfts: [row(1)], hasMore: true }, "x").nextCursor, null);
  assert.throws(() => parseItemsPage({ nope: 1 }, "x"));
});

test("walking every page returns each real card once, in the source's order, and nothing else", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 120 }), fc.constantFrom(null, "epic", "common"), async (count, rarity) => {
      const all = Array.from({ length: count }, (_, i) => row(i, rarity ?? "epic"));
      const urls: string[] = [];
      const get = async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        const start = Number(u.searchParams.get("cursor") ?? 0);
        const limit = Number(u.searchParams.get("limit"));
        const end = start + limit;
        return { ok: true, status: 200, json: async () => ({ nfts: all.slice(start, end), hasMore: end < all.length, nextCursor: end < all.length ? String(end) : null }) };
      };
      const src = createCatalogSource(get, { asOf: "x", machines: [] });
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const page = await src.page("pokemon_25", rarity as never, cursor);
        seen.push(...page.items.map((x) => x.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(seen, all.map((r) => r.id));
      // The source's own order for these parameters, so no call costs a redirect.
      for (const u of urls) assert.match(u, rarity ? /\?code=pokemon_25&rarity=(epic|common)&limit=24(&cursor=\d+)?$/ : /\?code=pokemon_25&limit=24(&cursor=\d+)?$/);
    }),
    { numRuns: 25 },
  );
});

test("the source failing is an error, never a saved list dressed up as what's in the machine", async () => {
  const snapshot = { asOf: "x", machines: [{ code: "pokemon_25", name: "n", cat: "c", price: 25, bb: 85, rates: [70, 20, 8, 2] as const, stock: 1, fan: parseItems({ nfts: [row(9)] }, "pokemon_25") }] };
  const src = createCatalogSource(async () => ({ ok: false, status: 500, json: async () => ({}) }), snapshot);
  await assert.rejects(src.page("pokemon_25", null, null));
});

test("merging a page keeps order and shows a card once, however pages overlap as stock moves", () => {
  fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 3 })), fc.array(fc.string({ minLength: 1, maxLength: 3 })), (a, b) => {
    const items = (ids: string[]) => ids.map((id) => ({ id })) as never[];
    const merged = mergePage(items(a), items(b)) as unknown as { id: string }[];
    assert.equal(new Set(merged.map((m) => m.id)).size, merged.length);
    assert.deepEqual([...new Set([...a, ...b])], merged.map((m) => m.id));
  }));
});

test("what the count line says is never more than what's there", () => {
  assert.equal(showingText(24, 1009, true), "Showing 24 of 1,009");
  assert.equal(showingText(378, 378, false), "That's all 378");
  // The list and the count refresh apart, so these can differ by a card or two. It says what it has, not "217 of 215".
  assert.equal(showingText(217, 215, false), "That's all 217");
  assert.equal(showingText(30, 215, false), "That's all 30 we can read right now");
  assert.equal(showingText(24, null, true), "Showing 24");
  fc.assert(fc.property(fc.nat(50000), fc.option(fc.nat(50000), { nil: null }), fc.boolean(), (shown, total, more) => {
    const m = /(\d[\d,]*) of (\d[\d,]*)/.exec(showingText(shown, total, more));
    if (m) assert.ok(Number(m[1].replaceAll(",", "")) <= Number(m[2].replaceAll(",", "")));
  }));
});

// ------------------------- Routes -------------------------

const packs = async (over: Record<string, unknown> = {}) => {
  const w = await world({ off: true, env: { SEAL_MACHINE_CODES: "pokemon_25,ewatch_250" }, ...over });
  w.cc.gacha = (u) => {
    if (u.pathname === "/api/machines") return { machines: [MACHINE, { ...MACHINE, code: "hidden_25" }] };
    const start = u.searchParams.get("cursor") === "next" ? 24 : 0;
    const rows = Array.from({ length: 30 }, (_, i) => row(i, u.searchParams.get("rarity") ?? "epic")).slice(start, start + 24);
    return { nfts: rows, hasMore: start === 0, nextCursor: start === 0 ? "next" : null };
  };
  return w;
};

test("browse: one source call per page, the cursor passed as it came, filtered by band, no cost to the client", async () => {
  const w = await packs();
  const first = await w.call("GET", "/api/packs/pokemon_25/browse");
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 24);
  assert.equal(first.body.nextCursor, "next");
  const before = w.cc.gachaCalls.filter((u) => u.includes("getNfts")).length;
  const second = await w.call("GET", "/api/packs/pokemon_25/browse?rarity=rare&cursor=next");
  assert.equal(second.body.items.length, 6);
  assert.equal(second.body.nextCursor, null);
  const calls = w.cc.gachaCalls.filter((u) => u.includes("getNfts"));
  assert.equal(calls.length - before, 1);
  assert.match(calls.at(-1) as string, /code=pokemon_25&rarity=rare&limit=24&cursor=next$/);
  assert.match(first.headers.get("cache-control") as string, /s-maxage/);
});

test("browse: an unknown pack, one off the allowlist, a bad band or a junk cursor reach no source", async () => {
  const w = await packs();
  await w.call("GET", "/api/packs/pokemon_25/browse");
  const before = w.cc.gachaCalls.filter((u) => u.includes("getNfts")).length;
  assert.equal((await w.call("GET", "/api/packs/nope_nope/browse")).status, 404);
  assert.equal((await w.call("GET", "/api/packs/hidden_25/browse")).status, 404, "a hidden pack can't be read by naming it");
  assert.equal((await w.call("GET", "/api/packs/pokemon_25/browse?rarity=mythic")).status, 400);
  for (const bad of ["a b", "x".repeat(300), "../../etc", "a&limit=100", "a#b"]) assert.equal((await w.call("GET", `/api/packs/pokemon_25/browse?cursor=${encodeURIComponent(bad)}`)).status, 400, bad);
  assert.equal(w.cc.gachaCalls.filter((u) => u.includes("getNfts")).length, before);
});

test("browse: a source that's down says so and shows no card, and it isn't cached", async () => {
  const w = await packs();
  await w.call("GET", "/api/packs/pokemon_25/browse");
  w.cc.down = true;
  const r = await w.call("GET", "/api/packs/pokemon_25/browse?rarity=epic");
  assert.equal(r.status, 503);
  assert.equal(r.body.items, undefined);
  assert.match(r.headers.get("cache-control") as string, /no-store/);
});

test("browse: one visitor hammering it is turned away", async () => {
  const w = await packs();
  const c = w.client(addressOf(1), false);
  let turned = 0;
  for (let i = 0; i < 150; i++) if ((await w.call("GET", `/api/packs/pokemon_25/browse?cursor=c${i}`, { as: c })).status === 429) turned += 1;
  assert.ok(turned > 0);
  assert.equal(w.cc.gachaCalls.filter((u) => u.includes("getNfts")).length, 150 - turned);
});

test("a card's details: read by mint from the public record, and a bad mint or a hidden pack costs nothing", async () => {
  const w = await packs();
  w.cc.rows = [{ nftAddress: MINT, itemName: "Full name", set: "Team Up", serial: "181", year: 2019, frontImage: `${CDN}/f`, backImage: `${CDN}/b` }];
  const r = await w.call("GET", `/api/packs/pokemon_25/card/${MINT}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.details.set, "Team Up");
  assert.equal(r.body.details.number, "181");
  const calls = w.cc.calls;
  assert.equal((await w.call("GET", "/api/packs/pokemon_25/card/not-a-mint")).status, 404);
  assert.equal((await w.call("GET", `/api/packs/hidden_25/card/${MINT}`)).status, 404);
  assert.equal(w.cc.calls, calls);
  w.cc.down = true;
  assert.equal((await w.call("GET", `/api/packs/pokemon_25/card/${MINT.slice(0, -1)}2`)).body.details, null, "no record reads as nothing to add");
});

// ------------------------- Photos of a real record -------------------------

const record = (over: Record<string, unknown>) => ({ filterNFtCard: [{ nftAddress: MINT, id: "2026092041C262192", images: { frontM: `${CDN}/frontM`, frontS: `${CDN}/frontS`, backS: `${CDN}/backS` }, ...over }] });

test("a card's record gives a picture on either side wherever its originals are hosted, the way the real ones vary", () => {
  // 14 of 32 sampled pokemon_25 cards: originals on the known host.
  const direct = parseCardDetails(record({ frontImage: `${CDN}/f`, backImage: `${CDN}/b` }), MINT);
  assert.equal(direct?.front, `${CDN}/f`);
  assert.equal(direct?.back, `${CDN}/b`);
  // 13 of 32: on arweave.net, which redirects to a one-off host. 5 of 32: Collector Crypt's image host. Watches: a shop's CDN.
  for (const host of ["https://arweave.net/abc", "https://nft.collectorcrypt.com/front/x", "https://cdn.shopify.com/s/x.png"]) {
    const d = parseCardDetails(record({ frontImage: host, backImage: `${host}b` }), MINT);
    assert.equal(d?.front, `${CDN}/frontM`, host);
    assert.equal(d?.back, `${CDN}/backS`, host);
  }
  assert.equal(parseCardDetails(record({ images: {} , frontImage: "https://evil.test/x", backImage: "https://evil.test/y" }), MINT)?.back, null);
});

// ------------------------- The viewer's camera -------------------------

const camera = fc.record({ rx: fc.integer({ min: -30, max: 30 }), ry: fc.integer({ min: -3000, max: 3000 }), zoom: fc.double({ min: 1, max: 5, noNaN: true }), px: fc.integer({ min: -500, max: 500 }), py: fc.integer({ min: -500, max: 500 }) });
const SIZE = { w: 400, h: 600 };
const move = fc.integer({ min: -4000, max: 4000 });

test("a card turns all the way round when it has two sides, and can only tilt when it has one", () => {
  fc.assert(fc.property(camera, move, move, (c, dx, dy) => {
    const two = rotateBy(c, dx, dy, true);
    assert.ok(Math.abs(two.rx) <= 30);
    const one = rotateBy({ ...c, ry: 0 }, dx, dy, false);
    assert.ok(Math.abs(one.ry) <= 25, "a photo with no back never turns far enough to show nothing");
    assert.equal(faceOf(one.ry), "front");
  }));
  assert.equal(faceOf(180), "back");
  assert.equal(faceOf(0), "front");
  assert.equal(faceOf(360), "front");
  assert.equal(faceOf(-180), "back");
  assert.equal(faceOf(rotateBy(HOME, 360, 0, true).ry), "back", "half a turn for a 360 px drag");
});

test("Front and Back land square on that side by the shortest way, wherever it was turned to", () => {
  fc.assert(fc.property(camera, fc.constantFrom("front", "back") as fc.Arbitrary<"front" | "back">, (c, side) => {
    const t = toFace(c, side);
    assert.equal(faceOf(t.ry), side);
    assert.equal(t.rx, 0);
    assert.ok(Math.abs(t.ry - c.ry) <= 180);
    assert.equal(((t.ry % 180) + 180) % 180, 0);
  }));
});

test("zoom stays in range by wheel and pinch, zooming out re-centers, and a pan never loses the card", () => {
  fc.assert(fc.property(camera, fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: 1, max: 900 }), fc.integer({ min: 1, max: 900 }), (c, delta, a, b) => {
    for (const z of [wheelBy(c, delta), pinchTo(c, c.zoom, a, b)]) assert.ok(z.zoom >= 1 && z.zoom <= 5);
    const home = pinchTo(c, 1, 900, 1);
    assert.equal(home.zoom, 1);
    assert.equal(home.px, 0);
    assert.equal(home.py, 0);
  }));
  fc.assert(fc.property(camera, move, move, (c, dx, dy) => {
    const p = panBy(c, dx, dy, SIZE);
    assert.ok(Math.abs(p.px) <= ((c.zoom - 1) * SIZE.w) / 2 + 1e-6);
    assert.ok(Math.abs(p.py) <= ((c.zoom - 1) * SIZE.h) / 2 + 1e-6);
  }));
  assert.ok(wheelBy(HOME, -100).zoom > 1, "a wheel up zooms in");
  assert.equal(panBy(HOME, 100, 100, SIZE).px, 0, "nothing to pan until it's zoomed");
});

test("the keyboard can do what a finger can", () => {
  const steps: readonly [string, (c: Camera) => boolean][] = [
    ["+", (c) => c.zoom > 1],
    ["ArrowRight", (c) => c.ry > 0],
    ["ArrowDown", (c) => c.rx !== 0],
    ["f", (c) => faceOf(c.ry) === "back"],
  ];
  for (const [key, ok] of steps) assert.ok(ok(nudge(HOME, key, true, SIZE)), key);
  const zoomed = { ...HOME, zoom: 3 };
  assert.notEqual(nudge(zoomed, "ArrowRight", true, SIZE).px, 0, "zoomed in, arrows pan");
  assert.deepEqual(nudge({ ...zoomed, ry: 40 }, "0", true, SIZE), HOME);
  assert.equal(nudge(HOME, "f", false, SIZE).ry, 0, "no back to flip to");
  assert.deepEqual(nudge(HOME, "x", true, SIZE), HOME);
});
