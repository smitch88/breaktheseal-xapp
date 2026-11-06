"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TERMS_KEY, buyState, cameAgain, keptQty, qtyKey, session } from "@/lib/again";
import type { NftPrice } from "@/config/nft-packs";
import { usd2 } from "@/lib/format";
import { clampQty } from "@/lib/live/multi";
import type { PackRef } from "@/lib/rails/types";
import { QtyPicker, useQtyRoom } from "./live/QtyPicker.tsx";
import { RestockLine, useHeldCheckout, usePackAvailability } from "./live/Restock.tsx";
import { useConnect, useRails } from "./Providers.tsx";
import { useXapp } from "./XappHost.tsx";

/**
 * Try and Open. Opening asks for a wallet first, then goes to Checkout. The quantity is remembered for this pack for the session, and a page
 * reached by Open another brings the buy area into view. Inside Xaman, Open from there goes straight to the wallet's request when this
 * session's account already ticked the terms box; checkout decides that, and the wallet still asks for the signature.
 */
export function PackBuy({ href, tryHref, price, soldOut, disabledLabel, nftPrice, cardCode, eachXrp }: { href: string; tryHref: string; price: number; soldOut?: boolean; disabledLabel?: string; nftPrice?: NftPrice; cardCode?: string; eachXrp?: number }) {
  const router = useRouter();
  const connect = useConnect();
  const { mode } = useRails();
  const { shell } = useXapp();
  // With real rails on, the server's stock rule decides whether an NFT pack can be opened right now.
  const availability = usePackAvailability(nftPrice, 20000);
  const held = useHeldCheckout(nftPrice === undefined ? null : { kind: "nft", price: nftPrice }, availability === "restocking");
  const pack: PackRef | null = nftPrice !== undefined ? { kind: "nft", price: nftPrice } : cardCode ? { kind: "card", code: cardCode } : null;
  const room = useQtyRoom(pack);
  const [wanted, setWanted] = useState(1);
  const [again, setAgain] = useState(false);
  const key = pack ? qtyKey(pack) : null;
  // After hydration, so the server's page and the first paint agree: the last choice for this pack, and the buy area in view after Open another.
  useEffect(() => {
    if (key) setWanted(keptQty(session.get(key), 99));
    const back = cameAgain(window.location.search);
    setAgain(back);
    if (back) document.getElementById("buy")?.scrollIntoView({ block: "center" });
  }, [key]);
  const choose = (n: number) => {
    setWanted(n);
    if (key) session.set(key, String(n));
  };
  // A limit that falls while the page is open takes the choice down with it.
  const qty = room.on ? clampQty(wanted, room.max ?? 1) : 1;
  const base = qty > 1 ? `${href}&qty=${qty}` : href;
  // Only inside Xaman, and only when this session's account already agreed: checkout checks both again before it asks the wallet.
  const openHref = shell && again && session.get(TERMS_KEY) ? `${base}&go=1` : base;
  const state = buyState({ availability, held, soldOut, disabledLabel, roomOn: room.on, roomMax: room.max });
  const shelf = (
    <Link className="btn ol" href="/packs">
      Back to packs
    </Link>
  );
  const open = () => {
    // An order this wallet already holds can still be paid, though the pack has closed since.
    if (state === "held") {
      return (
        <Link className="btn" href={href}>
          Finish your checkout
        </Link>
      );
    }
    if (state === "restocking") return <RestockLine />;
    if (state === "soldout" || state === "unavailable" || state === "full") {
      return (
        <p className="restockline" role="status">
          {state === "soldout" ? "Sold out. Check back soon." : state === "full" ? "No room in this pack right now. Check back soon." : `${disabledLabel}.`}
        </p>
      );
    }
    return (
      <button className="btn" disabled={state === "checking"} onClick={() => connect(() => router.push(openHref))}>
        Open · {usd2(price * qty)}
      </button>
    );
  };
  const closed = state === "restocking" || state === "soldout" || state === "unavailable" || state === "full";
  const showPicker = room.on && !closed && state !== "held" && (room.max ?? 1) >= 1;
  return (
    <div id="buy" className="buyarea">
      {showPicker ? <QtyPicker qty={qty} onChange={choose} max={room.max} cap={room.cap} eachXrp={eachXrp ?? null} eachUsd={price} about={pack?.kind === "card"} demo={mode === "demo"} /> : null}
      <div className="buy">
        {shell || closed ? null : (
          <Link className="btn ol" href={room.on && qty > 1 ? `${tryHref}&qty=${qty}` : tryHref}>
            Try the bite
          </Link>
        )}
        {closed ? shelf : null}
        {open()}
      </div>
    </div>
  );
}
