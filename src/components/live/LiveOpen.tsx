"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { NFT_LADDERS, type NftPrice } from "@/config/nft-packs";
import { useDemo, useHydrated } from "@/lib/demo/store";
import { REFUND_REASONS, api, owedPrizeText, pullComesBack, cardAward, networkLabel, nftAward, parseLiveId, txUrl, verifyHref, xrpShort, xrpText, type LiveCard, type LiveOrder, type LiveRef, dropsToXrp } from "@/lib/live/client";
import { useCardDetails, usePoll, useRipConfig } from "@/lib/live/hooks";
import { WAITING_CONFIRMATION } from "@/lib/live/sign-copy";
import { revealNext, soldTrail, withDetails } from "@/lib/live/proof";
import { noOrphan, usd2 } from "@/lib/format";
import { againHref, pullPack } from "@/lib/again";
import { orderBackXrp, pullMultiple } from "@/lib/pull-multiple";
import { useRails, useXrpUsd } from "../Providers.tsx";
import { RevealView } from "../RevealView.tsx";
import { Stage } from "../Stage.tsx";
import { useXapp } from "../XappHost.tsx";
import { usePackAvailability } from "./Restock.tsx";
import { LiveSellSheet } from "./SellSheet.tsx";
import { SellWindow } from "./SellWindow.tsx";
import { SignInToAct } from "./SignInToAct.tsx";

const packArt = (price: NftPrice) => `/assets/pack-${NFT_LADDERS[price].art}.webp`;

export function useLiveItem(ref: LiveRef) {
  const [nft, setNft] = useState<LiveOrder | null>(null);
  const [card, setCard] = useState<LiveCard | null>(null);
  const [missing, setMissing] = useState(false);
  const [mine, setMine] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    if (ref.kind === "nft") {
      const r = await api<{ order: LiveOrder; mine: boolean }>(ref.api);
      if (r.status === 404) setMissing(true);
      else if (r.ok) {
        setNft(r.body.order);
        setMine(r.body.mine);
      }
      return;
    }
    const r = await api<{ order: LiveCard; mine: boolean }>(ref.api);
    if (r.status === 404) setMissing(true);
    else if (r.ok) {
      setCard(r.body.order);
      setMine(r.body.mine);
    }
  }, [ref.api, ref.kind]);
  return { nft, card, missing, mine, load };
}

export function Gone({ title, text, back = "/packs" }: { title: string; text: string; back?: string }) {
  return (
    <div className="stage">
      <div className="err">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/404.webp" alt="A confused seal with foil in its teeth" width={260} />
        <h3>{title}</h3>
        <p>{text}</p>
        <div className="acts">
          <Link className="btn" href={back}>
            {back === "/packs" ? "Explore packs" : "Back to collection"}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Stays on the stage until the server has the result. It never decides anything: it waits, then shows what came back. */
export function LiveOpenFlow({ rawId }: { rawId: string }) {
  const router = useRouter();
  const ref = parseLiveId(rawId) as LiveRef;
  const { nft, card, missing, load } = useLiveItem(ref);
  const hydrated = useHydrated();
  const xrpUsd = useXrpUsd();
  const { mode } = useRails();
  const drawn = ref.kind === "nft" ? nft?.status === "drawn" : card?.status === "held";
  usePoll(load, 2000, drawn);
  const award = ref.kind === "nft" ? (nft ? nftAward(nft, xrpUsd) : null) : card ? cardAward(card) : null;
  const reveal = useCallback(() => router.replace(`/reveal/${rawId}`), [rawId, router]);
  const close = useCallback(() => router.push("/collection"), [router]);

  if (!hydrated) return <div className="stage" />;
  if (missing) return <Gone title="That pull isn't here" text="We can't find this order." />;
  if (nft && pullComesBack(nft)) return <Gone title="Your XRP is coming back" text={REFUND_REASONS[nft.refund?.reason ?? ""] ?? "This pull didn't complete. Your XRP is going back to your wallet, whole."} />;
  if (nft?.status === "expired") return <Gone title="That checkout ended" text="Nothing was charged." />;
  if (card?.status === "review") return <Gone title="We're checking on this one" text="Don't pay again. It's in your collection, and we'll sort it out from here." back="/collection" />;
  if (card?.status === "refund_due" || card?.status === "refunded") return <Gone title="Your XRP is coming back" text={REFUND_REASONS[card.refund?.reason ?? ""] ?? "This pack didn't complete. Your XRP is going back to your wallet, whole."} />;
  if (card?.status === "expired") return <Gone title="That checkout ended" text="Nothing was charged." />;

  const simulated = card?.source === "simulated";
  const art = ref.kind === "nft" && nft ? packArt(nft.price) : "/assets/stage-pack.webp";
  const steps =
    ref.kind === "nft"
      ? [
          { done: !!nft && nft.status !== "quoted", wait: WAITING_CONFIRMATION, yes: "Payment on the ledger" },
          { done: !!drawn, wait: "Waiting for a later ledger to close", yes: "Pull fixed" },
        ]
      : [
          { done: !!card && card.status !== "quoted", wait: WAITING_CONFIRMATION, yes: "Payment on the ledger" },
          { done: !!card && ["source_paid", "opened", "held"].includes(card.status), wait: simulated ? "Buying the pack (simulated source)" : card?.status === "funding" ? "Your pack is on its way" : "Buying your pack", yes: "Pack bought" },
          { done: !!drawn, wait: "Checking it's in the vault", yes: "In the vault" },
        ];
  const tag = [networkLabel(mode), simulated ? "SIMULATED CARD" : ""].filter(Boolean).join(" · ");
  // A phone can land here from a wallet without having paid: it said no, or the request ran out. Checkout finds the same order.
  const unpaid = nft?.status === "quoted" ? `/checkout?nft=${nft.price}` : card?.status === "quoted" ? `/checkout?pack=${encodeURIComponent(card.code)}` : null;
  return <Stage art={art} award={drawn ? award : null} error={null} mode="live" networkTag={tag} steps={steps} onClose={close} onReveal={reveal} waitingOn={unpaid ? <Link href={unpaid}>Didn&apos;t approve it? Back to checkout</Link> : null} />;
}

/** The result, on real rails. Stash moves nothing: the NFT or card stays in custody until you claim, ship or sell it. */
export function LiveRevealFlow({ rawId }: { rawId: string }) {
  const router = useRouter();
  const ref = parseLiveId(rawId) as LiveRef;
  const { nft, card, missing, load } = useLiveItem(ref);
  const details = useCardDetails(ref.kind === "card" && card?.status === "held" ? ref.id : null);
  const hydrated = useHydrated();
  const xrpUsd = useXrpUsd();
  const { mode } = useRails();
  const { shell } = useXapp();
  const [selling, setSelling] = useState(false);
  const [sold, setSold] = useState(false);
  const [quote, setQuote] = useState<number | null>(null);
  const demo = useDemo();
  const signedOut = hydrated && (!demo.signed || demo.wallet === "demo");
  const packState = usePackAvailability(nft?.prize?.token === "XRP" ? nft.price : undefined);
  usePoll(load, 2500, false);
  usePoll(
    async () => {
      if (ref.kind !== "card" || quote !== null) return;
      const r = await api<{ drops: string }>(`${ref.api}/sell`, {});
      if (r.ok) setQuote(dropsToXrp(r.body.drops));
    },
    8000,
    ref.kind !== "card" || quote !== null || sold || signedOut,
  );

  if (!hydrated) return <div className="stage" />;
  if (missing) return <Gone title="Nothing to reveal" text="We can't find this order." />;
  const drawn = ref.kind === "nft" ? (nft ? nftAward(nft, xrpUsd) : null) : card ? cardAward(card, (quote ?? 0) * xrpUsd) : null;
  if (!drawn) return <div className="stage" />;
  const award = withDetails(drawn, details);
  const sellXrp = ref.kind === "nft" ? nft?.sellXrp ?? null : quote;
  const doneSelling = ref.kind === "nft" ? nft?.pull === "sold" || nft?.pull === "selling" : card?.hold === "sold" || card?.hold === "selling" || card?.hold === "exit_source" || (card?.hold === "exit_burn" && card.exit?.kind === "sell");
  // Already decided, from another tab or an earlier visit: the item page has the rest of the story.
  // An owed prize is on its way from the draw, and it still gets its reveal, with the news.
  const owed = nft?.pull === "redeeming" && !!nft.prize?.owed;
  const moved = ref.kind === "nft" ? !!nft?.pull && nft.pull !== "stashed" && !owed : !!card?.hold && card.hold !== "stashed";
  if (moved && !sold && !doneSelling) {
    router.replace(`/collection/${rawId}`);
    return <div className="stage" />;
  }
  if (sold || doneSelling) return <LiveSoldScreen ref_={ref} nft={nft} card={card} />;
  const simulated = card?.source === "simulated";
  const tag = [networkLabel(mode), simulated ? "SIMULATED CARD" : "", "YOURS"].filter(Boolean).join(" · ");
  const payTx = nft?.paymentTx ?? card?.paymentTx ?? null;
  return (
    <>
      <RevealView
        award={award}
        back={details?.back}
        packName={ref.kind === "nft" && nft ? NFT_LADDERS[nft.price].name : card?.packName ?? "Card pack"}
        multiple={ref.kind === "nft" ? (nft ? pullMultiple(orderBackXrp(nft), nft.xrp) : null) : pullMultiple(quote, card?.xrp)}
        tag={tag}
        onClose={() => router.push("/collection")}
        actions={
          signedOut ? (
            <SignInToAct />
          ) : owed ? (
            <button className="btn full" onClick={() => router.replace(`/collection/${rawId}`)}>
              See it in your stash
            </button>
          ) : (
          <>
          <p className="rnext">{noOrphan(revealNext(award, nft?.prize))}</p>
          <div className="buy2">
            <button className="btn ol" onClick={() => router.replace(`/collection/${rawId}`)}>
              Stash
            </button>
            {nft?.prize ? (
              <button className="btn" onClick={() => router.replace(`/collection/${rawId}`)}>
                {nft.prize.token !== "XRP" ? "Redeem or sell" : packState === "restocking" || shell ? "Cash out" : "Cash out and rip again"}
              </button>
            ) : (
              <button className="btn" disabled={sellXrp === null} onClick={() => setSelling(true)}>
                {sellXrp === null ? "Sell" : `Sell for ${xrpShort(sellXrp)} XRP`}
              </button>
            )}
          </div>
          <SellWindow until={card?.sellUntil} priced={sellXrp !== null} />
          </>
          )
        }
        foot={
          <p className="fine">
            {owed && nft?.prize ? `${owedPrizeText(nft.prize.name)} ` : nft?.prize ? "Held in the public Break the Seal wallet. " : award.kind === "nft" ? "Held in the public Break the Seal wallet until you claim it. " : card?.sellUntil ? "The card vault sets the instant sell-back window. " : ""}
            {payTx ? (
              <a href={txUrl(mode, payTx)} target="_blank" rel="noopener">
                See your payment on the ledger
              </a>
            ) : null}
            {nft && nft.index !== null ? (
              <>
                {" · "}
                <Link href={verifyHref(nft.season, nft.index)}>Verify this pull</Link>
              </>
            ) : null}
          </p>
        }
      />
      {selling ? (
        <LiveSellSheet
          item={ref}
          onClose={() => setSelling(false)}
          onSold={() => {
            setSelling(false);
            setSold(true);
          }}
        />
      ) : null}
    </>
  );
}

const COIN_COUNT = 22;
/** One handful of coins out of the pile. Each coin's path is fixed by its place in the handful and which handful it is. */
function SoldCoins({ burst }: { burst: number }) {
  if (!burst) return null;
  return (
    <div className="soldcoins" key={burst} aria-hidden="true">
      {Array.from({ length: COIN_COUNT }, (_, i) => {
        const turn = (i * 137.5 + burst * 41) % 360;
        const far = 90 + ((i * 53 + burst * 17) % 150);
        return <i key={i} style={{ "--x": `${Math.round(Math.cos((turn * Math.PI) / 180) * far)}px`, "--y": `${Math.round(Math.sin((turn * Math.PI) / 180) * far) - 60}px`, "--spin": `${180 + ((i * 97) % 540)}deg`, "--d": `${(i % 6) * 35}ms` } as CSSProperties} />;
      })}
    </div>
  );
}

/** Runs up to the real amount and lands on it exactly. */
function useCountUp(target: number | null, ms = 1100): number | null {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (target === null) return;
    if (window.matchMedia("(prefers-reduced-motion:reduce)").matches) {
      setShown(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setShown(t === 1 ? target : target * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

export function LiveSoldScreen({ ref_, nft, card }: { ref_: LiveRef; nft: LiveOrder | null; card: LiveCard | null }) {
  const { mode } = useRails();
  const xrpUsd = useXrpUsd();
  const demo = useDemo();
  const config = useRipConfig(true);
  const { nft: fresh, card: freshCard, load, mine } = useLiveItem(ref_);
  const n = fresh ?? nft;
  const c = freshCard ?? card;
  const hash = n?.sellTx ?? c?.sellTx ?? null;
  usePoll(load, 2500, !!hash);
  const xrp = n?.sellXrp ?? (c?.exit?.drops ? dropsToXrp(c.exit.drops) : null);
  const shown = useCountUp(xrp);
  const [burst, setBurst] = useState(0);
  const { shell } = useXapp();
  // The first handful lands with the money, once. Inside Xaman a sale gets a plain receipt: no celebration, and no nudge to buy again.
  useEffect(() => {
    if (shell) return;
    if (hash && !window.matchMedia("(prefers-reduced-motion:reduce)").matches) setBurst((b) => b || 1);
  }, [hash, shell]);
  const wallet = mine && demo.signed && demo.wallet !== "demo" ? demo.address : null;
  const steps = soldTrail({ nft: n, card: c, mode, treasury: config?.treasury, wallet });
  return (
    <div className="stage sold">
      <div className="soldgrid">
        <div className="emptyc soldhead">
          <button type="button" className="soldart" onClick={() => !shell && setBurst((b) => b + 1)} aria-label={shell ? "Sold" : "Toss some coins"}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/sell.webp" alt="A happy seal in a pile of coins" />
            <SoldCoins burst={burst} />
          </button>
          <h2 className={hash ? "soldstamp" : "soldword"}>{hash ? "Sold" : "Selling"}</h2>
          {xrp !== null ? (
            <div className="soldamount">
              <strong>{xrpText(shown ?? 0)} XRP</strong>
              {mode === "testnet" ? <span>testnet</span> : <span>about {usd2(xrp * xrpUsd)}</span>}
            </div>
          ) : null}
          <p>{hash ? (mine === false ? "Paid to its owner's wallet." : "It's in your wallet.") : mine === false ? "On its way to its owner's wallet." : "On its way to your wallet."}</p>
          <div className="soldbtns">
            <Link className={shell ? "btn ol" : "btn"} href={againHref(pullPack(n ?? c))}>
              Open another
            </Link>
            <Link className={shell ? "btn" : "btn ol"} href="/collection">
              {shell ? "My stash" : "My collection"}
            </Link>
          </div>
        </div>
        {steps.length ? (
          <section className="trail" aria-label="Where the money went">
            <h3>{shell ? "Where the money went" : "Follow the money"}</h3>
            <ol>
              {steps.map((s, i) => (
                <li key={s.key} className={s.href ? "" : "wait"} style={{ "--i": i } as CSSProperties}>
                  <span className="tlabel">
                    {s.label}
                    {s.detail ? <em>{s.detail}</em> : null}
                  </span>
                  {s.href ? (
                    <a href={s.href} target={s.href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
                      {s.text}
                    </a>
                  ) : (
                    <span className="twait">{s.text}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </div>
  );
}
