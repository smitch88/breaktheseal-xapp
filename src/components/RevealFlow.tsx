"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { dispatch, useDemo, useHydrated } from "@/lib/demo/store";
import { RevealView } from "./RevealView.tsx";
import { SellSheet } from "./SellSheet.tsx";
import { SoldScreen } from "./SoldScreen.tsx";
import { noOrphan, usd2 } from "@/lib/format";
import { againHref } from "@/lib/again";
import { revealNext } from "@/lib/live/proof";
import { awardBack, pullMultiple } from "@/lib/pull-multiple";

export function RevealFlow({ orderId }: { orderId: string }) {
  const router = useRouter();
  const demo = useDemo();
  const order = demo.orders[orderId];
  const hydrated = useHydrated();
  const [selling, setSelling] = useState(false);
  useEffect(() => {
    if (order?.state === "awarded") dispatch({ type: "order_event", id: orderId, event: { type: "reveal" } });
    if (order?.state === "stashed") router.replace(`/collection/${orderId}`);
  }, [order?.state, orderId, router]);

  if (!hydrated) return <div className="stage" />;
  if (!order?.award) {
    return (
      <div className="stage">
        <div className="err">
          <h3>Nothing to reveal</h3>
          <p>This pull isn&apos;t in this browser. Demo pulls stay on the device that opened them.</p>
          <div className="acts">
            <Link className="btn" href="/packs">
              Explore packs
            </Link>
          </div>
        </div>
      </div>
    );
  }
  const award = order.award;
  if (order.state === "sold") return <SoldScreen usd={award.sell} again={againHref(order.pack)} />;
  return (
    <>
      <RevealView
        award={award}
        packName={order.name}
        multiple={pullMultiple(awardBack(award), order.price)}
        onClose={() => router.push(order.back)}
        actions={
          <>
          <p className="rnext">{noOrphan(revealNext(award, null, true))}</p>
          <div className="buy2">
            <button
              className="btn ol"
              onClick={() => {
                dispatch({ type: "stash", orderId });
                router.replace(`/collection/${orderId}`);
              }}
            >
              Stash
            </button>
            {award.sell > 0 ? (
              <button className="btn" onClick={() => setSelling(true)}>
                Sell for {usd2(award.sell)}
              </button>
            ) : null}
          </div>
          </>
        }
        foot={<p className="fine">{award.token ? `At launch, ${award.token} can be redeemed to your wallet any time.` : award.kind === "nft" ? "At launch, NFTs can be claimed to a Xaman wallet any time." : "At launch, cards stay in a third-party card vault until you ship them."}</p>}
      />
      {selling ? (
        <SellSheet
          usd={award.sell}
          onCancel={() => setSelling(false)}
          onSell={() => {
            dispatch({ type: "sell_order", orderId });
            setSelling(false);
          }}
        />
      ) : null}
    </>
  );
}
