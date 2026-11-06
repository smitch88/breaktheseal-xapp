import { createHash } from "node:crypto";
import { simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { RELAY_SOLANA_DEPOSITORIES, RELAY_XRP_DEPOSITORIES, RELAY_XRP_SOLVERS, type RelayApi, type RelayPolicy, type RelayRails } from "../src/lib/rip/relay.ts";
import { TREASURY as DEFAULT_TREASURY, type testLedger } from "./support-ledger.ts";

/**
 * Relay and Solana custody with the shapes the real ones answer in (quotes built to match test/fixtures/relay). The ledger side is the
 * simulated XRP ledger, so a delivery is a real Payment from the solver that goes through the engine's own scan.
 */
const DEFAULT_SOLVER = RELAY_XRP_SOLVERS[0];
const DEFAULT_DEPOSITORY = RELAY_XRP_DEPOSITORIES[0];
export const SOLVER = DEFAULT_SOLVER;
export const DEPOSITORY = DEFAULT_DEPOSITORY;
export const SOL_DEPOSITORY = RELAY_SOLANA_DEPOSITORIES[0];
export const CUSTODY = "8kpUHDwhZ5GYpuBmzjgsAK3jWZe3TGxZDPktSn6MCXm8";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XRP = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";
const hex32 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
export const memoHex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

export type Outcome = "success" | "slow" | "refund" | "never" | "partial";
type Ledger = ReturnType<typeof testLedger>;

export function fakeCustody(startUsdcMicro = 0n, opts: { machineUsd?: number; insuredMicro?: string; pct?: number } = {}) {
  const sim = simulatedGateway();
  const c = {
    usdc: startUsdcMicro,
    sol: 10_000_000n,
    calls: [] as string[],
    amounts: new Map<string, bigint>(),
    debited: new Set<string>(),
    relaySent: new Set<string>(),
    fills: new Map<string, bigint>(),
    onRelaySent: (_o: { orderId: string; amountMicro: bigint; signature: string }) => {},
    relayOrders: new Map<string, { orderId: string; amountMicro: bigint }>(),
    refuseGenerate: false,
    /** Collector Crypt not taking the sale yet. */
    holdSale: false,
    failSign: null as string | null,
    expired: new Set<string>(),
  };
  const usd = opts.machineUsd ?? 25;
  const gateway: CardGateway = {
    ...sim,
    machine: async (code) => (code === "pokemon_25" ? { code, name: "SIMULATED Pokémon 25", usd, instantBuybackPct: opts.pct ?? 85 } : null),
    floatMicro: async () => c.usdc,
    gasLamports: async () => c.sol,
    generate: async (code, ref) => {
      c.calls.push("generate");
      if (c.refuseGenerate) throw new (await import("../src/lib/rip/card-gateway.ts")).GatewayRefused("no");
      return sim.generate(code, ref);
    },
    sign: async (i) => {
      const s = await sim.sign(i);
      c.amounts.set(s.signature, BigInt(Math.round(i.usd * 1e6)));
      return s;
    },
    send: async (bytes, sig) => {
      await sim.send(bytes, sig);
    },
    open: async (memo) => {
      const card = await sim.open(memo);
      return card && opts.insuredMicro ? { ...card, insuredMicro: opts.insuredMicro } : card;
    },
    sellBack: async (mint, ref, guard) => {
      if (c.holdSale) throw new Error("not yet");
      const done = await sim.sellBack(mint, ref, guard);
      const gross = guard?.minNetMicro ? (BigInt(guard.minNetMicro) * 100n) / 98n + 1n : 0n;
      c.usdc += gross;
      c.calls.push("sellBack");
      return { usdMicro: gross.toString(), ref: done.ref };
    },
    signRelaySwap: async (i) => {
      if (c.failSign) throw new Error(c.failSign);
      const signature = `relaysig-${createHash("sha256").update(`${i.orderId}|${i.amountMicro}`).digest("hex").slice(0, 40)}`;
      c.relayOrders.set(signature, { orderId: i.orderId, amountMicro: i.amountMicro });
      return { signature, bytes: signature };
    },
    sendRaw: async (_bytes, signature) => {
      if (c.relaySent.has(signature)) return;
      const o = c.relayOrders.get(signature);
      if (!o || c.expired.has(signature)) return;
      c.relaySent.add(signature);
      c.usdc -= o.amountMicro;
      if (c.usdc < 0n) throw new Error("custody overdrawn by a swap");
      c.onRelaySent({ ...o, signature });
    },
    // A finalized balance shows a payment only once it has finalized, which is about when its status says so.
    sourceStatus: async (sig) => {
      if (c.relayOrders.has(sig)) return c.relaySent.has(sig) ? "finalized" : "pending";
      const status = await sim.sourceStatus(sig);
      if (status === "finalized" && !c.debited.has(sig)) {
        c.debited.add(sig);
        c.usdc -= c.amounts.get(sig) ?? 0n;
        if (c.usdc < 0n) throw new Error("custody overdrawn: a pack was paid with USDC that wasn't there");
      }
      return status;
    },
    sourceExpired: async (bytes, sig) => (c.relayOrders.has(sig) ? c.expired.has(sig) : sim.sourceExpired(bytes, sig)),
    proveUsdcFill: async (signature, minMicro) => {
      const got = c.fills.get(signature);
      return got !== undefined && got >= minMicro ? { micro: got.toString(), slot: 1 } : null;
    },
  };
  return { gateway, c };
}

/** Relay itself. Each order takes its outcome from `next`, or the default. `tick` plays deliveries forward. */
export function fakeRelay(ledger: Pick<Ledger, "fund" | "userSubmit" | "history">, custody: ReturnType<typeof fakeCustody>["c"], opts: { usdPerXrp?: number; feeBps?: number; treasury?: string; solver?: string; depository?: string } = {}) {
  const TREASURY = opts.treasury ?? DEFAULT_TREASURY;
  const SOLVER = opts.solver ?? DEFAULT_SOLVER;
  const DEPOSITORY = opts.depository ?? DEFAULT_DEPOSITORY;
  const r = {
    usdPerXrp: opts.usdPerXrp ?? 1.25,
    feeBps: opts.feeBps ?? 30,
    down: false,
    quotes: 0,
    tamper: null as null | ((q: Record<string, any>) => void),
    outcome: "success" as Outcome,
    next: [] as Outcome[],
    orders: new Map<string, { requestId: string; orderId: string; dir: "buy" | "sell"; inAmount: bigint; outMin: bigint; outcome: Outcome | null; status: string; txHashes: string[]; done: boolean }>(),
    n: 0,
    seenDeposits: new Set<string>(),
    deposits: [] as { hash: string; orderId: string; drops: bigint }[],
    delivered: [] as { orderId: string; drops?: bigint; micro?: bigint }[],
    pendingDelivery: [] as string[],
  };
  ledger.fund(SOLVER, 1_000_000);
  ledger.fund(DEPOSITORY, 100);
  const payXrp = (orderId: string, drops: bigint, memo = true) => {
    const hash = ledger.userSubmit({ TransactionType: "Payment", Account: SOLVER, Destination: TREASURY, Amount: drops.toString(), ...(memo ? { Memos: [{ Memo: { MemoData: memoHex(orderId) } }] } : {}) } as never);
    return hash;
  };
  /** Play an order's outcome. */
  const settle = (o: NonNullable<ReturnType<typeof r.orders.get>>) => {
    if (o.done) return;
    // Decided when money arrives, not when quoted: a quote asked for only to check Relay is up moves nothing.
    o.outcome ??= r.next.shift() ?? r.outcome;
    if (o.outcome === "never" || o.outcome === "slow") return void (o.status = "pending");
    o.done = true;
    if (o.dir === "buy") {
      if (o.outcome === "refund") {
        o.status = "refund";
        o.txHashes.push(payXrp(o.orderId, o.inAmount));
        return;
      }
      const out = o.outcome === "partial" ? o.outMin / 2n : o.outMin;
      const sig = `fill-${o.orderId.slice(2, 40)}`;
      custody.usdc += out;
      custody.fills.set(sig, out);
      o.status = "success";
      o.txHashes.push(sig);
      r.delivered.push({ orderId: o.orderId, micro: out });
      return;
    }
    if (o.outcome === "refund") {
      const sig = `back-${o.orderId.slice(2, 40)}`;
      custody.usdc += o.inAmount;
      custody.fills.set(sig, o.inAmount);
      o.status = "refund";
      o.txHashes.push(sig);
      return;
    }
    const drops = o.outcome === "partial" ? o.outMin / 2n : o.outMin;
    o.status = "success";
    o.txHashes.push(payXrp(o.orderId, drops));
    r.delivered.push({ orderId: o.orderId, drops });
  };
  custody.onRelaySent = ({ orderId }) => {
    const o = r.orders.get(orderId);
    if (o) settle(o);
  };
  const api: RelayApi = {
    async quote(body) {
      if (r.down) throw new Error("relay is down");
      r.quotes += 1;
      const n = ++r.n;
      const requestId = hex32(`req${n}`);
      const orderId = hex32(`ord${n}`);
      const buy = body.originCurrency === "xrp";
      const fee = r.feeBps;
      let inAmount: bigint;
      let outAmount: bigint;
      if (buy) {
        if (body.tradeType === "EXACT_OUTPUT") {
          outAmount = BigInt(body.amount);
          inAmount = (((outAmount * BigInt(10_000 + fee)) / 10_000n) * 1_000_000n) / BigInt(Math.round(r.usdPerXrp * 1e6));
        } else {
          inAmount = BigInt(body.amount);
          outAmount = (((inAmount * BigInt(Math.round(r.usdPerXrp * 1e6))) / 1_000_000n) * BigInt(10_000 - fee)) / 10_000n;
        }
      } else {
        inAmount = BigInt(body.amount);
        outAmount = (((inAmount * 1_000_000n) / BigInt(Math.round(r.usdPerXrp * 1e6))) * BigInt(10_000 - fee)) / 10_000n;
      }
      const outMin = buy ? outAmount : (outAmount * 995n) / 1000n;
      r.orders.set(orderId, { requestId, orderId, dir: buy ? "buy" : "sell", inAmount, outMin, outcome: null, status: "waiting", txHashes: [], done: false });
      const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;
      const refundXrp = { chainId: "xrp", recipient: TREASURY, currency: XRP, minimumAmount: "0", deadline, extraData: "0x" };
      const refundSol = { chainId: "solana", recipient: CUSTODY, currency: USDC, minimumAmount: "0", deadline, extraData: "0x" };
      const order = {
        version: "v1",
        solverChainId: "base",
        solver: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
        salt: hex32(`salt${n}`),
        inputs: [{ payment: { chainId: buy ? "xrp" : "solana", currency: buy ? XRP : USDC, amount: inAmount.toString(), weight: "1" }, refunds: buy ? [refundXrp, refundSol] : [refundSol, refundXrp] }],
        output: { chainId: buy ? "solana" : "xrp", payments: [{ recipient: buy ? CUSTODY : TREASURY, currency: buy ? USDC : XRP, minimumAmount: outMin.toString(), expectedAmount: outAmount.toString() }], calls: [], deadline, extraData: "0x" },
        fees: [],
      };
      const amountLe = Buffer.alloc(8);
      amountLe.writeBigUInt64LE(inAmount);
      const data = buy
        ? { to: DEPOSITORY, currency: "xrp", amount: inAmount.toString(), memo: orderId }
        : { instructions: [{ keys: [{ pubkey: CUSTODY, isSigner: true, isWritable: true }], programId: SOL_DEPOSITORY, data: `0b9c60da27a3b413${amountLe.toString("hex")}${orderId.slice(2)}` }], addressLookupTableAddresses: [] };
      const raw: Record<string, any> = {
        requestId,
        steps: [{ id: "deposit", action: "Confirm", description: "", kind: "transaction", requestId, depositAddress: "", items: [{ status: "incomplete", data, check: { endpoint: `/intents/status/v3?requestId=${requestId}`, method: "GET" } }] }],
        fees: {},
        details: { operation: "swap", sender: buy ? TREASURY : CUSTODY, recipient: buy ? CUSTODY : TREASURY, currencyIn: { amount: inAmount.toString() }, currencyOut: { amount: outAmount.toString(), minimumAmount: outMin.toString() } },
        protocol: { v2: { orderId, hubType: "onchain", orderData: order, paymentDetails: { chainId: buy ? "xrp" : "solana", depository: buy ? DEPOSITORY : SOL_DEPOSITORY, currency: buy ? XRP : USDC, amount: inAmount.toString() } } },
      };
      r.tamper?.(raw);
      return raw;
    },
    async status(requestId) {
      if (r.down) throw new Error("relay is down");
      const o = [...r.orders.values()].find((x) => x.requestId === requestId);
      return { status: o?.status ?? "unknown", txHashes: o?.txHashes ?? [] };
    },
  };
  return Object.assign(r, {
    api,
    /** What a deposit landing and a solver noticing it looks like. */
    tick() {
      for (const t of ledger.history) {
        if (t.tx.Destination !== DEPOSITORY || t.result !== "tesSUCCESS" || r.seenDeposits.has(t.hash)) continue;
        r.seenDeposits.add(t.hash);
        const memo = ((t.tx.Memos as { Memo: { MemoData: string } }[] | undefined) ?? [])[0]?.Memo.MemoData ?? "";
        const orderId = Buffer.from(memo, "hex").toString("utf8");
        r.deposits.push({ hash: t.hash, orderId, drops: BigInt(String(t.tx.Amount)) });
        const o = r.orders.get(orderId);
        if (o) settle(o);
      }
    },
    /** Let an order that was slow or silent finish after all. */
    finish(orderId: string, outcome: Outcome = "success") {
      const o = r.orders.get(orderId);
      if (o) {
        o.outcome = outcome;
        o.done = false;
        settle(o);
      }
    },
    payXrp,
  });
}

export const DEFAULT_POLICY: Omit<RelayPolicy, "treasury" | "custody"> = {
  xrpSolvers: RELAY_XRP_SOLVERS,
  xrpDepositories: RELAY_XRP_DEPOSITORIES,
  solanaDepositories: RELAY_SOLANA_DEPOSITORIES,
  maxSwapMicro: 20_000_000_000n,
  maxDayMicro: 50_000_000_000n,
};

export function railsFor(api: RelayApi, over: Partial<Omit<RelayRails, "policy">> & { policy?: Partial<RelayPolicy> } = {}): RelayRails {
  const { policy, ...rest } = over;
  return {
    enabled: true,
    api,
    policy: { treasury: DEFAULT_TREASURY, custody: CUSTODY, ...DEFAULT_POLICY, ...policy },
    custodyTargetMicro: 100_000_000n,
    custodyCeilingMicro: 1_000_000_000n,
    treasuryTargetDrops: 200_000_000n,
    treasuryCeilingDrops: 2_000_000_000n,
    minBatchMicro: 40_000_000n,
    refillLookMs: 0,
    ...rest,
  };
}
