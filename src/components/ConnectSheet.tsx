"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chain } from "@/lib/rails";
import { dispatch } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { JoeyConnect } from "./JoeyConnect.tsx";
import { useRails } from "./Providers.tsx";
import { Sheet } from "./Sheet.tsx";

type Config = { xaman: boolean; joey: boolean; joeyMobile: boolean; reownProjectId: string | null };
type View =
  | { name: "pick" }
  | { name: "xaman"; qr: string; open: string; ws: string; note?: string }
  | { name: "joey" }
  | { name: "error"; text: string };

/** Where a phone should land after Xaman. From a return page, that's wherever that page was headed. */
const returnPath = () => (window.location.pathname.startsWith("/auth/") ? new URLSearchParams(window.location.search).get("to") : `${window.location.pathname}${window.location.search}`);
/** The same line `.only-phone` draws, plus any phone or tablet: these go to Xaman on this device. */
const onPhone = () => window.matchMedia("(max-width: 759px)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
const inWebview = () => typeof (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView !== "undefined";
const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/**
 * Real sign-in for Xaman and Joey, when their credentials are set, plus a separate demo wallet. A real option is only
 * ever marked connected after the server verifies a signature and sets the session cookie.
 */
export function ConnectSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<View>({ name: "pick" });
  const { mode } = useRails();
  const live = useRef(true);
  const socket = useRef<WebSocket | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    live.current = true;
    void fetch("/api/auth/config")
      .then((r) => (r.ok ? (r.json() as Promise<Config>) : null))
      .then(async (c) => {
        if (!live.current) return;
        setConfig(c ?? { xaman: false, joey: false, joeyMobile: false, reownProjectId: null });
        // Inside Joey's own browser there's nothing to pick.
        if (c?.joeyMobile && inWebview()) {
          const { inJoeyBrowser } = await import("@/lib/wallet/joey-browser");
          if (live.current && inJoeyBrowser()) setView({ name: "joey" });
        }
      })
      .catch(() => live.current && setConfig({ xaman: false, joey: false, joeyMobile: false, reownProjectId: null }));
    return () => {
      live.current = false;
      socket.current?.close();
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  const stopWatching = () => {
    socket.current?.close();
    socket.current = null;
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  };

  const checkXaman = useCallback(async () => {
    const res = await post("/api/auth/xaman/status").catch(() => null);
    if (!res?.ok || !live.current) return;
    const body = (await res.json()) as { state: string; session?: { address: string } };
    if (body.state === "signed" && body.session) {
      stopWatching();
      dispatch({ type: "connect", address: body.session.address, wallet: "xaman" });
      onDone();
    } else if (body.state === "declined") {
      stopWatching();
      setView({ name: "error", text: "You declined in Xaman, so nothing changed." });
    } else if (body.state === "expired" || body.state === "used" || body.state === "invalid") {
      stopWatching();
      // A sleeping tab waking up: the return page may have finished this sign-in in another tab, which spends the cookie this tab was reading.
      const held = (await fetch("/api/auth/session").then((r) => r.json()).catch(() => null)) as { session?: { address: string } | null } | null;
      if (!live.current) return;
      if (held?.session) {
        dispatch({ type: "connect", address: held.session.address, wallet: "xaman" });
        onDone();
        return;
      }
      setView({ name: "error", text: body.state === "invalid" ? "That sign-in didn't verify. Try again." : "That sign-in request ended. Start a new one." });
    }
  }, [onDone]);

  // Back from Xaman on a phone: the socket may have slept, so look straight away.
  useEffect(() => {
    if (view.name !== "xaman") return;
    const back = () => {
      if (document.visibilityState === "visible") void checkXaman();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [view.name, checkXaman]);

  const startXaman = async () => {
    const res = await post("/api/auth/xaman/start", { to: returnPath(), phone: onPhone() }).catch(() => null);
    if (!live.current) return;
    const body = res ? ((await res.json().catch(() => ({}))) as { qr?: string; open?: string; ws?: string; error?: string }) : {};
    if (!res?.ok || !body.qr || !body.open || !body.ws) {
      setView({ name: "error", text: body.error ?? "Xaman didn't answer. Try again." });
      return;
    }
    setView({ name: "xaman", qr: body.qr, open: body.open, ws: body.ws });
    // Live status from Xaman tells us when to check. The server does the actual verifying.
    try {
      const ws = new WebSocket(body.ws);
      ws.onmessage = (e) => {
        const m = String(e.data);
        if (m.includes('"signed"') || m.includes('"expired"')) void checkXaman();
      };
      socket.current = ws;
    } catch {
      /* The slower check below still covers it. */
    }
    poll.current = setInterval(() => void checkXaman(), 8000);
  };

  const useDemo = async () => {
    const wallet = await chain.connect();
    dispatch({ type: "connect", address: wallet.address, wallet: "demo" });
    onDone();
  };

  if (view.name === "xaman") {
    return (
      <Sheet onClose={onClose} label="Sign in with Xaman">
        <h3>Sign in with Xaman</h3>
        <p className="fine">{noOrphan("This is a real sign-in. It proves the address is yours and can't move funds.")}</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="walletqr only-desk" src={view.qr} alt="QR code to sign in with Xaman" width={220} height={220} />
        <p className="fine only-desk">Scan this with Xaman on your phone.</p>
        <a className="btn full only-phone" href={view.open}>
          Open Xaman
        </a>
        <button className="linky" onClick={() => void checkXaman()}>
          I signed. Check again.
        </button>
      </Sheet>
    );
  }

  if (view.name === "joey") {
    return (
      <Sheet onClose={onClose} label="Sign in with Joey">
        <h3>Sign in with Joey</h3>
        <JoeyConnect
          reownProjectId={config?.reownProjectId ?? null}
          onDone={(address) => {
            dispatch({ type: "connect", address, wallet: "joey" });
            onDone();
          }}
        />
        <button className="linky" onClick={() => setView({ name: "pick" })}>
          Use another wallet
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose} label="Connect to Break the Seal">
      <h3>Connect to Break the Seal</h3>
      {view.name === "error" ? <p className="freshness">{view.text}</p> : <p className="fine">{noOrphan("Sign-in only. It proves the address is yours and can't move funds.")}</p>}
      <button className="btn full" disabled={!config?.xaman} onClick={() => void startXaman()}>
        Xaman
      </button>
      {config && !config.xaman ? <p className="fine">Xaman sign-in isn&apos;t set up yet. It needs API keys from the&nbsp;owner.</p> : null}
      <button className="btn full" disabled={!config?.joey} onClick={() => setView({ name: "joey" })}>
        Joey
      </button>
      {config && !config.joey ? <p className="fine">Joey sign-in isn&apos;t set up yet. It needs a session secret from the&nbsp;owner.</p> : null}
      {mode === "demo" ? (
        <>
          <button className="btn ol full" onClick={() => void useDemo()}>
            Demo wallet
          </button>
          <p className="fine">The demo wallet is fake: a made-up address and balance, so you can walk every&nbsp;flow.</p>
        </>
      ) : null}
    </Sheet>
  );
}
