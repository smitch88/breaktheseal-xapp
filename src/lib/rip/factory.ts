import { SHELF_PRICES } from "../../config/nft-packs.ts";
import { simulatedGateway, type CardGateway } from "./card-gateway.ts";
import { TESTNET_CLIO_RPC, rpcChain } from "./chain.ts";
import { ccConfig, collectorCryptGateway, custodyAddress } from "./cc-gateway.ts";
import { createEngine, type RipEngine } from "./engine.ts";
import { relayRails } from "./relay.ts";
import { fundingAddresses, multiConfig, railsConfig, treasuryBounds } from "./mode.ts";
import { liveArtResolver, xrplToMarket } from "./market.ts";
import { pgClient } from "./pg-pool.ts";
import { autobuyConfig, configRules, restockStage, type RestockDeps } from "./restock.ts";
import { createSigner } from "./signer.ts";
import { pgOnce, pgPrivate, pgStore } from "./store-pg.ts";
import { sealTokenSpec, type TokenSpec } from "./tokens.ts";
import { filePrivate, fileStore, memoryOnce, type EventStore, type OnceStore, type PrivateStore } from "./store.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The card line has its own switch, off unless SEAL_CARD_RAILS says otherwise. The simulated source can never run on
 * mainnet: a real XRP payment must never buy a pretend card.
 */
function cardRails(env: Env, mode: "testnet" | "mainnet"): { gateway: CardGateway; mirror: { issuer: string; transferFee: number; taxon: number; origin: string } } | null {
  const wanted = env.SEAL_CARD_RAILS?.trim();
  if (wanted !== "simulated" && wanted !== "collector-crypt") return null;
  for (const k of ["SEAL_MIRROR_ISSUER", "SEAL_MIRROR_MINTER_ADDRESS", "SEAL_MIRROR_MINTER_SEED", "SEAL_PUBLIC_ORIGIN"]) if (!env[k]?.trim()) throw new Error(`SEAL_CARD_RAILS needs ${k}`);
  if (wanted === "simulated" && mode === "mainnet") throw new Error("the simulated card source can't run on mainnet");
  // And the other way round: faucet XRP must never buy a real pack with real USDC.
  if (wanted === "collector-crypt" && mode !== "mainnet") throw new Error("the real card source runs only on mainnet");
  const mirror = { issuer: env.SEAL_MIRROR_ISSUER as string, transferFee: Number(env.SEAL_MIRROR_TRANSFER_FEE ?? 2000), taxon: Number(env.SEAL_MIRROR_TAXON ?? 1), origin: (env.SEAL_PUBLIC_ORIGIN as string).replace(/\/$/, "") };
  if (!Number.isInteger(mirror.transferFee) || mirror.transferFee < 0 || mirror.transferFee > 50000) throw new Error("SEAL_MIRROR_TRANSFER_FEE must be 0 to 50000");
  return { gateway: wanted === "simulated" ? simulatedGateway({ soldFile: env.SEAL_LOCAL_LOG ? `${env.SEAL_LOCAL_LOG}.sim-sold` : undefined }) : collectorCryptGateway(ccConfig(env)), mirror };
}

/**
 * The restocker's rules run on mainnet. Its floor check is on there unless SEAL_RELIST_FLOOR_CHECK=off, and buying stays off unless every one of
 * its switches says otherwise: see autobuyConfig. Testnet has no real market, so it keeps the plain re-add unless told to use these rules.
 */
export function restockDeps(env: Env, mode: "testnet" | "mainnet"): RestockDeps | undefined {
  if (mode !== "mainnet" && env.SEAL_RESTOCK_RULES?.trim() !== "on") return undefined;
  return { rules: configRules(restockStage(env)), market: env.SEAL_RELIST_FLOOR_CHECK?.trim() === "off" ? undefined : xrplToMarket(), art: liveArtResolver(), autobuy: autobuyConfig(env, mode) };
}

export interface Rails {
  readonly engine: RipEngine;
  readonly once: OnceStore;
  readonly secrets: PrivateStore;
  readonly cardsOn: boolean;
  readonly store: EventStore;
  readonly mode: "testnet" | "mainnet";
  readonly treasury: string;
  readonly vault: string;
  /** The SEAL token, or null while its prizes are off. New seasons commit to this; the admin tool passes it along. */
  readonly sealToken: TokenSpec | null;
  /** How long /api/rip/config may reuse a ledger read. Two seconds unless a test says otherwise. */
  readonly ledgerReadMs?: number;
}

/** Build the real rails from the environment, or null when the flag is off. Demo mode never gets past the first line. */
export function buildRails(env: Env): Rails | null {
  const config = railsConfig(env);
  if (config.mode === "demo" || !config.rpcUrl || config.networkId === null) return null;
  const cards = cardRails(env, config.mode);
  const signer = createSigner({ treasurySeed: env.SEAL_TREASURY_SEED as string, treasuryAddress: env.SEAL_TREASURY_ADDRESS as string, vaultSeed: env.SEAL_VAULT_SEED as string, vaultAddress: env.SEAL_VAULT_ADDRESS as string, minterSeed: cards ? env.SEAL_MIRROR_MINTER_SEED : undefined, minterAddress: cards ? env.SEAL_MIRROR_MINTER_ADDRESS : undefined });
  let store: EventStore;
  let once: OnceStore;
  let secrets: PrivateStore;
  if (env.DATABASE_URL?.trim()) {
    const sql = pgClient(env.DATABASE_URL.trim());
    store = pgStore(sql);
    once = pgOnce(sql);
    secrets = pgPrivate(sql);
  } else {
    store = fileStore(env.SEAL_LOCAL_LOG as string);
    once = memoryOnce();
    secrets = filePrivate(`${env.SEAL_LOCAL_LOG as string}.private`);
  }
  // Relay only goes between real XRP and real USDC. A testnet treasury or a simulated source must never be able to name it.
  if (env.SEAL_CARD_PASSTHROUGH?.trim() === "on" && (config.mode !== "mainnet" || env.SEAL_CARD_RAILS?.trim() !== "collector-crypt")) throw new Error("the passthrough runs only on mainnet with the real card source");
  const relay = cards && env.SEAL_CARD_RAILS?.trim() === "collector-crypt" ? relayRails(env, { treasury: signer.address("treasury"), custody: custodyAddress(env) }) : undefined;
  const engine = createEngine({
    store,
    chain: rpcChain(config.rpcUrl, fetch, config.mode === "testnet" ? { clioUrl: TESTNET_CLIO_RPC } : {}),
    signer,
    drawSecret: env.SEAL_DRAW_SECRET as string,
    expectedNetworkId: config.networkId,
    fundingAddresses: fundingAddresses(env),
    rateGuardBps: config.mode === "mainnet" ? 1500 : undefined,
    shelf: SHELF_PRICES,
    sealOff: !sealTokenSpec(env),
    multi: multiConfig(env) ?? undefined,
    ...treasuryBounds(env),
    restock: restockDeps(env, config.mode),
    ...(cards ?? {}),
    ...(relay ? { relay } : {}),
  });
  return { engine, once, secrets, cardsOn: !!cards, store, mode: config.mode, treasury: signer.address("treasury"), vault: signer.address("vault"), sealToken: sealTokenSpec(env) };
}
