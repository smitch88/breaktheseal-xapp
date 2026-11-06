import { NFT_LADDERS } from "../../config/nft-packs.ts";
import { displayName } from "../catalog/names.ts";
import { CARD_TIERS } from "../live/client.ts";
import { nftTitle } from "../nft/view.ts";
import { XRP_PRIZE_COIN } from "../prize-art.ts";
import type { TierName } from "../rails/types.ts";
import { BANDS, sha256Hex } from "./draw.ts";
import { prizeImg, prizeTitle } from "./nft-art.ts";
import type { RipState } from "./state.ts";
import { XRP_TOKEN, prizeName } from "./tokens.ts";

/**
 * A draw is on the public log the moment it's fixed, but the player who paid is still on the stage, one tap from biting. Nothing tells the server
 * when they've looked, so a pull stays out of the ticker this long: past any normal open, and short enough that the strip still reads as recent.
 */
export const REVEAL_HOLD_MS = 3 * 60_000;
export const FEED_SIZE = 24;

/** One real pull, as public as a ticker should make it. No order id, wallet, transaction, mint or NFT id, so nothing here leads to a player. */
export interface RecentPull {
  readonly key: string;
  readonly kind: "card" | "nft" | "prize";
  readonly tier: TierName;
  readonly name: string;
  readonly img: string;
  /** Null for an XRP prize, whose name already says it. */
  readonly value: string | null;
  readonly grade: string | null;
  readonly pack: string;
  readonly href: string;
  readonly at: string;
}

export interface PullFeed {
  readonly pulls: readonly RecentPull[];
  readonly asOf: number;
}

/** Hosts next.config.mjs lets next/image load. A slab from anywhere else shows the sealed foil, so a new host can't crash the homepage. */
const IMAGE_HOSTS: readonly string[] = ["d1xpxki1g4htqu.cloudfront.net", "nft.collectorcrypt.com"];
const FOIL = "/assets/stage-pack.webp";
function slabImg(img: string | null): string {
  try {
    const u = new URL(img ?? "");
    return u.protocol === "https:" && IMAGE_HOSTS.includes(u.hostname) ? (img as string) : FOIL;
  } catch {
    return FOIL;
  }
}

const xrp = (drops: string) => `${Number((Number(drops) / 1e6).toFixed(2))} XRP`;
const keyOf = (id: string) => sha256Hex(`pull:${id}`).slice(0, 16);

/**
 * The newest pulls whose outcome is final and old enough to show. An NFT or token pull is final once drawn; a card once it's in custody, which is when
 * its own player's stage shows it. A refund, a checkout that ended and a simulated card aren't pulls, so they never appear. Reads the log's state and nothing else.
 * A multi order shows once, its first pull by place in line and not its rarest, so twenty pulls can't flood the strip, a row of them can't point at one wallet, and the strip doesn't lean toward wins.
 */
export function recentPulls(s: RipState, now: number): RecentPull[] {
  const network = s.genesis?.networkId;
  const firstOf = (x: { id: string; bundle?: string }) => !x.bundle || s.bundles.get(x.bundle)?.children[0] === x.id;
  const nfts = [...s.orders.values()].flatMap((o): RecentPull[] => {
    if (o.status !== "drawn" || !o.drawnAt || o.band === null || !firstOf(o)) return [];
    const base = { key: keyOf(o.id), tier: BANDS[o.band], grade: null, pack: NFT_LADDERS[o.price].name, href: `/nft/${o.price}`, at: o.drawnAt };
    if (o.prize) return [{ ...base, kind: "prize", name: prizeName(o.prize.token, o.prize.amount), img: o.prize.token === XRP_TOKEN ? XRP_PRIZE_COIN : "/assets/prize-seal.svg", value: o.prize.token === XRP_TOKEN ? null : `about ${xrp(o.prize.valueDrops)}` }];
    const lot = o.lot ? s.lots.get(o.lot) : null;
    if (!lot) return [];
    return [{ ...base, kind: "nft", name: nftTitle(lot.collection, prizeTitle(lot, network)), img: prizeImg(lot, network), value: xrp(lot.markDrops) }];
  });
  const cards = [...s.cards.values()].flatMap((c): RecentPull[] => {
    if (c.status !== "held" || !c.heldAt || !c.name || c.gateway === "simulated" || !firstOf(c)) return [];
    return [{ key: keyOf(c.id), kind: "card", tier: CARD_TIERS[String(c.rarity).toLowerCase()] ?? "Common", name: c.name, img: slabImg(c.img), value: `$${Number((Number(c.insuredMicro) / 1e6).toFixed(2))}`, grade: c.grade, pack: displayName(c.code, c.packName, c.usd), href: `/packs/${encodeURIComponent(c.code)}`, at: c.heldAt }];
  });
  return [...nfts, ...cards]
    .filter((p) => Date.parse(p.at) + REVEAL_HOLD_MS <= now)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? -1 : 1))
    .slice(0, FEED_SIZE);
}
