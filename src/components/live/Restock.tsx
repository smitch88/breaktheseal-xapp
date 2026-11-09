"use client";

import { useDemo } from "@/lib/demo/store";
import { useOpenCheckouts, useRipConfig } from "@/lib/live/hooks";
import { RESTOCK_LINE, SHELF_LOOK_MS, holdsCheckout, packAvailability, type PackAvailability } from "@/lib/live/restock";
import type { PackRef } from "@/lib/rails/types";
import { useRails } from "../Providers.tsx";

/** One NFT pack's state on real rails. With no price, or in demo mode, it's open and nothing is read. */
export function usePackAvailability(price: number | undefined, ms = SHELF_LOOK_MS): PackAvailability {
  const { mode } = useRails();
  const config = useRipConfig(mode !== "demo" && price !== undefined, ms);
  return price === undefined ? "open" : packAvailability(mode, config, price);
}

/** Whether this wallet still has an open checkout on a pack, asked only once the pack reads closed. */
export function useHeldCheckout(pack: PackRef | null, closed: boolean): boolean {
  const demo = useDemo();
  const open = useOpenCheckouts(closed && !!pack && demo.signed && demo.wallet !== "demo");
  return !!pack && holdsCheckout(open, pack);
}

/** The red wax stamp itself, pressed over whatever pack art it sits on. Its parent has to be positioned. */
export const RestockMark = () => <span className="restamp" role="img" aria-label="Restocking" />;

/** The stamp over one NFT pack's art, when that pack can't be bought. */
export function RestockStamp({ price, ms }: { price: number; ms?: number }) {
  return usePackAvailability(price, ms) === "restocking" ? <RestockMark /> : null;
}

/** Where a buy button would be. Plain words, nothing to tap. */
export const RestockLine = () => (
  <p className="restockline" role="status">
    {RESTOCK_LINE}
  </p>
);
