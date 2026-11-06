import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { cardOdds, poolTiles } from "../src/lib/live/pool-tiles.ts";
import { XRP_PRIZE_ART } from "../src/lib/prize-art.ts";

const TIERS = ["Common", "Uncommon", "Rare", "Epic", "Chase"] as const;
const nft = (id: string, markXrp: number) => ({ id, name: `n${id}`, collection: "c", img: "/x.webp", markXrp });

test("one list, rarest first and highest value first in a band, with XRP prizes among the NFTs and empty bands simply absent", () => {
  const tiles = poolTiles({
    bands: [
      { tier: "Common", pct: 74, nftPct: 0, prizes: [{ xrp: 1, tokens: ["XRP", "SEAL"], pct: 50 }, { xrp: 2, tokens: ["XRP"], pct: 24 }], nfts: [] },
      { tier: "Uncommon", pct: 20, nftPct: 20, prizes: [], nfts: [] },
      { tier: "Rare", pct: 2.5, nftPct: 2, prizes: [{ xrp: 42, tokens: ["XRP"], pct: 0.5 }], nfts: [nft("a", 10), nft("b", 50)] },
      { tier: "Epic", pct: 3.14, nftPct: 3.14, prizes: [], nfts: [nft("c", 90)] },
      { tier: "Chase", pct: 0.36, nftPct: 0, prizes: [], nfts: [] },
    ],
  });
  assert.deepEqual(tiles.map((t) => [t.tier, t.value]), [["Epic", 90], ["Rare", 50], ["Rare", 42], ["Rare", 10], ["Common", 2], ["Common", 1]]);
});

test("an NFT's odds are its band's chance and its place among them, never a percentage of its own", () => {
  const [t] = poolTiles({ bands: [{ tier: "Epic", pct: 3.14, nftPct: 1.57, prizes: [{ xrp: 42, tokens: ["XRP"], pct: 1.57 }], nfts: [nft("a", 9), nft("b", 8), nft("c", 7), nft("d", 6)] }] }).filter((x) => x.kind === "nft");
  assert.equal(t.odds, "Epic: 1.57% of pulls are an NFT from this band, 1 of 4");
  const [p] = poolTiles({ bands: [{ tier: "Epic", pct: 3.14, nftPct: 1.57, prizes: [{ xrp: 42, tokens: ["XRP"], pct: 1.57 }], nfts: [nft("a", 9)] }] }).filter((x) => x.kind === "prize");
  assert.equal(p.odds, "Epic: 1.57% of pulls pay this prize");
});

test("a prize says what it pays: XRP, XRP or SEAL, or a token at its value", () => {
  const names = (tokens: string[]) => {
    const t = poolTiles({ bands: [{ tier: "Common", pct: 74, nftPct: 0, prizes: [{ xrp: 3, tokens, pct: 74 }], nfts: [] as ReturnType<typeof nft>[] }] })[0];
    assert.equal(t.kind, "prize");
    return t as Extract<typeof t, { kind: "prize" }>;
  };
  assert.equal(names(["XRP"]).name, "XRP prize");
  assert.equal(names(["XRP", "SEAL"]).name, "XRP or SEAL");
  assert.equal(names(["SEAL"]).name, "SEAL prize");
  assert.equal(names(["SEAL"]).img, "/assets/prize-seal.svg");
  assert.equal(names(["XRP"]).img, XRP_PRIZE_ART);
  assert.equal(names(["XRP"]).value, 3);
});

test("a very small chance isn't rounded away, and the chances shown add back up to the band's", () => {
  const [t] = poolTiles({ bands: [{ tier: "Chase", pct: 0.004, nftPct: 0.0035, prizes: [], nfts: [nft("a", 1)] }] });
  assert.match(t.odds, /^Chase: 0\.0035% of pulls/);
  const band = fc.record({ prizes: fc.array(fc.record({ xrp: fc.integer({ min: 1, max: 500 }), pct: fc.integer({ min: 1, max: 9000 }).map((n) => n / 100) }), { maxLength: 4 }), count: fc.nat(6), nftPct: fc.integer({ min: 0, max: 5000 }).map((n) => n / 100) });
  fc.assert(fc.property(fc.array(band, { minLength: 5, maxLength: 5 }), (bands) => {
    const input = { bands: bands.map((b, i) => ({ tier: TIERS[i], pct: 1, nftPct: b.nftPct, prizes: b.prizes.map((p) => ({ ...p, tokens: ["XRP"] })), nfts: Array.from({ length: b.count }, (_, k) => nft(`${i}-${k}`, k + 1)) })) };
    const tiles = poolTiles(input);
    // Every prize and NFT once, and nothing invented.
    assert.equal(tiles.length, bands.reduce((a, b) => a + b.prizes.length + b.count, 0));
    assert.equal(new Set(tiles.map((t) => t.key)).size, tiles.length);
    // Rarest first throughout.
    const ranks = tiles.map((t) => TIERS.indexOf(t.tier));
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] <= ranks[i - 1]);
    // No NFT carries a share of its own: every tile in a band quotes the same band figure.
    for (const b of input.bands) {
      const odds = new Set(tiles.filter((t) => t.kind === "nft" && t.tier === b.tier).map((t) => t.odds));
      assert.ok(odds.size <= 1, [...odds].join());
      for (const o of odds) assert.ok(o.endsWith(`1 of ${b.nfts.length}`), o);
    }
  }));
});

test("a card pack's badge says its band's rate, and claims nothing about one card's share", () => {
  assert.equal(cardOdds("Rare", 8), "Rare: 8% of pulls land in this band");
  assert.doesNotMatch(cardOdds("Epic", 1), /\bRTP\b|house edge|1 of/);
});
