"use client";

import type { Item } from "../catalog/types.ts";
import type { NftPackView } from "../nft/view.ts";
import { demoCardAward, demoNftAward } from "./demo.ts";
import type { Award, PackRef } from "./types.ts";
import { TIER_NAMES } from "../tiers.ts";

export interface CardPackFacts {
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly rates: readonly number[];
  readonly bb: number;
  readonly stock: number;
  readonly items: readonly Item[];
  readonly stale: boolean;
}

export class DrawUnavailable extends Error {}

const read = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new DrawUnavailable(`${url} ${res.status}`);
  return res.json() as Promise<T>;
};

/**
 * The browser side of a demo pull: fetch the pack's real items, then draw. This is the demo's OutcomeSource. Real mode
 * replaces it with one server call that returns the award after a confirmed payment.
 * `force` is a QA hook for the demo only.
 */
export async function demoDraw(pack: PackRef, opts: { force?: string | null } = {}): Promise<Award> {
  const rng = Math.random;
  const force = opts.force && TIER_NAMES.includes(opts.force as never) ? opts.force : null;
  if (pack.kind === "card") {
    const facts = await read<CardPackFacts>(`/api/packs/${encodeURIComponent(pack.code)}/items`);
    const forced = force && force !== "Chase" ? (force.toLowerCase() as Item["rarity"]) : undefined;
    const award = demoCardAward({ rates: facts.rates as [number, number, number, number], bb: facts.bb }, facts.items, rng, forced);
    if (!award) throw new DrawUnavailable("no items");
    return award;
  }
  const { pack: view, xrpUsd } = await read<{ pack: NftPackView; xrpUsd: number }>(`/api/nft/${pack.price}`);
  const forceTier = force ? TIER_NAMES.indexOf(force as never) : undefined;
  const award = demoNftAward(view, xrpUsd, rng, forceTier);
  if (!award) throw new DrawUnavailable("no art");
  return award;
}

/** Several demo pulls with one read of the pack's facts. Each rolls on its own, the way a real pull does. */
export async function demoDrawMany(pack: PackRef, count: number): Promise<Award[]> {
  const rng = Math.random;
  if (pack.kind === "card") {
    const facts = await read<CardPackFacts>(`/api/packs/${encodeURIComponent(pack.code)}/items`);
    return Array.from({ length: count }, () => {
      const award = demoCardAward({ rates: facts.rates as [number, number, number, number], bb: facts.bb }, facts.items, rng);
      if (!award) throw new DrawUnavailable("no items");
      return award;
    });
  }
  const { pack: view, xrpUsd } = await read<{ pack: NftPackView; xrpUsd: number }>(`/api/nft/${pack.price}`);
  return Array.from({ length: count }, () => {
    const award = demoNftAward(view, xrpUsd, rng);
    if (!award) throw new DrawUnavailable("no art");
    return award;
  });
}
