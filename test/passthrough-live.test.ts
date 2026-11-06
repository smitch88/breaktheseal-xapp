import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { CUSTODY_SOL_LOW_LAMPORTS, MAX_LAPSED_ORDERS, PASSTHROUGH_RATE_ROOM_BPS, SWAP_GIVE_UP_MS, SWAP_STALL_MS } from "../src/lib/rip/engine.ts";
import type { RelayRails } from "../src/lib/rip/relay.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { DEFAULT_POLICY, DEPOSITORY, fakeCustody, fakeRelay, railsFor } from "./support-relay.ts";
import { TREASURY, addressOf, world } from "./support-routes.ts";

/**
 * The passthrough on top of the live card line: multi-pack orders, the restocker, and the switch turned off with work still out.
 * Each test here was written to fail first, against the merged branch, and pins the fix that followed.
 */
const PLAYER = addressOf(1);
const OTHER = addressOf(2);
const MULTI = { SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: "20" };

type SiteOpts = { usdc?: bigint; treasuryXrp?: number; machineUsd?: number; insuredMicro?: string; pct?: number; over?: Parameters<typeof railsFor>[1]; off?: boolean; noRelay?: boolean; rate?: number; env?: Record<string, string>; wrapChain?: Parameters<typeof world>[0] extends infer W ? (W extends { wrapChain?: infer F } ? F : never) : never };

async function site(o: SiteOpts = {}) {
  const custody = fakeCustody(o.usdc ?? 0n, { machineUsd: o.machineUsd, insuredMicro: o.insuredMicro, pct: o.pct });
  let relay!: ReturnType<typeof fakeRelay>;
  let rails!: RelayRails;
  const w = await world({
    cards: true,
    gateway: custody.gateway,
    treasuryXrp: o.treasuryXrp ?? 15,
    rate: o.rate,
    env: o.env,
    wrapChain: o.wrapChain,
    relay: (ledger) => {
      relay = fakeRelay(ledger, custody.c, { usdPerXrp: o.rate ?? 1.25 });
      rails = railsFor(relay.api, { enabled: !o.off, ...o.over });
      // Without rails at all: a site as it runs today, for comparison.
      return o.noRelay ? (undefined as unknown as RelayRails) : rails;
    },
  });
  await w.engine.advance();
  const me = w.client(PLAYER);
  w.fund(me, 40_000);
  const other = w.client(OTHER);
  w.fund(other, 40_000);
  const go = async (n = 8) => {
    for (let i = 0; i < n; i++) {
      await w.engine.advance();
      relay.tick();
      w.ledger.close();
      await w.engine.advance();
    }
  };
  const buy = async (who = me) => {
    const q = await w.call("POST", "/api/rip/cards", { as: who, body: { code: "pokemon_25" } });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    w.ledger.userSubmit(q.body.tx);
    return q.body.order.id as string;
  };
  const sell = async (id: string, who = me) => {
    const quote = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: who });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    const done = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: who, body: { drops: quote.body.drops } });
    return { quote: BigInt(quote.body.drops), done };
  };
  const swaps = () => [...w.engine.state.swaps.values()];
  const alerts = async () => (await w.engine.opsAlerts()).map((a) => a.code);
  const setEnabled = (on: boolean) => {
    (rails as { enabled: boolean }).enabled = on;
  };
  return { w, me, other, relay, custody: custody.c, go, buy, sell, swaps, alerts, setEnabled };
}

const replays = async (w: Awaited<ReturnType<typeof site>>["w"]) => {
  const r = replayLog(await w.store.readFrom(0));
  assert.equal(r.ok, true, r.ok ? "" : `${r.why} at ${r.at}`);
};

/* ------------------------------------------------ round 1 ------------------------------------------------ */

test("switch off: a sold card waiting on the treasury raises exactly the alerts it raises on a site with no rails at all", async () => {
  const run = async (noRelay: boolean) => {
    const s = await site({ usdc: 400_000_000n, treasuryXrp: 400, off: true, noRelay, insuredMicro: "90000000", pct: 85 });
    const id = await s.buy();
    await s.go(6);
    s.custody.holdSale = true;
    const { done } = await s.sell(id);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    s.w.ledger.setBalance(TREASURY, 11);
    s.custody.holdSale = false;
    await s.go(3);
    assert.equal(s.w.cardOf(id)?.hold, "selling");
    s.w.state.clockMs += SWAP_STALL_MS + 60_000;
    return (await s.alerts()).sort();
  };
  const today = await run(true);
  assert.ok(today.includes("card_payout_waiting"));
  assert.deepEqual(await run(false), today);
});

test("a refill never takes a sale's own USDC while that sale's payout is waiting on it: XRP moved against it, so it waits, then pays the quote", async () => {
  // A card worth enough that its sale is a refill-sized batch by itself.
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, insuredMicro: "90000000", pct: 85 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  s.custody.holdSale = true;
  const { quote, done } = await s.sell(id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  s.relay.usdPerXrp = 1.35;
  s.custody.holdSale = false;
  await s.go(5);
  assert.equal(s.w.cardOf(id)?.hold, "selling");
  assert.equal(s.custody.relaySent.size, 0, "no USDC left custody at a rate that can't pay the player");
  assert.ok((await s.alerts()).includes("sale_rate_hold"));
  s.relay.usdPerXrp = 1.25;
  await s.go(8);
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote]);
  await replays(s.w);
});

test("switch turned off with a passthrough sale still waiting: the treasury owes it, so it can't promise the same XRP to another sale", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, insuredMicro: "30000000", pct: 100 });
  const mine = await s.buy();
  const theirs = await s.buy(s.other);
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  s.custody.holdSale = true;
  const { quote, done } = await s.sell(mine);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(s.w.cardOf(mine)?.exit?.passthrough, true);
  s.relay.down = true;
  s.setEnabled(false);
  s.custody.holdSale = false;
  await s.go(3);
  // Exactly one sale's worth of XRP above the floor.
  s.w.ledger.setBalance(TREASURY, Math.ceil(10 + Number(quote) / 1e6 + 1));
  const q = await s.w.call("POST", `/api/rip/cards/${theirs}/sell`, { as: s.other });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const second = await s.w.call("POST", `/api/rip/cards/${theirs}/sell`, { as: s.other, body: { drops: q.body.drops } });
  assert.equal(second.body.code, "sell_paused", "the waiting sale's XRP isn't free");
  await s.go(4);
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote], "the first sale is paid from the treasury once the switch is off");
});

test("custody short of SOL to buy the pack: no XRP goes to Relay, an alert says why, and the order goes back whole", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  s.custody.sol = CUSTODY_SOL_LOW_LAMPORTS - 1n;
  const id = await s.buy();
  await s.go(4);
  assert.equal(s.relay.deposits.length, 0, "a swap would land USDC custody can't spend");
  assert.ok((await s.alerts()).includes("custody_sol"));
  s.w.state.clockMs += SWAP_GIVE_UP_MS + 1000;
  await s.go(4);
  const c = s.w.cardOf(id);
  assert.equal(c?.status, "refunded");
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => t.delivered), [c?.drops]);
  await replays(s.w);
});

test("a Relay deposit that would cost custody more than a fee's worth of SOL is refused, as it's judged before signing", async () => {
  const { judgeRelayDeposit } = await import("../src/lib/rip/cc-gateway.ts");
  const { checkUsdcToXrp } = await import("../src/lib/rip/relay.ts");
  const { AddressLookupTableAccount, Keypair, PublicKey } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  const CUSTODY_KEY = "8kpUHDwhZ5GYpuBmzjgsAK3jWZe3TGxZDPktSn6MCXm8";
  const raw = JSON.parse(readFileSync(new URL("./fixtures/relay/quote-usdc-to-xrp-21-20261102.json", import.meta.url), "utf8"));
  const policy = { treasury: "rLixKPQ3jGk4yYhAt3ybAwdrC8tvTLLvG", custody: CUSTODY_KEY, ...DEFAULT_POLICY };
  const q = checkUsdcToXrp(raw, policy, { inMicro: 21_000_000n, minOutDrops: 16_000_000n }, 1794261192 - 7 * 86400);
  const usdcAfter = Buffer.alloc(165);
  usdcAfter.set(bs58.decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), 0);
  usdcAfter.set(bs58.decode(CUSTODY_KEY), 32);
  usdcAfter.writeBigUInt64LE(79_000_000n, 64);
  usdcAfter[108] = 1;
  const table = new AddressLookupTableAccount({ key: new PublicKey(q.lookupTables?.[0] as string), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [] } });
  const judge = (solDebit: number) =>
    judgeRelayDeposit(
      {
        getAddressLookupTable: async () => ({ value: table }),
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
        getTokenAccountBalance: async () => ({ value: { amount: "100000000" } }),
        getBalance: async () => 10_000_000,
        simulateTransaction: async () => ({ value: { err: null, accounts: [{ data: [usdcAfter.toString("base64")] }, { lamports: 10_000_000 - solDebit, owner: "11111111111111111111111111111111" }] } }),
      } as never,
      { custody: new PublicKey(CUSTODY_KEY), instructions: q.instructions ?? [], lookupTables: q.lookupTables ?? [], amountMicro: 21_000_000n, others: [] },
    );
  // What Relay's deposit costs today: its gas and the base fee.
  assert.equal((await judge(7_609)).refusal, null);
  // A tenth of custody's SOL for one deposit is a rent or a priority fee nobody agreed to.
  assert.match((await judge(1_000_000)).refusal as string, /SOL/);
});

test("a paid pack whose deposits keep dying still goes back whole at the limit: retries don't reset the clock", async () => {
  const dropDeposits = (c: import("../src/lib/rip/types.ts").Chain) => ({
    ...c,
    submit: async (blob: string) => ((JSON.parse(blob) as { Destination?: string }).Destination === DEPOSITORY ? { engineResult: "telINSUF_FEE_P" } : c.submit(blob)),
  });
  const s = await site({ usdc: 0n, treasuryXrp: 40, wrapChain: dropDeposits });
  const id = await s.buy();
  for (let i = 0; i < 8; i++) {
    await s.go(25);
    s.w.state.clockMs += SWAP_GIVE_UP_MS / 6;
  }
  await s.go(4);
  assert.ok(s.swaps().length >= 2, "it did retry");
  const c = s.w.cardOf(id);
  assert.equal(c?.status, "refunded");
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => t.delivered), [c?.drops]);
  await replays(s.w);
});

/* -------------------------------------- multi-pack card orders meet the passthrough -------------------------------------- */

test("multi: with the switch on, each card in a multi order is priced with the passthrough's room, as a single is", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, env: { ...MULTI, SEAL_MULTI_CARD_MAX: "5" } });
  const single = await s.w.call("POST", "/api/rip/cards", { as: s.other, body: { code: "pokemon_25" } });
  const q = await s.w.call("POST", "/api/rip/bundles", { as: s.me, body: { code: "pokemon_25", qty: 3, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const each = BigInt(Math.round(q.body.bundle.eachXrp * 1e6));
  const raw = (25_000_000n * 1_000_000n) / 1_250_000n;
  assert.ok(each >= (raw * (10_000n + PASSTHROUGH_RATE_ROOM_BPS)) / 10_000n, `each ${each}`);
  assert.equal(each, BigInt(single.body.tx.Amount));
});

test("multi: custody empty, a multi order still opens with the switch on, and each card is bought through its own swap", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40, env: { ...MULTI, SEAL_MULTI_CARD_MAX: "5" } });
  const room = await s.w.call("GET", "/api/rip/bundle-room?code=pokemon_25", { as: s.me });
  assert.ok(room.body.max >= 3, JSON.stringify(room.body));
  const q = await s.w.call("POST", "/api/rip/bundles", { as: s.me, body: { code: "pokemon_25", qty: 3, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  s.w.ledger.userSubmit(q.body.tx);
  await s.go(16);
  const kids = [...s.w.engine.state.cards.values()].filter((c) => c.bundle === q.body.bundle.id);
  assert.equal(kids.length, 3);
  assert.deepEqual(kids.map((c) => c.status), ["held", "held", "held"]);
  // Each card either swapped its own XRP first or, once a swap had refilled custody, paid from it. Either way nothing is spent twice.
  assert.ok(s.swaps().filter((x) => x.purpose === "buy_first" && x.status === "landed").length >= 2);
  assert.ok(kids.every((k) => k.funding === "swap" || k.funding === "float"));
  const toRelay = s.swaps().filter((x) => x.dir === "xrp_to_usdc").reduce((t, x) => t + BigInt(x.inAmount), 0n);
  assert.ok(toRelay <= BigInt(q.body.tx.Amount), "no more XRP went to Relay than the order brought in");
  for (const k of kids) assert.ok(BigInt(s.swaps().find((x) => x.card === k.id)?.inAmount ?? 0) <= BigInt(k.drops));
  assert.ok(s.custody.usdc >= 0n);
  await replays(s.w);
});

test("multi: switch off, a multi card order is exactly today's: float-bound, half-percent room, no quote asked", async () => {
  const s = await site({ usdc: 100_000_000n, treasuryXrp: 40, off: true, env: { ...MULTI, SEAL_MULTI_CARD_MAX: "8" } });
  assert.equal((await s.w.call("GET", "/api/rip/bundle-room?code=pokemon_25", { as: s.me })).body.max, 3);
  const q = await s.w.call("POST", "/api/rip/bundles", { as: s.me, body: { code: "pokemon_25", qty: 3, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const raw = (25_000_000n * 1_000_000n) / 1_250_000n;
  assert.equal(BigInt(Math.round(q.body.bundle.eachXrp * 1e6)), ((((raw * 10_050n) / 10_000n) + 9_999n) / 10_000n) * 10_000n);
  assert.equal(s.relay.quotes, 0);
});

test("multi: Relay down for a whole multi order, every card goes back whole, and the wallet isn't locked out for what the house couldn't do", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 400, env: { ...MULTI, SEAL_MULTI_CARD_MAX: "5" } });
  const q = await s.w.call("POST", "/api/rip/bundles", { as: s.me, body: { code: "pokemon_25", qty: 4, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  s.relay.down = true;
  s.w.ledger.userSubmit(q.body.tx);
  await s.go(4);
  s.w.state.clockMs += SWAP_GIVE_UP_MS + 1000;
  await s.go(10);
  const kids = [...s.w.engine.state.cards.values()].filter((c) => c.bundle === q.body.bundle.id);
  assert.deepEqual(kids.map((c) => c.status), ["refunded", "refunded", "refunded", "refunded"]);
  assert.equal(s.w.paidTo(PLAYER).reduce((t, x) => t + BigInt(x.delivered as string), 0n), BigInt(q.body.tx.Amount));
  assert.ok(4 > MAX_LAPSED_ORDERS);
  s.relay.down = false;
  const again = await s.w.call("POST", "/api/rip/cards", { as: s.me, body: { code: "pokemon_25" } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

/* ------------------------------------------------ round 2 ------------------------------------------------ */

test("multi on a quiet site: passes a minute apart, every card's deposit goes out on the quote it was opened with, none lapses unsent", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 400, env: { ...MULTI, SEAL_MULTI_CARD_MAX: "5" } });
  const q = await s.w.call("POST", "/api/rip/bundles", { as: s.me, body: { code: "pokemon_25", qty: 4, acceptedTerms: true } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  s.w.ledger.userSubmit(q.body.tx);
  // The cron's cadence: one pass, then a minute of nothing.
  for (let i = 0; i < 40; i++) {
    await s.w.engine.advance();
    s.relay.tick();
    s.w.ledger.close();
    s.w.state.clockMs += 61_000;
  }
  const kids = [...s.w.engine.state.cards.values()].filter((c) => c.bundle === q.body.bundle.id);
  assert.deepEqual(kids.map((c) => c.status), ["held", "held", "held", "held"]);
  assert.deepEqual(s.swaps().filter((x) => x.deadReason === "quote_stale").length, 0, "a quote opened only to lapse unsent");
  await replays(s.w);
});

test("custody low on SOL: a sale waiting on Relay doesn't ask for quotes or sign deposits over and over, and pays once SOL is back", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, insuredMicro: "90000000", pct: 85 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  s.custody.holdSale = true;
  const { quote, done } = await s.sell(id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  s.custody.sol = CUSTODY_SOL_LOW_LAMPORTS - 1n;
  s.custody.holdSale = false;
  const quotesBefore = s.relay.quotes;
  for (let i = 0; i < 6; i++) {
    await s.go(2);
    s.w.state.clockMs += 61_000;
  }
  assert.equal(s.relay.quotes, quotesBefore, "no quote while custody can't pay the fee to send");
  assert.equal(s.custody.relaySent.size, 0);
  assert.ok((await s.alerts()).includes("custody_sol"));
  s.custody.sol = 10_000_000n;
  s.w.state.clockMs += 6 * 60_000;
  await s.go(8);
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote]);
  await replays(s.w);
});

/* ------------------------------------------------ round 3 ------------------------------------------------ */

test("an idle hour with the switch on costs about what it costs off: no balance read a pass while nothing is waiting", async () => {
  const measure = async (off: boolean) => {
    const custody = fakeCustody(400_000_000n);
    let relay!: ReturnType<typeof fakeRelay>;
    const calls = { account: 0, float: 0 };
    const gateway = { ...custody.gateway, floatMicro: async () => (calls.float++, custody.c.usdc) };
    const w = await world({ cards: true, gateway, treasuryXrp: 400, wrapChain: (c) => ({ ...c, account: async (a: string) => (calls.account++, c.account(a)) }), relay: (l) => ((relay = fakeRelay(l, custody.c)), railsFor(relay.api, { enabled: !off, refillLookMs: 30_000 })) });
    const me = w.client(PLAYER);
    w.fund(me, 4000);
    const q = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } });
    w.ledger.userSubmit(q.body.tx);
    for (let i = 0; i < 6; i++) {
      await w.engine.advance();
      relay.tick();
      w.ledger.close();
    }
    calls.account = 0;
    calls.float = 0;
    const quotes = relay.quotes;
    // An hour of the cron, with one pack's XRP owed to custody and under the batch size.
    for (let i = 0; i < 60; i++) {
      await w.engine.advance();
      w.ledger.close();
      w.state.clockMs += 60_000;
    }
    return { ...calls, quotes: relay.quotes - quotes, owed: [...w.engine.state.accruals.values()].filter((a) => a.status === "owed").length };
  };
  const off = await measure(true);
  const on = await measure(false);
  assert.equal(on.owed, 1, "the case this measures: a refill waiting for a batch");
  assert.equal(on.quotes, 0);
  assert.ok(on.account <= off.account + 7, `XRPL account reads in an idle hour: ${on.account} on, ${off.account} off`);
  assert.ok(on.float <= off.float + 7, `custody balance reads in an idle hour: ${on.float} on, ${off.float} off`);
});

/* ------------------------------------------------ round 4 ------------------------------------------------ */

type OffOp = { k: "buy"; who: 0 | 1 } | { k: "bundle"; qty: number } | { k: "sell" } | { k: "close" } | { k: "clock"; ms: number } | { k: "drain" } | { k: "refuse"; on: boolean } | { k: "stray" };
const offOp: fc.Arbitrary<OffOp> = fc.oneof(
  fc.record({ k: fc.constant("buy" as const), who: fc.constantFrom(0 as const, 1 as const) }),
  fc.record({ k: fc.constant("bundle" as const), qty: fc.integer({ min: 2, max: 3 }) }),
  fc.constant({ k: "sell" as const }),
  fc.constant({ k: "sell" as const }),
  fc.constant({ k: "close" as const }),
  fc.constant({ k: "close" as const }),
  fc.constant({ k: "close" as const }),
  fc.record({ k: fc.constant("clock" as const), ms: fc.constantFrom(60_000, 11 * 60_000) }),
  fc.constant({ k: "drain" as const }),
  fc.record({ k: fc.constant("refuse" as const), on: fc.boolean() }),
  fc.constant({ k: "stray" as const }),
);

test("switch off is today's site, event for event: the same moves give the same log and the same ledger with or without the rails", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(offOp, { minLength: 6, maxLength: 24 }), fc.constantFrom(0n, 60_000_000n, 400_000_000n), async (ops, usdc) => {
      const run = async (noRelay: boolean) => {
        let n = 0;
        const custody = fakeCustody(usdc, { insuredMicro: "30000000", pct: 100 });
        let relay!: ReturnType<typeof fakeRelay>;
        const w = await world({ cards: true, gateway: custody.gateway, treasuryXrp: 60, env: { ...MULTI, SEAL_MULTI_CARD_MAX: "3" }, engineExtra: { newId: () => `id${String(++n).padStart(6, "0")}` }, relay: (l) => ((relay = fakeRelay(l, custody.c)), noRelay ? (undefined as unknown as RelayRails) : railsFor(relay.api, { enabled: false })) });
        await w.engine.advance();
        const players = [w.client(PLAYER), w.client(OTHER)];
        for (const p of players) w.fund(p, 4000);
        for (const op of ops) {
          if (op.k === "buy") {
            const q = await w.call("POST", "/api/rip/cards", { as: players[op.who], body: { code: "pokemon_25" } });
            if (q.status === 200) w.ledger.userSubmit(q.body.tx);
          } else if (op.k === "bundle") {
            const q = await w.call("POST", "/api/rip/bundles", { as: players[0], body: { code: "pokemon_25", qty: op.qty, acceptedTerms: true } });
            if (q.status === 200 && q.body.tx) w.ledger.userSubmit(q.body.tx);
          } else if (op.k === "sell") {
            const c = [...w.engine.state.cards.values()].find((x) => x.hold === "stashed");
            const who = players.find((p) => p.address === c?.address);
            if (c && who) {
              const q = await w.call("POST", `/api/rip/cards/${c.id}/sell`, { as: who });
              if (q.status === 200) await w.call("POST", `/api/rip/cards/${c.id}/sell`, { as: who, body: { drops: q.body.drops } });
            }
          } else if (op.k === "close") {
            w.ledger.close();
            await w.engine.advance();
          } else if (op.k === "clock") w.state.clockMs += op.ms;
          else if (op.k === "drain") w.ledger.setBalance(TREASURY, 12);
          else if (op.k === "refuse") custody.c.refuseGenerate = op.on;
          else if (op.k === "stray") relay.payXrp(`0x${"ab".repeat(32)}`, 3_000_000n);
        }
        for (let i = 0; i < 4; i++) {
          w.ledger.close();
          await w.engine.advance();
        }
        // Whatever is still waiting has waited long enough to raise its alert.
        w.state.clockMs += 11 * 60_000;
        const events = (await w.store.readFrom(0)).map((e) => JSON.stringify([e.type, e.data]));
        const txs = w.ledger.history.map((t) => JSON.stringify([t.tx.Account, t.tx.Destination, t.tx.Amount, t.result]));
        return { events, txs, alerts: (await w.engine.opsAlerts()).map((a) => a.code).sort(), quotes: relay.quotes };
      };
      const today = await run(true);
      const off = await run(false);
      assert.equal(off.quotes, 0);
      assert.deepEqual(off.events, today.events);
      assert.deepEqual(off.txs, today.txs);
      assert.deepEqual(off.alerts, today.alerts);
    }),
    { numRuns: 40, seed: 20261103 },
  );
});
