"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useDemo } from "@/lib/demo/store";
import { noOrphan, tidy, usd2 } from "@/lib/format";
import { api, cardAward, cardStatusLabel, dropsToXrp, networkLabel, nftAward, nftStatusLabel, parseLiveId, xrpShort, type LiveCard, type LiveOrder, type LiveRef, type WalletLink } from "@/lib/live/client";
import { useCardDetails, usePoll } from "@/lib/live/hooks";
import { cardProofs, cardRecordUrl, certUrl, marketUrl, nftProofs, withDetails, type ProofRow } from "@/lib/live/proof";
import { Sheet } from "../Sheet.tsx";
import { CardArt } from "../CardArt.tsx";
import { REVEAL_SIZES } from "../Stage.tsx";
import { useConfirmAccount, useRails, useXrpUsd } from "../Providers.tsx";
import { useXapp } from "../XappHost.tsx";
import { Attribution, TierLabel } from "../ui.tsx";
import { useAccept } from "./AcceptOffer.tsx";
import { LiveSoldScreen, useLiveItem } from "./LiveOpen.tsx";
import { PrizeActions } from "./PrizeActions.tsx";
import { SignInToAct } from "./SignInToAct.tsx";
import { LiveSellSheet } from "./SellSheet.tsx";
import { SellWindow } from "./SellWindow.tsx";
import { WalletSheet } from "./WalletSheet.tsx";

type Accept = { tx: Readonly<Record<string, unknown>>; wallet: WalletLink | null };

function ShipSheet({ ref_, onClose, onDone }: { ref_: LiveRef; onClose: () => void; onDone: () => void }) {
  const confirm = useConfirmAccount();
  const [form, setForm] = useState({ name: "", street: "", city: "", region: "", zip: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<(Accept & { hash: string }) | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const send = async () => {
    setBusy(true);
    setProblem(null);
    const r = await api<{ tx: Accept["tx"]; wallet: WalletLink | null; hash: string }>(`${ref_.api}/ship`, form);
    setBusy(false);
    if (r.ok) setAsked({ tx: r.body.tx, wallet: r.body.wallet, hash: r.body.hash });
    else if (r.body.code === "confirm_account") confirm(() => void send(), true);
    else setProblem(r.body.error ?? "That didn't go through. Your card is still in your stash.");
  };
  // Only the wallet's approval on the ledger starts a shipment, so the page keeps asking until it lands.
  const check = useCallback(async () => {
    if (!asked) return;
    const r = await api(`${ref_.api}/ship`, { confirm: asked.hash });
    if (r.ok) onDone();
    else if (r.body.code === "confirm_account") confirm(() => void check(), true);
    else if (r.body.code !== "ship_unsigned") setProblem(r.body.error ?? "That didn't go through. Your card is still in your stash.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, onDone, ref_.api, confirm]);
  usePoll(check, 3000, !asked);
  if (asked) {
    return (
      <WalletSheet title="Approve the address" intro="This isn't a sign-in. Approving says this card ships to the address you just entered. It costs only the network fee, and your card doesn't move until it's on the ledger." wallet={asked.wallet} tx={asked.tx} onClose={onClose} onCheck={() => void check()} declined="You said no in your wallet, so your card stays in your stash.">
        {problem ? <p className="freshness">{problem}</p> : null}
      </WalletSheet>
    );
  }
  return (
    <Sheet onClose={onClose} label="Ship this card">
      <h3>Ship this card</h3>
      <p className="fine">{noOrphan("Your wallet approves the address next. If this card has an NFT, the NFT is retired first. Your name and address go to the third-party card vault and the carrier that ship it, and never onto the ledger. A shipped card can't be sold back here.")}</p>
      <input aria-label="Full name" placeholder="Full name" autoComplete="off" value={form.name} onChange={set("name")} />
      <input aria-label="Street address" placeholder="Street address" autoComplete="off" value={form.street} onChange={set("street")} />
      <div className="two">
        <input aria-label="City" placeholder="City" autoComplete="off" value={form.city} onChange={set("city")} />
        <input aria-label="ZIP" placeholder="ZIP" autoComplete="off" inputMode="numeric" value={form.zip} onChange={set("zip")} />
      </div>
      {problem ? <p className="freshness">{problem}</p> : null}
      <button className="btn full" disabled={busy || !form.name || !form.street || !form.city || !form.zip} onClick={() => void send()}>
        {busy ? "Sending…" : "Continue"}
      </button>
    </Sheet>
  );
}

/** A link out opens in a new tab, and inside Xaman the host sends it to the phone's browser. The draw is a page on this site. */
function Proof({ row }: { row: ProofRow }) {
  return (
    <div>
      <dt>{row.label}</dt>
      <dd>
        {row.href.startsWith("/") ? (
          <Link href={row.href}>{row.text}</Link>
        ) : (
          <a href={row.href} target="_blank" rel="noopener">
            {row.text}
          </a>
        )}
      </dd>
    </div>
  );
}

/** One real pull: its picture, what it is, where it stands in plain words, the next thing to do, and proof of all of it. */
export function LiveItemView({ rawId }: { rawId: string }) {
  const ref = parseLiveId(rawId) as LiveRef;
  const { nft, card, missing, mine, load } = useLiveItem(ref);
  const details = useCardDetails(ref.kind === "card" && card?.status === "held" ? ref.id : null);
  const xrpUsd = useXrpUsd();
  const { mode } = useRails();
  const { shell } = useXapp();
  const demo = useDemo();
  const [sheet, setSheet] = useState<"sell" | "ship" | null>(null);
  const { claiming, problem, gone, claim, takeBack, close: closeAccept, sheet: acceptSheet } = useAccept(ref, load);
  const [quote, setQuote] = useState<number | null>(null);
  const [sold, setSold] = useState(false);
  // Nothing more can happen to these on our side, so there's nothing to keep asking the server about.
  const settled = nft?.pull === "claimed" || nft?.pull === "redeemed" || nft?.pull === "sold" || nft?.status === "refunded" || card?.hold === "shipped" || card?.hold === "sold" || card?.status === "refunded";
  usePoll(load, 3000, settled);
  // The ledger has it: nothing left to sign.
  useEffect(() => {
    if (nft?.pull === "claimed" || card?.hold === "mirrored") closeAccept();
  }, [nft?.pull, card?.hold, closeAccept]);
  const canSellCard = !!mine && !!card && (card.hold === "stashed" || card.hold === "offered" || card.hold === "mirrored");
  usePoll(
    async () => {
      const r = await api<{ drops: string }>(`${ref.api}/sell`, {});
      setQuote(r.ok ? dropsToXrp(r.body.drops) : null);
    },
    20000,
    !canSellCard,
  );
  // A connect on this page changes who's looking.
  useEffect(() => {
    void load();
  }, [demo.address, load]);

  if (missing) {
    return (
      <main className="pg">
        <div className="emptyc">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/404.webp" alt="A confused seal with foil in its teeth" />
          <h3>{shell ? "We can't find this item" : "That page got eaten"}</h3>
          <Link className="btn" href="/collection">
            Back to collection
          </Link>
        </div>
      </main>
    );
  }
  const drawn = nft ? nftAward(nft, xrpUsd) : card ? cardAward(card, (quote ?? 0) * xrpUsd) : null;
  const sellingNow = nft ? nft.pull === "selling" || nft.pull === "sold" : card ? ["exit_source", "selling", "sold"].includes(card.hold ?? "") || (card.hold === "exit_burn" && card.exit?.kind === "sell") : false;
  if (sold || sellingNow) return <LiveSoldScreen ref_={ref} nft={nft} card={card} />;
  if (card?.status === "review") {
    return (
      <main className="pg">
        <div className="emptyc">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/vault.webp" alt="A serious seal guards a vault door" />
          <h3>We&apos;re checking on this one</h3>
          <p>Don&apos;t pay again. It stays in your collection while we sort it&nbsp;out.</p>
          <Link className="btn" href="/collection">
            Back to collection
          </Link>
        </div>
      </main>
    );
  }
  if (!drawn) return <main className="pg" style={{ minHeight: "60vh" }} />;
  const award = withDetails(drawn, details);

  const isNft = award.kind === "nft";
  const status = nft ? nftStatusLabel(nft) : card ? cardStatusLabel(card) : "";
  const nftOpen = nft?.pull === "offered";
  const stashed = nft ? nft.pull === "stashed" : card?.hold === "stashed";
  const mirrored = card?.hold === "mirrored";
  const offered = card?.hold === "offered";
  const minting = card?.hold === "minting";
  const claimedNft = nft?.pull === "claimed";
  const takingBack = nft?.pull === "cancelling" || (card?.hold === "exit_burn" && card.exit?.kind === "back");
  const shipping = card?.hold === "ship_queue" || card?.hold === "shipped" || (card?.hold === "exit_burn" && card.exit?.kind === "ship");
  const simulated = card?.source === "simulated";
  const label = networkLabel(mode);
  const sellXrp = nft ? nft.sellXrp : quote;
  const onMarket = claimedNft && nft?.nft ? marketUrl(mode, nft.nft.id) : mirrored && card?.mirror ? marketUrl(mode, card.mirror.nftId) : null;
  // Money coming back keeps its receipt. The rest of the ledger trail stays on the explorer, not on this page.
  const proofs = (nft ? nftProofs(nft, mode) : card ? cardProofs(card, mode) : []).filter((row) => ["sale", "refund", "redeem"].includes(row.key));
  const graded = details?.grader && details.grade ? `${details.grader} ${details.grade}` : award.grade;
  const cert = details?.cert ? certUrl(details.grader, details.cert) : null;
  const fact = (name: string, value: string | number | null | undefined) =>
    value === null || value === undefined ? null : (
      <div>
        <dt>{name}</dt>
        <dd>{value}</dd>
      </div>
    );
  const sellLabel = sellXrp === null ? "Sell" : `Sell for ${xrpShort(sellXrp)} XRP`;
  return (
    <main className="pg packp">
      <div className="crumb">
        <Link href="/collection">collection</Link> / {tidy(award.name).slice(0, 44)}
      </div>
      <div className="split">
        <div className="pleft">
        <div className="pstage">
          {award.token ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className="solo card" src={award.img} alt={award.name} />
          ) : (
            <CardArt name={award.name} front={award.img} back={details?.back} nft={isNft} className="solo card" sizes={REVEAL_SIZES} priority />
          )}
        </div>
        {onMarket ? (
          <>
            <a className="btn ol full" href={onMarket} target="_blank" rel="noopener">
              View on xrp.cafe
            </a>
            {shell ? <p className="fine">{noOrphan("Opens xrp.cafe, a third-party marketplace, in your browser.")}</p> : null}
          </>
        ) : null}
        </div>
        <div className="pcopy">
          <div className="tagrow" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <TierLabel tier={award.tier} />
            {label ? <span className="notbanner">{label}</span> : null}
            {simulated ? <span className="notbanner">Simulated card</span> : null}
          </div>
          <h1 className="sm">
            {tidy(award.name)}
            <em>.</em>
          </h1>
          <div className="price">{isNft ? award.grade : usd2(award.value)}</div>
          <span className="lb">{award.token ? "when you pulled" : isNft ? "marked value" : "listed value"}</span>
          <dl className="dl">
            {fact("Status", status)}
            {!isNft ? fact("Grade", graded) : null}
            {details?.cert ? (
              <div>
                <dt>Cert number</dt>
                <dd>
                  {cert ? (
                    <a href={cert} target="_blank" rel="noopener">
                      {details.cert}
                    </a>
                  ) : (
                    details.cert
                  )}
                </dd>
              </div>
            ) : null}
            {fact("Set", details?.set)}
            {fact("Year", details?.year)}
            {fact("Card number", details?.number)}
            {fact("Category", details?.category)}
            {fact("Language", details?.language)}
            {isNft ? (
              fact("Custody", nft?.pull === "redeemed" || claimedNft ? "In your wallet" : "Public Break the Seal wallet")
            ) : card?.hold === "shipped" ? (
              fact("Custody", "Shipped to you")
            ) : (
              <div>
                <dt>Custody</dt>
                <dd className="custody">
                  <span>{noOrphan("Held in a third-party card vault")}</span>
                  {card?.card?.mint && !simulated ? (
                    <a href={cardRecordUrl(card.card.mint)} target="_blank" rel="noopener noreferrer">
                      View card
                    </a>
                  ) : null}
                </dd>
              </div>
            )}
            {!isNft && card?.sellUntil ? fact("Sell-back window", "Set by the card vault") : null}
            {proofs.map((row) => (
              <Proof key={row.key} row={row} />
            ))}
          </dl>
          {isNft && !award.token ? <Attribution /> : null}
          {problem ? <p className="freshness">{noOrphan(problem)}</p> : null}
          {mine === false ? (
            demo.signed && demo.wallet !== "demo" ? (
              <div className="note">{noOrphan("This belongs to another wallet, so there's nothing for you to do here.")}</div>
            ) : (
              <SignInToAct />
            )
          ) : mine === null ? null : nft?.prize ? (
            <PrizeActions ref_={ref} order={nft} onChange={() => void load()} onSold={() => setSold(true)} />
          ) : shipping ? (
            <div className="note">{card?.hold === "shipped" ? `On its way. Tracking: ${card.shipRef}` : "Queued to ship. We'll post tracking here as soon as the carrier has it."}</div>
          ) : claimedNft ? (
            <>
              <div className="note">{noOrphan("It's in your wallet now. You hold it yourself, and instant sell-back has ended.")}</div>
            </>
          ) : minting || nft?.pull === "offering" || takingBack ? (
            <div className="waitrow" role="status">
              <i className="spin" aria-hidden="true" /> {takingBack ? "Taking back the offer" : "Making your offer on the ledger"}
            </div>
          ) : nftOpen ? (
            <div className="offerbox">
              {gone ? (
                <button className="btn full" onClick={() => void takeBack()}>
                  Take it back
                </button>
              ) : (
                <>
                  <div className="note">{noOrphan("There's a free offer waiting that only your wallet can take. You don't have to take it: take it back and the NFT stays in your stash, where you can sell it.")}</div>
                  <div className="buy">
                    <button className="btn ol" onClick={() => void takeBack()}>
                      Take it back
                    </button>
                    <button className="btn" disabled={claiming} onClick={() => void claim()}>
                      Accept in wallet
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : offered ? (
            <div className="offerbox">
              {gone ? null : <div className="note">{noOrphan("There's a free offer waiting that only your wallet can take. You don't have to take it: sell or ship the card from here and the offer goes away, or take it back and keep the card in your stash.")}</div>}
              <div className="buy">
                <button className="btn ol" disabled={sellXrp === null} onClick={() => setSheet("sell")}>
                  {sellLabel}
                </button>
                {gone ? (
                  <button className="btn" onClick={() => setSheet("ship")}>
                    Ship it
                  </button>
                ) : (
                  <button className="btn" disabled={claiming} onClick={() => void claim()}>
                    Accept in wallet
                  </button>
                )}
              </div>
              <SellWindow until={card?.sellUntil} priced={sellXrp !== null} />
              {gone ? null : (
                <button className="btn ol full" onClick={() => setSheet("ship")}>
                  Ship it
                </button>
              )}
              <button className="btn ol full" onClick={() => void takeBack()}>
                Take back offer and keep it in my stash
              </button>
            </div>
          ) : stashed || mirrored ? (
            <>
              <div className="buy">
                {isNft ? (
                  <button className="btn ol" disabled={claiming} onClick={() => void claim()}>
                    {claiming ? "Making your offer…" : "Claim to wallet"}
                  </button>
                ) : null}
                {!isNft ? (
                  <button className="btn ol" onClick={() => setSheet("ship")}>
                    Ship it
                  </button>
                ) : null}
                <button className="btn" disabled={sellXrp === null} onClick={() => setSheet("sell")}>
                  {sellLabel}
                </button>
              </div>
              <SellWindow until={card?.sellUntil} priced={sellXrp !== null} />
            </>
          ) : null}
          {mine && stashed && !isNft ? (
            <button className="btn ol full" disabled={claiming} onClick={() => void claim()}>
              {claiming ? "Making your NFT…" : "Claim as NFT"}
            </button>
          ) : null}
          {mine && stashed && !nft?.prize ? <p className="fine">{isNft ? noOrphan("Claiming makes a free offer to your wallet. Accepting it holds at most 0.2 XRP in reserve and ends instant sell-back.") : noOrphan("Claiming makes an NFT that stands for this card, sent as a free offer. Accepting it holds at most 0.2 XRP in reserve. Whoever holds the NFT can ship or sell the card.")}</p> : null}
        </div>
      </div>
      {sheet === "sell" ? (
        <LiveSellSheet
          item={ref}
          onClose={() => setSheet(null)}
          onSold={() => {
            setSheet(null);
            setSold(true);
          }}
        />
      ) : null}
      {sheet === "ship" ? (
        <ShipSheet
          ref_={ref}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            void load();
          }}
        />
      ) : null}
      {acceptSheet}
    </main>
  );
}

export type { LiveCard, LiveOrder };
