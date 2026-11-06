import assert from "node:assert/strict";
import { test } from "node:test";
import { artProxy } from "../src/lib/rip/nft-art.ts";
import { addressOf, world } from "./support-routes.ts";

test("with rails off the pool route doesn't exist, and the pack API keeps its plan samples for the demo", async () => {
  const w = await world({ off: true } as never);
  assert.equal((await w.call("GET", "/api/rip/pool/5")).status, 404);
  const pack = await w.call("GET", "/api/nft/5");
  assert.equal(pack.status, 200);
  assert.ok(pack.body.pack.tiers.some((t: { collection: unknown }) => t.collection), "the demo still has its samples");
});

test("a pack's pool reads from the season and the log, with nothing about cost, and only for packs on the shelf", async () => {
  const w = await world();
  assert.deepEqual((await w.call("GET", "/api/rip/pool/5")).body, { pool: null });
  assert.equal((await w.call("GET", "/api/rip/pool/25")).status, 404);
  assert.equal((await w.call("GET", "/api/rip/pool/abc")).status, 404);
  await w.open(5, "4000000");
  const r = await w.call("GET", "/api/rip/pool/5");
  assert.equal(r.status, 200);
  assert.equal(r.body.pool.season, "5-1");
  assert.equal(r.body.pool.bands.length, 5);
  const listed = r.body.pool.bands.flatMap((b: { nfts: unknown[] }) => b.nfts);
  assert.ok(listed.length > 0);
  assert.doesNotMatch(JSON.stringify(r.body), /costDrops|rtp|edge/i);
  // On mainnet a row with a picture that isn't its own goes to the art route, which reads the NFT's own metadata, or says it can't. Never what the log says.
  for (const n of listed as { id: string; img: string }[]) assert.equal(n.img, artProxy(n.id));
});

test("with rails on, the free demo's pack holds what's in the pool and nothing from the plan; a pulled NFT drops out of both", async () => {
  const w = await world();
  await w.open(5, "4000000");
  const me = w.client(addressOf(1));
  w.fund(me);
  const pack = await w.call("GET", "/api/nft/5");
  assert.equal(pack.status, 200);
  const pool = (await w.call("GET", "/api/rip/pool/5")).body.pool;
  const ids = (p: { bands: { nfts: { id: string }[] }[] }) => p.bands.flatMap((b) => b.nfts.map((n) => n.id));
  const before = ids(pool);
  const samples = pack.body.pack.tiers.flatMap((t: { collection: { samples: { id: string }[] } | null }) => t.collection?.samples.map((s) => s.id) ?? []);
  assert.deepEqual([...samples].sort(), [...before].sort());
  assert.deepEqual(pack.body.pack.chase, []);
  assert.equal(pack.body.pack.fiftyUpPct, 0);

  const id = await w.pull(me);
  const nft = w.orderOf(id)?.lot ? w.engine.state.lots.get(w.orderOf(id)?.lot as string)?.nftId : null;
  assert.ok(nft, "this test's season has no token rows, so a pull lands on an NFT");
  const after = ids((await w.call("GET", "/api/rip/pool/5")).body.pool);
  assert.equal(after.includes(nft), false);
  assert.equal(after.length, before.length - 1);
});
