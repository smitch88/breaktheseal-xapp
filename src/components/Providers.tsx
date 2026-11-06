"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { dispatch, readDemo } from "@/lib/demo/store";
import type { RailsMode } from "@/lib/live/client";
import { ConnectSheet } from "./ConnectSheet.tsx";
import { KeyboardInset } from "./KeyboardInset.tsx";
import { XappProvider, useXapp } from "./XappHost.tsx";
import { ConfirmAccountSheet, XappNoLaunch } from "./XappSignIn.tsx";

const RateContext = createContext(1);
type RailsInfo = { readonly mode: RailsMode; readonly multi?: { readonly max: number; readonly cardMax: number } };
const RailsContext = createContext<RailsInfo>({ mode: "demo" });
const ConnectContext = createContext<(after?: () => void) => void>(() => {});
const ProofContext = createContext<(after: () => void, again?: boolean) => void>((after) => after());

/** USD per XRP, from the server's hourly read. */
export const useXrpUsd = () => useContext(RateContext);

/** Which rails this deployment runs. Demo unless the server's flag says otherwise. */
export const useRails = () => useContext(RailsContext);

/** Run `after` once a wallet is connected, opening the connect sheet first if it is not. */
export const useConnect = () => useContext(ConnectContext);

/**
 * Run `after`, the sale or redeem the player just pressed for. Outside Xaman it just runs. Inside, the launch's account needs a
 * checked signature behind it first, because the server does these with no transaction from the wallet.
 * `again` is for when the server said a signature is needed although this page thought it had one.
 */
export const useConfirmAccount = () => useContext(ProofContext);

export function Providers({ xapp, ...props }: { xrpUsd: number; rails: RailsInfo; xapp?: boolean; children: React.ReactNode }) {
  return (
    <XappProvider enabled={!!xapp}>
      <SiteProviders {...props} />
    </XappProvider>
  );
}

function SiteProviders({ xrpUsd, rails, children }: { xrpUsd: number; rails: RailsInfo; children: React.ReactNode }) {
  const { active: inXapp, shell, proven, refresh } = useXapp();
  const [open, setOpen] = useState(false);
  const after = useRef<(() => void) | undefined>(undefined);
  const connect = useCallback((next?: () => void) => {
    const now = readDemo();
    // A demo wallet can't buy anything on real rails.
    if (now.signed && !(rails.mode !== "demo" && now.wallet === "demo")) {
      next?.();
      return;
    }
    after.current = next;
    setOpen(true);
  }, [rails.mode]);
  const close = useCallback(() => setOpen(false), []);
  const proof = useRef<(() => void) | null>(null);
  const [proving, setProving] = useState(false);
  const prove = useCallback(
    (next: () => void, again?: boolean) => {
      if (!inXapp || (proven && !again)) return next();
      proof.current = next;
      setProving(true);
    },
    [inXapp, proven],
  );
  const proved = useCallback(() => {
    setProving(false);
    proof.current?.();
    proof.current = null;
  }, []);
  const done = useCallback(() => {
    setOpen(false);
    const next = after.current;
    after.current = undefined;
    next?.();
  }, []);

  // The cookie decides real sign-ins. A demo wallet is local and has no cookie.
  const syncSession = useCallback(() => {
    const before = readDemo().address;
    void fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { session?: { address: string; wallet: "xaman" | "joey" } | null } | null) => {
        if (!body) return;
        const state = readDemo();
        // A sign-in finished while this was on its way, so this answer is out of date. Believing it signed people straight back out.
        if (state.address !== before) return;
        if (body.session) {
          if (state.address !== body.session.address || state.wallet !== body.session.wallet) dispatch({ type: "connect", address: body.session.address, wallet: body.session.wallet });
        } else if (state.signed && (state.wallet !== "demo" || rails.mode !== "demo")) {
          dispatch({ type: "signout" });
        }
      })
      .catch(() => {});
  }, [rails.mode]);
  useEffect(syncSession, [syncSession]);
  // Coming back to a tab: a sign-in may have finished in another one, and the header should say so.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") syncSession();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [syncSession]);
  // Inside Xaman there is no reload or sign-out to fall back on, so an expired session has to show itself.
  useEffect(() => {
    if (!inXapp) return;
    const timer = setInterval(() => {
      syncSession();
      void refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [inXapp, refresh, syncSession]);

  return (
    <RailsContext.Provider value={rails}>
      <RateContext.Provider value={xrpUsd}>
        <ConnectContext.Provider value={connect}>
          <ProofContext.Provider value={prove}>
            {children}
            <KeyboardInset />
            {open ? shell ? <XappNoLaunch onClose={close} /> : <ConnectSheet onClose={close} onDone={done} /> : null}
            {proving ? <ConfirmAccountSheet onClose={() => setProving(false)} onDone={proved} /> : null}
          </ProofContext.Provider>
        </ConnectContext.Provider>
      </RateContext.Provider>
    </RailsContext.Provider>
  );
}
