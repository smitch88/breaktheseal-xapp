"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NFT_LADDERS } from "@/config/nft-packs";
import { useDemo, useHydrated } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { againHref, pullPack } from "@/lib/again";
import { orderBackXrp, pullMultiple, totalMultiple } from "@/lib/pull-multiple";
import { LIVE_CARD, LIVE_NFT, REFUND_REASONS, api, cardAward, dropsToXrp, xrpShort, cardStatusLabel, multiApi, networkLabel, nftAward, nftStatusLabel, txUrl, verifyHref, type LiveBundle, type LiveCard } from "@/lib/live/client";
import { usePoll } from "@/lib/live/hooks";
import { cashOutLabel, cashOutTotal, outcomeOf, outcomeText, payoutText, sellLine, sellTotal, type ChildState, type PayoutStatus } from "@/lib/live/multi";
import { readStep, writeStep } from "@/lib/reveal-flow";
import { useRails, useXrpUsd } from "../Providers.tsx";
import { MultiFlow, MultiGrid, type FlowPack, type MultiRow, type PendingTile } from "../MultiReveal.tsx";
import { Stage } from "../Stage.tsx";
import { useXapp } from "../XappHost.tsx";
import { Gone } from "./LiveOpen.tsx";
import { BulkSheet } from "./BulkSheet.tsx";
import { SellWindow } from "./SellWindow.tsx";
import { SignInToAct } from "./SignInToAct.tsx";

function useLiveBundle(id: string) {
  const [bundle, setBundle] = useState<LiveBundle | null>(null);
  const [missing, setMissing] = useState(false);
  const [mine, setMine] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ bundle: LiveBundle; mine: boolean }>(multiApi(id));
    if (r.status === 404) setMissing(true);
    else if (r.ok) {
      setBundle(r.body.bundle);
      setMine(r.body.mine);
    }
  }, [id]);
  return { bundle, missing, mine, load };
}

type BundleOrder = LiveBundle["orders"][number];
const orderState = (o: BundleOrder): ChildState => (o.status === "drawn" ? "ready" : o.status === "refund_due" || o.status === "refunded" ? "back" : "waiting");
const cardState = (c: LiveCard): ChildState => (c.status === "held" ? "ready" : c.status === "refund_due" || c.status === "refunded" ? "back" : c.status === "review" ? "checking" : "waiting");

type Row = MultiRow & { readonly order?: BundleOrder; readonly back?: number | null };
/** Every pack in the order, in the order they were bought, with its prize once it's drawn. */
type Child = { readonly id: string; readonly state: ChildState; readonly row: Row | null };

/** Every multiple is against the one pack's price, `eachXrp`, never the order's total. A card counts its sell-back quote while in the stash, or what it sold for. */
function childrenOf(b: LiveBundle, xrpUsd: number, quotes?: ReadonlyMap<string, number>): readonly Child[] {
  const nfts = b.orders.map((o): Child => {
    const state = orderState(o);
    const award = state === "ready" ? nftAward(o, xrpUsd) : null;
    const back = orderBackXrp(o);
    return { id: o.id, state, row: award ? { id: o.id, award, status: nftStatusLabel(o), href: `/collection/${LIVE_NFT}${o.id}`, selectable: o.pull === "stashed", why: o.pull === "stashed" ? null : "No longer in your stash", order: o, sell: sellLine(o), proof: o.index !== null ? verifyHref(o.season, o.index) : null, back, multiple: pullMultiple(back, b.eachXrp) } : null };
  });
  const cards = b.cards.map((c): Child => {
    const state = cardState(c);
    const inStash = c.hold === "stashed" || c.hold === "offered" || c.hold === "mirrored";
    const quote = inStash ? quotes?.get(c.id) ?? null : null;
    const back = quote ?? (c.exit?.kind === "sell" && c.exit.drops ? dropsToXrp(c.exit.drops) : null);
    const award = state === "ready" ? cardAward(c, (quote ?? 0) * xrpUsd) : null;
    return { id: c.id, state, row: award ? { id: c.id, award, status: cardStatusLabel(c), href: `/collection/${LIVE_CARD}${c.id}`, selectable: false, why: "A card sells on its own page", sellUntil: inStash ? c.sellUntil : null, sell: inStash ? { label: "Sell back", value: quote !== null ? `${xrpShort(quote)} XRP` : "Priced on its page", line: quote !== null ? `Sells back for ${xrpShort(quote)} XRP on its page` : "Sell it back from its page" } : null, back, multiple: pullMultiple(back, b.eachXrp) } : null };
  });
  return [...nfts, ...cards];
}

/** The whole order's multiple: every pack that wasn't refunded, once each one has a price. Still drawing or being checked means no total yet. */
const orderMultiple = (b: LiveBundle, children: readonly Child[]) => totalMultiple(children.filter((c) => c.state !== "back").map((c) => (c.state === "ready" ? c.row?.back ?? null : null)), b.eachXrp);

/** A card's sell-back quote, asked once per card while it's in the stash. Collector Crypt prices each one, so nothing here polls. */
function useCardQuotes(cards: readonly LiveCard[], on: boolean): ReadonlyMap<string, number> {
  const [quotes, setQuotes] = useState<ReadonlyMap<string, number>>(new Map());
  const asked = useRef(new Set<string>());
  const want = on ? cards.filter((c) => c.status === "held" && (c.hold === "stashed" || c.hold === "offered" || c.hold === "mirrored")).map((c) => c.id) : [];
  const key = want.join(",");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(",") : []) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void api<{ drops: string }>(`/api/rip/cards/${encodeURIComponent(id)}/sell`, {}).then((r) => {
        if (live && r.ok) setQuotes((q) => new Map(q).set(id, dropsToXrp(r.body.drops)));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return quotes;
}

/** The packs that open one at a time: everything but what's coming back as XRP or being checked. A pack still drawing waits its turn on the stage. */
const flowPacks = (children: readonly Child[]): FlowPack[] => children.filter((c) => c.state === "ready" || c.state === "waiting").map((c) => ({ id: c.id, row: c.row }));

/** Packs with no prize to show, said as they are. Nothing here is guessed: each line is the server's state for that pack. */
function pendingOf(children: readonly Child[], card: boolean): PendingTile[] {
  return children.flatMap((c): PendingTile[] => {
    if (c.state === "waiting") return [{ id: c.id, title: "Still drawing", detail: card ? "We're buying this pack. It lands in your stash by itself." : "Waiting for a later ledger to close. It lands in your stash by itself." }];
    if (c.state === "checking") return [{ id: c.id, title: "We're checking on this one", detail: "Don't pay again. It stays in your collection while we sort it out." }];
    if (c.state === "back") return [{ id: c.id, title: "XRP coming back", detail: "We couldn't deliver this pack, so its XRP is going back to your wallet, whole." }];
    return [];
  });
}

const outcomeFor = (b: LiveBundle) => outcomeOf([...b.orders.map(orderState), ...b.cards.map(cardState)], b.eachXrp);
const checkoutHref = (b: LiveBundle) => (b.code ? `/checkout?pack=${encodeURIComponent(b.code)}&qty=${b.qty}` : `/checkout?nft=${b.price}&qty=${b.qty}`);
const packNameOf = (b: LiveBundle) => (b.price ? NFT_LADDERS[b.price as keyof typeof NFT_LADDERS].name : b.name ?? "Card pack");
const packArtOf = (b: LiveBundle | null) => (b?.price ? `/assets/pack-${NFT_LADDERS[b.price as keyof typeof NFT_LADDERS].art}.webp` : "/assets/stage-pack.webp");

/** The action on one line and its total under it, so a phone's half-width button never splits the figure. */
function CashLabel({ text }: { text: string }) {
  const [what, total] = text.split(" · ");
  return total ? (
    <>
      <span>{what}</span>
      <small>{total}</small>
    </>
  ) : (
    <>{what}</>
  );
}

/** The first pack gets its bite here, on the same stage as a single pull, after the one payment. It waits on the server, and only shows what came back. */
export function LiveMultiOpen({ rawId }: { rawId: string }) {
  const id = rawId.slice("multi_".length);
  const router = useRouter();
  const { bundle, missing, load } = useLiveBundle(id);
  const hydrated = useHydrated();
  const xrpUsd = useXrpUsd();
  const { mode } = useRails();
  const packs = useMemo(() => (bundle ? flowPacks(childrenOf(bundle, xrpUsd)) : []), [bundle, xrpUsd]);
  const award = packs[0]?.row?.award ?? null;
  usePoll(load, 2000, !!award);
  const reveal = useCallback(() => {
    if (!readStep(id)) writeStep(id, { view: "reveal", at: 0 });
    router.replace(`/reveal/${rawId}`);
  }, [id, rawId, router]);
  const close = useCallback(() => router.push("/collection"), [router]);
  // Nothing left to open here, only packs being checked or coming back: the results say which.
  const outcome = bundle ? outcomeFor(bundle) : null;
  const nothingToOpen = !!outcome && outcome.total > 0 && outcome.back < outcome.total && !packs.length;
  // Back from a reload, past the first bite: the reveal page picks up where it left off.
  useEffect(() => {
    if (hydrated && (readStep(id) || nothingToOpen)) router.replace(`/reveal/${rawId}`);
  }, [hydrated, id, rawId, router, nothingToOpen]);

  if (!hydrated) return <div className="stage" />;
  if (missing) return <Gone title="That order isn't here" text="We can't find this order." />;
  if (bundle?.refund && bundle.status !== "paid") return <Gone title="Your XRP is coming back" text={`${REFUND_REASONS[bundle.refund.reason] ?? "That payment is going back to your wallet, whole."} Nothing was drawn.`} />;
  if (bundle?.status === "expired") return <Gone title="That checkout ended" text="Nothing was charged." />;
  if (outcome && outcome.total && outcome.back === outcome.total) return <Gone title="Your XRP is coming back" text="We couldn't deliver these packs, so your XRP is going back to your wallet, whole." />;
  if (nothingToOpen) return <div className="stage" />;
  const paid = !!bundle && bundle.status !== "quoted";
  const ready = outcome?.ready ?? 0;
  const steps = [
    { done: paid, wait: "Waiting for your one payment", yes: "Payment on the ledger" },
    { done: !!award, wait: bundle?.kind === "card" ? "Buying your packs" : "Waiting for a later ledger to close", yes: bundle && ready < bundle.qty ? `${ready} of ${bundle.qty} ready` : "Every pull fixed" },
  ];
  const unpaid = bundle?.status === "quoted" ? checkoutHref(bundle) : null;
  return <Stage art={packArtOf(bundle)} award={award} error={null} mode="live" networkTag={networkLabel(mode)} count={packs.length > 1 ? `PACK 1 OF ${packs.length}` : undefined} steps={steps} onClose={close} onReveal={reveal} waitingOn={unpaid ? <Link href={unpaid}>Didn&apos;t approve it? Back to checkout</Link> : null} />;
}

/** After the first bite: each pack in turn, Next or Skip to results, then all of them. How far you've got is kept on this device only, and the server has every result. */
export function LiveMultiReveal({ rawId }: { rawId: string }) {
  const id = rawId.slice("multi_".length);
  const router = useRouter();
  const { bundle, missing, mine, load } = useLiveBundle(id);
  const hydrated = useHydrated();
  const xrpUsd = useXrpUsd();
  const { mode } = useRails();
  const demo = useDemo();
  const { shell } = useXapp();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sheet, setSheet] = useState<readonly string[] | null>(null);
  const quotes = useCardQuotes(bundle?.cards ?? [], hydrated && demo.signed && demo.wallet !== "demo" && mine === true);
  const children = useMemo(() => (bundle ? childrenOf(bundle, xrpUsd, quotes) : []), [bundle, xrpUsd, quotes]);
  const rows = useMemo(() => children.flatMap((c) => (c.row ? [c.row] : [])), [children]);
  const packs = useMemo(() => flowPacks(children), [children]);
  const outcome = bundle ? outcomeFor(bundle) : null;
  const moving = !!bundle && (bundle.status === "quoted" || (outcome?.waiting ?? 0) > 0 || bundle.orders.some((o) => o.payout && (o.payout.status === "due" || o.payout.status === "sent")));
  usePoll(load, moving ? 2500 : 15000);
  const close = useCallback(() => router.push("/collection"), [router]);

  if (!hydrated) return <div className="stage" />;
  if (missing) return <Gone title="Nothing to reveal" text="We can't find this order." />;
  if (!bundle) return <div className="stage" />;
  const name = packNameOf(bundle);
  const tag = [networkLabel(mode), "YOURS"].filter(Boolean).join(" · ");

  const said = outcome ? outcomeText(outcome) : null;
  const payouts = new Map(bundle.orders.flatMap((o) => (o.payout ? [[o.payout.id, o.payout] as const] : [])));
  const signedOut = !demo.signed || demo.wallet === "demo";
  const stashed = rows.filter((r) => r.selectable);
  const toggle = (rowId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  const chosen = rows.filter((r) => selected.has(r.id) && r.selectable).map((r) => r.id);
  const ordersOf = (list: readonly Row[]) => list.flatMap((r) => (r.order ? [r.order] : []));
  // One payment for all of it: NFTs sold back and XRP prizes sent, the same sheet and the same server call as ever.
  const allCash = cashOutTotal(ordersOf(stashed));
  const pickedCash = cashOutTotal(ordersOf(rows.filter((r) => chosen.includes(r.id))));
  const canAct = !(signedOut || mine === false);
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const actions = !canAct ? (
    signedOut ? <SignInToAct /> : null
  ) : selecting ? (
    <>
      <button className="btn ol" onClick={stopSelecting}>
        Done
      </button>
      <button className="btn two-line" disabled={!chosen.length} onClick={() => setSheet(chosen)}>
        {chosen.length ? <CashLabel text={cashOutLabel(pickedCash, false)} /> : "Pick some"}
      </button>
    </>
  ) : (
    <>
      <Link className="btn ol" href="/collection">
        {stashed.length ? "Stash all" : shell ? "My stash" : "Collection"}
      </Link>
      {stashed.length ? (
        <button className="btn two-line" onClick={() => setSheet(stashed.map((r) => r.id))}>
          <CashLabel text={cashOutLabel(allCash, true)} />
        </button>
      ) : (
        <Link className="btn" href={againHref(pullPack(bundle))}>
          Open another
        </Link>
      )}
    </>
  );
  const tools =
    canAct && stashed.length > 1 ? (
      <>
        <span className="lb">{selecting ? `${chosen.length} picked` : rows.length === 1 ? "1 pull" : `${rows.length} pulls`}</span>
        <button type="button" className="mselect" aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          {selecting ? "Cancel" : "Select"}
        </button>
      </>
    ) : null;
  const barNote = canAct && stashed.length ? (selecting ? "Pick what to cash out in one payment." : "Cash out: one payment to your wallet.") : null;
  const soonestSell = rows.map((r) => r.sellUntil).filter((u): u is string => !!u).sort()[0] ?? null;
  const notes = (
    <>
      {said ? <p className="note" role="status">{noOrphan(said)}</p> : null}
      {[...payouts.values()].map((p) =>
        p ? (
          <p key={p.id} className="note" role="status">
            {noOrphan(payoutText(p.status as PayoutStatus, p.totalXrp, p.count))}{" "}
            {p.txHash ? (
              <a href={txUrl(mode, p.txHash)} target="_blank" rel="noopener">
                See it on the ledger
              </a>
            ) : null}
          </p>
        ) : null,
      )}
      {bundle.kind === "card" && rows.length ? <p className="fine">{noOrphan("Open any card to stash, ship, sell or claim it. Each one sells on its own.")}</p> : null}
      {/* The first card's clock, since they were bought together. Past it, each card's own page has Collector Crypt's answer, so nothing here says the window has closed. */}
      {soonestSell ? <SellWindow until={soonestSell} priced /> : null}
    </>
  );
  const foot = bundle.paymentTx ? (
    <p className="fine mproof">
      Proof:{" "}
      <a href={txUrl(mode, bundle.paymentTx)} target="_blank" rel="noopener">
        your payment on the ledger
      </a>
      {" · "}
      <Link href="/fair">verify every&nbsp;pull</Link>
    </p>
  ) : null;
  const cashFigure = allCash.priced && allCash.xrp > 0 ? `${xrpShort(allCash.xrp)} XRP` : null;
  const summary = (
    <>
      <MultiGrid rows={rows} pending={pendingOf(children, bundle.kind === "card")} packArt={packArtOf(bundle)} title={bundle.qty === 1 ? "1 pack" : `${bundle.qty} packs`} tag={tag} notes={notes} actions={actions} selecting={selecting} selected={selected} onToggle={toggle} total={orderMultiple(bundle, children)} onClose={close} sellTotal={cashFigure ?? sellTotal(bundle.orders)} sellLabel={cashFigure ? "Cash out" : "Sells back for"} tools={tools} foot={foot} barNote={barNote} />
      {sheet ? (
        <BulkSheet
          ids={sheet}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            stopSelecting();
            void load();
          }}
        />
      ) : null}
    </>
  );
  return (
    <MultiFlow
      flowId={id}
      packs={packs}
      art={packArtOf(bundle)}
      packName={name}
      tag={tag}
      stageMode="live"
      waitSteps={[
        { done: true, wait: "Waiting for your one payment", yes: "Payment on the ledger" },
        { done: false, wait: bundle.kind === "card" ? "Buying this pack" : "Waiting for a later ledger to close", yes: "Pull fixed" },
      ]}
      onClose={close}
      revealFoot={(row) => {
        const o = (row as Row).order;
        const what = row.award.kind === "card" ? "Stash, ship or sell it from its page" : o?.prize ? (o.prize.token === "XRP" ? "Cash it out to your wallet from its page" : "Redeem or sell it from its page") : "Stash or sell it from its page";
        return (
          <p className="fine">
            <Link href={row.href ?? "/collection"}>{what}</Link>
            {o && o.index !== null ? (
              <>
                {" · "}
                <Link href={verifyHref(o.season, o.index)}>Verify this pull</Link>
              </>
            ) : null}
          </p>
        );
      }}
      summary={summary}
    />
  );
}
