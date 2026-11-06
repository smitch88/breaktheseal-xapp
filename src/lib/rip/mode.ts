import { MAINNET_ID, TESTNET_ID, TESTNET_RPC } from "./chain.ts";

/**
 * The one switch for real rails. Unset, or anything unrecognized, is demo: no engine, no signer, no route that takes
 * anything. Testnet needs its own wallets. Mainnet needs SEAL_RAILS_MODE=mainnet AND the exact confirmation sentence AND
 * a database AND its own RPC, so no single typo or leftover setting can turn real money on.
 */
export type RailsMode = "demo" | "testnet" | "mainnet";

// The live deploy's SEAL_REAL_MONEY_CONFIRM holds these exact words. Changing them here switches real money off, so the old name stays.
export const MAINNET_CONFIRMATION = "the owner turned on real XRP for SEAL Rips";

export interface RailsConfig {
  readonly mode: RailsMode;
  readonly rpcUrl: string | null;
  readonly networkId: number | null;
  readonly problems: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const REQUIRED = ["SEAL_TREASURY_ADDRESS", "SEAL_TREASURY_SEED", "SEAL_VAULT_ADDRESS", "SEAL_VAULT_SEED", "SEAL_DRAW_SECRET"] as const;

export function railsConfig(env: Env): RailsConfig {
  const wanted = env.SEAL_RAILS_MODE?.trim();
  if (wanted !== "testnet" && wanted !== "mainnet") return { mode: "demo", rpcUrl: null, networkId: null, problems: [] };
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  const problems: string[] = missing.map((k) => `${k} isn't set`);
  if (!env.DATABASE_URL?.trim() && !env.SEAL_LOCAL_LOG?.trim()) problems.push("DATABASE_URL isn't set");
  if ((env.SEAL_DRAW_SECRET?.trim().length ?? 0) < 32) problems.push("SEAL_DRAW_SECRET must be 32 characters or more");
  if (wanted === "testnet") {
    if (problems.length) return { mode: "demo", rpcUrl: null, networkId: null, problems };
    return { mode: "testnet", rpcUrl: env.SEAL_XRPL_RPC?.trim() || TESTNET_RPC, networkId: TESTNET_ID, problems: [] };
  }
  // Mainnet refuses the local file log, and has no default RPC.
  if (env.SEAL_REAL_MONEY_CONFIRM !== MAINNET_CONFIRMATION) problems.push("SEAL_REAL_MONEY_CONFIRM doesn't match");
  if (!env.DATABASE_URL?.trim()) problems.push("mainnet needs DATABASE_URL");
  if (env.SEAL_LOCAL_LOG?.trim()) problems.push("mainnet can't use a local log");
  if (!env.SEAL_XRPL_RPC?.trim()) problems.push("mainnet needs SEAL_XRPL_RPC");
  // One server is trusted to say what was paid, so nobody on the wire can be.
  else if (!/^https:\/\//.test(env.SEAL_XRPL_RPC.trim())) problems.push("SEAL_XRPL_RPC must be https");
  if (env.SEAL_CARD_RAILS?.trim() === "simulated") problems.push("mainnet can't use the simulated card source");
  if (problems.length) return { mode: "demo", rpcUrl: null, networkId: null, problems };
  return { mode: "mainnet", rpcUrl: env.SEAL_XRPL_RPC!.trim(), networkId: MAINNET_ID, problems: [] };
}

export const adminAddresses = (env: Env): readonly string[] =>
  (env.SEAL_ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const fundingAddresses = (env: Env): readonly string[] =>
  (env.SEAL_FUNDING_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** While non-empty, only these wallets can open or act on anything. Real money stays closed to everyone else. */
export const allowedWallets = (env: Env): readonly string[] =>
  (env.SEAL_ALLOWED_WALLETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The site's own wallets. Signed in, they can look around (testers add them to Xaman read-only), but they can't buy or act on
 * anything: the treasury can't pay itself, a vault prize would be an offer to itself, and either one buying would spend house money.
 */
export const isHouseWallet = (env: Env, address: string): boolean =>
  [env.SEAL_TREASURY_ADDRESS, env.SEAL_VAULT_ADDRESS, env.SEAL_MIRROR_MINTER_ADDRESS, env.SEAL_MIRROR_ISSUER].some((a) => !!a?.trim() && a.trim() === address);

/** The most packs one payment can ever cover, whatever the env says. */
export const MULTI_HARD_MAX = 20;
/** Until the owner raises it. */
export const MULTI_DEFAULT_MAX = 3;

export interface MultiConfig {
  /** The most NFT packs in one order, before stock and cover have their say. */
  readonly max: number;
  /** The same for card packs. 1 means a card pack has no picker: its cost comes out of custody's USDC. */
  readonly cardMax: number;
}

const multiCap = (raw: string | undefined, fallback: number) => {
  const n = raw?.trim() ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MULTI_HARD_MAX) : fallback;
};

/**
 * How much XRP the treasury keeps back before a pack opens (owner, 2026-11-03: "we don't need the treasury to have that set to work,
 * lower the bounds to keep it open"). Unset, the built-in defaults hold: a 10 XRP floor, and cover for every place held at once.
 *   SEAL_TREASURY_FLOOR_XRP  1 to 1000 (decimals allowed): XRP never counted as free. Below 1 is refused: the account reserve alone is 1.
 *   SEAL_XRP_COVER_PLACES    1 to 20: at most this many places count toward a season's XRP cover. 1 = one top prize, however many are held.
 * A prize the treasury can't pay at once is owed and goes out when it's topped up; nothing is taken back.
 */
export function treasuryBounds(env: Env): { treasuryFloorDrops?: bigint; xrpCoverPlacesMax?: number } {
  const out: { treasuryFloorDrops?: bigint; xrpCoverPlacesMax?: number } = {};
  const floor = env.SEAL_TREASURY_FLOOR_XRP?.trim();
  if (floor && /^\d{1,4}(\.\d{1,6})?$/.test(floor)) {
    const [whole, frac = ""] = floor.split(".");
    const drops = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
    if (drops >= 1_000_000n && drops <= 1_000_000_000n) out.treasuryFloorDrops = drops;
  }
  const places = env.SEAL_XRP_COVER_PLACES?.trim();
  if (places && /^\d{1,2}$/.test(places) && Number(places) >= 1 && Number(places) <= MULTI_HARD_MAX) out.xrpCoverPlacesMax = Number(places);
  return out;
}

/** Buying several packs at once. Off unless SEAL_MULTI_QTY is exactly "on", and low until the owner raises SEAL_MULTI_MAX. */
export function multiConfig(env: Env): MultiConfig | null {
  if (env.SEAL_MULTI_QTY !== "on") return null;
  return { max: multiCap(env.SEAL_MULTI_MAX, MULTI_DEFAULT_MAX), cardMax: multiCap(env.SEAL_MULTI_CARD_MAX, 1) };
}
