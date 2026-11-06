"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dispatch, useDemo, useHydrated } from "@/lib/demo/store";
import { usd2 } from "@/lib/format";
import { againHref } from "@/lib/again";
import { awardBack, pullMultiple, totalMultiple } from "@/lib/pull-multiple";
import { demoDrawMany } from "@/lib/rails/demo-source";
import { readStep, writeStep } from "@/lib/reveal-flow";
import { MultiFlow, MultiGrid, type FlowPack, type MultiRow, type PendingTile } from "./MultiReveal.tsx";
import { SoldScreen } from "./SoldScreen.tsx";
import { Stage } from "./Stage.tsx";
import { useXapp } from "./XappHost.tsx";

const DEMO_TAG = "DEMO: EXAMPLES YOU DON'T OWN";
const NOTE = "A demo pull: these are examples you don't own. Nothing was paid, and nothing was kept on any ledger.";
const DEMO_FOOT = <p className="fine">A demo pull: an example you don&apos;t own. A real pull keeps its own page, with its&nbsp;proof.</p>;

/** `dm_<id>_<qty>` names the orders `<id>-0` and on, on this device. */
export function parseDemoMulti(raw: string): { base: string; qty: number; ids: string[] } | null {
  const m = /^dm_([a-z0-9]+)_([1-9][0-9]?)$/i.exec(raw);
  if (!m) return null;
  const qty = Number(m[2]);
  return { base: m[1], qty, ids: Array.from({ length: qty }, (_, i) => `${m[1]}-${i}`) };
}

const sellOf = (award: MultiRow["award"]): MultiRow["sell"] => (award.sell > 0 ? { label: "Sells back for", value: `${usd2(award.sell)} (demo)` } : null);

export function DemoMultiOpen({ rawId }: { rawId: string }) {
  const parsed = parseDemoMulti(rawId);
  const router = useRouter();
  const demo = useDemo();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const drawing = useRef(false);
  const orders = (parsed?.ids ?? []).flatMap((id) => (demo.orders[id] ? [demo.orders[id]] : []));
  const first = orders[0];
  const unpaid = orders.filter((o) => o.state === "paid");

  const draw = useCallback(async () => {
    if (drawing.current || !unpaid.length) return;
    drawing.current = true;
    setError(null);
    try {
      const awards = await demoDrawMany(unpaid[0].pack, unpaid.length);
      unpaid.forEach((o, i) => dispatch({ type: "order_event", id: o.id, event: { type: "award", award: awards[i] } }));
    } catch {
      setError("We couldn't reach this pack's items just now.");
    } finally {
      drawing.current = false;
    }
  }, [unpaid]);
  useEffect(() => {
    if (unpaid.length) void draw();
  }, [unpaid.length, draw]);
  // Back from a reload, past the first bite: the reveal page picks up where it left off.
  useEffect(() => {
    if (hydrated && readStep(rawId)) router.replace(`/reveal/${rawId}`);
  }, [hydrated, rawId, router]);

  const reveal = useCallback(() => {
    for (const id of parsed?.ids ?? []) dispatch({ type: "order_event", id, event: { type: "reveal" } });
    if (!readStep(rawId)) writeStep(rawId, { view: "reveal", at: 0 });
    router.replace(`/reveal/${rawId}`);
  }, [parsed, rawId, router]);

  if (!hydrated) return <div className="stage" />;
  if (!first) {
    return (
      <div className="stage">
        <div className="err">
          <h3>Pick a pack first</h3>
          <p>These pulls aren&apos;t in this browser. Demo pulls stay on the device that opened them.</p>
          <div className="acts">
            <Link className="btn" href="/packs">
              Explore packs
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return <Stage art={first.art} award={first.award} error={error} mode="order" count={orders.length > 1 ? `PACK 1 OF ${orders.length}` : undefined} onRetry={draw} onClose={() => router.push(first.back)} onReveal={reveal} />;
}

export function DemoMultiReveal({ rawId }: { rawId: string }) {
  const parsed = parseDemoMulti(rawId);
  const router = useRouter();
  const demo = useDemo();
  const hydrated = useHydrated();
  const [soldFor, setSoldFor] = useState<number | null>(null);
  const { shell } = useXapp();
  const orders = useMemo(() => (parsed?.ids ?? []).flatMap((id) => (demo.orders[id] ? [demo.orders[id]] : [])), [parsed?.ids, demo.orders]);
  const rows = orders.flatMap((o): MultiRow[] => (o.award ? [{ id: o.id, award: o.award, status: o.state === "stashed" ? "In your stash" : o.state === "sold" ? "Sold (demo)" : undefined, href: o.state === "stashed" ? `/collection/${o.id}` : undefined, sell: o.state === "revealed" ? sellOf(o.award) : null, multiple: pullMultiple(awardBack(o.award), o.price) }] : []));
  const packs: FlowPack[] = rows.map((r) => ({ id: r.id, row: r }));
  const pending: PendingTile[] = orders.filter((o) => !o.award).map((o) => ({ id: o.id, title: "Not drawn", detail: "This demo pack didn't draw. Nothing was paid." }));
  const first = orders[0];
  if (soldFor !== null) return <SoldScreen usd={soldFor} again={againHref(first?.pack)} />;
  if (!hydrated) return <div className="stage" />;
  if (!first || !rows.length) {
    return (
      <div className="stage">
        <div className="err">
          <h3>Nothing to reveal</h3>
          <p>These pulls aren&apos;t in this browser. Demo pulls stay on the device that opened them.</p>
          <div className="acts">
            <Link className="btn" href="/packs">
              Explore packs
            </Link>
          </div>
        </div>
      </div>
    );
  }
  const close = () => router.push(first.back);
  const open = orders.filter((o) => o.state === "revealed");
  const sellable = open.filter((o) => (o.award?.sell ?? 0) > 0);
  const summary = (
    <MultiGrid
      rows={rows}
      pending={pending}
      packArt={first.art}
      title={`${orders.length} packs`}
      tag={DEMO_TAG}
      total={totalMultiple(rows.map((r) => awardBack(r.award)), first.price)}
      onClose={close}
      sellTotal={sellable.length ? `${usd2(sellable.reduce((a, o) => a + (o.award?.sell ?? 0), 0))} (demo)` : null}
      notes={<p className="note">{NOTE}</p>}
      actions={
        open.length ? (
          <>
            <button
              className="btn ol"
              onClick={() => {
                open.forEach((o) => dispatch({ type: "stash", orderId: o.id }));
                router.push("/collection");
              }}
            >
              Stash all
            </button>
            {sellable.length ? (
              <button
                className="btn"
                onClick={() => {
                  // An XRP prize has no sale, so it stays in the stash, as a real one would stay yours.
                  open.filter((o) => !sellable.includes(o)).forEach((o) => dispatch({ type: "stash", orderId: o.id }));
                  sellable.forEach((o) => dispatch({ type: "sell_order", orderId: o.id }));
                  setSoldFor(sellable.reduce((a, o) => a + (o.award?.sell ?? 0), 0));
                }}
              >
                Sell all (demo)
              </button>
            ) : null}
          </>
        ) : (
          <>
            <Link className="btn ol" href="/collection">
              {shell ? "My stash" : "Collection"}
            </Link>
            <Link className="btn" href={againHref(first.pack)}>
              Open another
            </Link>
          </>
        )
      }
    />
  );
  return <MultiFlow flowId={rawId} packs={packs} art={first.art} packName={first.name} stageMode="order" onClose={close} revealFoot={() => DEMO_FOOT} summary={summary} />;
}

/** The results of a free try: nothing kept, nothing bought, and the same way through, one pack at a time. */
export function TryMultiReveal({ awards, name, price, art, onRetry, onClose }: { awards: readonly MultiRow["award"][]; name: string; price: number; art: string; onRetry: () => void; onClose: () => void }) {
  const rows = awards.map((award, i): MultiRow => ({ id: `try-${i}`, award, sell: sellOf(award), multiple: pullMultiple(awardBack(award), price) }));
  const summary = (
    <MultiGrid
      rows={rows}
      title={`${rows.length} packs`}
      tag={DEMO_TAG}
      total={totalMultiple(rows.map((r) => awardBack(r.award)), price)}
      onClose={onClose}
      notes={<p className="note">{NOTE}</p>}
      actions={
        <>
          <button className="btn ol" onClick={onRetry}>
            Try again
          </button>
          <Link className="btn" href="/packs">
            See the packs
          </Link>
        </>
      }
    />
  );
  return <MultiFlow flowId={null} packs={rows.map((r) => ({ id: r.id, row: r }))} art={art} packName={name} stageMode="try" onClose={onClose} revealFoot={() => DEMO_FOOT} summary={summary} />;
}
