import type { TokenPrizeRow } from "../../config/nft-packs.ts";
import type { EmptyBand, ItemOdds, PrizeRow } from "./draw.ts";

/**
 * Token prizes, in pure code that runs the same on the server and in a browser. A prize is a fixed amount struck at the
 * draw, like a cubes.fun BURR ticket: "56,300,000 SEAL". After that the amount never changes, whatever the price does.
 * XRP needs no price: its amount is its value. SEAL's amount comes from the XRP/SEAL AMM's own reserves at the pull's
 * entropy ledger, which anyone can read back, so the strike replays like the rest of the draw.
 */
export const XRP_TOKEN = "XRP";
export const SEAL_TOKEN = "SEAL";

/** "SEAL" as a ledger currency code. The token is also known as JoeLee; it's one token, and prize copy calls it SEAL. */
export const SEAL_CURRENCY = "5345414C00000000000000000000000000000000";
/**
 * The issuer the owner named, 2026-11-01, checked on the ledger: blackholed, no freeze, no clawback, no transfer fee.
 * Another issuer (rapAKxSwGodHqVjQeKdKb1EznhDAYisYiB) uses the same currency code, so the code alone proves nothing.
 * The SEAL on XRPL NFT collections are something else entirely: their issuers have nothing to do with this.
 */
export const SEAL_ISSUER = "r4pXXQzJ8soYSX4QKeeW4BzRQS1PCtVYLJ";

export interface TokenSpec {
  readonly id: string;
  readonly currency: string;
  readonly issuer: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The SEAL token. SEAL_TOKEN_PRIZES=off opens new seasons without it, and tells a running site to pay any SEAL row of a season
 * already open in XRP at its value. Prizes already struck stay SEAL. The issuer can be overridden for testnet only.
 */
export function sealTokenSpec(env: Env): TokenSpec | null {
  if (env.SEAL_TOKEN_PRIZES?.trim() === "off") return null;
  const issuer = env.SEAL_TOKEN_ISSUER?.trim() || SEAL_ISSUER;
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer)) throw new Error("SEAL_TOKEN_ISSUER isn't an XRPL address");
  if (issuer !== SEAL_ISSUER && env.SEAL_RAILS_MODE?.trim() === "mainnet") throw new Error("on mainnet the SEAL token's issuer is fixed");
  return { id: SEAL_TOKEN, currency: SEAL_CURRENCY, issuer };
}

/** A tier's rows as a season stores them. With SEAL on, half of each row's share pays it, and the other half XRP. */
export function prizeTableFor(rows: readonly TokenPrizeRow[], sealOn: boolean): PrizeRow[] {
  const out: PrizeRow[] = [];
  for (const r of rows) {
    const valueDrops = String(Math.round(r.xrp * 1e6));
    if (sealOn) {
      const half = Math.floor(r.bps / 2);
      out.push({ band: r.band, token: SEAL_TOKEN, bps: half, valueDrops, ...(r.dust ? { dust: true } : {}) });
      out.push({ band: r.band, token: XRP_TOKEN, bps: r.bps - half, valueDrops });
    } else {
      out.push({ band: r.band, token: XRP_TOKEN, bps: r.bps, valueDrops });
    }
  }
  return out;
}

/** Everything a price check needs, as the ledger holds it. Reserves stay integers: drops, and millionths of a token. */
export interface PoolRead {
  readonly ledger: number;
  readonly xrpDrops: string;
  readonly tokenMicro: string;
  /** When that ledger closed. Null when the server didn't say, which counts as stale for a live quote. */
  readonly closeMs: number | null;
}

export interface TokenPolicy {
  /** Ledgers back for the earlier look. At about 4 seconds a ledger, 450 is half an hour. */
  readonly priorLedgers: number;
  /** The most the pool may have moved over that half hour. */
  readonly maxMoveBps: number;
  /** A pool thinner than this isn't a price. */
  readonly minPoolDrops: bigint;
  /** No single prize may be worth more than this share of the pool's XRP side, so the market can absorb it. */
  readonly maxPrizeOfPoolBps: number;
  /** A live quote can't use a ledger older than this. */
  readonly maxAgeMs: number;
  /** Hard sanity band: drops per 1,000,000 whole tokens. */
  readonly minDropsPerMillion: bigint;
  readonly maxDropsPerMillion: bigint;
}

/** What a player gets for SEAL by redeeming it and selling it on the pool: the 1% fee and a little slippage off its value. */
export const SEAL_LIQUID_SHARE = 0.985;

/** Room over today's price when promising a place: a draw can strike up to the price guard's move above what was reserved. */
export const COVER_HEADROOM_BPS = 11_000n;

export const TOKEN_POLICY: TokenPolicy = {
  priorLedgers: 450,
  maxMoveBps: 500,
  minPoolDrops: 5_000_000_000n,
  maxPrizeOfPoolBps: 100,
  maxAgeMs: 60_000,
  minDropsPerMillion: 50_000n,
  maxDropsPerMillion: 20_000_000n,
};

export interface Price {
  readonly xrpDrops: string;
  readonly tokenMicro: string;
}
export type PriceCheck = { readonly ok: true; readonly strike: Price; readonly sell: Price } | { readonly ok: false; readonly code: string };

/** An issued token's value as the ledger writes it ("44788357114.1098", "5188873850259730e-4"), in whole millionths, rounded down. */
export function iouToMicro(value: string): string {
  const m = /^(-?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(value.trim());
  if (!m || (!m[2] && !m[3])) throw new Error("not a token value");
  const digits = BigInt(`${m[2] ?? ""}${m[3] ?? ""}` || "0");
  const shift = Number(m[4] ?? 0) - (m[3]?.length ?? 0) + 6;
  const out = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return (m[1] ? -out : out).toString();
}

const parse = (s: string) => (/^[1-9][0-9]*$/.test(s) ? BigInt(s) : null);
const no = (code: string): PriceCheck => ({ ok: false, code });

/**
 * Never pay from a bad quote. Stale, thin, out of band or moving fast is a code, never a guess. The strike takes the dearer
 * of now and half an hour ago, so a pushed-down pool can't buy more tokens than a dollar should, and a sale takes the cheaper.
 */
export function checkPool(now: PoolRead, prior: PoolRead, policy: TokenPolicy = TOKEN_POLICY, atMs?: number): PriceCheck {
  const x = parse(now.xrpDrops);
  const t = parse(now.tokenMicro);
  const px = parse(prior.xrpDrops);
  const pt = parse(prior.tokenMicro);
  if (x === null || t === null || px === null || pt === null) return no("price_unreadable");
  if (atMs !== undefined && (now.closeMs === null || atMs - now.closeMs > policy.maxAgeMs)) return no("price_stale");
  if (x < policy.minPoolDrops) return no("pool_thin");
  // drops per million whole tokens is x / (t / 1e6 / 1e6) = x * 1e12 / t.
  const perMillion = (x * 1_000_000_000_000n) / t;
  if (perMillion < policy.minDropsPerMillion || perMillion > policy.maxDropsPerMillion) return no("price_out_of_band");
  // Compare x/t with px/pt without dividing.
  const a = x * pt;
  const b = px * t;
  const gap = a > b ? a - b : b - a;
  const low = a < b ? a : b;
  if (gap * 10_000n > low * BigInt(policy.maxMoveBps)) return no("price_moved");
  const nowDearer = a >= b;
  const dear = { xrpDrops: nowDearer ? now.xrpDrops : prior.xrpDrops, tokenMicro: nowDearer ? now.tokenMicro : prior.tokenMicro };
  const cheap = { xrpDrops: nowDearer ? prior.xrpDrops : now.xrpDrops, tokenMicro: nowDearer ? prior.tokenMicro : now.tokenMicro };
  return { ok: true, strike: dear, sell: cheap };
}

/** Floored to three significant figures, so a prize reads clean and is never worth more than its value. */
export function prettyAmount(n: bigint, significant = 3): bigint {
  if (n <= 0n) return 0n;
  const digits = n.toString().length;
  if (digits <= significant) return n;
  const step = 10n ** BigInt(digits - significant);
  return (n / step) * step;
}

/** Whole tokens a prize's value buys at this price, rounded down. */
export function strikeAmount(valueDrops: string, price: Price): bigint {
  const raw = (BigInt(valueDrops) * BigInt(price.tokenMicro)) / (BigInt(price.xrpDrops) * 1_000_000n);
  return prettyAmount(raw);
}

/**
 * What a struck amount sells for: a share of its live value, rounded down to whole drops, and never more than that share of
 * what it was worth at the draw. The price guard only looks back half an hour, so a pool walked up slowly passes it every time.
 */
export function tokenSellDrops(amount: string, price: Price, sellBps: number, valueDrops: string): bigint {
  const live = (BigInt(amount) * BigInt(price.xrpDrops) * 1_000_000n * BigInt(sellBps)) / (BigInt(price.tokenMicro) * 10_000n);
  const cap = (BigInt(valueDrops) * BigInt(sellBps)) / 10_000n;
  return live < cap ? live : cap;
}

/** True if a prize this size is more than the pool should take. */
export const prizeTooBig = (valueDrops: string, poolDrops: string, policy: TokenPolicy = TOKEN_POLICY) => BigInt(valueDrops) * 10_000n > BigInt(poolDrops) * BigInt(policy.maxPrizeOfPoolBps);

/** The transaction a player signs to hold the token: the issuer named, nothing sent, and rippling left off. */
export function trustSetTx(account: string, spec: TokenSpec, amount: bigint): Record<string, unknown> {
  // Room for this prize and well beyond it, so a second prize doesn't need a second signature.
  const limit = (amount > 1_000_000_000_000n ? amount * 10n : 10_000_000_000_000n).toString();
  return { TransactionType: "TrustSet", Account: account, LimitAmount: { currency: spec.currency, issuer: spec.issuer, value: limit }, Flags: 0x00020000 };
}

/** The drops or token value a redemption pays, as a Payment's Amount. XRP is drops; a token names its issuer. */
export const redeemAmount = (amount: string, token: string, spec: TokenSpec | null): string | { currency: string; issuer: string; value: string } => {
  if (token === XRP_TOKEN) return amount;
  if (!spec) throw new Error(`${token} isn't configured`);
  return { currency: spec.currency, issuer: spec.issuer, value: amount };
};

/** What a season commits to: its rates, its token prizes, and which token SEAL is. */
export interface SeasonPlan {
  readonly bandBps: readonly number[];
  readonly prizeTable: readonly PrizeRow[];
  readonly tokens: readonly TokenSpec[];
  /** What an empty band's NFT share pays: see EmptyBand in draw.ts. */
  readonly emptyBand?: EmptyBand;
  /** Per-item NFT odds: see ItemOdds in draw.ts. */
  readonly nftOdds?: ItemOdds;
}

export function seasonPlan(ladder: { readonly bandBps: readonly number[]; readonly tokenPrizes: readonly TokenPrizeRow[]; readonly emptyBand?: EmptyBand; readonly nftOdds?: ItemOdds }, seal: TokenSpec | null): SeasonPlan {
  return { bandBps: ladder.bandBps, prizeTable: prizeTableFor(ladder.tokenPrizes, !!seal), tokens: seal ? [seal] : [], ...(ladder.emptyBand ? { emptyBand: ladder.emptyBand } : {}), ...(ladder.nftOdds ? { nftOdds: ladder.nftOdds } : {}) };
}

/** The most XRP one place on this table can ever need: any token row pays its value in XRP if its amount can't be set. */
export const maxRowValue = (table: readonly PrizeRow[]) => table.reduce((m, r) => (BigInt(r.valueDrops) > m ? BigInt(r.valueDrops) : m), 0n);

/** The largest value a tier's table can strike for one token. */
export const maxValueOf = (table: readonly PrizeRow[], token: string) => table.filter((r) => r.token === token).reduce((m, r) => (BigInt(r.valueDrops) > m ? BigInt(r.valueDrops) : m), 0n);

/** Plain words for the prize: "56,300,000 SEAL", "42 XRP". */
export function prizeName(token: string, amount: string): string {
  if (token === XRP_TOKEN) return `${Number(BigInt(amount)) / 1e6} XRP`;
  return `${BigInt(amount).toLocaleString("en-US")} ${token}`;
}
