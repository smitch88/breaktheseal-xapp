/**
 * Relay, the bridge between the treasury's XRP and custody's Solana USDC. Nothing it says is trusted past the checks here: a quote
 * passes only if it does exactly one thing, between our two wallets, in the amounts we asked for, through an address on a list a
 * person wrote down. Its status answer only says where to look. Money counts when the ledger or Solana shows it arrived.
 *
 * Shapes and addresses were read from Relay's live answers on 2026-11-02 (test/fixtures/relay). Solver and depositories are from
 * its /chains and /quote/v2. A real delivery seen on the ledger: `rE6xRr2GbS…` paying a wallet one Payment whose single memo is the
 * order id as text, `0x` and 64 hex. That was checked against the order id on the deposit side of request 0x179365037959…
 */
export const RELAY_XRP_CHAIN = 537724;
export const RELAY_SOLANA_CHAIN = 792703809;
export const RELAY_ORIGIN = "https://api.relay.link";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XRP_NATIVE = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const RELAY_XRP_SOLVERS: readonly string[] = ["rE6xRr2GbS31KPoL9RaLgfiarJ4vqXj8Si"];
export const RELAY_SOLANA_SOLVERS: readonly string[] = ["F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe", "DNLbQ4t95LLPevvLdcFzN8RHNN83ntQJLt26E8VTnE7p"];
export const RELAY_XRP_DEPOSITORIES: readonly string[] = ["rJBdWA9p5KwBoqSQTyMdg3UHLsJVzGVu5m"];
export const RELAY_SOLANA_DEPOSITORIES: readonly string[] = ["99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"];
/** Relay's default is 2%, far more than a sale's margin. A quote's minimum output is what a swap is judged on. */
export const RELAY_SLIPPAGE_BPS = 50;
/** A quote older than this isn't signed. A new one costs nothing. */
export const QUOTE_MAX_AGE_MS = 60_000;
/**
 * The most SOL one Relay deposit may cost custody. Relay's own quote put its gas at 2,609 lamports on 2026-11-02, plus the 5,000 base fee.
 * Custody runs on about 0.01 SOL and needs it to buy and sell cards, so a deposit that wants more than a fee's worth is refused.
 */
export const MAX_RELAY_SOL_LAMPORTS = 50_000n;

export type SwapDir = "xrp_to_usdc" | "usdc_to_xrp";

/** The quote is wrong in a way no market move explains. Never signed, and a person hears about it. */
export class RelayRefused extends Error {}
/** The quote is fine and the price isn't: it won't do what this order can afford. */
export class RelayRateMoved extends RelayRefused {}

export interface RelayPolicy {
  readonly treasury: string;
  readonly custody: string;
  readonly xrpSolvers: readonly string[];
  readonly xrpDepositories: readonly string[];
  readonly solanaDepositories: readonly string[];
  /** The most one swap can move, and the most swaps can move in 24 hours, in USDC micros. */
  readonly maxSwapMicro: bigint;
  readonly maxDayMicro: bigint;
}

export interface RelayInstruction {
  readonly programId: string;
  readonly keys: readonly { readonly pubkey: string; readonly isSigner: boolean; readonly isWritable: boolean }[];
  readonly data: string;
}

/** A quote that passed. Only these fields are ever used, and none of them can point at anyone but our two wallets. */
export interface CheckedQuote {
  readonly dir: SwapDir;
  readonly requestId: string;
  readonly orderId: string;
  readonly depository: string;
  readonly inAmount: string;
  readonly outMin: string;
  readonly outExpected: string;
  readonly deadline: number;
  readonly instructions?: readonly RelayInstruction[];
  readonly lookupTables?: readonly string[];
}

export interface RelayQuoteBody {
  readonly user: string;
  readonly recipient: string;
  readonly refundTo: string;
  readonly originChainId: number;
  readonly destinationChainId: number;
  readonly originCurrency: string;
  readonly destinationCurrency: string;
  readonly amount: string;
  readonly tradeType: "EXACT_INPUT" | "EXACT_OUTPUT";
  readonly slippageTolerance: string;
}

export interface RelayApi {
  quote(body: RelayQuoteBody): Promise<unknown>;
  status(requestId: string): Promise<{ status: string; txHashes: readonly string[] }>;
}

export interface RelayRails {
  /** The master switch. Off, nothing new is swapped and the float path runs as it always did. Swaps already out still finish. */
  readonly enabled: boolean;
  readonly api: RelayApi;
  readonly policy: RelayPolicy;
  /** Custody below the target pulls owed XRP across, and never past the ceiling. A sale's USDC above the ceiling goes back to XRP. */
  readonly custodyTargetMicro: bigint;
  readonly custodyCeilingMicro: bigint;
  /** The treasury's free XRP below the target pulls owed USDC across, and never past the ceiling. */
  readonly treasuryTargetDrops: bigint;
  readonly treasuryCeilingDrops: bigint;
  /** A refill smaller than this waits for more, unless custody can't sell the next pack without it. */
  readonly minBatchMicro: bigint;
  /** How often to look for refills to make. Each look reads both balances. Default 30 seconds. */
  readonly refillLookMs?: number;
}

const bad = (why: string): never => {
  throw new RelayRefused(`relay quote: ${why}`);
};
type Row = Record<string, unknown>;
const row = (v: unknown, what: string): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : bad(`${what} isn't an object`));
const list = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : bad(`${what} isn't a list`));
const one = (v: unknown, what: string): Row => {
  const items = list(v, what);
  return items.length === 1 ? row(items[0], what) : bad(`${what} isn't exactly one`);
};
const uint = (v: unknown, what: string): bigint => (typeof v === "string" && /^[0-9]{1,30}$/.test(v) ? BigInt(v) : bad(`${what} isn't an amount`));
const hash = (v: unknown, what: string): string => (typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) ? v : bad(`${what} isn't a hash`));

/** Everything both directions share: one deposit step, one payment each way, no calls, no fees, refunds only to our own wallets. */
function common(raw: unknown, policy: RelayPolicy, dir: SwapDir, nowS: number) {
  const buy = dir === "xrp_to_usdc";
  const root = row(raw, "quote");
  const v2 = row(row(root.protocol, "protocol").v2, "protocol.v2");
  const order = row(v2.orderData, "orderData");
  const payment = row(v2.paymentDetails, "paymentDetails");
  const orderId = hash(v2.orderId, "orderId");
  if (order.version !== "v1") bad("unknown order version");
  if (list(order.fees, "order fees").length) bad("the order carries a fee");
  const originChain = buy ? "xrp" : "solana";
  const destChain = buy ? "solana" : "xrp";
  const originToken = buy ? XRP_NATIVE : SOLANA_USDC;
  const destToken = buy ? SOLANA_USDC : XRP_NATIVE;
  const recipient = buy ? policy.custody : policy.treasury;
  if (payment.chainId !== originChain) bad("wrong origin chain");
  if (payment.currency !== originToken) bad("wrong origin token");
  const depository = String(payment.depository);
  if (!(buy ? policy.xrpDepositories : policy.solanaDepositories).includes(depository)) bad(`depository ${depository} isn't on the list`);
  const inAmount = uint(payment.amount, "input");
  if (inAmount <= 0n) bad("no input");
  const input = one(order.inputs, "inputs");
  const paid = row(input.payment, "input payment");
  if (paid.chainId !== originChain || paid.currency !== originToken || paid.weight !== "1" || uint(paid.amount, "input") !== inAmount) bad("the input doesn't match the payment");
  const refunds = list(input.refunds, "refunds").map((r) => row(r, "refund"));
  if (!refunds.length || refunds.length > 2) bad("wrong number of refund routes");
  for (const r of refunds) {
    const ours = r.chainId === "xrp" ? r.recipient === policy.treasury && r.currency === XRP_NATIVE : r.chainId === "solana" && r.recipient === policy.custody && r.currency === SOLANA_USDC;
    if (!ours || r.extraData !== "0x") bad("a refund can go somewhere other than our wallets");
  }
  const output = row(order.output, "output");
  if (output.chainId !== destChain) bad("wrong output chain");
  if (list(output.calls, "output calls").length || output.extraData !== "0x") bad("the output makes a call");
  const out = one(output.payments, "output payments");
  if (out.recipient !== recipient) bad("the output goes to someone else");
  if (out.currency !== destToken) bad("wrong output token");
  const outMin = uint(out.minimumAmount, "minimum output");
  const outExpected = uint(out.expectedAmount, "expected output");
  if (outMin <= 0n || outExpected < outMin) bad("output amounts don't add up");
  const deadline = Number(output.deadline);
  if (!Number.isSafeInteger(deadline) || deadline <= nowS + 60) bad("the deadline is gone");
  const step = one(root.steps, "steps");
  if (step.id !== "deposit" || step.kind !== "transaction") bad("the one step isn't a deposit");
  const requestId = hash(step.requestId, "requestId");
  const item = one(step.items, "step items");
  if (item.status !== "incomplete") bad("the step is already done");
  return { orderId, depository, inAmount, outMin, outExpected, deadline, requestId, data: row(item.data, "step data") };
}

/**
 * XRP to USDC: the treasury pays one address one amount with one memo. `outMicro` is an exact output and `inDrops` an exact input;
 * `maxInDrops` is what this order brought in. A quote that wants more than that is a moved rate, told apart from a bad quote.
 */
export function checkXrpToUsdc(raw: unknown, policy: RelayPolicy, want: { outMicro?: bigint; inDrops?: bigint; minOutMicro?: bigint; maxInDrops: bigint }, nowS: number): CheckedQuote {
  const q = common(raw, policy, "xrp_to_usdc", nowS);
  if (want.outMicro !== undefined && q.outMin !== want.outMicro) bad("the output isn't what was asked for");
  if (want.inDrops !== undefined && q.inAmount !== want.inDrops) bad("the input isn't what was asked for");
  const keys = Object.keys(q.data).sort().join(",");
  if (keys !== "amount,currency,memo,to") bad("the deposit carries something extra");
  if (q.data.to !== q.depository) bad("the deposit pays someone else");
  if (q.data.currency !== "xrp") bad("the deposit isn't XRP");
  if (String(q.data.amount) !== q.inAmount.toString()) bad("the deposit isn't the input");
  if (q.data.memo !== q.orderId) bad("the deposit's memo isn't its order");
  if (q.inAmount > want.maxInDrops) throw new RelayRateMoved(`relay wants ${q.inAmount} drops, and this order brought in ${want.maxInDrops}`);
  if (want.minOutMicro !== undefined && q.outMin < want.minOutMicro) throw new RelayRateMoved(`relay's minimum is ${q.outMin}, under ${want.minOutMicro}`);
  return { dir: "xrp_to_usdc", requestId: q.requestId, orderId: q.orderId, depository: q.depository, inAmount: q.inAmount.toString(), outMin: q.outMin.toString(), outExpected: q.outExpected.toString(), deadline: q.deadline };
}

/** USDC to XRP: one instruction into the listed depository, naming this order and this amount. What it does is judged again by simulation before it's signed. */
export function checkUsdcToXrp(raw: unknown, policy: RelayPolicy, want: { inMicro: bigint; minOutDrops: bigint }, nowS: number): CheckedQuote {
  const q = common(raw, policy, "usdc_to_xrp", nowS);
  if (q.inAmount !== want.inMicro) bad("the input isn't what was asked for");
  const keys = Object.keys(q.data).sort().join(",");
  if (keys !== "addressLookupTableAddresses,instructions") bad("the deposit carries something extra");
  const instructions = list(q.data.instructions, "instructions").map((i) => {
    const r = row(i, "instruction");
    const accounts = list(r.keys, "instruction keys").map((k) => {
      const key = row(k, "instruction key");
      if (typeof key.pubkey !== "string" || typeof key.isSigner !== "boolean" || typeof key.isWritable !== "boolean") bad("an instruction key is malformed");
      return { pubkey: key.pubkey as string, isSigner: key.isSigner as boolean, isWritable: key.isWritable as boolean };
    });
    if (typeof r.programId !== "string" || typeof r.data !== "string" || !/^[0-9a-f]*$/.test(r.data)) bad("an instruction is malformed");
    return { programId: r.programId as string, keys: accounts, data: r.data as string };
  });
  const deposits = instructions.filter((i) => i.programId !== COMPUTE_BUDGET);
  if (deposits.length !== 1) bad("there isn't exactly one deposit");
  const [deposit] = deposits;
  if (deposit.programId !== q.depository) bad("the deposit runs an unknown program");
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(q.inAmount);
  // Relay's depository instruction: 8 bytes naming it, the amount, the order id.
  if (deposit.data.slice(16, 32) !== amount.toString("hex")) bad("the instruction moves a different amount");
  if (deposit.data.slice(32, 96) !== q.orderId.slice(2)) bad("the instruction names a different order");
  if (!deposit.keys.some((k) => k.pubkey === policy.custody && k.isSigner)) bad("custody doesn't sign it");
  const lookupTables = list(q.data.addressLookupTableAddresses, "lookup tables").map(String);
  if (q.outMin < want.minOutDrops) throw new RelayRateMoved(`relay's minimum is ${q.outMin} drops, under ${want.minOutDrops}`);
  return { dir: "usdc_to_xrp", requestId: q.requestId, orderId: q.orderId, depository: q.depository, inAmount: q.inAmount.toString(), outMin: q.outMin.toString(), outExpected: q.outExpected.toString(), deadline: q.deadline, instructions, lookupTables };
}

const quoteBase = { slippageTolerance: String(RELAY_SLIPPAGE_BPS) };
export const xrpToUsdcBody = (policy: RelayPolicy, want: { outMicro: bigint } | { inDrops: bigint }): RelayQuoteBody => ({ ...quoteBase, user: policy.treasury, recipient: policy.custody, refundTo: policy.treasury, originChainId: RELAY_XRP_CHAIN, destinationChainId: RELAY_SOLANA_CHAIN, originCurrency: "xrp", destinationCurrency: SOLANA_USDC, ...("outMicro" in want ? { amount: want.outMicro.toString(), tradeType: "EXACT_OUTPUT" as const } : { amount: want.inDrops.toString(), tradeType: "EXACT_INPUT" as const }) });
export const usdcToXrpBody = (policy: RelayPolicy, inMicro: bigint): RelayQuoteBody => ({ ...quoteBase, user: policy.custody, recipient: policy.treasury, refundTo: policy.custody, originChainId: RELAY_SOLANA_CHAIN, destinationChainId: RELAY_XRP_CHAIN, originCurrency: SOLANA_USDC, destinationCurrency: "xrp", amount: inMicro.toString(), tradeType: "EXACT_INPUT" });

/** What the memo of a Relay payment says, if it reads as one: `0x` and 64 hex, as text. */
export function deliveryMemo(memos: unknown): string | null {
  if (!Array.isArray(memos) || memos.length !== 1) return null;
  const data = (memos[0] as { Memo?: { MemoData?: unknown } })?.Memo?.MemoData;
  if (typeof data !== "string" || !/^[0-9A-Fa-f]+$/.test(data) || data.length > 200) return null;
  const text = Buffer.from(data, "hex").toString("utf8").toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(text) ? text : null;
}

/** The last check before the treasury signs: to the list, in drops, with exactly this order's memo. Nothing else can leave this way. */
export function depositRefusal(tx: Readonly<Record<string, unknown>>, swap: { depository: string; inAmount: string; orderId: string }, depositories: readonly string[] = RELAY_XRP_DEPOSITORIES): string | null {
  if (tx.TransactionType !== "Payment") return "not a payment";
  if (!depositories.includes(String(tx.Destination)) || tx.Destination !== swap.depository) return "not the listed deposit address";
  if (tx.Amount !== swap.inAmount) return "not the quoted amount";
  if (tx.Flags !== undefined || tx.Paths !== undefined || tx.SendMax !== undefined || tx.DestinationTag !== undefined) return "carries something extra";
  if (deliveryMemo(tx.Memos) !== swap.orderId) return "the memo isn't its order";
  return null;
}

const hexMemo = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
export const depositMemos = (orderId: string) => [{ Memo: { MemoData: hexMemo(orderId) } }];

/**
 * A Relay transaction, judged like a buyback by what simulation says it does to custody. Exactly the USDC agreed leaves, the account stays
 * custody's own (no delegate, no new owner, no close authority), SOL goes down by fees only, and no card in custody is named.
 * A program can only move what a transaction names, so that covers every other asset.
 */
export function relaySpendRefusal(input: { custody: string; amountMicro: bigint; usdcBefore: bigint; usdcAfter: { data: readonly string[] } | null; solBefore: bigint; solAfter: { lamports: number; owner: string } | null; maxSolDebit: bigint; keys: readonly string[]; others: readonly string[] }): string | null {
  if (!input.usdcAfter || !input.solAfter) return "simulation failed";
  const usdc = Buffer.from(input.usdcAfter.data[0], "base64");
  if (usdc.length < 133) return "simulation failed";
  if (base58(usdc.subarray(0, 32)) !== SOLANA_USDC) return "that account isn't USDC";
  const after = usdc.readBigUInt64LE(64);
  const spent = input.usdcBefore - after;
  if (spent > input.amountMicro) return "it spends more USDC than agreed";
  if (spent < input.amountMicro) return "it spends less USDC than agreed, so it isn't the deposit we priced";
  if (usdc.readUInt32LE(72) !== 0) return "it leaves a delegate on custody's USDC";
  if (base58(usdc.subarray(32, 64)) !== input.custody || usdc[108] !== 1 || usdc.readUInt32LE(129) !== 0) return "it changes who controls custody's USDC";
  if (input.solAfter.owner !== SYSTEM_PROGRAM) return "it changes custody's owner";
  if (input.solBefore - BigInt(input.solAfter.lamports) > input.maxSolDebit) return "it costs too much SOL";
  const named = new Set(input.keys);
  if (input.others.some((o) => named.has(o))) return "it touches another asset in custody";
  return null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The real API. A fixed origin, no redirects, a size limit, and what comes back is never a URL we'd follow. */
export function relayApi(input: { fetchImpl?: typeof fetch; apiKey?: string } = {}): RelayApi {
  const f = input.fetchImpl ?? fetch;
  const read = async (res: Response) => {
    const text = await res.text();
    if (!res.ok || text.length > 262_144) throw new Error(`relay answered ${res.status}`);
    return JSON.parse(text) as Row;
  };
  const headers = { accept: "application/json", ...(input.apiKey ? { "x-api-key": input.apiKey } : {}) };
  return {
    async quote(body) {
      return read(await f(`${RELAY_ORIGIN}/quote/v2`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) }));
    },
    async status(requestId) {
      if (!/^0x[0-9a-f]{64}$/.test(requestId)) throw new Error("not a request id");
      const r = await read(await f(`${RELAY_ORIGIN}/intents/status/v3?requestId=${requestId}`, { headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) }));
      const hashes = Array.isArray(r.txHashes) ? r.txHashes.filter((h): h is string => typeof h === "string" && h.length <= 128).slice(0, 16) : [];
      return { status: typeof r.status === "string" ? r.status.slice(0, 40) : "unknown", txHashes: hashes };
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;
const usdEnv = (env: Env, key: string, fallback?: number): bigint => {
  const raw = env[key]?.trim();
  if (!raw) {
    if (fallback === undefined) throw new Error(`the passthrough needs ${key}`);
    return BigInt(Math.round(fallback * 1e6));
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of dollars`);
  return BigInt(Math.round(n * 1e6));
};
const xrpEnv = (env: Env, key: string, fallback: number): bigint => {
  const raw = env[key]?.trim();
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a number of XRP`);
  return BigInt(Math.round(n * 1e6));
};

/** The rails for a real card line. They're always built, because a switch turned off still has to finish what's out and recognize Relay's deliveries. */
export function relayRails(env: Env, wallets: { treasury: string; custody: string }, api: RelayApi = relayApi({ apiKey: env.SEAL_RELAY_API_KEY?.trim() || undefined })): RelayRails {
  const config = relayConfig(env);
  return {
    enabled: !!config,
    api,
    policy: { ...wallets, xrpSolvers: RELAY_XRP_SOLVERS, xrpDepositories: RELAY_XRP_DEPOSITORIES, solanaDepositories: RELAY_SOLANA_DEPOSITORIES, maxSwapMicro: config?.maxSwapMicro ?? 0n, maxDayMicro: config?.maxDayMicro ?? 0n },
    custodyTargetMicro: config?.custodyTargetMicro ?? 0n,
    custodyCeilingMicro: config?.custodyCeilingMicro ?? 0n,
    treasuryTargetDrops: config?.treasuryTargetDrops ?? 0n,
    treasuryCeilingDrops: config?.treasuryCeilingDrops ?? 0n,
    minBatchMicro: config?.minBatchMicro ?? 0n,
  };
}

/** The switch and its sizes. Unset or anything but "on" is off. On needs both caps spelled out: there is no default for how much can move. */
export function relayConfig(env: Env): (Pick<RelayRails, "custodyTargetMicro" | "custodyCeilingMicro" | "treasuryTargetDrops" | "treasuryCeilingDrops" | "minBatchMicro"> & Pick<RelayPolicy, "maxSwapMicro" | "maxDayMicro">) | null {
  if (env.SEAL_CARD_PASSTHROUGH?.trim() !== "on") return null;
  const out = {
    maxSwapMicro: usdEnv(env, "SEAL_RELAY_MAX_SWAP_USD"),
    maxDayMicro: usdEnv(env, "SEAL_RELAY_MAX_DAY_USD"),
    custodyTargetMicro: usdEnv(env, "SEAL_CUSTODY_TARGET_USD", 300),
    custodyCeilingMicro: usdEnv(env, "SEAL_CUSTODY_CEILING_USD", 1000),
    treasuryTargetDrops: xrpEnv(env, "SEAL_TREASURY_TARGET_XRP", 250),
    treasuryCeilingDrops: xrpEnv(env, "SEAL_TREASURY_CEILING_XRP", 1000),
    minBatchMicro: usdEnv(env, "SEAL_REFILL_MIN_USD", 100),
  };
  if (out.custodyCeilingMicro < out.custodyTargetMicro || out.treasuryCeilingDrops < out.treasuryTargetDrops) throw new Error("a ceiling is below its target");
  return out;
}
