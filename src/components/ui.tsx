import Link from "next/link";
import type { Item, Machine } from "@/lib/catalog/types";
import { noOrphan, shortDate, tidy, usd, usd2, whole } from "@/lib/format";
import { TIER_SYMBOL, capitalize } from "@/lib/tiers";
import type { TierName } from "@/lib/rails/types";
import type { NftPackView, NftTierView } from "@/lib/nft/view";
import { shortCollection } from "@/lib/nft/view";
import { XRP_PRIZE_ART } from "@/lib/prize-art";
import type { PullMultiple } from "@/lib/pull-multiple";
import { RestockStamp, RestockTag } from "./live/Restock.tsx";
import { Slab } from "./Slab.tsx";

export function SecHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="sh">
      <h2>{title}</h2>
      {right ? <p>{right}</p> : null}
    </div>
  );
}

export function TierLabel({ tier }: { tier: TierName }) {
  return (
    <span className={`tier t-${tier}`}>
      {TIER_SYMBOL[tier]} {tier}
    </span>
  );
}

export const Attribution = () => (
  <span className="attr">
    <a href="https://xrpl.to" target="_blank" rel="noopener">
      Data by xrpl.to
    </a>
  </span>
);


/** Three real slabs fanned out. A sold-out pack with no items left shows the sealed foil, never made-up cards. */
export function Fan({ machine, big }: { machine: Pick<Machine, "fan">; big?: boolean }) {
  const fan = machine.fan.slice(0, 3);
  if (!fan.length) {
    return (
      <div className={`stack one ${big ? "" : "s"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img loading="lazy" src="/assets/stage-pack.webp" alt="" />
      </div>
    );
  }
  return (
    <div className={`stack ${big ? "big" : ""}`}>
      {fan.map((c) => (
        <Slab key={c.id} src={c.img} alt="" width={big ? 260 : 110} height={big ? 360 : 150} sizes={big ? "260px" : "110px"} />
      ))}
    </div>
  );
}

export function PackCard({ m }: { m: Machine }) {
  return (
    <article className={`pc ${m.stock ? "" : "off"}`}>
      <div className="pt">
        <span>{m.cat}</span>
        {m.stock ? null : <span className="tag warnT">Sold out</span>}
      </div>
      <Link href={`/packs/${m.code}`} aria-label={`${m.name} pack`} prefetch={false}>
        <Fan machine={m} />
      </Link>
      <h3>{noOrphan(m.name)}</h3>
      <div className="ps">
        <div>
          <span className="lb">Price</span>
          <strong>{usd(m.price)}</strong>
        </div>
        <div className="r">
          <span className="lb">In stock</span>
          <strong className="st">{m.stock.toLocaleString("en-US")}</strong>
        </div>
      </div>
      <Link className="btn ol full" href={`/packs/${m.code}`} prefetch={false}>
        View pack <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function NftCard({ pack, xrp }: { pack: Pick<NftPackView, "price" | "name" | "shortName" | "art">; xrp: string }) {
  return (
    <article className="pc nft">
      <div className="pt">
        <span>XRPL NFT</span>
        <RestockTag price={pack.price} />
      </div>
      <Link href={`/nft/${pack.price}`} aria-label={pack.name}>
        <div className="stack one">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src={pack.art} alt="" />
          <RestockStamp price={pack.price} />
        </div>
      </Link>
      <h3>{pack.shortName}</h3>
      <div className="ps">
        <div>
          <span className="lb">Price</span>
          <strong>${pack.price}</strong>
        </div>
        <div className="r">
          <span className="lb">About</span>
          <strong className="st">{xrp} XRP</strong>
        </div>
      </div>
      <Link className="btn ol full" href={`/nft/${pack.price}`}>
        View pack <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function ItemCard({ item, href, foot, onOpen, badge }: { item: Item; href?: string; foot?: React.ReactNode; onOpen?: () => void; badge?: React.ReactNode }) {
  const body = (
    <>
      <div className="ia">
        <Slab src={item.img} alt="" width={200} height={270} sizes="(min-width:1000px) 240px, 45vw" style={{ width: "auto" }} onFail="placeholder" />
      </div>
      {badge ? null : <TierLabel tier={capitalize(item.rarity) as TierName} />}
      <h3>{tidy(item.name).slice(0, 72)}</h3>
      <div className="mr">
        <div>
          <span className="lb">Listed value</span>
          <strong>{usd(item.ins)}</strong>
        </div>
        <small>{item.grade}</small>
      </div>
      {foot}
      {onOpen ? <button type="button" className="itemhit" aria-label={`See ${tidy(item.name)}`} onClick={onOpen} /> : null}
      {badge}
    </>
  );
  return href ? (
    <Link className="item" href={href} prefetch={false}>
      {body}
    </Link>
  ) : (
    <div className="item">{body}</div>
  );
}

/** One band of an NFT pack: real art from its primary collection and that floor. A collection with no art shows a plain tier block. */
export function NftTierCard({ view, xrpUsd }: { view: NftTierView; xrpUsd: number }) {
  if (view.dustXrp) {
    return (
      <div className="item nftitem">
        <div className="ia nftia">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src={XRP_PRIZE_ART} alt="An XRP prize" />
        </div>
        <TierLabel tier={view.tier} />
        <h3>XRP or SEAL</h3>
        <div className="mr">
          <div>
            <span className="lb">Pays</span>
            <strong>{`${view.dustXrp[0]} to ${view.dustXrp.at(-1)} XRP`}</strong>
          </div>
        </div>
      </div>
    );
  }
  const c = view.collection;
  const art = c?.samples[0]?.img;
  return (
    <div className="item nftitem">
      {art ? (
        <div className="ia nftia">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src={art} alt={`${c.name}: a real NFT from this collection`} />
        </div>
      ) : (
        <div className="ia tierbg noart">
          <span>{TIER_SYMBOL[view.tier]}</span>
          <small>Art not ready</small>
        </div>
      )}
      <TierLabel tier={view.tier} />
      <h3>{shortCollection(c ? c.name : "To pick")}</h3>
      <div className="mr">
        <div>
          <span className="lb">Floor</span>
          <strong>{c ? `${whole(c.floor)} XRP` : "-"}</strong>
        </div>
        <small>{c ? usd(Math.round(c.floor * xrpUsd)) : ""}</small>
      </div>
      {view.more > 0 ? <p className="fine moreband">{noOrphan(`and ${view.more} more ${view.more === 1 ? "collection" : "collections"}`)}</p> : null}
    </div>
  );
}

/** A pack's rarity rates as one table, rarest first as given. */
export function RatesGrid({ rows }: { rows: readonly { tier: TierName; rate: number }[] }) {
  return (
    <table className="ratetable" aria-label="Rarity rates">
      <thead>
        <tr>
          <th scope="col">Rarity</th>
          <th scope="col">Chance per pull</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.tier}>
            <th scope="row">
              <TierLabel tier={o.tier} />
            </th>
            <td>
              <span className="ratebar" aria-hidden="true">
                <i style={{ width: `${Math.max(1, o.rate)}%` }} />
              </span>
              <strong>{o.rate}%</strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The two even panels under a pack: its rates, and similar packs. With nothing similar, the rates take the row. */
export function PackPanels({ rates, similar }: { rates: React.ReactNode; similar?: React.ReactNode }) {
  return (
    <div className={`panels ${similar ? "" : "one"}`}>
      <section className="panel">{rates}</section>
      {similar ? <section className="panel">{similar}</section> : null}
    </div>
  );
}

/** Shown when the live source is down and we are serving our last copy. */
export function StaleNote({ asOf }: { asOf: string }) {
  return <p className="freshness">Live pack data is catching up. Prices and stock below are the last we saw, from {shortDate(asOf)}.</p>;
}

export const moneyLabel = usd2;

/**
 * What this pull can get back now against what its pack cost, as one badge: yellow at or above the price, quiet under it. Nothing at all
 * until both numbers are real. It's one pull's outcome, never odds or a return.
 */
export function MultBadge({ m, label = "the pack price" }: { m: PullMultiple | null | undefined; label?: string }) {
  if (!m) return null;
  return (
    <span className={m.up ? "pmult up" : "pmult"} title={`${m.text} ${label}`} aria-label={`${m.text} ${label}`}>
      {m.text}
    </span>
  );
}
