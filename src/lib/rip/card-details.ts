import "server-only";
import { parseCardDetails, type CardDetails } from "../live/proof.ts";
import { cachedGet } from "../server-cache.ts";
import type { CardState } from "./state.ts";

const DETAILS_TTL_S = 6 * 3600;

/**
 * Collector Crypt's public record of one card, by mint. A card's set and grade don't change, so one read serves every viewer for
 * hours. A failure reads as nothing to add, and the page and the metadata fall back on what the log already holds.
 */
export async function cardDetailsFor(c: Pick<CardState, "gateway" | "mint">): Promise<CardDetails | null> {
  if (c.gateway !== "collector-crypt" || !c.mint) return null;
  const params = new URLSearchParams({ search: c.mint, blockchain: "Solana", page: "1", step: "8" });
  try {
    return parseCardDetails(await (await cachedGet(`https://api.collectorcrypt.com/marketplace?${params}`, DETAILS_TTL_S)).json(), c.mint);
  } catch {
    return null;
  }
}
