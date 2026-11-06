"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { noOrphan, shortAddress, usd2 } from "@/lib/format";
import { useDemo } from "@/lib/demo/store";
import { LIVE_CARD, LIVE_MULTI, LIVE_NFT, REFUND_REASONS, afterLook, api, multiApi, type LiveBundle, type LiveCard, type LiveOrder, type WalletLink, networkLabel, xrpText } from "@/lib/live/client";
import { usePoll, useRipConfig } from "@/lib/live/hooks";
import { checkoutQty } from "@/lib/live/multi";
import { TERMS_KEY, qtyKey, quickStart, session } from "@/lib/again";
import { REFUSED_HOLD_MS, checkoutView, packAvailability, readRefusal } from "@/lib/live/restock";
import type { PackRef } from "@/lib/rails/types";
import { CheckoutBar, CheckoutDetails } from "../CheckoutParts.tsx";
import { useConfirmAccount, useConnect, useRails } from "../Providers.tsx";
import { useXapp } from "../XappHost.tsx";
import { QtyPicker, useQtyRoom } from "./QtyPicker.tsx";
import { RestockLine, RestockMark, useHeldCheckout } from "./Restock.tsx";
import { WalletSheet } from "./WalletSheet.tsx";

type Props = { pack: PackRef; name: string; price: number; back: string; xrpUsd: number; stage: React.ReactNode; qty?: number; go?: boolean };

type Made = { kind: "nft"; order: LiveOrder; tx: Readonly<Record<string, unknown>>; wallet: WalletLink | null } | { kind: "card"; order: LiveCard; tx: Readonly<Record<string, unknown>>; wallet: WalletLink | null } | { kind: "multi"; bundle: LiveBundle; tx: Readonly<Record<string, unknown>>; wallet: WalletLink | null };

/** Checkout on real rails: open the order on the server, sign one payment in the wallet, and watch the ledger. */
export function LiveCheckout({ pack, name, price, back, xrpUsd, stage, qty: firstQty = 1, go = false }: Props) {
  const router = useRouter();
  const connect = useConnect();
  const confirm = useConfirmAccount();
  const demo = useDemo();
  const { mode } = useRails();
  const { shell } = useXapp();
  const config = useRipConfig(pack.kind === "nft");
  const tier = pack.kind === "nft" ? config?.tiers.find((t) => t.price === pack.price) : null;
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  // Closing the sheet doesn't end the order: its place stays held, so it stays payable even if the pack closes meanwhile.
  const [sheet, setSheet] = useState(false);
  const [refused, setRefused] = useState(false);
  const [heldEnded, setHeldEnded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const label = networkLabel(mode);
  const xrp = pack.kind === "nft" ? (tier?.xrp ?? null) : Math.ceil((price / xrpUsd) * 1.005 * 100) / 100;
  const availability = pack.kind === "nft" ? packAvailability(mode, config, pack.price) : "open";
  const room = useQtyRoom(pack);
  const [wanted, setWanted] = useState(firstQty);
  // The server's limit, falling while this page is open, takes the choice down with it. An order already made keeps its own size.
  const [heldQty, setHeldQty] = useState<number | null>(null);
  const qty = checkoutQty({ made: made?.kind === "multi" ? made.bundle.qty : null, held: heldQty, on: room.on, wanted, max: room.max });
  const totalXrp = xrp === null ? null : Number((xrp * qty).toFixed(6));
  const signedIn = demo.signed && demo.wallet !== "demo";

  // Back on this page with a multi order still open: it's the one to pay, and its size is what to show.
  useEffect(() => {
    if (!room.on || !signedIn) return;
    let live = true;
    void api<{ open: LiveBundle | null }>(`/api/rip/bundles?${pack.kind === "nft" ? `price=${pack.price}` : `code=${encodeURIComponent(pack.code)}`}`).then((r) => {
      const o = r.body.open;
      if (!live || !o) return;
      if (pack.kind === "nft" ? o.price === pack.price : o.code === pack.code) {
        setWanted(o.qty);
        setHeldQty(o.qty);
        setNotice(`You have a checkout open for ${o.qty} packs. Pay it below, or wait for it to end. Nothing has been charged.`);
      }
    });
    return () => {
      live = false;
    };
  }, [room.on, signedIn, pack]);
  const held = useHeldCheckout(pack, availability === "restocking") && !heldEnded;
  const view = checkoutView({ availability, refused, showing: !!made, held });

  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(false), REFUSED_HOLD_MS);
    return () => clearTimeout(t);
  }, [refused]);

  const start = () =>
    connect(() => {
      setBusy(true);
      setProblem(null);
      setNotice(null);
      // Remembered for this session only: the next Open on this pack keeps the size, and inside Xaman can skip straight to the wallet.
      session.set(qtyKey(pack), String(qty));
      if (agreed && signedIn && demo.address) session.set(TERMS_KEY, demo.address);
      void (async () => {
        if (qty > 1) {
          const m = await api<{ bundle: LiveBundle; tx: Record<string, unknown>; wallet: WalletLink | null; max?: number; open?: LiveBundle }>("/api/rip/bundles", { ...(pack.kind === "nft" ? { price: pack.price } : { code: pack.code }), qty, acceptedTerms: agreed });
          setBusy(false);
          // The same rule as one pack: a launch only holds so many places on its word. Past that the player confirms, and this goes through. Nothing was charged.
          if (m.body.code === "confirm_account") {
            confirm(start, true);
            return;
          }
          if (m.ok) {
            setMade({ kind: "multi", ...m.body });
            setSheet(true);
            return;
          }
          // The server's limit is the one that counts, so the page moves to it and says why. Nothing was held and nothing was charged.
          if (m.body.code === "qty_too_high" && typeof m.body.max === "number") {
            setHeldQty(null);
            setWanted(m.body.max);
            setProblem(m.body.error ?? "That many aren't available right now. Nothing was charged.");
            return;
          }
          if (m.body.code === "open_checkout" && m.body.open) {
            // Only an order on this pack can be paid from here, so only that one takes over the size. Choosing another size still works: the picker stays.
            const here = m.body.open.code === (pack.kind === "card" ? pack.code : null) && m.body.open.price === (pack.kind === "nft" ? pack.price : null);
            if (here) setHeldQty(m.body.open.qty);
            setProblem(`You have a checkout open for ${m.body.open.qty} packs${here ? "" : " of another pack"}. Pay it, or wait for it to end. Nothing has been charged.`);
            return;
          }
          const whyMulti = readRefusal(m);
          if (whyMulti.kind === "problem") {
            setProblem(whyMulti.text);
            return;
          }
          setRefused(true);
          setHeldEnded(true);
          setMade(null);
          setSheet(false);
          return;
        }
        const r = pack.kind === "nft" ? await api<{ order: LiveOrder; tx: Record<string, unknown>; wallet: WalletLink | null }>("/api/rip/orders", { price: pack.price, acceptedTerms: agreed }) : await api<{ order: LiveCard; tx: Record<string, unknown>; wallet: WalletLink | null }>("/api/rip/cards", { code: pack.code, acceptedTerms: agreed });
        setBusy(false);
        // A launch only holds so many places on its word. Past that the player confirms, and this goes through. Nothing was charged.
        if (r.body.code === "confirm_account") {
          confirm(start, true);
          return;
        }
        if (!r.ok) {
          const why = readRefusal(r);
          if (why.kind === "problem") {
            setProblem(why.text);
            return;
          }
          setRefused(true);
          setHeldEnded(true);
          setMade(null);
          setSheet(false);
          return;
        }
        setMade({ kind: pack.kind, ...r.body } as Made);
        setSheet(true);
      })();
    });

  // Open, tapped on the pack page inside Xaman, by the account that ticked the terms box this session: straight to its wallet request, once.
  // It waits for the price and the room, so the order is the size the player picked. The wallet still asks them to sign.
  const quick = useRef(false);
  const [auto, setAuto] = useState(false);
  const ready = xrp !== null && view === "pay" && !made && (!room.on || room.max !== null);
  useEffect(() => {
    if (!ready || !quickStart({ go, shell, address: signedIn ? demo.address : null, agreedBy: session.get(TERMS_KEY), started: quick.current })) return;
    quick.current = true;
    // A reload of this page is an ordinary checkout again.
    const url = new URL(window.location.href);
    url.searchParams.delete("go");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    setAgreed(true);
    setAuto(true);
  }, [ready, go, shell, signedIn, demo.address]);
  useEffect(() => {
    if (!auto || !agreed) return;
    setAuto(false);
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, agreed]);

  const told = useRef(new Set<string>());
  const settle = (status: string, reason: string | undefined) => {
    const step = afterLook(status, reason, told.current);
    if (step === "wait") return;
    setHeldQty(null);
    setMade(null);
    setSheet(false);
    setHeldEnded(true);
    if (step === "ended") {
      setNotice("That checkout ended. Nothing was charged.");
      return;
    }
    told.current.add(reason as string);
    setNotice(REFUND_REASONS[reason as string] ?? "That payment is going back to your wallet, whole.");
  };

  const watching = !!made;
  const look = async () => {
    if (!made) return;
    if (made.kind === "multi") {
      const r = await api<{ bundle: LiveBundle }>(multiApi(made.bundle.id));
      const b = r.body.bundle;
      if (!b) return;
      if (b.status === "paid") router.push(`/open/${LIVE_MULTI}${b.id}`);
      else settle(b.status, b.refund?.reason);
      return;
    }
    if (made.kind === "nft") {
      const r = await api<{ order: LiveOrder }>(`/api/rip/orders/${made.order.id}`);
      const o = r.body.order;
      if (!o) return;
      if (o.status === "paid" || o.status === "drawn") router.push(`/open/${LIVE_NFT}${o.id}`);
      else settle(o.status, o.refund?.reason);
      return;
    }
    const r = await api<{ order: LiveCard }>(`/api/rip/cards/${made.order.id}`);
    const c = r.body.order;
    if (!c) return;
    if (c.status === "quoted" || c.status === "expired") {
      settle(c.status, c.refund?.reason);
      return;
    }
    router.push(`/open/${LIVE_CARD}${c.id}`);
  };
  // Still watching with the sheet closed, in case it was paid from the wallet anyway, but at an easy pace.
  usePoll(look, sheet ? 2500 : 10000, !watching);

  const payXrp = made ? Number(made.tx.Amount) / 1e6 : totalXrp;

  return (
    <main className="pg packp cop">
      <div className="crumb">
        <Link href="/packs">packs</Link> / <Link href={back}>{name}</Link> / checkout
      </div>
      <div className="split co">
        <div className="pstage">
          {stage}
          {view === "restocking" ? <RestockMark /> : null}
        </div>
        <div className="pcopy">
          <h1 className="sm">
            Checkout<em>.</em>
          </h1>
          {label ? <span className="notbanner livetag">{label}: play XRP, no real value</span> : null}
          {notice ? <p className="freshness">{notice}</p> : null}
          {view === "restocking" ? (
            <>
              <RestockLine />
              <Link className="btn ol full" href={back}>
                See prizes and odds
              </Link>
            </>
          ) : (
            <>
              {room.on && !made ? <QtyPicker qty={qty} onChange={(n) => { setHeldQty(null); setNotice(null); setWanted(n); }} max={room.max} cap={room.cap} eachXrp={xrp} eachUsd={price} about={pack.kind === "card"} brief /> : null}
              <CheckoutDetails pack={qty > 1 ? `${qty} x ${name}` : name} total={totalXrp === null ? "…" : `${pack.kind === "nft" ? "" : "About "}${xrpText(totalXrp)} XRP${qty > 1 ? ` · ${usd2(price * qty)}` : ""}`} note={noOrphan(qty > 1 ? `One payment for all ${qty} packs, each its own pull at the same rates. If it doesn't land before the order ends, nothing is charged.` : "One payment, for the exact amount. If it doesn't land before the order ends, nothing is charged.")}>
                <div>
                  <dt>{shell ? "List price" : "Sticker"}</dt>
                  <dd>About {usd2(price * qty)}</dd>
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
                  <dt>{pack.kind === "nft" ? "You pay" : "You pay about"}</dt>
                  <dd>{totalXrp === null ? "…" : `${xrpText(totalXrp)} XRP`}</dd>
                </div>
                <div>
                  <dt>Pay with</dt>
                  <dd>XRP in your wallet</dd>
                </div>
                {shell ? (
                  <div>
                    <dt>Paid to</dt>
                    <dd>Break the Seal, a third-party app</dd>
                  </div>
                ) : null}
                <div>
                  <dt>From</dt>
                  <dd>{demo.signed ? shortAddress(demo.address) : "Your wallet, once connected"}</dd>
                </div>
              </CheckoutDetails>
              <CheckoutBar agreed={agreed} onAgree={setAgreed} problem={problem}>
                <button className="btn full" disabled={!agreed || busy || view === "checking" || (xrp === null && !held && !made)} onClick={start}>
                  {busy ? "Getting your order…" : `Pay ${totalXrp === null ? "" : `${xrpText(totalXrp)} XRP`}`}
                </button>
              </CheckoutBar>
            </>
          )}
        </div>
      </div>
      {made && sheet ? (
        <WalletSheet title={made.kind === "multi" ? "Approve one payment" : "Approve the payment"} intro={made.kind === "multi" ? `${payXrp === null ? "" : `${xrpText(payXrp)} XRP`} to Break the Seal for ${made.bundle.qty} x ${name}, in one payment.${label ? " Testnet XRP only." : ""} You sign once. This page moves on as soon as the ledger has it.` : `${payXrp === null ? "" : `${xrpText(payXrp)} XRP`} to Break the Seal for one ${name}.${label ? " Testnet XRP only." : ""} This page moves on as soon as the ledger has it.`} wallet={made.wallet} tx={made.tx} onClose={() => setSheet(false)} onCheck={() => void look()} onRetry={start} declined="You said no in your wallet, so nothing was charged.">
          <div className="waitrow" role="status">
            <i className="spin" aria-hidden="true" /> Waiting for your payment
          </div>
        </WalletSheet>
      ) : null}
    </main>
  );
}
