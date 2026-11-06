import assert from "node:assert/strict";
import { test } from "node:test";
import type { NftPrice } from "../src/config/nft-packs.ts";
import { createEngine } from "../src/lib/rip/engine.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { XRP_TOKEN } from "../src/lib/rip/tokens.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/**
 * With the switch off, the log has to be the log the site writes today, byte for byte. This walks the money paths on a fixed clock with fixed ids and pins the head of the
 * hash chain. The figures below came from running this same file on the live branch this work was last merged from (f4db83dff), so any change to what a single order writes fails here.
 *
 * The restocker merge moved the head once, on purpose: a pool change's root now commits each lot's mark (`v: 2`), so its anchor memo and that anchor's
 * hash differ. Run against the live branch (e0e46a880), the walk's 75 events matched field for field except event 4's root and v, and events 7 and 8's
 * anchor hash, and nothing an order writes moved. That head was e1c32a5a2fb5f33ca41f051876b3c0434cc818121e64eb0a2c195f95ebf2e84f.
 */
const GOLDEN = { events: 75, head: "f2614a4673c8b03d728d10e5177e9485145adcf57c44d0994e79551b73c68e29" };

const GOLDEN_SHAPES = "4d65bd9b45a7c21613922dc5b10e9c295b5b14e15e2943fbb56703534d85cdc3";

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const PRICE: NftPrice = 5;
const PLAN = { bandBps: [5000, 3000, 1000, 800, 200], prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 6000, valueDrops: "1000000" }, { band: 0, token: XRP_TOKEN, bps: 4000, valueDrops: "2000000" }, { band: 3, token: XRP_TOKEN, bps: 5000, valueDrops: "42000000" }], tokens: [] };

async function walk() {
  const ledger = testLedger("golden");
  ledger.fund(TREASURY, 800);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 800);
  ledger.fund(OTHER, 800);
  const store = memoryStore();
  let tick = Date.parse("2026-11-02T00:00:00.000Z");
  let ids = 0;
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "golden-secret", expectedNetworkId: 1, now: () => new Date((tick += 1000)), newId: () => `id${++ids}` });
  const run = async (passes = 3) => {
    for (let i = 0; i < passes; i++) {
      await engine.advance();
      ledger.close();
      await engine.advance();
    }
  };
  await engine.openSeason(PRICE, "4000000", null, PLAN);
  const adds = [0, 1, 2, 3, 4].flatMap((band) => Array.from({ length: 6 }, (_, i) => {
    const nftId = nftIdFor(9000 + band * 10 + i);
    ledger.mintTo(nftId, VAULT);
    return { nftId, band, collection: `c${i}`, name: `n${band}-${i}`, img: "/x.webp", costDrops: "1000000", markDrops: "3000000" };
  }));
  assert.equal((await engine.changePool(PRICE, adds)).ok, true);
  await run(5);
  const pulled: string[] = [];
  for (const who of [PLAYER, OTHER, PLAYER, PLAYER, OTHER, PLAYER, PLAYER, OTHER]) {
    const q = await engine.createOrder(who, PRICE);
    assert.ok(q.ok, JSON.stringify(q));
    ledger.userSubmit(q.tx as never);
    pulled.push(q.order.id);
    await run(5);
  }
  // A wrong amount, a stray payment, a lapse.
  const wrong = await engine.createOrder(PLAYER, PRICE);
  assert.ok(wrong.ok);
  ledger.userSubmit({ ...wrong.tx, Amount: "3000000" } as never);
  await run(3);
  ledger.userSubmit({ TransactionType: "Payment", Account: OTHER, Destination: TREASURY, Amount: "2000000" } as never);
  await run(3);
  ledger.close(90);
  await run(2);
  // Every way out of the stash.
  for (const [i, id] of pulled.entries()) {
    const o = engine.state.orders.get(id)!;
    if (o.prize) await engine.redeem(o.address, id);
    else if (i % 2) {
      const p = engine.sellPrice(o.address, id);
      if (p.ok) await engine.sell(o.address, id, p.drops);
    } else await engine.claim(o.address, id);
    await run(3);
  }
  await run(4);
  return store.readFrom(0);
}

test("switch off: the log is the log the site writes today, byte for byte", async () => {
  const log = await walk();
  assert.ok(replayLog(log).ok);
  assert.deepEqual({ events: log.length, head: log.at(-1)?.hash }, GOLDEN);
});

/** The keys of an answer, all the way down, in order: what a page can read from it, with none of its random ids. */
const shape = (v: unknown): unknown => (Array.isArray(v) ? v.slice(0, 1).map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, shape(x)])) : v === null ? null : typeof v);

test("switch off: every route answers in the shape the live site's does", async () => {
  const { addressOf, world, sha } = await import("./support-routes.ts");
  const w = await world({ xaman: true });
  await w.open(5, "4000000", [12, 12, 12, 12, 12]);
  const me = w.client(addressOf(1));
  w.fund(me);
  const q = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  w.ledger.userSubmit(q.body.tx as never);
  await w.pump(5);
  const id = q.body.order.id as string;
  const seen: Record<string, unknown> = {};
  const look = async (name: string, a: Promise<{ status: number; body: unknown }>) => {
    const r = await a;
    seen[name] = [r.status, shape(r.body)];
  };
  await look("quote", Promise.resolve({ status: q.status, body: q.body }));
  await look("config", w.call("GET", "/api/rip/config"));
  await look("open", w.call("GET", "/api/rip/orders", { as: me }));
  await look("order", w.call("GET", `/api/rip/orders/${id}`, { as: me }));
  await look("holdings", w.call("GET", "/api/rip/holdings", { as: me }));
  await look("pending", w.call("GET", "/api/rip/pending", { as: me }));
  await look("sellQuote", w.call("POST", `/api/rip/orders/${id}/sell`, { as: me }));
  const drops = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body.drops;
  await look("sell", w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } }));
  await w.pump(4);
  await look("sold", w.call("GET", `/api/rip/orders/${id}`, { as: me }));
  assert.equal(sha(JSON.stringify(seen)), GOLDEN_SHAPES);
});

test("switch off: routes that sell in bulk don't exist, and the config answer has nothing new in it", async () => {
  const { addressOf, world } = await import("./support-routes.ts");
  const w = await world({ cards: true });
  await w.open();
  const me = w.client(addressOf(1));
  w.fund(me);
  for (const [method, path] of [["POST", "/api/rip/bundles"], ["GET", "/api/rip/bundles"], ["POST", "/api/rip/payouts"], ["GET", "/api/rip/bundle-room?code=pokemon_25"]] as const) {
    assert.equal((await w.call(method, path, { as: me, body: method === "POST" ? { price: 5, qty: 3 } : undefined })).status, 404, path);
  }
  const config = await w.call("GET", "/api/rip/config");
  assert.deepEqual(Object.keys(config.body).sort(), ["cardsOn", "mode", "tiers", "treasury", "vault"]);
  const open = await w.call("GET", "/api/rip/orders", { as: me });
  assert.deepEqual(Object.keys(open.body.open).sort(), ["cards", "nft"]);
  const q = await w.newOrder(me);
  assert.ok(!("bundle" in q.order) && !("payout" in q.order));
  for (const v of ["ON", "true", "1", " on"]) {
    const off = await world({ env: { SEAL_MULTI_QTY: v } });
    await off.open();
    const c = off.client(addressOf(2));
    off.fund(c);
    assert.equal((await off.call("POST", "/api/rip/bundles", { as: c, body: { price: 5, qty: 3, acceptedTerms: true } })).status, 404, v);
  }
});
