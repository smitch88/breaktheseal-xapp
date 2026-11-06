import { cardSellUntil } from "../sellback.ts";
import { NFT_PRICES, type NftPrice } from "../../config/nft-packs.ts";
import { BANDS, ITEM_SCALE, itemWeights, stockCovers, tokenOnlyBand } from "./draw.ts";
import type { Rails } from "./factory.ts";
import { holdsFor, seasonToken, sellableStock, stockOf, tokenOwed, treasuryOwed, type BundleState, type CardState, type OrderState, type RefundState, type RipState } from "./state.ts";
import { SEAL_TOKEN, XRP_TOKEN, prizeName } from "./tokens.ts";
import { sellQuote } from "./engine.ts";
import { prizeImg, prizeTitle } from "./nft-art.ts";

/** This NFT already has a lot a new listing would collide with: it's in a pool, or a player drew it. One taken out of a pool is free to go back. */
export function inPoolAlready(s: RipState, nftId: string): boolean {
  const lot = s.lots.get(s.nftLot.get(nftId) ?? "");
  return !!lot && lot.status !== "removed" && !(lot.status === "available" && lot.removeLedger !== null);
}

/** Public pack status. Rarity rates and whether a pack can be opened, never what anything cost. */
/** A tier for the shelf. With no ledger reading its stock can't be known, so it reads closed. `closed` is what a checkout would refuse right now. */
export function tierView(s: RipState, price: NftPrice, ledger: number | null, closed?: ReadonlySet<NftPrice>) {
  const season = s.seasons.get(s.activeSeason.get(price) ?? "");
  const stock = ledger === null ? [] : sellableStock(s, price, ledger);
  const holds = holdsFor(s, price);
  // A band that pays only tokens never reaches its NFTs, so anything left in one isn't a prize this season.
  const table = season?.prizeTable ?? [];
  const collections = new Set([...s.lots.values()].filter((l) => l.price === price && l.status === "available" && l.removeLedger === null && !tokenOnlyBand(table, l.band)).map((l) => l.collection)).size;
  return {
    price,
    xrp: season ? Number(season.priceDrops) / 1e6 : null,
    open: ledger !== null && !!season?.live && !closed?.has(price) && stockCovers(stock, holds, season.bandBps, season.prizeTable, season.emptyBand),
    nfts: stock.reduce((a, n, band) => a + (tokenOnlyBand(table, band) ? 0 : n), 0),
    /** What a pull on this season can pay besides an NFT, and its committed rates, from the ledger's season and not the plan. */
    prizeTokens: [...new Set(table.map((r) => r.token))],
    bandBps: season?.bandBps ?? null,
    collections,
    season: season?.season ?? null,
    commit: season?.commit ?? null,
    commitTx: season?.anchorTx ?? null,
  };
}

/** The checkouts this wallet can still pay: exactly the orders a repeat tap on Pay gets handed back, closed pack or not. */
export function openCheckouts(s: RipState, address: string, validated: number) {
  // A multi order is paid as one, through its own invoice. Its children can't be paid, so they aren't checkouts of their own.
  const live = (o: { address: string; status: string; lastLedger: number; bundle?: string }) => o.address === address && o.status === "quoted" && !o.bundle && o.lastLedger > validated + 20;
  const bundles = [...s.bundles.values()].filter((b) => b.address === address && b.status === "quoted" && b.lastLedger > validated + 5).map((b) => ({ id: b.id, qty: b.qty, ...(b.price !== null ? { price: b.price as number } : {}), ...(b.code !== null ? { code: b.code } : {}) }));
  return { nft: [...s.orders.values()].filter(live).map((o) => o.price as number), cards: [...s.cards.values()].filter(live).map((c) => c.code), ...(bundles.length ? { bundles } : {}) };
}

/**
 * What this pack's live season can pay, band by band: its committed rates and token rows, and the NFTs a pull could land on right now.
 * All of it is already in the public log, so it says nothing about the next draw: the seed stays hidden, the pick depends on a ledger that hasn't closed.
 * No cost, and nothing that adds up the odds and the prizes. Null if no season is live.
 */
export function poolView(s: RipState, price: NftPrice) {
  const season = s.seasons.get(s.activeSeason.get(price) ?? "");
  if (!season?.live) return null;
  const network = s.genesis?.networkId;
  const leaving = new Set<string>();
  for (const p of s.poolChanges.values()) if (!p.anchored) p.removes.forEach((id) => leaving.add(id));
  const bands = BANDS.map((tier, band) => {
    const pct = season.bandBps[band] / 100;
    const rows = season.prizeTable.filter((r) => r.band === band);
    // A row's XRP and SEAL halves are one prize to a player: this value, in either.
    const values = [...new Set(rows.map((r) => r.valueDrops))];
    const rowsBps = rows.reduce((a, r) => a + r.bps, 0);
    const lots = tokenOnlyBand(season.prizeTable, band)
      ? []
      : [...s.lots.values()].filter((l) => l.price === price && l.band === band && l.status === "available" && l.removeLedger === null && !leaving.has(l.lot)).sort((a, b) => (a.nftId < b.nftId ? -1 : 1));
    // Per-item odds: each NFT its own share, the ladder (or, with no rows, the pull's XRP back) what they leave.
    const weights = season.nftOdds ? itemWeights(season.nftOdds, season.prizeTable, band, lots.map((l) => l.markDrops), season.sellBps, season.priceDrops) : null;
    const left = weights ? 1 - weights.reduce((a, w) => a + w, 0) / ITEM_SCALE : 0;
    const nfts = lots.map((l, i) => ({ id: l.nftId, name: prizeTitle(l, network), collection: l.collection, img: prizeImg(l, network), markXrp: Number(l.markDrops) / 1e6, ...(weights ? { pct: (pct * weights[i]) / ITEM_SCALE } : {}) }));
    // With its NFTs gone, a band whose season falls back to its rows pays them on every pull it gets: the odds say so.
    const onRows = !nfts.length && season.emptyBand === "rows" && rowsBps > 0;
    const prizes = values
      .map((value) => {
        const same = rows.filter((r) => r.valueDrops === value);
        const bps = same.reduce((a, r) => a + r.bps, 0);
        return { xrp: Number(value) / 1e6, tokens: [...new Set(same.map((r) => r.token))], pct: weights ? (pct * left * bps) / rowsBps : onRows ? (pct * bps) / rowsBps : (pct * bps) / 10_000 };
      })
      .sort((a, b) => a.xrp - b.xrp);
    if (weights) {
      const nftPct = nfts.reduce((a, n) => a + (n.pct ?? 0), 0);
      return { tier, pct, prizes, nftPct, nfts, ...(rowsBps ? {} : { refundPct: pct * left }) };
    }
    const nftBps = onRows ? 0 : Math.max(0, 10_000 - rowsBps);
    return { tier, pct, prizes, nftPct: (pct * nftBps) / 10_000, nfts };
  });
  return { price, season: season.season, commit: season.commit, bands };
}

/** A pull from a multi order shows its refund without the wallet it went to. A single order's page has always shown it, and stays as it is. */
const anonymous = (o: OrderState, r: RefundState | null) => (r && o.bundle ? { ...r, to: "" } : r);

export function publicOrder(s: RipState, o: OrderState) {
  const lot = o.lot ? s.lots.get(o.lot) : null;
  const season = s.seasons.get(o.season);
  return {
    id: o.id,
    price: o.price,
    xrp: Number(o.drops) / 1e6,
    status: o.status,
    pull: o.pull,
    tier: o.band !== null ? BANDS[o.band] : null,
    nft: lot ? { id: lot.nftId, name: prizeTitle(lot, s.genesis?.networkId), collection: lot.collection, img: prizeImg(lot, s.genesis?.networkId), markXrp: Number(lot.markDrops) / 1e6 } : null,
    prize: o.prize
      ? { token: o.prize.token, name: prizeName(o.prize.token, o.prize.amount), amount: o.prize.amount, valueXrp: Number(o.prize.valueDrops) / 1e6, redeemTx: o.prize.redeemTx, note: o.prize.note, owed: o.prize.owed, issuer: seasonToken(s, o.season, o.prize.token)?.issuer ?? null }
      : null,
    sellXrp: o.prize ? (o.sellDrops ? Number(o.sellDrops) / 1e6 : null) : lot && season ? Number(sellQuote(lot.markDrops, season.sellBps)) / 1e6 : null,
    paymentTx: o.txHash,
    sellTx: o.sellTx,
    offerId: o.offerId,
    claimTx: o.claimTx,
    refund: anonymous(o, o.refundId ? s.refunds.get(o.refundId) ?? null : [...s.refunds.values()].find((r) => r.order === o.id) ?? null),
    lastLedger: o.lastLedger,
    index: o.index,
    season: o.season,
    ...(o.bundle ? { bundle: o.bundle } : {}),
    ...(o.payout ? { payout: payoutSummary(s, o.payout) } : o.failedPayout && o.pull === "stashed" ? { payout: payoutSummary(s, o.failedPayout) } : {}),
  };
}

/** One payment that pays several items, as a page shows it. Each item has its own price, and they all point at this transaction. */
function payoutSummary(s: RipState, id: string) {
  const p = s.payouts.get(id);
  return p ? { id: p.id, status: p.status, count: p.items.length, totalXrp: Number(p.total) / 1e6, txHash: p.status === "done" ? p.txHash : null } : null;
}

/** A card pull for its owner's pages. Insured value, grade and the sell quote are all shown on the demo's cards today. */
export function publicCard(c: CardState) {
  return {
    id: c.id,
    kind: "card" as const,
    code: c.code,
    packName: c.packName,
    usd: c.usd,
    xrp: Number(c.drops) / 1e6,
    status: c.status,
    hold: c.hold,
    /** What a player reads while a pack waits on money moving behind the scenes. */
    stage: c.status === "funding" ? "Your pack is on its way" : c.hold === "selling" ? "Your XRP is on its way" : null,
    // The page says where a card comes from without naming the vault: the log keeps its own label, this answer says "vault".
    source: c.gateway === "collector-crypt" ? "vault" : c.gateway,
    card: c.mint ? { mint: c.mint, name: c.name, img: c.img, grade: c.grade, insuredUsd: Number(c.insuredMicro) / 1e6, rarity: c.rarity, proof: c.proof, proofSlot: c.proofSlot, proofAt: c.proofAt ?? null } : null,
    // The pack's payment on Solana, already on the public log. A simulated source has no real transaction to point at.
    sourceTx: c.gateway === "collector-crypt" ? c.signature : null,
    mirror: c.mirror ? { nftId: c.mirror.nftId, offerId: c.mirror.offerId, accepted: c.mirror.accepted, mintTx: c.mirror.mintTx, acceptTx: c.mirror.acceptTx ?? null } : null,
    exit: c.exit ? { kind: c.exit.kind, drops: c.exit.drops } : null,
    sellUntil: cardSellUntil(c),
    sellTx: c.sellTx,
    shipRef: c.shipRef,
    paymentTx: c.txHash,
    lastLedger: c.lastLedger,
    ...(c.bundle ? { bundle: c.bundle } : {}),
  };
}

/** A multi order and everything in it. It says what a page needs to show partial outcomes, and nothing about the wallet that paid. */
export function publicBundle(s: RipState, b: BundleState) {
  const refund = [...s.refunds.values()].find((r) => r.order === b.id);
  return {
    id: b.id,
    kind: b.kind,
    qty: b.qty,
    price: b.price,
    code: b.code,
    name: b.name,
    usd: b.usd,
    xrp: Number(b.drops) / 1e6,
    eachXrp: Number(b.each) / 1e6,
    status: b.status,
    lastLedger: b.lastLedger,
    paymentTx: b.txHash,
    refund: refund ? { reason: refund.reason, status: refund.status, txHash: refund.txHash } : null,
    orders: b.kind === "nft" ? b.children.flatMap((id) => {
      const o = s.orders.get(id);
      if (!o) return [];
      const { refund: r, ...rest } = publicOrder(s, o);
      return [{ ...rest, refund: r ? { reason: r.reason, status: r.status, txHash: r.txHash } : null }];
    }) : [],
    cards: b.kind === "card" ? b.children.flatMap((id) => {
      const c = s.cards.get(id);
      if (!c) return [];
      const r = c.refundId ? s.refunds.get(c.refundId) : null;
      return [{ ...publicCard(c), refund: r ? { reason: r.reason, status: r.status, txHash: r.txHash } : null }];
    }) : [],
  };
}

/** Internal only: everything an operator needs, including cost, which never appears on a player's page. */
export async function adminView(rails: Rails) {
  const { engine } = rails;
  await engine.sync();
  const s = engine.state;
  const chain = engine.chain;
  const validated = await chain.validatedLedger();
  const [treasury, vault] = await Promise.all([chain.account(rails.treasury), chain.account(rails.vault)]);
  const tiers = NFT_PRICES.map((price) => {
    const stock = stockOf(s, price, validated);
    const lots = [...s.lots.values()].filter((l) => l.price === price);
    const available = lots.filter((l) => l.status === "available");
    const byBand = BANDS.map((name, b) => {
      const band = available.filter((l) => l.band === b);
      const col = new Map<string, number>();
      band.forEach((l) => col.set(l.collection, (col.get(l.collection) ?? 0) + 1));
      return { name, stock: stock[b], collections: col.size, topShare: band.length ? Math.max(...col.values()) / band.length : 0, costXrp: band.reduce((a, l) => a + Number(l.costDrops) / 1e6, 0), markXrp: band.reduce((a, l) => a + Number(l.markDrops) / 1e6, 0) };
    });
    const season = s.seasons.get(s.activeSeason.get(price) ?? "");
    const orders = [...s.orders.values()].filter((o) => o.price === price);
    return { price, season: season?.season ?? null, live: !!season?.live, priceXrp: season ? Number(season.priceDrops) / 1e6 : null, pullsDrawn: orders.filter((o) => o.status === "drawn").length, holds: holdsFor(s, price), bands: byBand };
  });
  const orders = [...s.orders.values()];
  const stashed = orders.filter((o) => o.pull === "stashed" || o.pull === "offered" || o.pull === "offering" || o.pull === "cancelling");
  const stuck = {
    refunds: [...s.refunds.values()].filter((r) => r.status === "stuck" || r.status === "due"),
    paidNotDrawn: orders.filter((o) => o.status === "paid" && validated > (o.entropyLedger ?? 0) + 10).map((o) => ({ id: o.id, ledger: o.ledger, entropyLedger: o.entropyLedger })),
    selling: orders.filter((o) => o.pull === "selling").map((o) => ({ id: o.id, drops: o.sellDrops })),
    pendingTx: [...s.intents.values()].map((i) => ({ kind: i.kind, ref: i.ref, hash: i.hash, lastLedger: i.lastLedger })),
    openOffers: orders.filter((o) => o.pull === "offered").map((o) => ({ id: o.id, offerId: o.offerId })),
    ...([...s.payouts.values()].some((p) => p.status === "due" || p.status === "sent") ? { payouts: [...s.payouts.values()].filter((p) => p.status === "due" || p.status === "sent").map((p) => ({ id: p.id, status: p.status, count: p.items.length, totalXrp: Number(p.total) / 1e6 })) } : {}),
  };
  const cards = [...s.cards.values()];
  const cardLine = {
    open: cards.filter((c) => ["paid", "funding", "generating", "generated", "signed", "source_paid", "opened"].includes(c.status)).map((c) => ({ id: c.id, status: c.status, code: c.code })),
    review: cards.filter((c) => c.status === "review").map((c) => ({ id: c.id, reason: c.review, memo: c.memo, signature: c.signature, txHash: c.txHash, source: c.gateway })),
    // Burned or on the way to the provider and not yet paid: a person should look if these stay here.
    exiting: cards.filter((c) => c.hold === "exit_burn" || c.hold === "exit_source" || c.hold === "selling").map((c) => ({ id: c.id, hold: c.hold, kind: c.exit?.kind, drops: c.exit?.drops, by: c.exit?.by })),
    shipQueue: cards.filter((c) => c.hold === "ship_queue").map((c) => ({ id: c.id, mint: c.mint, name: c.name, by: c.exit?.by, addressHash: c.exit?.addressHash })),
    mirrorsLive: cards.filter((c) => c.mirror).length,
    stashedUnminted: cards.filter((c) => c.hold === "stashed").length,
    sold: cards.filter((c) => c.hold === "sold").length,
    shipped: cards.filter((c) => c.hold === "shipped").length,
    custody: await engine.custodyStatus().catch(() => null),
    swaps: [...s.swaps.values()].filter((x) => !["landed", "dead", "refunded"].includes(x.status)).map((x) => ({ id: x.id, dir: x.dir, purpose: x.purpose, status: x.status, card: x.card, requestId: x.requestId, inAmount: x.inAmount, outMin: x.outMin, openedAt: x.openedAt })),
    /** What's on the wrong side: XRP that bought packs out of custody, and USDC from sales the treasury paid. */
    owedToCustodyXrp: [...s.accruals.values()].filter((a) => a.dir === "to_custody" && a.status !== "done" && a.status !== "void").reduce((t, a) => t + Number(a.amount) / 1e6, 0),
    owedToTreasuryUsd: [...s.accruals.values()].filter((a) => a.dir === "to_treasury" && a.status !== "done" && a.status !== "void").reduce((t, a) => t + Number(a.amount) / 1e6, 0),
  };
  const liability = stashed.reduce((sum, o) => {
    const lot = o.lot ? s.lots.get(o.lot) : null;
    const season = s.seasons.get(o.season);
    return sum + (lot && season ? sellQuote(lot.markDrops, season.sellBps) : 0n);
  }, 0n);
  const prizes = orders.filter((o) => o.prize);
  const prizeLine = (token: string) => {
    const mine = prizes.filter((o) => o.prize?.token === token);
    const count = (p: string) => mine.filter((o) => o.pull === p).length;
    return { token, drawn: mine.length, stashed: count("stashed"), redeeming: count("redeeming"), redeemed: count("redeemed"), sold: count("sold") + count("selling") };
  };
  const sealSpec = [...s.seasons.values()].flatMap((x) => x.tokens).find((t) => t.id === SEAL_TOKEN) ?? rails.sealToken;
  const sealLine = sealSpec ? await chain.trustLine?.(rails.treasury, sealSpec).catch(() => null) : null;
  const tokenFloat = {
    xrp: { ...prizeLine(XRP_TOKEN), owedXrp: prizes.reduce((a, o) => a + (o.prize?.token === XRP_TOKEN && (o.pull === "stashed" || o.pull === "redeeming") ? Number(o.prize.amount) / 1e6 : 0), 0) },
    seal: sealSpec ? { ...prizeLine(SEAL_TOKEN), on: !!rails.sealToken, issuer: sealSpec.issuer, currency: sealSpec.currency, owed: tokenOwed(s, SEAL_TOKEN).toString(), held: sealLine ? (BigInt(sealLine.balanceMicro) / 1_000_000n).toString() : null } : null,
  };
  const sealFloat = await engine.sealFloatStatus().catch(() => null);
  const restock = await engine.restockStatus().catch(() => null);
  const prizeStuck = prizes.filter((o) => o.pull === "redeeming" || o.prize?.note).map((o) => ({ id: o.id, token: o.prize?.token, amount: o.prize?.amount, pull: o.pull, note: o.prize?.note ?? (o.prize?.owed && o.pull === "redeeming" ? "owed: waiting on a top-up" : null), address: o.address }));
  const recentDraws = orders
    .filter((o) => o.status === "drawn")
    .slice(-30)
    .reverse()
    .map((o) => ({ id: o.id, price: o.price, address: o.address, band: BANDS[o.band as number], lot: o.prize ? prizeName(o.prize.token, o.prize.amount) : o.lot, pull: o.pull, costXrp: o.prize ? Number(o.prize.valueDrops) / 1e6 : Number(s.lots.get(o.lot as string)?.costDrops ?? 0) / 1e6, paidXrp: Number(o.drops) / 1e6 }));
  return {
    mode: rails.mode,
    validated,
    head: s.head,
    treasury: { address: rails.treasury, balanceXrp: treasury ? Number(treasury.balance) / 1e6 : null, ownerCount: treasury?.ownerCount ?? 0, owedXrp: Number(treasuryOwed(s)) / 1e6, stashSellLiabilityXrp: Number(liability) / 1e6 },
    vault: { address: rails.vault, balanceXrp: vault ? Number(vault.balance) / 1e6 : null, ownerCount: vault?.ownerCount ?? 0 },
    tiers,
    tokenFloat,
    sealFloat,
    prizeStuck,
    // Never public: this names what the vault means to buy and at what limits.
    restock: restock && {
      on: restock.on,
      off: restock.off,
      dailyXrp: restock.limits ? Number(restock.limits.dailyDrops) / 1e6 : null,
      perNftXrp: restock.limits ? Number(restock.limits.perNftDrops) / 1e6 : null,
      spentDayXrp: Number(restock.spentDayDrops) / 1e6,
      vaultSpendableXrp: Number(restock.vaultSpendableDrops) / 1e6,
      treasurySpareXrp: Number(restock.treasurySpareDrops) / 1e6,
      gaps: restock.gaps,
      holds: restock.holds,
      buys: restock.buys.map((b) => ({ id: b.id, nftId: b.nftId, price: b.price, band: b.band, name: b.name, status: b.status, why: b.why, route: b.route, offeredXrp: Number(b.offeredDrops) / 1e6, markXrp: Number(b.markDrops) / 1e6, txHash: b.txHash, at: b.at })),
    },
    cardLine,
    recentDraws,
    stuck,
  };
}
