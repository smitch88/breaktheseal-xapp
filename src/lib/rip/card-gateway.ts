import { SELL_FEE_PERCENT } from "../sellback.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RelayInstruction } from "./relay.ts";

/**
 * The source of cards. The engine journals every step around these calls, so each one is either safe to repeat or held
 * for a person when its answer is lost. `collectorCryptGateway` is the real one. `simulatedGateway` is for smoke tests
 * only, is labeled in every record it makes, and can't be selected on mainnet.
 */
export interface CardMachine {
  readonly code: string;
  readonly name: string;
  readonly usd: number;
  readonly instantBuybackPct: number;
}

export interface OpenedCard {
  readonly mint: string;
  readonly name: string;
  readonly img: string;
  readonly grade: string;
  readonly insuredMicro: string;
  readonly rarity: string;
}

export interface CardGateway {
  readonly label: "collector-crypt" | "simulated";
  machine(code: string): Promise<CardMachine | null>;
  /** USDC on hand to buy packs with, in micro dollars. */
  floatMicro(): Promise<bigint>;
  /** SOL on custody for network fees, in lamports. */
  gasLamports(): Promise<bigint>;
  /** Ask for one random pack. An answer lost here is held for a person, because asking again would buy a different pack. */
  generate(code: string, ref: string): Promise<{ memo: string; transaction: string }>;
  /** Check the provider's unsigned payment against our rules, and sign it. Pure: nothing is sent. */
  sign(input: { memo: string; transaction: string; usd: number }): Promise<{ signature: string; bytes: string }>;
  /** Send the same bytes again as often as needed. */
  send(bytes: string, signature: string): Promise<void>;
  sourceStatus(signature: string): Promise<"finalized" | "pending" | "failed">;
  /** True only if this signed payment can never land: its blockhash has gone and the signature has no status. Throws if it can't tell. */
  sourceExpired(bytes: string, signature: string): Promise<boolean>;
  /** Null until the provider's reveal is ready. */
  open(memo: string): Promise<OpenedCard | null>;
  /** Read the source chain for the card now. */
  prove(mint: string): Promise<{ held: boolean; slot: number; proof: string }>;
  sellQuote(mint: string, insuredMicro: string, instantBuybackPct: number): Promise<{ usdMicro: bigint }>;
  /**
   * Idempotent on `ref`: the same ref never sells twice. `minNetMicro` is what the player was quoted, and `others` is every
   * other card in custody, which a sale's transaction must not touch.
   */
  sellBack(mint: string, ref: string, guard?: { readonly minNetMicro?: string | null; readonly others?: readonly string[] }): Promise<{ usdMicro: string; ref: string }>;
  /** Build Relay's deposit, judge what simulation says it does to custody, and sign. Pure: nothing is sent. Throws if it won't sign. */
  signRelaySwap(input: { orderId: string; instructions: readonly RelayInstruction[]; lookupTables: readonly string[]; amountMicro: bigint; others: readonly string[] }): Promise<{ signature: string; bytes: string }>;
  /** Send signed bytes to Solana, and only Solana: this isn't Collector Crypt's transaction. Safe to repeat. */
  sendRaw(bytes: string, signature: string): Promise<void>;
  /** USDC this one finalized transaction put in custody, or null if it doesn't show at least this much. Throws if it can't tell. */
  proveUsdcFill(signature: string, minMicro: bigint): Promise<{ micro: string; slot: number } | null>;
}

/** Thrown when the provider said no, for certain, and no pack exists. Anything else is treated as unknown. */
export class GatewayRefused extends Error {}

/** Whole cents rounded down: insured x instant buyback, less the sell fee, the same rule the card pages show. */
export function cardSellMicro(insuredMicro: string, instantBuybackPct: number): bigint {
  const raw = (BigInt(insuredMicro) * BigInt(Math.round(instantBuybackPct * 100)) * BigInt(100 - SELL_FEE_PERCENT)) / 1_000_000n;
  return (raw / 10_000n) * 10_000n;
}

const CARDS = [
  { name: "SIMULATED: Mega Dragonite", grade: "CGC 10", insuredMicro: "14000000", rarity: "common" },
  { name: "SIMULATED: Charizard Holo", grade: "PSA 9", insuredMicro: "26000000", rarity: "uncommon" },
  { name: "SIMULATED: Umbreon Star", grade: "PSA 10", insuredMicro: "90000000", rarity: "rare" },
];

/**
 * A stand-in for Collector Crypt's API and the Solana custody leg. No request leaves this process, and every card it
 * returns says SIMULATED in its name. It holds its state on disk when given a path, so a restart behaves like a real
 * provider that remembers its packs.
 */
export function simulatedGateway(input: { floatMicro?: bigint; failNext?: () => "refuse" | "lost" | null; soldFile?: string } = {}): CardGateway {
  const packs = new Map<string, { code: string }>();
  const paid = new Set<string>();
  const held = new Set<string>();
  const load = (): [string, { usdMicro: string; ref: string }][] => (input.soldFile && existsSync(input.soldFile) ? JSON.parse(readFileSync(input.soldFile, "utf8")) : []);
  const sold = new Map(load());
  const save = () => {
    if (input.soldFile) writeFileSync(input.soldFile, JSON.stringify([...sold]));
  };
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  return {
    label: "simulated",
    machine: async (code) => (code === "pokemon_25" ? { code, name: "SIMULATED Pokémon 25", usd: 25, instantBuybackPct: 85 } : null),
    floatMicro: async () => input.floatMicro ?? 400_000_000n,
    gasLamports: async () => 50_000_000n,
    generate: async (code, ref) => {
      const fail = input.failNext?.();
      if (fail === "refuse") throw new GatewayRefused("simulated refusal");
      if (fail === "lost") throw new Error("simulated lost answer");
      const memo = `sim-${hash(ref).slice(0, 16)}`;
      packs.set(memo, { code });
      return { memo, transaction: Buffer.from(JSON.stringify({ simulated: true, memo })).toString("base64") };
    },
    sign: async ({ memo, transaction }) => ({ signature: `simsig-${hash(memo + transaction).slice(0, 40)}`, bytes: transaction }),
    send: async (bytes, signature) => {
      void bytes;
      paid.add(signature);
    },
    sourceStatus: async (signature) => (paid.has(signature) ? "finalized" : "pending"),
    sourceExpired: async () => false,
    open: async (memo) => {
      const n = parseInt(hash(memo).slice(0, 8), 16);
      const card = CARDS[n % CARDS.length];
      const mint = `SiM${hash(memo).slice(0, 40)}`;
      if (![...sold.keys()].includes(`mint:${mint}`)) held.add(mint);
      return { ...card, mint, img: "/assets/testnet-nft.webp" };
    },
    // A restart forgets nothing that matters: a simulated card is in custody until it has been sold.
    prove: async (mint) => ({ held: mint.startsWith("SiM") && !sold.has(`mint:${mint}`), slot: 1, proof: `simulated-custody:${hash(mint).slice(0, 24)}` }),
    sellQuote: async (_mint, insuredMicro, pct) => ({ usdMicro: cardSellMicro(insuredMicro, pct) }),
    sellBack: async (mint, ref) => {
      const done = sold.get(ref);
      if (done) return done;
      held.delete(mint);
      const out = { usdMicro: "0", ref: `simsale-${hash(ref).slice(0, 16)}` };
      sold.set(ref, out);
      sold.set(`mint:${mint}`, out);
      save();
      return out;
    },
    // A simulated source never swaps: there's no USDC to move, and a checkout on it never reads custody as short.
    signRelaySwap: async () => {
      throw new Error("the simulated source doesn't swap");
    },
    sendRaw: async () => {},
    proveUsdcFill: async () => null,
  };
}
