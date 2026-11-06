"use client";

import Link from "next/link";
import { againHref, pullPack } from "@/lib/again";
import { useCallback, useState } from "react";
import { noOrphan } from "@/lib/format";
import { api, dropsToXrp, owedPrizeText, ripAgainHref, txUrl, xrpShort, type LiveOrder, type LiveRef, type WalletLink } from "@/lib/live/client";
import { usePoll } from "@/lib/live/hooks";
import { useConfirmAccount, useRails } from "../Providers.tsx";
import { useXapp } from "../XappHost.tsx";
import { RestockLine, usePackAvailability } from "./Restock.tsx";
import { LiveSellSheet } from "./SellSheet.tsx";
import { WalletSheet } from "./WalletSheet.tsx";

type Trust = { tx: Readonly<Record<string, unknown>>; wallet: WalletLink | null };

/** A token prize: stash it, redeem it to the wallet, or for SEAL sell it. The server pays it, once, however often this asks. */
export function PrizeActions({ ref_, order, onChange, onSold }: { ref_: LiveRef; order: LiveOrder; onChange: () => void; onSold: () => void }) {
  const { mode } = useRails();
  const { shell } = useXapp();
  const confirm = useConfirmAccount();
  const prize = order.prize;
  const availability = usePackAvailability(order.pull === "redeemed" ? order.price : undefined);
  const [trust, setTrust] = useState<Trust | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [quote, setQuote] = useState<number | null>(null);
  const [selling, setSelling] = useState(false);
  const stashed = order.pull === "stashed";
  const sellable = stashed && prize?.token !== "XRP";
  usePoll(
    async () => {
      const r = await api<{ drops: string }>(`${ref_.api}/sell`, {});
      setQuote(r.ok ? dropsToXrp(r.body.drops) : null);
    },
    20000,
    !sellable,
  );

  const redeem = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    const r = await api<{ needsTrustLine?: boolean; tx?: Trust["tx"]; wallet?: WalletLink | null }>(`${ref_.api}/redeem`, {});
    setBusy(false);
    if (r.ok && r.body.needsTrustLine && r.body.tx) setTrust({ tx: r.body.tx, wallet: r.body.wallet ?? null });
    else if (r.ok) {
      setTrust(null);
      onChange();
    } else if (r.body.code === "confirm_account") confirm(() => void redeem(), true);
    else setProblem(r.body.error ?? "That didn't go through. Your prize is safe in your stash.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref_.api, onChange, confirm]);

  // Once a trust line shows up on the ledger the redeem goes through by itself. This never opens a new wallet request.
  usePoll(
    async () => {
      const r = await api<{ needsTrustLine?: boolean }>(`${ref_.api}/redeem`, { poll: true });
      if (r.ok && !r.body.needsTrustLine) {
        setTrust(null);
        onChange();
      }
    },
    4000,
    !trust,
  );

  if (!prize) return null;
  if (order.pull === "redeemed") {
    return (
      <>
        <div className="note">
          {noOrphan(`${prize.name} is in your wallet.`)}{" "}
          {prize.redeemTx ? (
            <a href={txUrl(mode, prize.redeemTx)} target="_blank" rel="noopener">
              See it on the ledger
            </a>
          ) : null}
        </div>
        {availability === "restocking" ? (
          <RestockLine />
        ) : (
          <Link className="btn full" href={shell ? againHref(pullPack(order)) : ripAgainHref(order.price)}>
            {shell ? "Open another pack" : "Rip again"}
          </Link>
        )}
      </>
    );
  }
  if (order.pull === "redeeming" && prize.owed) {
    return (
      <div className="note" role="status">
        {noOrphan(owedPrizeText(prize.name))}
      </div>
    );
  }
  if (order.pull === "redeeming") {
    return (
      <div className="waitrow" role="status">
        <i className="spin" aria-hidden="true" /> {noOrphan(order.payout && order.payout.count > 1 ? `Sending ${prize.name} to your wallet, in one payment with ${order.payout.count - 1} other ${order.payout.count === 2 ? "item" : "items"}` : `Sending ${prize.name} to your wallet`)}
      </div>
    );
  }
  if (!stashed) return null;
  return (
    <>
      {prize.token === "XRP" ? <p className="fine">{noOrphan("Want another rip? Cash this out first. Packs are paid from your wallet, so this XRP counts once it's there.")}</p> : null}
      {prize.note ? <p className="freshness">{noOrphan(prize.note === "needs_trustline" ? "Your wallet couldn't take it, so it's back in your stash. Set up the trust line and try again." : "That didn't land, so it's back in your stash. Nothing moved. Try again.")}</p> : null}
      {problem ? <p className="freshness">{problem}</p> : null}
      <div className="buy">
        <button className="btn ol" disabled={busy} onClick={() => confirm(() => void redeem())}>
          {busy ? "Checking your wallet…" : prize.token === "XRP" ? "Cash out to wallet" : "Redeem to wallet"}
        </button>
        {sellable ? (
          <button className="btn" disabled={quote === null} onClick={() => setSelling(true)}>
            {quote === null ? "Sell" : `Sell for ${xrpShort(quote)} XRP`}
          </button>
        ) : null}
      </div>
      <p className="fine">{noOrphan(prize.token === "XRP" ? "Cash out sends this XRP straight to your wallet. It sits in your stash until you do." : "This is SEAL, the XRPL token, a separate thing from SEAL NFTs. Redeeming sends this fixed amount to your wallet. A sale pays XRP at the price right now.")}</p>
      {trust ? (
        <WalletSheet
          title="Set up SEAL in your wallet"
          intro={`Your wallet needs a trust line before it can hold SEAL. Issuer: ${prize.issuer ?? ""}. It sends nothing and holds 0.2 XRP in reserve. Say no and your prize stays in your stash.`}
          wallet={trust.wallet}
          tx={trust.tx}
          onClose={() => setTrust(null)}
          onCheck={() => void redeem()}
          onRetry={() => void redeem()}
          declined="You said no in your wallet, so nothing changed. Your prize stays in your stash."
        >
          <button className="btn full" disabled={busy} onClick={() => void redeem()}>
            I signed it, send my prize
          </button>
          <button className="btn ol full" disabled={busy} onClick={() => setTrust(null)}>
            No thanks, keep it stashed
          </button>
        </WalletSheet>
      ) : null}
      {selling ? (
        <LiveSellSheet
          item={ref_}
          onClose={() => setSelling(false)}
          onSold={() => {
            setSelling(false);
            onSold();
          }}
        />
      ) : null}
    </>
  );
}
