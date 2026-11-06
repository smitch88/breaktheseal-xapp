import { sha256Hex } from "./draw.ts";
import { GENESIS_HASH } from "./state.ts";
import type { RipEvent, RipEventBody } from "./types.ts";

/** Fields kept from the public log. They are not part of an event's hash, so the public copy still verifies. */
function publicData(e: RipEventBody): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(e.data as object) };
  if (e.type === "tx_intent") delete data.blob;
  if (e.type === "card_signed") delete data.bytes;
  if (e.type === "card_generated") delete data.transaction;
  if (e.type === "swap_signed") delete data.bytes;
  if (e.type === "pool_change") data.adds = e.data.adds.map(({ costDrops: _cost, ...lot }) => lot);
  return data;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
  }
  return v;
}

export const canonical = (e: { seq: number; at: string; prev: string } & RipEventBody): string => JSON.stringify({ seq: e.seq, at: e.at, prev: e.prev, type: e.type, data: sortDeep(publicData(e)) });

export const stripPrivate = (e: RipEvent): RipEvent => {
  if (e.type === "tx_intent") return { ...e, data: { ...e.data, blob: "" } };
  if (e.type === "card_signed") return { ...e, data: { ...e.data, bytes: "" } };
  if (e.type === "card_generated") return { ...e, data: { ...e.data, transaction: "" } };
  if (e.type === "swap_signed") return { ...e, data: { ...e.data, bytes: "" } };
  if (e.type === "pool_change") return { ...e, data: { ...e.data, adds: e.data.adds.map((l) => ({ ...l, costDrops: "" })) } };
  return e;
};

/** The manifest hash a pool change anchors on the ledger. What we paid isn't part of it. */
export const poolRoot = (price: number, adds: readonly { lot: string; nftId: string; band: number }[], removes: readonly string[]) => sha256Hex(JSON.stringify({ price, adds: [...adds].map((l) => [l.lot, l.nftId, l.band]).sort(), removes: [...removes].sort() }));

/** The same, committing each lot's mark too, since a mark sets what a sell-back pays. Every pool change the engine writes now uses this and says so with `v: 2`. */
export const poolRootV2 = (price: number, adds: readonly { lot: string; nftId: string; band: number; markDrops: string }[], removes: readonly string[]) => sha256Hex(JSON.stringify({ v: 2, price, adds: [...adds].map((l) => [l.lot, l.nftId, l.band, l.markDrops]).sort(), removes: [...removes].sort() }));

/** Number and chain a batch of drafts onto the head. */
export function sealEvents(head: number, headHash: string, drafts: readonly RipEventBody[], at: string): RipEvent[] {
  let prev = headHash || GENESIS_HASH;
  let seq = head;
  return drafts.map((d) => {
    seq += 1;
    const base = { ...d, seq, at, prev } as RipEvent;
    const hash = sha256Hex(canonical(base));
    prev = hash;
    return { ...base, hash } as RipEvent;
  });
}
