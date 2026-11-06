import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NFT_LADDERS, SEASON_5_4, type NftPrice } from "../src/config/nft-packs.ts";
import { MAX_SELL_BACK_SHARE, createEngine, sellBackShare } from "../src/lib/rip/engine.ts";
import { xrpCoverFor } from "../src/lib/rip/draw.ts";
import { nftAward } from "../src/lib/live/client.ts";
import { livePack, nftPack } from "../src/lib/nft/view.ts";
import { demoNftAward } from "../src/lib/rails/demo.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { sealTokenSpec, seasonPlan } from "../src/lib/rip/tokens.ts";
import type { Lot, RipEvent } from "../src/lib/rip/types.ts";
import { publicEvents, replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { poolView, publicOrder, tierView } from "../src/lib/rip/views.ts";
import { XRP_PRIZE_ART } from "../src/lib/prize-art.ts";
import { TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

/**
 * The owner's path to XRP dust, run on the simulated ledger with the mainnet network id and the 12 NFTs really in the pools,
 * in the bands and with the marks the public log gives them: seasons 5-1 and 10-1 opened with no tokens, then 5-2 and 10-2 with SEAL off.
 */
const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const LOG = JSON.parse(readFileSync(new URL("./fixtures/mainnet-log-20261102.json", import.meta.url), "utf8")) as { events: RipEvent[] };
const ROWS = LOG.events.flatMap((e) => (e.type === "pool_change" ? e.data.adds : []));
const ROUND_TRIPPRX = ROWS.find((l) => l.band === 0 && l.price === 5) as Lot;
/** The dust season as mainnet opened it, on the $5 rates of the day. A later season's rates don't rewrite this history. */
const XRP_ONLY = (price: NftPrice) => {
  // The XRP rows as they stood then: 5-5 moved the $5 ladder on since.
  const plan = seasonPlan(price === 5 ? { ...NFT_LADDERS[5], tokenPrizes: SEASON_5_4.tokenPrizes, emptyBand: undefined } : NFT_LADDERS[price], sealTokenSpec({ SEAL_TOKEN_PRIZES: "off" }));
  return price === 5 ? { ...plan, bandBps: [7396, 2000, 250, 314, 40] } : plan;
};
const NO_TOKENS = (price: NftPrice) => ({ ...seasonPlan(NFT_LADDERS[price], null), ...(price === 5 ? { bandBps: [...SEASON_5_4.bandBps] } : {}), prizeTable: [], tokens: [], emptyBand: undefined });

async function live(treasuryXrp: number) {
  const ledger = testLedger("dust", 0);
  ledger.fund(TREASURY, treasuryXrp);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 5000);
  ledger.fund(OTHER, 5000);
  const store = memoryStore();
  // Fixed ids, so every run draws the same pulls. A random id made about one run in twenty land on a pull that left a band short.
  let ids = 0;
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "dust-secret", expectedNetworkId: 0, shelf: [5, 10], newId: () => `dust-${++ids}` });
  const run = async (passes = 6) => {
    for (let i = 0; i < passes; i++) {
      await engine.advance();
      ledger.close();
      await engine.advance();
    }
  };
  const open = (price: NftPrice, plan: ReturnType<typeof XRP_ONLY>) => engine.openSeason(price, String(NFT_LADDERS[price].xrp * 1e6), null, plan);
  await open(5, NO_TOKENS(5));
  await open(10, NO_TOKENS(10));
  await run(2);
  for (const price of [5, 10] as const) {
    const rows = ROWS.filter((l) => l.price === price);
    for (const l of rows) ledger.mintTo(l.nftId, VAULT);
    assert.equal((await engine.changePool(price, rows.map(({ lot: _l, price: _p, ...r }) => ({ ...r, costDrops: r.markDrops })))).ok, true);
    await run(2);
  }
  return { ledger, store, engine, run, open };
}

const closedNow = async (engine: Awaited<ReturnType<typeof live>>["engine"], ledger: Awaited<ReturnType<typeof live>>["ledger"]) => engine.closedPacks(await ledger.chain.validatedLedger(), async () => null);

test("the XRP each pack needs free, at the odds the engine works to: 42 for one place, 84 for two, plus the 10 XRP floor", () => {
  for (const price of [5, 10] as const) {
    const { prizeTable, bandBps } = XRP_ONLY(price);
    assert.equal(prizeTable.every((r) => r.token === "XRP"), true);
    assert.equal(xrpCoverFor(prizeTable, bandBps, 1), 42_000_000n);
    assert.equal(xrpCoverFor(prizeTable, bandBps, 2), 84_000_000n);
  }
});

test("SEAL off commits the ladder's rows at full value in XRP; dust is every Common pull, at 1, 2 and 4 XRP on $5 and 2, 4 and 8 on $10", () => {
  assert.equal(XRP_ONLY(5).tokens.length, 0);
  const dust = (price: NftPrice) => XRP_ONLY(price).prizeTable.filter((r) => r.band === 0).map((r) => [r.bps, Number(r.valueDrops) / 1e6]);
  assert.deepEqual(dust(5), [[6000, 1], [3300, 2], [700, 4]]);
  assert.deepEqual(dust(10), [[6000, 2], [3300, 4], [700, 8]]);
});

test("the whole path: a live season gives way to a dust season, nothing already sold moves, the reveal says X XRP, redeem pays it, and /fair replays", async () => {
  const { ledger, store, engine, run, open } = await live(15);
  // Before anything: $5 sells, on the no-token season. The public log says 0 pulls so far, and $10 has no Epic or Chase NFT, so it doesn't.
  assert.deepEqual([...(await closedNow(engine, ledger))], [10]);

  // Someone holds a quote on 5-1, so 5-2 can't open under it.
  const early = await engine.createOrder(OTHER, 5);
  assert.ok(early.ok, JSON.stringify(early));
  assert.equal(early.order.season, "5-1");
  assert.equal(await open(5, XRP_ONLY(5)), null, "a season can't switch under an open order");

  // The quote pays out on the terms it was sold under: no token rows. Then the switch goes through.
  ledger.userSubmit(early.tx as never);
  await run(6);
  const old = engine.state.orders.get(early.order.id)!;
  assert.equal(old.season, "5-1");
  assert.equal(old.status, "drawn");
  assert.equal(old.prize, null, "5-1 pays an NFT, whatever band it hits");
  assert.ok(old.lot, "an NFT");
  assert.equal(await open(5, XRP_ONLY(5)), "5-2");
  await run(2);
  assert.equal(engine.state.activeSeason.get(5), "5-2");
  assert.equal(engine.state.seasons.get("5-1")?.live, true, "the old season stays on the record");

  // With 15 XRP in the treasury a token season can't promise a place: closed, nothing charged, and it says so honestly.
  const start = (await ledger.chain.account(TREASURY))!.balance;
  assert.ok(BigInt(start) < 52_000_000n);
  assert.equal((await closedNow(engine, ledger)).has(5), true);
  const refused = await engine.createOrder(PLAYER, 5);
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "restocking");
  const short = tierView(engine.state, 5, await ledger.chain.validatedLedger(), await closedNow(engine, ledger));
  assert.equal(short.open, false);

  // Funded to the 52: it opens, for one place at a time.
  ledger.fund(TREASURY, 60);
  ledger.close();
  await engine.advance();
  assert.equal((await closedNow(engine, ledger)).has(5), false);
  const held = await engine.createOrder(PLAYER, 5);
  assert.ok(held.ok, JSON.stringify(held));
  assert.equal(held.order.season, "5-2");
  const second = await engine.createOrder(OTHER, 5);
  assert.equal(second.ok, false, "a second place at once needs more XRP and more stock");
  ledger.userSubmit(held.tx as never);
  await run(6);

  // Pull until Common lands: every one of them pays dust, and a Common pull never reaches the NFT left in its band.
  let dust = engine.state.orders.get(held.order.id)!;
  for (let i = 0; i < 40 && !(dust.prize && dust.band === 0); i++) {
    ledger.fund(TREASURY, 50);
    const q = await engine.createOrder(PLAYER, 5);
    assert.ok(q.ok, JSON.stringify(q));
    ledger.userSubmit(q.tx as never);
    await run(6);
    dust = engine.state.orders.get(q.order.id)!;
  }
  assert.equal(dust.band, 0);
  assert.ok(dust.prize);
  assert.equal(dust.prize.token, "XRP");
  assert.ok(["1000000", "2000000", "4000000"].includes(dust.prize.amount), dust.prize.amount);
  const roundTripprxLot = engine.state.lots.get(engine.state.nftLot.get(ROUND_TRIPPRX.nftId) as string);
  if (old.lot !== roundTripprxLot?.lot) assert.equal(roundTripprxLot?.status, "available", "still in its band, and nothing in 5-2 can reach it");

  // The reveal.
  const view = publicOrder(engine.state, dust);
  assert.match(view.prize?.name ?? "", /^[124] XRP$/);
  assert.equal(view.sellXrp, null, "XRP has nothing to sell for");
  assert.equal(view.nft, null);
  const award = nftAward(view, 1.25);
  assert.match(award?.name ?? "", /^[124] XRP$/);
  assert.equal(award?.img, XRP_PRIZE_ART);

  // Its options: no sale, no claim, one redeem to the wallet that pulled it, paid once.
  assert.equal(((await engine.quoteSell(PLAYER, dust.id)) as { code: string }).code, "no_sale");
  assert.equal(((await engine.sell(PLAYER, dust.id, dust.prize.amount)) as { ok: boolean }).ok, false);
  assert.equal(((await engine.claim(PLAYER, dust.id)) as { ok: boolean }).ok, false);
  const before = BigInt((await ledger.chain.account(PLAYER))!.balance);
  assert.equal(((await engine.redeem(PLAYER, dust.id)) as { ok: boolean }).ok, true);
  await run(4);
  assert.equal(engine.state.orders.get(dust.id)?.pull, "redeemed");
  assert.equal(BigInt((await ledger.chain.account(PLAYER))!.balance) - before, BigInt(dust.prize.amount));
  await engine.redeem(PLAYER, dust.id);
  await run(2);
  assert.equal(BigInt((await ledger.chain.account(PLAYER))!.balance) - before, BigInt(dust.prize.amount));

  // /fair: the public record of both seasons, with one past the switch, replays and matches the ledger.
  const events = publicEvents(await store.readFrom(0));
  const replay = replayLog(events);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  const chain = await verifyAgainstChain(events, ledger.chain, TREASURY, 1);
  assert.equal(chain.ok, true, JSON.stringify(chain));
});

test("the prize view shows the season's real rows and pool: dust as amounts with odds, nothing unreachable, a pulled NFT gone, an empty band said plainly", async () => {
  const { ledger, engine, run, open } = await live(200);
  // 5-1, as it is now: the ledger's rates with no token rows, whatever the ladder plans.
  const before = poolView(engine.state, 5)!;
  assert.equal(before.season, "5-1");
  assert.deepEqual(before.bands.map((b) => b.pct), NO_TOKENS(5).bandBps.map((b) => b / 100));
  assert.equal(before.bands.every((b) => b.prizes.length === 0), true);
  assert.equal(before.bands[0].nfts.length, 1);

  await open(5, XRP_ONLY(5));
  await open(10, XRP_ONLY(10));
  await run(2);
  const pool = poolView(engine.state, 5)!;
  assert.equal(pool.season, "5-2");
  assert.deepEqual(pool.bands.map((b) => b.pct), [73.96, 20, 2.5, 3.14, 0.4]);
  const common = pool.bands[0];
  assert.deepEqual(common.prizes.map((p) => [p.xrp, p.tokens, Number(p.pct.toFixed(3))]), [[1, ["XRP"], 44.376], [2, ["XRP"], 24.407], [4, ["XRP"], 5.177]]);
  assert.equal(common.nftPct, 0);
  // Round Tripprx is still in Common's pool on the ledger, but no pull can reach it, so it isn't offered or counted.
  assert.deepEqual(common.nfts, []);
  const tier = tierView(engine.state, 5, await ledger.chain.validatedLedger());
  assert.equal(tier.nfts, 8);
  assert.deepEqual(tier.prizeTokens, ["XRP"]);
  assert.deepEqual(tier.bandBps, XRP_ONLY(5).bandBps);
  // Higher bands: the rows the ladder has, with the rest of the band on its NFTs.
  assert.deepEqual(pool.bands[3].prizes.map((p) => [p.xrp, Number(p.pct.toFixed(2))]), [[42, 1.57]]);
  assert.equal(Number(pool.bands[3].nftPct.toFixed(2)), 1.57);
  assert.equal(pool.bands[4].prizes.length, 0);
  // Odds on a pull add to 100%: nothing's hidden.
  assert.equal(Number(pool.bands.reduce((a, b) => a + b.nftPct + b.prizes.reduce((x, p) => x + p.pct, 0), 0).toFixed(6)), 100);
  assert.doesNotMatch(JSON.stringify(pool), /rtp|edge|costDrops|expected/i);

  // $10 can't open on dust alone: Epic and Chase hold no NFTs, and those bands aren't all tokens.
  const ten = poolView(engine.state, 10)!;
  assert.deepEqual(ten.bands.map((b) => b.nfts.length), [0, 1, 2, 0, 0]);
  assert.equal(ten.bands[3].nftPct > 0 && ten.bands[4].nftPct > 0, true);
  assert.equal((await closedNow(engine, ledger)).has(10), true);

  // A pulled NFT leaves the list by the next read. Keep pulling until one is drawn.
  const listed = () => poolView(engine.state, 5)!.bands.flatMap((b) => b.nfts.map((n) => n.id));
  const first = listed();
  let drawn: string | null = null;
  for (let i = 0; i < 60 && !drawn; i++) {
    ledger.fund(TREASURY, 50);
    const q = await engine.createOrder(PLAYER, 5);
    if (!q.ok) break;
    ledger.userSubmit(q.tx as never);
    await run(6);
    const o = engine.state.orders.get(q.order.id)!;
    drawn = o.lot ? (engine.state.lots.get(o.lot)?.nftId ?? null) : null;
  }
  assert.ok(drawn, "some pull lands on an NFT");
  assert.equal(first.includes(drawn), true);
  assert.equal(listed().includes(drawn), false);
});

test("a dust season stays under the sell-back limit with the real marks in the pools, so it doesn't close itself", async () => {
  const { ledger, engine, run, open } = await live(200);
  await open(5, XRP_ONLY(5));
  await run(2);
  const season = engine.state.seasons.get("5-2")!;
  const share = sellBackShare(engine.state, season, await ledger.chain.validatedLedger());
  assert.ok(share < MAX_SELL_BACK_SHARE, String(share));
  assert.equal((await closedNow(engine, ledger)).has(5), false);
});

test("the free demo with rails on shows only what's in the live pool, and never a SEAL prize on an XRP-only season", async () => {
  const { engine, run, open } = await live(200);
  await open(5, XRP_ONLY(5));
  await run(2);
  const pool = poolView(engine.state, 5);
  const pack = livePack(nftPack(5, {}), pool);
  const inPool = new Set(pool!.bands.flatMap((b) => b.nfts.map((n) => n.img)));
  assert.equal(pack.fiftyUpPct, 0);
  assert.deepEqual(pack.chase, []);
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400; i++) {
    const award = demoNftAward(pack, 1.25, rng);
    assert.ok(award);
    assert.doesNotMatch(award.name, /\bSEAL\b/);
    if (!/XRP$/.test(award.name)) assert.ok(inPool.has(award.img), award.name);
  }
  // No season at all: nothing to show, and it says so instead of showing the plan.
  assert.deepEqual(livePack(nftPack(5, {}), null).tiers.map((t) => t.collection), [null, null, null, null, null]);
});
