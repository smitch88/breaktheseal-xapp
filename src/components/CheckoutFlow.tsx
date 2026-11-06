"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatch, readDemo, useDemo } from "@/lib/demo/store";
import { noOrphan, shortAddress, usd2 } from "@/lib/format";
import { chain } from "@/lib/rails";
import { quoteFor } from "@/lib/rails/order";
import type { PackRef } from "@/lib/rails/types";
import { useRipConfig } from "@/lib/live/hooks";
import { clampQty } from "@/lib/live/multi";
import { DEMO_MULTI } from "@/lib/live/client";
import { TERMS_KEY, qtyKey, quickStart, session } from "@/lib/again";
import { QtyPicker, useQtyRoom } from "./live/QtyPicker.tsx";
import { CheckoutBar, CheckoutDetails } from "./CheckoutParts.tsx";
import { LiveCheckout } from "./live/LiveCheckout.tsx";
import { useConnect, useRails } from "./Providers.tsx";
import { useXapp } from "./XappHost.tsx";
import { Sheet } from "./Sheet.tsx";

type Props = { pack: PackRef; name: string; price: number; art: string; back: string; xrpUsd: number; stage: React.ReactNode; qty?: number; go?: boolean };

const HOLD_SECONDS = 120;
const newId = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Real rails take over only where they're on: NFT packs with the flag on, card packs when the card line is on too. */
export function CheckoutFlow(props: Props) {
  const { mode } = useRails();
  const live = mode !== "demo";
  const config = useRipConfig(live && props.pack.kind === "card", 60000);
  if (!live) return <DemoCheckout {...props} />;
  if (props.pack.kind === "nft") return <LiveCheckout {...props} />;
  if (!config) return <main className="pg" style={{ minHeight: "60vh" }} />;
  return config.cardsOn ? <LiveCheckout {...props} /> : <DemoCheckout {...props} />;
}

function DemoCheckout({ pack, name, price, art, back, xrpUsd, stage, qty: firstQty = 1, go = false }: Props) {
  const router = useRouter();
  const { shell } = useXapp();
  const connect = useConnect();
  const demo = useDemo();
  const room = useQtyRoom(pack);
  const [wanted, setWanted] = useState(firstQty);
  const qty = room.on ? clampQty(wanted, room.max ?? 1) : 1;
  const single = quoteFor(pack, price, xrpUsd);
  const quote = qty > 1 ? { ...single, usd: price * qty, maxXrp: Math.ceil(single.maxXrp * qty * 100) / 100 } : single;
  const [left, setLeft] = useState(HOLD_SECONDS);
  const [agreed, setAgreed] = useState(false);
  const [xaman, setXaman] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const pay = () =>
    connect(() => {
      // The same session memory as a real checkout: the size for next time, and, inside Xaman, who already agreed.
      session.set(qtyKey(pack), String(qty));
      const now = readDemo();
      if (agreed && now.address) session.set(TERMS_KEY, now.address);
      const id = newId();
      if (qty > 1) for (let i = 0; i < qty; i++) {
        dispatch({ type: "order_new", order: { id: `${id}-${i}`, pack, name, price, art, back, quote: single } });
        dispatch({ type: "order_event", id: `${id}-${i}`, event: { type: "request_signature" } });
      }
      else {
        dispatch({ type: "order_new", order: { id, pack, name, price, art, back, quote } });
        dispatch({ type: "order_event", id, event: { type: "request_signature" } });
      }
      setXaman(id);
    });

  const accept = useCallback(async () => {
    if (!xaman) return;
    const result = await chain.requestPayment({ orderId: xaman, quote, destinationLabel: "Break the Seal" });
    if (result.status !== "signed") return;
    if (qty > 1) {
      for (let i = 0; i < qty; i++) {
        dispatch({ type: "order_event", id: `${xaman}-${i}`, event: { type: "signed", txRef: result.txRef } });
        dispatch({ type: "order_event", id: `${xaman}-${i}`, event: { type: "payment_confirmed" } });
      }
      router.push(`/open/${DEMO_MULTI}${xaman}_${qty}`);
      return;
    }
    dispatch({ type: "order_event", id: xaman, event: { type: "signed", txRef: result.txRef } });
    if ((await chain.paymentStatus({ orderId: xaman, txRef: result.txRef })) !== "confirmed") return;
    dispatch({ type: "order_event", id: xaman, event: { type: "payment_confirmed" } });
    if (readDemo().orders[xaman]?.state === "paid") router.push(`/open/${xaman}`);
  }, [xaman, quote, router, qty]);

  const decline = () => {
    if (xaman && qty > 1) for (let i = 0; i < qty; i++) dispatch({ type: "order_event", id: `${xaman}-${i}`, event: { type: "decline" } });
    else if (xaman) dispatch({ type: "order_event", id: xaman, event: { type: "decline" } });
    setXaman(null);
    setDeclined(true);
  };

  const closeDeclined = useCallback(() => setDeclined(false), []);

  // As on real rails: Open on the pack page inside Xaman, by the account that agreed this session, goes straight to the (mock) request, once.
  const quick = useRef(false);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    if (!quickStart({ go, shell, address: demo.signed ? demo.address : null, agreedBy: session.get(TERMS_KEY), started: quick.current })) return;
    quick.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("go");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    setAgreed(true);
    setAuto(true);
  }, [go, shell, demo.signed, demo.address]);
  useEffect(() => {
    if (!auto || !agreed) return;
    setAuto(false);
    pay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, agreed]);

  if (xaman) {
    return (
      <div className="stage xs">
        <div className="xam">
          <div className="c">
            <div className="tiny">Mock of the request Xaman shows. Nothing is sent.</div>
            <h3>Payment</h3>
            <div className="kv">
              <span>To</span>
              <b>Break the Seal</b>
            </div>
            <div className="kv">
              <span>They receive</span>
              <b>{pack.kind === "nft" ? `${((price * qty) / xrpUsd).toFixed(2)} XRP` : `${price * qty}.00 RLUSD`}</b>
            </div>
            <div className="kv">
              <span>You pay at most</span>
              <b>{quote.maxXrp.toFixed(2)} XRP</b>
            </div>
            <div className="kv tiny">
              <span>Valid for</span>
              <span>
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
              </span>
            </div>
            <button className="slide" onClick={accept}>
              Slide to accept
            </button>
            <button className="slide alt" onClick={decline}>
              Decline
            </button>
          </div>
        </div>
      </div>
    );
  }

  const expired = left === 0;
  return (
    <main className="pg packp cop">
      <div className="crumb">
        <Link href="/packs">packs</Link> / <Link href={back}>{name}</Link> / checkout
      </div>
      <div className="split co">
        <div className="pstage">{stage}</div>
        <div className="pcopy">
          <h1 className="sm">
            Checkout<em>.</em>
          </h1>
          {room.on ? <QtyPicker qty={qty} onChange={setWanted} max={room.max} cap={room.cap} eachXrp={single.maxXrp} eachUsd={price} demo brief /> : null}
          <CheckoutDetails pack={qty > 1 ? `${qty} x ${name}` : name} total={`${quote.maxXrp.toFixed(2)} XRP${qty > 1 ? ` · ${usd2(price * qty)}` : ""}`} note={qty > 1 ? noOrphan(`Demo pulls: no XRP moves and every pull is an example you don't own. A real order is one payment for all ${qty}.`) : noOrphan("Demo pull: no XRP moves and the pull is an example you don't own.")}>
            <div>
              <dt>Price</dt>
              <dd>{usd2(price * qty)}</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>Under 0.001 XRP</dd>
            </div>
            <div>
              <dt>Service fee</dt>
              <dd>None</dd>
            </div>
            <div className="tot">
              <dt>You pay at most</dt>
              <dd>{quote.maxXrp.toFixed(2)} XRP</dd>
            </div>
            <div>
              <dt>Pay with</dt>
              <dd>XRP in Xaman (mock)</dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>{demo.signed ? shortAddress(demo.address) : "Your wallet, once connected"}</dd>
            </div>
            <div>
              <dt>Price held for</dt>
              <dd>{expired ? "Refresh the price" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</dd>
            </div>
          </CheckoutDetails>
          <CheckoutBar agreed={agreed} onAgree={setAgreed}>
            {expired ? (
              <button
                className="btn full"
                onClick={() => {
                  router.refresh();
                  setLeft(HOLD_SECONDS);
                }}
              >
                Refresh the price
              </button>
            ) : (
              <button className="btn full" disabled={!agreed} onClick={pay}>
                Pay {quote.maxXrp.toFixed(2)} XRP (demo)
              </button>
            )}
          </CheckoutBar>
        </div>
      </div>
      {declined ? (
        <Sheet onClose={closeDeclined} label="Nothing was charged">
          <h3>Nothing was charged</h3>
          <button className="btn full" onClick={closeDeclined}>
            Back to checkout
          </button>
        </Sheet>
      ) : null}
    </main>
  );
}
