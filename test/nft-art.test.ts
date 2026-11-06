import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import sharp from "sharp";
import { mediaUrls } from "../src/lib/nft/media.ts";
import { apply, emptyState } from "../src/lib/rip/state.ts";
import { MAINNET_ID, TESTNET_ID } from "../src/lib/rip/chain.ts";
import { ART_ROUTE, NFT_ART, NO_PICTURE, TESTNET_PLACEHOLDER, artKey, artPathFor, artProxy, artRefusal, fallbackName, isFallbackName, isOwnArt, prizeImg, prizeTitle } from "../src/lib/rip/nft-art.ts";
import type { RipEvent } from "../src/lib/rip/types.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { poolView } from "../src/lib/rip/views.ts";

/** The public log as breaktheseal.rip served it on 2026-11-02: 18 events, 12 NFTs, 9 of them written with the testnet placeholder. */
const LOG = JSON.parse(readFileSync(new URL("./fixtures/mainnet-log-20261102.json", import.meta.url), "utf8")) as { events: RipEvent[] };
const adds = LOG.events.flatMap((e) => (e.type === "pool_change" ? e.data.adds : []));
const SEXY_BETZY_1567 = "001813880C7C14716237C4A8AC7FDA9B4AF1D6642B556AE14B85789C0617FC03";
const onDisk = (img: string) => new URL(`../public${img}`, import.meta.url);
const hexId = fc.string({ unit: fc.constantFrom(..."0123456789ABCDEF"), minLength: 64, maxLength: 64 });

test("the public log still replays, and the art fix never touches it: the placeholders are still there, as written", () => {
  const replay = replayLog(LOG.events);
  assert.equal(replay.ok, true);
  assert.equal(replay.ok && replay.pulls, 0);
  assert.equal(adds.length, 12);
  assert.equal(adds.filter((l) => l.img === TESTNET_PLACEHOLDER).length, 9);
});

test("every NFT in the live pools shows its own picture: a real file, named for that NFT, the size of the rest of the art", async () => {
  for (const l of adds) {
    const img = prizeImg(l, MAINNET_ID);
    assert.notEqual(img, TESTNET_PLACEHOLDER, l.name);
    assert.notEqual(img, NO_PICTURE, l.name);
    assert.ok(isOwnArt(l.nftId, img), `${l.name}: ${img}`);
    assert.ok(existsSync(onDisk(img)), img);
    const meta = await sharp(readFileSync(onDisk(img))).metadata();
    assert.equal(meta.format, "webp", img);
    assert.ok(Math.max(meta.width as number, meta.height as number) <= 420 && Math.max(meta.width as number, meta.height as number) >= 210, `${img} ${meta.width}x${meta.height}`);
  }
  // The two Panthers were both written with one sample picture. They're different NFTs.
  const panthers = adds.filter((l) => l.collection === "Panther").map((l) => prizeImg(l, MAINNET_ID));
  assert.equal(new Set(panthers).size, 2);
});

test("every row of the art map is that NFT's file, read from its on-ledger URI, and Sexy Betzy #1567 is ready", () => {
  assert.equal(NFT_ART[SEXY_BETZY_1567]?.name?.includes("1567"), true);
  for (const [id, row] of Object.entries(NFT_ART)) {
    assert.match(id, /^[0-9A-F]{64}$/);
    assert.ok(isOwnArt(id, row.img), row.img);
    assert.equal(artPathFor(row.img.split("/")[2], id), row.img);
    assert.ok(existsSync(onDisk(row.img)), row.img);
    assert.ok(row.uri && row.media, id);
  }
});

test("on mainnet no NFT ever shows the testnet placeholder or another NFT's picture, whatever the log says: anything not its own file goes to the art route", () => {
  fc.assert(
    fc.property(hexId, hexId, fc.constantFrom(TESTNET_PLACEHOLDER, "/nfts/some/0000000000000000.webp", "", "/assets/other.webp", "ipfs://x", "https://ipfs.io/ipfs/abc/teddy1160.png", "https://art.thejumpoff.xyz/sexy-betzy-c88a63/v52/1483.png", "ar://y"), (nftId, other, img) => {
      fc.pre(nftId.slice(-16) !== other.slice(-16));
      const none = {};
      // The route finds the NFT's own picture from the log's link or its metadata, or says it can't: never the placeholder, never a stand-in.
      assert.equal(prizeImg({ nftId, img }, MAINNET_ID, none), artProxy(nftId));
      // A file named for another NFT is that NFT's picture.
      assert.equal(prizeImg({ nftId, img: artPathFor("c", other) }, MAINNET_ID, none), artProxy(nftId));
      // Its own file is shown as it is.
      assert.equal(prizeImg({ nftId, img: artPathFor("c", nftId) }, MAINNET_ID, none), artPathFor("c", nftId));
      // The map wins over all of it.
      assert.equal(prizeImg({ nftId, img }, MAINNET_ID, { [nftId]: { img: "/nfts/c/mine.webp" } }), "/nfts/c/mine.webp");
    }),
  );
});

test("the art route's address never carries the NFT's id, is the same for the same NFT in any case, and differs between NFTs", () => {
  fc.assert(
    fc.property(hexId, hexId, (a, b) => {
      const url = artProxy(a);
      assert.ok(url.startsWith(ART_ROUTE));
      assert.match(url.slice(ART_ROUTE.length), /^[0-9a-f]{40}$/);
      assert.ok(!url.toUpperCase().includes(a.slice(-12)), "no part of the id that a feed could match");
      assert.equal(artProxy(a.toLowerCase()), url);
      if (a !== b) assert.notEqual(artKey(a), artKey(b));
    }),
  );
});

test("off mainnet the log's picture and name go through untouched, except a remote link, which goes through the art route so it can't show blank", () => {
  fc.assert(
    fc.property(hexId, fc.string(), fc.string(), fc.constantFrom(TESTNET_ID, null, undefined, 21337), (nftId, img, name, network) => {
      const remote = /^(https|ipfs|ar):\/\//i.test(img.trim());
      assert.equal(prizeImg({ nftId, img }, network, { [nftId]: { img: "/nope" } }), remote ? artProxy(nftId) : img);
      assert.equal(prizeImg({ nftId, img: `https://x.example/${img}` }, network), artProxy(nftId));
      assert.equal(prizeTitle({ nftId, name }, network, { [nftId]: { name: "nope" } }, () => "nope"), name);
    }),
  );
});

test("names on mainnet: the saved one, then the registered one when it came from metadata, then the metadata's read here; an id-made name only when there's none", () => {
  const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,20}[A-Za-z0-9]$/);
  fc.assert(
    fc.property(hexId, word, word, fc.option(word, { nil: null }), (nftId, collection, real, learned) => {
      const made = fallbackName(collection, nftId);
      assert.equal(isFallbackName({ nftId, name: made }), true);
      assert.equal(isFallbackName({ nftId, name: made.toLowerCase() }), true);
      const none = {};
      // An id-made name gives way to what the NFT's metadata says.
      assert.equal(prizeTitle({ nftId, name: made }, MAINNET_ID, none, () => learned), learned ?? made);
      // A registered name that isn't id-made is the metadata's own, and stays, whatever was read since.
      fc.pre(!isFallbackName({ nftId, name: real }));
      assert.equal(prizeTitle({ nftId, name: real }, MAINNET_ID, none, () => "other"), real);
      // The saved row beats both.
      assert.equal(prizeTitle({ nftId, name: made }, MAINNET_ID, { [nftId]: { name: "Saved" } }, () => learned), "Saved");
      // A saved row with no name doesn't hide one from metadata.
      assert.equal(prizeTitle({ nftId, name: made }, MAINNET_ID, { [nftId]: { name: null } }, () => learned), learned ?? made);
    }),
  );
});

test("a pool's view shows real art, the bands as logged, and no cost", () => {
  const s = emptyState();
  LOG.events.forEach((e) => apply(s, e));
  for (const price of [5, 10] as const) {
    const pool = poolView(s, price);
    assert.ok(pool);
    assert.deepEqual(pool.bands.map((b) => b.nfts.length), [0, 1, 2, 3, 4].map((band) => adds.filter((l) => l.price === price && l.band === band).length));
    const text = JSON.stringify(pool);
    assert.doesNotMatch(text, /testnet-nft|cost|rtp|edge/i);
  }
});

test("--apply's art check: on mainnet anything but its own picture stops it, unless the owner says so; testnet doesn't care", () => {
  const kinds = fc.constantFrom("its own", "collection sample", "PLACEHOLDER") as fc.Arbitrary<"its own" | "collection sample" | "PLACEHOLDER">;
  fc.assert(
    fc.property(fc.array(kinds), (arts) => {
      const rows = arts.map((art, i) => ({ name: `n${i}`, art }));
      const stop = artRefusal(rows, "mainnet", false);
      assert.equal(stop !== null, arts.some((a) => a !== "its own"));
      assert.equal(artRefusal(rows, "mainnet", true), null);
      assert.equal(artRefusal(rows, "testnet", false), null);
    }),
  );
});

test("an NFT's media reference becomes every gateway's URL, or none at all", () => {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  for (const ref of [`ipfs://${cid}/1.png`, `ipfs://ipfs/${cid}/1.png`, `${cid}/1.png`, `https://gateway.example/ipfs/${cid}/1.png`]) {
    const urls = mediaUrls(ref);
    assert.ok(urls.length >= 3, ref);
    for (const u of urls) assert.ok(u.startsWith("https://") && u.endsWith(`/ipfs/${cid}/1.png`), u);
  }
  assert.deepEqual(mediaUrls("ar://abc"), ["https://arweave.net/abc"]);
  assert.deepEqual(mediaUrls("https://site.example/a.png"), ["https://site.example/a.png"]);
  for (const bad of ["", "http://site.example/a.png", "javascript:alert(1)", "not a uri"]) assert.deepEqual(mediaUrls(bad), []);
});
