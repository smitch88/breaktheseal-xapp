"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { inXamanWebview, xappLink, xappSdk } from "@/lib/auth/xapp-host";
import { storedXappStyle } from "@/lib/xapp-style";

interface Xapp {
  /** True only inside Xaman's webview, with a launch the server confirmed. */
  readonly active: boolean;
  /** Running in Xaman's webview at all: the app's own small shell shows instead of the site's. Layout only, and never trust. */
  readonly shell: boolean;
  /** The account Xaman opened this launch on. */
  readonly account: string | null;
  /** A checked signature backs that account. What the server does with no transaction from the wallet needs it. */
  readonly proven: boolean;
  /** The server has answered at least once, so no launch means the launch has ended, not that it hasn't arrived yet. */
  readonly checked: boolean;
  readonly refresh: () => Promise<boolean>;
}

const XappContext = createContext<Xapp>({ active: false, shell: false, account: null, proven: false, checked: false, refresh: async () => false });
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

  useEffect(() => {
    if (!inXamanWebview()) return;
    // The root layout's head script marks <html> before first paint, but a dynamic 404 (notFound() from /admin) is served as an error
    // document that never runs it, and the site's header and footer would show beside the shell. Mark it here too.
    document.documentElement.dataset.xapp = "1";
    document.documentElement.dataset.xstyle ??= storedXappStyle();
    setShell(true);
    void xappSdk()?.then((sdk) => sdk.ready());
    // On /xapp the launch itself asks, once the server has seen the token. Asking now could answer last and read as no launch.
    if (window.location.pathname !== "/xapp") void refresh();
  }, [refresh]);

  // A webview can't come back from another site, so nothing here navigates it there: every way out goes through Xaman.
  useEffect(() => {
    if (!shell) return;
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a");
      const url = xappLink(link?.getAttribute("href"), link?.getAttribute("target"), window.location.origin);
      if (!url) return;
      e.preventDefault();
      void xappSdk()?.then((sdk) => sdk.openBrowser({ url }));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [shell]);

  return <XappContext.Provider value={{ ...launch, shell, refresh }}>{children}</XappContext.Provider>;
}

/** With the flag off this renders only its children, and nothing below it knows the xApp exists. */
export function XappProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return enabled ? <Host>{children}</Host> : <>{children}</>;
}

/** The same words on the site, and different ones where Xaman's rules ask for plainer language. For server-rendered pages. */
export function XappText({ web, app }: { web: string; app: string }) {
  return <>{useXapp().shell ? app : web}</>;
}
