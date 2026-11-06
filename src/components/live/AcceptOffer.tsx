"use client";

import { useCallback, useState } from "react";
import { api, networkLabel, type LiveRef, type WalletLink } from "@/lib/live/client";
import { useConfirmAccount, useRails } from "../Providers.tsx";
import { acceptIntro } from "@/lib/live/sign-copy";
import { WalletSheet } from "./WalletSheet.tsx";

type Accept = { tx: Readonly<Record<string, unknown>>; wallet: WalletLink | null };

/**
 * Claiming, accepting and taking back, from anywhere a prize shows. Every press asks the server again, which gives back the request
 * still open or makes a fresh one if it ended, for Xaman, and the transaction for Joey. An accept is never required: the offer waits,
 * and it can always be taken back.
 */
export function useAccept(ref: LiveRef, load: () => Promise<void> | void) {
  const { mode } = useRails();
  const confirm = useConfirmAccount();
  const [accept, setAccept] = useState<Accept | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The ledger says the offer isn't there, so there's nothing to accept until it's taken back. */
  const [gone, setGone] = useState(false);

  const claim = useCallback(async () => {
    setClaiming(true);
    setProblem(null);
    try {
      for (let i = 0; i < 45; i++) {
        const r = await api<{ tx: Accept["tx"] | null; wallet: WalletLink | null; order?: { pull?: string | null; hold?: string | null } }>(`${ref.api}/claim`, {});
        if (r.body.code === "confirm_account") {
          confirm(() => void claim(), true);
          return;
        }
        if (!r.ok) {
          setAccept(null);
          setGone(r.body.code === "offer_gone");
          setProblem(r.body.error ?? "That didn't go through. It's still in your stash.");
          return;
        }
        if (r.body.tx) {
          setAccept({ tx: r.body.tx, wallet: r.body.wallet });
          return;
        }
        // Already taken: there's nothing left to sign.
        if (r.body.order?.pull === "claimed" || r.body.order?.hold === "mirrored") return;
        await new Promise((d) => setTimeout(d, 2000));
      }
      setProblem("This is taking longer than usual. Check back in a minute.");
    } finally {
      setClaiming(false);
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.api, load, confirm]);

  const takeBack = useCallback(async () => {
    setAccept(null);
    setGone(false);
    setProblem(null);
    const r = await api(`${ref.api}/claim/cancel`, {});
    if (r.body.code === "confirm_account") confirm(() => void takeBack(), true);
    else if (!r.ok) setProblem(r.body.error ?? "We couldn't take the offer back.");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.api, load, confirm]);

  const close = useCallback(() => setAccept(null), []);

  const sheet = accept ? (
    <WalletSheet title="Accept in your wallet" intro={acceptIntro(!!networkLabel(mode))} wallet={accept.wallet} tx={accept.tx} onClose={close} onCheck={() => void load()} onRetry={() => void claim()} declined="You said no in your wallet. Your offer is still open, and you don't have to take it.">
      <button className="linky" onClick={() => void takeBack()}>
        Take back the offer
      </button>
    </WalletSheet>
  ) : null;

  return { claiming, problem, gone, claim, takeBack, close, sheet };
}
