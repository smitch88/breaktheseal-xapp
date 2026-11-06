import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_RATES, NFT_TIERS, TIER_TARGETS, bandPrizeShare, targetFor } from "../src/lib/nft/bands.ts";
import { cardSellBack, nftSellBack } from "../src/lib/sellback.ts";
import { quoteFor } from "../src/lib/rails/order.ts";

test("card sell-back: $14 at 85% less the 2% sell fee pays $11.66", () => {
  assert.equal(cardSellBack(14, 85), 11.66);
});

test("card sell-back at each live rate", () => {
  assert.equal(cardSellBack(100, 85), 83.3);
  assert.equal(cardSellBack(100, 90), 88.2);
  assert.equal(cardSellBack(100, 93), 91.14);
  assert.equal(cardSellBack(100, 94), 92.12);
  assert.equal(cardSellBack(24000, 93), 21873.6);
});

test("card sell-back is whole cents, never over insured x rate x 98%, and within a cent of it", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 1, max: 100 }), (cents, rate) => {
      const insured = cents / 100;
      const pay = cardSellBack(insured, rate);
      const exact = (cents * rate * 98) / 1_000_000;
      assert.ok(Number.isInteger(Math.round(pay * 100)));
      assert.ok(Math.abs(pay * 100 - Math.round(pay * 100)) < 1e-6);
      assert.ok(pay <= exact + 1e-9);
      assert.ok(exact - pay < 0.01 + 1e-9);
    }),
  );
});

test("card sell-back rises with value and rate", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 99 }), (cents, more, rate) => {
      assert.ok(cardSellBack((cents + more) / 100, rate) >= cardSellBack(cents / 100, rate));
      assert.ok(cardSellBack(cents / 100, rate + 1) >= cardSellBack(cents / 100, rate));
    }),
  );
});

test("NFT sell-back is 97% of floor less the 2% sell fee, rounded down to the cent", () => {
  assert.equal(nftSellBack(100), 95.06);
  assert.equal(nftSellBack(1.11), 1.05);
  fc.assert(fc.property(fc.integer({ min: 0, max: 100_000_000 }), (c) => assert.ok(nftSellBack(c / 100) <= (c / 100) * 0.9506 + 1e-9)));
});

test("the rarity rates are 66/24/7/2/1 and add to 100%", () => {
  assert.deepEqual(NFT_RATES, [66, 24, 7, 2, 1]);
  assert.equal(NFT_RATES.reduce((x, y) => x + y, 0), 100);
  assert.equal(NFT_TIERS.length, NFT_RATES.length);
});

test("tier targets scale with price", () => {
  assert.deepEqual(TIER_TARGETS, [0.4, 0.8, 1.8, 5, 15]);
  assert.equal(targetFor(100, 4), 1500);
  assert.equal(targetFor(5, 0), 2);
  const share = bandPrizeShare(100, [40, 80, 180, 500, 1500]);
  assert.ok(Math.abs(share - (66 * 40 + 24 * 80 + 7 * 180 + 2 * 500 + 1500) / 10000) < 1e-9);
});

test("a quote's XRP cap covers the price, with 0.5% room on card packs only", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5000 }), fc.double({ min: 0.1, max: 100, noNaN: true }), (usd, rate) => {
      const nft = quoteFor({ kind: "nft", price: 5 }, usd, rate).maxXrp;
      const card = quoteFor({ kind: "card", code: "x" }, usd, rate).maxXrp;
      assert.ok(nft >= usd / rate - 1e-9);
      assert.ok(card >= (usd / rate) * 1.005 - 1e-9);
      assert.ok(card >= nft);
    }),
  );
});
