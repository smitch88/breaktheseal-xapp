"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { openOutside, readyGate, xappLink, xappSdk } from "@/lib/auth/xapp-host";
import { inXapp } from "@/lib/xapp-style";

interface Xapp {
  /** True only inside Xaman's webview, with a launch the server confirmed. */
  readonly active: boolean;
  /** Running as the xApp at all (Xaman's user agent or its launch address): the app's own small shell shows instead of the site's. Layout only, and never trust. */
  readonly shell: boolean;
  /** The account Xaman opened this launch on. */
  readonly account: string | null;
  /** A checked signature backs that account. What the server does with no transaction from the wallet needs it. */
  readonly proven: boolean;
  /** The server has answered at least once, so no launch means the launch has ended, not that it hasn't arrived yet. */
  readonly checked: boolean;
  readonly refresh: () => Promise<boolean>;
  /** The launch is known and its first screen is drawn: the page shows, and Xaman hears ready(). Once; later calls do nothing. */
  readonly settle: () => void;
}

const XappContext = createContext<Xapp>({ active: false, shell: false, account: null, proven: false, checked: false, refresh: async () => false, settle: () => {} });
export const useXapp = () => useContext(XappContext);

function Host({ children }: { children: React.ReactNode }) {
  const [shell, setShell] = useState(false);
  const [launch, setLaunch] = useState<{ active: boolean; account: string | null; proven: boolean; checked: boolean }>({ active: false, account: null, proven: false, checked: false });
  const refresh = useCallback(async () => {
    const res = await fetch("/api/auth/xapp").catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { xapp?: boolean; account?: string | null; proven?: boolean } | null) : null;
    // A request that never got an answer says nothing about the launch.
    setLaunch((was) => ({ active: !!body?.xapp, account: body?.account ?? null, proven: !!body?.proven, checked: was.checked || !!body }));
    return !!body?.xapp;
  }, []);

  const gate = useRef<ReturnType<typeof readyGate> | null>(null);
  const settle = useCallback(() => gate.current?.settle(), []);
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    // The root layout's head script marks <html> before first paint. A dynamic 404 (notFound() from /admin) is served as an error
    // document that never runs it, so this makes the same decision again and marks the page itself.
    if (!inXapp()) return;
    setShell(true);
    // ready() waits for the launch, so Xaman's own loader stays up until there's a real screen, and never past Xaman's slow mark.
    gate.current = readyGate({ ready: () => xappSdk()?.then((sdk) => sdk.ready()), reveal: () => void delete document.documentElement.dataset.xpending });
    // On /xapp the launch itself asks, once the server has seen the token, and settles when its screen is drawn. Asking now could
    // answer last and read as no launch. Any other page settles once the server has said whether a launch stands.
    if (window.location.pathname !== "/xapp") void refresh().then(() => setAnswered(true));
    return () => gate.current?.cancel();
  }, [refresh]);
  // After the answer has been drawn, not before.
  useEffect(() => {
    if (answered) settle();
  }, [answered, settle]);

  // A webview can't come back from another site, so nothing here navigates it there: every way out goes through Xaman's openBrowser.
  useEffect(() => {
    if (!shell) return;
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a");
      const url = xappLink(link?.getAttribute("href"), link?.getAttribute("target"), window.location.origin);
      if (!url) return;
      e.preventDefault();
      void openOutside(url);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [shell]);

  return <XappContext.Provider value={{ ...launch, shell, refresh, settle }}>{children}</XappContext.Provider>;
}

/** With the flag off this renders only its children, and nothing below it knows the xApp exists. */
export function XappProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return enabled ? <Host>{children}</Host> : <>{children}</>;
}

/** The same words on the site, and different ones where Xaman's rules ask for plainer language. For server-rendered pages. */
export function XappText({ web, app }: { web: string; app: string }) {
  return <>{useXapp().shell ? app : web}</>;
}
