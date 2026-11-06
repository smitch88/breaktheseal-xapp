import { notFound } from "next/navigation";
import { AdminActions, AutobuySwitch, ShipActions } from "@/components/live/AdminActions";
import { isAdmin, rails } from "@/lib/rip/server";
import { adminView } from "@/lib/rip/views";
import { SEO, pageMeta } from "@/lib/seo";

export const dynamic = "force-dynamic";
// A non-admin gets the 404's title too, not "Admin": the page never admits it exists.
export async function generateMetadata() {
  return pageMeta(rails() && (await isAdmin()) ? SEO.admin : SEO.notFound);
}

const xrp = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Operators only, and it doesn't admit it exists to anyone else. Cost and float are internal and appear nowhere a player can reach. */
export default async function AdminPage() {
  const r = rails();
  if (!r || !(await isAdmin())) notFound();
  const v = await adminView(r);
  const shipQueue = await Promise.all(v.cardLine.shipQueue.map(async (s) => ({ ...s, address: await r.secrets.get(`ship:${s.id}:${s.addressHash}`) })));
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          Admin<em>.</em>
        </h1>
      </div>
      <p className="freshness">Internal numbers, for operators only. Mode: {v.mode}. Validated ledger {v.validated}. Log head {v.head}.</p>
      <section className="s">
        <h2>Float</h2>
        <div className="stats">
          <div className="stat">
            <span className="lb">Treasury</span>
            <strong>{xrp(v.treasury.balanceXrp)} XRP</strong>
            <p className="fine">
              Owed now {xrp(v.treasury.owedXrp)} · stash sell liability {xrp(v.treasury.stashSellLiabilityXrp)}
            </p>
            <span className="admincode">{v.treasury.address}</span>
          </div>
          <div className="stat">
            <span className="lb">Vault</span>
            <strong>{xrp(v.vault.balanceXrp)} XRP</strong>
            <p className="fine">Owner objects {v.vault.ownerCount}</p>
            <span className="admincode">{v.vault.address}</span>
          </div>
        </div>
      </section>
      <section className="s">
        <h2>Inventory</h2>
        {v.tiers.filter((t) => t.season).length === 0 ? <div className="empty">No seasons are open yet.</div> : null}
        {v.tiers.filter((t) => t.season).map((t) => (
          <div key={t.price} className="adminscroll">
            <p className="fine">
              ${t.price} pack · season {t.season ?? "none"} {t.live ? "(live)" : "(not open)"} · {xrp(t.priceXrp)} XRP · drawn {t.pullsDrawn} · holds {t.holds}
            </p>
            <table className="admintable">
              <thead>
                <tr>
                  <th>Band</th>
                  <th>In pool</th>
                  <th>Collections</th>
                  <th>Top share</th>
                  <th>Cost XRP</th>
                  <th>Mark XRP</th>
                </tr>
              </thead>
              <tbody>
                {t.bands.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td>{b.stock}</td>
                    <td>{b.collections}</td>
                    <td>{pct(b.topShare)}</td>
                    <td>{xrp(b.costXrp)}</td>
                    <td>{xrp(b.markXrp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
      {v.restock ? (
        <section className="s">
          <h2>Restocker</h2>
          <p className="fine">
            Buying {v.restock.on ? "on" : v.restock.dailyXrp === null ? "off (SEAL_AUTOBUY isn't on)" : "off (kill switch)"} · spent in the last day {xrp(v.restock.spentDayXrp)} of {xrp(v.restock.dailyXrp)} XRP · up to {xrp(v.restock.perNftXrp)} XRP an NFT · vault can spend {xrp(v.restock.vaultSpendableXrp)} XRP · treasury spare {xrp(v.restock.treasurySpareXrp)} XRP
          </p>
          {v.restock.dailyXrp !== null ? <AutobuySwitch off={!!v.restock.off} /> : null}
          <div className="adminscroll">
            <table className="admintable">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Band</th>
                  <th>Have</th>
                  <th>Target</th>
                  <th>Short</th>
                </tr>
              </thead>
              <tbody>
                {v.restock.gaps.map((g) => (
                  <tr key={`${g.price}-${g.band}`}>
                    <td>${g.price}</td>
                    <td>{g.bandName}</td>
                    <td>{g.have}</td>
                    <td>{g.target}</td>
                    <td>{g.short}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {v.restock.holds.length ? <p className="fine">Held out, waiting on you: {v.restock.holds.map((h) => `${h.nftId.slice(-8)} (${h.reason})`).join(", ")}. scripts/rip-admin.mjs release-held puts one back.</p> : null}
          {v.restock.buys.length ? (
            <div className="adminscroll">
              <table className="admintable">
                <thead>
                  <tr>
                    <th>Buy</th>
                    <th>NFT</th>
                    <th>Paid XRP</th>
                    <th>Mark XRP</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {v.restock.buys.map((b) => (
                    <tr key={b.id}>
                      <td>
                        ${b.price} {b.band}
                      </td>
                      <td>{b.name}</td>
                      <td>{xrp(b.offeredXrp)}</td>
                      <td>{xrp(b.markXrp)}</td>
                      <td>
                        {b.status}
                        {b.why ? ` (${b.why})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
      <section className="s">
        <h2>Token prizes</h2>
        <p className="fine">
          XRP: drawn {v.tokenFloat.xrp.drawn} · stashed {v.tokenFloat.xrp.stashed} · redeeming {v.tokenFloat.xrp.redeeming} · redeemed {v.tokenFloat.xrp.redeemed} · owed {xrp(v.tokenFloat.xrp.owedXrp)} XRP
        </p>
        {v.tokenFloat.seal ? (
          <p className="fine">
            SEAL {v.tokenFloat.seal.on ? "on" : "off, its rows pay XRP"}: drawn {v.tokenFloat.seal.drawn} · stashed {v.tokenFloat.seal.stashed} · redeeming {v.tokenFloat.seal.redeeming} · redeemed {v.tokenFloat.seal.redeemed} · sold {v.tokenFloat.seal.sold}
            <br />
            <span className="admincode">
              {v.tokenFloat.seal.currency} · {v.tokenFloat.seal.issuer}
            </span>
          </p>
        ) : null}
        {v.sealFloat ? (
          <div className="stats">
            <div className="stat">
              <span className="lb">SEAL float{v.sealFloat.low ? " · LOW" : ""}</span>
              <strong>{v.sealFloat.freeXrp === null ? "No live price" : `${xrp(v.sealFloat.freeXrp)} XRP free`}</strong>
              <p className="fine">
                Held {Number(v.sealFloat.held).toLocaleString("en-US")} · owed {Number(v.sealFloat.owed).toLocaleString("en-US")} · start {v.sealFloat.startXrp} · alert under {v.sealFloat.lowXrp} · refill {v.sealFloat.refillXrp} XRP at a time
              </p>
              {v.sealFloat.priceCode ? <p className="fine">Price paused: {v.sealFloat.priceCode}</p> : null}
              {v.sealFloat.pauses.length ? <p className="fine">Paused packs: {v.sealFloat.pauses.map((p) => `$${p}`).join(", ")}. Run deploy/09-seal-float.mjs.</p> : null}
            </div>
          </div>
        ) : null}
        {v.prizeStuck.length ? (
          <div className="adminscroll">
            <table className="admintable">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Prize</th>
                  <th>State</th>
                  <th>Note</th>
                  <th>Wallet</th>
                </tr>
              </thead>
              <tbody>
                {v.prizeStuck.map((p) => (
                  <tr key={p.id}>
                    <td className="admincode">{p.id.slice(0, 10)}</td>
                    <td>
                      {p.amount} {p.token}
                    </td>
                    <td>{p.pull}</td>
                    <td>{p.note ?? ""}</td>
                    <td className="admincode">{p.address}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="s">
        <h2>Stuck</h2>
        <p className="fine">Paid and not drawn {v.stuck.paidNotDrawn.length} · selling {v.stuck.selling.length} · pending transactions {v.stuck.pendingTx.length} · open offers {v.stuck.openOffers.length}</p>
        {v.stuck.refunds.length ? (
          <div className="adminscroll">
            <table className="admintable">
              <thead>
                <tr>
                  <th>Refund</th>
                  <th>To</th>
                  <th>XRP</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {v.stuck.refunds.map((x) => (
                  <tr key={x.id}>
                    <td className="admincode">{x.id.slice(0, 24)}</td>
                    <td className="admincode">{x.to}</td>
                    <td>{xrp(Number(x.drops) / 1e6)}</td>
                    <td>{x.reason}</td>
                    <td>
                      {x.status} {x.result ?? ""}
                    </td>
                    <td>{x.status === "stuck" ? <AdminActions action="retry-refund" id={x.id} label="Retry" /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No refunds waiting.</div>
        )}
      </section>
      <section className="s">
        <h2>Card line</h2>
        <p className="fine">
          Opening {v.cardLine.open.length} · stashed {v.cardLine.stashedUnminted} · live mirrors {v.cardLine.mirrorsLive} · sold {v.cardLine.sold} · shipped {v.cardLine.shipped}
          {v.cardLine.custody ? ` · custody ${Number(v.cardLine.custody.usdcMicro) / 1e6} USDC, ${v.cardLine.custody.lamports === null ? "SOL unknown" : `${Number(v.cardLine.custody.lamports) / 1e9} SOL`}` : " · custody unreadable"}
        </p>
        {v.cardLine.review.map((c) => (
          <div className="fairrow" key={c.id}>
            <span className="lb">Review: {c.reason}</span>
            <span className="admincode">
              {c.id} · source {c.source} · memo {c.memo ?? "none"} · signature {c.signature ?? "none"} · payment {c.txHash ?? "none"}
            </span>
            <div className="adminform">
              <AdminActions action="resolve-card" id={c.id} label="Resume" extra={{ action: "resume" }} />
              <AdminActions action="resolve-card" id={c.id} label="Refund whole" extra={{ action: "refund" }} />
              {c.reason === "stalled_at_exit_source" ? <AdminActions action="resolve-card" id={c.id} label="Back to stash" extra={{ action: "restash" }} /> : null}
            </div>
          </div>
        ))}
        {shipQueue.map((s) => (
          <div className="fairrow" key={s.id}>
            <span className="lb">Ship: {s.name}</span>
            <span className="admincode">
              {s.mint} · holder {s.by}
            </span>
            <span className="admincode">{s.address ?? "address missing"}</span>
            <ShipActions id={s.id} />
          </div>
        ))}
      </section>
      <section className="s">
        <h2>Recent draws</h2>
        <div className="adminscroll">
          <table className="admintable">
            <thead>
              <tr>
                <th>Order</th>
                <th>Pack</th>
                <th>Band</th>
                <th>Paid XRP</th>
                <th>Cost XRP</th>
                <th>State</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {v.recentDraws.map((d) => (
                <tr key={d.id}>
                  <td className="admincode">{d.id.slice(0, 10)}</td>
                  <td>${d.price}</td>
                  <td>{d.band}</td>
                  <td>{xrp(d.paidXrp)}</td>
                  <td>{xrp(d.costXrp)}</td>
                  <td>{d.pull}</td>
                  <td className="admincode">{d.address}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
