"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inXamanWebview, launchToken, refusalText, xappSdk } from "@/lib/auth/xapp-host";
import { dispatch } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { LEGAL_LINKS } from "@/lib/legal/links";
import { WELCOMED_KEY, welcomeNeeded } from "@/lib/xapp-copy";
import { Logo } from "./Logo.tsx";
import { XappAbout } from "./XappShell.tsx";
import { useXapp } from "./XappHost.tsx";
import { launchXapp } from "./XappSignIn.tsx";

const welcomed = {
  get: () => {
    try {
      return window.localStorage.getItem(WELCOMED_KEY);
    } catch {
      return null;
    }
  },
  set: () => {
    try {
      window.localStorage.setItem(WELCOMED_KEY, "1");
    } catch {
      /* Shown again next launch, which is the safe side. */
    }
  },
};

/**
 * Where Xaman opens the app. It says what this is, who runs it and the risk, and asks for nothing: no sign-in, no signature. The first
 * launch on a phone stays on that screen until the player taps through; later ones go straight to the packs. Outside Xaman this page
 * is just a way to the home page, and spends nothing.
 */
export function XappBoot({ network, seal, cards }: { network: "MAINNET" | "TESTNET"; seal: boolean; cards: boolean }) {
  const router = useRouter();
  const { refresh } = useXapp();
  const [view, setView] = useState<{ name: "opening" } | { name: "welcome" } | { name: "refused"; text: string }>({ name: "opening" });

  useEffect(() => {
    if (!inXamanWebview()) {
      router.replace("/");
      return;
    }
    // The token is sent once and leaves the address bar right away.
    const token = launchToken(window.location.search, navigator.userAgent);
    window.history.replaceState(null, "", "/xapp");
    let live = true;
    const onward = () => (welcomeNeeded(welcomed.get()) ? setView({ name: "welcome" }) : router.replace("/packs"));
    void (async () => {
      // Back here from Terms or Support, with the token long gone from the address: the launch this page already made still stands.
      // Sending an empty token would end it.
      if (!token) {
        const on = await refresh();
        if (!live) return;
        if (on) onward();
        else setView({ name: "refused", text: refusalText(undefined, network) });
        return;
      }
      const body = await launchXapp(token);
      if (!live) return;
      await refresh();
      if (body.state === "ready" && body.account) {
        dispatch({ type: "connect", address: body.account, wallet: "xaman" });
        onward();
        return;
      }
      dispatch({ type: "signout" });
      setView({ name: "refused", text: refusalText(body.state, network) });
    })();
    return () => {
      live = false;
    };
    // One launch per page load. A token is spent on the first try.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="pg xboot">
      <div className="logo">
        <Logo />
      </div>
      <XappAbout seal={seal} cards={cards} />
      {view.name === "refused" ? (
        <>
          <p className="freshness">{noOrphan(view.text)}</p>
          <button className="btn full" onClick={() => void xappSdk()?.then((sdk) => sdk.close())}>
            Close
          </button>
        </>
      ) : view.name === "welcome" ? (
        <button
          className="btn full"
          onClick={() => {
            welcomed.set();
            router.replace("/packs");
          }}
        >
          See the packs
        </button>
      ) : (
        <div className="waitrow" role="status">
          <i className="spin" aria-hidden="true" /> Opening your account
        </div>
      )}
      <p className="xlegal">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </p>
    </main>
  );
}
