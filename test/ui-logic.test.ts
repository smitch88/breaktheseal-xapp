import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { packLabel, usd } from "../src/lib/format.ts";
import { ALL, DEFAULT_SORT, NFT_CATEGORY, activeFilters, filterNftPacks, filterPacks, shownCount, type PackSort } from "../src/lib/pack-filter.ts";
import { FLICK, dragProgress, settle, snapProgress } from "../src/lib/sheet.ts";

const rowArb = fc.record({ name: fc.string({ maxLength: 12 }), cat: fc.constantFrom("Pokémon", "Comics", "Sports"), price: fc.integer({ min: 1, max: 5000 }), stock: fc.integer({ min: 0, max: 500 }) });
const sortArb = fc.constantFrom<PackSort>("price", "high", "stock");
const catArb = fc.constantFrom(ALL, NFT_CATEGORY, "Pokémon", "Comics", "Sports");

test("a drag never takes the sheet off its track", () => {
  fc.assert(
    fc.property(fc.constantFrom(0, 1), fc.double({ min: -5000, max: 5000, noNaN: true }), fc.integer({ min: 0, max: 2000 }), (start, dy, range) => {
      const p = dragProgress(start, dy, range);
      assert.ok(p >= 0 && p <= 1);
    }),
  );
});

test("dragging down only ever moves the sheet toward collapsed", () => {
  fc.assert(
    fc.property(fc.constantFrom(0, 1), fc.double({ min: 0, max: 5000, noNaN: true }), fc.integer({ min: 1, max: 2000 }), (start, dy, range) => {
      assert.ok(dragProgress(start, dy, range) >= start);
    }),
  );
});

test("a release rests at an end: a flick wins, otherwise the nearer end", () => {
  fc.assert(
    fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -3, max: 3, noNaN: true }), (p, v) => {
      const snap = settle(p, v);
      if (v >= FLICK) assert.equal(snap, "collapsed");
      else if (v <= -FLICK) assert.equal(snap, "open");
      else assert.equal(snap, p >= 0.5 ? "collapsed" : "open");
      assert.ok([0, 1].includes(snapProgress(snap)));
    }),
  );
});

test("the price leads a pack's label, so a narrow picker can only cut the name", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 80 }), (name, price, room) => {
      const label = packLabel(name, price);
      assert.ok(label.startsWith(`${usd(price)} · `));
      // The first characters of the label, as much as fits, never show a shortened price once the price fits at all.
      if (room >= usd(price).length) assert.ok(label.slice(0, room).startsWith(usd(price)));
    }),
  );
  assert.equal(packLabel("Starter Pokémon Pack", 25), "$25 · Starter Pokémon Pack");
});

test("filters keep only matching packs, and every kept pack came from the list", () => {
  fc.assert(
    fc.property(fc.array(rowArb, { maxLength: 30 }), catArb, sortArb, fc.string({ maxLength: 3 }), (rows, cat, sort, query) => {
      const kept = filterPacks(rows, { cat, query, sort });
      assert.ok(kept.length <= rows.length);
      for (const m of kept) {
        assert.ok(rows.includes(m));
        assert.ok(cat === ALL || m.cat === cat);
      }
      if (cat === NFT_CATEGORY) assert.equal(kept.length, 0);
    }),
  );
});

test("sorts order by price or stock, and no filter keeps the whole list", () => {
  fc.assert(
    fc.property(fc.array(rowArb, { maxLength: 30 }), sortArb, (rows, sort) => {
      const kept = filterPacks(rows, { cat: ALL, query: "", sort });
      assert.equal(kept.length, rows.length);
      for (let i = 1; i < kept.length; i++) {
        if (sort === "high") assert.ok(kept[i - 1].price >= kept[i].price);
        if (sort === "stock") assert.ok(kept[i - 1].stock >= kept[i].stock);
      }
      if (sort === "price") assert.deepEqual(kept, rows);
    }),
  );
});

test("search ignores case and accents", () => {
  const rows = [{ name: "Starter Pokémon Pack", cat: "Pokémon", price: 25, stock: 3 }, { name: "Comic Select", cat: "Comics", price: 50, stock: 3 }];
  assert.deepEqual(filterPacks(rows, { cat: ALL, query: "  POKEMON ", sort: DEFAULT_SORT }), [rows[0]]);
});

test("NFT packs show under All and NFT Packs only, and a search narrows them", () => {
  const rows = [{ name: "Five Dollar Pack" }, { name: "Hundred Dollar Pack" }];
  assert.equal(filterNftPacks(rows, { cat: "Comics", query: "", sort: DEFAULT_SORT }).length, 0);
  assert.equal(filterNftPacks(rows, { cat: NFT_CATEGORY, query: "", sort: DEFAULT_SORT }).length, 2);
  assert.deepEqual(filterNftPacks(rows, { cat: ALL, query: "hundred", sort: DEFAULT_SORT }), [rows[1]]);
});

test("the Filters count is the number of choices away from the defaults", () => {
  fc.assert(
    fc.property(catArb, sortArb, (cat, sort) => {
      assert.equal(activeFilters({ cat, sort }), (cat === ALL ? 0 : 1) + (sort === DEFAULT_SORT ? 0 : 1));
      // Where Sort has its own button, as in the xApp, Filters counts only the category.
      assert.equal(activeFilters({ cat, sort }, true), cat === ALL ? 0 : 1);
    }),
  );
});

test("NFT packs follow a price sort and keep their order otherwise, and nothing is lost or added", () => {
  const nftArb = fc.array(fc.record({ name: fc.string({ maxLength: 8 }), price: fc.integer({ min: 1, max: 500 }) }), { maxLength: 8 });
  fc.assert(
    fc.property(nftArb, sortArb, (rows, sort) => {
      const kept = filterNftPacks(rows, { cat: ALL, query: "", sort });
      assert.equal(kept.length, rows.length);
      assert.deepEqual(new Set(kept), new Set(rows));
      if (sort === "high") for (let i = 1; i < kept.length; i++) assert.ok(kept[i - 1].price >= kept[i].price);
      else assert.deepEqual(kept, rows);
    }),
  );
});

test("Show N packs counts the NFT packs, and the card packs only where they're on the shelf", () => {
  fc.assert(
    fc.property(fc.nat(50), fc.nat(50), fc.boolean(), (nft, cards, shown) => {
      assert.equal(shownCount(nft, cards, shown), nft + (shown ? cards : 0));
    }),
  );
});
