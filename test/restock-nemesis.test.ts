import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { commitmentOf } from "../src/lib/rip/draw.ts";
import { createEngine, seasonRoot, type EngineDeps, type RipEngine } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { parseMarket, type MarketRead } from "../src/lib/rip/market.ts";
import { RELIST_MARKET_WAIT_LEDGERS, RELIST_NO_SWEEP_LEDGERS, bandGaps, configRules, type AutobuyLimits, type RestockRules } from "../src/lib/rip/restock.ts";
import { memoryStore, type EventStore } from "../src/lib/rip/store.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import type { RipEvent, RipEventBody, Signer } from "../src/lib/rip/types.ts";
import { createHash } from "node:crypto";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/** What the audit of the restocker found. Each test here failed before its fix. */

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const SELLER = "rSELLERsellerSELLERsellerSELLER";
const SELLER2 = "rSELLER2seller2SELLER2seller2SE";
const NOW = Date.parse("2026-11-03T00:00:00Z");
const xrp = (n: number) => BigInt(Math.round(n * 1e6));

/** Real, spread-out sales around a floor, and listings from different holders, all carrying ids `prefix` says are this collection. */
function market(floorXrp: number, listings: readonly { nftId: string; xrp: number; holder?: string }[] = [], prefix = "alpha:"): MarketRead {
  const fill = [1, 1.05, 1.1].map((k, i) => ({ nftId: `${prefix}filler${i}`, drops: Math.round(floorXrp * k * 1e6), holder: `rH${i}` }));
  return {
    slug: "alpha",
    at: NOW,
    listings: [...listings.map((l) => ({ nftId: l.nftId, drops: Math.round(l.xrp * 1e6), holder: l.holder ?? SELLER })), ...fill].sort((a, b) => a.drops - b.drops),
    sales: Array.from({ length: 12 }, (_, i) => ({ nftId: `${prefix}sold${i}`, drops: Math.round(floorXrp * 1e6), buyer: `rB${i}`, seller: `rS${i}`, at: NOW - i * 3_600_000 })),
  };
}

async function setup(opts: { stock?: readonly number[]; targets?: readonly number[]; autobuy?: Partial<AutobuyLimits> | null; store?: EventStore & { all(): RipEvent[] } } = {}) {
  const ledger = testLedger("nemesis");
  ledger.fund(TREASURY, 3000);
  ledger.fund(VAULT, 300);
  ledger.fund(PLAYER, 9000);
  const store = opts.store ?? memoryStore();
  const reads = new Map<string, MarketRead | null>();
  const reader = { calls: 0, async read(slug: string) { reader.calls++; return reads.get(slug) ?? null; } };
  const slugs = new Map<string, string>();
  const windows = [[0.5, 2], [1.5, 4], [5, 13], [40, 60], [80, 100]] as const;
  const rules: RestockRules = {
    windowOf: (_p, band) => ({ minDrops: xrp(windows[band][0]), maxDrops: xrp(windows[band][1]) }),
    targetOf: (_p, band) => opts.targets?.[band] ?? 0,
    allowOf: () => ["alpha"],
    slugOf: (id) => slugs.get(id) ?? (id.startsWith("alpha:") ? "alpha" : null),
    prices: [5],
    stopBps: 500,
  };
  const limits: AutobuyLimits | null = opts.autobuy ? { dailyDrops: xrp(100), perNftDrops: xrp(100), keepDrops: xrp(2), lowVaultDrops: xrp(10), ...opts.autobuy } : null;
  let ids = 0;
  const make = (extra: Partial<EngineDeps> = {}) => createEngine({ newId: () => `order-${++ids}`, store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, now: () => new Date(NOW), restock: { rules, market: reader, art: async (_u, id) => ({ img: `https://art.example/${id}.png`, name: null }), autobuy: limits }, ...extra });
  const engine = make();
  await engine.openSeason(5, "4000000");
  let n = 0;
  const marks = [1, 3, 9, 50, 90];
  const adds = (opts.stock ?? [20, 10, 4, 2, 2]).flatMap((count, band) =>
    Array.from({ length: count }, () => {
      const nftId = nftIdFor(++n);
      ledger.mintTo(nftId, VAULT);
      slugs.set(nftId, "alpha");
      return { nftId, band, collection: "Alpha", name: `n${n}`, img: "/x.webp", costDrops: String(xrp(marks[band])), markDrops: String(xrp(marks[band])) };
    }),
  );
  assert.equal((await engine.changePool(5, adds)).ok, true);
  await run(engine, ledger, 6);
  return { ledger, store, engine, make, reader, reads, slugs };
}

async function run(engine: RipEngine, ledger: ReturnType<typeof testLedger>, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

async function sweeps(w: { engine: RipEngine; ledger: ReturnType<typeof testLedger> }, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await w.engine.sweep();
    w.ledger.close();
  }
  await w.engine.sweep();
}

async function pullNft(w: { engine: RipEngine; ledger: ReturnType<typeof testLedger> }) {
  for (let i = 0; i < 80; i++) {
    const q = await w.engine.createOrder(PLAYER, 5);
    assert.ok(q.ok, JSON.stringify(q));
    w.ledger.userSubmit(q.tx as never);
    await run(w.engine, w.ledger, 5);
    const o = w.engine.state.orders.get(q.order.id)!;
    if (o.lot) return o;
  }
  throw new Error("no NFT");
}

async function sellIt(w: { engine: RipEngine; ledger: ReturnType<typeof testLedger> }, id: string) {
  const p = w.engine.sellPrice(PLAYER, id);
  assert.ok(p.ok);
  assert.deepEqual(await w.engine.sell(PLAYER, id, p.drops), { ok: true });
  await run(w.engine, w.ledger, 3);
}

const inPool = (engine: RipEngine, nftId: string) => [...engine.state.lots.values()].filter((l) => l.nftId === nftId && (l.status === "available" || l.status === "pending"));

/** A band under target with one direct listing, and a clean floor behind it. */
async function buying(extra: Parameters<typeof setup>[0] = {}) {
  const w = await setup({ stock: [20, 10, 1, 2, 2], targets: [0, 0, 2, 0, 0], autobuy: {}, ...extra });
  const id = nftIdFor(5000);
  w.ledger.listNft(id, SELLER, xrp(9));
  w.slugs.set(id, "alpha");
  w.reads.set("alpha", market(9, [{ nftId: id, xrp: 9 }]));
  return { ...w, id };
}

// ---------- The sweep isn't firing

test("with no cron at all, a sold-back NFT still goes back, from players' own passes, after the wait a market outage gets, and without asking the market", async () => {
  const w = await setup({ stock: [20, 10, 4, 2, 2] });
  const o = await pullNft(w);
  await sellIt(w, o.id);
  // Not at once: a working sweep gets there first, with a floor to check against.
  assert.equal(inPool(w.engine, o.nftId!).length, 0);
  w.ledger.close(RELIST_MARKET_WAIT_LEDGERS + 1);
  await run(w.engine, w.ledger, 2);
  assert.equal(inPool(w.engine, o.nftId!).length, 0);
  w.ledger.close(RELIST_NO_SWEEP_LEDGERS - RELIST_MARKET_WAIT_LEDGERS);
  await run(w.engine, w.ledger, 4);
  const back = inPool(w.engine, o.nftId!);
  assert.equal(back.length, 1);
  assert.equal(back[0].status, "available");
  assert.equal(back[0].markDrops, [...w.engine.state.lots.values()].find((l) => l.lot === o.lot)!.markDrops);
  assert.equal(w.reader.calls, 0);
  const replay = replayLog(w.store.all());
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("that fallback can't race the sweep into listing an NFT twice, on one server or two", async () => {
  const w = await setup({ stock: [20, 10, 4, 2, 2] });
  const other = w.make();
  const o = await pullNft(w);
  await sellIt(w, o.id);
  w.ledger.close(RELIST_NO_SWEEP_LEDGERS + 1);
  await Promise.all([w.engine.advance(), other.sweep(), w.engine.sweep(), other.advance()]);
  w.ledger.close();
  await Promise.all([w.engine.sweep(), other.advance()]);
  await run(w.engine, w.ledger, 3);
  assert.equal(inPool(w.engine, o.nftId!).length, 1);
  assert.ok(replayLog(w.store.all()).ok);
});

// ---------- Counting what's there

test("a lot anchored in the ledger just closed is stock, not a gap: for any validated ledger from its anchor on, the band counts it once", async () => {
  const w = await setup({ stock: [20, 10, 2, 2, 2], targets: [0, 0, 2, 0, 0] });
  const { addLedger } = [...w.engine.state.lots.values()].find((l) => l.band === 2)!;
  const season = w.engine.state.seasons.get("5-1")!;
  const rules = { targetOf: (_p: number, b: number) => (b === 2 ? 2 : 0) };
  for (const validated of [addLedger! - 1, addLedger!, addLedger! + 1, addLedger! + 50]) {
    const [gap] = bandGaps(w.engine.state, 5, season, validated, rules);
    assert.equal(gap.have, 2, `at ${validated}`);
    assert.equal(gap.short, 0, `at ${validated}`);
  }
});

// ---------- What an indexer can say

test("an indexer's ids come out the way the ledger writes them, whatever case it sends", () => {
  fc.assert(fc.property(fc.hexaString({ minLength: 64, maxLength: 64 }), (id) => {
    const read = parseMarket("alpha", { history: [{ type: "SALE", buyer: "rB", seller: "rS", NFTokenID: id.toLowerCase(), costXRP: 5, time: NOW }] }, { nfts: [{ NFTokenID: id.toLowerCase(), account: "rH", cost: { currency: "XRP", amount: 5 } }] }, NOW);
    assert.equal(read.listings[0].nftId, id.toUpperCase());
    assert.equal(read.sales[0].nftId, id.toUpperCase());
  }));
});

test("an indexer's numbers come out as whole drops or not at all, so a bad row can't zero a mark or throw every sweep for half an hour", async () => {
  const id = nftIdFor(1);
  const junk = fc.oneof(fc.constantFrom<unknown>(1e-9, 1e999, "1e999", "Infinity", -1, 0, null, "abc", 1e300, 9e15), fc.double());
  fc.assert(fc.property(junk, fc.oneof(fc.constantFrom<unknown>(1e999, NOW + 86_400_000 * 30, -1, 0, "soon"), fc.constant<unknown>(NOW)), (amount, time) => {
    const read = parseMarket("alpha", { history: [{ type: "SALE", buyer: "rB", seller: "rS", NFTokenID: id, costXRP: amount, time }] }, { nfts: [{ NFTokenID: id, account: "rH", cost: { currency: "XRP", amount } }] }, NOW);
    for (const row of [...read.listings, ...read.sales]) {
      assert.ok(Number.isSafeInteger(row.drops) && row.drops >= 1, String(row.drops));
      assert.doesNotThrow(() => BigInt(row.drops));
    }
    // A sale from the future can't stay "recent" for ever.
    for (const sale of read.sales) assert.ok(sale.at <= NOW);
  }));
  // And a real row still reads.
  const real = parseMarket("alpha", { history: [{ type: "SALE", buyer: "rB", seller: "rS", NFTokenID: id, costXRP: 12.5, time: NOW - 1000 }] }, { nfts: [{ NFTokenID: id, account: "rH", cost: { currency: "XRP", amount: "12.5" } }] }, NOW);
  assert.equal(real.listings[0].drops, 12_500_000);
  assert.equal(real.sales[0].drops, 12_500_000);
});

test("a lookalike's listings and sales can't vouch for a price: with only the real collection's own data thin, the vault doesn't buy", async () => {
  const w = await setup({ stock: [20, 10, 1, 2, 2], targets: [0, 0, 2, 0, 0], autobuy: {} });
  const id = nftIdFor(5000);
  w.ledger.listNft(id, SELLER, xrp(9));
  w.slugs.set(id, "alpha");
  // Every other row is another issuer's NFT, listed and "sold" near the one real listing. This is the same read the test below buys on, but for whose NFTs they are.
  w.reads.set("alpha", market(9, [{ nftId: id, xrp: 9 }], "lookalike:"));
  await sweeps(w, 4);
  assert.equal(w.engine.state.buys.size, 0);
  assert.equal(w.ledger.ownerOf(id), SELLER);
});

test("a lookalike's cheap listings can't mark a sold-back NFT down or hold it out", async () => {
  const w = await setup({ stock: [20, 10, 4, 2, 2] });
  const o = await pullNft(w);
  const mark = w.engine.state.lots.get(o.lot!)!.markDrops;
  w.reads.set("alpha", market(0.1, [], "lookalike:"));
  await sellIt(w, o.id);
  w.ledger.close(40);
  await sweeps(w, 4);
  assert.equal(w.engine.state.restockHolds.size, 0);
  const [back] = inPool(w.engine, o.nftId!);
  assert.equal(back.markDrops, mark);
});

test("the real collection's own data still buys, so the pin isn't a wall", async () => {
  const w = await buying();
  await sweeps(w, 5);
  assert.equal(w.ledger.ownerOf(w.id), VAULT);
});

// ---------- Spend caps and double-buys

test("a plan made while another landed under it doesn't stand: the cap holds across two engines sharing a process's view of the log", async () => {
  const w = await setup({ stock: [20, 10, 1, 2, 2], targets: [0, 0, 3, 0, 0], autobuy: { dailyDrops: xrp(10) } });
  const [a, b] = [nftIdFor(5000), nftIdFor(5001)];
  for (const id of [a, b]) {
    w.ledger.listNft(id, id === a ? SELLER : SELLER2, xrp(9));
    w.slugs.set(id, "alpha");
  }
  w.reads.set("alpha", market(9, [{ nftId: a, xrp: 9 }, { nftId: b, xrp: 9, holder: SELLER2 }]));
  const other = w.make();
  let armed = true;
  let mine: RipEngine;
  // While this engine asks what the vault can spend, another server plans a buy and this one reads it from the log, as any player's request can make it do.
  const chain = { ...w.ledger.chain, account: async (address: string, at?: number) => {
    if (armed && address === VAULT) {
      armed = false;
      await other.sweep();
      await mine.sync();
    }
    return w.ledger.chain.account(address, at);
  } };
  mine = w.make({ chain });
  await mine.sweep();
  const open = [...w.engine.state.buys.values()];
  await w.engine.sync();
  assert.equal([...w.engine.state.buys.values()].filter((x) => x.status !== "ended").length, 1, JSON.stringify(open));
});

test("an NFT the ledger turned a buy away for isn't tried again that day: a seller who keeps pulling it can't keep the vault's slot and grow the log", async () => {
  const w = await buying();
  await w.engine.sweep();
  // The seller moves it just before the buy lands, then moves it back and leaves the listing up.
  w.ledger.moveNft(w.id, SELLER2);
  w.ledger.close();
  await w.engine.advance();
  assert.equal([...w.engine.state.buys.values()][0].status, "ended");
  w.ledger.moveNft(w.id, SELLER);
  await sweeps(w, 6);
  assert.equal(w.engine.state.buys.size, 1);
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenAcceptOffer" && t.tx.Account === VAULT).length, 1);
});

test("a claim goes ahead of a buy on the vault's one slot, neither reuses a sequence, and both land", async () => {
  const w = await buying();
  const o = await pullNft(w);
  // The buy is planned and the player asks for their NFT before it's sent.
  w.reads.set("alpha", null);
  assert.deepEqual(await w.engine.claim(PLAYER, o.id), { ok: true });
  w.reads.set("alpha", market(9, [{ nftId: w.id, xrp: 9 }]));
  await w.engine.sweep();
  const firstOut = [...w.engine.state.intents.values()].filter((i) => i.account === VAULT);
  assert.equal(firstOut.length, 1);
  assert.equal(firstOut[0].kind, "claim_offer");
  await sweeps(w, 6);
  const vaultTxs = w.ledger.history.filter((t) => t.tx.Account === VAULT);
  assert.equal(new Set(vaultTxs.map((t) => t.tx.Sequence)).size, vaultTxs.length);
  assert.equal(w.engine.state.orders.get(o.id)!.pull, "offered");
  assert.equal(w.ledger.ownerOf(w.id), VAULT);
  assert.ok(replayLog(w.store.all()).ok);
});

test("a person can't register a bought NFT on other terms while it's on its way into the pool, which would leave the public log failing its replay for good", async () => {
  const w = await buying();
  await w.engine.sweep();
  w.ledger.close();
  await w.engine.advance();
  assert.equal([...w.engine.state.buys.values()][0].status, "filled");
  const refused = await w.engine.changePool(5, [{ nftId: w.id, band: 3, collection: "Alpha", name: "by hand", img: "/x.webp", costDrops: "1", markDrops: String(xrp(50)) }]);
  assert.equal(refused.ok, false);
  await sweeps(w, 4);
  assert.equal(inPool(w.engine, w.id).length, 1);
  const replay = replayLog(w.store.all());
  assert.ok(replay.ok, JSON.stringify(replay));
});

// ---------- The kill switch

test("the kill switch gets through a busy log: losing a race for the head isn't an answer to the owner", async () => {
  const inner = memoryStore();
  let lose = 3;
  const store = { ...inner, append: async (head: number, events: readonly RipEvent[]) => (events[0]?.type === "restock_switch" && lose-- > 0 ? false : inner.append(head, events)) };
  const w = await setup({ store: store as never, autobuy: {} });
  assert.equal(await w.engine.setAutobuy(false, "owner", "stop"), true);
  assert.equal(w.engine.state.autobuyOff?.by, "owner");
});

test("a buy logged but never sent stays unsent once it's switched off: the kill switch beats the crash-recovery resend", async () => {
  const w = await buying();
  let crash = true;
  const crashy = w.make({ beforeSubmit: () => { if (crash) throw new Error("crash"); } });
  await crashy.sweep().catch(() => {});
  assert.equal([...w.store.all()].filter((e) => e.type === "tx_intent" && e.data.kind === "vault_buy").length, 1);
  crash = false;
  assert.equal(await w.engine.setAutobuy(false, "owner"), true);
  for (let i = 0; i < 30; i++) {
    await w.engine.sweep();
    w.ledger.close(2);
  }
  assert.equal(w.ledger.ownerOf(w.id), SELLER);
  assert.equal(w.ledger.history.filter((t) => t.tx.Account === VAULT && t.tx.TransactionType === "NFTokenAcceptOffer").length, 0);
  assert.equal([...w.engine.state.buys.values()][0].status, "ended");
  assert.equal(w.engine.state.intents.size, 0);
});

// ---------- The log that's really out there

test("the live mainnet log, all 59 events, runs on under this code: a real $5 pull, a sale, its re-add on the same open season, and a replay that still holds", async () => {
  const { events: published, treasury, vault } = JSON.parse(readFileSync(new URL("./fixtures/mainnet-log-20261102-59.json", import.meta.url), "utf8")) as { events: RipEvent[]; treasury: string; vault: string };
  assert.equal(published.length, 59);
  assert.ok(replayLog(published).ok);
  // Draws here can't use the real seeds, so each season commits to a test secret instead, and the chain is resealed around that. Nothing else changes.
  const SECRET = "not the real one";
  const events: RipEvent[] = [];
  for (const { seq: _s, at, prev: _p, hash: _h, ...body } of published) {
    const draft = body as unknown as RipEventBody;
    const swapped = draft.type === "season_open" ? ({ ...draft, data: { ...draft.data, commit: commitmentOf(seasonRoot(SECRET, draft.data.season), draft.data.length) } } as RipEventBody) : draft;
    events.push(...sealEvents(events.length, events.at(-1)?.hash ?? "", [swapped], at));
  }
  const inner = memoryStore();
  await inner.append(0, events);
  const ledger = testLedger("live", 0, 108_076_000);
  ledger.fund(treasury, 175);
  ledger.fund(vault, 10);
  ledger.fund(PLAYER, 9000);
  const replayed = replayLog(events);
  assert.ok(replayed.ok);
  const live = [...replayed.state.lots.values()].filter((l) => l.status === "available");
  for (const l of live) ledger.mintTo(l.nftId, vault);
  const signer: Signer = {
    address: (role) => (role === "treasury" ? treasury : role === "vault" ? vault : "rNoMinter"),
    sign(_r, tx) {
      const blob = JSON.stringify(tx);
      return { blob, hash: createHash("sha256").update(blob).digest("hex").toUpperCase() };
    },
  };
  const rules = configRules();
  const reader = { read: async () => null };
  const engine = createEngine({ store: inner, chain: ledger.chain, signer, drawSecret: SECRET, expectedNetworkId: 0, now: () => new Date(NOW), shelf: [5, 10], restock: { rules, market: reader, autobuy: null } });
  await engine.advance();
  assert.equal(engine.state.head, 59);
  assert.equal(engine.state.activeSeason.get(5), "5-3");
  const w = { engine, ledger };
  let sold = 0;
  for (let i = 0; i < 40 && !sold; i++) {
    const q = await engine.createOrder(PLAYER, 5);
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(q.order.season, "5-3");
    ledger.userSubmit(q.tx as never);
    for (let k = 0; k < 6; k++) {
      ledger.close();
      await engine.sweep();
    }
    const o = engine.state.orders.get(q.order.id)!;
    assert.equal(o.status, "drawn");
    if (o.lot) {
      const p = engine.sellPrice(PLAYER, o.id);
      assert.ok(p.ok);
      assert.equal(BigInt(p.drops), (BigInt(engine.state.lots.get(o.lot)!.markDrops) * 9506n) / 10_000n);
      assert.deepEqual(await engine.sell(PLAYER, o.id, p.drops), { ok: true });
      await sweeps(w, 3);
      assert.equal(engine.state.orders.get(o.id)!.pull, "sold");
      assert.equal(engine.state.lots.get(o.lot)!.status, "returned");
      ledger.close(RELIST_MARKET_WAIT_LEDGERS + 1);
      await sweeps(w, 4);
      assert.equal(inPool(engine, o.nftId!).length, 1);
      assert.equal(inPool(engine, o.nftId!)[0].status, "available");
      sold += 1;
    }
  }
  assert.equal(sold, 1, "the fixed pack seed never reached an NFT");
  const replay = replayLog(inner.all());
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.ok(inner.all().some((e) => e.type === "pool_change" && e.data.v === 2 && e.data.id.startsWith("relist-")));
});

// ---------- Everything at once

test("any mix of pulls, sales, claims, listings, broker fills, floor moves, kill switches and two servers: the books, the pool and the replay all stay true", async () => {
  const op = fc.oneof(
    { weight: 4, arbitrary: fc.constant({ k: "pull" as const }) },
    { weight: 4, arbitrary: fc.nat(40).map((n) => ({ k: "sell" as const, n })) },
    { weight: 2, arbitrary: fc.nat(40).map((n) => ({ k: "claim" as const, n })) },
    { weight: 2, arbitrary: fc.nat(40).map((n) => ({ k: "cancel" as const, n })) },
    { weight: 2, arbitrary: fc.nat(40).map((n) => ({ k: "accept" as const, n })) },
    { weight: 2, arbitrary: fc.record({ n: fc.nat(6), price: fc.constantFrom(8, 9, 9.5, 10), broker: fc.boolean() }).map((x) => ({ k: "list" as const, ...x })) },
    { weight: 2, arbitrary: fc.constant({ k: "fill" as const }) },
    { weight: 1, arbitrary: fc.nat(6).map((n) => ({ k: "pullListing" as const, n })) },
    { weight: 2, arbitrary: fc.constantFrom(null, 2, 7, 9, 12).map((floor) => ({ k: "floor" as const, floor })) },
    { weight: 1, arbitrary: fc.boolean().map((on) => ({ k: "switch" as const, on })) },
    { weight: 5, arbitrary: fc.boolean().map((other) => ({ k: "sweep" as const, other })) },
    { weight: 3, arbitrary: fc.constantFrom(1, 3, 20, 240).map((n) => ({ k: "close" as const, n })) },
  );
  const CAFE = "rpx9JThQ2y37FaGeeJP7PXDUVEXY3PHZSC";
  await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 8, maxLength: 40 }), async (ops) => {
    const w = await setup({ stock: [20, 8, 3, 2, 2], targets: [0, 0, 5, 0, 0], autobuy: { dailyDrops: xrp(25), perNftDrops: xrp(11) } });
    const other = w.make();
    const vaultStart = w.ledger.balance(VAULT);
    const treasuryStart = w.ledger.balance(TREASURY);
    const ids = Array.from({ length: 7 }, (_, i) => nftIdFor(6000 + i));
    const listed: { nftId: string; xrp: number; holder: string }[] = [];
    let floor: number | null = 9;
    const refresh = () => w.reads.set("alpha", floor === null ? null : market(floor, listed));
    refresh();
    const orders = () => [...w.engine.state.orders.values()].filter((o) => o.lot);
    for (const step of ops) {
      if (step.k === "pull") {
        const q = await w.engine.createOrder(PLAYER, 5);
        if (q.ok) w.ledger.userSubmit(q.tx as never);
      } else if (step.k === "sell" || step.k === "claim" || step.k === "cancel" || step.k === "accept") {
        const all = orders();
        const o = all.length ? all[step.n % all.length] : null;
        if (!o) continue;
        if (step.k === "sell") {
          const p = w.engine.sellPrice(PLAYER, o.id);
          if (p.ok) await w.engine.sell(PLAYER, o.id, p.drops);
        } else if (step.k === "claim") await w.engine.claim(PLAYER, o.id);
        else if (step.k === "cancel") await w.engine.cancelClaim(PLAYER, o.id);
        else if (o.pull === "offered" && o.offerId) w.ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: o.offerId });
      } else if (step.k === "list") {
        const id = ids[step.n];
        if (listed.some((l) => l.nftId === id) || w.ledger.ownerOf(id) === VAULT) continue;
        w.ledger.listNft(id, SELLER, xrp(step.price), step.broker ? { destination: CAFE } : {});
        w.slugs.set(id, "alpha");
        listed.push({ nftId: id, xrp: step.price, holder: SELLER });
        refresh();
      } else if (step.k === "fill") {
        for (const [id, offer] of w.ledger.offers) if (offer.isBuy && offer.owner === VAULT && [...w.ledger.offers.values()].some((o) => o.nftId === offer.nftId && !o.isBuy && o.amount && w.ledger.ownerOf(o.nftId) === o.owner)) w.ledger.brokerFill(id);
      } else if (step.k === "pullListing") {
        const id = ids[step.n];
        if (w.ledger.ownerOf(id) === SELLER) w.ledger.moveNft(id, SELLER2);
        else if (w.ledger.ownerOf(id) === SELLER2) w.ledger.moveNft(id, SELLER);
      } else if (step.k === "floor") {
        floor = step.floor;
        refresh();
      } else if (step.k === "switch") await w.engine.setAutobuy(step.on, "owner");
      else if (step.k === "sweep") await (step.other ? other : w.engine).sweep();
      else w.ledger.close(step.n);
    }
    // Let it all land.
    for (let i = 0; i < 12; i++) {
      w.ledger.close(i % 3 === 0 ? 40 : 1);
      await w.engine.sweep();
    }
    await w.engine.sync();
    const s = w.engine.state;
    const replay = replayLog(w.store.all());
    assert.ok(replay.ok, JSON.stringify(replay));
    // Never more than one buy out at a time, and the vault spent no more than its day's budget, in XRP that really left it.
    assert.ok([...s.buys.values()].filter((b) => b.status !== "ended" && b.status !== "registered").length <= 1);
    const spent = vaultStart - w.ledger.balance(VAULT);
    assert.ok(spent <= xrp(25) + 100_000n, `the vault spent ${spent}`);
    // Each NFT has at most one live lot, and each is really in the vault.
    const live = [...s.lots.values()].filter((l) => l.status === "pending" || (l.status === "available" && l.removeLedger === null));
    assert.equal(new Set(live.map((l) => l.nftId)).size, live.length);
    for (const l of live) assert.equal(w.ledger.ownerOf(l.nftId), VAULT, l.nftId);
    // No live lot is an NFT a player holds, in the stash or out.
    const held = new Set([...s.orders.values()].filter((o) => o.nftId && o.pull !== "sold").map((o) => o.nftId));
    for (const l of live) assert.ok(!held.has(l.nftId), l.nftId);
    // A sold-back NFT's mark only comes down, lap by lap.
    const byNft = new Map<string, bigint>();
    for (const e of w.store.all()) {
      if (e.type !== "pool_change") continue;
      for (const a of e.data.adds) {
        const before = byNft.get(a.nftId);
        if (before !== undefined && e.data.id.startsWith("relist-")) assert.ok(BigInt(a.markDrops) <= before);
        byNft.set(a.nftId, BigInt(a.markDrops));
      }
    }
    // The treasury paid out only what the sales were quoted, plus fees, and took in every pack.
    const paidIn = [...s.orders.values()].filter((o) => o.txHash).reduce((a, o) => a + BigInt(o.drops), 0n);
    const paidOut = [...s.orders.values()].filter((o) => o.pull === "sold" && o.sellDrops).reduce((a, o) => a + BigInt(o.sellDrops!), 0n);
    const prizes = [...s.orders.values()].filter((o) => o.pull === "redeemed" && o.prize).reduce((a, o) => a + BigInt(o.prize!.amount), 0n);
    const fees = treasuryStart + paidIn - paidOut - prizes - w.ledger.balance(TREASURY);
    assert.ok(fees >= 0n && fees < 100_000n, `treasury off by ${fees}`);
  }), { numRuns: Number(process.env.FUZZ_RUNS ?? 40) });
});
