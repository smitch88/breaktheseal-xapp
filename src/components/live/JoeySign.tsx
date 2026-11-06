"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDemo } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { txUrl } from "@/lib/live/client";
import { chainForMode } from "@/lib/wallet/chain";
import type { SendOutcome, SignerTransport, Tx } from "@/lib/wallet/send";
import { JoeyConnect } from "../JoeyConnect.tsx";
import { useRails } from "../Providers.tsx";

type View =
  | { name: "preparing" }
  | { name: "reconnect" }
  | { name: "asking"; phone: boolean }
  | { name: "outcome"; outcome: SendOutcome };

const JOEY_OPEN = "joey://settings/wc";

/**
 * One server-made transaction, signed in Joey. It asks once by itself when the sheet opens and again only on a press. It only asks:
 * the page moves on when the ledger has the transaction, and a wallet saying it worked doesn't change that.
 */
export function JoeySign({ tx, onSent, declined }: { tx: Tx; onSent?: () => void; declined: string }) {
  const { address } = useDemo();
  const { mode } = useRails();
  const [view, setView] = useState<View>({ name: "preparing" });
  const [reownProjectId, setReown] = useState<string | null>(null);
  const live = useRef(true);
  const unlisten = useRef<(() => void) | null>(null);
  const sent = useRef(onSent);
  sent.current = onSent;
  const chain = chainForMode(mode);
  const phone = useRef(false);

  const send = useCallback(
    async (force: boolean) => {
      if (!address) return;
      setView({ name: "preparing" });
      const [{ findRoute, browserSentLog, inJoeyBrowser, isPhone }, { sendTx }] = await Promise.all([import("@/lib/wallet/joey-browser"), import("@/lib/wallet/send")]);
      phone.current = isPhone();
      const config = (await fetch("/api/auth/config")
        .then((r) => r.json())
        .catch(() => ({}))) as { reownProjectId?: string | null };
      if (!live.current) return;
      const reown = config.reownProjectId ?? null;
      setReown(reown);
      const route = await findRoute({ address, chain, reownProjectId: reown }).catch(() => ({ kind: "reconnect" as const, extension: false }));
      if (!live.current) return;
      if (route.kind === "reconnect") return setView({ name: "reconnect" });
      const transport: SignerTransport = route.transport;
      unlisten.current?.();
      unlisten.current = transport.onChange((what) => {
        if (live.current && what === "disconnect") setView({ name: "reconnect" });
      });
      setView({ name: "asking", phone: phone.current && route.via === "mobile" && !inJoeyBrowser() });
      const outcome = await sendTx(transport, tx, { sessionAddress: address, expectedChain: chain, log: browserSentLog(), force });
      if (!live.current) return;
      if (outcome.state === "refused" && outcome.code === "not_connected") return setView({ name: "reconnect" });
      setView({ name: "outcome", outcome });
      if (outcome.state === "sent") sent.current?.();
    },
    [address, chain, tx],
  );

  // A strict-mode remount must not ask twice: sendTx joins an open request, and the log remembers a finished one.
  useEffect(() => {
    live.current = true;
    void send(false);
    return () => {
      live.current = false;
      unlisten.current?.();
      unlisten.current = null;
    };
  }, [send]);

  // Back from the Joey app: the ledger may already have it.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") sent.current?.();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  if (view.name === "preparing") {
    return (
      <div className="waitrow" role="status">
        <i className="spin" aria-hidden="true" /> Getting Joey ready
      </div>
    );
  }
  if (view.name === "reconnect") {
    return (
      <>
        <p className="fine">{noOrphan("Your connection to Joey ended. Connect again with the same account.")}</p>
        <JoeyConnect reownProjectId={reownProjectId} reconnect={address ?? undefined} onDone={() => void send(false)} />
      </>
    );
  }
  if (view.name === "asking") {
    return (
      <>
        <div className="waitrow" role="status">
          <i className="spin" aria-hidden="true" /> {noOrphan(phone.current ? "Approve this in the Joey app." : "Approve this in Joey. Unlock it first if it asks.")}
        </div>
        {view.phone ? (
          <a className="btn full" href={JOEY_OPEN}>
            Open Joey
          </a>
        ) : null}
      </>
    );
  }
  const o = view.outcome;
  if (o.state === "sent") {
    return (
      <div className="note" role="status">
        {noOrphan(o.already ? "This already went to the ledger. Waiting for it to show up." : "Sent. Waiting for the ledger.")}{" "}
        {o.hash ? (
          <a href={txUrl(mode, o.hash)} target="_blank" rel="noopener">
            See it on the ledger
          </a>
        ) : null}
      </div>
    );
  }
  const text = o.state === "declined" ? declined : o.state === "asked" ? "We already asked Joey for this. Approve it there, or ask again if it's gone." : o.text;
  return (
    <>
      <p className="freshness">{noOrphan(text)}</p>
      {o.state === "unknown" ? null : (
        <button className="btn full" onClick={() => void send(true)}>
          {o.state === "asked" ? "Ask again" : "Try again"}
        </button>
      )}
    </>
  );
}
