import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { GatewayRefused, simulatedGateway } from "../src/lib/rip/card-gateway.ts";
import { ataOf, collectorCryptGateway, parseOpened, paymentRefusal } from "../src/lib/rip/cc-gateway.ts";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const custody = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const memo = "abc123";
const priceMicro = 25_000_000n;

function build(opts: { amount?: bigint; to?: PublicKey; memoText?: string; extra?: TransactionInstruction; from?: PublicKey; decimals?: number; payer?: PublicKey } = {}) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(opts.amount ?? priceMicro, 1);
  data[9] = opts.decimals ?? 6;
  const transfer = new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: opts.from ?? ataOf(custody.publicKey, USDC), isSigner: false, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: opts.to ?? recipient, isSigner: false, isWritable: true },
      { pubkey: custody.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const m = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(opts.memoText ?? `${memo}:open`) });
  const message = new TransactionMessage({ payerKey: opts.payer ?? custody.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [transfer, m, ...(opts.extra ? [opts.extra] : [])] }).compileToV0Message();
  return new VersionedTransaction(message);
}
const rules = { custody: custody.publicKey, memo, priceMicro, recipients: [recipient.toBase58()], maxComputeUnits: 400_000, maxUnitPrice: 2_000_000n };

test("a provider payment is signed only if it is the exact price, to a reviewed account, from custody's USDC", () => {
  assert.equal(paymentRefusal(build(), rules), null);
  assert.match(paymentRefusal(build({ amount: priceMicro + 1n }), rules) ?? "", /amount/);
  assert.match(paymentRefusal(build({ to: Keypair.generate().publicKey }), rules) ?? "", /recipient/);
  assert.match(paymentRefusal(build({ memoText: "other:open" }), rules) ?? "", /memo/);
  assert.match(paymentRefusal(build({ from: Keypair.generate().publicKey }), rules) ?? "", /custody/);
  assert.match(paymentRefusal(build({ decimals: 9 }), rules) ?? "", /USDC/);
  assert.match(paymentRefusal(build({ payer: Keypair.generate().publicKey }), rules) ?? "", /fee payer/);
  const drain = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
  assert.match(paymentRefusal(build({ extra: drain }), rules) ?? "", /unknown program/);
});

test("any amount other than the price is refused, however close", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), (amount) => {
      const r = paymentRefusal(build({ amount }), rules);
      return amount === priceMicro ? r === null : /amount/.test(r ?? "");
    }),
    { numRuns: 60 },
  );
});

test("a provider reveal is parsed strictly: not ready, mismatched and incomplete answers never become a card", () => {
  assert.equal(parseOpened({ code: "WAITING_FOR_WEBHOOK" }, memo), null);
  const good = {
    success: true,
    memo,
    nft_address: Keypair.generate().publicKey.toBase58(),
    transactionSignature: "sig",
    rarity: "rare",
    nftWon: { content: { metadata: { name: "Charizard", image: "https://x.test/c.png", attributes: [{ trait_type: "Insured Value", value: "14" }, { trait_type: "Grading Company", value: "CGC" }, { trait_type: "The Grade", value: "10" }] } } },
  };
  const card = parseOpened(good, memo);
  assert.equal(card?.insuredMicro, "14000000");
  assert.equal(card?.grade, "CGC 10");
  assert.throws(() => parseOpened({ ...good, memo: "not-this-pack" }, memo));
  assert.throws(() => parseOpened({ ...good, code: "TURBO_MODE_BUYBACK" }, memo));
  assert.throws(() => parseOpened({ ...good, nftWon: { content: { metadata: { name: "x", attributes: [] } } } }, memo));
});

test("the real gateway refuses to sign a bad payment and reads the provider's no as a refusal, using a recorded fake of its API", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "machine closed" }), { status: 400 });
  }) as typeof fetch;
  const gw = collectorCryptGateway({ custodySecret: custody.secretKey, solanaRpc: "https://solana.invalid", recipientTokenAccounts: [recipient.toBase58()], maxComputeUnits: 400_000, maxComputeUnitPriceMicroLamports: 2_000_000n, fetchImpl });
  await assert.rejects(() => gw.generate("pokemon_25", "r"), GatewayRefused);
  const bad = Buffer.from(build({ to: Keypair.generate().publicKey }).serialize()).toString("base64");
  await assert.rejects(() => gw.sign({ memo, transaction: bad, usd: 25 }), /not signing/);
  const good = Buffer.from(build().serialize()).toString("base64");
  const signed = await gw.sign({ memo, transaction: good, usd: 25 });
  assert.ok(signed.signature.length > 40);
  assert.deepEqual(calls.filter((c) => c.includes("submitTransaction")), [], "signing sends nothing");
});

test("the simulated source says so on every card and remembers what it sold", async () => {
  const gw = simulatedGateway();
  assert.equal(gw.label, "simulated");
  const made = await gw.generate("pokemon_25", "ref");
  const card = await gw.open(made.memo);
  assert.ok(card?.name.startsWith("SIMULATED"));
  assert.ok((await gw.prove(card!.mint)).held);
  await gw.sellBack(card!.mint, "s");
  assert.equal((await gw.prove(card!.mint)).held, false);
  assert.equal((await gw.sellBack(card!.mint, "s")).ref, (await gw.sellBack(card!.mint, "s")).ref);
});
