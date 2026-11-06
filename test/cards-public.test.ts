import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { GatewayRefused, simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { COLLECTOR_CRYPT_SIGNER, ataOf, collectorCryptGateway, paymentRefusal } from "../src/lib/rip/cc-gateway.ts";
import { CARD_STALL_MS, GENERATE_WAIT_MS, RESTASH_WAIT_MS, RETRY_WAIT_LEDGERS, createEngine } from "../src/lib/rip/engine.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { ISSUER, MINTER, TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

/**
 * What it takes to turn cards on for anyone, each written to fail first on 6a8f0c409. The Collector Crypt and Solana answers
 * here are the real ones, read from mainnet on 2026-11-02: see test/fixtures/cc.
 */
const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const BUYER = "rBUYERbuyerBUYERbuyerBUYERbuyer";
const RATE = 1.25;
const mirror = { issuer: ISSUER, transferFee: 2000, taxon: 1, origin: "https://example.test" };
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/cc/generate-pack-20261102.json", import.meta.url), "utf8"));

function setup(opts: { gateway?: CardGateway; treasuryXrp?: number; minterXrp?: number; clock?: () => number } = {}) {
  const ledger = testLedger();
  for (const [a, x] of [[TREASURY, opts.treasuryXrp ?? 500], [VAULT, 50], [MINTER, opts.minterXrp ?? 50], [ISSUER, 50], [PLAYER, 500], [BUYER, 100]] as const) ledger.fund(a, x);
  ledger.authorize(ISSUER, MINTER);
  const store = memoryStore();
  const gateway = opts.gateway ?? simulatedGateway();
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, gateway, mirror, ...(opts.clock ? { now: () => new Date((opts.clock as () => number)()) } : {}) });
  return { ledger, store, gateway, engine };
}
type Engine = ReturnType<typeof createEngine>;
type Ledger = ReturnType<typeof testLedger>;

async function run(engine: Engine, ledger: Ledger, passes = 4) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

async function pull(engine: Engine, ledger: Ledger) {
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  await run(engine, ledger, 4);
  return q.order.id;
}

/** Pay, and let the next pass see it. */
async function paid(engine: Engine, ledger: Ledger) {
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  ledger.close();
  return q.order;
}

async function mirrored(engine: Engine, ledger: Ledger) {
  const id = await pull(engine, ledger);
  await engine.claimCard(PLAYER, id);
  await run(engine, ledger, 2);
  const offered = engine.state.cards.get(id)!;
  ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offered.mirror!.offerId });
  await run(engine, ledger, 2);
  assert.equal(engine.state.cards.get(id)!.hold, "mirrored");
  return { id, nftId: offered.mirror!.nftId };
}

const txsOf = (ledger: Ledger, type: string) => ledger.history.filter((t) => t.tx.TransactionType === type);

// The minter's slot: the same loop NM-2 closed on the vault's.

test("a wallet that turns away NFT offers can't loop on the minter's slot, and can still sell", async () => {
  const { ledger, engine, store } = setup();
  const id = await pull(engine, ledger);
  ledger.refuseOffers(PLAYER, "tecNO_PERMISSION");
  assert.deepEqual(await engine.claimCard(PLAYER, id), { ok: true });
  await run(engine, ledger, 2);
  const c = engine.state.cards.get(id)!;
  assert.equal(c.hold, "stashed", "the mint failed and moved nothing");
  assert.equal(txsOf(ledger, "NFTokenMint").length, 1);

  const logged = (await store.readFrom(0)).length;
  const again = await engine.claimCard(PLAYER, id);
  assert.equal(again.ok, false);
  assert.equal((again as { code: string }).code, "try_later");
  await run(engine, ledger, 3);
  assert.equal(txsOf(ledger, "NFTokenMint").length, 1, "no second try inside the wait");
  assert.equal(engine.state.cards.get(id)!.hold, "stashed");
  // Refused claims write nothing to the log, and the log grows only by whatever else ran.
  assert.ok((await store.readFrom(0)).filter((e) => e.seq > logged).every((e) => e.type !== "mirror_requested"));

  // Selling needs no mint, so the wait doesn't hold the card up.
  const q = await engine.cardSellPrice(PLAYER, id, RATE);
  assert.ok(q.ok);
  ledger.refuseOffers(PLAYER, null);
  for (let i = 0; i < RETRY_WAIT_LEDGERS; i++) ledger.close();
  assert.deepEqual(await engine.claimCard(PLAYER, id), { ok: true }, "after the wait it can try again");
  await run(engine, ledger, 2);
  assert.equal(engine.state.cards.get(id)!.hold, "offered");
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("a burn that fails on the ledger waits too: a holder moving the mirror around can't loop on the minter's slot", async () => {
  const { ledger, engine, store } = setup();
  const { id, nftId } = await mirrored(engine, ledger);
  const q = await engine.cardSellPrice(PLAYER, id, RATE);
  assert.ok(q.ok);
  assert.deepEqual(await engine.sellCard(PLAYER, id, q), { ok: true });
  // It moves on before the burn lands, so the burn fails.
  ledger.mintTo(nftId, BUYER);
  await run(engine, ledger, 2);
  const c = engine.state.cards.get(id)!;
  assert.equal(c.hold, "mirrored");
  assert.equal(c.exit, null);
  assert.equal(txsOf(ledger, "NFTokenBurn").length, 1);

  const b = await engine.cardSellPrice(BUYER, id, RATE);
  assert.ok(b.ok);
  const sell = await engine.sellCard(BUYER, id, b);
  assert.equal((sell as { code: string }).code, "try_later");
  const ship = await engine.shipAuthorization(BUYER, id, "hash");
  assert.equal((ship as { code: string }).code, "try_later");
  await run(engine, ledger, 3);
  assert.equal(txsOf(ledger, "NFTokenBurn").length, 1, "no second burn inside the wait");

  for (let i = 0; i < RETRY_WAIT_LEDGERS; i++) ledger.close();
  const later = await engine.cardSellPrice(BUYER, id, RATE);
  assert.ok(later.ok);
  assert.deepEqual(await engine.sellCard(BUYER, id, later), { ok: true });
  await run(engine, ledger, 5);
  assert.equal(engine.state.cards.get(id)!.hold, "sold");
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("property: however often and whenever a refusing wallet asks, the minter sends at most one mint per wait", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 120 }), { minLength: 1, maxLength: 12 }), async (gaps) => {
      const { ledger, engine } = setup();
      const id = await pull(engine, ledger);
      ledger.refuseOffers(PLAYER, "tecNO_PERMISSION");
      const start = ledger.ledger();
      for (const gap of gaps) {
        await engine.claimCard(PLAYER, id);
        await run(engine, ledger, 2);
        for (let i = 0; i < gap; i++) ledger.close();
      }
      const span = ledger.ledger() - start;
      const mints = txsOf(ledger, "NFTokenMint").length;
      assert.ok(mints <= 1 + Math.floor(span / RETRY_WAIT_LEDGERS), `${mints} mints in ${span} ledgers`);
      assert.equal(engine.state.cards.get(id)!.everMinted, 0);
      return true;
    }),
    { numRuns: 20 },
  );
});

// The pipeline's clock: a provider's transaction dies about a minute after it's built.

test("one pass takes a paid card from the payment to its source payment on the wire, or a page closed after paying misses the blockhash", async () => {
  const base = simulatedGateway();
  const sends: string[] = [];
  const gateway: CardGateway = { ...base, send: async (bytes, signature) => (sends.push(signature), base.send(bytes, signature)) };
  const { ledger, engine } = setup({ gateway });
  const order = await paid(engine, ledger);
  await engine.advance();
  const c = engine.state.cards.get(order.id)!;
  assert.equal(c.status, "signed");
  assert.deepEqual(sends, [c.signature], "generated, signed and sent in that one pass");
  await engine.advance();
  assert.equal(engine.state.cards.get(order.id)!.status, "held", "and the next pass takes it as far as the source allows");
});

test("a source payment that failed on Solana moved nothing, so the XRP goes back whole without a person", async () => {
  const base = simulatedGateway();
  const gateway: CardGateway = { ...base, sourceStatus: async () => "failed" };
  const { ledger, engine, store } = setup({ gateway });
  const before = ledger.balance(PLAYER);
  const order = await paid(engine, ledger);
  await run(engine, ledger, 3);
  const c = engine.state.cards.get(order.id)!;
  assert.equal(c.status, "refunded");
  assert.equal([...engine.state.refunds.values()].find((r) => r.order === c.id)?.reason, "source_failed");
  assert.equal(ledger.balance(PLAYER), before - 12n, "only the network fee");
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("a source payment that can no longer land goes back whole, only after the wait, and never while it may still land", async () => {
  let t = Date.parse("2026-11-02T00:00:00Z");
  const base = simulatedGateway();
  let dead: boolean | "unreadable" = false;
  const sends: string[] = [];
  const gateway: CardGateway = {
    ...base,
    sourceStatus: async () => "pending",
    send: async (_b, s) => void sends.push(s),
    sourceExpired: async () => {
      if (dead === "unreadable") throw new Error("Solana is down");
      return dead;
    },
    // Collector Crypt's real answer for a pack it never saw paid: 400, "No spin transaction found for memo".
    open: async () => {
      throw new GatewayRefused("/api/openPack 400");
    },
  };
  const { ledger, engine, store } = setup({ gateway, clock: () => t });
  const order = await paid(engine, ledger);
  await run(engine, ledger, 2);
  assert.equal(engine.state.cards.get(order.id)!.status, "signed");
  dead = true;
  t += RESTASH_WAIT_MS - 1000;
  await run(engine, ledger, 1);
  assert.equal(engine.state.cards.get(order.id)!.status, "signed", "inside the wait nothing is believed");

  t += 2000;
  dead = false;
  await run(engine, ledger, 1);
  assert.equal(engine.state.cards.get(order.id)!.status, "signed", "still able to land: it keeps being sent");
  const sentSoFar = sends.length;
  assert.ok(sentSoFar > 1);

  dead = "unreadable";
  await run(engine, ledger, 1);
  assert.equal(engine.state.cards.get(order.id)!.status, "signed", "a failed read proves nothing");

  dead = true;
  const before = ledger.balance(PLAYER);
  await run(engine, ledger, 3);
  const c = engine.state.cards.get(order.id)!;
  assert.equal(c.status, "refunded");
  assert.equal([...engine.state.refunds.values()].find((r) => r.order === c.id)?.reason, "source_expired");
  assert.equal(ledger.balance(PLAYER), before + BigInt(c.drops));
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("if Solana can't be read for half an hour, the card reaches a person and isn't refunded on a guess", async () => {
  let t = Date.parse("2026-11-02T00:00:00Z");
  const base = simulatedGateway();
  const gateway: CardGateway = { ...base, sourceStatus: async () => { throw new Error("down"); }, sourceExpired: async () => { throw new Error("down"); } };
  const { ledger, engine } = setup({ gateway, clock: () => t });
  const order = await paid(engine, ledger);
  await run(engine, ledger, 2);
  t += CARD_STALL_MS + 1000;
  await run(engine, ledger, 1);
  const c = engine.state.cards.get(order.id)!;
  assert.equal(c.status, "review");
  assert.equal(c.review, "stalled_at_signed");
});

test("a lost answer to generate moved no money, so it refunds whole and never asks twice", async () => {
  let calls = 0;
  const gateway: CardGateway = {
    ...simulatedGateway(),
    generate: async () => {
      calls++;
      throw new Error("timeout");
    },
  };
  const { ledger, engine, store } = setup({ gateway });
  const before = ledger.balance(PLAYER);
  const order = await paid(engine, ledger);
  await run(engine, ledger, 4);
  const c = engine.state.cards.get(order.id)!;
  assert.equal(c.status, "refunded");
  assert.equal(calls, 1);
  assert.equal([...engine.state.refunds.values()].find((r) => r.order === c.id)?.reason, "source_unknown");
  assert.equal(ledger.balance(PLAYER), before - 12n, "only the network fee");
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("a server that died mid-generate: the order waits for it, then refunds whole, because nothing can be signed without an answer", async () => {
  let t = Date.parse("2026-11-02T00:00:00Z");
  const { ledger, engine, store } = setup({ clock: () => t });
  const before = ledger.balance(PLAYER);
  const order = await paid(engine, ledger);
  // The other server took it, logged card_generating, and was never heard from again.
  const stuck = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, gateway: { ...simulatedGateway(), generate: () => new Promise(() => {}) }, mirror, now: () => new Date(t) });
  void stuck.advance();
  await new Promise((r) => setTimeout(r, 30));
  await engine.sync();
  assert.equal(engine.state.cards.get(order.id)!.status, "generating");
  await engine.advance();
  assert.equal(engine.state.cards.get(order.id)!.status, "generating", "it might still answer");
  t += GENERATE_WAIT_MS + 1000;
  await run(engine, ledger, 3);
  assert.equal(engine.state.cards.get(order.id)!.status, "refunded");
  assert.equal(ledger.balance(PLAYER), before - 12n);
});

// Strangers reaching a provider that says no.

test("no instant buyback right now is an answer, not a server error", async () => {
  const base = simulatedGateway();
  let mode: "no" | "refused" | "ok" = "no";
  const gateway: CardGateway = {
    ...base,
    sellQuote: async (m, i, p) => {
      if (mode === "no") throw new Error("no instant buyback right now");
      if (mode === "refused") throw new GatewayRefused("/api/buyback/available 404");
      return base.sellQuote(m, i, p);
    },
  };
  const { ledger, engine } = setup({ gateway });
  const id = await pull(engine, ledger);
  const a = await engine.cardSellPrice(PLAYER, id, RATE);
  assert.equal((a as { code: string }).code, "no_buyback");
  mode = "refused";
  assert.equal(((await engine.cardSellPrice(PLAYER, id, RATE)) as { code: string }).code, "no_buyback");
  mode = "ok";
  assert.ok((await engine.cardSellPrice(PLAYER, id, RATE)).ok);
});

test("a claim while Solana can't be read says so and moves nothing", async () => {
  const base = simulatedGateway();
  let down = false;
  const gateway: CardGateway = { ...base, prove: async (m) => { if (down) throw new Error("down"); return base.prove(m); } };
  const { ledger, engine } = setup({ gateway });
  const id = await pull(engine, ledger);
  down = true;
  const r = await engine.claimCard(PLAYER, id);
  assert.equal((r as { code: string }).code, "custody");
  const c = engine.state.cards.get(id)!;
  assert.equal(c.hold, "stashed");
  assert.equal(c.status, "held", "a failed read isn't a missing card");
});

// What the owner hears.

test("the sweep names cards held for a person, a float too low to sell any pack, low gas, a short minter and a card payout waiting on XRP", async () => {
  let float = 400_000_000n;
  let lamports = 50_000_000n;
  const gateway: CardGateway = { ...simulatedGateway(), floatMicro: async () => float, gasLamports: async () => lamports };
  const { ledger, engine } = setup({ gateway });
  const codes = async () => (await engine.opsAlerts()).map((a) => a.code);
  assert.deepEqual(await codes(), []);
  float = 24_000_000n;
  assert.ok((await codes()).includes("card_float"));
  float = 400_000_000n;
  lamports = 1_000n;
  assert.ok((await codes()).includes("custody_sol"));
  lamports = 50_000_000n;
  assert.deepEqual(await codes(), []);

  const short = setup({ minterXrp: 1 });
  assert.ok((await short.engine.opsAlerts()).some((a) => a.code === "minter_low"));
  void ledger;
});

test("a card sitting in review raises an alert, and so does a sold card whose XRP can't go out yet", async () => {
  let t = Date.parse("2026-11-02T00:00:00Z");
  const { ledger, engine } = setup({ gateway: { ...simulatedGateway(), open: async () => null }, clock: () => t });
  const order = await paid(engine, ledger);
  await run(engine, ledger, 3);
  t += CARD_STALL_MS + 1000;
  await run(engine, ledger, 1);
  assert.equal(engine.state.cards.get(order.id)!.status, "review");
  assert.ok((await engine.opsAlerts()).find((a) => a.code === "cards_review")?.text.includes("/admin"));

  const s = setup({ treasuryXrp: 100 });
  const id = await pull(s.engine, s.ledger);
  const q = await s.engine.cardSellPrice(PLAYER, id, RATE);
  assert.ok(q.ok);
  assert.deepEqual(await s.engine.sellCard(PLAYER, id, q), { ok: true });
  s.ledger.setBalance(TREASURY, 11);
  await run(s.engine, s.ledger, 3);
  assert.equal(s.engine.state.cards.get(id)!.hold, "selling");
  assert.ok((await s.engine.opsAlerts()).some((a) => a.code === "card_payout_waiting"));
});

test("custody status for the admin page reads the float and the gas, and a failed read says unknown", async () => {
  const gateway: CardGateway = { ...simulatedGateway(), floatMicro: async () => 25_000_000n, gasLamports: async () => { throw new Error("down"); } };
  const { engine } = setup({ gateway });
  assert.deepEqual(await engine.custodyStatus(), { usdcMicro: "25000000", lamports: null });
});

// The real provider's real answers.

const custody = Keypair.generate();
const provider = new PublicKey(COLLECTOR_CRYPT_SIGNER);
const recipient = Keypair.generate().publicKey;
const rules = { custody: custody.publicKey, memo: "m1", priceMicro: 25_000_000n, recipients: [recipient.toBase58()], maxComputeUnits: 400_000, maxUnitPrice: 2_000_000n };

function build(payer: PublicKey, other?: PublicKey) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(25_000_000n, 1);
  data[9] = 6;
  const transfer = new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: ataOf(custody.publicKey, USDC), isSigner: false, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: other ?? custody.publicKey, isSigner: true, isWritable: false },
      { pubkey: custody.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const m = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("m1:open") });
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [transfer, m] }).compileToV0Message());
}

test("real generatePack answers pass as they are: Collector Crypt pays the fee for an unfunded custody, a funded custody pays its own", () => {
  for (const name of ["unfunded", "unfundedBigger", "funded"]) {
    const f = fixtures[name];
    const tx = VersionedTransaction.deserialize(Buffer.from(f.transaction, "base64"));
    const refusal = paymentRefusal(tx, { custody: new PublicKey(f.custody), memo: f.memo, priceMicro: BigInt(f.usd * 1e6), recipients: [fixtures.recipient], maxComputeUnits: 400_000, maxUnitPrice: 2_000_000n });
    assert.equal(refusal, null, name);
  }
  const real = fixtures.unfunded;
  const tx = VersionedTransaction.deserialize(Buffer.from(real.transaction, "base64"));
  const strict = { custody: new PublicKey(real.custody), memo: real.memo, priceMicro: 25_000_000n, maxComputeUnits: 400_000, maxUnitPrice: 2_000_000n };
  assert.match(paymentRefusal(tx, { ...strict, recipients: [Keypair.generate().publicKey.toBase58()] }) ?? "", /recipient/);
  assert.match(paymentRefusal(tx, { ...strict, recipients: [fixtures.recipient], priceMicro: 24_000_000n }) ?? "", /amount/);
  assert.match(paymentRefusal(tx, { ...strict, recipients: [fixtures.recipient], custody: Keypair.generate().publicKey }) ?? "", /custody/);
});

test("the fee payer is custody or Collector Crypt's own signer, nobody else, and custody must sign either way", () => {
  assert.equal(paymentRefusal(build(custody.publicKey), rules), null);
  assert.equal(paymentRefusal(build(provider), rules), null);
  assert.match(paymentRefusal(build(Keypair.generate().publicKey), rules) ?? "", /fee payer/);
  const other = Keypair.generate().publicKey;
  assert.match(paymentRefusal(build(provider, other), rules) ?? "", /custody/);
});

test("with Collector Crypt as fee payer, custody signs in its own slot and the transaction id stays the fee payer's", async () => {
  const fetchImpl = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const gw = collectorCryptGateway({ custodySecret: custody.secretKey, solanaRpc: "https://solana.invalid", recipientTokenAccounts: [recipient.toBase58()], maxComputeUnits: 400_000, maxComputeUnitPriceMicroLamports: 2_000_000n, fetchImpl });
  const tx = build(provider);
  const presigned = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
  tx.signatures[0] = presigned;
  const signed = await gw.sign({ memo: "m1", transaction: Buffer.from(tx.serialize()).toString("base64"), usd: 25 });
  const back = VersionedTransaction.deserialize(Buffer.from(signed.bytes, "base64"));
  assert.deepEqual(Buffer.from(back.signatures[0]), Buffer.from(presigned), "the provider's signature is untouched");
  assert.ok(!back.signatures[1].every((b) => b === 0), "custody signed");
  const { default: bs58 } = await import("bs58");
  assert.equal(signed.signature, bs58.encode(presigned));
});

/** Solana's RPC as it answered on 2026-11-02: Core assets aren't SPL mints, and getAsset takes named params. */
function realRpc(input: { assetOwner: string; frozen?: boolean; down?: readonly string[]; mintOwner?: string | null; tokenAmount?: string | null; blockhashValid?: boolean; statusRow?: unknown }) {
  const calls: string[] = [];
  const data = Buffer.alloc(307);
  data[0] = 1;
  new PublicKey(input.assetOwner).toBuffer().copy(data, 1);
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    const reply = (body: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), { status: 200 });
    if (input.down?.includes(method)) return new Response("nope", { status: 503 });
    if (method === "getTokenAccountsByOwner") {
      if (input.mintOwner !== TOKEN.toBase58()) return reply({ error: { code: -32602, message: "Invalid param: could not find mint" } });
      const rows = input.tokenAmount ? [{ pubkey: "TokenAccount1", account: { data: { parsed: { info: { tokenAmount: { amount: input.tokenAmount } } } } } }] : [];
      return reply({ result: { context: { slot: 77 }, value: rows } });
    }
    if (method === "getAsset") {
      if (Array.isArray(params)) return reply({ error: { code: -32602, message: "invalid type: map, expected a string at line 1 column 1" } });
      return reply({ result: { interface: "MplCoreAsset", ownership: { frozen: !!input.frozen, delegated: true, owner: input.assetOwner } } });
    }
    if (method === "getAccountInfo") {
      if (input.mintOwner === null) return reply({ result: { context: { slot: 9 }, value: null } });
      return reply({ result: { context: { slot: 464616190 }, value: { owner: input.mintOwner ?? CORE, data: [data.toString("base64"), "base64"], lamports: 1, executable: false, rentEpoch: 0 } } });
    }
    if (method === "isBlockhashValid") return reply({ result: { context: { slot: 9 }, value: input.blockhashValid ?? false } });
    if (method === "getSignatureStatuses") return reply({ result: { context: { slot: 9 }, value: [input.statusRow ?? null] } });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const gatewayOn = (fetchImpl: typeof fetch) => collectorCryptGateway({ custodySecret: custody.secretKey, solanaRpc: "https://solana.test", recipientTokenAccounts: [recipient.toBase58()], maxComputeUnits: 400_000, maxComputeUnitPriceMicroLamports: 2_000_000n, fetchImpl });
const CARD = "27N5AzUaipWqKa63g16zbJVu4fvG8HwsBwhztS2WZY81";

test("every Collector Crypt card today is a Core asset: custody is proven from the finalized account, on a real RPC's real answers", async () => {
  const held = await gatewayOn(realRpc({ assetOwner: custody.publicKey.toBase58() }).fetchImpl).prove(CARD);
  assert.equal(held.held, true);
  assert.equal(held.slot, 464616190);
  assert.ok(held.proof.length === 64);
  const gone = await gatewayOn(realRpc({ assetOwner: Keypair.generate().publicKey.toBase58() }).fetchImpl).prove(CARD);
  assert.equal(gone.held, false);
  const frozen = await gatewayOn(realRpc({ assetOwner: custody.publicKey.toBase58(), frozen: true }).fetchImpl).prove(CARD);
  assert.equal(frozen.held, false, "a frozen card can't be promised");
});

test("an SPL card still reads from its token account", async () => {
  const me = custody.publicKey.toBase58();
  const held = await gatewayOn(realRpc({ assetOwner: me, mintOwner: TOKEN.toBase58(), tokenAmount: "1" }).fetchImpl).prove(CARD);
  assert.equal(held.held, true);
  assert.equal(held.slot, 77);
  const gone = await gatewayOn(realRpc({ assetOwner: me, mintOwner: TOKEN.toBase58(), tokenAmount: null }).fetchImpl).prove(CARD);
  assert.equal(gone.held, false);
});

test("custody that can't be read throws: it never reads as not held, which a sale would count as done", async () => {
  const me = custody.publicKey.toBase58();
  await assert.rejects(() => gatewayOn(realRpc({ assetOwner: me, down: ["getAccountInfo"] }).fetchImpl).prove(CARD));
  await assert.rejects(() => gatewayOn(realRpc({ assetOwner: me, down: ["getAsset"] }).fetchImpl).prove(CARD));
  await assert.rejects(() => gatewayOn(realRpc({ assetOwner: me, mintOwner: null }).fetchImpl).prove(CARD), "no account at all is a question, not a sale");
});

test("a frozen card still in custody isn't a finished sale: the sale waits, and no XRP can follow", async () => {
  const gw = gatewayOn(realRpc({ assetOwner: custody.publicKey.toBase58(), frozen: true }).fetchImpl);
  await assert.rejects(() => gw.sellBack(CARD, "sell-1"), /frozen/);
});

test("a card already gone from custody is a sale done, with nothing sent again", async () => {
  const { fetchImpl } = realRpc({ assetOwner: Keypair.generate().publicKey.toBase58() });
  assert.deepEqual(await gatewayOn(fetchImpl).sellBack(CARD, "sell-1"), { usdMicro: "0", ref: "sell-1" });
});

test("a source transaction is dead only when its blockhash has gone and no status exists", async () => {
  const signed = build(custody.publicKey);
  signed.sign([custody]);
  const bytes = Buffer.from(signed.serialize()).toString("base64");
  const sig = "sig";
  assert.equal(await gatewayOn(realRpc({ assetOwner: CARD, blockhashValid: true }).fetchImpl).sourceExpired(bytes, sig), false);
  assert.equal(await gatewayOn(realRpc({ assetOwner: CARD, blockhashValid: false }).fetchImpl).sourceExpired(bytes, sig), true);
  assert.equal(await gatewayOn(realRpc({ assetOwner: CARD, blockhashValid: false, statusRow: { err: null, confirmationStatus: "processed" } }).fetchImpl).sourceExpired(bytes, sig), false);
  await assert.rejects(() => gatewayOn(realRpc({ assetOwner: CARD, down: ["isBlockhashValid"] }).fetchImpl).sourceExpired(bytes, sig));
  await assert.rejects(() => gatewayOn(realRpc({ assetOwner: CARD, down: ["getSignatureStatuses"] }).fetchImpl).sourceExpired(bytes, sig));
});
