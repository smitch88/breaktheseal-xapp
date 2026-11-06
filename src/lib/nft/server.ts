import "server-only";
import { cache } from "react";
import snapshot from "../../data/nft-snapshot.json";
import { NFT_LADDERS, SHELF_PRICES, picksOf } from "../../config/nft-packs.ts";
import { cachedGet } from "../server-cache.ts";
import { readMarket } from "./source.ts";
import type { NftSnapshot } from "./view.ts";

const picked = SHELF_PRICES.flatMap((p) => picksOf(NFT_LADDERS[p]));

export const getMarket = cache(() => readMarket(cachedGet, snapshot as unknown as NftSnapshot, picked));
