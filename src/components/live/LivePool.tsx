"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { marketUrl } from "@/lib/live/proof";
import { nftUrl } from "@/lib/live/client";
import { CardArt } from "../CardArt.tsx";
import { NftImg } from "../NftImg.tsx";
import { DetailSheet } from "../DetailSheet.tsx";
import { useRails } from "../Providers.tsx";
import { NftRateCopy } from "./NftRateCopy.tsx";
import { OddsBadge } from "../OddsBadge.tsx";
import { poolTiles, type PoolTile } from "@/lib/live/pool-tiles";
import { useLivePool } from "@/lib/live/hooks";
import type { LivePool } from "@/lib/live/client";
import { noOrphan } from "@/lib/format";
import { nftTitle, shortCollection } from "@/lib/nft/view";
import { PackPanels, RatesGrid, SecHead, TierLabel } from "../ui.tsx";

type PoolNft = LivePool["bands"][number]["nfts"][number];

/** One NFT in the pool: what the public log already says about it, and where to look it up. Nothing here is about any pull to come. */
function PoolNftSheet({ nft, tier, odds, onClose }: { nft: PoolNft; tier: PoolTile<PoolNft>["tier"]; odds: string; onClose: () => void }) {
  const { mode } = useRails();
  const name = nftTitle(nft.collection, nft.name);
  const market = marketUrl(mode, nft.id);
  return (
    <DetailSheet label={name} onClose={onClose}>
      <div className="dart">
        <CardArt name={name} front={nft.img} nft sizes="(min-width:760px) 380px, 80vw" />
      </div>
      <div className="dinfo">
        <TierLabel tier={tier} />
        <h3>{name}</h3>
        <dl className="dl">
          <div>
            <dt>Collection</dt>
            <dd>{shortCollection(nft.collection)}</dd>
          </div>
          <div>
            <dt>Band</dt>
            <dd>{tier}</dd>
          </div>
          <div>
            <dt>Marked at</dt>
            <dd>{`${Number(nft.markXrp.toFixed(2))} XRP`}</dd>
          </div>
          <div>
            <dt>Odds</dt>
            <dd>{odds}</dd>
          </div>
          {market ? (
            <div>
              <dt>On the market</dt>
              <dd>
                <a href={market} target="_blank" rel="noopener">
                  View on xrp.cafe
                </a>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>On the ledger</dt>
            <dd>
              <a href={nftUrl(mode, nft.id)} target="_blank" rel="noopener">
                View on the explorer
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </DetailSheet>
  );
}

/** An XRP or SEAL prize: what it pays and how often. */
function PoolPrizeSheet({ tile, onClose }: { tile: Extract<PoolTile<PoolNft>, { kind: "prize" }>; onClose: () => void }) {
  return (
    <DetailSheet label={`${tile.value} XRP`} onClose={onClose}>
      <div className="dart">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={tile.img} alt={tile.name} />
      </div>
      <div className="dinfo">
        <TierLabel tier={tile.tier} />
        <h3>{tile.name}</h3>
        <dl className="dl">
          <div>
            <dt>Pays</dt>
            <dd>{tile.tokens.length > 1 ? `${tile.value} XRP, or SEAL worth the same` : tile.tokens[0] === "XRP" ? `${tile.value} XRP` : `${tile.tokens[0]} worth ${tile.value} XRP`}</dd>
          </div>
          <div>
            <dt>Odds</dt>
            <dd>{tile.odds}</dd>
          </div>
        </dl>
      </div>
    </DetailSheet>
  );
}

/** One thing a pull can land on. The whole tile opens its details, and the badge on it holds the odds. */
function PoolTileView({ tile, onOpen }: { tile: PoolTile<PoolNft>; onOpen: () => void }) {
  const name = tile.kind === "nft" ? nftTitle(tile.nft.collection, tile.nft.name) : tile.name;
  return (
    <div className="item ptile">
      <div className="ia nftia">
        {tile.kind === "nft" ? (
          <NftImg loading="lazy" src={tile.nft.img} alt="" sizes="(min-width:700px) 240px, 45vw" />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img loading="lazy" src={tile.img} alt="" />
        )}
      </div>
      <h3>{name}</h3>
      <strong>{`${Number(tile.value.toFixed(2))} XRP`}</strong>
      <button type="button" className="itemhit" aria-label={`See ${name}`} onClick={onOpen} />
      <OddsBadge tier={tile.tier} odds={tile.odds} />
    </div>
  );
}

function PoolGrid({ pool }: { pool: LivePool }) {
  const tiles = poolTiles(pool);
  const [open, setOpen] = useState<PoolTile<PoolNft> | null>(null);
  if (!tiles.length) return <p className="fine">{noOrphan("Nothing in this pool yet. This pack stays closed until something goes in.")}</p>;
  return (
    <>
      <div className="igrid ptiles">
        {tiles.map((t) => (
          <PoolTileView key={t.key} tile={t} onOpen={() => setOpen(t)} />
        ))}
      </div>
      {open?.kind === "nft" ? <PoolNftSheet nft={open.nft} tier={open.tier} odds={open.odds} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "prize" ? <PoolPrizeSheet tile={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** With real rails on, the pack's prize view: this season's committed rates and what's really in its pool right now. A pulled NFT drops off on the next read. */
export function LivePoolSections({ price, similar }: { price: number; similar?: ReactNode }) {
  const pool = useLivePool(price);
  const rates = (body: ReactNode) => <PackPanels similar={similar} rates={<><SecHead title="Rarity rates" />{body}</>} />;
  if (pool === undefined) return rates(<><div className="waitrow" role="status"><i className="spin" aria-hidden="true" /> Reading this season&apos;s pool</div></>);
  if (pool === null) return rates(<><p className="fine">{noOrphan("This pack has no season open yet. Its rates and prizes show here as soon as they're on the ledger.")}</p></>);
  const rarestFirst = [...pool.bands].reverse();
  const count = pool.bands.reduce((a, b) => a + b.nfts.length, 0);
  const paysTokens = pool.bands.some((b) => b.prizes.length);
  // Per-item odds: each NFT quotes its own chance, and a band's XRP prizes take what its NFTs leave.
  const perItem = pool.bands.some((b) => b.nfts.some((n) => "pct" in n && n.pct !== undefined));
  // A full Chase leaves a sliver to the draw's rounding, millionths of a percent: the line is for a share worth reading, not "0% of pulls".
  const refund = Number(pool.bands.reduce((a, b) => a + ("refundPct" in b && typeof b.refundPct === "number" ? b.refundPct : 0), 0).toFixed(4));
  const howPicked = perItem
    ? "Each NFT has its own odds, and a dearer one is rarer in proportion. Whatever share a band's NFTs don't take pays its XRP prizes, so an NFT someone pulls hands its odds to them."
    : "A pull that lands on an NFT picks one fairly from its band's list, and an NFT someone pulls leaves it.";
  const refundLine = refund > 0 ? ` A Chase pull that lands on an NFT already pulled gives your XRP back whole: ${refund}% of pulls right now.` : "";
  return (
    <>
      {rates(
        <>
          <RatesGrid rows={rarestFirst.map((b) => ({ tier: b.tier, rate: b.pct }))} />
          <p className="fine">
            <NftRateCopy /> <Link href="/fair">How the draw works</Link>.
          </p>
        </>,
      )}
      <section className="s">
        <SecHead title="In this pack" right={`${count} ${count === 1 ? "NFT" : "NFTs"} in the pool`} />
        <PoolGrid pool={pool} />
<p className="fine">
          {noOrphan(`This is everything in the pool right now, and it's the same list the public log holds. ${howPicked}${refundLine}${paysTokens ? " An XRP prize stays in your stash until you redeem it to your wallet." : ""} Hover or tap a badge for its odds.`)}{" "}
          <Link href="/rates">Rarity&nbsp;rates</Link>.
        </p>
      </section>
    </>
  );
}
