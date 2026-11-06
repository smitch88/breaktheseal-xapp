"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Item } from "@/lib/catalog/types";
import type { Holding } from "@/lib/demo/state";
import { dispatch, useDemo } from "@/lib/demo/store";
import { shortAddress, tidy, usd, usd2 } from "@/lib/format";
import { Slab } from "./Slab.tsx";
import { NftImg } from "./NftImg.tsx";
import { REVEAL_SIZES } from "./Stage.tsx";
import { LIVE_CARD, LIVE_NFT, cardAward, cardStatusLabel, nftAward, nftStatusLabel, txUrl, type RailsMode } from "@/lib/live/client";
import { splitDust } from "@/lib/live/proof";
import { SellBadge } from "./live/SellWindow.tsx";
import { useLiveHoldings } from "@/lib/live/hooks";
import { signOutWallet } from "@/lib/wallet/sign-out";
import { BulkSheet } from "./live/BulkSheet.tsx";
import { PendingAccepts } from "./live/PendingAccepts.tsx";
import { useConnect, useRails, useXrpUsd } from "./Providers.tsx";
import { useXapp } from "./XappHost.tsx";
import { XappEnded } from "./XappSignIn.tsx";
import { SecHead, Attribution, ItemCard, TierLabel } from "./ui.tsx";
import { SellSheet } from "./SellSheet.tsx";
import { Sheet } from "./Sheet.tsx";
import { SoldScreen } from "./SoldScreen.tsx";

type Shown = { readonly id: string; readonly award: Holding["award"]; readonly status: string; readonly sellUntil?: string | null };

function HoldingArt({ h, size }: { h: Shown; size: "card" | "large" }) {
  const a = h.award;
  const className = size === "large" ? "solo card" : undefined;
  if (a.kind === "nft") return <NftImg className={className} src={a.img} alt={size === "large" ? a.name : ""} sizes={size === "large" ? REVEAL_SIZES : "(min-width:1000px) 240px, 45vw"} priority={size === "large"} />;
  return size === "large" ? <Slab className={className} src={a.img} alt={a.name} width={400} height={560} sizes={REVEAL_SIZES} priority onFail="placeholder" /> : <Slab src={a.img} alt="" width={200} height={270} sizes="(min-width:1000px) 240px, 45vw" style={{ width: "auto" }} onFail="placeholder" />;
}

function HoldingCard({ h, verb }: { h: Shown; verb?: "You receive" | "Listed value" }) {
  const a = h.award;
  const label = verb ?? (a.token ? "Worth" : a.kind === "nft" ? (a.provenance === "server" ? "Marked value" : "Floor") : "Listed value");
  return (
    <Link className="item" href={`/collection/${h.id}`}>
      <div className="ia">
        <HoldingArt h={h} size="card" />
        <SellBadge until={h.sellUntil} />
      </div>
      <TierLabel tier={a.tier} />
      <h3>{tidy(a.name).slice(0, 72)}</h3>
      <div className="mr">
        <div>
          <span className="lb">{label}</span>
          <strong>{verb === "You receive" ? usd2(a.sell) : usd(Math.round(a.value))}</strong>
        </div>
        <small>{verb === "You receive" ? a.grade : h.status}</small>
      </div>
    </Link>
  );
}

const useHydrated = () => {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
};

function Empty({ title }: { title: string }) {
  return (
    <div className="emptyc">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/assets/empty.webp" alt="A puzzled seal peeks into an empty locker" />
      <h3>{title}</h3>
      <Link className="btn" href="/packs">
        Open a pack
      </Link>
    </div>
  );
}

function ConnectFirst({ title }: { title: string }) {
  const connect = useConnect();
  // Inside Xaman the launch names the account, so there's no sign-in to offer: only the word that the launch has ended.
  if (useXapp().shell) return <XappEnded />;
  // webonly: inside Xaman it's hidden from the first paint, before the shell has even started.
  return (
    <div className="emptyc webonly">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/assets/vault.webp" alt="A serious seal guards a vault door" />
      <h3>{title}</h3>
      <button className="btn" onClick={() => connect()}>
        Connect
      </button>
    </div>
  );
}

function Stats({ items, value, claimed }: { items: number; value: number; claimed: number }) {
  return (
    <div className="stats">
      <div className="stat">
        <span className="lb">Items</span>
        <strong>{items}</strong>
      </div>
      <div className="stat">
        <span className="lb">Total value</span>
        <strong>{usd2(value)}</strong>
      </div>
      <div className="stat">
        <span className="lb">NFTs claimed</span>
        <strong>{claimed}</strong>
      </div>
    </div>
  );
}

const BULK_MAX = 20;
const WAITING = "Waiting for you to accept";
const STASH = "In your stash";
const WALLET = "In your wallet";

/** Real pulls for the collection. Anything finished (sold, claimed, refunded) is `done`, and every one keeps its own page. */
function useLiveShown(): { rows: readonly Shown[]; done: readonly Shown[]; lines: readonly (Shown & { over: boolean; redeemTx: string | null; onWay?: boolean })[]; sendable: readonly string[]; loaded: boolean; live: boolean; mode: RailsMode; refresh: () => void } {
  const { mode, multi } = useRails();
  const demo = useDemo();
  const xrpUsd = useXrpUsd();
  const live = mode !== "demo";
  const held = useLiveHoldings(live && demo.signed, demo.address);
  const nfts = held.nfts.flatMap((o): (Shown & { over: boolean; redeemTx: string | null; onWay?: boolean })[] => {
    const award = nftAward(o, xrpUsd);
    return award ? [{ id: `${LIVE_NFT}${o.id}`, award, status: nftStatusLabel(o), over: o.pull === "sold" || o.pull === "claimed" || o.pull === "redeemed", redeemTx: o.prize?.redeemTx ?? null, ...(o.payout && o.pull === "redeeming" ? { onWay: true } : {}) }] : [];
  });
  const cards = held.cards.flatMap((c): (Shown & { over: boolean; redeemTx: string | null })[] => {
    const award = cardAward(c);
    return award ? [{ id: `${LIVE_CARD}${c.id}`, award, status: cardStatusLabel(c), over: c.hold === "sold", redeemTx: null, sellUntil: c.hold === "stashed" || c.hold === "offered" || c.hold === "mirrored" ? c.sellUntil : null }] : [];
  });
  const all = [...nfts, ...cards];
  const { lines, items } = splitDust(all, WAITING);
  // Up to one payment's worth of XRP prizes, oldest first, and only with the switch on.
  const sendable = multi ? held.nfts.filter((o) => o.pull === "stashed" && o.prize?.token === "XRP").map((o) => o.id).slice(-BULK_MAX) : [];
  return { rows: items.filter((x) => !x.over), done: items.filter((x) => x.over), lines: [...lines.filter((x) => !x.over), ...lines.filter((x) => x.over)], sendable, loaded: held.loaded, live, mode, refresh: held.refresh };
}

export function CollectionView({ examples }: { examples: readonly Item[] }) {
  const [sendAll, setSendAll] = useState(false);
  const demo = useDemo();
  const liveShown = useLiveShown();
  const connect = useConnect();
  const hydrated = useHydrated();
  const signed = hydrated && demo.signed;
  const { shell } = useXapp();
  const title = shell ? "Stash" : "Collection";
  // Inside Xaman the launch names the account, so there's never a sign-in to offer: this is the moment before it arrives, or the word that it ended.
  if (!signed && shell) {
    return (
      <main className="pg" style={{ minHeight: "60vh" }}>
        <XappEnded />
      </main>
    );
  }
  if (!signed) {
    return (
      <main className="pg">
        <div className="ptitle">
          <h1>
            {title}<em>.</em>
          </h1>
        </div>
        <div className="acts">
          <button className="btn webonly" onClick={() => connect()}>
            Connect to see yours
          </button>
          <Link className="btn ol" href="/packs">
            Open a pack
          </Link>
        </div>
        <Stats items={examples.length} value={examples.reduce((a, c) => a + c.ins, 0)} claimed={0} />
        <section className="s">
          <SecHead title="Example collection" right="Real items from the packs" />
          <div className="igrid">
            {examples.map((c) => (
              <ItemCard key={c.id} item={c} />
            ))}
          </div>
        </section>
      </main>
    );
  }
  if (liveShown.live) {
    const pending = liveShown.rows.filter((h) => h.status === WAITING);
    const inWallet = [...liveShown.rows, ...liveShown.done].filter((h) => h.status === WALLET);
    const sold = liveShown.done.filter((h) => h.status === "Sold");
    const yours = liveShown.rows.filter((h) => h.status !== WAITING && h.status !== WALLET);
    const counted = [...pending, ...yours, ...inWallet];
    const total = counted.reduce((a, h) => a + h.award.value, 0);
    return (
      <main className="pg">
        <div className="ptitle">
          <h1>
            {title}<em>.</em>
          </h1>
        </div>
        <PendingAccepts rows={pending} onChange={liveShown.refresh} />
        <Stats items={counted.length} value={total} claimed={inWallet.filter((h) => !h.award.token).length} />
        <section className="s">
          <SecHead title="Yours" />
          {yours.length ? (
            <div className="igrid">
              {yours.map((h) => (
                <HoldingCard key={h.id} h={h} />
              ))}
            </div>
          ) : liveShown.loaded ? (
            pending.length || inWallet.length ? (
              <div className="empty">Nothing else in your stash right now.</div>
            ) : (
              <Empty title="Nothing stashed yet" />
            )
          ) : (
            <div style={{ minHeight: 200 }} />
          )}
        </section>
        {inWallet.length ? (
          <section className="s">
            <SecHead title="In your wallet" />
            <div className="igrid">
              {inWallet.map((h) => (
                <HoldingCard key={h.id} h={h} />
              ))}
            </div>
          </section>
        ) : null}
        {liveShown.lines.length ? (
          <section className="s">
            <SecHead title="Cash out" />
            {liveShown.sendable.length > 1 ? (
              <button className="btn ol redall" onClick={() => setSendAll(true)}>
                Cash out {liveShown.sendable.length} XRP prizes
              </button>
            ) : null}
            <ul className="redlines">
              {liveShown.lines.map((h) => {
                // XRP prizes cash out; a SEAL token prize still redeems.
                const xrp = h.award.token === "XRP";
                return (
                <li key={h.id}>
                  <strong>{tidy(h.award.name)}</strong>
                  <span>{usd2(h.award.value)}</span>
                  <span>{h.over ? (h.status === "Sold" ? "Sold" : xrp ? "Cashed out" : "Redeemed") : h.onWay ? "On its way" : xrp ? "Ready to cash out" : "Ready to redeem"}</span>
                  {h.redeemTx ? (
                    <a href={txUrl(liveShown.mode, h.redeemTx)} target="_blank" rel="noopener noreferrer">
                      View transaction
                    </a>
                  ) : (
                    <Link href={`/collection/${h.id}`}>{h.over || h.onWay ? "Details" : xrp ? "Cash out" : "Redeem"}</Link>
                  )}
                </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {sold.length ? (
          <section className="s">
            <SecHead title="Sold" />
            <div className="igrid">
              {sold.map((h) => (
                <HoldingCard key={h.id} h={h} />
              ))}
            </div>
          </section>
        ) : null}
        {sendAll ? (
          <BulkSheet
            ids={liveShown.sendable}
            onClose={() => setSendAll(false)}
            onDone={() => {
              setSendAll(false);
              liveShown.refresh();
            }}
          />
        ) : null}
      </main>
    );
  }
  const total = demo.holdings.reduce((a, h) => a + h.award.value, 0);
  const claimed = demo.history.filter((h) => h.label.startsWith("Demo claim")).length;
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          Collection<em>.</em>
        </h1>
      </div>
      <Stats items={demo.holdings.length} value={total} claimed={claimed} />
      <section className="s">
        <SecHead title="Yours" />
        {demo.holdings.length ? (
          <div className="igrid">
            {demo.holdings.map((h) => (
              <HoldingCard key={h.id} h={h} />
            ))}
          </div>
        ) : (
          <Empty title="Nothing stashed yet" />
        )}
      </section>
    </main>
  );
}

export function ItemView({ id }: { id: string }) {
  const demo = useDemo();
  const router = useRouter();
  const hydrated = useHydrated();
  const [sheet, setSheet] = useState<"sell" | "ship" | "claim" | null>(null);
  const [soldFor, setSoldFor] = useState<number | null>(null);
  const h = demo.holdings.find((x) => x.id === id);
  if (soldFor !== null) return <SoldScreen usd={soldFor} />;
  if (!hydrated) return <main className="pg" style={{ minHeight: "60vh" }} />;
  if (!h) {
    return (
      <main className="pg">
        <div className="emptyc">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/404.webp" alt="A confused seal with foil in its teeth" />
          <h3>That page got eaten</h3>
          <p>Demo items stay in the browser that pulled them.</p>
          <Link className="btn" href="/collection">
            Back to collection
          </Link>
        </div>
      </main>
    );
  }
  const a = h.award;
  const nft = a.kind === "nft";
  return (
    <main className="pg packp">
      <div className="crumb">
        <Link href="/collection">collection</Link> / {tidy(a.name).slice(0, 44)}
      </div>
      <div className="split">
        <div className="pstage">
          <HoldingArt h={h} size="large" />
        </div>
        <div className="pcopy">
          <div className="tagrow" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <TierLabel tier={a.tier} />
          </div>
          <h1 className="sm">
            {tidy(a.name)}
            <em>.</em>
          </h1>
          <div className="price">{usd2(a.value)}</div>
          <span className="lb">{nft ? "floor" : "listed value"}</span>
          <dl className="dl">
            <div>
              <dt>Status</dt>
              <dd>{h.status}</dd>
            </div>
            <div>
              <dt>Grade</dt>
              <dd>{a.grade}</dd>
            </div>
            <div>
              <dt>Custody</dt>
              {nft ? (
                <dd>None yet: public Break the Seal wallet at launch</dd>
              ) : (
                <dd>Held in a third-party card vault</dd>
              )}
            </div>
          </dl>
          {nft ? <Attribution /> : null}
          {h.status === "Shipping" ? (
            <div className="note">Demo shipment. At launch, tracking shows here as soon as the carrier has it.</div>
          ) : (
            <div className="buy">
              <button className="btn ol" onClick={() => setSheet(nft ? "claim" : "ship")}>
                {nft ? "Claim to wallet" : "Ship it"}
              </button>
              <button className="btn" onClick={() => setSheet("sell")}>
                Sell for {usd2(a.sell)}
              </button>
            </div>
          )}
        </div>
      </div>
      {sheet === "sell" ? (
        <SellSheet
          usd={a.sell}
          onCancel={() => setSheet(null)}
          onSell={() => {
            dispatch({ type: "sell", holdingId: h.id });
            setSoldFor(a.sell);
          }}
        />
      ) : null}
      {sheet === "ship" ? (
        <ShipSheet
          onClose={() => setSheet(null)}
          onShip={() => {
            dispatch({ type: "ship", holdingId: h.id });
            setSheet(null);
          }}
        />
      ) : null}
      {sheet === "claim" ? (
        <Sheet onClose={() => setSheet(null)} label="Claim to your wallet">
          <h3>Claim to your wallet</h3>
          <p className="fine">Mock. At launch we create a free transfer offer to your Xaman wallet, and accepting it holds at most 0.2 XRP in reserve. After that you hold the NFT yourself, and instant sell-back&nbsp;ends.</p>
          <button
            className="btn full"
            onClick={() => {
              dispatch({ type: "claim", holdingId: h.id });
              router.push("/collection");
            }}
          >
            Accept in Xaman (mock)
          </button>
        </Sheet>
      ) : null}
    </main>
  );
}

function ShipSheet({ onClose, onShip }: { onClose: () => void; onShip: () => void }) {
  return (
    <Sheet onClose={onClose} label="Ship this card">
      <h3>Ship this card</h3>
      <p className="fine">Mock form. Nothing you type leaves this page.</p>
      <input aria-label="Full name" placeholder="Full name" autoComplete="off" />
      <input aria-label="Street address" placeholder="Street address" autoComplete="off" />
      <div className="two">
        <input aria-label="City" placeholder="City" autoComplete="off" />
        <input aria-label="ZIP" placeholder="ZIP" autoComplete="off" inputMode="numeric" />
      </div>
      <div className="kv">
        <span>Shipping</span>
        <b>Quoted next</b>
      </div>
      <button className="btn full" onClick={onShip}>
        Ship it
      </button>
    </Sheet>
  );
}

export function ListView({ kind }: { kind: "sell" | "ship" }) {
  const demo = useDemo();
  const hydrated = useHydrated();
  const signed = hydrated && demo.signed;
  const liveShown = useLiveShown();
  // `rows` leaves out what's finished, so "in your wallet" here is always a card whose NFT the wallet holds.
  const usable = (h: Shown) => (h.status === STASH || h.status === WALLET) && (kind === "sell" || h.award.kind === "card");
  const rows: readonly Shown[] = liveShown.live ? liveShown.rows.filter(usable) : demo.holdings.filter((h) => (kind === "sell" ? h.status === "Stashed" : h.award.kind === "card"));
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          {kind === "sell" ? "Sell back" : "Ship"}
          <em>.</em>
        </h1>
      </div>
      {!signed ? (
        <ConnectFirst title="Connect to see your items" />
      ) : rows.length ? (
        <>
          <div className="igrid" style={{ marginTop: 14 }}>
            {rows.map((h) => (
              <HoldingCard key={h.id} h={h} verb={liveShown.live ? undefined : kind === "sell" ? "You receive" : "Listed value"} />
            ))}
          </div>
        </>
      ) : (
        <Empty title="Nothing here yet" />
      )}
    </main>
  );
}

export function ProfileView() {
  const { shell } = useXapp();
  const demo = useDemo();
  const connect = useConnect();
  const router = useRouter();
  const hydrated = useHydrated();
  const signed = hydrated && demo.signed;
  const liveShown = useLiveShown();
  if (signed && liveShown.live) {
    const waiting = liveShown.rows.filter((h) => h.status === WAITING).length;
    return (
      <main className="pg">
        <div className="ptitle">
          <h1>
            Profile<em>.</em>
          </h1>
        </div>
        {waiting ? (
          <p className="note">
            <Link href="/collection">
              {waiting} waiting for you to accept. See {waiting === 1 ? "it" : "them"} in your&nbsp;{shell ? "stash" : "collection"}.
            </Link>
          </p>
        ) : null}
        <div className="stats">
          <div className="stat">
            <span className="lb">{shell ? "Your Xaman account" : demo.wallet === "joey" ? "Signed in with Joey" : "Signed in with Xaman"}</span>
            <strong title={demo.address ?? undefined}>{shortAddress(demo.address)}</strong>
          </div>
          <div className="stat">
            <span className="lb">Packs opened</span>
            <strong>{liveShown.rows.length + liveShown.done.length}</strong>
          </div>
        </div>
        <section className="s">
          <SecHead title="Activity" />
          {[...liveShown.rows, ...liveShown.done].length ? (
            <dl className="dl">
              {[...liveShown.rows, ...liveShown.done].map((h) => (
                <div key={h.id}>
                  <dt>
                    <Link href={`/collection/${h.id}`}>{tidy(h.award.name).slice(0, 44)}</Link>
                  </dt>
                  <dd>{h.status}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="empty">Your packs and sales show here, each with a link to the ledger.</div>
          )}
        </section>
        {shell ? null : (
          <p style={{ marginTop: 18 }}>
            <button
              className="linky"
              onClick={() => {
                signOutWallet(demo.wallet);
                dispatch({ type: "disconnect" });
                router.push("/");
              }}
            >
              Sign out
            </button>
          </p>
        )}
      </main>
    );
  }
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          Profile<em>.</em>
        </h1>
      </div>
      {signed ? (
        <>
          <div className="stats">
            <div className="stat">
              <span className="lb">{demo.wallet === "demo" ? "Demo wallet" : demo.wallet === "joey" ? "Signed in with Joey" : "Signed in with Xaman"}</span>
              <strong title={demo.address ?? undefined}>{shortAddress(demo.address)}</strong>
            </div>
            <div className="stat">
              <span className="lb">{demo.wallet === "demo" ? "Demo balance" : "Balance"}</span>
              <strong>{demo.wallet === "demo" ? "1,240 XRP" : "Not read in this preview"}</strong>
            </div>
            <div className="stat">
              <span className="lb">Packs opened</span>
              <strong>{demo.history.filter((h) => h.label.startsWith("Demo pull")).length}</strong>
            </div>
          </div>
          <section className="s">
            <SecHead title="Activity" />
            {demo.history.length ? (
              <dl className="dl">
                {demo.history.map((h, i) => (
                  <div key={i}>
                    <dt>{h.label}</dt>
                    <dd>{h.amount}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="empty">Your demo packs and sales show here. At launch each links to the ledger.</div>
            )}
          </section>
          {shell ? null : (
            <p style={{ marginTop: 18 }}>
              <button
                className="linky"
                onClick={() => {
                  signOutWallet(demo.wallet);
                  dispatch({ type: "disconnect" });
                  router.push("/");
                }}
              >
                Sign out and clear the demo
              </button>
            </p>
          )}
        </>
      ) : shell ? (
        <XappEnded />
      ) : (
        <div className="emptyc webonly">
          <h3>Connect to see your profile</h3>
          <button className="btn" onClick={() => connect()}>
            Connect
          </button>
        </div>
      )}
    </main>
  );
}
