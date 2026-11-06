import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createEngine } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { pgConfig } from "../src/lib/rip/pg-pool.ts";
import { GENESIS_HASH } from "../src/lib/rip/state.ts";
import { pgOnce, pgPrivate, pgStore, type SqlClient } from "../src/lib/rip/store-pg.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import type { RipEvent } from "../src/lib/rip/types.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/**
 * The races that matter, on a real Postgres with real connections, where PGlite's single connection can't interleave.
 * Needs a throwaway database, because it drops the tables:
 *   SEAL_TEST_PG_URL=postgres://127.0.0.1:55432/seal pnpm test
 * Point it at PgBouncer in transaction mode to test what production runs. It uses the app's own pool settings, with
 * SEAL_TEST_PG_MAX connections (32 by default) so the races really interleave. Skipped without the URL.
 */
const url = process.env.SEAL_TEST_PG_URL;
const skip = url ? false : "SEAL_TEST_PG_URL isn't set";

let pool: Pool;
let sql: SqlClient;
const draft = (n: number) => ({ type: "scan_cursor" as const, data: { account: "r", ledger: n } });

before(async () => {
  if (skip) return;
  pool = new Pool({ ...pgConfig(url as string), max: Number(process.env.SEAL_TEST_PG_MAX ?? 32) });
  sql = { query: (t, p) => pool.query(t, p ? [...p] : []) as never };
  const version = await pool.query("SELECT version() AS v");
  assert.match(String(version.rows[0].v), /PostgreSQL/);
});

after(async () => {
  if (!skip) await pool.end();
});

const fresh = async () => {
  await pool.query("DROP TABLE IF EXISTS seal_rip_events, seal_rip_once, seal_rip_private");
  const store = pgStore(sql);
  await store.ensureSchema();
  return store;
};

test("of many servers appending at one head, exactly one wins each round, batches stay whole, and the chain has no gap", { skip }, async () => {
  const store = await fresh();
  let head = 0;
  let headHash = GENESIS_HASH;
  for (let round = 0; round < 40; round++) {
    const attempts = Array.from({ length: 24 }, (_, i) => sealEvents(head, headHash, Array.from({ length: 1 + (i % 4) }, (_x, k) => draft(round * 100 + i * 10 + k)), new Date().toISOString()));
    const wins = await Promise.all(attempts.map((batch) => store.append(head, batch)));
    assert.equal(wins.filter(Boolean).length, 1, `round ${round}`);
    const won = attempts[wins.indexOf(true)];
    head = won[won.length - 1].seq;
    headHash = won[won.length - 1].hash;
  }
  const all = await store.readFrom(0);
  all.forEach((e, i) => assert.equal(e.seq, i + 1));
  let prev = GENESIS_HASH;
  for (const e of all) {
    assert.equal(e.prev, prev);
    prev = e.hash;
  }
});

test("a reader never sees a hole in the log while writers are racing", { skip }, async () => {
  const store = await fresh();
  let stop = false;
  const reader = (async () => {
    let reads = 0;
    while (!stop) {
      const seen = await store.readFrom(0);
      seen.forEach((e, i) => assert.equal(e.seq, i + 1, "a reader saw a gap"));
      reads++;
    }
    return reads;
  })();
  const writer = async () => {
    for (let i = 0; i < 40; i++) {
      for (;;) {
        const log = await store.readFrom(0);
        const last = log[log.length - 1] as RipEvent | undefined;
        if (await store.append(last?.seq ?? 0, sealEvents(last?.seq ?? 0, last?.hash ?? GENESIS_HASH, [draft(i), draft(i + 1)], new Date().toISOString()))) break;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, writer));
  stop = true;
  assert.ok((await reader) > 0);
  const all = await store.readFrom(0);
  assert.equal(all.length, 8 * 40 * 2);
});

test("replay protection holds under real concurrency: one winner per id, and an expired id can be used again", { skip }, async () => {
  await fresh();
  const once = pgOnce(sql);
  for (let round = 0; round < 20; round++) {
    const results = await Promise.all(Array.from({ length: 40 }, () => once.consume(`n-${round}`, 60)));
    assert.equal(results.filter(Boolean).length, 1, `round ${round}`);
  }
  assert.equal(await once.consume("short", 1), true);
  assert.equal(await once.consume("short", 1), false);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await once.consume("short", 1), true);
});

test("a shipping address can be written many times at once and reads back whole", { skip }, async () => {
  await fresh();
  const secrets = pgPrivate(sql);
  await Promise.all(Array.from({ length: 30 }, (_, i) => secrets.put("k", `value-${i}`)));
  assert.match(String(await secrets.get("k")), /^value-\d+$/);
  assert.equal(await secrets.get("missing"), null);
});

test("four servers on one real database serve many players at once: every pull once, every sale paid once, the log replays", { skip }, async () => {
  const store = await fresh();
  const ledger = testLedger("pg-real");
  ledger.fund(TREASURY, 5000);
  ledger.fund(VAULT, 100);
  const players = Array.from({ length: 12 }, (_, i) => `rPLAYER${i}`);
  players.forEach((p) => ledger.fund(p, 500));
  const servers = Array.from({ length: 4 }, () => createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "pg-real-secret", expectedNetworkId: 1 }));
  const [first] = servers;
  await first.openSeason(5, "4000000");
  const adds = Array.from({ length: 150 }, (_, i) => {
    const nftId = nftIdFor(5000 + i);
    ledger.mintTo(nftId, VAULT);
    return { nftId, band: i % 5, collection: `c${i % 7}`, name: `n${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "2000000" };
  });
  assert.equal((await first.changePool(5, adds)).ok, true);
  const pump = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      await Promise.all(servers.map((s) => s.advance()));
      ledger.close();
      await Promise.all(servers.map((s) => s.advance()));
    }
  };
  await pump(8);
  // A burst can lose every try at the log's head and hear "try again". That's safe, and it's what a player would do.
  let busy = 0;
  const tap = async <T extends { ok: boolean; code?: string }>(f: () => Promise<T>): Promise<T> => {
    for (;;) {
      const r = await f();
      if (r.code !== "busy") return r;
      busy++;
      await new Promise((d) => setTimeout(d, Math.random() * 20));
    }
  };
  // Each player taps on a different server, all at once, twice over.
  const quotes = await Promise.all(players.flatMap((p, i) => [tap(() => servers[i % 4].createOrder(p, 5)), tap(() => servers[(i + 1) % 4].createOrder(p, 5))]));
  assert.ok(quotes.every((q) => q.ok), JSON.stringify(quotes.find((q) => !q.ok)));
  const ids = new Map<string, string>();
  for (const q of quotes) if (q.ok) ids.set(q.order.address, q.order.id);
  assert.equal(new Set(quotes.map((q) => (q.ok ? q.order.id : ""))).size, players.length, "a double tap across servers makes one order");
  for (const q of quotes.slice(0).filter((_, i) => i % 2 === 0)) if (q.ok) ledger.userSubmit(q.tx as never);
  await pump(6);
  await Promise.all(servers.map((s) => s.sync()));
  const drawn = [...ids.values()].map((id) => first.state.orders.get(id));
  assert.ok(drawn.every((o) => o?.status === "drawn"), JSON.stringify(drawn.map((o) => o?.status)));
  assert.equal(new Set(drawn.map((o) => o?.nftId)).size, players.length, "no NFT drawn twice");
  // Everyone sells on two servers at once.
  await Promise.all(
    players.flatMap((p, i) => {
      const id = ids.get(p) as string;
      const q = first.sellPrice(p, id);
      assert.ok(q.ok);
      return [tap(() => servers[i % 4].sell(p, id, q.drops)), tap(() => servers[(i + 2) % 4].sell(p, id, q.drops))];
    }),
  );
  await pump(30);
  await Promise.all(servers.map((s) => s.sync()));
  for (const p of players) {
    const paid = ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.tx.Destination === p && t.result === "tesSUCCESS");
    assert.equal(paid.length, 1, `${p} paid ${paid.length} times`);
  }
  const replay = replayLog(await store.readFrom(0));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  // All four servers ended up believing the same thing.
  const heads = new Set(servers.map((s) => `${s.state.head}:${s.state.headHash}`));
  assert.equal(heads.size, 1);
  console.log(`busy answers in the burst: ${busy}`);
});
