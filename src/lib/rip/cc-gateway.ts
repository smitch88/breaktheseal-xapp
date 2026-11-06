import { SELL_FEE_PERCENT } from "../sellback.ts";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MAX_RELAY_SOL_LAMPORTS, RELAY_SOLANA_DEPOSITORIES, RELAY_SOLANA_SOLVERS, relaySpendRefusal, type RelayInstruction } from "./relay.ts";
import bs58 from "bs58";
import { GatewayRefused, type CardGateway, type CardMachine, type OpenedCard } from "./card-gateway.ts";

/**
 * Collector Crypt's public API, with no key of any kind, and our own Solana custody wallet. The API's answers are untrusted:
 * a generated payment is checked instruction by instruction before anything signs it (the rule set from cubes.fun's
 * reviewed worker), and every card is proven on Solana. This path has not moved money on Break the Seal: it runs only behind
 * SEAL_CARD_RAILS=collector-crypt, on the owner's go, and the mainnet check in the go-live order is its first real use. The
 * shapes it expects were read off Collector Crypt's and Solana's real answers on 2026-11-02: see test/cards-public.test.ts.
 */
const ORIGIN = "https://gacha.collectorcrypt.com";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMOS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MAX_BUYBACK_SOL_LAMPORTS = 5_000_000n;
/** Collector Crypt's own co-signer. It pays the fee on a pack for a wallet with no SOL, and every buyback. Read off real transactions on 2026-11-02. */
export const COLLECTOR_CRYPT_SIGNER = "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3";
/**
 * The USDC account every generatePack paid on 2026-11-02, across 11 machines from $25 to $500 and three machine owners, and every
 * real pack cubes.fun bought on 2026-10-30 and 31. A token account of the signer above. Set on the server through
 * SEAL_CC_RECIPIENT_TOKEN_ACCOUNTS: this is the value the deploy kit proposes and checks, not a default the app falls back on.
 */
export const CC_REVIEWED_RECIPIENTS: readonly string[] = ["D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk"];

export interface CcConfig {
  readonly custodySecret: Uint8Array;
  readonly solanaRpc: string;
  /** USDC accounts Collector Crypt is paid at, reviewed by the owner. A payment to anywhere else is never signed. */
  readonly recipientTokenAccounts: readonly string[];
  readonly maxComputeUnits: number;
  readonly maxComputeUnitPriceMicroLamports: bigint;
  readonly fetchImpl?: typeof fetch;
}

type Env = Readonly<Record<string, string | undefined>>;

/** A typo here refuses every purchase, so it stops at startup and in the deploy kit, not on a player's first pack. */
export const parseRecipients = (raw: string): readonly string[] => {
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("SEAL_CC_RECIPIENT_TOKEN_ACCOUNTS is empty");
  for (const r of list) new PublicKey(r);
  return list;
};

export function ccConfig(env: Env): CcConfig {
  for (const k of ["SEAL_SOLANA_CUSTODY_SECRET", "SEAL_SOLANA_RPC", "SEAL_CC_RECIPIENT_TOKEN_ACCOUNTS"]) if (!env[k]?.trim()) throw new Error(`the card line needs ${k}`);
  const secret = JSON.parse(env.SEAL_SOLANA_CUSTODY_SECRET as string) as number[];
  return {
    custodySecret: Uint8Array.from(secret),
    solanaRpc: (env.SEAL_SOLANA_RPC as string).trim(),
    recipientTokenAccounts: parseRecipients(env.SEAL_CC_RECIPIENT_TOKEN_ACCOUNTS as string),
    maxComputeUnits: 400_000,
    maxComputeUnitPriceMicroLamports: 2_000_000n,
  };
}

export const custodyAddress = (env: Env) => Keypair.fromSecretKey(ccConfig(env).custodySecret).publicKey.toBase58();

export const ataOf = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];

/** Every rule a provider-built payment has to pass. Returns the reason it fails, or null. */
export function paymentRefusal(tx: VersionedTransaction, input: { custody: PublicKey; memo: string; priceMicro: bigint; recipients: readonly string[]; maxComputeUnits: number; maxUnitPrice: bigint }): string | null {
  const keys = tx.message.staticAccountKeys;
  if (tx.message.addressTableLookups.length) return "uses a lookup table";
  // Collector Crypt pays the fee itself for a wallet with no SOL, and leaves it to one that has some. Either is fine: nobody
  // else's key can be first, and everything below says what custody's signature can do.
  if (!keys[0]?.equals(input.custody) && keys[0]?.toBase58() !== COLLECTOR_CRYPT_SIGNER) return "fee payer isn't custody or the card source's co-signer";
  if (tx.message.header.numRequiredSignatures < 1 || tx.message.header.numRequiredSignatures > 4) return "wrong number of signers";
  if (!keys.slice(0, tx.message.header.numRequiredSignatures).some((k) => k.equals(input.custody))) return "custody isn't asked to sign";
  const ixs = tx.message.compiledInstructions;
  if (ixs.length < 2 || ixs.length > 4) return "wrong number of instructions";
  let transfers = 0;
  let memos = 0;
  const seen = new Set<number>();
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    const accounts = Array.from(ix.accountKeyIndexes, (i) => keys[i]);
    if (!program || accounts.some((a) => !a)) return "bad account index";
    if (program.toBase58() === COMPUTE) {
      if (seen.has(data[0]) || accounts.length) return "bad compute instruction";
      seen.add(data[0]);
      const units = data.length === 5 && data[0] === 2 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= input.maxComputeUnits;
      const price = data.length === 9 && data[0] === 3 && data.readBigUInt64LE(1) <= input.maxUnitPrice;
      if (!units && !price) return "compute budget out of bounds";
    } else if (MEMOS.has(program.toBase58())) {
      if (++memos !== 1 || data.toString("utf8") !== `${input.memo}:open`) return "memo doesn't match the pack";
    } else if (program.equals(TOKEN)) {
      // transferChecked, USDC's 6 decimals, the exact price, from our account, to a reviewed account, and nothing else.
      if (++transfers !== 1 || data.length !== 10 || data[0] !== 12 || data[9] !== 6) return "not a single USDC transfer";
      if (data.readBigUInt64LE(1) !== input.priceMicro) return "amount isn't the pack price";
      if (!(accounts.length === 4 || (accounts.length === 5 && accounts[4].equals(input.custody)))) return "unexpected transfer accounts";
      if (!accounts[0].equals(ataOf(input.custody, USDC)) || !accounts[1].equals(USDC) || !accounts[3].equals(input.custody)) return "transfer isn't custody's USDC";
      if (!input.recipients.includes(accounts[2].toBase58())) return "recipient isn't on the reviewed list";
    } else {
      return "unknown program";
    }
  }
  if (transfers !== 1 || memos !== 1) return "not one transfer and one memo";
  return null;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const CORE_PROGRAM = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
/** The player's quote from a gross buyback: less the sell fee, rounded down to whole cents. */
const netOf = (gross: bigint) => ((gross * BigInt(100 - SELL_FEE_PERCENT)) / 100n / 10_000n) * 10_000n;

/**
 * A buyback's transaction is built by the provider and can take many shapes, so it is judged by what it would do to custody
 * if signed. Custody only owns SOL, USDC and cards, so that covers everything: USDC up by the quote with no delegate left
 * on the account, SOL down by no more than fees and still ours, this card gone, and no other card anywhere in the transaction.
 * A program can only move an account the transaction names.
 */
export function saleRefusal(input: { custody?: string; gross: bigint; minNetMicro?: string | null; usdcBefore: bigint; usdcAfter: { data: readonly string[] } | null; solBefore: bigint; solAfter: { lamports: number; owner: string } | null; maxSolDebit: bigint; cardStillHeld: boolean; keys: readonly string[]; others: readonly string[] }): string | null {
  if (!input.usdcAfter || !input.solAfter) return "simulation failed";
  const usdc = Buffer.from(input.usdcAfter.data[0], "base64");
  if (usdc.length < 76) return "simulation failed";
  if (input.minNetMicro && netOf(input.gross) < BigInt(input.minNetMicro)) return "buyback fell below the quote";
  if (usdc.readBigUInt64LE(64) - input.usdcBefore < input.gross) return "buyback pays less than quoted";
  if (usdc.readUInt32LE(72) !== 0) return "buyback leaves a delegate on custody's USDC";
  // The account has to stay custody's own, with nobody else able to close it.
  if (input.custody && (usdc.length < 133 || new PublicKey(usdc.subarray(32, 64)).toBase58() !== input.custody || usdc.readUInt32LE(129) !== 0)) return "buyback changes who controls custody's USDC";
  if (input.solAfter.owner !== SYSTEM_PROGRAM) return "buyback changes custody's owner";
  if (input.solBefore - BigInt(input.solAfter.lamports) > input.maxSolDebit) return "buyback costs too much SOL";
  if (input.cardStillHeld) return "the card doesn't leave custody";
  const named = new Set(input.keys);
  if (input.others.some((o) => named.has(o))) return "buyback touches another card in custody";
  return null;
}

const insuredOf = (metadata: Record<string, unknown>): string | null => {
  const attrs = Array.isArray(metadata.attributes) ? (metadata.attributes as Record<string, unknown>[]) : [];
  const row = attrs.find((a) => /^(insured[ _]value|insured value usd)$/i.test(String(a.trait_type ?? "")));
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 1e6)) : null;
};

const gradeOf = (metadata: Record<string, unknown>): string => {
  const attrs = Array.isArray(metadata.attributes) ? (metadata.attributes as Record<string, unknown>[]) : [];
  const pick = (t: string) => attrs.find((a) => String(a.trait_type) === t)?.value;
  return `${String(pick("Grading Company") ?? "")} ${String(pick("The Grade") ?? "")}`.trim();
};

/** Read a provider reveal. Throws on anything that doesn't fit; null while it isn't ready. */
export function parseOpened(raw: Record<string, unknown>, memo: string): OpenedCard | null {
  if (raw.code === "WAITING_FOR_WEBHOOK" || !raw.nft_address || !raw.transactionSignature) return null;
  if (raw.success === false || (raw.memo && raw.memo !== memo) || raw.code === "TURBO_MODE_BUYBACK") throw new Error("reveal doesn't match this pack");
  const won = raw.nftWon as { content?: { metadata?: Record<string, unknown>; links?: { image?: string } } } | undefined;
  const metadata = won?.content?.metadata ?? {};
  const insuredMicro = insuredOf(metadata);
  const name = metadata.name;
  const img = (metadata.image as string | undefined) ?? won?.content?.links?.image;
  if (!insuredMicro || typeof name !== "string" || typeof img !== "string" || !img.startsWith("https://")) throw new Error("reveal is missing the card's details");
  return { mint: new PublicKey(String(raw.nft_address)).toBase58(), name, img, grade: gradeOf(metadata), insuredMicro, rarity: String(raw.rarity ?? "Unknown").slice(0, 80) };
}

/**
 * Build Relay's deposit as our own transaction, with custody paying the network fee, and judge what simulation says it would do. Nothing is
 * signed here, so the read-only check in the deploy kit runs this same code on a live quote with no key. Only compute budget and a listed
 * depository can run, and custody can be the only signer.
 */
export async function judgeRelayDeposit(connection: Connection, input: { custody: PublicKey; instructions: readonly RelayInstruction[]; lookupTables: readonly string[]; amountMicro: bigint; others: readonly string[] }): Promise<{ refusal: string | null; tx: VersionedTransaction }> {
  const { custody, instructions, lookupTables, amountMicro, others } = input;
  for (const i of instructions) if (i.programId !== COMPUTE && !RELAY_SOLANA_DEPOSITORIES.includes(i.programId)) throw new Error(`not signing: ${i.programId} isn't on the list`);
  const tables = await Promise.all(lookupTables.map(async (t) => (await connection.getAddressLookupTable(new PublicKey(t))).value));
  if (tables.some((t) => !t)) throw new Error("the deposit's lookup table can't be read");
  const live = tables as NonNullable<(typeof tables)[number]>[];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: custody,
    recentBlockhash: blockhash,
    instructions: instructions.map((i) => new TransactionInstruction({ programId: new PublicKey(i.programId), data: Buffer.from(i.data, "hex"), keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })) })),
  }).compileToV0Message(live);
  const tx = new VersionedTransaction(message);
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
  if (signers.length !== 1 || !signers[0].equals(custody)) return { refusal: "someone else has to sign this deposit", tx };
  const usdc = ataOf(custody, USDC);
  const usdcBefore = BigInt((await connection.getTokenAccountBalance(usdc)).value.amount);
  const solBefore = BigInt(await connection.getBalance(custody));
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, accounts: { encoding: "base64", addresses: [usdc.toBase58(), custody.toBase58()] } });
  if (sim.value.err) return { refusal: `the deposit's simulation failed: ${JSON.stringify(sim.value.err)}`, tx };
  const [after, solAfter] = sim.value.accounts ?? [];
  const keys = message.getAccountKeys({ addressLookupTableAccounts: live }).keySegments().flat().map((k) => k.toBase58());
  return { tx, refusal: relaySpendRefusal({ custody: custody.toBase58(), amountMicro, usdcBefore, usdcAfter: after ?? null, solBefore, solAfter: solAfter ?? null, maxSolDebit: MAX_RELAY_SOL_LAMPORTS, keys, others: others.flatMap((m) => [m, ataOf(custody, new PublicKey(m)).toBase58()]) }) };
}

export function collectorCryptGateway(config: CcConfig): CardGateway {
  const f = config.fetchImpl ?? fetch;
  const custody = Keypair.fromSecretKey(config.custodySecret);
  const owner = custody.publicKey;
  const prices = new Map<string, CardMachine>();

  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await f(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    // Too many requests isn't a no: it says nothing about the pack or the card.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new GatewayRefused(`${path} ${res.status}`);
    if (!res.ok || text.length > 5_000_000) throw new Error(`${path} unavailable`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const solana = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const res = await f(config.solanaRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (body.error) throw new Error(`Solana ${method}`);
    return body.result ?? {};
  };

  /**
   * Who holds this card, from a finalized read. Every Collector Crypt card seen so far is a Core asset, which isn't an SPL mint:
   * the token account read refuses to answer for one, so the account's own program decides which read applies.
   * A failed read throws. "We couldn't tell" must never read as gone: a sale would count as already done.
   */
  const custodyOf = async (mint: string): Promise<{ ours: boolean; frozen: boolean; slot: number; proof: string }> => {
    const info = await solana("getAccountInfo", [mint, { encoding: "base64", commitment: "finalized" }]);
    const slot = Number((info.context as { slot?: number } | undefined)?.slot ?? 0);
    const account = info.value as { owner: string; data: [string, string] } | null | undefined;
    if (!account) throw new Error("no such card account");
    if (account.owner === CORE_PROGRAM) {
      const data = Buffer.from(account.data[0], "base64");
      if (data.length < 33 || data[0] !== 1) throw new Error("that isn't a live Core asset");
      if (!new PublicKey(data.subarray(1, 33)).equals(owner)) return { ours: false, frozen: false, slot, proof: "" };
      // A freeze sits in the asset's plugins, which the asset index reads for us. Named params: an array is refused.
      const asset = await solana("getAsset", { id: mint });
      const frozen = (asset as { ownership?: { frozen?: unknown } }).ownership?.frozen;
      if (typeof frozen !== "boolean") throw new Error("asset index didn't answer for this card");
      return { ours: true, frozen, slot, proof: createHash("sha256").update(`${owner.toBase58()}|${mint}|core|${slot}`).digest("hex") };
    }
    const r = await solana("getTokenAccountsByOwner", [owner.toBase58(), { mint }, { encoding: "jsonParsed", commitment: "finalized" }]);
    const at = Number((r.context as { slot?: number } | undefined)?.slot ?? slot);
    const rows = (r.value as { pubkey: string; account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] | undefined) ?? [];
    const row = rows.find((x) => x.account.data.parsed.info.tokenAmount.amount === "1");
    return { ours: !!row, frozen: false, slot: at, proof: row ? createHash("sha256").update(`${owner.toBase58()}|${mint}|${row.pubkey}|${at}`).digest("hex") : "" };
  };

  const gateway: CardGateway = {
    label: "collector-crypt",
    async machine(code) {
      const raw = (await request("/api/machines")) as unknown as Record<string, unknown>[] | { machines?: Record<string, unknown>[] };
      const list = Array.isArray(raw) ? raw : (raw.machines ?? []);
      const m = list.find((x) => x.code === code);
      const status = await request("/api/status");
      const open = (status.gachas as Record<string, unknown>[] | undefined)?.find((g) => g.code === code)?.isOpen === true;
      if (!m || !open || typeof m.price !== "number") return null;
      const machine = { code, name: String(m.name ?? code), usd: m.price, instantBuybackPct: Number(m.instantBuyback ?? 0) };
      prices.set(code, machine);
      return machine;
    },
    async floatMicro() {
      // No account yet, or Solana unreachable: both read as nothing to spend, so a pack waits rather than oversells.
      const r = await solana("getTokenAccountBalance", [ataOf(owner, USDC).toBase58(), { commitment: "finalized" }]).catch(() => null);
      return BigInt(String((r?.value as { amount?: string } | undefined)?.amount ?? "0"));
    },
    async gasLamports() {
      const r = await solana("getBalance", [owner.toBase58(), { commitment: "finalized" }]);
      return BigInt(String(r.value ?? "0"));
    },
    async generate(code) {
      const r = await request("/api/generatePack", { playerAddress: owner.toBase58(), altPlayerAddress: owner.toBase58(), packType: code, turbo: false });
      if (typeof r.memo !== "string" || !r.memo || r.memo.length > 200 || typeof r.transaction !== "string" || r.transaction.length > 4096) throw new Error("unexpected generatePack answer");
      return { memo: r.memo, transaction: r.transaction };
    },
    async sign({ memo, transaction, usd }) {
      const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
      const refusal = paymentRefusal(tx, { custody: owner, memo, priceMicro: BigInt(Math.round(usd * 1e6)), recipients: config.recipientTokenAccounts, maxComputeUnits: config.maxComputeUnits, maxUnitPrice: config.maxComputeUnitPriceMicroLamports });
      if (refusal) throw new Error(`not signing: ${refusal}`);
      tx.sign([custody]);
      const signature = tx.signatures[0];
      return { signature: bs58.encode(signature), bytes: Buffer.from(tx.serialize()).toString("base64") };
    },
    async send(bytes) {
      await request("/api/submitTransaction", { signedTransaction: bytes }).catch(() => {});
      await solana("sendTransaction", [bytes, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]).catch(() => {});
    },
    async sourceStatus(signature) {
      const r = await solana("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      const row = (r.value as ({ err: unknown; confirmationStatus?: string } | null)[] | undefined)?.[0];
      if (!row) return "pending";
      // A failure only counts once it can't be undone: a fork that dropped it could still land the payment, and a refund follows this.
      if (row.err) return row.confirmationStatus === "finalized" ? "failed" : "pending";
      return row.confirmationStatus === "finalized" ? "finalized" : "pending";
    },
    async sourceExpired(bytes, signature) {
      const { recentBlockhash } = VersionedTransaction.deserialize(Buffer.from(bytes, "base64")).message;
      // Confirmed, not finalized: a blockhash too new for the finalized view reads as invalid there, which cost cubes.fun a real pull.
      const live = await solana("isBlockhashValid", [recentBlockhash, { commitment: "confirmed" }]);
      if (live.value !== false) return false;
      const r = await solana("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      const rows = r.value as unknown[] | undefined;
      return Array.isArray(rows) && rows[0] === null;
    },
    async open(memo) {
      return parseOpened(await request("/api/openPack", { memo }), memo);
    },
    async prove(mint) {
      const at = await custodyOf(mint);
      const held = at.ours && !at.frozen;
      return { held, slot: at.slot, proof: held ? at.proof : "" };
    },
    async sellQuote(mint, insuredMicro, pct) {
      const params = new URLSearchParams({ wallet: owner.toBase58(), nft: mint });
      const q = await request(`/api/buyback/available?${params}`);
      if (q.available === true && (typeof q.amount === "number" || typeof q.amount === "string")) {
        const gross = BigInt(q.amount as number);
        // Never above the card's insured value, and our sell fee comes off Collector Crypt's own quote.
        if (gross > BigInt(insuredMicro)) throw new Error("buyback above insured value");
        return { usdMicro: netOf(gross) };
      }
      // Past their 72-hour window there's no instant buyback from them. Keep the quote honest and leave this to a person.
      void pct;
      throw new Error("no instant buyback right now");
    },
    async sellBack(mint, ref, guard) {
      // Idempotent by effect: if the card has already left custody, that sale is done and nothing is sent again.
      const now = await custodyOf(mint);
      if (!now.ours) return { usdMicro: "0", ref };
      // Frozen where it sits is not sold, and no XRP can follow it. It stalls for a person.
      if (now.frozen) throw new Error("the card is frozen");
      const quote = await request(`/api/buyback/available?${new URLSearchParams({ wallet: owner.toBase58(), nft: mint })}`);
      if (quote.available !== true) throw new Error("no instant buyback right now");
      const gross = BigInt(quote.amount as number);
      const built = await request("/api/buyback", { playerAddress: owner.toBase58(), nftAddress: mint });
      const raw = typeof built.serializedTransaction === "string" ? built.serializedTransaction : built.transaction;
      if (typeof raw !== "string" || raw.length > 4096) throw new Error("unexpected buyback answer");
      const tx = VersionedTransaction.deserialize(Buffer.from(raw, "base64"));
      const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
      if (!signers.some((k) => k.equals(owner))) throw new Error("buyback isn't signed by custody");
      // Prove the sale by its effect before signing, as cubes.fun does: our USDC goes up by at least the quote.
      const connection = new Connection(config.solanaRpc, "confirmed");
      const usdc = ataOf(owner, USDC);
      const mintKey = new PublicKey(mint);
      const before = BigInt((await connection.getTokenAccountBalance(usdc)).value.amount);
      const solBefore = BigInt(await connection.getBalance(owner));
      const core = (await connection.getAccountInfo(mintKey))?.owner.toBase58() === CORE_PROGRAM;
      const holding = core ? mintKey : ataOf(owner, mintKey);
      const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, accounts: { encoding: "base64", addresses: [usdc.toBase58(), owner.toBase58(), holding.toBase58()] } });
      if (sim.value.err) throw new Error("buyback simulation failed");
      const [after, solAfter, cardAfter] = sim.value.accounts ?? [];
      const cardData = cardAfter ? Buffer.from(cardAfter.data[0] ?? "", "base64") : Buffer.alloc(0);
      const cardStillHeld = core ? cardData.length >= 33 && new PublicKey(cardData.subarray(1, 33)).equals(owner) : cardData.length >= 72 && cardData.readBigUInt64LE(64) > 0n;
      // Every account the transaction can reach, including any behind a lookup table.
      const tables = await Promise.all(tx.message.addressTableLookups.map(async (l) => (await connection.getAddressLookupTable(l.accountKey)).value));
      if (tables.some((t) => !t)) throw new Error("buyback's lookup table can't be read");
      const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables as NonNullable<(typeof tables)[number]>[] }).keySegments().flat().map((k) => k.toBase58());
      const others = (guard?.others ?? []).flatMap((m) => [m, ataOf(owner, new PublicKey(m)).toBase58()]);
      const refusal = saleRefusal({ custody: owner.toBase58(), gross, minNetMicro: guard?.minNetMicro, usdcBefore: before, usdcAfter: after ?? null, solBefore, solAfter: solAfter ?? null, maxSolDebit: MAX_BUYBACK_SOL_LAMPORTS, cardStillHeld, keys, others });
      if (refusal) throw new Error(refusal);
      tx.sign([custody]);
      await request("/api/submitTransaction", { signedTransaction: Buffer.from(tx.serialize()).toString("base64") });
      // Done only when finalized reads show the card has left. Until then this throws, the engine asks again, and the
      // first line above says it's done once it lands. XRP is never paid on a 200 from an API.
      if ((await custodyOf(mint)).ours) throw new Error("buyback isn't finalized yet");
      return { usdMicro: gross.toString(), ref };
    },
    async signRelaySwap({ instructions, lookupTables, amountMicro, others }) {
      const connection = new Connection(config.solanaRpc, "confirmed");
      const judged = await judgeRelayDeposit(connection, { custody: owner, instructions, lookupTables, amountMicro, others });
      if (judged.refusal) throw new Error(`not signing: ${judged.refusal}`);
      const { tx } = judged;
      tx.sign([custody]);
      return { signature: bs58.encode(tx.signatures[0]), bytes: Buffer.from(tx.serialize()).toString("base64") };
    },
    async sendRaw(bytes) {
      await solana("sendTransaction", [bytes, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]).catch(() => {});
    },
    async proveUsdcFill(signature, minMicro) {
      const r = await solana("getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
      if (!r || !r.meta) return null;
      // Relay's status said to look here, and its word is all that said so. The transaction itself has to be one of Relay's solvers paying custody.
      const named = ((r.transaction as { message?: { accountKeys?: { pubkey: string }[] } } | undefined)?.message?.accountKeys ?? []).map((k) => k.pubkey);
      if (!named.some((k) => RELAY_SOLANA_SOLVERS.includes(k))) return null;
      const meta = r.meta as { err: unknown; preTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[]; postTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] };
      if (meta.err) return null;
      const ours = (rows: typeof meta.preTokenBalances) => BigInt(rows?.find((b) => b.owner === owner.toBase58() && b.mint === USDC.toBase58())?.uiTokenAmount.amount ?? "0");
      const got = ours(meta.postTokenBalances) - ours(meta.preTokenBalances);
      return got >= minMicro && got > 0n ? { micro: got.toString(), slot: Number(r.slot ?? 0) } : null;
    },
  };
  return gateway;
}
