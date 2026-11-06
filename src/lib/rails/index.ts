import { mockXaman } from "./demo.ts";
import type { ChainAdapter } from "./types.ts";

/**
 * Where real rails plug in. Phase one has one mode. To go live: add a Xaman ChainAdapter, add a server route that takes
 * a confirmed payment and returns the award, implement OutcomeSource against that route, and switch here. The stage and
 * reveal already take a finished Award and never decide one.
 */
export const RAILS_MODE = "demo" as const;

export const chain: ChainAdapter = mockXaman;
