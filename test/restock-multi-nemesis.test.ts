import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { createEngine, sellBackShare, type EngineDeps, type RipEngine } from "../src/lib/rip/engine.ts";
import type { MarketRead } from "../src/lib/rip/market.ts";
import { BUY_MAX_SHARE, RELIST_NO_SWEEP_LEDGERS, type AutobuyLimits, type RestockRules } from "../src/lib/rip/restock.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import type { OrderState, SeasonState } from "../src/lib/rip/state.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/**
 * The audit of the restocker merged with multi-pack orders: bundles, bulk sales and the room they share with buying. Each test here failed before its fix.
 */

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const SELLER = "rSELLERsellerSELLERsellerSELLER";
const NOW = Date.parse("2026-11-03T00:00:00Z");
const xrp = (n: number) => BigInt(Math.round(n * 1e6));
/** Every band pays an NFT, so a bundle fills a stash fast, and Chase is common enough that what's in it moves the sell-back share. */
const NFTS_ONLY = { bandBps: [3000, 3000, 2000, 1000, 1000], prizeTable: [], tokens: [] };
/** Priced so the pack sits at about 93.3% sold back with the default marks and stock: close under the buyer's line. */
const PRICE_DROPS = 17_320_000;
/** The sell-back share of an NFT-only table, by hand: each band's chance times its average mark, at the sale rate, over the price. */
const shareOf = (marks: readonly (readonly number[])[]) => NFTS_ONLY.bandBps.reduce((acc, bps, band) => acc + (bps / 10_000) * (marks[band].length ? marks[band].reduce((x, y) => x + y, 0) / marks[band].length : 0), 0) * 0.9506 / PRICE_DROPS;
const WINDOWS = [[0.5, 2], [1.5, 4], [5, 13], [40, 60], [80, 100.01]] as const;

/** Other holders' listings: real ids of the collection, on nobody's ledger here. */
const FILLERS = [0, 1, 2].map((i) => nftIdFor(90_000 + i));
const BETA_FILLERS = [0, 1, 2].map((i) => nftIdFor(91_000 + i));
const GAMMA_FILLERS = [0, 1, 2].map((i) => nftIdFor(92_000 + i));

function market(floorXrp: number, listings: readonly { nftId: string; xrp: number }[] = [], slug = "alpha", fillers = FILLERS): MarketRead {
  const fill = [1, 1.05, 1.1].map((k, i) => ({ nftId: fillers[i], drops: Math.round(floorXrp * k * 1e6), holder: `rH${i}` }));
  return {
    slug,
    at: NOW,
    listings: [...listings.map((l) => ({ nftId: l.nftId, drops: Math.round(l.xrp * 1e6), holder: SELLER })), ...fill].sort((a, b) => a.drops - b.drops),
    sales: Array.from({ length: 12 }, (_, i) => ({ nftId: `${slug}:sold${i}`, drops: Math.round(floorXrp * 1e6), buyer: `rB${i}`, seller: `rS${i}`, at: NOW - i * 3_600_000 })),
  };
}

interface Opts {
  stock?: readonly number[];
  marks?: readonly number[];
  targets?: readonly number[];
  autobuy?: Partial<AutobuyLimits> | null;
  vaultXrp?: number;
  market?: boolean;
  salt?: string;
  allow?: readonly string[];
  priority?: readonly string[];
}

async function setup(opts: Opts = {}) {
  const ledger = testLedger(`rmn-${opts.salt ?? "a"}`);
  ledger.fund(TREASURY, 5000);
  ledger.fund(VAULT, opts.vaultXrp ?? 300);
  ledger.fund(PLAYER, 20_000);
  const store = memoryStore();
  const reads = new Map<string, MarketRead | null>();
  const reader = { calls: 0, fresh: [] as string[], cache: new Set<string>(), cached(slug: string) { return reader.cache.has(slug); }, async read(slug: string) { reader.calls++; if (!reader.cache.has(slug)) reader.fresh.push(slug); if (reads.get(slug)) reader.cache.add(slug); return reads.get(slug) ?? null; } };
  const slugs = new Map<string, string>([...FILLERS.map((id) => [id, "alpha"] as const), ...BETA_FILLERS.map((id) => [id, "beta"] as const), ...GAMMA_FILLERS.map((id) => [id, "gamma"] as const)]);
  const rules: RestockRules = {
    windowOf: (_p, band) => ({ minDrops: xrp(WINDOWS[band][0]), maxDrops: xrp(WINDOWS[band][1]) }),
    targetOf: (_p, band) => opts.targets?.[band] ?? 0,
    allowOf: () => opts.allow ?? ["alpha"],
    slugOf: (id) => slugs.get(id) ?? (/^([a-z]+):/.exec(id)?.[1] ?? null),
    prices: [5],
    stopBps: 500,
    priorityOf: (slug) => (opts.priority?.includes(slug) ? opts.priority.indexOf(slug) : undefined),
  };
  const limits: AutobuyLimits | null = opts.autobuy ? { dailyDrops: xrp(400), perNftDrops: xrp(200), keepDrops: xrp(2), lowVaultDrops: xrp(10), ...opts.autobuy } : null;
  let ids = 0;
  const make = (extra: Partial<EngineDeps> = {}) =>
    createEngine({ newId: () => `o-${++ids}-${opts.salt ?? "a"}`, store, chain: ledger.chain, signer: testSigner(), drawSecret: "rmn", expectedNetworkId: 1, now: () => new Date(NOW), multi: { max: 10, cardMax: 1 }, restock: { rules, market: opts.market === false ? undefined : reader, art: async (_u, id) => ({ img: `https://art.example/${id}.png`, name: null }), autobuy: limits }, ...extra });
  const engine = make();
  await engine.openSeason(5, String(PRICE_DROPS), null, NFTS_ONLY);
  const marks = opts.marks ?? [1, 3, 9, 50, 90];
  let n = 0;
  const adds = (opts.stock ?? [30, 30, 20, 10, 10]).flatMap((count, band) =>
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
type World = Awaited<ReturnType<typeof setup>>;

async function run(engine: RipEngine, ledger: World["ledger"], passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

async function sweeps(w: Pick<World, "engine" | "ledger">, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await w.engine.sweep();
    w.ledger.close();
  }
  await w.engine.sweep();
}

/** One payment for `qty` packs, drawn. */
async function bundle(w: World, qty: number): Promise<OrderState[]> {
  const q = await w.engine.createBundle(PLAYER, 5, qty);
  assert.ok(q.ok, JSON.stringify(q));
  w.ledger.userSubmit((q as unknown as { tx: never }).tx);
  await run(w.engine, w.ledger, 6);
  const kids = (q as { bundle: { children: readonly string[] } }).bundle.children.map((id) => w.engine.state.orders.get(id)!);
  for (const o of kids) assert.equal(o.status, "drawn");
  return kids;
}

async function bulkSell(w: World, ids: readonly string[]) {
  const quote = await w.engine.quotePayout(PLAYER, ids);
  assert.ok(quote.ok, JSON.stringify(quote));
  const done = await w.engine.requestPayout(PLAYER, (quote as unknown as { items: never }).items);
  assert.ok(done.ok, JSON.stringify(done));
  await run(w.engine, w.ledger, 4);
  for (const id of ids) assert.equal(w.engine.state.orders.get(id)!.pull, "sold");
}

const inPool = (engine: RipEngine, nftId: string) => [...engine.state.lots.values()].filter((l) => l.nftId === nftId && (l.status === "available" || l.status === "pending"));

// ---------- Round 1

test("a bulk sale goes back by the same rule as a single one: a player's own pass doesn't relist it unchecked before the no-sweep wait", async () => {
  const w = await setup();
  const kids = await bundle(w, 4);
  const nfts = kids.filter((o) => o.lot).map((o) => o.id);
  assert.ok(nfts.length >= 2);
  await bulkSell(w, nfts);
  // Players' passes only, well inside the wait: nothing may go back without the sweep's floor check.
  w.ledger.close(20);
  await run(w.engine, w.ledger, 3);
  for (const id of nfts) assert.equal(inPool(w.engine, w.engine.state.orders.get(id)!.nftId!).length, 0, "relisted by a player's pass, unchecked");
  assert.equal(w.reader.calls, 0);
  // Past the wait with no sweep at all, they come home the way a single sale's does.
  w.ledger.close(RELIST_NO_SWEEP_LEDGERS + 1);
  await run(w.engine, w.ledger, 4);
  for (const id of nfts) assert.equal(inPool(w.engine, w.engine.state.orders.get(id)!.nftId!).length, 1);
  assert.ok(replayLog(await w.store.readFrom(0)).ok);
});

test("buying leaves the vault the reserve every stashed NFT needs to be claimed: a bundle's stash can't be stranded by a buy", async () => {
  const w = await setup({ targets: [0, 0, 21, 0, 0], autobuy: {}, vaultXrp: 13 });
  const kids = await bundle(w, 10);
  const stashed = kids.filter((o) => o.lot && o.pull === "stashed").length;
  assert.ok(stashed >= 8, String(stashed));
  // 13 XRP in the vault is 12 free: a 9 XRP buy, its own 0.4 of room and the 2 kept back, but not the 0.2 each stashed NFT's claim offer would lock.
  const info = (await w.ledger.chain.account(VAULT))!;
  assert.equal(info.balance, String(xrp(13)));
  const id = nftIdFor(7000);
  w.ledger.listNft(id, SELLER, xrp(9));
  w.slugs.set(id, "alpha");
  w.reads.set("alpha", market(9, [{ nftId: id, xrp: 9 }]));
  await sweeps(w, 4);
  assert.equal(w.ledger.ownerOf(id), SELLER, "bought with the stash's claim reserve");
  assert.equal(w.engine.state.buys.size, 0);
  // With the reserves there too, it buys, and every stashed NFT can still be claimed after.
  w.ledger.fund(VAULT, 3);
  await sweeps(w, 4);
  assert.equal(w.ledger.ownerOf(id), VAULT);
  for (const o of kids.filter((k) => k.lot && w.engine.state.orders.get(k.id)!.pull === "stashed")) assert.deepEqual(await w.engine.claim(PLAYER, o.id), { ok: true });
  await run(w.engine, w.ledger, 30);
  const after = (await w.ledger.chain.account(VAULT))!;
  const r = await w.ledger.chain.reserves();
  assert.ok(BigInt(after.balance) >= BigInt(r.base) + BigInt(after.ownerCount) * BigInt(r.inc), "the vault went under its reserve");
  assert.ok(replayLog(await w.store.readFrom(0)).ok);
});

test("the sell-back gate counts what's already bought and on its way in: two buys can't take the pack past it between them", async () => {
  // Chase is short by two, and each 100 XRP Chase NFT raises the share. One alone keeps under the buyer's line. Two together don't.
  const w = await setup({ targets: [0, 0, 0, 0, 12], autobuy: {} });
  const base = [30, 30, 20, 10, 10].map((n, band) => Array.from({ length: n }, () => Number(xrp([1, 3, 9, 50, 90][band]))));
  const withOne = base.map((b, band) => (band === 4 ? [...b, Number(xrp(100))] : b));
  const withTwo = withOne.map((b, band) => (band === 4 ? [...b, Number(xrp(100))] : b));
  const season = w.engine.state.seasons.get(w.engine.state.activeSeason.get(5)!) as SeasonState;
  assert.ok(Math.abs(sellBackShare(w.engine.state, season, Number.MAX_SAFE_INTEGER) - shareOf(base)) < 1e-9);
  assert.ok(shareOf(withOne) <= BUY_MAX_SHARE && shareOf(withTwo) > BUY_MAX_SHARE, `${shareOf(withOne)} ${shareOf(withTwo)}`);
  const a = nftIdFor(7101);
  const b = nftIdFor(7102);
  w.ledger.listNft(a, SELLER, xrp(100));
  w.ledger.listNft(b, SELLER, xrp(100));
  w.slugs.set(a, "alpha");
  w.slugs.set(b, "alpha");
  w.reads.set("alpha", market(95, [{ nftId: a, xrp: 100 }, { nftId: b, xrp: 100 }]));
  await sweeps(w, 12);
  const s = w.engine.state;
  const lots = [...s.lots.values()].filter((l) => l.price === 5 && (l.status === "available" || l.status === "pending") && l.removeLedger === null);
  const now = [0, 1, 2, 3, 4].map((band) => lots.filter((l) => l.band === band).map((l) => Number(l.markDrops)));
  assert.ok([a, b].some((id) => w.ledger.ownerOf(id) === VAULT), "the first buy fits and goes through");
  assert.ok(shareOf(now) <= BUY_MAX_SHARE, `two buys took the pack to ${shareOf(now)}`);
});

// ---------- Round 2: everything at once

test("any mix of bundles, singles, bulk and single sales, claims, listings, fills, kill switches, follow-ups and two servers: budget, caps, reserves, the pool and the replay all hold", async () => {
  const CAFE = "rpx9JThQ2y37FaGeeJP7PXDUVEXY3PHZSC";
  const op = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 2, max: 6 }).map((qty) => ({ k: "bundle" as const, qty })) },
    { weight: 2, arbitrary: fc.constant({ k: "single" as const }) },
    { weight: 3, arbitrary: fc.nat(40).map((n) => ({ k: "bulk" as const, n })) },
    { weight: 2, arbitrary: fc.nat(40).map((n) => ({ k: "sell" as const, n })) },
    { weight: 2, arbitrary: fc.nat(40).map((n) => ({ k: "claim" as const, n })) },
    { weight: 1, arbitrary: fc.nat(40).map((n) => ({ k: "accept" as const, n })) },
    { weight: 2, arbitrary: fc.record({ n: fc.nat(5), price: fc.constantFrom(8, 9, 12, 55, 95), broker: fc.boolean() }).map((x) => ({ k: "list" as const, ...x })) },
    { weight: 2, arbitrary: fc.constant({ k: "fill" as const }) },
    { weight: 1, arbitrary: fc.boolean().map((on) => ({ k: "switch" as const, on })) },
    { weight: 5, arbitrary: fc.boolean().map((other) => ({ k: "sweep" as const, other })) },
    { weight: 3, arbitrary: fc.boolean().map((other) => ({ k: "follow" as const, other })) },
    { weight: 3, arbitrary: fc.constantFrom(1, 3, 30, 500).map((n) => ({ k: "close" as const, n })) },
  );
  const DAILY = xrp(30);
  const EACH = xrp(13);
  await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 10, maxLength: 50 }), fc.nat(1000), async (ops, salt) => {
    const w = await setup({ stock: [30, 30, 20, 10, 10], targets: [0, 0, 24, 12, 0], autobuy: { dailyDrops: DAILY, perNftDrops: EACH }, vaultXrp: 60, salt: `p${salt}` });
    const other = w.make();
    const vaultStart = w.ledger.balance(VAULT);
    const ids = Array.from({ length: 6 }, (_, i) => nftIdFor(60_000 + i));
    const listed: { nftId: string; xrp: number }[] = [];
    const refresh = () => w.reads.set("alpha", market(9, listed));
    refresh();
    const mine = () => [...w.engine.state.orders.values()].filter((o) => o.lot && o.pull === "stashed");
    for (const step of ops) {
      if (step.k === "bundle") {
        const q = await w.engine.createBundle(PLAYER, 5, step.qty);
        if (q.ok) w.ledger.userSubmit((q as unknown as { tx: never }).tx);
      } else if (step.k === "single") {
        const q = await w.engine.createOrder(PLAYER, 5);
        if (q.ok) w.ledger.userSubmit(q.tx as never);
      } else if (step.k === "bulk") {
        const all = mine();
        const pick = all.filter((_, i) => (step.n >> (i % 5)) & 1).slice(0, 10).map((o) => o.id);
        if (pick.length < 2) continue;
        const quote = await w.engine.quotePayout(PLAYER, pick);
        if (quote.ok) await w.engine.requestPayout(PLAYER, (quote as unknown as { items: never }).items);
      } else if (step.k === "sell" || step.k === "claim" || step.k === "accept") {
        const all = [...w.engine.state.orders.values()].filter((o) => o.lot);
        const o = all.length ? all[step.n % all.length] : null;
        if (!o) continue;
        if (step.k === "sell") {
          const p = w.engine.sellPrice(PLAYER, o.id);
          if (p.ok) await w.engine.sell(PLAYER, o.id, p.drops);
        } else if (step.k === "claim") await w.engine.claim(PLAYER, o.id);
        else if (o.pull === "offered" && o.offerId) w.ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: o.offerId });
      } else if (step.k === "list") {
        const id = ids[step.n];
        if (listed.some((l) => l.nftId === id) || w.ledger.ownerOf(id) === VAULT) continue;
        w.ledger.listNft(id, SELLER, xrp(step.price), step.broker ? { destination: CAFE } : {});
        w.slugs.set(id, "alpha");
        listed.push({ nftId: id, xrp: step.price });
        refresh();
      } else if (step.k === "fill") {
        for (const [id, offer] of w.ledger.offers) if (offer.isBuy && offer.owner === VAULT && [...w.ledger.offers.values()].some((o) => o.nftId === offer.nftId && !o.isBuy && o.amount && w.ledger.ownerOf(o.nftId) === o.owner)) w.ledger.brokerFill(id);
      } else if (step.k === "switch") await w.engine.setAutobuy(step.on, "owner");
      else if (step.k === "sweep") await (step.other ? other : w.engine).sweep();
      else if (step.k === "follow") await (step.other ? other : w.engine).followUp();
      else w.ledger.close(step.n);
      await w.engine.advance();
    }
    for (let i = 0; i < 14; i++) {
      w.ledger.close(i % 3 === 0 ? 40 : 1);
      await w.engine.sweep();
    }
    await w.engine.sync();
    const s = w.engine.state;
    const log = await w.store.readFrom(0);
    const replay = replayLog(log);
    assert.ok(replay.ok, JSON.stringify(replay));
    if (process.env.FUZZ_STATS) console.log("STATS", JSON.stringify({ bundles: s.bundles.size, paid: [...s.bundles.values()].filter((b) => b.status !== "quoted" && b.status !== "expired").length, payouts: s.payouts.size, buys: [...s.buys.values()].map((b) => b.status), relists: log.filter((e) => e.type === "pool_change" && e.data.id.startsWith("relist-")).length, sold: [...s.orders.values()].filter((o) => o.pull === "sold").length }));
    // Spend: never past the day's budget in XRP that really left the vault, never past the cap on one NFT, never more than one buy open.
    assert.ok(vaultStart - w.ledger.balance(VAULT) <= DAILY + 200_000n, `the vault spent ${vaultStart - w.ledger.balance(VAULT)}`);
    for (const b of s.buys.values()) assert.ok(BigInt(b.offeredDrops) <= EACH, b.id);
    assert.ok([...s.buys.values()].filter((b) => b.status !== "ended" && b.status !== "registered").length <= 1);
    // Off means off: no buy is signed while the switch is off.
    let off = false;
    for (const e of log) {
      if (e.type === "restock_switch") off = !e.data.on;
      if (e.type === "tx_intent" && e.data.kind === "vault_buy") assert.ok(!off, `buy signed while switched off at ${e.seq}`);
    }
    // The vault never goes under its reserve, with room for every stashed NFT's claim.
    const v = (await w.ledger.chain.account(VAULT))!;
    assert.ok(BigInt(v.balance) >= 1_000_000n + BigInt(v.ownerCount) * 200_000n);
    // One live lot per NFT, in the vault, and none a player holds.
    const live = [...s.lots.values()].filter((l) => l.status === "pending" || (l.status === "available" && l.removeLedger === null));
    assert.equal(new Set(live.map((l) => l.nftId)).size, live.length);
    for (const l of live) assert.equal(w.ledger.ownerOf(l.nftId), VAULT, l.nftId);
    const held = new Set([...s.orders.values()].filter((o) => o.nftId && o.pull !== "sold").map((o) => o.nftId));
    for (const l of live) assert.ok(!held.has(l.nftId), l.nftId);
    // Every bought NFT the vault holds is in a pool or on its way, exactly once: a crash or a race can't lose one or count it twice.
    for (const b of s.buys.values()) if (w.ledger.ownerOf(b.nftId) === VAULT && !held.has(b.nftId)) assert.equal(live.filter((l) => l.nftId === b.nftId).length + [...s.restockHolds.values()].filter((h) => h.nftId === b.nftId).length + [...s.lots.values()].filter((l) => l.nftId === b.nftId && l.status === "returned").length, 1, b.nftId);
  }), { numRuns: Number(process.env.FUZZ_RUNS ?? 25) });
});

// ---------- Priority and narrowing

import { autobuyConfig, slugOrder, AUTOBUY_CONFIRMATION, configRules } from "../src/lib/rip/restock.ts";
import { PRIORITY_COLLECTIONS, BUY_ALLOW, COLLECTION_PINS } from "../src/config/restock.ts";

test("collection order: the priority list first in its order, the rest taking turns, and never a collection added or lost", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f", "g"), { maxLength: 7 }), fc.uniqueArray(fc.constantFrom("a", "b", "c", "x"), { maxLength: 4 }), fc.integer({ min: -50, max: 50 }), (slugs, priority, turn) => {
    const rank = (s: string) => (priority.includes(s) ? priority.indexOf(s) : undefined);
    const out = slugOrder(slugs, turn, rank);
    assert.deepEqual([...out].sort(), [...slugs].sort());
    const firsts = out.filter((s) => rank(s) !== undefined);
    assert.deepEqual(out.slice(0, firsts.length), firsts);
    assert.deepEqual(firsts, [...firsts].sort((a, b) => rank(a)! - rank(b)!));
    const rest = slugs.filter((s) => rank(s) === undefined);
    const tail = out.slice(firsts.length);
    // A rotation of the rest.
    if (rest.length) assert.ok(rest.some((_, k) => JSON.stringify([...rest.slice(k), ...rest.slice(0, k)]) === JSON.stringify(tail)));
  }));
});

test("a priority collection is bought first when it passes the same checks, even over a cheaper listing elsewhere in the band", async () => {
  const w = await setup({ stock: [30, 30, 19, 10, 10], targets: [0, 0, 20, 0, 0], autobuy: {}, allow: ["alpha", "beta"], priority: ["beta"] });
  const cheap = nftIdFor(7201);
  const pick = nftIdFor(7202);
  w.ledger.listNft(cheap, SELLER, xrp(8));
  w.ledger.listNft(pick, SELLER, xrp(10));
  w.slugs.set(cheap, "alpha");
  w.slugs.set(pick, "beta");
  w.reads.set("alpha", market(8, [{ nftId: cheap, xrp: 8 }]));
  w.reads.set("beta", market(10, [{ nftId: pick, xrp: 10 }], "beta", BETA_FILLERS));
  await sweeps(w, 4);
  assert.equal(w.ledger.ownerOf(pick), VAULT);
  assert.equal(w.ledger.ownerOf(cheap), SELLER);
});

test("being on the priority list skips no check: a thin or over-cap priority collection is passed over and the band still fills from the rest", async () => {
  for (const bad of ["thin", "over"] as const) {
    const w = await setup({ stock: [30, 30, 19, 10, 10], targets: [0, 0, 20, 0, 0], autobuy: { perNftDrops: xrp(11) }, allow: ["alpha", "beta"], priority: ["beta"], salt: bad });
    const other = nftIdFor(7301);
    const pick = nftIdFor(7302);
    w.ledger.listNft(other, SELLER, xrp(9));
    w.ledger.listNft(pick, SELLER, xrp(bad === "over" ? 12 : 9));
    w.slugs.set(other, "alpha");
    w.slugs.set(pick, "beta");
    w.reads.set("alpha", market(9, [{ nftId: other, xrp: 9 }]));
    const beta = market(bad === "over" ? 12 : 9, [{ nftId: pick, xrp: bad === "over" ? 12 : 9 }], "beta", BETA_FILLERS);
    w.reads.set("beta", bad === "thin" ? { ...beta, sales: beta.sales.slice(0, 3) } : beta);
    await sweeps(w, 6);
    assert.equal(w.ledger.ownerOf(pick), SELLER, bad);
    assert.equal(w.ledger.ownerOf(other), VAULT, bad);
  }
});

test("a priority collection already read doesn't use up the sweep's indexer reads: the rest still get their turn", async () => {
  const w = await setup({ stock: [30, 30, 19, 10, 10], targets: [0, 0, 20, 0, 0], autobuy: {}, allow: ["alpha", "beta", "gamma"], priority: ["beta"] });
  const want = nftIdFor(7401);
  w.ledger.listNft(want, SELLER, xrp(9));
  w.slugs.set(want, "gamma");
  // Beta reads fine and has nothing to sell; alpha can't be read; gamma has the listing.
  w.reads.set("beta", market(9, [], "beta", BETA_FILLERS));
  w.reads.set("gamma", market(9, [{ nftId: want, xrp: 9 }], "gamma", GAMMA_FILLERS));
  await sweeps(w, 6);
  assert.equal(w.ledger.ownerOf(want), VAULT);
  // Beta went to the indexer once; every later look came from what was held.
  assert.equal(w.reader.fresh.filter((x) => x === "beta").length, 1);
});

test("the pack and collection lists only narrow: unset means the config's lists, a bad entry turns buying off, and the buyer keeps to them", async () => {
  const on = { SEAL_AUTOBUY: "on", SEAL_AUTOBUY_CONFIRM: AUTOBUY_CONFIRMATION, SEAL_AUTOBUY_DAILY_XRP: "100", SEAL_AUTOBUY_MAX_NFT_XRP: "60" };
  const base = autobuyConfig(on, "mainnet")!;
  assert.equal(base.prices, null);
  assert.equal(base.collections, null);
  assert.deepEqual(autobuyConfig({ ...on, SEAL_AUTOBUY_PRICES: "5" }, "mainnet")!.prices, [5]);
  assert.deepEqual([...autobuyConfig({ ...on, SEAL_AUTOBUY_COLLECTIONS: "bearchampdaf, luckypunch" }, "mainnet")!.collections!], ["bearchampdaf", "luckypunch"]);
  for (const bad of [{ SEAL_AUTOBUY_PRICES: "5,7" }, { SEAL_AUTOBUY_PRICES: " , " }, { SEAL_AUTOBUY_PRICES: "25" }, { SEAL_AUTOBUY_COLLECTIONS: "bearchampdaf,bear-champ-lookalike" }, { SEAL_AUTOBUY_COLLECTIONS: "bear-champ-custom-pfps" }]) assert.equal(autobuyConfig({ ...on, ...bad }, "mainnet"), null, JSON.stringify(bad));
  // In the engine: a pack or a collection left off isn't bought for, however short.
  for (const narrow of [{ prices: [10 as const] }, { collections: new Set(["beta"]) }]) {
    const w = await setup({ stock: [30, 30, 19, 10, 10], targets: [0, 0, 20, 0, 0], autobuy: narrow, salt: JSON.stringify(narrow.prices ?? "c") });
    const id = nftIdFor(7501);
    w.ledger.listNft(id, SELLER, xrp(9));
    w.slugs.set(id, "alpha");
    w.reads.set("alpha", market(9, [{ nftId: id, xrp: 9 }]));
    await sweeps(w, 4);
    assert.equal(w.ledger.ownerOf(id), SELLER);
    assert.equal(w.engine.state.buys.size, 0);
  }
});

test("the real priority list: every one pinned to the Bear Champ's issuer, in the owner's order, and only ones a band lists can be bought", () => {
  const rules = configRules();
  assert.deepEqual(PRIORITY_COLLECTIONS.slice(0, 3), ["bearchampdaf", "bearchamp", "bearchampgf"]);
  for (const [i, slug] of PRIORITY_COLLECTIONS.entries()) {
    assert.equal(COLLECTION_PINS[slug]?.issuer, "r4qHM7vWeLTtWPVoEzDjT6AskpQjSmui7B", slug);
    assert.equal(rules.priorityOf!(slug), i);
  }
  assert.equal(new Set(PRIORITY_COLLECTIONS.map((s) => COLLECTION_PINS[s].taxon)).size, PRIORITY_COLLECTIONS.length);
  assert.ok(BUY_ALLOW[5]![4].includes("bearchampdaf"));
  assert.ok(BUY_ALLOW[10]![2].includes("luckypunch"));
  assert.equal(rules.priorityOf!("xpunks"), undefined);
});

// ---------- Round 3: how fast what's sold back is back

import { settling } from "../src/lib/rip/restock.ts";

async function soldBack(w: World) {
  const kids = await bundle(w, 3);
  const o = kids.find((k) => k.lot)!;
  const p = w.engine.sellPrice(PLAYER, o.id);
  assert.ok(p.ok);
  assert.deepEqual(await w.engine.sell(PLAYER, o.id, p.drops), { ok: true });
  // The sale goes out and settles: two ledgers and two passes.
  await run(w.engine, w.ledger, 2);
  assert.equal(w.engine.state.orders.get(o.id)!.pull, "sold");
  return o.nftId!;
}

test("with no market check set up, a sold-back NFT is back on the next pass, as it was before the restocker", async () => {
  const w = await setup({ market: false, salt: "fast-off" });
  const nft = await soldBack(w);
  await run(w.engine, w.ledger, 2);
  assert.equal(inPool(w.engine, nft).filter((l) => l.status === "available").length, 1);
});

test("with the floor check on, the first sweep after a sale settles puts it back: no batch window on top of the cron's minute", async () => {
  const w = await setup({ salt: "fast-on" });
  w.reads.set("alpha", market(9));
  const nft = await soldBack(w);
  await w.engine.sweep();
  w.ledger.close();
  await w.engine.sweep();
  assert.equal(inPool(w.engine, nft).filter((l) => l.status === "available").length, 1);
  assert.ok(w.reader.calls >= 1, "and it was checked against the floor");
});

test("a follow-up pass, run seconds after a sale off the player's request, puts it back with the floor check and says when nothing's left to settle", async () => {
  const w = await setup({ salt: "follow" });
  w.reads.set("alpha", market(9));
  const nft = await soldBack(w);
  assert.equal(settling(w.engine.state), true);
  let passes = 0;
  while (settling(w.engine.state) && passes < 6) {
    w.ledger.close();
    await w.engine.followUp();
    passes += 1;
  }
  assert.equal(inPool(w.engine, nft).filter((l) => l.status === "available").length, 1);
  assert.ok(passes <= 3, String(passes));
  assert.equal(settling(w.engine.state), false);
  // It never buys: a follow-up only finishes what's already under way.
  assert.equal(w.engine.state.buys.size, 0);
  assert.ok(replayLog(await w.store.readFrom(0)).ok);
});

test("a listing the ledger turned down isn't read on the ledger again every minute: one look per listing per half hour, however many sweeps", async () => {
  const w = await setup({ stock: [30, 30, 19, 10, 10], targets: [0, 0, 20, 0, 0], autobuy: {}, salt: "stale" });
  const ledgerReads = new Map<string, number>();
  const seen = (id: string) => ledgerReads.set(id, (ledgerReads.get(id) ?? 0) + 1);
  const counted = w.make({ chain: { ...w.ledger.chain, nftInfo: async (id: string) => (seen(id), w.ledger.chain.nftInfo!(id)), nftSellOffers: async (id: string) => (seen(id), w.ledger.chain.nftSellOffers!(id)) } });
  // The indexer still lists it, but the seller moved it away: the offer on the ledger is an old owner's and can't fill.
  const id = nftIdFor(7601);
  w.ledger.listNft(id, SELLER, xrp(9));
  w.ledger.moveNft(id, "rELSEWHEREelsewhereELSEWHEREels");
  w.slugs.set(id, "alpha");
  w.reads.set("alpha", market(9, [{ nftId: id, xrp: 9 }]));
  await sweeps({ engine: counted, ledger: w.ledger }, 20);
  assert.equal(counted.state.buys.size, 0);
  // Each listing the indexer names, the stale one and the other holders' that have no live offer here, is read once: two calls.
  assert.ok(ledgerReads.size >= 1);
  for (const [nft, n] of ledgerReads) assert.ok(n <= 2, `${n} ledger reads for ${nft}`);
});

test("the owner's never-buy list wins over every other list: no XRP Frens Club, even where a band or the narrowing env names it", async () => {
  const { NEVER_BUY } = await import("../src/config/restock.ts");
  assert.ok(NEVER_BUY.includes("xrpfrensclub"));
  for (const bands of Object.values(BUY_ALLOW)) for (const list of bands ?? []) assert.ok(!list.includes("xrpfrensclub"));
  for (const price of [5, 10] as const) for (const band of [0, 1, 2, 3, 4]) assert.ok(!configRules().allowOf(price, band).includes("xrpfrensclub"));
  const on = { SEAL_AUTOBUY: "on", SEAL_AUTOBUY_CONFIRM: AUTOBUY_CONFIRMATION, SEAL_AUTOBUY_DAILY_XRP: "100", SEAL_AUTOBUY_MAX_NFT_XRP: "60" };
  assert.equal(autobuyConfig({ ...on, SEAL_AUTOBUY_COLLECTIONS: "xrpfrensclub" }, "mainnet"), null);
  // Rules that do list it, as a stale config would: the engine still won't buy one.
  const w = await setup({ stock: [30, 30, 19, 10, 10], targets: [0, 0, 20, 0, 0], autobuy: {}, allow: ["xrpfrensclub"], salt: "fren" });
  const id = nftIdFor(7701);
  w.ledger.listNft(id, SELLER, xrp(9));
  w.slugs.set(id, "xrpfrensclub");
  for (const f of FILLERS) w.slugs.set(f, "xrpfrensclub");
  w.reads.set("xrpfrensclub", market(9, [{ nftId: id, xrp: 9 }], "xrpfrensclub"));
  await sweeps(w, 4);
  assert.equal(w.ledger.ownerOf(id), SELLER);
  assert.equal(w.engine.state.buys.size, 0);
});
