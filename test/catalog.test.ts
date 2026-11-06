import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { FOREIGN_NAME, categoryOf, displayName, uniqueNames } from "../src/lib/catalog/names.ts";
import { SourceFormatError, allowedImage, parseItems, parseMachines } from "../src/lib/catalog/parse.ts";

const row = (o: Record<string, unknown> = {}) => ({
  code: "pokemon_25",
  name: "Starter Pokémon Gacha Pack",
  price: 25,
  instantBuyback: 85,
  odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
  stock: { common: 500, uncommon: 300, rare: 150, epic: 34 },
  ...o,
});

test("a good machine parses to real price, rates, stock and sell-back", () => {
  const [m] = parseMachines({ machines: [row()] });
  assert.equal(m.code, "pokemon_25");
  assert.equal(m.name, "Starter Pokémon Pack");
  assert.equal(m.cat, "Pokémon");
  assert.equal(m.price, 25);
  assert.equal(m.bb, 85);
  assert.deepEqual(m.rates, [75, 20, 4, 1]);
  assert.equal(m.stock, 984);
});

test("sold-out packs sort last, then lowest price first", () => {
  const rows = parseMachines([row({ code: "a_500", price: 500 }), row({ code: "b_25", price: 25, stock: {} }), row({ code: "c_50", price: 50 })]);
  assert.deepEqual(rows.map((m) => m.code), ["c_50", "a_500", "b_25"]);
});

test("rows that can't be shown honestly are skipped, not fatal", () => {
  const rows = parseMachines({ machines: [row(), null, 7, row({ code: "../etc" }), row({ code: "x", price: -1 }), row({ code: "y", odds: { common: 0.2 } }), row({ code: "z", odds: null }), row({ code: "w", price: "free" })] });
  assert.deepEqual(rows.map((m) => m.code), ["pokemon_25"]);
});

test("a payload with no usable rows is an error, so it can never wipe the store", () => {
  for (const bad of [null, {}, { machines: "x" }, { machines: [] }, { machines: [null] }, "<html>", 42]) assert.throws(() => parseMachines(bad), SourceFormatError);
});

test("any payload at all either parses to valid machines or throws the format error", () => {
  fc.assert(
    fc.property(fc.oneof(fc.anything(), fc.array(fc.anything()), fc.record({ machines: fc.array(fc.oneof(fc.anything(), fc.record({ code: fc.string(), price: fc.anything(), odds: fc.anything(), name: fc.anything(), stock: fc.anything() }))) })), (payload) => {
      let rows;
      try {
        rows = parseMachines(payload);
      } catch (e) {
        assert.ok(e instanceof SourceFormatError);
        return;
      }
      for (const m of rows) {
        assert.ok(m.price > 0 && m.stock >= 0);
        assert.ok(Math.abs(m.rates.reduce((a, b) => a + b, 0) - 100) < 1.1);
      }
    }),
  );
});

test("raw codes and other brands' names get the plain Select name", () => {
  assert.equal(displayName("bf_poke25", "bf_poke25", 25), "Pokémon Select $25");
  assert.equal(displayName("ehhpoke_69", "Solflare Pokemon 69", 69), "Pokémon Select $69");
  assert.equal(displayName("epokemon_200", "Infinex Pokemon 200", 200), "Pokémon Select $200");
  assert.equal(displayName("eelectric_100", "Rarible Electric 100", 100), "Pokémon Select $100");
  assert.equal(displayName("fb_op100", "Fee Builder", 100), "One Piece Select $100");
  assert.equal(displayName("pokewatch_50_jup", "pokewatch_50_jup", 50), "Watches Select $50");
  assert.equal(displayName("degen_100", "exclusive low ev, high potential win", 100), "Exclusive Select $100");
});

test("plain names only lose the Gacha wording and bad spacing", () => {
  assert.equal(displayName("sports_100", "Sports Gacha Pack", 100), "Sports Pack");
  assert.equal(displayName("anime_75", "Anime Pop Culture Gacha", 75), "Anime Pop Culture");
  assert.equal(displayName("egengar_100", "Gengar Haunter's  & Friends", 100), "Gengar Haunter's & Friends");
  assert.equal(displayName("ev90s_500", "exclusive vintange 90's 500", 500), "Exclusive vintage 90's 500");
  assert.equal(displayName("eanime_150", "exclusive anime 150", 150), "Exclusive anime 150");
});

test("categories follow the concept's rules", () => {
  assert.equal(categoryOf("bf_op50", "bf_op50"), "One Piece");
  assert.equal(categoryOf("ghost_500", "Halloween Spookys 500"), "Halloween");
  assert.equal(categoryOf("esolana_75", "Exclusive Solana $75"), "Exclusive");
  assert.equal(categoryOf("mystery", "Mystery"), "Exclusive");
});

test("duplicate names get a stable No. n whatever order the API sends", () => {
  fc.assert(
    fc.property(fc.shuffledSubarray(["bf_poke25", "fb_poke_25", "ejup_poke_25", "eopoke_25", "pokemon_25"], { minLength: 1 }), (codes) => {
      const rows = codes.map((code) => ({ code, name: "Pokémon Select $25", price: 25 }));
      const named = uniqueNames(rows);
      const reversed = uniqueNames([...rows].reverse());
      assert.equal(new Set(named.map((r) => r.name)).size, rows.length);
      for (const r of named) assert.equal(reversed.find((x) => x.code === r.code)?.name, r.name);
    }),
  );
});

test("names stay unique and brand-free whatever the source calls a machine", () => {
  const nameArb = fc.oneof(fc.constantFrom("Solflare Pack", "Infinex 200", "Jup Special", "Fee Builder", "Rarible One", "Sns 25", "dboy", "Primate 100", "Plain Pack"), fc.string());
  fc.assert(
    fc.property(fc.array(fc.record({ code: fc.stringMatching(/^[a-z0-9_]{1,12}$/), name: nameArb, price: fc.integer({ min: 1, max: 5000 }) })), (rows) => {
      const parsed = (() => {
        try {
          return parseMachines({ machines: rows.map((r) => row(r)) });
        } catch {
          return [];
        }
      })();
      assert.equal(new Set(parsed.map((m) => m.name)).size, parsed.length);
      for (const m of parsed) assert.ok(!FOREIGN_NAME.test(m.name), m.name);
    }),
  );
});

test("the checked-in snapshot is real, complete and clean", () => {
  const snap = JSON.parse(readFileSync(new URL("../src/data/catalog-snapshot.json", import.meta.url), "utf8"));
  assert.ok(snap.machines.length >= 100);
  for (const m of snap.machines) {
    assert.ok(!FOREIGN_NAME.test(m.name), m.name);
    assert.ok(!/gacha/i.test(m.name), m.name);
    if (m.stock > 0) assert.ok(m.fan.length > 0, `${m.code} has no fan`);
    for (const i of m.fan) assert.ok(allowedImage(i.img), i.img);
  }
});

const nft = (o: Record<string, unknown> = {}) => ({
  id: "abc",
  description: "1998  #149 Dragonite-Holo PSA 8",
  name: "short",
  rarity: "epic",
  image: "https://d1xpxki1g4htqu.cloudfront.net/abc",
  insured_value: 485,
  attributes: [{ trait_type: "Grading Company", value: "PSA" }, { trait_type: "The Grade", value: "NM-MT 8" }],
  ...o,
});

test("an item parses with its real value, grade and image", () => {
  const [i] = parseItems({ nfts: [nft()] }, "pokemon_25");
  assert.deepEqual(i, { id: "abc", name: "1998 #149 Dragonite-Holo PSA 8", rarity: "epic", ins: 485, grade: "PSA NM-MT 8", img: "https://d1xpxki1g4htqu.cloudfront.net/abc", code: "pokemon_25", grader: "PSA", gradeName: "NM-MT 8" });
});

test("insured value falls back to its attribute, and a missing grade reads as not graded", () => {
  const [i] = parseItems({ nfts: [nft({ insured_value: undefined, attributes: [{ trait_type: "Insured Value", value: "99" }] })] }, "x");
  assert.equal(i.ins, 99);
  assert.equal(i.grade, "Not graded");
});

test("items without identity, a tier, a value or an allowed image are dropped", () => {
  const rows = [nft({ id: "" , nft_address: undefined }), nft({ id: "b", rarity: "mythic" }), nft({ id: "c", image: "http://d1xpxki1g4htqu.cloudfront.net/a" }), nft({ id: "d", image: "https://evil.example/a.png" }), nft({ id: "e", insured_value: 0 }), nft({ id: "f" })];
  assert.deepEqual(parseItems({ nfts: rows }, "x").map((i) => i.id), ["f"]);
  assert.throws(() => parseItems({ error: "nope" }, "x"), SourceFormatError);
});

test("no payload can put a disallowed image host on a page", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ id: fc.string(), rarity: fc.constantFrom("common", "epic", "rare"), image: fc.oneof(fc.webUrl(), fc.string()), insured_value: fc.integer({ min: 1 }), description: fc.string() })), (nfts) => {
      for (const i of parseItems({ nfts }, "x")) assert.ok(allowedImage(i.img));
    }),
  );
});
