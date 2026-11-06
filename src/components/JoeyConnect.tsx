"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { noOrphan } from "@/lib/format";
import { useRails } from "./Providers.tsx";

/** Joey's own pages for getting it. */
const EXTENSION_URL = "https://joeywallet.xyz/extension";
const appUrl = () => (/Android/i.test(navigator.userAgent) ? "https://play.google.com/store/apps/details?id=xyz.joeywallet" : "https://apps.apple.com/us/app/joey-wallet/id6745415911");

type View =
  | { name: "looking" }
  | { name: "approve"; note: string; viaApp: boolean }
  /** Nothing here can sign and there's no phone app route on this site: all that's left is getting the extension. */
  | { name: "install" }
  | { name: "pair"; qr: string | null; deeplink: string | null; note: string; extensionHint: boolean; phone: boolean }
  | { name: "problem"; text: string; retry: "app" | "extension"; canUseApp: boolean };

const plain = (e: unknown, fallback: string) => {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  if (err.code === 4001 || err.code === 5000 || /reject|declin|denied/i.test(String(err.message ?? ""))) return "You said no in Joey, so nothing changed.";
  return typeof err.message === "string" && err.message && err.message.length < 240 ? err.message : fallback;
};

/**
 * Connecting Joey, as one path with no choice to make: the extension straight away if this browser has it, otherwise the phone
 * app, by QR on a desktop and by opening the app on a phone, and getting Joey if neither can work. With `reconnect` set, the person is already signed in, so this only restores a wallet connection for that account.
 * The extension code, and all of WalletConnect, load from here and not before.
 */
export function JoeyConnect({ reownProjectId, reconnect, onDone }: { reownProjectId: string | null; reconnect?: string; onDone: (address: string) => void }) {
  const [view, setView] = useState<View>({ name: "looking" });
  const { mode } = useRails();
  const live = useRef(true);
  const begun = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  const startApp = useCallback(async () => {
    if (!reownProjectId) {
      setView({ name: "problem", text: "The Joey phone app isn't set up on this site yet. Use the Joey extension on a computer, or another wallet.", retry: "extension", canUseApp: false });
      return;
    }
    try {
      const [{ wcProvider, signInApi, rememberVia, inJoeyBrowser, isPhone }, mobile, { default: QRCode }, { chainForMode }] = await Promise.all([import("@/lib/wallet/joey-browser"), import("@/lib/wallet/joey-mobile"), import("qrcode"), import("@/lib/wallet/chain")]);
      const phone = isPhone();
      if (live.current) setView({ name: "pair", qr: null, deeplink: null, note: "Starting WalletConnect…", extensionHint: !phone, phone });
      const provider = await wcProvider(reownProjectId);
      // A proposal clears Joey's older sessions from this site anyway, so end ours rather than leave it dangling.
      if (provider.session) await provider.disconnect().catch(() => {});
      const onUri = async (uri: string) => {
        const qr = await QRCode.toDataURL(uri, { width: 320, margin: 1 });
        const deeplink = mobile.joeyPairLink(uri);
        if (!live.current) return;
        const same = reconnect ? " Use the account you signed in with." : "";
        setView({ name: "pair", qr, deeplink, note: phone ? `Approve in the Joey app.${same}` : `Scan with the Joey app on your phone.${same}`, extensionHint: !phone, phone });
        // On a phone the press that got here opens Joey. Some browsers want a second tap, and the button stays for that. Inside Joey's own browser this link pairs in place.
        if (phone || inJoeyBrowser()) window.location.href = deeplink;
      };
      provider.on("display_uri", onUri);
      try {
        if (reconnect) {
          await mobile.mobileReconnect(provider as never, reconnect, chainForMode(mode));
          rememberVia("mobile");
          if (live.current) done.current(reconnect);
        } else {
          const { address } = await mobile.mobileSignIn(provider as never, signInApi);
          rememberVia("mobile");
          if (live.current) done.current(address);
        }
      } finally {
        provider.off("display_uri", onUri);
      }
    } catch (e) {
      if (live.current) setView({ name: "problem", text: plain(e, "Joey didn't connect. Try again."), retry: "app", canUseApp: false });
    }
  }, [mode, reconnect, reownProjectId]);

  const startExtension = useCallback(async () => {
    setView({ name: "approve", note: "Approve this in the Joey extension. If it's locked, unlock it first.", viaApp: !!reownProjectId });
    try {
      const [{ detectExtension, extensionReconnect, extensionSignIn }, { signInApi, rememberVia }, { chainForMode }] = await Promise.all([import("@/lib/wallet/joey-extension"), import("@/lib/wallet/joey-browser"), import("@/lib/wallet/chain")]);
      const joey = await detectExtension();
      if (!joey) throw new Error("We can't find the Joey extension. Reload this page, then try again.");
      if (reconnect) {
        await extensionReconnect(joey, reconnect, chainForMode(mode));
        rememberVia("extension");
        if (live.current) done.current(reconnect);
      } else {
        const { address } = await extensionSignIn(joey, signInApi);
        rememberVia("extension");
        if (live.current) done.current(address);
      }
    } catch (e) {
      if (live.current) setView({ name: "problem", text: plain(e, "Joey didn't finish. Try again."), retry: "extension", canUseApp: !!reownProjectId });
    }
  }, [mode, reconnect, reownProjectId]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void (async () => {
      const [{ isPhone }, { detectExtension }] = await Promise.all([import("@/lib/wallet/joey-browser"), import("@/lib/wallet/joey-extension")]);
      if (!live.current) return;
      if (isPhone()) return void startApp();
      const joey = await detectExtension();
      if (!live.current) return;
      if (joey) void startExtension();
      else if (reownProjectId) void startApp();
      else setView({ name: "install" });
    })();
  }, [reownProjectId, startApp, startExtension]);

  if (view.name === "looking") return <p className="fine">Looking for Joey…</p>;

  if (view.name === "install") {
    return (
      <>
        <p className="fine">{noOrphan("Add the Joey extension to this browser, then reload this page and pick Joey again.")}</p>
        <a className="btn full" href={EXTENSION_URL} target="_blank" rel="noopener">
          Get the Joey extension
        </a>
      </>
    );
  }

  if (view.name === "approve") {
    return (
      <>
        <div className="waitrow" role="status">
          <i className="spin" aria-hidden="true" /> {noOrphan(view.note)}
        </div>
        {view.viaApp ? (
          <button className="linky" onClick={() => void startApp()}>
            Use the Joey app instead
          </button>
        ) : null}
      </>
    );
  }

  if (view.name === "pair") {
    return (
      <>
        <p className="fine">{noOrphan(view.note)}</p>
        {view.qr ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="walletqr only-desk" src={view.qr} alt="QR code to connect the Joey app" width={220} height={220} />
            <a className="btn full only-phone" href={view.deeplink as string}>
              Open Joey
            </a>
          </>
        ) : null}
        {view.extensionHint ? (
          <p className="fine only-desk">
            Prefer your browser?{" "}
            <a href={EXTENSION_URL} target="_blank" rel="noopener">
              Get the Joey extension
            </a>
            , then reload.
          </p>
        ) : null}
        {view.phone ? (
          <p className="fine">
            No Joey yet?{" "}
            <a href={appUrl()} target="_blank" rel="noopener">
              Get the Joey app
            </a>
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <p className="freshness">{noOrphan(view.text)}</p>
      <button className="btn full" onClick={() => void (view.retry === "app" ? startApp() : startExtension())}>
        Try again
      </button>
      {view.canUseApp ? (
        <button className="linky" onClick={() => void startApp()}>
          Use the Joey app instead
        </button>
      ) : null}
    </>
  );
}
