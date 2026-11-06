"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { launchToken, refusalText, xappSdk } from "@/lib/auth/xapp-host";
import { dispatch } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { LEGAL_LINKS } from "@/lib/legal/links";
import { infoNeeded } from "@/lib/xapp-copy";
import { inXapp } from "@/lib/xapp-style";
import { Logo } from "./Logo.tsx";
import { XappAbout, XappInfoSheet } from "./XappShell.tsx";
import { useXapp } from "./XappHost.tsx";
import { launchXapp } from "./XappSignIn.tsx";

type View = { name: "opening" } | { name: "welcome"; info: boolean } | { name: "refused"; text: string; info: boolean };

/** Whether this player still needs the info sheet, from Xaman's userstore through the server. Any failure shows it. */
const askInfo = async (): Promise<boolean> => {
  const res = await fetch("/api/auth/xapp/info", { cache: "no-store" }).catch(() => null);
  return infoNeeded(res?.ok ? await res.json().catch(() => null) : null);
};

/**
 * Where Xaman opens the app. The account comes from Xaman's launch: no sign-in, no wallet to pick, no signature. Until the launch is
 * known this draws nothing of its own, and Xaman's loader stays up (readyGate). Every launch then lands here, on what this is, the risk,
 * About, and Support, Terms and Privacy, and waits for a tap before the packs. A player's first launch opens the info sheet over it,
 * until they press Got it, which Xaman's userstore remembers. Outside the xApp this page is just a way to the home page, and spends nothing.
 */
export function XappBoot({ network, seal, cards }: { network: "MAINNET" | "TESTNET"; seal: boolean; cards: boolean }) {
  const router = useRouter();
  const { refresh, settle } = useXapp();
  const [view, setView] = useState<View>({ name: "opening" });

  useEffect(() => {
    if (!inXapp()) {
      router.replace("/");
      return;
    }
    // The token is sent once and leaves the address bar right away.
    const token = launchToken(window.location.search, navigator.userAgent);
    window.history.replaceState(null, "", "/xapp");
    let live = true;
    const onward = async () => {
      const info = await askInfo();
      if (live) setView({ name: "welcome", info });
    };
    void (async () => {
      // Back here from Terms or Support, with the token long gone from the address: the launch this page already made still stands.
      // Sending an empty token would end it.
      if (!token) {
        const on = await refresh();
        if (!live) return;
        if (on) await onward();
        else setView({ name: "refused", text: refusalText(undefined, network), info: false });
        return;
      }
      const body = await launchXapp(token);
      if (!live) return;
      await refresh();
      if (body.state === "ready" && body.account) {
        dispatch({ type: "connect", address: body.account, wallet: "xaman" });
        await onward();
        return;
      }
      dispatch({ type: "signout" });
      setView({ name: "refused", text: refusalText(body.state, network), info: false });
    })();
    return () => {
      live = false;
    };
    // One launch per page load. A token is spent on the first try.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The launch is known and this screen is drawn: now Xaman may take its loader down.
  useEffect(() => {
    if (view.name !== "opening") settle();
  }, [view.name, settle]);

  // Nothing of ours while the launch is open: no chooser, no sign-in, no loader. Xaman's own loader covers it.
  if (view.name === "opening") return <main className="pg xboot" aria-busy="true" />;

  const showInfo = (info: boolean) => setView((v) => (v.name === "opening" ? v : { ...v, info }));
  return (
    <main className="pg xboot">
      <div className="xbootbar">
        <div className="logo">
          <Logo />
        </div>
        <button type="button" className="xaboutbtn" onClick={() => showInfo(true)}>
          About
        </button>
      </div>
      <XappAbout seal={seal} cards={cards} />
      {view.name === "refused" ? (
        <>
          <p className="freshness">{noOrphan(view.text)}</p>
          <button className="btn full" onClick={() => void xappSdk()?.then((sdk) => sdk.close())}>
            Close
          </button>
        </>
      ) : (
        <button className="btn full" onClick={() => router.replace("/packs")}>
          See the packs
        </button>
      )}
      <p className="xlegal">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </p>
      {view.info ? <XappInfoSheet seal={seal} cards={cards} onClose={() => showInfo(false)} onGotIt={() => void fetch("/api/auth/xapp/info", { method: "POST" }).catch(() => {})} /> : null}
    </main>
  );
}
