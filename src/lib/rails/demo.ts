import { CARD_TIERS, type CardRarity, type Item, type Machine } from "../catalog/types.ts";
import { NFT_TIERS } from "../nft/bands.ts";
import { nftTitle, type NftPackView } from "../nft/view.ts";
import { SEAL_TOKEN, XRP_TOKEN, prettyAmount, prizeName } from "../rip/tokens.ts";
import { cardSellBack, nftSellBack } from "../sellback.ts";
import { whole } from "../format.ts";
import { XRP_PRIZE_ART } from "../prize-art.ts";
import type { Award, ChainAdapter, TierName } from "./types.ts";

const CARD_LABEL: Record<CardRarity, TierName> = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic" };

/**
 * Demo draws. These run in the browser only because a demo pull pays nothing, awards nothing, and nothing is paid or
 * awarded. `provenance: "demo"` travels with the award. `rng` returns 0 <= x < 1.
 */
export function pickTier(rates: readonly number[], available: readonly boolean[], rng: () => number): number {
  const weights = rates.map((r, i) => (available[i] ? Math.max(0, r) : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return available.indexOf(true);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.findLastIndex((w) => w > 0);
}

/** A card example from this pack's real items. Tiers with no item on hand are skipped, so the label always matches the item. */
export function demoCardAward(machine: Pick<Machine, "rates" | "bb">, pool: readonly Item[], rng: () => number, force?: CardRarity): Award | null {
  const byTier = CARD_TIERS.map((t) => pool.filter((i) => i.rarity === t));
  const available = byTier.map((list) => list.length > 0);
  if (!available.includes(true)) return null;
  const forced = force ? CARD_TIERS.indexOf(force) : -1;
  const tierIndex = forced >= 0 && available[forced] ? forced : pickTier(machine.rates, available, rng);
  const list = byTier[tierIndex];
  const item = list[Math.floor(rng() * list.length)];
  return { kind: "card", provenance: "demo", tier: CARD_LABEL[item.rarity], name: item.name, img: item.img, value: item.ins, grade: item.grade, sell: cardSellBack(item.ins, machine.bb), sourceId: item.id };
}

/** Only for showing a demo prize's size. A real pull reads the pool on the ledger. */
const DEMO_XRP_PER_SEAL = 7.4e-7;

/** An NFT example: a band at the published rates, on its own like a real pull, with real art and floor from its collection. Null if it has no real art. */
export function demoNftAward(pack: NftPackView, xrpUsd: number, rng: () => number, forceTier?: number): Award | null {
  const rates = pack.tiers.map((t) => t.rate);
  const tierIndex = forceTier !== undefined ? forceTier : pickTier(rates, rates.map(() => true), rng);
  const view = pack.tiers[tierIndex];
  // A token prize takes its share of the band first, as a real pull does. Half pays SEAL at the demo's rough price.
  let edge = 0;
  const roll = rng() * 10_000;
  const row = pack.tokenPrizes?.find((r) => r.band === tierIndex && roll < (edge += r.bps));
  if (row) {
    const seal = rng() < 0.5 && !pack.xrpOnly;
    const value = row.xrp * xrpUsd;
    return { kind: "nft", provenance: "demo", tier: NFT_TIERS[tierIndex], name: seal ? prizeName(SEAL_TOKEN, prettyAmount(BigInt(Math.floor(row.xrp / DEMO_XRP_PER_SEAL))).toString()) : prizeName(XRP_TOKEN, String(Math.round(row.xrp * 1e6))), img: seal ? "/assets/prize-seal.svg" : XRP_PRIZE_ART, value, grade: `about ${row.xrp} XRP`, sell: seal ? nftSellBack(value) : 0, sourceId: `${seal ? SEAL_TOKEN : XRP_TOKEN}-${tierIndex}-${Math.floor(rng() * 1e9)}`, token: seal ? SEAL_TOKEN : XRP_TOKEN };
  }
  const samples = view.collection?.samples ?? [];
  if (!view.collection || !samples.length) return null;
  const sample = samples[Math.floor(rng() * samples.length)];
  const value = view.collection.floor * xrpUsd;
  return { kind: "nft", provenance: "demo", tier: NFT_TIERS[tierIndex], name: nftTitle(view.collection.name, sample.name), img: sample.img, value, grade: `${whole(view.collection.floor)} XRP floor`, sell: nftSellBack(value), sourceId: sample.id };
}

/** The Xaman step in phase one. No network, no signature, no ledger: every method answers locally with a demo reference. */
export const mockXaman: ChainAdapter = {
  kind: "mock-xaman",
  connect: async () => ({ address: "rDEMO…kT4", label: "Demo wallet" }),
  requestPayment: async (r) => ({ status: "signed", txRef: `demo-${r.orderId}` }),
  paymentStatus: async () => "confirmed",
  payout: async (i) => ({ txRef: `demo-${i.exitId}` }),
  offerNft: async (i) => ({ offerRef: `demo-${i.exitId}` }),
};
