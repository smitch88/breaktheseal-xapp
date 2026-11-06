"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BANDS } from "@/lib/rip/draw";
import { prizeName } from "@/lib/rip/tokens";
import { replayLog } from "@/lib/rip/verify";
import type { RipEvent } from "@/lib/rip/types";
import { api, accountUrl, txUrl } from "@/lib/live/client";
import { usePoll, useRipConfig } from "@/lib/live/hooks";
import { useRails } from "../Providers.tsx";

type LogBody = { network: string; treasury: string; vault: string; events: RipEvent[] };

const short = (h: string, n = 12) => (h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-6)}` : h);

/** Plain words first, then the record itself. The Verify button replays every pull in this browser, trusting nothing. */
export function FairView() {
  const { mode } = useRails();
  const live = mode !== "demo";
  const config = useRipConfig(live, 30000);
  const [log, setLog] = useState<LogBody | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  usePoll(
    async () => {
      const r = await api<LogBody>("/api/rip/log");
      if (r.ok) setLog(r.body);
    },
    30000,
    !live,
  );
  // A prize's page links to its own pull here, however old it is, so that one always shows, and the page goes to it once the log is in.
  const [linked, setLinked] = useState("");
  useEffect(() => setLinked(window.location.hash.slice(1)), []);
  const pulls = useMemo(() => {
    const all = (log?.events ?? []).filter((e): e is Extract<RipEvent, { type: "pull_drawn" | "pull_prize_drawn" }> => e.type === "pull_drawn" || e.type === "pull_prize_drawn");
    return all.filter((p, i) => i >= all.length - 30 || `pull-${p.data.season}-${p.data.index}` === linked).reverse();
  }, [log, linked]);
  useEffect(() => {
    if (linked && log) document.getElementById(linked)?.scrollIntoView({ block: "center" });
  }, [linked, log]);
  const verify = async () => {
    setResult(null);
    const r = await api<LogBody>("/api/rip/log");
    if (!r.ok) return setResult({ ok: false, text: "We couldn't fetch the record just now." });
    setLog(r.body);
    const out = replayLog(r.body.events);
    setResult(out.ok ? { ok: true, text: `Verified: ${out.pulls} ${out.pulls === 1 ? "pull" : "pulls"} and ${r.body.events.length} records all replay from the published data, right here in your browser.` } : { ok: false, text: `Didn't verify, at record ${out.at}: ${out.why}.` });
  };
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          How the draw works<em>.</em>
        </h1>
      </div>
      <div className="legal">
        <section>
          <h2>Before any pack sells</h2>
          <p>Each pack&apos;s season starts with a hash chain of secret seeds. Only the end of the chain, the commitment, goes on the XRP Ledger, in a public memo, before the first sale. It locks in the seeds without showing&nbsp;them.</p>
        </section>
        <section>
          <h2>Your pull</h2>
          <p>You pay on the ledger. That fixes your payment&apos;s hash and your place in line. Then we wait for a later ledger to close, whose hash didn&apos;t exist when you signed. Your pull comes from the season&apos;s next seed, your payment and that ledger hash, together, so neither side can choose the&nbsp;result.</p>
        </section>
        <section>
          <h2>Band first, then one NFT</h2>
          <p>The pull lands on a band at that pack&apos;s published <Link href="/rates">rarity rates</Link>. Then it picks one NFT, fairly, from everything in that band&apos;s pool, across collections. On a season with each NFT at its own odds, one more roll picks an NFT by its own share of the band, a dearer one rarer in proportion, and lands on the band&apos;s XRP or SEAL prizes for whatever share its NFTs don&apos;t take. Each NFT&apos;s odds are on the pack&apos;s&nbsp;page.</p>
        </section>
        <section>
          <h2>XRP and SEAL prizes</h2>
          <p>Some bands also pay XRP or SEAL. After the band, one more roll from the same pull says whether this one does, at a share fixed when the season opened, or, on a season with each NFT at its own odds, at whatever share the band&apos;s NFTs don&apos;t take right now. An XRP prize is worth its face. A SEAL prize is a fixed amount, set from the XRP/SEAL pool on the ledger at your pull&apos;s own ledger, so anyone can read it back. If that price moved too fast or can&apos;t be read, your prize pays its value in XRP instead. If our wallet is short of XRP when you win, the prize is still yours: it&apos;s owed to you, and it pays as soon as we top&nbsp;up.</p>
        </section>
        <section>
          <h2>No deck to count</h2>
          <p>Every pull rolls the same rates on its own, so there&apos;s no deck to run down and no better moment to buy. Restocks are posted to the ledger first and only reach pulls paid after that, so a pool can&apos;t be changed under a pull. If a band runs out, the pack pauses for a restock instead of changing its rates. On a season that says so when it opens, a band with no NFTs left pays one of its own XRP or SEAL prizes instead, by their published shares, so the pack keeps selling while it&nbsp;restocks.</p>
        </section>
        {config?.multi ? (
          <section>
            <h2>Several packs at once</h2>
            <p>One payment can cover several packs. Each pack is still its own pull: it takes the next seed in line, so the same payment and ledger hash give each one a different result. Each is drawn in turn from what&apos;s left, at the same rates, and each has its own line in the record below. Buying more doesn&apos;t change anyone&apos;s&nbsp;odds.</p>
          </section>
        ) : null}
        <section>
          <h2>Check it yourself</h2>
          <p>After each pull, its seed is published. Anyone can hash it back to the commitment and recompute the band and the NFT from the public&nbsp;record.</p>
        </section>
      </div>
      {!live ? <p className="freshness">This isn&apos;t running yet. This site is still a demo, so no seasons are open and there&apos;s nothing to verify. Demo pulls roll the same rates in your browser and are labeled&nbsp;examples.</p> : null}
      {live ? (
        <>
          {mode === "testnet" ? <p className="freshness">These are testnet records: play XRP and test NFTs.</p> : null}
          <section className="s">
            <h2>Open seasons</h2>
            <div className="fairlist">
              {(config?.tiers ?? [])
                .filter((t) => t.season)
                .map((t) => (
                  <div className="fairrow" key={t.season}>
                    <span className="lb">
                      ${t.price} pack · season {t.season}
                    </span>
                    <code>{t.commit}</code>
                    {t.commitTx ? (
                      <a className="fine" href={txUrl(mode, t.commitTx)} target="_blank" rel="noopener">
                        Commitment on the ledger
                      </a>
                    ) : (
                      <span className="fine">Going on the ledger now</span>
                    )}
                  </div>
                ))}
              {config && !config.tiers.some((t) => t.season) ? <div className="empty">No seasons are open yet.</div> : null}
            </div>
            {config?.vault ? (
              <p className="fine">
                <a href={accountUrl(mode, config.vault)} target="_blank" rel="noopener">
                  See the wallet that holds the prizes
                </a>
              </p>
            ) : null}
          </section>
          <section className="s">
            <h2>Verify every pull</h2>
            <div className="acts">
              <button className="btn" onClick={() => void verify()}>
                Verify now
              </button>
              <a className="btn ol" href="/api/rip/log" target="_blank" rel="noopener">
                Download the record
              </a>
            </div>
            {result ? <p className={result.ok ? "note fairok" : "note fairbad"}>{result.text}</p> : null}
          </section>
          <section className="s">
            <h2>Recent pulls</h2>
            <div className="fairlist">
              {pulls.map((p) => (
                <div className={`fairrow${`pull-${p.data.season}-${p.data.index}` === linked ? " on" : ""}`} id={`pull-${p.data.season}-${p.data.index}`} key={p.seq}>
                  <span className="lb">
                    Season {p.data.season} · pull {p.data.index + 1} · {BANDS[p.data.band]}
                    {p.type === "pull_drawn" ? ` · ${p.data.pick + 1} of ${p.data.poolSize}` : ` · ${prizeName(p.data.token, p.data.amount)}`}
                  </span>
                  <span className="fine">Seed</span>
                  <code>{short(p.data.seed, 20)}</code>
                  {p.type === "pull_drawn" ? (
                    <>
                      <span className="fine">NFT</span>
                      <code>{short(p.data.nftId, 20)}</code>
                    </>
                  ) : p.data.reads ? (
                    <>
                      <span className="fine">Pool at ledger {p.data.reads.now.ledger}</span>
                      <code>{p.data.reads.now.xrpDrops} drops / {p.data.reads.now.tokenMicro} millionths</code>
                    </>
                  ) : null}
                  <span className="fine">
                    <a href={txUrl(mode, p.data.txHash)} target="_blank" rel="noopener">
                      Payment
                    </a>{" "}
                    · ledger {p.data.entropyLedger} hash {short(p.data.ledgerHash, 8)}
                  </span>
                </div>
              ))}
              {log && !pulls.length ? <div className="empty">No pulls yet.</div> : null}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
