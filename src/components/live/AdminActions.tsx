"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/live/client";

/** One operator action. The route checks who's asking; this only sends it and refreshes the page. */
export function AdminActions({ action, id, label, extra }: { action: string; id: string; label: string; extra?: Readonly<Record<string, string>> }) {
  const router = useRouter();
  const [state, setState] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn ol"
        disabled={state === "…"}
        onClick={() => {
          setState("…");
          void api(`/api/rip/admin/${action}`, { id, ...extra }).then((r) => {
            setState(r.ok ? null : (r.body.error ?? "Failed"));
            router.refresh();
          });
        }}
      >
        {label}
      </button>
      {state && state !== "…" ? <span className="fine">{state}</span> : null}
    </>
  );
}

export function ShipActions({ id }: { id: string }) {
  const [tracking, setTracking] = useState("");
  return (
    <div className="adminform">
      <input aria-label="Tracking number" placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
      {tracking.trim() ? <AdminActions action="mark-shipped" id={id} label="Mark shipped" extra={{ ref: tracking.trim() }} /> : null}
    </div>
  );
}

/** The buyer's kill switch. Off takes effect on the next sweep, within a minute, and stays off across deploys until someone turns it back on here. */
export function AutobuySwitch({ off }: { off: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn ol"
        disabled={state === "…"}
        onClick={() => {
          setState("…");
          void api("/api/rip/admin/autobuy", off ? { on: true } : { on: false, why: "stopped from /admin" }).then((r) => {
            setState(r.ok ? null : (r.body.error ?? "Failed"));
            router.refresh();
          });
        }}
      >
        {off ? "Turn buying back on" : "Stop buying"}
      </button>
      {state && state !== "…" ? <span className="fine">{state}</span> : null}
    </>
  );
}
