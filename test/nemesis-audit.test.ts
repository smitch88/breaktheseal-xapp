import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, SHELF_PRICES, type NftPrice } from "../src/config/nft-packs.ts";
import * as draw from "../src/lib/rip/draw.ts";
import { createEngine, type RipEngine } from "../src/lib/rip/engine.ts";
import * as live from "../src/lib/live/client.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { treasuryOwed } from "../src/lib/rip/state.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { SEAL_CURRENCY, SEAL_ISSUER, SEAL_TOKEN, XRP_TOKEN, iouToMicro, seasonPlan, type TokenSpec } from "../src/lib/rip/tokens.ts";
import type { Chain, RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { publicOrder, tierView } from "../src/lib/rip/views.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

/**
 * Failures from the Nov 2 nemesis audit, each written to fail on the code it was found in (a5078e36e). A ledger server one
 * step behind, a hand-signed transaction, a lost race for the log and a sale right before a big win are what these add.
 */
const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const OTHER = "rOTHERotherOTHERotherOTHERother";
const STRANGER = "rSTRANGERstrangerSTRANGERstrang";
const SPEC: TokenSpec = { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer: SEAL_ISSUER };
const POOL_XRP = "33007194945";
const POOL_TOKEN = iouToMicro("44788357114.1098");
const ALL = (token: string, valueDrops: string) => ({ bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token, bps: 10000, valueDrops }], tokens: token === SEAL_TOKEN ? [SPEC] : [] });
const NFTS_ONLY = { bandBps: [10000, 0, 0, 0, 0], prizeTable: [], tokens: [] };
type Ledger = ReturnType<typeof testLedger>;
type Plan = Parameters<RipEngine["openSeason"]>[3];

/** A server behind the ledger: until it's cleared, this account's current Sequence reads as an old one. A read at a past ledger is still true. */
function laggingChain(ledger: Ledger) {
  const behind = new Map<string, number>();
  const chain: Chain = {
    ...ledger.chain,
    account: async (a, at) => {
      const x = await ledger.chain.account(a, at);
      const old = behind.get(a);
      return x && at === undefined && old !== undefined ? { ...x, sequence: old } : x;
    },
  };
  return { chain, behind };
}

async function setup(opts: { treasuryXrp?: number; seal?: bigint; stock?: number; seasons?: readonly [NftPrice, string, Plan][]; wrap?: (c: Chain) => Chain; store?: ReturnType<typeof memoryStore> } = {}) {
  const ledger = testLedger("nemesis-audit");
  ledger.fund(TREASURY, opts.treasuryXrp ?? 1000);
  ledger.fund(VAULT, 100);
  for (const a of [PLAYER, OTHER, STRANGER]) ledger.fund(a, 5000);
  ledger.setPool(SPEC, POOL_XRP, POOL_TOKEN);
  ledger.setLine(SPEC, TREASURY, opts.seal ?? 10_000_000_000n);
  const lag = laggingChain(ledger);
  const store = opts.store ?? memoryStore();
  const chain = opts.wrap ? opts.wrap(lag.chain) : lag.chain;
  const engine = createEngine({ store, chain, signer: testSigner(), drawSecret: "test-secret", expectedNetworkId: 1 });
  let n = 0;
  for (const [price, drops, plan] of opts.seasons ?? [[10, "8000000", ALL(XRP_TOKEN, "2500000")] as const]) {
    await engine.openSeason(price, drops, null, plan);
    const adds = [0, 1, 2, 3, 4].flatMap((band) => Array.from({ length: opts.stock ?? 6 }, () => {
      const nftId = nftIdFor(++n);
      ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: `c${band}`, name: `n${n}`, img: "/x.webp", costDrops: "1000000", markDrops: "1000000" };
    }));
    assert.equal((await engine.changePool(price, adds)).ok, true);
  }
  await run(engine, ledger, 8);
  return { ledger, store, engine, behind: lag.behind };
}

async function run(engine: RipEngine, ledger: Ledger, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

/** Long enough for anything signed now to pass its last ledger, with the server keeping up. */
async function waitOut(engine: RipEngine, ledger: Ledger, ledgers = 150) {
  for (let i = 0; i < ledgers / 5; i++) {
    await engine.advance();
    ledger.close(5);
  }
  await engine.advance();
}

async function paid(engine: RipEngine, ledger: Ledger, price: NftPrice = 10, who = PLAYER) {
  const q = await engine.createOrder(who, price);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  return q.order.id;
}

/**
 * A place on a pack, written straight to the log. The sell-back guard rightly refuses a table where every pull beats its price,
 * and a real one reaches this state on one lucky pull in many. This makes that one pull certain, so the test is about what follows.
 */
async function luckyPaid(engine: RipEngine, store: ReturnType<typeof memoryStore>, ledger: Ledger, price: NftPrice, who: string) {
  await engine.sync();
  const season = engine.state.activeSeason.get(price) as string;
  const drops = engine.state.seasons.get(season)?.priceDrops as string;
  const id = `lucky-${who}-${engine.state.head}`;
  const invoice = draw.invoiceOf(id);
  const lastLedger = ledger.ledger() + 80;
  const body: RipEventBody = { type: "order_created", data: { id, season, price, address: who, invoice, drops, lastLedger, createdLedger: ledger.ledger() } };
  assert.equal(await store.append(engine.state.head, sealEvents(engine.state.head, engine.state.headHash, [body], new Date().toISOString())), true);
  await engine.sync();
  ledger.userSubmit({ TransactionType: "Payment", Account: who, Destination: TREASURY, Amount: drops, InvoiceID: invoice, LastLedgerSequence: lastLedger });
  return id;
}

const sequenceOf = async (ledger: Ledger, a: string) => (await ledger.chain.account(a))?.sequence as number;
const payouts = (ledger: Ledger, to: string) => ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.tx.Destination === to && t.result === "tesSUCCESS");
const expiredFinals = (log: readonly RipEvent[]) => log.flatMap((e) => (e.type === "tx_final" && e.data.result === "expired" ? [e.data.hash] : []));
const setFree = (ledger: Ledger, free: bigint, owedAndFloor = 10_000_000n) => ledger.fund(TREASURY, -Number((ledger.balance(TREASURY) - owedAndFloor - free) / 1_000_000n));

// NM-1: a transaction whose Sequence was already spent.

test("NM-1 a payout signed on a spent Sequence settles as expired, is paid once, and nothing behind it freezes", async () => {
  const { engine, ledger, store, behind } = await setup();
  const a = await paid(engine, ledger);
  const b = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  const spent = await sequenceOf(ledger, TREASURY);
  assert.deepEqual(await engine.redeem(PLAYER, a), { ok: true });
  await engine.advance();
  ledger.close();
  // A's payout landed. The server answering for the Sequence is a ledger behind, and still says it's free.
  behind.set(TREASURY, spent);
  assert.deepEqual(await engine.redeem(OTHER, b), { ok: true });
  await engine.advance();
  const stuck = [...engine.state.intents.values()].find((i) => i.ref === b);
  assert.equal(stuck?.sequence, spent);
  behind.clear();
  ledger.userSubmit({ TransactionType: "Payment", Account: STRANGER, Destination: TREASURY, Amount: "5000000" });
  await waitOut(engine, ledger);
  assert.equal(engine.state.orders.get(b)?.pull, "redeemed", "the prize stayed redeeming behind a dead transaction");
  assert.equal(payouts(ledger, OTHER).length, 1);
  assert.equal(payouts(ledger, PLAYER).length, 1);
  assert.equal(payouts(ledger, STRANGER).length, 1, "a stranger's refund froze behind it");
  assert.equal(engine.state.intents.size, 0);
  const log = await store.readFrom(0);
  assert.deepEqual(expiredFinals(log), [stuck?.hash]);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("NM-1 a hand-signed transaction racing a pool anchor can't stop a paid pull from drawing", async () => {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", NFTS_ONLY]] });
  const id = await paid(engine, ledger);
  ledger.close();
  await engine.advance();
  assert.equal(engine.state.orders.get(id)?.status, "paid");
  const nftId = nftIdFor(9000);
  ledger.mintTo(nftId, VAULT);
  assert.equal((await engine.changePool(10, [{ nftId, band: 0, collection: "c", name: "n", img: "/x.webp", costDrops: "1", markDrops: "1" }])).ok, true);
  await engine.advance();
  assert.equal([...engine.state.intents.values()].filter((i) => i.kind === "anchor").length, 1);
  ledger.queueFirst({ TransactionType: "AccountSet", Account: TREASURY });
  ledger.close();
  await waitOut(engine, ledger);
  assert.equal(engine.state.orders.get(id)?.status, "drawn", "the buyer's pull never drew");
  const replay = replayLog(await store.readFrom(0));
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("NM-1 a hand-signed vault transaction can't strand NFT claims at offering, and each gets one offer", async () => {
  const { engine, ledger } = await setup({ seasons: [[10, "8000000", NFTS_ONLY]] });
  const a = await paid(engine, ledger);
  const b = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  assert.deepEqual(await engine.claim(PLAYER, a), { ok: true });
  assert.deepEqual(await engine.claim(OTHER, b), { ok: true });
  await engine.advance();
  ledger.queueFirst({ TransactionType: "AccountSet", Account: VAULT });
  ledger.close();
  await waitOut(engine, ledger);
  assert.equal(engine.state.orders.get(a)?.pull, "offered");
  assert.equal(engine.state.orders.get(b)?.pull, "offered");
  assert.equal(ledger.offers.size, 2);
});

test("NM-1 a spender well behind the transaction's own range is still found", async () => {
  const { engine, ledger, behind } = await setup();
  const a = await paid(engine, ledger);
  const b = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  const spent = await sequenceOf(ledger, TREASURY);
  assert.deepEqual(await engine.redeem(PLAYER, a), { ok: true });
  await run(engine, ledger, 2);
  ledger.close(300);
  behind.set(TREASURY, spent);
  assert.deepEqual(await engine.redeem(OTHER, b), { ok: true });
  await engine.advance();
  behind.clear();
  await waitOut(engine, ledger);
  assert.equal(engine.state.orders.get(b)?.pull, "redeemed");
  assert.equal(payouts(ledger, OTHER).length, 1);
});

/** Claim on a vault whose Sequence a hand-signed transaction just took. The claim's own transaction can never land. */
async function raced(wrap: (c: Chain) => Chain) {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", NFTS_ONLY]], wrap });
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.deepEqual(await engine.claim(PLAYER, id), { ok: true });
  await engine.advance();
  ledger.queueFirst({ TransactionType: "AccountSet", Account: VAULT });
  ledger.close();
  await waitOut(engine, ledger);
  return { engine, ledger, store, id };
}

test("NM-1 no answer about history is no proof: a failed read waits, shows on the alert, and settles once it can read", async () => {
  let down = true;
  const { engine, ledger, store, id } = await raced((c) => ({ ...c, accountTx: async (a, from) => {
    if (down && a === VAULT) throw new Error("history unavailable");
    return c.accountTx(a, from);
  } }));
  assert.equal(engine.state.orders.get(id)?.pull, "offering");
  assert.equal(expiredFinals(await store.readFrom(0)).length, 0);
  assert.equal(engine.state.intents.size, 1);
  assert.equal(ledger.offers.size, 0);
  ledger.close(200);
  assert.ok((await engine.opsAlerts()).some((x) => x.code === "tx_unsettled"));
  down = false;
  await waitOut(engine, ledger);
  assert.equal(engine.state.orders.get(id)?.pull, "offered");
  assert.equal(ledger.offers.size, 1);
});

test("NM-1 an empty or partial history read proves nothing, and neither does another account's Sequence", async () => {
  let rows: "none" | "stranger" | "real" = "none";
  const { engine, ledger, store, id } = await raced((c) => ({ ...c, accountTx: async (a, from) => {
    const real = await c.accountTx(a, from);
    if (a !== VAULT || rows === "real") return real;
    const hand = real.find((t) => t.tx.TransactionType === "AccountSet");
    // The same number, on a payment into the vault from somebody else's account. Their Sequence says nothing about ours.
    return rows === "stranger" && hand ? [{ ...hand, hash: "A".repeat(64), tx: { ...hand.tx, Account: STRANGER, Destination: VAULT } }] : [];
  } }));
  assert.equal(engine.state.orders.get(id)?.pull, "offering");
  rows = "stranger";
  await waitOut(engine, ledger, 50);
  assert.equal(engine.state.orders.get(id)?.pull, "offering");
  assert.equal(expiredFinals(await store.readFrom(0)).length, 0);
  rows = "real";
  await waitOut(engine, ledger);
  assert.equal(engine.state.orders.get(id)?.pull, "offered");
});

test("NM-1 a transaction that did land is never called expired, even if a lookup misses it: its own hash isn't a spender", async () => {
  let blind = false;
  const { engine, ledger, store } = await setup({ wrap: (c) => ({ ...c, tx: async (hash, range) => {
    const t = await c.tx(hash, range);
    return blind && t.found ? { found: false as const, definite: true } : t;
  } }) });
  const a = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.deepEqual(await engine.redeem(PLAYER, a), { ok: true });
  blind = true;
  await waitOut(engine, ledger);
  assert.equal(expiredFinals(await store.readFrom(0)).length, 0);
  assert.equal(payouts(ledger, PLAYER).length, 1);
  blind = false;
  await run(engine, ledger, 2);
  assert.equal(engine.state.orders.get(a)?.pull, "redeemed");
  assert.equal(payouts(ledger, PLAYER).length, 1);
});

test("NM-1 a read so far behind that its spender is out of reach waits for a person, and still pays once when it can", async () => {
  const { engine, ledger, store, behind } = await setup();
  const a = await paid(engine, ledger);
  const b = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  const spent = await sequenceOf(ledger, TREASURY);
  assert.deepEqual(await engine.redeem(PLAYER, a), { ok: true });
  await run(engine, ledger, 2);
  ledger.close(1000);
  behind.set(TREASURY, spent);
  assert.deepEqual(await engine.redeem(OTHER, b), { ok: true });
  await engine.advance();
  behind.clear();
  await waitOut(engine, ledger, 200);
  assert.equal(expiredFinals(await store.readFrom(0)).length, 0);
  assert.equal(engine.state.orders.get(b)?.pull, "redeeming");
  assert.ok((await engine.opsAlerts()).some((x) => x.code === "tx_unsettled"));
  assert.equal(payouts(ledger, OTHER).length, 0);
});

test("NM-1 property: through any mix of hand-signed transactions and a lagging server, every prize pays exactly once, and only a transaction that never landed is ever expired", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("advance", "close", "hand", "lag", "catchup", "redeemA", "redeemB"), { minLength: 5, maxLength: 40 }), async (steps) => {
      const { engine, ledger, store, behind } = await setup();
      const a = await paid(engine, ledger);
      const b = await paid(engine, ledger, 10, OTHER);
      await run(engine, ledger, 8);
      let last = await sequenceOf(ledger, TREASURY);
      for (const s of steps) {
        if (s === "advance") await engine.advance();
        else if (s === "close") {
          last = await sequenceOf(ledger, TREASURY);
          ledger.close();
        } else if (s === "hand") ledger.queueFirst({ TransactionType: "AccountSet", Account: TREASURY });
        else if (s === "lag") behind.set(TREASURY, last);
        else if (s === "catchup") behind.clear();
        else if (s === "redeemA") await engine.redeem(PLAYER, a);
        else await engine.redeem(OTHER, b);
      }
      behind.clear();
      await engine.redeem(PLAYER, a);
      await engine.redeem(OTHER, b);
      await waitOut(engine, ledger, 100);
      assert.equal(engine.state.orders.get(a)?.pull, "redeemed");
      assert.equal(engine.state.orders.get(b)?.pull, "redeemed");
      assert.equal(payouts(ledger, PLAYER).length, 1, "paid twice");
      assert.equal(payouts(ledger, OTHER).length, 1, "paid twice");
      const log = await store.readFrom(0);
      const landed = new Set(ledger.history.map((t) => t.hash));
      for (const hash of expiredFinals(log)) assert.ok(!landed.has(hash), "a transaction that landed was called expired");
      const replay = replayLog(log);
      assert.ok(replay.ok, JSON.stringify(replay));
    }),
    { numRuns: 25 },
  );
});

// NM-2: a wallet that refuses claim offers.

test("NM-2 a wallet that refuses claim offers can't loop on the vault's slot or the log, and it can still sell or try later", async () => {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", NFTS_ONLY]] });
  const mine = await paid(engine, ledger);
  const theirs = await paid(engine, ledger, 10, OTHER);
  await run(engine, ledger, 8);
  ledger.refuseOffers(PLAYER, "tecNO_PERMISSION");
  const before = (await store.readFrom(0)).length;
  const vaultBefore = ledger.balance(VAULT);
  let told: string | null = null;
  for (let i = 0; i < 60; i++) {
    const r = await engine.claim(PLAYER, mine);
    if (!r.ok && r.code === "try_later") told = r.message;
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
  const grew = (await store.readFrom(0)).length - before;
  assert.ok(grew <= 6, `60 claims wrote ${grew} log entries`);
  assert.ok(vaultBefore - ledger.balance(VAULT) <= 24n, "each try burned a fee from the vault");
  assert.ok(told, "it was never told to wait");
  assert.doesNotMatch(told as string, /took this offer back/, "this wallet took nothing back");
  assert.match(told as string, /wallet/);
  // Nobody behind it waits, and selling doesn't.
  assert.deepEqual(await engine.claim(OTHER, theirs), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(theirs)?.pull, "offered");
  assert.ok(engine.sellPrice(PLAYER, mine).ok);
  // Once the wait is over and the wallet takes offers, it goes through once.
  ledger.refuseOffers(PLAYER, null);
  ledger.close(300);
  await engine.advance();
  assert.deepEqual(await engine.claim(PLAYER, mine), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(mine)?.pull, "offered");
  const replay = replayLog(await store.readFrom(0));
  assert.ok(replay.ok, JSON.stringify(replay));
});

// NM-3: a sell-back can't void a win.

async function winAfterSale() {
  const s = await setup({ treasuryXrp: 100, seasons: [[10, "100000000", ALL(SEAL_TOKEN, "80000000")], [5, "4000000", ALL(XRP_TOKEN, "30000000")]] });
  const { engine, ledger, store } = s;
  const stash = await paid(engine, ledger, 10);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(stash)?.prize?.token, SEAL_TOKEN);
  setFree(ledger, 90_000_000n);
  const winner = await luckyPaid(engine, store, ledger, 5, OTHER);
  // The winner's payment is on the ledger, not yet scanned, so it reads as a quote and nothing is held for it.
  ledger.close();
  const quote = await engine.quoteSell(PLAYER, stash);
  assert.ok(quote.ok, JSON.stringify(quote));
  assert.ok(BigInt(quote.drops) > 64_000_000n);
  assert.deepEqual(await engine.sell(PLAYER, stash, quote.drops), { ok: true });
  await run(engine, ledger, 8);
  return { ...s, stash, winner };
}

test("NM-3 a sale racing an unscanned win can't void it: the prize is struck, owed, paid after a top-up, once, and the log replays", async () => {
  const { engine, ledger, store, stash, winner } = await winAfterSale();
  const o = engine.state.orders.get(winner)!;
  assert.equal(o.status, "drawn", "the win was voided down to a pack-price refund");
  assert.equal(engine.state.refunds.size, 0);
  assert.equal(engine.state.orders.get(stash)?.pull, "sold");
  assert.equal(o.prize?.token, XRP_TOKEN);
  assert.equal(o.prize?.amount, "30000000");
  // It's owed, and owed money is counted, on the admin page and against every gate.
  assert.equal(treasuryOwed(engine.state), 30_000_000n);
  assert.equal(o.pull, "redeeming", "it pays by itself: nobody has to come back and ask");
  assert.equal(payouts(ledger, OTHER).length, 0);
  // The owner hears about it, in numbers.
  const alert = (await engine.opsAlerts()).find((a) => a.code === "prizes_owed");
  assert.ok(alert, "nobody was told a prize is owed");
  assert.match(alert.text, /1 prize/);
  assert.match(alert.text, /30 XRP/);
  // The player's screen says so plainly.
  const pub = publicOrder(engine.state, o);
  assert.equal(pub.prize?.owed, true);
  assert.equal(live.nftStatusLabel(pub), "Owed to you");
  assert.match(live.owedPrizeText(pub.prize?.name ?? ""), /owed to you/);
  assert.match(live.owedPrizeText(pub.prize?.name ?? ""), /30 XRP/);
  // Sales stay closed while it's owed: no new place is sold on money that isn't there.
  const closed = await engine.createOrder(STRANGER, 5);
  assert.equal(closed.ok, false);
  // A top-up pays it without anyone asking, exactly once.
  ledger.fund(TREASURY, 50);
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(winner)?.pull, "redeemed");
  assert.equal(payouts(ledger, OTHER).length, 1);
  assert.equal(treasuryOwed(engine.state), 0n);
  assert.equal(publicOrder(engine.state, engine.state.orders.get(winner)!).pull, "redeemed");
  assert.equal((await engine.opsAlerts()).some((a) => a.code === "prizes_owed"), false);
  await run(engine, ledger, 3);
  assert.equal(payouts(ledger, OTHER).length, 1);
  const log = await store.readFrom(0);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  const check = await verifyAgainstChain(log, ledger.chain, TREASURY, 100);
  assert.ok(check.ok, JSON.stringify(check));
});

test("NM-3 a prize waiting on a top-up doesn't freeze the treasury: a refund it can pay still goes", async () => {
  const { engine, ledger, winner } = await winAfterSale();
  ledger.userSubmit({ TransactionType: "Payment", Account: STRANGER, Destination: TREASURY, Amount: "2000000" });
  await run(engine, ledger, 4);
  assert.equal(payouts(ledger, STRANGER).length, 1, "a stranger's refund froze behind the owed prize");
  assert.equal(engine.state.orders.get(winner)?.pull, "redeeming");
  assert.equal(payouts(ledger, OTHER).length, 0);
});

test("NM-3 a wallet that refuses its owed prize gets the normal wait, keeps the prize, and it's still counted as owed", async () => {
  const { engine, ledger, winner } = await winAfterSale();
  ledger.refusePayments(OTHER, "tecNO_PERMISSION");
  ledger.fund(TREASURY, 50);
  await run(engine, ledger, 3);
  const o = engine.state.orders.get(winner)!;
  assert.equal(o.pull, "stashed");
  assert.equal(treasuryOwed(engine.state), 30_000_000n);
  ledger.refusePayments(OTHER, null);
  ledger.close(300);
  assert.deepEqual(await engine.redeem(OTHER, winner), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(winner)?.pull, "redeemed");
  assert.equal(payouts(ledger, OTHER).length, 1);
});

test("NM-3 property: however short the treasury is at the draw, every prize row is struck for its roll, none is refunded, and a top-up pays each exactly once", async () => {
  await fc.assert(
    fc.asyncProperty(fc.bigInt({ min: 0n, max: 80_000_000n }), fc.boolean(), fc.boolean(), async (free, sealRow, drain) => {
      const value = "42000000";
      const { engine, ledger, store } = await setup({ treasuryXrp: 200, seasons: [[10, "8000000", ALL(sealRow ? SEAL_TOKEN : XRP_TOKEN, value)]] });
      const a = await luckyPaid(engine, store, ledger, 10, PLAYER);
      const b = await luckyPaid(engine, store, ledger, 10, OTHER);
      ledger.close();
      setFree(ledger, free);
      if (drain) ledger.setLine(SPEC, TREASURY, 0n);
      await run(engine, ledger, 8);
      for (const id of [a, b]) {
        const o = engine.state.orders.get(id)!;
        assert.equal(o.status, "drawn");
        assert.equal(o.prize?.valueDrops, value);
        if (o.prize?.token === XRP_TOKEN) assert.equal(o.prize.amount, value);
      }
      assert.equal(engine.state.refunds.size, 0);
      ledger.setLine(SPEC, PLAYER, 0n);
      ledger.setLine(SPEC, OTHER, 0n);
      ledger.fund(TREASURY, 500);
      for (const [who, id] of [[PLAYER, a], [OTHER, b]] as const) assert.deepEqual(await engine.redeem(who, id), { ok: true });
      await run(engine, ledger, 6);
      for (const id of [a, b]) assert.equal(engine.state.orders.get(id)?.pull, "redeemed");
      for (const who of [PLAYER, OTHER]) assert.equal(payouts(ledger, who).length, 1);
      const replay = replayLog(await store.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
    }),
    { numRuns: 25 },
  );
});

/** Re-seal a log with some events changed, as an older engine or someone rewriting history would have written it. */
function rewrite(events: readonly RipEvent[], change: (e: RipEventBody) => RipEventBody): RipEvent[] {
  let out: RipEvent[] = [];
  for (const e of events) {
    const { seq: _s, prev: _p, hash: _h, at, ...body } = e;
    const last = out.at(-1);
    out = [...out, ...sealEvents(last?.seq ?? 0, last?.hash ?? "", [change(body as RipEventBody)], at)];
  }
  return out;
}

test("NM-3 replay: a log with an older float_short refund still replays and verifies, and only XRP can be owed", async () => {
  const { engine, ledger, store } = await setup({ treasuryXrp: 100, seasons: [[10, "100000000", ALL(XRP_TOKEN, "60000000")]] });
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(id)?.prize?.token, XRP_TOKEN);
  const log = await store.readFrom(0);
  const old = rewrite(log, (e) => (e.type === "pull_prize_drawn" && e.data.order === id ? { type: "pull_refund_due", data: { id: `pull:${id}`, order: id, seed: e.data.seed, ledgerHash: e.data.ledgerHash, digest: e.data.digest, band: e.data.band, reason: "float_short", to: e.data.address, drops: "100000000" } } : e));
  const replay = replayLog(old);
  assert.ok(replay.ok, JSON.stringify(replay));
  const check = await verifyAgainstChain(old, ledger.chain, TREASURY, 100);
  assert.ok(check.ok, JSON.stringify(check));
  const lying = await verifyAgainstChain(old, { ...ledger.chain, ledgerHash: async () => "F".repeat(64) }, TREASURY, 100);
  assert.equal(lying.ok, false);
  assert.match((lying as { why: string }).why, /ledger hash/);
  // The flag means XRP is on its way. A token prize marked owed isn't anything the engine can write.
  const forged = rewrite(await sealLog(), (e) => (e.type === "pull_prize_drawn" ? ({ ...e, data: { ...e.data, owed: true } } as RipEventBody) : e));
  assert.equal(replayLog(forged).ok, false);
});

async function sealLog() {
  const { engine, ledger, store } = await setup({ seasons: [[10, "8000000", ALL(SEAL_TOKEN, "2500000")]] });
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(id)?.prize?.token, SEAL_TOKEN);
  return store.readFrom(0);
}

// NM-4: free quotes can't close the packs, and a closed pack says so.

const shelf = SHELF_PRICES.map((price) => [price, String(NFT_LADDERS[price].xrp * 1e6), seasonPlan(NFT_LADDERS[price], SPEC)] as [NftPrice, string, Plan]);
const wallets = (n: number) => Array.from({ length: n }, (_, i) => `rWALLET${String(i).padStart(4, "0")}walletWALLETwallet`);

test("NM-4 free quotes can't close the packs on SEAL: launch float, one prize of cover plus what's owed", async () => {
  // About 60.6M SEAL a place at this price, against what the owner holds.
  const { engine, ledger } = await setup({ treasuryXrp: 2000, seal: 273_600_000n, stock: 35, seasons: shelf });
  const who = wallets(5);
  for (const w of who) ledger.fund(w, 500);
  for (const w of who) {
    for (const price of SHELF_PRICES) {
      const q = await engine.createOrder(w, price);
      assert.ok(q.ok, `the place after ${engine.state.orders.size} got ${JSON.stringify(q)}`);
    }
  }
  const st = await engine.sealFloatStatus();
  assert.deepEqual(st?.pauses, []);
});

test("NM-4 a pack short of one SEAL prize is closed everywhere at once: the quote, the float status, the alert and the shelf agree", async () => {
  const { engine, ledger } = await setup({ treasuryXrp: 2000, seal: 273_600_000n, stock: 35, seasons: shelf });
  const validated = await ledger.chain.validatedLedger();
  const rate = async () => null;
  assert.equal((await engine.closedPacks(validated, rate)).size, 0);
  assert.equal(tierView(engine.state, 5, validated, await engine.closedPacks(validated, rate)).open, true);
  ledger.setLine(SPEC, TREASURY, 1_000_000n);
  const q = await engine.createOrder(PLAYER, 5);
  assert.equal(q.ok, false);
  assert.equal((q as { code: string }).code, "restocking");
  const st = await engine.sealFloatStatus();
  assert.deepEqual([...(st?.pauses ?? [])].sort(), [...SHELF_PRICES].sort());
  ledger.close();
  const closed = await engine.closedPacks(validated + 1, rate);
  assert.deepEqual([...closed].sort(), [...SHELF_PRICES].sort());
  for (const price of SHELF_PRICES) assert.equal(tierView(engine.state, price, validated + 1, closed).open, false);
  // Refilled, it's all open again, with nobody having to reset anything.
  ledger.setLine(SPEC, TREASURY, 273_600_000n);
  ledger.close();
  assert.equal(tierView(engine.state, 5, validated + 2, await engine.closedPacks(validated + 2, rate)).open, true);
  assert.deepEqual((await engine.sealFloatStatus())?.pauses, []);
});

test("NM-4 every SEAL refusal shows in the float status: a prize too big for the pool is a pause, not a silent restock", async () => {
  // 100 XRP is over 1% of a 6,000 XRP pool, which the gate refuses however much SEAL is on hand.
  const { engine, ledger } = await setup({ treasuryXrp: 2000, seasons: [[10, "200000000", ALL(SEAL_TOKEN, "100000000")]] });
  ledger.setPool(SPEC, "6000000000", String((BigInt(POOL_TOKEN) * 6_000_000_000n) / BigInt(POOL_XRP)), 100);
  ledger.close();
  const q = await engine.createOrder(PLAYER, 10);
  assert.equal((q as { code: string }).code, "prize_paused");
  assert.deepEqual((await engine.sealFloatStatus())?.pauses, [10]);
});

test("NM-4 the XRP gate is sized by the odds: 15 places don't close it, and when it does close the owner is told and the shelf reads closed", async () => {
  const { engine, ledger } = await setup({ treasuryXrp: 1000, stock: 35, seal: 10_000_000_000n, seasons: shelf });
  const who = wallets(10);
  for (const w of who) ledger.fund(w, 500);
  // Ten places on each pack, uncapped: $5's 5-6 ladder (17 prize sizes) needs 407.5 XRP for ten at the odds, $10's 304. 5-5 needed 162.
  setFree(ledger, 760_000_000n);
  let places = 0;
  for (const w of who) {
    for (const price of SHELF_PRICES) {
      const q = await engine.createOrder(w, price);
      assert.ok(q.ok, `place ${places + 1}: ${JSON.stringify(q)}`);
      places++;
    }
  }
  assert.equal((await engine.opsAlerts()).some((a) => a.code === "xrp_float"), false);
  // The treasury is swept while those places are open: their prizes aren't covered now.
  setFree(ledger, 100_000_000n);
  const next = await engine.createOrder(STRANGER, 5);
  assert.equal(next.ok, false);
  const alert = (await engine.opsAlerts()).find((a) => a.code === "xrp_float");
  assert.ok(alert, "the pack closed and nobody was told");
  assert.match(alert.text, /\$5/);
  ledger.close();
  assert.ok((await engine.closedPacks(ledger.ledger(), async () => null)).has(5));
});

test("NM-4 property: the XRP cover holds at the odds it claims, on the launch tables, and a sure row still counts every place", () => {
  const cover = draw.xrpCoverFor;
  for (const price of SHELF_PRICES) {
    const { bandBps, prizeTable } = seasonPlan(NFT_LADDERS[price], SPEC);
    const biggest = prizeTable.reduce((m, r) => (BigInt(r.valueDrops) > m ? BigInt(r.valueDrops) : m), 0n);
    assert.equal(cover(prizeTable, bandBps, 0), 0n);
    assert.equal(cover(prizeTable, bandBps, 1), biggest);
    // The whole distribution of what `places` pulls pay, worked exactly, in half-XRP steps.
    const step = 500_000n;
    const outcomes = new Map<number, number>();
    for (const r of prizeTable) outcomes.set(Number(BigInt(r.valueDrops) / step), (outcomes.get(Number(BigInt(r.valueDrops) / step)) ?? 0) + (bandBps[r.band] / 10_000) * (r.bps / 10_000));
    const none = 1 - [...outcomes.values()].reduce((a, b) => a + b, 0);
    let dist = new Map<number, number>([[0, 1]]);
    let previous = 0n;
    for (let places = 1; places <= 60; places++) {
      const next = new Map<number, number>();
      for (const [sum, p] of dist) {
        next.set(sum, (next.get(sum) ?? 0) + p * none);
        for (const [v, q] of outcomes) next.set(sum + v, (next.get(sum + v) ?? 0) + p * q);
      }
      dist = next;
      const need = cover(prizeTable, bandBps, places);
      assert.ok(need >= previous, "more places can't need less");
      assert.ok(need <= biggest * BigInt(places));
      previous = need;
      let over = 0;
      for (const [sum, p] of dist) if (BigInt(sum) * step > need) over += p;
      assert.ok(over <= 1e-3, `$${price} ${places} places: ${over} chance of needing more than ${need}`);
    }
  }
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 200 }), fc.integer({ min: 1, max: 1000 }), (places, xrp) => {
      assert.equal(cover([{ band: 0, token: XRP_TOKEN, bps: 10000, valueDrops: String(xrp * 1e6) }], [10000, 0, 0, 0, 0], places), BigInt(places) * BigInt(xrp * 1e6));
    }),
  );
});

// NM-5: a stashed prize can't sell for more than its share of what it was worth.

test("NM-5 a pool walked up in small steps can't sell a stashed prize above its value's share", async () => {
  const value = 42_000_000n;
  const cap = (value * 8500n) / 10_000n;
  const { engine, ledger } = await setup({ treasuryXrp: 1000, seasons: [[10, "60000000", ALL(SEAL_TOKEN, value.toString())]] });
  const id = await paid(engine, ledger);
  await run(engine, ledger, 8);
  const o = engine.state.orders.get(id)!;
  assert.equal(o.prize?.token, SEAL_TOKEN);
  let x = BigInt(POOL_XRP);
  for (let step = 0; step < 13; step++) {
    // 4% each half hour, inside the price guard every time. Nothing here ever trips it.
    x = (x * 104n) / 100n;
    ledger.setPool(SPEC, x.toString(), POOL_TOKEN);
    ledger.close(460);
    await engine.advance();
    const q = await engine.quoteSell(PLAYER, id);
    assert.ok(q.ok, `step ${step}: ${JSON.stringify(q)}`);
    assert.ok(BigInt(q.drops) <= cap, `step ${step}: quoted ${q.drops} on a prize whose cap is ${cap}`);
  }
  assert.equal(((await engine.sell(PLAYER, id, (cap + 1n).toString())) as { code: string }).code, "price_changed");
  assert.deepEqual(await engine.sell(PLAYER, id, cap.toString()), { ok: true });
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(id)?.pull, "sold");
  assert.equal(payouts(ledger, PLAYER)[0]?.delivered, cap.toString());
});

// NM-6: a payment made in time, and a lost race for the log.

test("NM-6 a payment made in time isn't a late refund when the first scan after its order's last ledger loses the race for the log", async () => {
  const base = memoryStore();
  let lose = false;
  const store = {
    ...base,
    append: async (head: number, events: readonly RipEvent[]) => {
      if (lose && events.some((e) => e.type === "pull_paid")) {
        lose = false;
        return false;
      }
      return base.append(head, events);
    },
  };
  const { engine, ledger, store: used } = await setup({ store: store as typeof base, seasons: [[10, "8000000", NFTS_ONLY]] });
  const q = await engine.createOrder(PLAYER, 10);
  assert.ok(q.ok);
  ledger.userSubmit(q.tx as never);
  ledger.close();
  assert.ok(ledger.history.some((t) => t.tx.InvoiceID === q.order.invoice), "the payment is on the ledger, in time");
  // The server is away until after the order's last ledger, and its first scan back loses.
  ledger.close(q.order.lastLedger - ledger.ledger() + 2);
  lose = true;
  await engine.advance();
  assert.equal(lose, false, "the scan didn't try to log the payment");
  assert.notEqual(engine.state.orders.get(q.order.id)?.status, "expired", "the expiry pass ran on a scan that didn't make it into the log");
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(q.order.id)?.status, "drawn", "paid in time, and got a late refund");
  assert.equal(engine.state.refunds.size, 0);
  const replay = replayLog(await used.readFrom(0));
  assert.ok(replay.ok, JSON.stringify(replay));
});

// Also looked at: stuck refunds and treasuryOwed.

test("a stuck refund is still owed: free XRP doesn't read high until it's retried", async () => {
  const { engine, ledger } = await setup();
  ledger.refusePayments(STRANGER, "tecNO_PERMISSION");
  ledger.userSubmit({ TransactionType: "Payment", Account: STRANGER, Destination: TREASURY, Amount: "5000000" });
  await run(engine, ledger, 4);
  const r = [...engine.state.refunds.values()][0];
  assert.equal(r.status, "stuck");
  assert.equal(treasuryOwed(engine.state), 5_000_000n);
  ledger.refusePayments(STRANGER, null);
  assert.equal(await engine.retryRefund(r.id, "owner"), true);
  await run(engine, ledger, 3);
  assert.equal(treasuryOwed(engine.state), 0n);
  assert.equal(payouts(ledger, STRANGER).length, 1);
});

// Replay: season 5-1 is on mainnet, so nothing here may change how an existing log reads.

test("a log written by the engine these fixes were made on replays to the same pulls, orders and refunds, float_short refund included", () => {
  // test/fixtures/log-a5078e36e.json came out of that engine: NFT pulls, claims, a cancel, a sale, shelf-table token prizes, redemptions, sold SEAL, a refund, a stuck refund, a lapsed quote and a real float_short.
  const { events, expected } = JSON.parse(readFileSync(new URL("./fixtures/log-a5078e36e.json", import.meta.url), "utf8")) as { events: RipEvent[]; expected: { pulls: number; head: number; orders: Record<string, { status: string; pull: string | null; prize: string | null; sell: string | null }>; refunds: Record<string, string>; intents: number } };
  const replay = replayLog(events);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.equal(replay.pulls, expected.pulls);
  assert.equal(replay.state.head, expected.head);
  assert.equal(replay.state.intents.size, expected.intents);
  assert.deepEqual(Object.fromEntries([...replay.state.orders.values()].map((o) => [o.id, { status: o.status, pull: o.pull, prize: o.prize ? `${o.prize.amount} ${o.prize.token}` : null, sell: o.sellDrops }])), expected.orders);
  assert.deepEqual(Object.fromEntries([...replay.state.refunds.values()].map((r) => [r.id, r.status])), expected.refunds);
  assert.ok(Object.values(expected.refunds).includes("stuck"));
  assert.ok([...replay.state.refunds.values()].some((r) => r.reason === "float_short"));
});
