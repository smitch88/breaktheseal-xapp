import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createEngine } from "../src/lib/rip/engine.ts";
import { pgOnce, pgPrivate, pgStore, type SqlClient } from "../src/lib/rip/store-pg.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

async function db() {
  const pg = new PGlite();
  const sql: SqlClient = { query: (t, p) => pg.query(t, p ? [...p] : []) as never };
  const store = pgStore(sql);
  await store.ensureSchema();
  return { pg, sql, store };
}

test("the Postgres log behaves like the one in the tests: head check, whole batches, a pull end to end", async () => {
  const { pg, store } = await db();
  const ledger = testLedger();
  ledger.fund(TREASURY, 100);
  ledger.fund(VAULT, 100);
  const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
  ledger.fund(PLAYER, 100);
  const make = () => createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1 });
  const a = make();
  const b = make();
  await a.openSeason(5, "4000000");
  const nfts = Array.from({ length: 10 }, (_, i) => nftIdFor(i + 1));
  nfts.forEach((n) => ledger.mintTo(n, VAULT));
  const adds = nfts.map((nftId, i) => ({ nftId, band: i % 5, collection: "c", name: "n", img: "/x.webp", costDrops: "1000000", markDrops: "1000000" }));
  assert.ok((await a.changePool(5, adds)).ok);
  for (let i = 0; i < 5; i++) {
    await Promise.all([a.advance(), b.advance()]);
    ledger.close();
  }
  await a.sync();
  const q = await a.createOrder(PLAYER, 5);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  for (let i = 0; i < 6; i++) {
    await Promise.all([a.advance(), b.advance()]);
    ledger.close();
  }
  await a.sync();
  assert.equal(a.state.orders.get(q.order.id)!.status, "drawn");
  const events = await store.readFrom(0);
  const replay = replayLog(events);
  assert.ok(replay.ok, JSON.stringify(replay));
  // A stale head writes nothing.
  assert.equal(await store.append(1, events.slice(0, 1).map((e) => ({ ...e, seq: 2 }))), false);
  assert.equal((await store.readFrom(0)).length, events.length);
  await pg.close();
});

test("replay protection is atomic: of many tries at one id, exactly one wins", async () => {
  const { pg, sql } = await db();
  const once = pgOnce(sql);
  const results = await Promise.all(Array.from({ length: 20 }, () => once.consume("challenge-1", 60)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await once.consume("challenge-2", 60), true);
  const secrets = pgPrivate(sql);
  await secrets.put("ship:1", "addr");
  await secrets.put("ship:1", "addr2");
  assert.equal(await secrets.get("ship:1"), "addr2");
  assert.equal(await secrets.get("nope"), null);
  await pg.close();
});
