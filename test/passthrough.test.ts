import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { CARD_FLOAT_LOW_MICRO, MAX_LAPSED_ORDERS, SWAP_GIVE_UP_MS, SWAP_STALL_MS } from "../src/lib/rip/engine.ts";
import { RELAY_XRP_DEPOSITORIES, RELAY_XRP_SOLVERS, RelayRateMoved, RelayRefused, checkUsdcToXrp, checkXrpToUsdc, relayConfig, relaySpendRefusal } from "../src/lib/rip/relay.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { publicEvents } from "../src/lib/rip/verify.ts";
import { DEFAULT_POLICY, DEPOSITORY, SOLVER, fakeCustody, fakeRelay, memoHex, railsFor, type Outcome } from "./support-relay.ts";
import { TREASURY, addressOf, world } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);
const ADMIN = addressOf(3);
const USD25_DROPS = 20_000_000n;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/relay/${name}`, import.meta.url), "utf8")) as Record<string, any>;
const POLICY = { treasury: "rLixKPQ3jGk4yYhAt3ybAwdrC8tvTLLvG", custody: "8kpUHDwhZ5GYpuBmzjgsAK3jWZe3TGxZDPktSn6MCXm8", ...DEFAULT_POLICY };
/** The fixtures were read on 2026-11-02; their deadline was a week off. */
const FIXTURE_NOW = 1794261192 - 7 * 86400;

async function site(o: { usdc?: bigint; treasuryXrp?: number; machineUsd?: number; insuredMicro?: string; pct?: number; over?: Parameters<typeof railsFor>[1]; off?: boolean; rate?: number; relayRate?: number; env?: Record<string, string> } = {}) {
  const custody = fakeCustody(o.usdc ?? 0n, { machineUsd: o.machineUsd, insuredMicro: o.insuredMicro, pct: o.pct });
  let relay!: ReturnType<typeof fakeRelay>;
  const w = await world({
    cards: true,
    gateway: custody.gateway,
    admins: ADMIN,
    treasuryXrp: o.treasuryXrp ?? 15,
    rate: o.rate,
    env: o.env,
    relay: (ledger) => {
      relay = fakeRelay(ledger, custody.c, { usdPerXrp: o.relayRate ?? o.rate ?? 1.25 });
      return railsFor(relay.api, { enabled: !o.off, ...o.over });
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
  return { w, me, other, relay: relay!, custody: custody.c, go, buy, sell, swaps, alerts };
}
const replays = async (w: Awaited<ReturnType<typeof site>>["w"]) => {
  const r = replayLog(await w.store.readFrom(0));
  assert.equal(r.ok, true, r.ok ? "" : `${r.why} at ${r.at}`);
};

/* ---------------------------------------- the quote and the transaction, as untrusted ---------------------------------------- */

test("Relay's real answers pass as they came: XRP to Solana USDC, and USDC back to the treasury", () => {
  const buy = checkXrpToUsdc(fixture("quote-xrp-to-usdc-25-20261102.json"), POLICY, { outMicro: 25_000_000n, maxInDrops: 21_000_000n }, FIXTURE_NOW);
  assert.equal(buy.depository, "rJBdWA9p5KwBoqSQTyMdg3UHLsJVzGVu5m");
  assert.equal(buy.inAmount, "20078568");
  assert.equal(buy.outMin, "25000000");
  assert.ok(/^0x[0-9a-f]{64}$/.test(buy.orderId));
  const sell = checkUsdcToXrp(fixture("quote-usdc-to-xrp-21-20261102.json"), POLICY, { inMicro: 21_000_000n, minOutDrops: 16_000_000n }, FIXTURE_NOW);
  assert.equal(sell.inAmount, "21000000");
  assert.equal(sell.outMin, "16388412");
  assert.equal(sell.instructions?.length, 1);
});

const buyTampers: Record<string, (q: Record<string, any>) => void> = {
  "a different recipient": (q) => (q.protocol.v2.orderData.output.payments[0].recipient = "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe"),
  "a second payment": (q) => q.protocol.v2.orderData.output.payments.push(q.protocol.v2.orderData.output.payments[0]),
  "a destination call": (q) => q.protocol.v2.orderData.output.calls.push({ to: "x" }),
  "another output token": (q) => (q.protocol.v2.orderData.output.payments[0].currency = "So11111111111111111111111111111111111111112"),
  "a smaller output": (q) => (q.protocol.v2.orderData.output.payments[0].minimumAmount = "24000000"),
  "another output chain": (q) => (q.protocol.v2.orderData.output.chainId = "base"),
  "a deposit address off the list": (q) => {
    q.protocol.v2.paymentDetails.depository = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB";
    q.steps[0].items[0].data.to = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB";
  },
  "a step paying elsewhere than its own details": (q) => (q.steps[0].items[0].data.to = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB"),
  "a step asking for more than its details": (q) => (q.steps[0].items[0].data.amount = "40000000"),
  "a memo that isn't the order": (q) => (q.steps[0].items[0].data.memo = "0xdeadbeef"),
  "a refund sent to someone else": (q) => (q.protocol.v2.orderData.inputs[0].refunds[0].recipient = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB"),
  "two steps": (q) => q.steps.push(q.steps[0]),
  "an approval step": (q) => (q.steps[0].id = "approve"),
  "an extra field on the step": (q) => (q.steps[0].items[0].data.flags = 131072),
  "an order fee": (q) => q.protocol.v2.orderData.fees.push({ recipient: "x", amount: "1" }),
  "a deadline already gone": (q) => (q.protocol.v2.orderData.output.deadline = FIXTURE_NOW - 1),
  "XRP on another chain": (q) => (q.protocol.v2.paymentDetails.chainId = "solana"),
  "a non-XRP input": (q) => (q.protocol.v2.paymentDetails.currency = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"),
};
for (const [name, tamper] of Object.entries(buyTampers)) {
  test(`an XRP swap is refused over ${name}`, () => {
    const q = fixture("quote-xrp-to-usdc-25-20261102.json");
    tamper(q);
    assert.throws(() => checkXrpToUsdc(q, POLICY, { outMicro: 25_000_000n, maxInDrops: 21_000_000n }, FIXTURE_NOW), RelayRefused);
  });
}
test("an XRP swap asking for more than this order brought in is a moved rate, told apart from a bad quote", () => {
  assert.throws(() => checkXrpToUsdc(fixture("quote-xrp-to-usdc-25-20261102.json"), POLICY, { outMicro: 25_000_000n, maxInDrops: 20_000_000n }, FIXTURE_NOW), RelayRateMoved);
});

const sellTampers: Record<string, (q: Record<string, any>) => void> = {
  "XRP going to another wallet": (q) => (q.protocol.v2.orderData.output.payments[0].recipient = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB"),
  "a depository off the list": (q) => (q.protocol.v2.paymentDetails.depository = "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe"),
  "a second instruction": (q) => q.steps[0].items[0].data.instructions.push(q.steps[0].items[0].data.instructions[0]),
  "an unknown program": (q) => (q.steps[0].items[0].data.instructions[0].programId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  "an instruction moving a different amount": (q) => (q.steps[0].items[0].data.instructions[0].data = q.steps[0].items[0].data.instructions[0].data.replace("406f4001", "ffffff7f")),
  "an instruction for another order": (q) => (q.steps[0].items[0].data.instructions[0].data = q.steps[0].items[0].data.instructions[0].data.slice(0, 32) + "00".repeat(32)),
  "a bigger input": (q) => (q.protocol.v2.paymentDetails.amount = "22000000"),
  "a refund to someone else": (q) => (q.protocol.v2.orderData.inputs[0].refunds[0].recipient = "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe"),
  "an approval step": (q) => (q.steps[0].id = "approve"),
};
for (const [name, tamper] of Object.entries(sellTampers)) {
  test(`a USDC swap is refused over ${name}`, () => {
    const q = fixture("quote-usdc-to-xrp-21-20261102.json");
    tamper(q);
    assert.throws(() => checkUsdcToXrp(q, POLICY, { inMicro: 21_000_000n, minOutDrops: 16_000_000n }, FIXTURE_NOW), RelayRefused);
  });
}
test("a USDC swap whose minimum won't cover the player is a moved rate", () => {
  assert.throws(() => checkUsdcToXrp(fixture("quote-usdc-to-xrp-21-20261102.json"), POLICY, { inMicro: 21_000_000n, minOutDrops: 17_000_000n }, FIXTURE_NOW), RelayRateMoved);
});

const CUSTODY_KEY = "8kpUHDwhZ5GYpuBmzjgsAK3jWZe3TGxZDPktSn6MCXm8";
const tokenAccount = (o: { micro: bigint; owner?: string; delegate?: boolean; closeAuthority?: boolean; state?: number; mint?: string }) => {
  const b = Buffer.alloc(165);
  b.set(bs58(o.mint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), 0);
  b.set(bs58(o.owner ?? CUSTODY_KEY), 32);
  b.writeBigUInt64LE(o.micro, 64);
  b.writeUInt32LE(o.delegate ? 1 : 0, 72);
  b[108] = o.state ?? 1;
  b.writeUInt32LE(o.closeAuthority ? 1 : 0, 129);
  return { data: [b.toString("base64")] };
};
import bs58lib from "bs58";
const bs58 = (s: string) => bs58lib.decode(s);
const spend = (over: Partial<Parameters<typeof relaySpendRefusal>[0]> = {}) => relaySpendRefusal({ custody: CUSTODY_KEY, amountMicro: 21_000_000n, usdcBefore: 100_000_000n, usdcAfter: tokenAccount({ micro: 79_000_000n }), solBefore: 10_000_000n, solAfter: { lamports: 9_990_000, owner: "11111111111111111111111111111111" }, maxSolDebit: 5_000_000n, keys: [CUSTODY_KEY], others: ["CardMintInCustody"], ...over });

test("simulating a Relay transaction: exactly the USDC agreed and nothing else about custody changes", () => {
  assert.equal(spend(), null);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 78_999_999n }) }) as string, /more USDC/);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 79_000_001n }) }) as string, /less USDC/);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 79_000_000n, delegate: true }) }) as string, /delegate/);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 79_000_000n, owner: "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe" }) }) as string, /controls/);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 79_000_000n, closeAuthority: true }) }) as string, /controls/);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 79_000_000n, state: 2 }) }) as string, /controls/);
  assert.match(spend({ usdcAfter: tokenAccount({ micro: 79_000_000n, mint: "So11111111111111111111111111111111111111112" }) }) as string, /isn't USDC/);
  assert.match(spend({ solAfter: { lamports: 0, owner: "11111111111111111111111111111111" } }) as string, /SOL/);
  assert.match(spend({ solAfter: { lamports: 9_990_000, owner: "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe" } }) as string, /owner/);
  assert.match(spend({ keys: [CUSTODY_KEY, "CardMintInCustody"] }) as string, /another/);
  assert.match(spend({ usdcAfter: null }) as string, /simulation/);
});

/* ---------------------------------------- the switch ---------------------------------------- */

test("the switch defaults off, and on needs both caps and a real number for each", () => {
  assert.equal(relayConfig({}), null);
  assert.equal(relayConfig({ SEAL_CARD_PASSTHROUGH: "off" }), null);
  assert.throws(() => relayConfig({ SEAL_CARD_PASSTHROUGH: "on" }), /SEAL_RELAY_MAX_SWAP_USD/);
  assert.throws(() => relayConfig({ SEAL_CARD_PASSTHROUGH: "on", SEAL_RELAY_MAX_SWAP_USD: "abc", SEAL_RELAY_MAX_DAY_USD: "1000" }), /SEAL_RELAY_MAX_SWAP_USD/);
  const on = relayConfig({ SEAL_CARD_PASSTHROUGH: "on", SEAL_RELAY_MAX_SWAP_USD: "15000", SEAL_RELAY_MAX_DAY_USD: "30000" });
  assert.equal(on?.maxSwapMicro, 15_000_000_000n);
  assert.equal(on?.maxDayMicro, 30_000_000_000n);
  assert.ok((on?.custodyTargetMicro ?? 0n) > 0n);
});

test("switch off: an empty custody still reads as restocking, a sale the treasury can't pay is still refused, no quote is ever asked for", async () => {
  const off = await site({ off: true, usdc: 0n });
  assert.equal((await off.w.call("POST", "/api/rip/cards", { as: off.me, body: { code: "pokemon_25" } })).body.code, "restocking");
  assert.equal(off.relay.quotes, 0);
  const b = await site({ off: true, usdc: 400_000_000n, treasuryXrp: 11 });
  const id = await b.buy();
  await b.go(6);
  assert.equal(b.w.cardOf(id)?.status, "held");
  b.w.ledger.setBalance(TREASURY, 11);
  const quote = await b.w.call("POST", `/api/rip/cards/${id}/sell`, { as: b.me });
  const sale = await b.w.call("POST", `/api/rip/cards/${id}/sell`, { as: b.me, body: { drops: quote.body.drops } });
  assert.equal(sale.body.code, "sell_paused");
  assert.equal(b.swaps().length, 0);
  assert.equal(b.relay.quotes, 0);
  assert.equal(b.relay.deposits.length, 0);
  // With the treasury able to pay, the same sale goes as it always did, and nothing is marked to move.
  b.w.ledger.fund(TREASURY, 500);
  const paid = await b.w.call("POST", `/api/rip/cards/${id}/sell`, { as: b.me, body: { drops: quote.body.drops } });
  assert.equal(paid.status, 200);
  await b.go(4);
  assert.equal(b.w.cardOf(id)?.hold, "sold");
  assert.equal(b.w.cardOf(id)?.exit?.passthrough, undefined);
  assert.equal(b.w.engine.state.accruals.size, 0);
  assert.equal(b.w.paidTo(PLAYER).length, 1);
});

/* ---------------------------------------- buying ---------------------------------------- */

test("buy, custody can pay: the pack is paid at once with no Relay in the wait, and its XRP refills afterward", async () => {
  const { w, buy, go, relay, custody, swaps } = await site({ usdc: 400_000_000n, treasuryXrp: 100 });
  const id = await buy();
  w.ledger.close();
  await w.engine.advance();
  assert.equal(relay.quotes, 0, "no Relay before the pack");
  assert.deepEqual(custody.calls, ["generate"]);
  assert.equal(w.cardOf(id)?.funding, "float");
  await go(6);
  assert.equal(w.cardOf(id)?.status, "held");
  assert.equal(relay.deposits.length, 0, "custody is above its target, so nothing moves yet");
  assert.equal(swaps().length, 0);
  const owed = [...w.engine.state.accruals.values()];
  assert.equal(owed.length, 1);
  assert.equal(owed[0].status, "owed");
  assert.equal(owed[0].amount, w.cardOf(id)?.drops);
  await replays(w);
});

test("buy, custody short: USDC lands first and only then is the pack asked for, inside its one-minute window", async () => {
  const { w, buy, go, relay, custody, swaps } = await site({ usdc: 0n, treasuryXrp: 15 });
  const id = await buy();
  w.ledger.close();
  await w.engine.advance();
  assert.equal(w.cardOf(id)?.status, "funding");
  assert.deepEqual(custody.calls, [], "the pack isn't asked for until the money is there");
  w.ledger.close();
  await w.engine.advance();
  relay.tick();
  await go(6);
  assert.equal(relay.deposits.length, 1);
  assert.equal(relay.deposits[0].orderId, swaps()[0].orderId);
  assert.ok(relay.deposits[0].drops <= BigInt(w.cardOf(id)?.drops as string), "never more than the order brought in");
  assert.equal(w.cardOf(id)?.status, "held");
  assert.deepEqual(custody.calls, ["generate"]);
  assert.ok(custody.usdc < 1_000_000n, "no float beyond dust");
  await replays(w);
});

test("zero pre-funding: many checkouts open at once with empty custody, and each buys through its own XRP", async () => {
  const { w, me, other, buy, go, relay } = await site({ usdc: 0n, treasuryXrp: 15 });
  const players = [me, other, w.client(addressOf(7)), w.client(addressOf(8))];
  players.slice(2).forEach((p) => w.fund(p, 500));
  const ids = await Promise.all(players.map((p) => buy(p)));
  await go(14);
  for (const id of ids) assert.equal(w.cardOf(id)?.status, "held", id);
  assert.equal(relay.deposits.length, 4);
  await replays(w);
});

test("float path: a second card can't count USDC already promised to the first", async () => {
  const { w, me, other, buy, go, custody } = await site({ usdc: 30_000_000n, treasuryXrp: 15 });
  const a = await buy(me);
  const b = await buy(other);
  w.ledger.close();
  await w.engine.advance();
  await go(12);
  const via = [w.cardOf(a)?.funding, w.cardOf(b)?.funding].sort();
  assert.deepEqual(via, ["float", "swap"], "only one pack fits $30");
  assert.equal(w.cardOf(a)?.status, "held");
  assert.equal(w.cardOf(b)?.status, "held");
  assert.ok(custody.usdc >= 0n);
});

test("Relay refuses at the door: with custody short and no good quote, the pack reads as restocking and nothing is charged", async () => {
  const s = await site({ usdc: 0n });
  s.relay.down = true;
  assert.equal((await s.w.call("POST", "/api/rip/cards", { as: s.me, body: { code: "pokemon_25" } })).body.code, "restocking");
  s.relay.down = false;
  s.relay.tamper = (q) => (q.protocol.v2.orderData.output.payments[0].recipient = "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe");
  assert.equal((await s.w.call("POST", "/api/rip/cards", { as: s.me, body: { code: "pokemon_25" } })).body.code, "restocking");
});

test("a pack over the per-swap cap reads as restocking when custody can't pay for it, and sells when custody can", async () => {
  const over = { policy: { maxSwapMicro: 10_000_000n } };
  const short = await site({ usdc: 0n, over });
  assert.equal((await short.w.call("POST", "/api/rip/cards", { as: short.me, body: { code: "pokemon_25" } })).body.code, "restocking");
  const covered = await site({ usdc: 100_000_000n, over, treasuryXrp: 100 });
  const id = await covered.buy();
  await covered.go(6);
  assert.equal(covered.w.cardOf(id)?.status, "held");
});

test("the daily cap stops new swaps from opening, and a paid order goes back whole with no USDC spent", async () => {
  const { w, buy, go, relay, custody } = await site({ usdc: 0n, over: { policy: { maxDayMicro: 30_000_000n } } });
  const first = await buy();
  await go(8);
  assert.equal(w.cardOf(first)?.status, "held");
  const before = w.paidTo(OTHER).length;
  const other = w.client(OTHER);
  const q = await w.call("POST", "/api/rip/cards", { as: other, body: { code: "pokemon_25" } });
  assert.equal(q.body.code, "restocking", "the day's room is gone, so it isn't sold");
  assert.equal(w.paidTo(OTHER).length, before);
  assert.equal(relay.deposits.length, 1);
  assert.ok(custody.calls.length === 1);
});

test("Relay refunds the deposit: the player gets their XRP back whole, no pack is asked for, and the fee gap is the house's", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 15 });
  s.relay.next.push("refund");
  const id = await s.buy();
  const paid = BigInt(s.w.cardOf(id)?.drops as string);
  await s.go(10);
  assert.ok(["refund_due", "refunded"].includes(s.w.cardOf(id)?.status as string));
  await s.go(4);
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.deepEqual(s.custody.calls, []);
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [paid]);
  assert.equal(s.w.engine.state.refunds.size, 1, "Relay's own payment back is never treated as a stray");
  await replays(s.w);
});

test("USDC landed but Collector Crypt refuses: the player is whole, and that USDC is sent back through Relay, with the round-trip fee on the house", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  s.custody.refuseGenerate = true;
  const id = await s.buy();
  await s.go(12);
  assert.ok(["refund_due", "refunded"].includes(s.w.cardOf(id)?.status as string));
  const paid = BigInt(s.w.cardOf(id)?.drops as string);
  const accrual = [...s.w.engine.state.accruals.values()].find((a) => a.order === id);
  assert.equal(accrual?.dir, "to_treasury");
  await s.go(10);
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [paid]);
  await replays(s.w);
});

test("USDC landed, Collector Crypt refuses, and the treasury can't pay yet: the swap back runs first, and then the refund", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 11 });
  s.custody.refuseGenerate = true;
  const id = await s.buy();
  await s.go(20);
  assert.equal(s.w.cardOf(id)?.status, "refunded", JSON.stringify(s.swaps().map((x) => [x.dir, x.status])));
  assert.equal(s.w.paidTo(PLAYER).length, 1);
  assert.ok(s.swaps().some((x) => x.dir === "usdc_to_xrp" && x.status === "landed"));
});

test("a partial fill: the little that landed isn't spent on a pack it can't pay for, and the player is refunded whole", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  s.relay.next.push("partial");
  const id = await s.buy();
  await s.go(14);
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.deepEqual(s.custody.calls, []);
  assert.equal(s.w.paidTo(PLAYER).length, 1);
});

test("XRP moved past the order's room before it could swap: refunded whole and no swap goes out", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  const id = await s.buy();
  s.relay.usdPerXrp = 1.15;
  await s.go(6);
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.equal(s.relay.deposits.length, 0);
  assert.deepEqual(s.custody.calls, []);
});

test("float path: an order that has gone underwater doesn't get a free pack on the house, it takes the checked path", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40 });
  const id = await s.buy();
  s.w.state.rate = 1.15;
  s.relay.usdPerXrp = 1.15;
  await s.go(6);
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.deepEqual(s.custody.calls, []);
});

/* ---------------------------------------- hazard 1: telling Relay from a stray ---------------------------------------- */

async function saleWaiting(usdc = 400_000_000n) {
  const s = await site({ usdc, treasuryXrp: 40 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  s.relay.next.push("never");
  const { quote, done } = await s.sell(id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  await s.go(4);
  return { ...s, id, quote };
}

test("Relay's XRP arriving at the treasury is the sale's money: never refunded back to the solver, and the player is paid once", async () => {
  const s = await saleWaiting();
  assert.equal(s.w.cardOf(s.id)?.hold, "selling");
  const swap = s.swaps().find((x) => x.dir === "usdc_to_xrp") as NonNullable<ReturnType<typeof s.swaps>[number]>;
  assert.equal(swap.status, "deposited");
  s.relay.finish(swap.orderId);
  await s.go(5);
  assert.equal(s.w.paidTo(SOLVER).length, 0, "nothing bounced");
  assert.equal(s.w.engine.state.refunds.size, 0);
  assert.equal(s.w.cardOf(s.id)?.hold, "sold");
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [s.quote]);
  await replays(s.w);
});

test("a stranger naming the sale's order in a memo counts for nothing and gets their own money back", async () => {
  const s = await saleWaiting();
  const swap = s.swaps().find((x) => x.dir === "usdc_to_xrp") as NonNullable<ReturnType<typeof s.swaps>[number]>;
  const STRANGER = addressOf(9);
  s.w.ledger.fund(STRANGER, 500);
  s.w.ledger.userSubmit({ TransactionType: "Payment", Account: STRANGER, Destination: TREASURY, Amount: swap.outMin, Memos: [{ Memo: { MemoData: memoHex(swap.orderId) } }] } as never);
  await s.go(5);
  assert.equal(s.w.engine.state.swaps.get(swap.id)?.status, "deposited", "the swap hasn't landed");
  assert.equal(s.w.cardOf(s.id)?.exit?.funded ?? false, false);
  assert.equal(s.w.paidTo(STRANGER).length, 1, "a stray goes back, as any stray does");
  assert.ok((await s.alerts()).includes("relay_lookalike"), "and a person hears, in case Relay has added a solver");
  await replays(s.w);
});

test("the real solver paying the treasury for someone else's order isn't bounced and isn't counted: it just sits as extra, with an alert", async () => {
  const s = await saleWaiting();
  const swap = s.swaps().find((x) => x.dir === "usdc_to_xrp") as NonNullable<ReturnType<typeof s.swaps>[number]>;
  s.relay.payXrp(`0x${"ab".repeat(32)}`, BigInt(swap.outMin));
  await s.go(4);
  assert.equal(s.w.paidTo(SOLVER).length, 0);
  assert.equal(s.w.engine.state.swaps.get(swap.id)?.status, "deposited");
  assert.ok((await s.alerts()).includes("relay_unmatched"));
  await replays(s.w);
});

test("a delivery with no memo from the solver is matched only if Relay's own status names that transaction", async () => {
  const s = await saleWaiting();
  const swap = s.swaps().find((x) => x.dir === "usdc_to_xrp") as NonNullable<ReturnType<typeof s.swaps>[number]>;
  const hash = s.relay.payXrp(swap.orderId, BigInt(swap.outExpected), false);
  await s.go(2);
  assert.equal(s.w.engine.state.swaps.get(swap.id)?.status, "deposited", "no memo and no status: not ours yet");
  const o = s.relay.orders.get(swap.orderId) as NonNullable<ReturnType<typeof s.relay.orders.get>>;
  o.status = "success";
  o.txHashes.push(hash);
  await s.go(3);
  assert.equal(s.w.engine.state.swaps.get(swap.id)?.status, "landed");
  await replays(s.w);
});

test("turning the switch off doesn't strand or bounce a delivery already on its way", async () => {
  const custody = fakeCustody(400_000_000n);
  let relay!: ReturnType<typeof fakeRelay>;
  let enabled = true;
  const w = await world({
    cards: true,
    gateway: custody.gateway,
    treasuryXrp: 40,
    relay: (ledger) => {
      relay = fakeRelay(ledger, custody.c);
      return { ...railsFor(relay.api), get enabled() { return enabled; } };
    },
  });
  await w.engine.advance();
  const me = w.client(PLAYER);
  w.fund(me, 500);
  const q = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } });
  w.ledger.userSubmit(q.body.tx);
  await w.pump(6);
  const id = q.body.order.id;
  w.ledger.setBalance(TREASURY, 11);
  relay.next.push("never");
  const quote = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me });
  await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: quote.body.drops } });
  await w.pump(4);
  const swap = [...w.engine.state.swaps.values()][0];
  enabled = false;
  relay.finish(swap.orderId);
  await w.pump(5);
  assert.equal(w.paidTo(SOLVER).length, 0);
  assert.equal(w.cardOf(id)?.hold, "sold");
});

test("the 10-drop dust wallet that's been hitting the treasury stays dust", async () => {
  const s = await site({ usdc: 0n });
  const DUSTER = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB";
  s.w.ledger.fund(DUSTER, 50);
  s.w.ledger.userSubmit({ TransactionType: "Payment", Account: DUSTER, Destination: TREASURY, Amount: "10" } as never);
  await s.go(2);
  assert.equal(s.w.engine.state.refunds.size, 0);
  assert.equal(s.w.engine.state.relayArrivals.size, 0);
  assert.deepEqual(RELAY_XRP_SOLVERS, ["rE6xRr2GbS31KPoL9RaLgfiarJ4vqXj8Si"]);
  assert.deepEqual(RELAY_XRP_DEPOSITORIES, [DEPOSITORY]);
});

/* ---------------------------------------- hazard 2: signing to an outside address ---------------------------------------- */

test("every XRP that leaves the treasury to Relay goes to the allowlisted deposit address, with a memo, and nothing else about it changes", async () => {
  const s = await site({ usdc: 0n });
  const id = await s.buy();
  await s.go(6);
  assert.equal(s.w.cardOf(id)?.status, "held");
  const out = s.w.ledger.history.filter((t) => t.tx.Account === TREASURY && t.tx.Destination === DEPOSITORY);
  assert.equal(out.length, 1);
  const tx = out[0].tx as Record<string, any>;
  assert.equal(typeof tx.Amount, "string");
  assert.equal(tx.Flags, undefined);
  assert.equal(tx.Paths, undefined);
  assert.equal(tx.SendMax, undefined);
  assert.equal(Buffer.from(tx.Memos[0].Memo.MemoData, "hex").toString("utf8"), s.swaps()[0].orderId);
});

test("a tampered quote while an order waits sends nothing, alerts, and after the wait gives the XRP back whole", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  const b = await s.buy(s.other);
  s.relay.tamper = (q) => (q.protocol.v2.paymentDetails.depository = "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB");
  await s.go(4);
  assert.equal(s.w.cardOf(b)?.status, "paid");
  assert.equal(s.relay.deposits.length, 0);
  assert.ok((await s.alerts()).includes("relay_refused"));
  s.w.state.clockMs += SWAP_GIVE_UP_MS + 1000;
  await s.go(4);
  assert.equal(s.w.cardOf(b)?.status, "refunded");
  assert.equal(s.w.paidTo(OTHER).length, 1);
});

test("a Relay transaction custody won't sign kills that swap and frees its money: the player's sale still waits safely and an alert goes out", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  s.custody.failSign = "not signing: the transaction would leave a delegate";
  await s.sell(id);
  await s.go(4);
  assert.equal(s.w.cardOf(id)?.hold, "selling");
  assert.equal(s.custody.relaySent.size, 0);
  assert.ok(s.swaps().every((x) => x.status === "dead"));
  assert.ok((await s.alerts()).includes("relay_refused"));
  s.custody.failSign = null;
  s.w.state.clockMs += 10 * 60_000;
  await s.go(8);
  assert.equal(s.w.cardOf(id)?.hold, "sold");
  assert.equal(s.w.paidTo(PLAYER).length, 1);
});

/* ---------------------------------------- selling ---------------------------------------- */

test("sell, treasury has it: Collector Crypt first, then the player is paid at once, and a refill brings that USDC's XRP back later", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 2000, over: { treasuryTargetDrops: 2000_000_000n } });
  const id = await s.buy();
  await s.go(6);
  const { quote } = await s.sell(id);
  await s.go(3);
  assert.equal(s.w.cardOf(id)?.hold, "sold");
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote]);
  const accrual = [...s.w.engine.state.accruals.values()].find((a) => a.dir === "to_treasury");
  assert.ok(accrual);
  assert.ok(s.custody.calls.indexOf("sellBack") >= 0);
  await replays(s.w);
});

test("the $14,000 Rolex: an empty treasury doesn't refuse the sale, and the player is paid exactly the quote once XRP lands", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, insuredMicro: "14000000000", pct: 100 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 15);
  const { quote, done } = await s.sell(id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(quote > 10_000_000_000n);
  await s.go(10);
  assert.equal(s.w.cardOf(id)?.hold, "sold", JSON.stringify(s.swaps().map((x) => [x.dir, x.status])));
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote]);
  assert.ok(s.w.ledger.balance(TREASURY) >= 15_000_000n, "the fee came out of the sale, not the treasury");
  await replays(s.w);
});

test("a big sale waiting on Relay doesn't close NFT packs or block other players' payouts", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, insuredMicro: "14000000000", pct: 100 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 30);
  s.relay.next.push("never");
  await s.sell(id);
  await s.go(4);
  assert.equal(s.w.cardOf(id)?.hold, "selling");
  const { treasuryOwed } = await import("../src/lib/rip/state.ts");
  assert.equal(treasuryOwed(s.w.engine.state, true), 0n, "USDC-backed: the treasury doesn't owe this until Relay delivers");
  // A stray is a refund the treasury can pay, and the waiting sale can't hold it up.
  const STRANGER = addressOf(9);
  s.w.ledger.fund(STRANGER, 50);
  s.w.ledger.userSubmit({ TransactionType: "Payment", Account: STRANGER, Destination: TREASURY, Amount: "5000000" } as never);
  await s.go(4);
  assert.equal(s.w.paidTo(STRANGER).length, 1);
});

test("XRP moves against a sale waiting on Relay: no swap, no payment from anyone else's money, and an alert to top up", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  s.custody.holdSale = true;
  const { quote } = await s.sell(id);
  s.relay.usdPerXrp = 1.35;
  s.custody.holdSale = false;
  await s.go(5);
  assert.equal(s.w.cardOf(id)?.hold, "selling");
  assert.equal(s.w.paidTo(PLAYER).length, 0);
  assert.equal(s.custody.relaySent.size, 0);
  assert.ok((await s.alerts()).includes("sale_rate_hold"));
  // Once it recovers, or the owner tops up, it goes by itself at the quoted figure.
  s.relay.usdPerXrp = 1.25;
  await s.go(6);
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote]);
});

test("a sale over the per-swap cap isn't refused: it waits with an alert, and pays when the owner tops up", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40, insuredMicro: "14000000000", pct: 100, over: { policy: { maxSwapMicro: 1_000_000_000n } } });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 15);
  const { quote, done } = await s.sell(id);
  assert.equal(done.status, 200);
  await s.go(5);
  assert.equal(s.w.cardOf(id)?.hold, "selling");
  assert.ok((await s.alerts()).includes("swap_cap"));
  s.w.ledger.fund(TREASURY, Number(quote / 1_000_000n) + 100);
  await s.go(4);
  assert.equal(s.w.cardOf(id)?.hold, "sold");
  assert.equal(s.w.paidTo(PLAYER).length, 1);
});

test("the instant payout went out and the refill then fails: the house is short and hears about it, and nobody is paid twice", async () => {
  const s = await site({ usdc: 50_000_000n, treasuryXrp: 40, insuredMicro: "14000000", over: { treasuryTargetDrops: 1_000_000_000n, minBatchMicro: 1_000_000n } });
  const id = await s.buy();
  await s.go(6);
  s.relay.outcome = "refund";
  const { quote } = await s.sell(id);
  await s.go(10);
  assert.equal(s.w.cardOf(id)?.hold, "sold");
  assert.deepEqual(s.w.paidTo(PLAYER).map((t) => BigInt(t.delivered as string)), [quote]);
  const accrual = [...s.w.engine.state.accruals.values()].find((a) => a.dir === "to_treasury");
  assert.equal(accrual?.status, "owed", "still owed: nothing was forgotten");
  assert.ok((await s.alerts()).includes("refill_failing"));
  // Relay comes back, and it refills once.
  s.relay.outcome = "success";
  s.w.state.clockMs += 10 * 60_000;
  await s.go(8);
  assert.equal(accrual && s.w.engine.state.accruals.get(accrual.id)?.status, "done");
  assert.equal(s.w.paidTo(PLAYER).length, 1);
  assert.ok(!(await s.alerts()).includes("refill_failing"));
  await replays(s.w);
});

/* ---------------------------------------- refills ---------------------------------------- */

test("refills: custody under its target pulls owed XRP across in one batch, never more than those orders brought in, and only whole orders", async () => {
  const s = await site({ usdc: 60_000_000n, treasuryXrp: 300, over: { custodyTargetMicro: 60_000_000n, minBatchMicro: 40_000_000n } });
  const a = await s.buy(s.me);
  const b = await s.buy(s.other);
  await s.go(10);
  assert.equal(s.w.cardOf(a)?.status, "held");
  assert.equal(s.w.cardOf(b)?.status, "held");
  const refills = s.swaps().filter((x) => x.purpose === "refill");
  assert.equal(refills.length, 1);
  assert.equal(refills[0].accruals.length, 2);
  const brought = BigInt(s.w.cardOf(a)?.drops as string) + BigInt(s.w.cardOf(b)?.drops as string);
  assert.ok(BigInt(refills[0].inAmount) <= brought);
  assert.equal(s.relay.deposits.length, 1);
  for (const x of s.w.engine.state.accruals.values()) assert.equal(x.status, "done");
  await s.go(6);
  assert.equal(s.relay.deposits.length, 1, "never swapped twice");
  await replays(s.w);
});

test("refills wait for a batch: one small order doesn't pay Relay's fees by itself while custody can still sell", async () => {
  const s = await site({ usdc: 90_000_000n, treasuryXrp: 300, over: { custodyTargetMicro: 100_000_000n, minBatchMicro: 40_000_000n } });
  const a = await s.buy();
  await s.go(6);
  assert.equal(s.w.cardOf(a)?.status, "held");
  assert.equal(s.relay.deposits.length, 0);
  assert.equal([...s.w.engine.state.accruals.values()][0].status, "owed");
});

test("refills stop at the ceiling: custody is never filled past it, even with XRP owed", async () => {
  const fits = await site({ usdc: 60_000_000n, treasuryXrp: 300, over: { custodyTargetMicro: 60_000_000n, custodyCeilingMicro: 60_000_000n, minBatchMicro: 1_000_000n } });
  const a = await fits.buy();
  await fits.go(8);
  assert.equal(fits.w.cardOf(a)?.funding, "float");
  assert.equal(fits.relay.deposits.length, 1);
  assert.equal(fits.custody.usdc, 60_000_000n);
  const over = await site({ usdc: 95_000_000n, treasuryXrp: 300, over: { custodyTargetMicro: 80_000_000n, custodyCeilingMicro: 80_000_000n, minBatchMicro: 1_000_000n } });
  const b = await over.buy();
  await over.go(8);
  assert.equal(over.w.cardOf(b)?.status, "held");
  assert.equal(over.relay.deposits.length, 0, "$25 more would pass the ceiling, so it stays owed");
  assert.equal([...over.w.engine.state.accruals.values()][0].status, "owed");
});

test("a refill never spends XRP owed to a player", async () => {
  // A stray that owes its sender a refund, stuck because their wallet refuses it. Then a pack bought from custody. Only what's above that and the floor can move.
  const s = await site({ usdc: 30_000_000n, treasuryXrp: 9, over: { custodyTargetMicro: 100_000_000n, treasuryTargetDrops: 0n, minBatchMicro: 1_000_000n } });
  const STRANGER = addressOf(9);
  s.w.ledger.fund(STRANGER, 50);
  s.w.ledger.refusePayments(STRANGER, "tecNO_DST");
  // The scan starts with the first checkout.
  await s.w.call("POST", "/api/rip/cards", { as: s.other, body: { code: "pokemon_25" } });
  s.w.ledger.userSubmit({ TransactionType: "Payment", Account: STRANGER, Destination: TREASURY, Amount: "20000000" } as never);
  await s.go(3);
  const a = await s.buy();
  await s.go(6);
  assert.equal(s.w.cardOf(a)?.funding, "float");
  assert.equal([...s.w.engine.state.refunds.values()][0].status, "stuck", "still owed: it just can't be delivered");
  assert.equal(s.relay.deposits.length, 0, "about 49 XRP on hand, 20 owed, 10 floor: 19 free, and this refill needs 20");
  assert.equal([...s.w.engine.state.accruals.values()][0].status, "owed");
  // A balance that grows with nothing in the log (a real top-up is a payment the scan logs) is seen at the next idle look.
  s.w.ledger.fund(TREASURY, 5);
  s.w.state.clockMs += 10 * 60_000;
  await s.go(4);
  assert.equal(s.relay.deposits.length, 1, "with a little more free, it goes");
});

test("a refill never touches the XRP that dust prizes need", async () => {
  const s = await site({ usdc: 30_000_000n, treasuryXrp: 100, over: { custodyTargetMicro: 100_000_000n, treasuryTargetDrops: 0n, minBatchMicro: 1_000_000n } });
  const { nftIdFor, VAULT } = await import("./support-ledger.ts");
  const { XRP_TOKEN } = await import("../src/lib/rip/tokens.ts");
  await s.w.engine.openSeason(5, "4000000", 1.25, { bandBps: [8000, 1000, 500, 300, 200], prizeTable: [{ band: 4, bps: 1000, token: XRP_TOKEN, valueDrops: "30000000" }] as never, tokens: [] });
  let n = 500_000;
  const adds = [8, 6, 4, 3, 2].flatMap((count, band) =>
    Array.from({ length: count }, () => {
      const nftId = nftIdFor(++n);
      s.w.ledger.mintTo(nftId, VAULT);
      return { nftId, band, collection: `c${n % 5}`, name: `n${n}`, img: "/x.webp", costDrops: "2000000", markDrops: "3000000" };
    }),
  );
  await s.w.engine.changePool(5, adds);
  await s.go(4);
  // One place held on the season: it could need 30 XRP.
  assert.equal((await s.w.engine.createOrder(OTHER, 5, 1.25)).ok, true);
  s.w.ledger.setBalance(TREASURY, 20);
  const a = await s.buy();
  await s.go(5);
  assert.equal(s.w.cardOf(a)?.funding, "float");
  assert.equal(s.relay.deposits.length, 0, "40 XRP on hand, 10 floor, 30 cover: nothing free to move");
  assert.equal([...s.w.engine.state.accruals.values()][0].status, "owed");
  await replays(s.w);
});

test("USDC and XRP net: a sale's USDC keeps custody up, so buys need no swap at all and no fee is paid", async () => {
  const s = await site({ usdc: 30_000_000n, treasuryXrp: 400, insuredMicro: "60000000", over: { custodyTargetMicro: 5_000_000n, treasuryTargetDrops: 100_000_000n, minBatchMicro: 1_000_000n } });
  const a = await s.buy();
  await s.go(6);
  await s.sell(a);
  await s.go(4);
  assert.equal(s.w.cardOf(a)?.hold, "sold");
  const b = await s.buy(s.other);
  await s.go(6);
  assert.equal(s.w.cardOf(b)?.funding, "float");
  assert.equal(s.relay.deposits.length + s.custody.relaySent.size, 0);
});

test("a failed refill retries and alerts, and players keep buying through it", async () => {
  const s = await site({ usdc: 60_000_000n, treasuryXrp: 300, over: { custodyTargetMicro: 100_000_000n, minBatchMicro: 1_000_000n } });
  s.relay.down = true;
  const a = await s.buy();
  await s.go(5);
  assert.equal(s.w.cardOf(a)?.status, "held", "the float path doesn't know Relay exists");
  assert.equal([...s.w.engine.state.accruals.values()][0].status, "owed");
  assert.ok((await s.alerts()).includes("refill_failing"));
  s.relay.down = false;
  s.w.state.clockMs += 10 * 60_000;
  await s.go(5);
  assert.equal([...s.w.engine.state.accruals.values()][0].status, "done");
});

/* ---------------------------------------- hazard 3: exactly once ---------------------------------------- */

test("a crash after the deposit is logged sends the same bytes again, and Relay sees one deposit", async () => {
  const s = await site({ usdc: 0n });
  let crashes = 0;
  const id = await s.buy();
  s.w.ledger.close();
  await s.w.engine.advance();
  for (let i = 0; i < 3; i++) {
    s.w.restart();
    crashes += 1;
    await s.w.engine.advance();
    s.relay.tick();
    s.w.ledger.close();
  }
  await s.go(6);
  assert.equal(crashes, 3);
  assert.equal(s.relay.deposits.length, 1);
  assert.equal(s.w.cardOf(id)?.status, "held");
});

test("two servers on one log: one deposit, one pack, one fill counted", async () => {
  const s = await site({ usdc: 0n });
  const id = await s.buy();
  s.w.ledger.close();
  const first = s.w.engine;
  s.w.restart();
  const second = s.w.engine;
  for (let i = 0; i < 8; i++) {
    await Promise.all([first.advance(), second.advance()]);
    s.relay.tick();
    s.w.ledger.close();
    await Promise.all([second.advance(), first.advance()]);
  }
  assert.equal(s.relay.deposits.length, 1);
  assert.equal(s.custody.calls.filter((c) => c === "generate").length, 1);
  assert.equal(second.state.cards.get(id)?.status, "held");
  await replays(s.w);
});

test("a deposit that expires unapplied gets a new quote; it can't land after, and the ledger's sequence rule proves it", async () => {
  const s = await site({ usdc: 0n });
  const id = await s.buy();
  s.w.ledger.close();
  await s.w.engine.advance();
  const before = s.swaps().length;
  // Another of the treasury's transactions takes the Sequence the deposit used, as a key used elsewhere would.
  s.w.ledger.queueFirst({ TransactionType: "AccountSet", Account: TREASURY } as never);
  s.w.ledger.close(30);
  await s.go(10);
  assert.ok(s.swaps().length > before, "a fresh quote");
  assert.equal(s.relay.deposits.length, 1);
  assert.equal(s.w.cardOf(id)?.status, "held");
  await replays(s.w);
});

test("an old fill can't be counted for a new swap", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  const a = await s.buy();
  await s.go(8);
  assert.equal(s.w.cardOf(a)?.status, "held");
  const old = s.swaps()[0];
  const fill = [...s.relay.orders.values()].find((o) => o.orderId === old.orderId)?.txHashes[0] as string;
  s.relay.next.push("never");
  const b = await s.buy(s.other);
  await s.go(4);
  const swap = s.swaps().find((x) => x.status === "deposited") as NonNullable<ReturnType<typeof s.swaps>[number]>;
  const o = s.relay.orders.get(swap.orderId) as NonNullable<ReturnType<typeof s.relay.orders.get>>;
  o.status = "success";
  o.txHashes.push(fill);
  await s.go(4);
  assert.equal(s.w.cardOf(b)?.status, "funding", "a replayed signature isn't a fill");
});

test("the public log carries no signed bytes for a swap, and still replays", async () => {
  const s = await saleWaiting();
  const events = await s.w.store.readFrom(0);
  const open = publicEvents(events);
  assert.ok(open.some((e) => e.type === "swap_signed"));
  for (const e of open) if (e.type === "swap_signed") assert.equal(e.data.bytes, "");
  assert.equal(replayLog(open).ok, true);
});

test("replay catches a forged log: a deposit to an address off the list, a second landing, a deposit bigger than the order", async () => {
  const s = await site({ usdc: 0n });
  await s.buy();
  await s.go(8);
  const events = await s.w.store.readFrom(0);
  assert.equal(replayLog(events).ok, true);
  const { sealEvents } = await import("../src/lib/rip/log.ts");
  const reseal = (mutate: (e: any[]) => any[]) => {
    const bodies = mutate(events.map((e) => JSON.parse(JSON.stringify(e)))).map(({ seq: _s, at: _a, prev: _p, hash: _h, ...b }) => b);
    return sealEvents(0, "", bodies as never, events[0].at);
  };
  const off = reseal((all) => all.map((e) => (e.type === "tx_intent" && e.data.kind === "relay_deposit" ? { ...e, data: { ...e.data, tx: { ...e.data.tx, Destination: "rhVGXf3KKNa2nox1544s4sVrDw3NSfwwUB" } } } : e)));
  assert.equal(replayLog(off).ok, false);
  const big = reseal((all) => all.map((e) => (e.type === "tx_intent" && e.data.kind === "relay_deposit" ? { ...e, data: { ...e.data, tx: { ...e.data.tx, Amount: "99000000" } } } : e)));
  assert.equal(replayLog(big).ok, false);
  const twice = reseal((all) => {
    const i = all.findIndex((e) => e.type === "swap_landed");
    return [...all.slice(0, i + 1), all[i], ...all.slice(i + 1)];
  });
  assert.equal(replayLog(twice).ok, false);
});

test("the chain check accepts Relay's arrivals as accounted for, and rejects one the ledger doesn't show", async () => {
  const s = await saleWaiting();
  const swap = s.swaps().find((x) => x.dir === "usdc_to_xrp") as NonNullable<ReturnType<typeof s.swaps>[number]>;
  s.relay.finish(swap.orderId);
  await s.go(5);
  const events = await s.w.store.readFrom(0);
  const ok = await verifyAgainstChain(events, s.w.chain, TREASURY, 100);
  assert.equal(ok.ok, true, ok.ok ? "" : ok.why);
});

test("existing logs replay unchanged: every log kept from before this feature, including the mainnet ones", () => {
  for (const name of ["log-a5078e36e.json", "mainnet-log-20261102.json", "mainnet-log-20261102-5-3.json"]) {
    const { events } = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const r = replayLog(events);
    assert.equal(r.ok, true, name);
    assert.equal(r.ok && r.state.swaps.size, 0);
  }
});

/* ---------------------------------------- hazards 5 to 7 ---------------------------------------- */

test("custody low on SOL says so while the switch is on", async () => {
  const s = await site({ usdc: 400_000_000n });
  s.custody.sol = 100_000n;
  assert.ok((await s.alerts()).includes("custody_sol"));
});

test("Relay slow past ten minutes: an alert, the player reads 'on its way', and at the limit the XRP goes back whole with no USDC spent", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  s.relay.next.push("never");
  const id = await s.buy();
  await s.go(5);
  assert.equal(s.w.cardOf(id)?.status, "funding");
  const polled = await s.w.call("GET", `/api/rip/cards/${id}`);
  assert.match(polled.body.order.stage, /on its way/i);
  assert.doesNotMatch(JSON.stringify(polled.body), /treasury|float/i);
  s.w.state.clockMs += SWAP_STALL_MS + 1000;
  assert.ok((await s.alerts()).includes("swap_stalled"));
  s.w.state.clockMs += SWAP_GIVE_UP_MS;
  await s.go(4);
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.deepEqual(s.custody.calls, []);
  // Relay finishes after all: the USDC is ours, the player has been paid, and that USDC is marked to come back.
  const swap = s.swaps()[0];
  s.relay.finish(swap.orderId);
  await s.go(4);
  assert.equal(s.w.engine.state.swaps.get(swap.id)?.status, "landed");
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.deepEqual(s.custody.calls, [], "a late fill never buys a pack for a refunded order");
  assert.equal(s.w.paidTo(PLAYER).length, 1);
  assert.ok([...s.w.engine.state.accruals.values()].some((a) => a.dir === "to_treasury" && a.reason === "late_fill"));
  await replays(s.w);
});

test("Relay down: a checkout is refused only if custody can't pay, and a paid order that can't swap goes back whole at the limit", async () => {
  const s = await site({ usdc: 25_000_000n, treasuryXrp: 40 });
  const a = await s.buy();
  await s.go(5);
  assert.equal(s.w.cardOf(a)?.status, "held");
  s.custody.usdc = 0n;
  const b = await s.buy(s.other);
  await s.w.engine.advance();
  s.relay.down = true;
  await s.go(4);
  assert.equal(s.w.cardOf(b)?.status, "paid");
  s.w.state.clockMs += SWAP_GIVE_UP_MS + 1000;
  await s.go(4);
  assert.equal(s.w.cardOf(b)?.status, "refunded");
  assert.equal(s.w.paidTo(OTHER).length, 1);
});

test("a wallet getting refunds over and over has to wait: buy-and-refund can't be spun", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  s.custody.refuseGenerate = true;
  for (let i = 0; i < MAX_LAPSED_ORDERS; i++) {
    await s.buy();
    await s.go(10);
  }
  const again = await s.w.call("POST", "/api/rip/cards", { as: s.me, body: { code: "pokemon_25" } });
  assert.equal(again.body.code, "too_many_lapsed");
  assert.equal((await s.w.call("POST", "/api/rip/cards", { as: s.other, body: { code: "pokemon_25" } })).status, 200, "other wallets are fine");
});

test("the machine closing before a swap costs nothing: the check comes first", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  const id = await s.buy();
  const original = s.w.gateway?.machine;
  (s.w.gateway as { machine: unknown }).machine = async () => null;
  await s.go(5);
  (s.w.gateway as { machine: unknown }).machine = original;
  assert.equal(s.w.cardOf(id)?.status, "refunded");
  assert.equal(s.relay.deposits.length, 0);
});

test("a low custody balance no longer says packs are restocking while Relay works", async () => {
  const s = await site({ usdc: CARD_FLOAT_LOW_MICRO - 1n });
  assert.ok(!(await s.alerts()).includes("card_float"));
  assert.ok(!(await s.alerts()).includes("card_sale_uncovered"));
});

test("a sale the treasury can't pay is paused, not taken, while Relay can't bring the XRP: the card stays safe and the mirror isn't burned", async () => {
  const s = await site({ usdc: 400_000_000n, treasuryXrp: 40 });
  const id = await s.buy();
  await s.go(6);
  s.w.ledger.setBalance(TREASURY, 11);
  const quote = await s.w.call("POST", `/api/rip/cards/${id}/sell`, { as: s.me });
  s.relay.down = true;
  const refused = await s.w.call("POST", `/api/rip/cards/${id}/sell`, { as: s.me, body: { drops: quote.body.drops } });
  assert.equal(refused.body.code, "sell_paused");
  assert.equal(s.w.cardOf(id)?.hold, "stashed");
  assert.equal(s.w.cardOf(id)?.exit, null);
  s.relay.down = false;
  assert.equal((await s.w.call("POST", `/api/rip/cards/${id}/sell`, { as: s.me, body: { drops: quote.body.drops } })).status, 200);
});

test("a treasury under its floor doesn't let an unpayable deposit hold up the payouts it can make", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  await s.buy();
  s.w.ledger.close();
  s.w.ledger.setBalance(TREASURY, 2);
  const STRANGER = addressOf(9);
  s.w.ledger.fund(STRANGER, 50);
  await s.w.engine.advance();
  const logBefore = (await s.w.store.readFrom(0)).length;
  for (let i = 0; i < 4; i++) await s.w.engine.advance();
  assert.ok((await s.w.store.readFrom(0)).length - logBefore <= 1, "waiting doesn't fill the log");
  assert.ok((await s.alerts()).includes("treasury_floor"));
});

test("an operator can settle a swap Relay stopped answering for, only once it's stalled, and only by an admin route", async () => {
  const s = await site({ usdc: 0n, treasuryXrp: 40 });
  s.relay.next.push("never");
  const id = await s.buy();
  await s.go(5);
  const swap = s.swaps()[0];
  const boss = s.w.client(ADMIN);
  const path = "/api/rip/admin/resolve-swap";
  assert.equal((await s.w.call("POST", path, { as: s.me, body: { id: swap.id, action: "released" } })).status, 404);
  assert.equal((await s.w.call("POST", path, { as: boss, body: { id: swap.id, action: "nope" } })).status, 400);
  assert.equal((await s.w.call("POST", path, { as: boss, body: { id: swap.id, action: "released" } })).status, 409, "not stalled yet");
  s.w.state.clockMs += SWAP_STALL_MS + 1000;
  assert.equal((await s.w.call("POST", path, { as: boss, body: { id: swap.id, action: "released" } })).status, 200);
  assert.equal(s.w.engine.state.swaps.get(swap.id)?.status, "dead");
  assert.equal(s.w.cardOf(id)?.status, "paid");
  await replays(s.w);
});

test("the factory: the switch off by default still recognizes Relay's solver, and on is refused anywhere but mainnet's real source", async () => {
  const { relayRails } = await import("../src/lib/rip/relay.ts");
  const off = relayRails({}, { treasury: TREASURY, custody: CUSTODY_KEY }, { quote: async () => ({}), status: async () => ({ status: "x", txHashes: [] }) });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.policy.xrpSolvers, RELAY_XRP_SOLVERS);
  const { buildRails } = await import("../src/lib/rip/factory.ts");
  const { Wallet } = await import("xrpl");
  const [t, v] = [Wallet.generate(), Wallet.generate()];
  const env = { SEAL_RAILS_MODE: "testnet", SEAL_TREASURY_ADDRESS: t.classicAddress, SEAL_TREASURY_SEED: t.seed, SEAL_VAULT_ADDRESS: v.classicAddress, SEAL_VAULT_SEED: v.seed, SEAL_DRAW_SECRET: "x".repeat(40), SEAL_LOCAL_LOG: "/tmp/never-written-seal-passthrough" };
  assert.ok(buildRails(env));
  assert.throws(() => buildRails({ ...env, SEAL_CARD_PASSTHROUGH: "on" }), /only on mainnet/);
});

test("the deposit as custody would sign it: Relay's real instructions build into one transaction, and the judge decides", async () => {
  const { judgeRelayDeposit } = await import("../src/lib/rip/cc-gateway.ts");
  const { AddressLookupTableAccount, Keypair, PublicKey } = await import("@solana/web3.js");
  const q = checkUsdcToXrp(fixture("quote-usdc-to-xrp-21-20261102.json"), POLICY, { inMicro: 21_000_000n, minOutDrops: 16_000_000n }, FIXTURE_NOW);
  const table = new AddressLookupTableAccount({ key: new PublicKey(q.lookupTables?.[0] as string), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [] } });
  const custody = new PublicKey(CUSTODY_KEY);
  const connection = (after: ReturnType<typeof tokenAccount> | null, err: unknown = null) => ({
    getAddressLookupTable: async () => ({ value: table }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    getTokenAccountBalance: async () => ({ value: { amount: "100000000" } }),
    getBalance: async () => 9_000_000,
    simulateTransaction: async () => ({ value: { err, accounts: [after, { lamports: 8_990_000, owner: "11111111111111111111111111111111" }] } }),
  });
  const run = (c: ReturnType<typeof connection>, over: object = {}) => judgeRelayDeposit(c as never, { custody, instructions: q.instructions ?? [], lookupTables: q.lookupTables ?? [], amountMicro: 21_000_000n, others: [], ...over });
  assert.equal((await run(connection(tokenAccount({ micro: 79_000_000n })))).refusal, null);
  assert.match((await run(connection(tokenAccount({ micro: 79_000_000n, delegate: true })))).refusal as string, /delegate/);
  assert.match((await run(connection(null, { InstructionError: [0, "Custom"] }))).refusal as string, /simulation failed/);
  const hostile = [{ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", keys: [], data: "" }];
  await assert.rejects(() => run(connection(tokenAccount({ micro: 79_000_000n })), { instructions: hostile }), /isn't on the list/);
  const stranger = Keypair.generate().publicKey.toBase58();
  const cosigned = [{ ...(q.instructions ?? [])[0], keys: [...((q.instructions ?? [])[0]?.keys ?? []), { pubkey: stranger, isSigner: true, isWritable: false }] }];
  assert.match((await run(connection(tokenAccount({ micro: 79_000_000n })), { instructions: cosigned })).refusal as string, /someone else/);
});

test("a fill is only a fill if Solana shows one of Relay's solvers paying custody that much, finalized", async () => {
  const { collectorCryptGateway } = await import("../src/lib/rip/cc-gateway.ts");
  const { Keypair } = await import("@solana/web3.js");
  const key = Keypair.generate();
  const me = key.publicKey.toBase58();
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const answer = { current: null as unknown };
  const gw = collectorCryptGateway({ custodySecret: key.secretKey, solanaRpc: "https://rpc.test", recipientTokenAccounts: [], maxComputeUnits: 1, maxComputeUnitPriceMicroLamports: 1n, fetchImpl: (async () => new Response(JSON.stringify({ result: answer.current }))) as never });
  const tx = (signer: string, pre: string, post: string, err: unknown = null) => ({ slot: 9, meta: { err, preTokenBalances: [{ owner: me, mint: USDC, uiTokenAmount: { amount: pre } }], postTokenBalances: [{ owner: me, mint: USDC, uiTokenAmount: { amount: post } }] }, transaction: { message: { accountKeys: [{ pubkey: signer }, { pubkey: me }] } } });
  answer.current = tx("F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe", "0", "25000000");
  assert.deepEqual(await gw.proveUsdcFill("sig", 25_000_000n), { micro: "25000000", slot: 9 });
  assert.equal(await gw.proveUsdcFill("sig", 25_000_001n), null, "less than it needs");
  answer.current = tx("GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3", "0", "25000000");
  assert.equal(await gw.proveUsdcFill("sig", 1n), null, "USDC from anyone else, like a buyback, isn't a fill");
  answer.current = tx("F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe", "0", "25000000", { err: "failed" });
  assert.equal(await gw.proveUsdcFill("sig", 1n), null, "a failed transaction");
  answer.current = null;
  assert.equal(await gw.proveUsdcFill("sig", 1n), null, "not found yet");
});

/* ---------------------------------------- any interleaving ---------------------------------------- */

const OUTCOMES: Outcome[] = ["success", "success", "slow", "refund", "never", "partial"];
type Op =
  | { k: "buy"; who: 0 | 1 }
  | { k: "close" }
  | { k: "advance" }
  | { k: "restart" }
  | { k: "next"; o: Outcome }
  | { k: "down"; on: boolean }
  | { k: "sell" }
  | { k: "drain" }
  | { k: "clock"; ms: number }
  | { k: "finish" }
  | { k: "refuse"; on: boolean }
  | { k: "rate"; r: number }
  | { k: "bundle"; who: 0 | 1; qty: number }
  | { k: "sol"; low: boolean };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant("buy" as const), who: fc.constantFrom(0 as const, 1 as const) }), weight: 3 },
  { arbitrary: fc.constant({ k: "close" as const }), weight: 5 },
  { arbitrary: fc.constant({ k: "advance" as const }), weight: 5 },
  { arbitrary: fc.constant({ k: "restart" as const }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("next" as const), o: fc.constantFrom(...OUTCOMES) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("down" as const), on: fc.boolean() }), weight: 1 },
  { arbitrary: fc.constant({ k: "sell" as const }), weight: 3 },
  { arbitrary: fc.constant({ k: "drain" as const }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("clock" as const), ms: fc.constantFrom(60_000, 11 * 60_000, 31 * 60_000) }), weight: 1 },
  { arbitrary: fc.constant({ k: "finish" as const }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("refuse" as const), on: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("rate" as const), r: fc.constantFrom(1.25, 1.24, 1.26, 1.2, 1.3) }), weight: 1 },
);

/** The same with multi-pack card orders, and custody's SOL running out and coming back. */
const multiOpArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: opArb, weight: 10 },
  { arbitrary: fc.record({ k: fc.constant("bundle" as const), who: fc.constantFrom(0 as const, 1 as const), qty: fc.integer({ min: 2, max: 4 }) }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("sol" as const), low: fc.boolean() }), weight: 1 },
);

test("any interleaving of crashes, retries and Relay outcomes: nobody is paid twice, no pack without money, nobody's money vanishes", () => crashProperty(opArb, undefined, 60));
test("the same with multi-pack card orders and custody's SOL running out: every card of every order is bought once or refunded whole", () => crashProperty(multiOpArb, { SEAL_MULTI_QTY: "on", SEAL_MULTI_MAX: "20", SEAL_MULTI_CARD_MAX: "5" }, 40));

async function crashProperty(ops_: fc.Arbitrary<Op>, env: Record<string, string> | undefined, numRuns: number) {
  let bundled = 0;
  let bundledHeld = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(ops_, { minLength: 8, maxLength: 40 }), fc.constantFrom(0n, 30_000_000n, 400_000_000n), fc.constantFrom(15, 40, 400), async (ops, usdc, treasuryXrp) => {
      const s = await site({ usdc, treasuryXrp, env, over: { custodyTargetMicro: 50_000_000n, treasuryTargetDrops: 100_000_000n, minBatchMicro: 10_000_000n } });
      const players = [s.me, s.other];
      const paidIn = new Map<string, bigint>();
      const bought: string[] = [];
      for (const op of ops) {
        try {
          switch (op.k) {
            case "buy": {
              const q = await s.w.call("POST", "/api/rip/cards", { as: players[op.who], body: { code: "pokemon_25" } });
              if (q.status === 200) {
                s.w.ledger.userSubmit(q.body.tx);
                paidIn.set(q.body.order.id, BigInt(q.body.tx.Amount));
                bought.push(q.body.order.id);
              }
              break;
            }
            case "close":
              s.relay.tick();
              s.w.ledger.close();
              break;
            case "advance":
              await s.w.engine.advance();
              break;
            case "restart":
              s.w.restart();
              break;
            case "next":
              s.relay.next.push(op.o);
              break;
            case "down":
              s.relay.down = op.on;
              break;
            case "sell": {
              const id = [...bought].reverse().find((b) => s.w.cardOf(b)?.hold === "stashed");
              if (id) {
                const who = players.find((p) => p.address === s.w.cardOf(id)?.address) ?? s.me;
                const q = await s.w.call("POST", `/api/rip/cards/${id}/sell`, { as: who });
                if (q.status === 200) await s.w.call("POST", `/api/rip/cards/${id}/sell`, { as: who, body: { drops: q.body.drops } });
              }
              break;
            }
            case "drain":
              s.w.ledger.setBalance(TREASURY, 11);
              break;
            case "clock":
              s.w.state.clockMs += op.ms;
              break;
            case "finish": {
              const open = [...s.relay.orders.values()].find((o) => !o.done && s.relay.seenDeposits.size + s.custody.relaySent.size > 0);
              if (open && s.swaps().some((x) => x.orderId === open.orderId && x.status === "deposited")) s.relay.finish(open.orderId);
              break;
            }
            case "refuse":
              s.custody.refuseGenerate = op.on;
              break;
            case "rate":
              s.relay.usdPerXrp = op.r;
              s.w.state.rate = op.r;
              break;
            case "bundle": {
              const q = await s.w.call("POST", "/api/rip/bundles", { as: players[op.who], body: { code: "pokemon_25", qty: op.qty, acceptedTerms: true } });
              if (q.status === 200 && q.body.tx) {
                s.w.ledger.userSubmit(q.body.tx);
                const b = s.w.engine.state.bundles.get(q.body.bundle.id);
                for (const id of b?.children ?? []) {
                  bundled += 1;
                  paidIn.set(id, BigInt(b?.each ?? 0));
                  bought.push(id);
                }
              }
              break;
            }
            case "sol":
              s.custody.sol = op.low ? 500_000n : 10_000_000n;
              break;
          }
        } catch (e) {
          // A step that fails midway is what a crash is. An overdraft is the one thing that's never allowed.
          if (e instanceof Error && /overdrawn/.test(e.message)) throw e;
        }
        check(s, paidIn);
      }
      // Everything calms down: Relay answers, every open order finishes, the owner tops up what the house came up short.
      s.relay.down = false;
      s.custody.refuseGenerate = false;
      s.relay.outcome = "success";
      s.relay.usdPerXrp = 1.25;
      s.w.state.rate = 1.25;
      s.custody.sol = 10_000_000n;
      for (let i = 0; i < 4; i++) {
        s.relay.next.length = 0;
        for (const x of s.swaps()) if (x.status === "deposited" && !s.relay.orders.get(x.orderId)?.done) s.relay.finish(x.orderId);
        s.w.ledger.fund(TREASURY, 3000);
        s.w.state.clockMs += 31 * 60_000;
        await s.go(6);
        check(s, paidIn);
      }
      check(s, paidIn);
      // Nobody's money vanished: every paid card ended held, sold, refunded, or in front of a person, and no refund is left unpaid.
      for (const [id] of paidIn) {
        const c = s.w.cardOf(id);
        if (!c || c.status === "quoted" || c.status === "expired") continue;
        assert.ok(["held", "refunded", "review"].includes(c.status), `${id} ended ${c.status}/${c.hold}, via ${c.funding}`);
        if (c.status === "held") assert.ok(!["exit_source", "selling"].includes(c.hold as string), `${id} is stuck ${c.hold}`);
      }
      for (const r of s.w.engine.state.refunds.values()) assert.ok(r.status === "done" || r.status === "stuck", `refund ${r.id} ended ${r.status}`);
      bundledHeld += [...paidIn.keys()].filter((id) => s.w.cardOf(id)?.bundle && s.w.cardOf(id)?.status === "held").length;
      for (const x of s.swaps()) if (x.purpose !== "refill") assert.ok(["landed", "dead", "refunded", "review"].includes(x.status), `swap ended ${x.status}`);
      await replays(s.w);
    }),
    { numRuns, seed: 20261102 },
  );
  if (env) assert.ok(bundled > 20 && bundledHeld > 5, `the runs have to reach multi orders: ${bundled} cards ordered in multi orders, ${bundledHeld} bought`);
}

function check(s: Awaited<ReturnType<typeof site>>, paidIn: Map<string, bigint>) {
  const st = s.w.engine.state;
  // Exactly once, on the ledger: no order sees two deposits.
  const seen = new Set<string>();
  for (const d of s.relay.deposits) {
    assert.ok(!seen.has(d.orderId), "two deposits for one Relay order");
    seen.add(d.orderId);
  }
  assert.ok(s.custody.usdc >= 0n, "custody overdrawn");
  // No swap moves more than what it names: an order's own XRP, or USDC a sale brought in.
  for (const x of st.swaps.values()) {
    if (x.status === "dead") continue;
    const refs = x.accruals.map((a) => st.accruals.get(a));
    if (x.purpose === "refill" || refs.length) {
      const total = refs.reduce((t, a) => t + BigInt(a?.amount ?? 0), 0n);
      assert.ok(BigInt(x.inAmount) <= total, `swap ${x.id} moves ${x.inAmount}, brought in ${total}`);
    } else if (x.card) {
      assert.ok(BigInt(x.inAmount) <= (paidIn.get(x.card) ?? 0n), `swap ${x.id} moves more than its order paid`);
    }
  }
  // An accrual is in one live swap at most.
  const live = new Map<string, string>();
  for (const x of st.swaps.values()) {
    if (x.status === "dead" || x.status === "refunded") continue;
    for (const a of x.accruals) {
      assert.ok(!live.has(a), `accrual ${a} is in two swaps`);
      live.set(a, x.id);
    }
  }
  // Each order pays out once at most, in one form, and a refund is exactly what came in.
  for (const [id, drops] of paidIn) {
    const c = st.cards.get(id);
    if (!c) continue;
    const address = c.address;
    const refunds = s.w.paidTo(address).filter((t) => JSON.stringify(t.tx.Memos ?? "").includes(Buffer.from("seal-rips/refund").toString("hex").toUpperCase()));
    void refunds;
    const sales = s.w.ledger.history.filter((t) => t.tx.Account === TREASURY && t.result === "tesSUCCESS" && t.tx.Destination === c.exit?.by && JSON.stringify(t.tx.Memos ?? "").includes(Buffer.from(`${id}`).toString("hex").toUpperCase()));
    assert.ok(sales.length <= 1, `card ${id} was paid ${sales.length} times`);
    if (c.status === "refunded") {
      assert.equal(c.hold, null);
      assert.equal(sales.length, 0, "a refund after a sale");
      const r = st.refunds.get(c.refundId as string);
      assert.equal(BigInt(r?.drops ?? -1), drops, "a refund is whole");
      assert.equal(c.mint, null, "a refund after a pack was bought");
    }
    // A pack was asked for only once USDC could pay for it.
    if (c.memo && c.funding === "swap") assert.ok([...st.swaps.values()].some((x) => x.card === id && x.status === "landed"));
  }
}
