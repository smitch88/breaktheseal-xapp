"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sheetMode, signInXaman } from "@/lib/auth/xapp-host";
import { noOrphan } from "@/lib/format";
import { useDemo } from "@/lib/demo/store";
import { api, dropsToXrp, type WalletLink } from "@/lib/live/client";
import { failureText, readXamanSocket } from "@/lib/wallet/xaman-socket";
import { Sheet } from "../Sheet.tsx";
import { useXapp } from "../XappHost.tsx";
import { JoeySign } from "./JoeySign.tsx";

function CopyRow({ label, value, shown }: { label: string; value: string; shown?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyrow">
      <span className="lb">{label}</span>
      <div>
        <code>{shown ?? value}</code>
        <button
          className="linky"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function AnyWallet({ tx }: { tx: Readonly<Record<string, unknown>> }) {
  if (tx.TransactionType === "Payment") {
    return (
      <>
        <CopyRow label="Send to" value={String(tx.Destination)} />
        <CopyRow label="Exact amount" value={String(dropsToXrp(String(tx.Amount)))} shown={`${dropsToXrp(String(tx.Amount))} XRP`} />
        <CopyRow label="Invoice ID" value={String(tx.InvoiceID)} />
        {tx.LastLedgerSequence ? <CopyRow label="Valid through ledger" value={String(tx.LastLedgerSequence)} /> : null}
      </>
    );
  }
  if (tx.TransactionType === "TrustSet") {
    const limit = tx.LimitAmount as { currency: string; issuer: string; value: string };
    return (
      <>
        <p className="fine">{noOrphan("In your wallet, add this trust line. Check the issuer: other tokens use the same name.")}</p>
        <CopyRow label="Token" value="SEAL" />
        <CopyRow label="Issuer" value={limit.issuer} />
        <CopyRow label="Currency code" value={limit.currency} />
        <CopyRow label="Limit" value={limit.value} />
      </>
    );
  }
  if (tx.TransactionType === "AccountSet") {
    return <p className="fine">{noOrphan("This approval needs Xaman or Joey, so it can show you what you're approving. Connect one of them.")}</p>;
  }
  return (
    <>
      <p className="fine">{noOrphan("In your wallet, accept this NFT sell offer. It costs nothing but the network fee.")}</p>
      <CopyRow label="Offer ID" value={String(tx.NFTokenSellOffer)} />
    </>
  );
}

/**
 * The one transaction a player signs. In Joey for a Joey sign-in. For Xaman, its QR on desktop, its app link on a phone, or, inside
 * the xApp, the request itself, opened only when the player presses Approve under the sheet's plain explanation and fees. Nothing opens
 * a request on its own. The plain details for any other wallet are always there. It only asks: the server moves a pull forward when
 * the ledger says it happened, never because this sheet did.
 */
export function WalletSheet({ title, intro, wallet, tx, onClose, onCheck, onRetry, declined = "You said no in your wallet, so nothing moved.", children }: { title: string; intro: string; wallet: WalletLink | null; tx: Readonly<Record<string, unknown>>; onClose: () => void; onCheck?: () => void; onRetry?: () => void; declined?: string; children?: React.ReactNode }) {
  const check = useRef(onCheck);
  check.current = onCheck;
  const { wallet: signedWith } = useDemo();
  const [ended, setEnded] = useState<"declined" | "expired" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const uuid = wallet?.uuid;

  // A new request is a new start.
  useEffect(() => {
    setEnded(null);
    setFailure(null);
  }, [uuid]);

  /** Where the request stands. A signature the ledger turned down isn't the player saying no, so it says why. */
  const lookUp = useCallback(() => {
    if (!uuid) return;
    void api<{ state?: string; failure?: string }>("/api/rip/wallet-request", { uuid }).then((r) => {
      if (r.body.failure) setFailure(r.body.failure);
      if (r.body.state === "declined" || r.body.state === "expired") setEnded(r.body.state);
    });
  }, [uuid]);
  const after = useRef(lookUp);
  after.current = lookUp;

  // Xaman's status socket says when a request was signed, so the page looks at the ledger right away. Xaman's own request status is
  // only ever read on one of its signals, never on a timer; the page's own check reads our ledger record, so a dropped socket is still covered.
  useEffect(() => {
    if (!wallet?.ws) return;
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(wallet.ws);
      socket.onmessage = (e) => {
        const signal = readXamanSocket(e.data);
        if (signal === "signed") {
          check.current?.();
          setTimeout(() => after.current(), 5000);
        } else if (signal) setEnded(signal);
      };
    } catch {
      /* The page's ledger check still covers it. */
    }
    return () => socket?.close();
  }, [wallet?.ws]);

  // A phone coming back from Xaman has no socket to hear from, so it asks once.
  useEffect(() => {
    if (!uuid) return;
    const back = () => {
      if (document.visibilityState !== "visible") return;
      check.current?.();
      lookUp();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [uuid, lookUp]);

  const { active, shell } = useXapp();
  const inXapp = active && !!wallet;
  const [refused, setRefused] = useState<string | null>(null);
  // Only ever from the Approve button: the sheet above it has already said what this is and what it costs.
  const openInXaman = useCallback(() => {
    if (!uuid) return;
    setRefused(null);
    void signInXaman(uuid).then(
      (outcome) => {
        if (outcome === "signed") {
          check.current?.();
          setTimeout(() => after.current(), 5000);
        } else setEnded("declined");
      },
      () => setRefused("Xaman didn't open the request. Try again."),
    );
  }, [uuid]);

  const mode = sheetMode({ signedWith, inXapp, hasWallet: !!wallet, ended });
  const saidNo = shell ? declined.replace("You said no in your wallet", "You declined in Xaman") : declined;

  return (
    <Sheet onClose={onClose} label={title}>
      <h3>{title}</h3>
      <p className="fine">{noOrphan(intro)}</p>
      {mode === "joey" ? (
        <>
          <JoeySign tx={tx} onSent={onCheck} declined={declined} />
          <details className="anywallet">
            <summary>Use another wallet</summary>
            <AnyWallet tx={tx} />
          </details>
        </>
      ) : mode === "ended" ? (
        <>
          <p className="freshness">{noOrphan(failure ? failureText(failure) : ended === "declined" ? saidNo : "That request ended before it was signed, so nothing moved.")}</p>
          {onRetry ? (
            <button className="btn full" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </>
      ) : mode === "xapp" ? (
        <>
          {refused ? <p className="freshness">{noOrphan(refused)}</p> : null}
          <button className="btn full" onClick={openInXaman}>
            Approve in Xaman
          </button>
        </>
      ) : mode === "link" && wallet ? (
        <>
          {wallet.pushed ? <p className="note">{noOrphan("We sent this to your Xaman app too. Open it there, or use the options below.")}</p> : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="walletqr only-desk" src={wallet.qr} alt="QR code to approve this in Xaman" width={220} height={220} />
          <p className="fine only-desk">Scan this with Xaman on your phone.</p>
          <a className="btn full only-phone" href={wallet.open}>
            Open Xaman
          </a>
          <details className="anywallet">
            <summary>Use another wallet</summary>
            <AnyWallet tx={tx} />
          </details>
        </>
      ) : shell ? (
        // Inside Xaman a request is the only way to sign. Details to copy into another wallet would only lead away from it.
        <>
          <p className="freshness">{noOrphan("Xaman didn't answer, so nothing moved. Try again.")}</p>
          {onRetry ? (
            <button className="btn full" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </>
      ) : (
        <AnyWallet tx={tx} />
      )}
      {children}
    </Sheet>
  );
}
