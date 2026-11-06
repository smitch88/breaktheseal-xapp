"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatch, useDemo, useHydrated } from "@/lib/demo/store";
import { demoDraw } from "@/lib/rails/demo-source";
import { Stage } from "./Stage.tsx";

/** Runs one order: the award is fixed in the order before the stage can play. Replays of this page show the same award. */
export function OpenFlow({ orderId }: { orderId: string }) {
  const router = useRouter();
  const demo = useDemo();
  const order = demo.orders[orderId];
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const drawing = useRef(false);

  const draw = useCallback(async () => {
    if (drawing.current || order?.state !== "paid") return;
    drawing.current = true;
    setError(null);
    try {
      const award = await demoDraw(order.pack);
      dispatch({ type: "order_event", id: orderId, event: { type: "award", award } });
    } catch {
      setError("We couldn't reach this pack's items just now.");
    } finally {
      drawing.current = false;
    }
  }, [order, orderId]);

  useEffect(() => {
    if (order?.state === "paid") void draw();
  }, [order?.state, draw]);

  useEffect(() => {
    if (order && order.state !== "paid" && order.state !== "awarded" && order.award) router.replace(`/reveal/${orderId}`);
  }, [order, orderId, router]);

  // The bite ends on this page's last frame, so have the next page ready to take over from it.
  useEffect(() => {
    if (order?.award) router.prefetch(`/reveal/${orderId}`);
  }, [order?.award, orderId, router]);

  const reveal = useCallback(() => {
    dispatch({ type: "order_event", id: orderId, event: { type: "reveal" } });
    router.replace(`/reveal/${orderId}`);
  }, [orderId, router]);

  if (!hydrated) return <div className="stage" />;
  if (!order) {
    return (
      <div className="stage">
        <div className="err">
          <h3>Pick a pack first</h3>
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
  return <Stage art={order.art} award={order.award} error={error} mode="order" onRetry={draw} onClose={() => router.push(order.back)} onReveal={reveal} />;
}
