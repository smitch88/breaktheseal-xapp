import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_PRICES } from "../src/config/nft-packs.ts";
import { RIP_ART, RIP_LAYERS, ripParts } from "../src/lib/rip-art.ts";

const onDisk = (url: string) => existsSync(new URL(`../public${url}`, import.meta.url));

test("every layer of the bite is a real file", () => {
  for (const src of RIP_LAYERS) assert.ok(onDisk(src), src);
  for (const art of Object.keys(RIP_ART)) {
    const p = ripParts(art);
    for (const src of [p.whole, p.top, p.body, p.back]) assert.ok(onDisk(src), src);
  }
});

test("each NFT pack and the card pack rip as themselves", () => {
  for (const price of NFT_PRICES) assert.equal(ripParts(`/assets/pack-n${price}.webp`).key, `pack-n${price}`);
  assert.equal(ripParts("/assets/stage-pack.webp").key, "stage-pack");
});

test("art with no parts still rips, as the standard foil pack and never as nothing", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }).filter((s) => !(s in RIP_ART)), (art) => {
      const p = ripParts(art);
      assert.equal(p.whole, "/assets/stage-pack.webp");
      assert.ok(onDisk(p.top) && onDisk(p.body) && onDisk(p.back));
    }),
  );
});

test("the tear sits below the wax on every pack, so the wax goes with the teeth", () => {
  for (const a of Object.values(RIP_ART)) {
    assert.ok(a.tear > a.wy && a.tear < 50, a.key);
    assert.ok(a.seal > 100, a.key);
  }
});
