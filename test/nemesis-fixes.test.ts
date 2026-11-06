import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { machineOnSale } from "../src/config/machines.ts";
import { GatewayRefused, simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { collectorCryptGateway, parseOpened, saleRefusal } from "../src/lib/rip/cc-gateway.ts";
import { MAX_SELL_BACK_SHARE, RESTASH_WAIT_MS, createEngine, sellBackShare } from "../src/lib/rip/engine.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import type { RipEvent } from "../src/lib/rip/types.ts";
import { ISSUER, MINTER, TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";
import { addressOf, world } from "./support-routes.ts";

/** The fixes from the audit of 2026-11-02. Each of these failed, or showed the problem, before its fix. */
const PLAYER = addressOf(1);
const ADDRESS = { name: "A Player", street: "1 Main St", city: "Town", region: "NY", zip: "10001", country: "US" };
const TOKEN = "11111111-2222-4333-8444-555555555555";

const usdcAccount = (amount: bigint, owner: PublicKey, closer?: PublicKey) => {
  const b = Buffer.alloc(165);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  if (closer) {
    b.writeUInt32LE(1, 129);
    closer.toBuffer().copy(b, 133);
  }
  return b.toString("base64");
};

test("a sale that hands custody's USDC account to anyone else, or lets anyone else close it, is never signed", () => {
  const custody = Keypair.generate().publicKey;
  const thief = Keypair.generate().publicKey;
  const sale = { custody: custody.toBase58(), gross: 21_250_000n, minNetMicro: "0", usdcBefore: 75_000_000n, solBefore: 10_000_000n, solAfter: { lamports: 10_000_000, owner: "11111111111111111111111111111111" }, maxSolDebit: 5_000_000n, cardStillHeld: false, keys: [] as string[], others: [] as string[] };
  assert.equal(saleRefusal({ ...sale, usdcAfter: { data: [usdcAccount(96_250_000n, custody), "base64"] } }), null);
  assert.match(saleRefusal({ ...sale, usdcAfter: { data: [usdcAccount(96_250_000n, thief), "base64"] } }) ?? "", /controls/);
  assert.match(saleRefusal({ ...sale, usdcAfter: { data: [usdcAccount(96_250_000n, custody, thief), "base64"] } }) ?? "", /controls/);
});

test("a card sale never pays over today's quote: a figure above it gets today's price back, and nothing moves", async () => {
  const w = await world({ cards: true });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  const id = await w.cardPull(me);
  const today = BigInt((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body.drops);
  const over = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: (today + 1n).toString() } });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "price_changed");
  assert.equal(over.body.drops, today.toString());
  assert.equal(w.cardOf(id)?.exit, null);
  const under = (today * 998n) / 1000n;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: under.toString() } })).status, 200);
  assert.equal(w.cardOf(id)?.exit?.drops, under.toString(), "a figure just under today's is what the player accepted");
  await w.pump(5);
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("the sell sheet says the lower price out loud", () => {
  const sheet = readFileSync(new URL("../src/components/live/SellSheet.tsx", import.meta.url), "utf8");
  assert.match(sheet, /the price is lower now/);
  assert.match(sheet, /Nothing was sold/);
});

test("a failure read before it's final isn't believed: the payment could still land, and a refund would follow", async () => {
  let status = "processed";
  const fetchImpl = (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ result: JSON.parse(String(init.body)).method === "getSignatureStatuses" ? { value: [{ err: { InstructionError: [2, "Custom"] }, confirmationStatus: status }] } : {} }))) as typeof fetch;
  const gw = collectorCryptGateway({ custodySecret: Keypair.generate().secretKey, solanaRpc: "https://rpc.test", recipientTokenAccounts: [], maxComputeUnits: 1, maxComputeUnitPriceMicroLamports: 1n, fetchImpl });
  assert.equal(await gw.sourceStatus("s"), "pending");
  status = "confirmed";
  assert.equal(await gw.sourceStatus("s"), "pending");
  status = "finalized";
  assert.equal(await gw.sourceStatus("s"), "failed");
});

test("Collector Crypt saying too many requests isn't a no: a reveal it rate-limits can't turn into a refund", async () => {
  const fetchImpl = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  const gw = collectorCryptGateway({ custodySecret: Keypair.generate().secretKey, solanaRpc: "https://rpc.test", recipientTokenAccounts: [], maxComputeUnits: 1, maxComputeUnitPriceMicroLamports: 1n, fetchImpl });
  await assert.rejects(gw.open("memo"), (e) => !(e instanceof GatewayRefused));
  const no = (async () => new Response(JSON.stringify({ error: "No spin transaction found for memo" }), { status: 400 })) as typeof fetch;
  const real = collectorCryptGateway({ custodySecret: Keypair.generate().secretKey, solanaRpc: "https://rpc.test", recipientTokenAccounts: [], maxComputeUnits: 1, maxComputeUnitPriceMicroLamports: 1n, fetchImpl: no });
  await assert.rejects(real.open("memo"), (e) => e instanceof GatewayRefused);
});

test("Xaman push: a ship approval never rings a phone, and a claim still does", async () => {
  const w = await world({ cards: true, xaman: true });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  const id = await w.cardPull(me);
  await w.secrets.put(`xaman-user-token:${PLAYER}`, TOKEN);
  await w.call("POST", `/api/rip/cards/${id}/ship`, { as: me, body: ADDRESS });
  assert.equal(w.xaman.calls.at(-1)!.txjson.TransactionType, "AccountSet");
  assert.equal(w.xaman.calls.at(-1)!.user_token, undefined);
  await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  await w.pump(2);
  await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  assert.equal(w.xaman.calls.at(-1)!.txjson.TransactionType, "NFTokenAcceptOffer");
  assert.equal(w.xaman.calls.at(-1)!.user_token, TOKEN);
});

function cardSetup(gateway: CardGateway, clock?: () => number) {
  const ledger = testLedger();
  for (const [a, x] of [[TREASURY, 500], [VAULT, 50], [MINTER, 50], [ISSUER, 50], [PLAYER, 500]] as const) ledger.fund(a, x);
  ledger.authorize(ISSUER, MINTER);
  const store = memoryStore();
  const opts = { store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, mirror: { issuer: ISSUER, transferFee: 2000, taxon: 1, origin: "https://example.test" }, ...(clock ? { now: () => new Date(clock()) } : {}) };
  const engine = createEngine({ ...opts, gateway });
  const run = async (e: { advance: () => Promise<unknown> }, n = 4) => {
    for (let i = 0; i < n; i++) {
      await e.advance();
      ledger.close();
      await e.advance();
    }
  };
  return { ledger, store, opts, engine, run };
}

test("taking an offer back with the card line off says no, and leaves the card where it is", async () => {
  const { ledger, opts, engine, run } = cardSetup(simulatedGateway());
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", 1.25);
  assert.ok(q.ok);
  ledger.userSubmit(q.tx as never);
  await run(engine);
  await engine.claimCard(PLAYER, q.order.id);
  await run(engine, 2);
  assert.equal(engine.state.cards.get(q.order.id)?.hold, "offered");
  const off = createEngine(opts);
  await off.sync();
  assert.equal(((await off.takeBackCard(PLAYER, q.order.id)) as { code: string }).code, "card_off");
  assert.equal(off.state.cards.get(q.order.id)?.hold, "offered");
});

test("a source payment past its life: a reveal means it landed, so it's opened and not refunded; a no from Collector Crypt refunds", async () => {
  for (const answer of ["revealed", "refused", "down"] as const) {
    let t = Date.parse("2026-11-02T00:00:00Z");
    const base = simulatedGateway();
    let expired = false;
    const gateway: CardGateway = {
      ...base,
      sourceStatus: async () => "pending",
      sourceExpired: async () => expired,
      open: async (memo) => {
        if (!expired) return null;
        if (answer === "revealed") return base.open(memo);
        if (answer === "refused") throw new GatewayRefused("/api/openPack 400");
        throw new Error("/api/openPack unavailable");
      },
    };
    const { ledger, engine, store, run } = cardSetup(gateway, () => t);
    await engine.advance();
    const q = await engine.createCardOrder(PLAYER, "pokemon_25", 1.25);
    assert.ok(q.ok);
    const before = ledger.balance(PLAYER);
    ledger.userSubmit(q.tx as never);
    await run(engine, 2);
    assert.equal(engine.state.cards.get(q.order.id)?.status, "signed");
    t += RESTASH_WAIT_MS + 1000;
    expired = true;
    await run(engine, 3);
    const c = engine.state.cards.get(q.order.id)!;
    if (answer === "revealed") {
      assert.equal(c.status, "held");
      assert.equal(engine.state.refunds.size, 0);
    } else if (answer === "refused") {
      assert.equal(c.status, "refunded");
      assert.ok(ledger.balance(PLAYER) >= before - 1000n);
    } else {
      assert.equal(c.status, "signed", "a reveal we couldn't read isn't a no");
      assert.equal(engine.state.refunds.size, 0);
    }
    assert.ok(replayLog(await store.readFrom(0)).ok);
  }
});

test("mainnet sells only a machine on the list: an empty list closes the card line, and testnet has no list", async () => {
  assert.equal(machineOnSale("pokemon_25, comic_50", true, "comic_50"), true);
  assert.equal(machineOnSale("pokemon_25", true, "comic_50"), false);
  for (const empty of [undefined, null, "", " , "]) {
    assert.equal(machineOnSale(empty, true, "pokemon_25"), false);
    assert.equal(machineOnSale(empty, false, "pokemon_25"), true);
  }
  const w = await world({ cards: true, env: { SEAL_MACHINE_CODES: "" } });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  const r = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25", acceptedTerms: true } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "no_machine");
  assert.equal(w.engine.state.cards.size, 0);
});

test("a season can't open while a checkout is held, whichever kind of hold, and it can once the quote lapses", async () => {
  const w = await world({});
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  await w.newOrder(me);
  const head = w.engine.state.head;
  assert.equal(await w.engine.openSeason(5, "4000000", 1.25), null);
  assert.equal(w.engine.state.head, head, "nothing logged");
  for (let i = 0; i < 90; i++) w.ledger.close();
  await w.pump(1);
  assert.ok(await w.engine.openSeason(5, "4000000", 1.25));
});

test("a sale the treasury can't pay reaches the owner while Collector Crypt's window is open", async () => {
  const w = await world({ cards: true, treasuryXrp: 12 });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  const id = await w.cardPull(me);
  const tick = async () => (await w.call("GET", "/api/rip/tick", { headers: { authorization: "Bearer route-test-cron-secret" } } as never)).body.alerts as string[];
  const c = w.cardOf(id)!;
  c.insuredMicro = "16430000000";
  c.instantBuybackPct = 90;
  assert.ok((await tick()).includes("card_sale_uncovered"));
  c.insuredMicro = "1000000";
  assert.ok(!(await tick()).includes("card_sale_uncovered"));
});

test("WATCH 250: a real watch's record reads as a card, with its insured value, grader and direct picture", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/cc/watch-asset-20261102.json", import.meta.url), "utf8")) as { mint: string; content: unknown };
  const memo = "cc-watch";
  const out = parseOpened({ success: true, memo, nft_address: f.mint, transactionSignature: "s", rarity: "Epic", nftWon: { content: f.content } }, memo);
  assert.equal(out?.mint, f.mint);
  assert.equal(out?.insuredMicro, "16430000000");
  assert.match(out?.grade ?? "", /^Wristcheck/);
  assert.ok(out?.img.startsWith("https://nft.collectorcrypt.com/"));
});

test("/fair replays the public log as it stood after season 5-3 opened, with every season and the real card", () => {
  const { events } = JSON.parse(readFileSync(new URL("./fixtures/mainnet-log-20261102-5-3.json", import.meta.url), "utf8")) as { events: RipEvent[] };
  const r = replayLog(events);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.state.activeSeason.get(5), "5-3");
  assert.equal(r.state.seasons.get("5-3")?.sellBps, 9506);
  assert.equal(r.state.orders.size, 0, "no pack had been ordered, so no season switched under anyone");
  assert.equal(r.state.cards.get("df01391ebcd619c9b61b88771e548e2b")?.hold, "mirrored");
  // Internal, and under the line that closes a pack: an average pull sold back at 95.06% of its mark on this pool.
  const season = r.state.seasons.get("5-3")!;
  const share = sellBackShare(r.state, season, (season.anchorLedger as number) + 1);
  assert.ok(share > 0.9 && share < MAX_SELL_BACK_SHARE, String(share));
});

test("the config route reuses a ledger read, however many hits, and a new log entry reads again", async () => {
  let reads = 0;
  const w = await world({ ledgerReadMs: 60_000, wrapChain: (c) => ({ ...c, validatedLedger: async () => (reads++, c.validatedLedger()) }) });
  await w.open();
  await w.call("GET", "/api/rip/config");
  const before = reads;
  for (let i = 0; i < 20; i++) await w.call("GET", "/api/rip/config");
  assert.ok(reads - before <= 1, `${reads - before} ledger reads for 20 hits`);
  w.fund(w.client(PLAYER));
  await w.newOrder(w.client(PLAYER));
  const after = reads;
  await w.call("GET", "/api/rip/config");
  assert.ok(reads > after, "the log moved, so the ledger is read again");
});
