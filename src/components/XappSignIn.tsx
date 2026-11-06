"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { refusalText, reopenInXaman, signInXaman, xappSdk } from "@/lib/auth/xapp-host";
import { dispatch } from "@/lib/demo/store";
import { noOrphan, shortAddress } from "@/lib/format";
import { Sheet } from "./Sheet.tsx";
import { useXapp } from "./XappHost.tsx";

type Answer = { state?: string; uuid?: string; account?: string; proven?: boolean; session?: { address: string; wallet: "xaman" | "joey" } };
type View = { name: "idle" } | { name: "working" } | { name: "waiting"; uuid: string; note?: string } | { name: "again"; text: string };

const post = async (url: string, body?: unknown): Promise<Answer> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).catch(() => null);
  return res ? ((await res.json().catch(() => ({}))) as Answer) : {};
};

/** Spend a launch token, at most once. The answer is the account Xaman opened on: no sign request and no session. */
export const launchXapp = (token: string) => post("/api/auth/xapp", { token });

/**
 * A checked signature behind the launch's account, only after the player pressed for it. Xaman's own event says when to look, so
 * this reads the request's status then and once more if that read beat Xaman's record, and never on a timer.
 */
function useAccountProof(onDone: () => void) {
  const { refresh } = useXapp();
  const [view, setView] = useState<View>({ name: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const finish = useCallback(
    async (session: NonNullable<Answer["session"]>) => {
      dispatch({ type: "connect", address: session.address, wallet: session.wallet });
      await refresh();
      if (live.current) onDone();
    },
    [onDone, refresh],
  );

  const check = useCallback(async () => {
    for (let tries = 0; tries < 2 && live.current; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, 1500));
      const body = await post("/api/auth/xapp/status");
      if (!live.current) return;
      if (body.state === "signed" && body.session) return finish(body.session);
      if (body.state === "wrong-account") return setView({ name: "again", text: refusalText(body.state) });
      if (body.state === "declined") return setView({ name: "again", text: "You declined in Xaman, so nothing changed." });
      if (body.state === "expired" || body.state === "used" || body.state === "invalid") return setView({ name: "again", text: "That request ended. Try again." });
    }
    if (live.current) setView((v) => (v.name === "waiting" ? { ...v, note: "We haven't seen your signature yet." } : v));
  }, [finish]);

  const start = useCallback(async () => {
    setView({ name: "working" });
    const body = await post("/api/auth/xapp");
    if (!live.current) return;
    if (body.state === "signed" && body.session) return finish(body.session);
    if (body.state !== "sign" || !body.uuid) {
      await refresh();
      return setView({ name: "again", text: body.state === "retry" ? "Xaman didn't answer. Try again." : refusalText(body.state) });
    }
    setView({ name: "waiting", uuid: body.uuid });
    const outcome = await signInXaman(body.uuid).catch(() => null);
    if (!live.current) return;
    if (outcome === "signed") await check();
    else setView({ name: "again", text: outcome === "declined" ? "You declined in Xaman, so nothing changed." : "Xaman didn't open the request. Try again." });
  }, [check, finish, refresh]);

  return { view, start, check, reopen: (uuid: string) => void reopenInXaman(uuid).catch(() => {}) };
}

/** Before what the server does with no transaction from the wallet: a sale, a redeem, an offer, a shipping address. Nothing is sent to Xaman until the button is pressed. */
export function ConfirmAccountSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { account } = useXapp();
  const { view, start, check, reopen } = useAccountProof(onDone);
  return (
    <Sheet top onClose={onClose} label="Confirm your account">
      <h3>Confirm your account</h3>
      <p className="fine">{noOrphan(`Break the Seal does this without a transaction from you, so first it needs this signature from ${shortAddress(account)}. It shows the account is yours and moves no funds. It lasts two hours.`)}</p>
      {view.name === "again" ? <p className="freshness">{noOrphan(view.text)}</p> : null}
      {view.name === "waiting" ? (
        <>
          <p className="fine">{noOrphan("Approve the request in Xaman.")}</p>
          {view.note ? <p className="freshness">{noOrphan(view.note)}</p> : null}
          <button className="btn full" onClick={() => reopen(view.uuid)}>
            Open in Xaman
          </button>
          <button className="linky" onClick={() => void check()}>
            I signed. Check again.
          </button>
        </>
      ) : (
        <>
          <button className="btn full" disabled={view.name === "working"} onClick={() => void start()}>
            {view.name === "again" ? "Try again" : "Confirm in Xaman"}
          </button>
          <button className="btn ol full" onClick={onClose}>
            Not now
          </button>
        </>
      )}
    </Sheet>
  );
}

/**
 * In place of a page that needs the account, once the server has said the launch is gone. Nothing here can bring it back: only closing
 * the xApp and opening it again from Xaman gets a new one. Before the server has answered, it shows nothing.
 */
export function XappEnded() {
  const { checked, active } = useXapp();
  if (!checked || active) return null;
  return (
    <div className="emptyc">
      <h3>Session ended</h3>
      <p className="fine">{noOrphan(`${refusalText(undefined)} Your stash is safe.`)}</p>
      <button className="btn" onClick={() => void xappSdk()?.then((sdk) => sdk.close())}>
        Close
      </button>
    </div>
  );
}

/** Only when there's no launch to use. Closing and opening the xApp is what gets a new token from Xaman. */
export function XappNoLaunch({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label="Open Break the Seal again">
      <h3>Open Break the Seal again</h3>
      <p className="fine">{noOrphan(refusalText(undefined))}</p>
      <button className="btn full" onClick={() => void xappSdk()?.then((sdk) => sdk.close())}>
        Close
      </button>
    </Sheet>
  );
}
