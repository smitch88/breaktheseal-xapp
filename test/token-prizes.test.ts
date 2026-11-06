import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { NFT_LADDERS, NFT_PRICES, SHELF_PRICES, SHELF_UNDER_USD, isOffered, type NftPrice } from "../src/config/nft-packs.ts";
import { DUST_DROPS, bandOf, prizeRowOf, sha256Hex } from "../src/lib/rip/draw.ts";
import { specBreaks } from "../src/lib/rip/rarity-spec.ts";
import { STRIKE_WAIT_LEDGERS, createEngine, type RipEngine } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import type { RipEvent, RipEventBody } from "../src/lib/rip/types.ts";
import { tokenOwed, treasuryOwed } from "../src/lib/rip/state.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { SEAL_CURRENCY, SEAL_ISSUER, SEAL_TOKEN, TOKEN_POLICY, XRP_TOKEN, checkPool, iouToMicro, prettyAmount, prizeName, prizeTableFor, prizeTooBig, sealTokenSpec, seasonPlan, strikeAmount, tokenSellDrops, trustSetTx, type TokenSpec } from "../src/lib/rip/tokens.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { TREASURY, VAULT, nftIdFor, testLedger, testSigner } from "./support-ledger.ts";

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const SPEC: TokenSpec = { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer: SEAL_ISSUER };
const POOL_XRP = "33007194945";
const POOL_TOKEN = iouToMicro("44788357114.1098");
const PRICE: NftPrice = 10;
const DROPS = "8000000";
/** Every roll in a band lands on the token rows: the rest of the flow is what these tests are about. */
const ALL_XRP = { bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 10000, valueDrops: "2500000" }], tokens: [] };
const ALL_SEAL = { bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: SEAL_TOKEN, bps: 10000, valueDrops: "2500000" }], tokens: [SPEC] };

async function setup(plan: Parameters<RipEngine["openSeason"]>[3], opts: { sealInTreasury?: bigint; treasuryXrp?: number; shelf?: readonly NftPrice[]; stock?: number; store?: ReturnType<typeof memoryStore>; drops?: string } = {}) {
  const ledger = testLedger("tokens");
  ledger.fund(TREASURY, opts.treasuryXrp ?? 1000);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 1000);
  ledger.setPool(SPEC, POOL_XRP, POOL_TOKEN);
  ledger.setLine(SPEC, TREASURY, opts.sealInTreasury ?? 10_000_000_000n);
  const store = opts.store ?? memoryStore();
  const make = () => createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "test-secret", expectedNetworkId: 1, ...(opts.shelf ? { shelf: opts.shelf } : {}) });
  const engine = make();
  await engine.openSeason(PRICE, opts.drops ?? DROPS, null, plan);
  const adds = [0, 1, 2, 3, 4].flatMap((band) => Array.from({ length: opts.stock ?? 2 }, (_, i) => {
    const nftId = nftIdFor(band * 100 + i + 1);
    ledger.mintTo(nftId, VAULT);
    return { nftId, band, collection: `c${band}`, name: `n${i}`, img: "/x.webp", costDrops: "2000000", markDrops: "2000000" };
  }));
  assert.equal((await engine.changePool(PRICE, adds)).ok, true);
  await run(engine, ledger, 6);
  return { ledger, store, engine, make };
}

async function run(engine: RipEngine, ledger: ReturnType<typeof testLedger>, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

async function pull(engine: RipEngine, ledger: ReturnType<typeof testLedger>) {
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.ok(quote.ok, JSON.stringify(quote));
  ledger.userSubmit(quote.tx as never);
  await run(engine, ledger, 6);
  return engine.state.orders.get(quote.order.id)!;
}

const PACK_60 = "60000000";
const events = async (store: ReturnType<typeof memoryStore>) => store.readFrom(0);

test("the shelf is only packs under $50: a pack priced exactly $50 is not under $50", () => {
  assert.deepEqual([...SHELF_PRICES], [5, 10]);
  for (const p of SHELF_PRICES) assert.ok(p < SHELF_UNDER_USD && NFT_LADDERS[p].offered);
  assert.equal(isOffered(25), false);
  assert.equal(isOffered(50), false);
  assert.equal(isOffered(100), false);
  // Built, not deleted.
  assert.equal(NFT_LADDERS[25].bands.length, 5);
  assert.equal(NFT_LADDERS[50].bands.length, 5);
  assert.equal(NFT_LADDERS[100].bands.length, 5);
});

test("a pack off the shelf can't take an order, even with a season open", async () => {
  const { engine } = await setup(undefined, { shelf: [5, 25] });
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.equal(quote.ok, false);
  assert.equal((quote as { code: string }).code, "not_open");
});

test("$50 and $100 can't be reached: no season opens, no order opens, and every route checks the shelf", async () => {
  const ledger = testLedger("off");
  ledger.fund(TREASURY, 100);
  ledger.fund(VAULT, 100);
  ledger.fund(PLAYER, 100);
  const engine = createEngine({ store: memoryStore(), chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, shelf: SHELF_PRICES });
  for (const p of [25, 50, 100] as const) {
    assert.equal(await engine.openSeason(p, "40000000"), null);
    assert.equal(((await engine.createOrder(PLAYER, p)) as { code?: string }).code, "not_open");
  }
  const root = new URL("../src/", import.meta.url);
  for (const f of ["app/api/rip/orders/route.ts", "app/api/nft/[price]/route.ts", "app/(site)/checkout/page.tsx", "app/(site)/nft/[price]/page.tsx"]) assert.ok(/isOffered\(/.test(readFileSync(new URL(f, root), "utf8")), f);
  for (const f of ["app/(site)/page.tsx", "app/(site)/packs/page.tsx", "app/(stage)/try/page.tsx", "app/api/rip/config/route.ts"]) {
    const text = readFileSync(new URL(f, root), "utf8");
    assert.ok(/SHELF_PRICES/.test(text) && !/NFT_PRICES/.test(text), f);
  }
  assert.ok(/shelf: SHELF_PRICES/.test(readFileSync(new URL("lib/rip/factory.ts", root), "utf8")));
});

test("every ladder's rates add to 100%, and only the dust band pays all tokens", () => {
  for (const p of NFT_PRICES) {
    const l = NFT_LADDERS[p];
    assert.equal(l.bandBps.reduce((a, b) => a + b, 0), 10000, `$${p}`);
    if (p === 5) {
      // Season 5-6 is cut by the rarity spec: every row sits in its tier's value range, dust is Common's, and Common holds NFTs beside it.
      assert.deepEqual(specBreaks(l, []), []);
      for (const r of l.tokenPrizes) assert.equal(!!r.dust, r.band === 0, `$5 band ${r.band}`);
      assert.ok(l.bands[0].length > 0);
      assert.ok(l.tokenPrizes.every((r) => !(r.band === 4)), "Chase is all NFT");
      continue;
    }
    for (const r of l.tokenPrizes) assert.ok(r.bps > 0 && (r.dust ? r.band === 0 : r.bps <= 5000) && r.band >= 0 && r.band < 4, `$${p} band ${r.band}`);
    const dust = l.tokenPrizes.filter((r) => r.dust);
    if (dust.length) {
      assert.equal(dust.reduce((a, r) => a + r.bps, 0), 10000, `$${p}: a dust band pays dust on every pull`);
      assert.equal(l.bands[0].length, 0, `$${p}: a dust band holds no NFTs`);
      for (const r of dust) assert.ok(r.xrp >= Number(DUST_DROPS) / 1e6 && r.xrp <= l.xrp, `$${p}: dust is 1 XRP or more, and at most one pack`);
    }
    assert.ok(l.tokenPrizes.every((r) => !(r.band === 4)), "Chase is all NFT");
  }
});

test("NFTs are still a real share of pulls on every shelf pack, though the owner moved off a majority for this launch", () => {
  for (const p of SHELF_PRICES) {
    const l = NFT_LADDERS[p];
    const tokenPulls = l.tokenPrizes.reduce((a, r) => a + (l.bandBps[r.band] * r.bps) / 10000, 0);
    assert.ok(tokenPulls <= 8500, `$${p}: ${tokenPulls}`);
  }
});

test("with SEAL off the same rows pay XRP, so the value of the pack doesn't change", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ band: fc.integer({ min: 0, max: 3 }), bps: fc.integer({ min: 1, max: 5000 }), xrp: fc.integer({ min: 1, max: 200 }) }), { maxLength: 4 }), (rows) => {
      const worth = (t: ReturnType<typeof prizeTableFor>) => t.reduce((a, r) => a + r.bps * Number(r.valueDrops), 0);
      assert.equal(worth(prizeTableFor(rows, true)), worth(prizeTableFor(rows, false)));
      assert.ok(prizeTableFor(rows, false).every((r) => r.token === XRP_TOKEN));
    }),
  );
});

test("the SEAL token: fixed issuer on mainnet, off when told, and the same code from another issuer is refused", () => {
  assert.equal(sealTokenSpec({})?.issuer, SEAL_ISSUER);
  assert.equal(sealTokenSpec({})?.currency, "5345414C00000000000000000000000000000000");
  assert.equal(sealTokenSpec({ SEAL_TOKEN_PRIZES: "off" }), null);
  assert.throws(() => sealTokenSpec({ SEAL_RAILS_MODE: "mainnet", SEAL_TOKEN_ISSUER: "rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB" }));
  assert.equal(sealTokenSpec({ SEAL_RAILS_MODE: "testnet", SEAL_TOKEN_ISSUER: "rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB" })?.issuer, "rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB");
  assert.throws(() => sealTokenSpec({ SEAL_TOKEN_ISSUER: "not-an-address" }));
});

test("ledger values parse exactly, including exponents", () => {
  assert.equal(iouToMicro("44788357114.1098"), "44788357114109800");
  assert.equal(iouToMicro("5188873850259730e-4"), "518887385025973000");
  assert.equal(iouToMicro("0"), "0");
  assert.equal(iouToMicro("1.0000009"), "1000000");
  assert.equal(iouToMicro("-617.0677017692"), "-617067701");
});

test("a struck amount is never worth more than its value, and reads clean", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1_000_000n, max: 500_000_000n }), fc.bigInt({ min: 5_000_000_000n, max: 500_000_000_000n }), fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n }), (value, x, t) => {
      const price = { xrpDrops: x.toString(), tokenMicro: t.toString() };
      const amount = strikeAmount(value.toString(), price);
      // Back at the same price it's worth at most the value.
      assert.ok((amount * x * 1_000_000n) / t <= value);
      assert.equal(prettyAmount(amount), amount);
      assert.ok(tokenSellDrops(amount.toString(), price, 8500, value.toString()) <= (value * 8500n) / 10000n);
    }),
  );
});

test("a price that moved, went thin, went stale or left the band pauses; a healthy one takes the safer side", () => {
  const read = (x: string, t: string, ledger = 1000, closeMs: number | null = 1000) => ({ ledger, xrpDrops: x, tokenMicro: t, closeMs });
  const now = read(POOL_XRP, POOL_TOKEN);
  const same = checkPool(now, read(POOL_XRP, POOL_TOKEN, 550));
  assert.equal(same.ok, true);
  // Moved more than the policy allows, either way.
  const up = (BigInt(POOL_XRP) * 110n) / 100n;
  assert.deepEqual(checkPool(read(up.toString(), POOL_TOKEN), now), { ok: false, code: "price_moved" });
  assert.deepEqual(checkPool(now, read(up.toString(), POOL_TOKEN, 550)), { ok: false, code: "price_moved" });
  assert.deepEqual(checkPool(read("1000000", POOL_TOKEN), read("1000000", POOL_TOKEN)), { ok: false, code: "pool_thin" });
  assert.deepEqual(checkPool(read("nonsense", POOL_TOKEN), now), { ok: false, code: "price_unreadable" });
  assert.deepEqual(checkPool(read(POOL_XRP, "1000"), read(POOL_XRP, "1000")), { ok: false, code: "price_out_of_band" });
  assert.deepEqual(checkPool(read(POOL_XRP, POOL_TOKEN, 1000, 0), now, TOKEN_POLICY, 120_000), { ok: false, code: "price_stale" });
  assert.deepEqual(checkPool(read(POOL_XRP, POOL_TOKEN, 1000, null), now, TOKEN_POLICY, 1), { ok: false, code: "price_stale" });
  // Moved a little: the strike uses the dearer price (fewer tokens), and a sale the cheaper (fewer drops).
  const a = (BigInt(POOL_XRP) * 102n) / 100n;
  const c = checkPool(read(a.toString(), POOL_TOKEN), read(POOL_XRP, POOL_TOKEN, 550));
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal(c.strike.xrpDrops, a.toString());
    assert.equal(c.sell.xrpDrops, POOL_XRP);
  }
});

test("prizes are sized against the pool", () => {
  assert.equal(prizeTooBig("100000000", POOL_XRP), false);
  assert.equal(prizeTooBig("400000000", POOL_XRP), true);
});

test("the prize roll holds its share and depends on nothing but the digest and the table", () => {
  const table = [{ band: 0, token: SEAL_TOKEN, bps: 2500, valueDrops: "1" }, { band: 0, token: XRP_TOKEN, bps: 2500, valueDrops: "1" }];
  let seal = 0;
  let xrp = 0;
  const n = 40_000;
  for (let i = 0; i < n; i++) {
    const r = prizeRowOf(sha256Hex(`r${i}`), table, 0);
    if (r?.token === SEAL_TOKEN) seal++;
    if (r?.token === XRP_TOKEN) xrp++;
    assert.equal(prizeRowOf(sha256Hex(`r${i}`), table, 3), null);
  }
  assert.ok(Math.abs(seal / n - 0.25) < 0.015 && Math.abs(xrp / n - 0.25) < 0.015, `${seal} ${xrp}`);
});

test("season plans carry the real rates and name the token they pay", () => {
  const on = seasonPlan(NFT_LADDERS[10], SPEC);
  assert.deepEqual(on.bandBps, NFT_LADDERS[10].bandBps);
  assert.deepEqual(on.tokens, [SPEC]);
  assert.ok(on.prizeTable.some((r) => r.token === SEAL_TOKEN));
  const off = seasonPlan(NFT_LADDERS[10], null);
  assert.ok(off.prizeTable.every((r) => r.token === XRP_TOKEN));
  assert.deepEqual(seasonPlan(NFT_LADDERS[50], SPEC).prizeTable, []);
});

test("an XRP prize: struck at its value, redeemed to the player's wallet once, however many times it's asked", async () => {
  const { engine, ledger, store } = await setup(ALL_XRP);
  const o = await pull(engine, ledger);
  assert.equal(o.status, "drawn");
  assert.equal(o.pull, "stashed");
  assert.equal(o.prize?.amount, "2500000");
  assert.equal(o.nftId, null);
  assert.equal(treasuryOwed(engine.state), 2_500_000n, "owed from the moment it's struck");
  const before = ledger.balance(PLAYER);
  for (let i = 0; i < 3; i++) assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await run(engine, ledger, 4);
  for (let i = 0; i < 3; i++) assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(o.id)?.pull, "redeemed");
  assert.equal(ledger.balance(PLAYER) - before, 2_500_000n);
  assert.equal(treasuryOwed(engine.state), 0n);
  const log = await events(store);
  assert.equal(log.filter((e) => e.type === "tx_final" && engine.state.settled.get(e.data.id)?.kind === "prize_redeem" && e.data.result === "tesSUCCESS").length, 1);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("an XRP prize has no sale: it's already XRP", async () => {
  const { engine, ledger } = await setup(ALL_XRP);
  const o = await pull(engine, ledger);
  const q = await engine.quoteSell(PLAYER, o.id);
  assert.equal(q.ok, false);
  assert.equal((await engine.sell(PLAYER, o.id, "2000000")).ok, false);
  assert.equal(engine.state.orders.get(o.id)?.pull, "stashed");
});

test("a SEAL prize with no trust line: the wallet is asked for one, declining loses nothing, and signing lets it through", async () => {
  const { engine, ledger, store } = await setup(ALL_SEAL);
  const o = await pull(engine, ledger);
  assert.equal(o.prize?.token, SEAL_TOKEN);
  const amount = BigInt(o.prize?.amount ?? 0);
  assert.ok(amount > 0n);
  const answer = await engine.redeem(PLAYER, o.id);
  assert.equal(answer.ok, false);
  assert.equal((answer as { code: string }).code, "needs_trustline");
  const tx = (answer as { tx: Record<string, unknown> }).tx;
  assert.equal(tx.TransactionType, "TrustSet");
  assert.deepEqual({ currency: (tx.LimitAmount as { currency: string }).currency, issuer: (tx.LimitAmount as { issuer: string }).issuer }, { currency: SEAL_CURRENCY, issuer: SEAL_ISSUER });
  // Declined: nothing moved and nothing is lost, however long it sits.
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(o.id)?.pull, "stashed");
  assert.equal(tokenOwed(engine.state, SEAL_TOKEN), amount);
  // Signed.
  ledger.userSubmit({ ...(tx as object), Account: PLAYER } as never);
  ledger.close();
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await run(engine, ledger, 4);
  assert.equal(engine.state.orders.get(o.id)?.pull, "redeemed");
  assert.equal(ledger.tokenBalance(SPEC, PLAYER), amount);
  assert.equal(tokenOwed(engine.state, SEAL_TOKEN), 0n);
  const log = await events(store);
  const replay = replayLog(log);
  assert.ok(replay.ok, JSON.stringify(replay));
  const chainCheck = await verifyAgainstChain(log, ledger.chain, TREASURY, 100);
  assert.ok(chainCheck.ok, JSON.stringify(chainCheck));
});

test("a trust line dropped after redeeming goes back to the stash, and one on its way is left for the ledger to settle", async () => {
  const { engine, ledger } = await setup(ALL_SEAL);
  const o = await pull(engine, ledger);
  ledger.setLine(SPEC, PLAYER, 0n);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  ledger.dropLine(SPEC, PLAYER);
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(o.id)?.pull, "stashed");
  assert.equal(engine.state.orders.get(o.id)?.prize?.note, "needs_trustline");
  // Line back, redeem again: paid once.
  ledger.setLine(SPEC, PLAYER, 0n);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await engine.advance(); // Signed and sent, not yet on a ledger.
  assert.equal([...engine.state.intents.values()].filter((i) => i.kind === "prize_redeem").length, 1);
  ledger.dropLine(SPEC, PLAYER);
  await engine.advance();
  assert.equal(engine.state.orders.get(o.id)?.pull, "redeeming", "can't be pulled back while on its way");
  ledger.close();
  await run(engine, ledger, 3);
  // The ledger refused it, so nothing moved, and it's back in the stash.
  assert.equal(engine.state.orders.get(o.id)?.pull, "stashed");
  assert.equal(engine.state.orders.get(o.id)?.prize?.note, "tecPATH_DRY");
  assert.equal(ledger.tokenBalance(SPEC, PLAYER), null);
});

test("a redemption the treasury can't cover waits, whole, and holds up nothing else", async () => {
  const { engine, ledger } = await setup(ALL_SEAL, { sealInTreasury: 40_000_000n });
  const o = await pull(engine, ledger);
  const amount = BigInt(o.prize?.amount ?? 0);
  ledger.setLine(SPEC, PLAYER, 0n);
  ledger.setLine(SPEC, TREASURY, amount - 1n);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(o.id)?.pull, "redeeming");
  assert.equal(ledger.tokenBalance(SPEC, PLAYER), 0n);
  ledger.setLine(SPEC, TREASURY, amount);
  await run(engine, ledger, 4);
  assert.equal(engine.state.orders.get(o.id)?.pull, "redeemed");
  assert.equal(ledger.tokenBalance(SPEC, PLAYER), amount);
});

test("selling SEAL pays XRP at the live price, once, the token stays with us, and a stale quote is refused", async () => {
  const { engine, ledger } = await setup(ALL_SEAL);
  const o = await pull(engine, ledger);
  const amount = BigInt(o.prize?.amount ?? 0);
  const q = await engine.quoteSell(PLAYER, o.id);
  assert.ok(q.ok);
  if (!q.ok) return;
  assert.ok(BigInt(q.drops) <= (2_500_000n * 8500n) / 10000n);
  assert.equal((await engine.sell(PLAYER, o.id, (BigInt(q.drops) + 1n).toString())).ok, false);
  assert.equal((await engine.sell(PLAYER, o.id, "0")).ok, false);
  const before = ledger.balance(PLAYER);
  const held = ledger.tokenBalance(SPEC, TREASURY);
  assert.equal((await engine.sell(PLAYER, o.id, q.drops)).ok, true);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, false, "selling and redeeming can't both happen");
  await run(engine, ledger, 4);
  assert.equal(engine.state.orders.get(o.id)?.pull, "sold");
  assert.equal(ledger.balance(PLAYER) - before, BigInt(q.drops));
  assert.equal(ledger.tokenBalance(SPEC, TREASURY), held);
  assert.equal(tokenOwed(engine.state, SEAL_TOKEN), 0n);
  assert.ok(amount > 0n);
});

test("redeeming blocks a sale, and a claim can't touch a token prize", async () => {
  const { engine, ledger } = await setup(ALL_XRP);
  const o = await pull(engine, ledger);
  assert.equal((await engine.claim(PLAYER, o.id)).ok, false);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  assert.equal((await engine.sell(PLAYER, o.id, "1000000")).ok, false);
  assert.equal((await engine.redeem("rSOMEONEelseSOMEONEelseSOMEONE", o.id)).ok, false);
});

test("a stale, moved or unreadable price pauses the pack before anything is charged", async () => {
  const { engine, ledger } = await setup(ALL_SEAL);
  const before = ledger.balance(PLAYER);
  ledger.setPoolDown(true);
  ledger.close();
  let q = await engine.createOrder(PLAYER, PRICE);
  assert.equal((q as { code?: string }).code, "prize_paused");
  ledger.setPoolDown(false);
  ledger.setPool(SPEC, (BigInt(POOL_XRP) * 12n / 10n).toString(), POOL_TOKEN);
  ledger.close();
  q = await engine.createOrder(PLAYER, PRICE);
  assert.equal((q as { code?: string }).code, "prize_paused");
  ledger.setIssuer(SEAL_ISSUER, { globalFreeze: true, transferRate: 0, clawback: false });
  assert.equal(ledger.balance(PLAYER), before);
});

test("an issuer that can freeze, skim or claw back pauses the pack", async () => {
  for (const bad of [{ globalFreeze: true, transferRate: 0, clawback: false }, { globalFreeze: false, transferRate: 1_020_000_000, clawback: false }, { globalFreeze: false, transferRate: 0, clawback: true }]) {
    const { engine, ledger } = await setup(ALL_SEAL);
    ledger.setIssuer(SEAL_ISSUER, bad);
    ledger.close();
    assert.equal(((await engine.createOrder(PLAYER, PRICE)) as { code?: string }).code, "prize_paused");
  }
});

test("too little of a token, or of XRP, to pay what's already promised closes the pack", async () => {
  const seal = await setup(ALL_SEAL, { sealInTreasury: 1n });
  assert.equal(((await seal.engine.createOrder(PLAYER, PRICE)) as { code?: string }).code, "restocking");
  const xrp = await setup({ ...ALL_XRP, prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 10000, valueDrops: "500000000" }] }, { treasuryXrp: 100, drops: "600000000" });
  assert.equal(((await xrp.engine.createOrder(PLAYER, PRICE)) as { code?: string }).code, "restocking");
});

test("the float can't be over-promised: a draw SEAL can't cover pays its value in XRP, and a redemption never runs short", async () => {
  // Enough to promise one place today. Then the float leaves before the draw.
  const { engine, ledger } = await setup(ALL_SEAL, { sealInTreasury: 5_000_000n });
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.ok(quote.ok, JSON.stringify(quote));
  if (!quote.ok) return;
  ledger.userSubmit(quote.tx as never);
  ledger.setLine(SPEC, TREASURY, 1n);
  await run(engine, ledger, 6);
  const o = engine.state.orders.get(quote.order.id)!;
  assert.equal(o.status, "drawn");
  assert.equal(o.prize?.token, XRP_TOKEN);
  assert.equal(o.prize?.amount, o.prize?.valueDrops);
  assert.equal(tokenOwed(engine.state, SEAL_TOKEN), 0n);
});

test("an XRP prize past what the treasury can pay is struck anyway, owed, and paid after a top-up: a win isn't voided", async () => {
  const { engine, ledger, store } = await setup({ ...ALL_XRP, prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 10000, valueDrops: "50000000" }] }, { treasuryXrp: 70, drops: PACK_60 });
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.ok(quote.ok, JSON.stringify(quote));
  if (!quote.ok) return;
  ledger.userSubmit(quote.tx as never);
  ledger.close();
  await engine.advance();
  // The treasury's XRP goes elsewhere before the draw.
  ledger.fund(PLAYER, 0);
  ledger.userSubmit({ TransactionType: "Payment", Account: TREASURY, Destination: "rSOMEWHEREelseSOMEWHEREelseSOM", Amount: "100000000" } as never);
  await run(engine, ledger, 6);
  const o = engine.state.orders.get(quote.order.id);
  assert.equal(o?.prize?.amount, "50000000");
  assert.equal(o?.prize?.owed, true);
  assert.equal(engine.state.refunds.size, 0);
  assert.equal(o?.pull, "redeeming");
  ledger.fund(TREASURY, 100);
  await run(engine, ledger, 3);
  assert.equal(engine.state.orders.get(quote.order.id)?.pull, "redeemed");
  const replay = replayLog(await store.readFrom(0));
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("the sell-back guard counts token prizes at what they really pay", async () => {
  const { engine, ledger } = await setup({ bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 5000, valueDrops: "7800000" }], tokens: [] });
  // Half the pulls pay 7.8 XRP, the other half an NFT marked 2 XRP: 4.65 XRP on an 8 XRP pack. Open.
  assert.equal((await engine.createOrder(PLAYER, PRICE)).ok, true);
  const high = await setup({ bandBps: [10000, 0, 0, 0, 0], prizeTable: [{ band: 0, token: XRP_TOKEN, bps: 9500, valueDrops: "8000000" }], tokens: [] });
  // 95% of pulls paying a pack's whole price in XRP is more than the guard allows.
  assert.equal(((await high.engine.createOrder(PLAYER, PRICE)) as { code?: string }).code, "restocking");
  assert.ok(ledger);
});

test("every shelf pack passes the sell-back guard at the plan's marks", () => {
  // Marks by band from the plan, in XRP. A mistyped ladder fails here before it can close a pack.
  const marks: Record<number, number[]> = { 5: [0, 2.95, 9.44, 51.28, 90.87], 10: [0, 5.3, 15.3, 55.02, 215.88] };
  for (const p of SHELF_PRICES) {
    const l = NFT_LADDERS[p];
    let avg = 0;
    l.bandBps.forEach((b, i) => {
      const rows = l.tokenPrizes.filter((r) => r.band === i);
      const share = rows.reduce((a, r) => a + r.bps, 0) / 10000;
      avg += (b / 10000) * ((1 - share) * marks[p][i] * 0.85 + rows.reduce((a, r) => a + (r.bps / 10000) * r.xrp, 0));
    });
    assert.ok(avg / l.xrp < 0.95, `$\${p}: \${avg / l.xrp}`);
  }
});

test("the float status says when it's low and which packs it has paused", async () => {
  const { engine, ledger } = await setup(ALL_SEAL, { sealInTreasury: 10_000_000_000n });
  let st = await engine.sealFloatStatus();
  assert.ok(st);
  assert.equal(st?.low, false);
  assert.deepEqual(st?.pauses, []);
  // A little over one prize is left: under the low-water mark, still open.
  ledger.setLine(SPEC, TREASURY, 80_000_000n);
  st = await engine.sealFloatStatus();
  assert.equal(st?.low, true);
  assert.deepEqual(st?.pauses, []);
  // Under one prize: paused, and an order is refused with nothing charged.
  ledger.setLine(SPEC, TREASURY, 1_000_000n);
  st = await engine.sealFloatStatus();
  assert.deepEqual(st?.pauses, [PRICE]);
  assert.equal(((await engine.createOrder(PLAYER, PRICE)) as { code?: string }).code, "restocking");
});

test("property: however the price and the float move, what's struck never passes what the treasury holds", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.record({ move: fc.integer({ min: 92, max: 108 }), float: fc.integer({ min: 0, max: 40 }) }), { minLength: 2, maxLength: 7 }), async (steps) => {
      const { engine, ledger } = await setup(ALL_SEAL, { sealInTreasury: 8_000_000n, stock: 12 });
      let px = BigInt(POOL_XRP);
      for (const s of steps) {
        px = (px * BigInt(s.move)) / 100n;
        ledger.setPool(SPEC, px.toString(), POOL_TOKEN);
        const quote = await engine.createOrder(PLAYER, PRICE);
        if (quote.ok) ledger.userSubmit(quote.tx as never);
        ledger.setLine(SPEC, TREASURY, (ledger.tokenBalance(SPEC, TREASURY) ?? 0n) + BigInt(s.float) * 100_000n);
        await run(engine, ledger, 5);
        assert.ok(tokenOwed(engine.state, SEAL_TOKEN) <= (ledger.tokenBalance(SPEC, TREASURY) ?? 0n), "owes more than it holds");
      }
    }),
    { numRuns: 25 },
  );
});

test("a price that moved between paying and the draw pays the row's value in XRP; the log proves why", async () => {
  const { engine, ledger, store } = await setup(ALL_SEAL);
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.ok(quote.ok);
  if (!quote.ok) return;
  ledger.userSubmit(quote.tx as never);
  ledger.close();
  ledger.setPool(SPEC, (BigInt(POOL_XRP) * 12n / 10n).toString(), POOL_TOKEN);
  await run(engine, ledger, 6);
  const o = engine.state.orders.get(quote.order.id)!;
  assert.equal(o.status, "drawn");
  assert.equal(o.prize?.token, XRP_TOKEN);
  assert.equal(o.prize?.amount, "2500000");
  assert.equal(engine.state.refunds.size, 0);
  const drawn = (await events(store)).find((e) => e.type === "pull_prize_drawn");
  assert.equal(drawn?.type === "pull_prize_drawn" && drawn.data.paidInXrp?.code, "price_moved");
  const replay = replayLog(await events(store));
  assert.ok(replay.ok, JSON.stringify(replay));
});

test("a price that can't be read waits; it's never struck on a guess", async () => {
  const { engine, ledger } = await setup(ALL_SEAL);
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.ok(quote.ok);
  if (!quote.ok) return;
  ledger.userSubmit(quote.tx as never);
  ledger.close();
  ledger.setPoolDown(true);
  await run(engine, ledger, 8);
  assert.equal(engine.state.orders.get(quote.order.id)?.status, "paid");
  ledger.setPoolDown(false);
  await run(engine, ledger, 2);
  assert.equal(engine.state.orders.get(quote.order.id)?.status, "drawn");
});

test("a price that stays unreadable past the wait pays the row's value in XRP", async () => {
  const { engine, ledger } = await setup(ALL_SEAL);
  const quote = await engine.createOrder(PLAYER, PRICE);
  assert.ok(quote.ok);
  if (!quote.ok) return;
  ledger.userSubmit(quote.tx as never);
  ledger.close();
  ledger.setPoolDown(true);
  await engine.advance();
  ledger.close(STRIKE_WAIT_LEDGERS + 5);
  await run(engine, ledger, 4);
  const o = engine.state.orders.get(quote.order.id)!;
  assert.equal(o.status, "drawn");
  assert.equal(o.prize?.token, XRP_TOKEN);
  assert.equal(engine.state.refunds.size, 0);
});

test("a server crash at any point in a redemption can't pay twice", async () => {
  const { engine, ledger, make } = await setup(ALL_SEAL);
  const o = await pull(engine, ledger);
  ledger.setLine(SPEC, PLAYER, 0n);
  const amount = BigInt(o.prize?.amount ?? 0);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await engine.advance();
  // A second server starts from the log, and both keep going.
  const other = make();
  await other.advance();
  ledger.close();
  await engine.advance();
  await other.advance();
  ledger.close();
  await other.advance();
  await engine.advance();
  assert.equal(ledger.tokenBalance(SPEC, PLAYER), amount);
  await run(other, ledger, 3);
  await run(engine, ledger, 3);
  assert.equal(ledger.tokenBalance(SPEC, PLAYER), amount);
  assert.equal(engine.state.orders.get(o.id)?.pull, "redeemed");
});

test("property: whatever a player does, in any order, a prize pays out at most once and the books balance", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("redeem", "sell", "close", "trust", "untrust", "tick"), { minLength: 3, maxLength: 16 }), fc.boolean(), async (moves, xrpPrize) => {
      const { engine, ledger, store } = await setup(xrpPrize ? ALL_XRP : ALL_SEAL);
      const o = await pull(engine, ledger);
      const amount = BigInt(o.prize?.amount ?? 0);
      const startXrp = ledger.balance(PLAYER);
      for (const m of moves) {
        if (m === "redeem") await engine.redeem(PLAYER, o.id);
        if (m === "sell") {
          const q = await engine.quoteSell(PLAYER, o.id);
          if (q.ok) await engine.sell(PLAYER, o.id, q.drops);
        }
        if (m === "close") ledger.close();
        if (m === "tick") await engine.advance();
        if (m === "trust" && ledger.tokenBalance(SPEC, PLAYER) === null) ledger.setLine(SPEC, PLAYER, 0n);
        if (m === "untrust" && ledger.tokenBalance(SPEC, PLAYER) === 0n) ledger.dropLine(SPEC, PLAYER);
      }
      await run(engine, ledger, 6);
      const pullNow = engine.state.orders.get(o.id)?.pull;
      const gotXrp = ledger.balance(PLAYER) - startXrp;
      const gotToken = ledger.tokenBalance(SPEC, PLAYER) ?? 0n;
      if (xrpPrize) {
        assert.equal(gotXrp, pullNow === "redeemed" ? amount : 0n);
        assert.equal(gotToken, 0n);
      } else {
        assert.equal(gotToken, pullNow === "redeemed" ? amount : 0n);
        if (pullNow === "redeemed") assert.equal(gotXrp, 0n);
        if (pullNow === "stashed") assert.equal(gotXrp, 0n);
      }
      assert.equal(tokenOwed(engine.state, SEAL_TOKEN), !xrpPrize && (pullNow === "stashed" || pullNow === "redeeming" || pullNow === "selling") ? amount : 0n);
      const replay = replayLog(await store.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
    }),
    { numRuns: 40 },
  );
});

test("replay catches a struck amount, a token or a read that was changed, even with every hash redone", async () => {
  const { engine, ledger, store } = await setup(ALL_SEAL);
  await pull(engine, ledger);
  const log = await events(store);
  assert.ok(replayLog(log).ok);
  const reseal = (mutate: (d: Record<string, unknown>) => void): RipEvent[] => {
    const bodies = JSON.parse(JSON.stringify(log)).map((e: RipEvent & Record<string, unknown>) => {
      if (e.type === "pull_prize_drawn") mutate(e.data as unknown as Record<string, unknown>);
      return { type: e.type, data: e.data } as RipEventBody;
    });
    return sealEvents(0, "", bodies, "2026-11-01T00:00:00.000Z");
  };
  assert.ok(replayLog(reseal(() => {})).ok, "resealing alone changes nothing");
  assert.equal(replayLog(reseal((d) => (d.amount = "999999999999"))).ok, false, "amount");
  assert.equal(replayLog(reseal((d) => (d.token = XRP_TOKEN))).ok, false, "token");
  assert.equal(replayLog(reseal((d) => {
    const reads = d.reads as { now: { xrpDrops: string } };
    reads.now.xrpDrops = (BigInt(reads.now.xrpDrops) * 3n).toString();
  })).ok, false, "reads");
});

test("replay refuses an NFT where the roll says a token, and a second payout", async () => {
  const { engine, ledger, store } = await setup(ALL_XRP);
  const o = await pull(engine, ledger);
  assert.equal((await engine.redeem(PLAYER, o.id)).ok, true);
  await run(engine, ledger, 4);
  const log = await events(store);
  assert.ok(replayLog(log).ok);
  const final = log.findIndex((e) => e.type === "tx_final");
  assert.ok(final > 0);
  const intent = log.filter((e) => e.type === "tx_intent" && e.data.kind === "prize_redeem")[0] as Extract<RipEvent, { type: "tx_intent" }>;
  const bodies = log.map((e) => ({ type: e.type, data: e.data }) as RipEventBody);
  const again = sealEvents(0, "", [...bodies, { type: "tx_intent", data: { ...intent.data, id: "prize_redeem:again" } }], "2026-11-01T00:00:00.000Z");
  assert.equal(replayLog(again).ok, false);
});

test("players read SEAL, in plain words", () => {
  assert.equal(prizeName(SEAL_TOKEN, "56300000"), "56,300,000 SEAL");
  assert.equal(prizeName(XRP_TOKEN, "42000000"), "42 XRP");
  assert.equal(prizeName(XRP_TOKEN, "1200000"), "1.2 XRP");
  const tx = trustSetTx(PLAYER, SPEC, 56_300_000n);
  assert.equal(tx.TransactionType, "TrustSet");
  assert.equal((tx.LimitAmount as { issuer: string }).issuer, SEAL_ISSUER);
});

test("band and prize rolls replay from one digest", () => {
  const d = sha256Hex("one");
  assert.equal(bandOf(d, NFT_LADDERS[25].bandBps), bandOf(d, NFT_LADDERS[25].bandBps));
});
