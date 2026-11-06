import { DUST_DROPS, ENTROPY_DELAY, bandOf, digestOf, fallbackRowOf, invoiceOf, itemPick, itemWeights, pickOf, prizeRowOf, seasonTermsHash, seedMatches } from "./draw.ts";
import { TOKEN_POLICY, XRP_TOKEN, checkPool, prizeTooBig, strikeAmount } from "./tokens.ts";
import { apply, emptyState, poolAt, GENESIS_HASH, type RipState } from "./state.ts";
import { canonical, poolRoot, poolRootV2, stripPrivate } from "./log.ts";
import { sha256Hex } from "./draw.ts";
import { namesShipment } from "./ship.ts";
import { depositRefusal } from "./relay.ts";
import type { Chain, RipEvent, StrikeReads } from "./types.ts";

/** The most packs one payment can cover, as the log must show it. Kept here too, so a replay in a browser needs nothing from the server's settings. */
const MAX_BUNDLE = 20;
/** What a sold NFT is worth at sale, as engine.ts quotes it: a share of its mark, rounded down to whole drops. */
const sellQuoteOf = (markDrops: string, sellBps: number) => (BigInt(markDrops) * BigInt(sellBps)) / 10_000n;

/** Why a token row paid in XRP, checked against the reads it published. Null if the reads bear it out. */
function xrpInsteadWhy(code: string, reads: StrikeReads | null, valueDrops: string): string | null {
  if (!reads) return code === "price_unreadable" || code === "token_off" ? null : "paid in XRP with no reads to show why";
  const check = checkPool(reads.now, reads.prior);
  if (!check.ok) return check.code === code ? null : "paid in XRP for a reason its reads don't show";
  if (code === "prize_too_big") return prizeTooBig(valueDrops, reads.now.xrpDrops) ? null : "paid in XRP over a price that was fine";
  return code === "float_short" || code === "strike_empty" ? null : "paid in XRP over a price that was fine";
}

export type ReplayResult = { readonly ok: true; readonly pulls: number; readonly state: RipState } | { readonly ok: false; readonly at: number; readonly why: string };

/**
 * Check a published log with nothing but the log. The hash chain must hold, every seed must hash back to its season's
 * commitment, and recomputing each pull from the seed, payment and ledger hash must land on the same band and the same
 * NFT from the same pool. No NFT can be held by two pulls. Anyone can run this: `pnpm verify <site>`.
 */
export function replayLog(events: readonly RipEvent[], opts: { xrpDepositories?: readonly string[] } = {}): ReplayResult {
  const s = emptyState();
  let prev = GENESIS_HASH;
  let pulls = 0;
  const bad = (at: number, why: string): ReplayResult => ({ ok: false, at, why });
  const held = new Set<string>();
  const redeemed = new Set<string>();
  const lastPaid = new Map<string, { ledger: number; txIndex: number; txHash: string }>();
  /** The children still to come straight after a bundle's payment, in order, and the payment they share. */
  let owing: { txHash: string; ledger: number; txIndex: number; season: string | null; kind: "nft" | "card"; children: string[]; address: string; each: string } | null = null;
  /** One payment pays one bundle or one pull, whichever comes first on the log. Old logs never share one. */
  const usedTx = new Set<string>();
  /** Every transaction signed, so two intents can't lean on one payment. A signature is only ever logged once. */
  const signedTx = new Set<string>();
  /** On a season whose empty band pays its rows, the next pull due a draw: who draws first decides who gets a band's last NFT and who its ladder. */
  const drawNext = new Map<string, number>();
  for (const e of events) {
    if (e.seq !== s.head + 1) return bad(e.seq, "gap in the log");
    if (e.prev !== prev) return bad(e.seq, "hash chain broken");
    if (sha256Hex(canonical(e)) !== e.hash) return bad(e.seq, "event was changed");
    prev = e.hash;
    // The engine draws in the order the ledger took the payments, so on such a season pull i is drawn before pull i + 1. Older seasons aren't held to it here.
    if (e.type === "pull_drawn" || e.type === "pull_prize_drawn" || e.type === "pull_refund_due") {
      const o = s.orders.get(e.data.order);
      if (o?.status === "paid" && o.index !== null && s.seasons.get(o.season)?.emptyBand === "rows") {
        if (o.index !== (drawNext.get(o.season) ?? 0)) return bad(e.seq, "a pull drawn ahead of one paid before it");
        drawNext.set(o.season, o.index + 1);
      }
    }
    // Per-item odds hand what the NFTs don't take to the band's ladder, so a season with them has to commit that ladder pays: five whole numbers each.
    if (e.type === "season_open" && e.data.nftOdds) {
      const odds = e.data.nftOdds;
      const five = (xs: unknown) => Array.isArray(xs) && xs.length === 5 && xs.every((x) => Number.isSafeInteger(x) && (x as number) >= 0);
      if (e.data.emptyBand !== "rows") return bad(e.seq, "per-item odds without a ladder to pay what the NFTs don't take");
      if (!five(odds.kDrops) || !five(odds.capBps) || !five(odds.excessDrops) || odds.capBps.some((c) => c > 10_000)) return bad(e.seq, "per-item odds aren't five whole numbers per band");
    }
    // A bundle's payment and its children go on the log as one write: anything between them means the log was rearranged.
    if (owing) {
      if ((e.type !== "pull_paid" && e.type !== "card_paid") || e.type !== (owing.kind === "nft" ? "pull_paid" : "card_paid") || e.data.order !== owing.children[0] || e.data.txHash !== owing.txHash || e.data.ledger !== owing.ledger || e.data.txIndex !== owing.txIndex || e.data.address !== owing.address || e.data.drops !== owing.each || (e.type === "pull_paid" && e.data.season !== owing.season)) return bad(e.seq, "a bundle's pulls don't follow its payment");
      owing.children.shift();
      if (!owing.children.length) owing = null;
    } else if ((e.type === "pull_paid" && s.orders.get(e.data.order)?.bundle) || (e.type === "card_paid" && s.cards.get(e.data.order)?.bundle)) {
      return bad(e.seq, "a bundle's pull was paid apart from its payment");
    } else if (e.type === "pull_paid" || e.type === "card_paid" || e.type === "payment_refund_due" || e.type === "payment_ignored") {
      if (usedTx.has(e.data.txHash)) return bad(e.seq, "a payment that paid for one thing can't pay for anything else");
      usedTx.add(e.data.txHash);
    }
    // A bundle ends as one. A child struck off alone would leave a paid pack with no pull.
    if (e.type === "order_expired" && (s.orders.get(e.data.id)?.bundle || s.cards.get(e.data.id)?.bundle)) return bad(e.seq, "a bundle's pull expired apart from its bundle");
    // An order exists once. Making it again would rewrite what it was.
    if ((e.type === "order_created" || e.type === "card_order_created") && (s.orders.has(e.data.id) || s.cards.has(e.data.id) || s.bundles.has(e.data.id))) return bad(e.seq, "an order's id used twice");
    if (e.type === "tx_final") {
      const intent = s.intents.get(e.data.id);
      // A result has to be for the transaction that was signed, and a success has to say where it landed, or nothing can check it on the ledger.
      if (intent && e.data.result !== "expired" && e.data.hash !== intent.hash) return bad(e.seq, "a result for a transaction other than the one signed");
      if (intent && e.data.result === "tesSUCCESS" && e.data.ledger === null) return bad(e.seq, "a success with no ledger");
    }
    if (e.type === "bundle_created" || e.type === "card_bundle_created") {
      const d = e.data;
      if (s.bundles.has(d.id) || s.orders.has(d.id) || s.cards.has(d.id)) return bad(e.seq, "a bundle reuses an order's id");
      if (!Number.isInteger(d.qty) || d.qty < 2 || d.qty > MAX_BUNDLE || d.children.length !== d.qty || new Set(d.children).size !== d.qty) return bad(e.seq, "a bundle's size doesn't match its pulls");
      if (d.children.some((c) => s.orders.has(c) || s.cards.has(c) || s.bundles.has(c) || c === d.id)) return bad(e.seq, "a bundle reuses an order's id");
      if (d.invoice !== invoiceOf(d.id)) return bad(e.seq, "a bundle's invoice isn't its own");
      if (BigInt(d.each) * BigInt(d.qty) !== BigInt(d.drops)) return bad(e.seq, "a bundle's total isn't its packs");
      if (e.type === "bundle_created") {
        const season = s.seasons.get(e.data.season);
        if (!season?.live) return bad(e.seq, "a bundle on a season with no commitment on the ledger");
        if (season.price !== e.data.price || e.data.each !== season.priceDrops) return bad(e.seq, "a bundle priced other than its season");
      }
    }
    if (e.type === "bundle_paid") {
      const b = s.bundles.get(e.data.bundle);
      if (!b || b.status !== "quoted") return bad(e.seq, "payment for an unknown bundle");
      if (e.data.address !== b.address || e.data.drops !== b.drops) return bad(e.seq, "payment doesn't match its bundle");
      if (e.data.ledger > b.lastLedger) return bad(e.seq, "a bundle paid after it ended");
      if (usedTx.has(e.data.txHash)) return bad(e.seq, "a payment that paid for one thing can't pay for anything else");
      usedTx.add(e.data.txHash);
      owing = { txHash: e.data.txHash, ledger: e.data.ledger, txIndex: e.data.txIndex, season: b.season, kind: b.kind, children: [...b.children], address: b.address, each: b.each };
    }
    if (e.type === "payout_requested") {
      const d = e.data;
      if (s.payouts.has(d.id)) return bad(e.seq, "a payout's id used twice");
      if (!d.items.length || d.items.length > MAX_BUNDLE || new Set(d.items.map((i) => i.order)).size !== d.items.length) return bad(e.seq, "a payout's items don't add up");
      let total = 0n;
      for (const item of d.items) {
        const o = s.orders.get(item.order);
        if (!o || o.address !== d.address || o.pull !== "stashed") return bad(e.seq, "a payout for something that wasn't in this wallet's stash");
        const drops = BigInt(item.drops);
        if (drops <= 0n) return bad(e.seq, "a payout's items don't add up");
        total += drops;
        if (o.prize?.token === XRP_TOKEN) {
          if (item.action !== "redeem" || item.drops !== o.prize.amount) return bad(e.seq, "an XRP prize paid at anything but its face");
        } else if (item.action !== "sell") {
          return bad(e.seq, "a payout redeems something other than an XRP prize");
        } else if (!o.prize) {
          const lot = o.lot ? s.lots.get(o.lot) : null;
          const season = s.seasons.get(o.season);
          if (!lot || !season || drops !== sellQuoteOf(lot.markDrops, season.sellBps)) return bad(e.seq, "an NFT sold at anything but its quote");
        } else if (drops > BigInt(o.prize.valueDrops)) {
          return bad(e.seq, "a prize sold for more than it's worth");
        }
      }
      if (total.toString() !== d.total) return bad(e.seq, "a payout's items don't add up");
    }
    if (e.type === "sell_requested") {
      const o = s.orders.get(e.data.order);
      const lot = o?.lot ? s.lots.get(o.lot) : null;
      const season = o ? s.seasons.get(o.season) : null;
      if (o?.pull === "stashed" && (e.data.address !== o.address || (lot && season ? BigInt(e.data.drops) !== sellQuoteOf(lot.markDrops, season.sellBps) : o.prize ? BigInt(e.data.drops) > BigInt(o.prize.valueDrops) : false))) return bad(e.seq, "a sale at anything but its quote");
    }
    if (e.type === "card_exit_requested") {
      const c = s.cards.get(e.data.order);
      if (c && !c.mirror?.accepted && e.data.by !== c.address) return bad(e.seq, "a card's exit asked by someone who doesn't hold it");
    }
    if (e.type === "tx_intent") {
      if (signedTx.has(e.data.hash)) return bad(e.seq, "two records of one signed transaction");
      signedTx.add(e.data.hash);
      // What goes out has to be what's owed, to whoever it's owed to.
      const tx = e.data.tx as { Destination?: unknown; Amount?: unknown };
      const owes = (to: unknown, drops: unknown) => tx.Destination === to && tx.Amount === drops;
      if (e.data.kind === "refund") {
        const r = s.refunds.get(e.data.ref);
        if (!r || r.status !== "due" || !owes(r.to, r.drops)) return bad(e.seq, "a refund that isn't what's owed");
      }
      if (e.data.kind === "sellback") {
        const o = s.orders.get(e.data.ref);
        if (!o || o.pull !== "selling" || !owes(o.address, o.sellDrops)) return bad(e.seq, "a sale's payment that isn't what was agreed");
      }
      if (e.data.kind === "card_sellback") {
        const c = s.cards.get(e.data.ref);
        if (!c || c.hold !== "selling" || !owes(c.exit?.by, c.exit?.drops)) return bad(e.seq, "a card sale's payment that isn't what was agreed");
      }
    }
    if (e.type === "tx_intent" && e.data.kind === "payout") {
      const p = s.payouts.get(e.data.ref);
      if (!p || p.status !== "due") return bad(e.seq, "a payment for a payout that wasn't due");
      const tx = e.data.tx as { Destination?: unknown; Amount?: unknown };
      if (tx.Destination !== p.address || tx.Amount !== p.total) return bad(e.seq, "a payment doesn't match its payout");
    }
    if (e.type === "pull_paid") {
      const o = s.orders.get(e.data.order);
      const season = s.seasons.get(e.data.season);
      if (!o || !season) return bad(e.seq, "payment for an unknown order");
      if (e.data.season !== o.season) return bad(e.seq, "payment for a season other than its order's");
      if (o.status !== "quoted") return bad(e.seq, "a second payment taken for an order already paid");
      if (!season.live) return bad(e.seq, "sold before the commitment was on the ledger");
      if (season.anchorLedger !== null && e.data.ledger <= season.anchorLedger) return bad(e.seq, "paid before the commitment was on the ledger");
      if (e.data.index !== season.nextIndex) return bad(e.seq, "pull index out of order");
      if (e.data.address !== o.address || e.data.drops !== o.drops) return bad(e.seq, "payment doesn't match its order");
      if (e.data.entropyLedger !== e.data.ledger + ENTROPY_DELAY) return bad(e.seq, "entropy ledger isn't the fixed distance after the payment");
      // Seeds are given out in the order the ledger took the payments, so a later payment can't pick an earlier seed.
      const last = lastPaid.get(e.data.season);
      // Only a bundle shares a transaction between pulls, and the check above has already tied them to its one payment.
      const sameBundle = !!o.bundle && last?.txHash === e.data.txHash;
      if (last && !sameBundle && (e.data.ledger < last.ledger || (e.data.ledger === last.ledger && e.data.txIndex <= last.txIndex))) return bad(e.seq, "pull index out of ledger order");
      lastPaid.set(e.data.season, { ledger: e.data.ledger, txIndex: e.data.txIndex, txHash: e.data.txHash });
    }
    if (e.type === "tx_final" && s.intents.get(e.data.id)?.kind === "anchor" && e.data.result === "tesSUCCESS") {
      const ref = s.intents.get(e.data.id)?.ref ?? "";
      const change = ref.startsWith("pool:") ? s.poolChanges.get(ref.slice(5)) : null;
      // A pool change takes effect from the ledger after its anchor. Any draw already past that ledger would have been
      // working from the wrong pool, so the order of this log would give it away.
      if (change && (s.drawnThrough.get(change.price) ?? 0) > (e.data.ledger ?? 0)) return bad(e.seq, "pool changed under a pull that was already drawn");
    }
    if (e.type === "pull_drawn") {
      const d = e.data;
      const o = s.orders.get(d.order);
      const season = s.seasons.get(d.season);
      if (!o || !season) return bad(e.seq, "draw for an unknown order");
      if (o.status !== "paid" || o.index !== d.index || o.txHash !== d.txHash || o.entropyLedger !== d.entropyLedger) return bad(e.seq, "draw doesn't match its payment");
      if (!seedMatches(d.seed, d.index, season.commit)) return bad(e.seq, "seed doesn't hash back to the commitment");
      const digest = digestOf({ season: d.season, index: d.index, seed: d.seed, txHash: d.txHash, ledgerHash: d.ledgerHash, address: d.address });
      if (digest !== d.digest) return bad(e.seq, "digest doesn't reproduce");
      if (bandOf(digest, season.bandBps) !== d.band) return bad(e.seq, "band doesn't reproduce");
      if (!season.nftOdds && prizeRowOf(digest, season.prizeTable, d.band)) return bad(e.seq, "an NFT was given where the roll says a token prize");
      const pool = poolAt(s, o.price, d.band, o.ledger as number);
      if (pool.length !== d.poolSize) return bad(e.seq, "pool size doesn't reproduce");
      // Without this a forged draw from an empty band throws in the pick, and a browser's check shows nothing at all.
      if (!pool.length) return bad(e.seq, "an NFT drawn from an empty band");
      // Per-item odds: the item roll, over each NFT's own share of the band, names the NFT, or the ladder when it lands past them all.
      const pick = season.nftOdds ? itemPick(digest, itemWeights(season.nftOdds, season.prizeTable, d.band, pool.map((l) => l.markDrops), season.sellBps, season.priceDrops)) : pickOf(digest, pool.length);
      if (pick === null) return bad(e.seq, "an NFT was given where the roll says the band's ladder");
      if (pick !== d.pick || pool[pick].lot !== d.lot || pool[pick].nftId !== d.nftId) return bad(e.seq, "NFT doesn't reproduce");
      if (held.has(d.nftId)) return bad(e.seq, "NFT delivered while another pull holds it");
      held.add(d.nftId);
      pulls += 1;
    }
    if (e.type === "pull_prize_drawn") {
      const d = e.data;
      const o = s.orders.get(d.order);
      const season = s.seasons.get(d.season);
      if (!o || !season) return bad(e.seq, "draw for an unknown order");
      if (o.status !== "paid" || o.index !== d.index || o.txHash !== d.txHash || o.entropyLedger !== d.entropyLedger) return bad(e.seq, "draw doesn't match its payment");
      if (!seedMatches(d.seed, d.index, season.commit)) return bad(e.seq, "seed doesn't hash back to the commitment");
      const digest = digestOf({ season: d.season, index: d.index, seed: d.seed, txHash: d.txHash, ledgerHash: d.ledgerHash, address: d.address });
      if (digest !== d.digest) return bad(e.seq, "digest doesn't reproduce");
      if (bandOf(digest, season.bandBps) !== d.band) return bad(e.seq, "band doesn't reproduce");
      // A roll that lands on the band's NFTs pays its rows only on a season that says so, and only while the band holds none.
      const pool = poolAt(s, o.price, d.band, o.ledger as number);
      const ladder = season.nftOdds ? itemPick(digest, itemWeights(season.nftOdds, season.prizeTable, d.band, pool.map((l) => l.markDrops), season.sellBps, season.priceDrops)) === null : !pool.length;
      const row = season.nftOdds ? (ladder ? fallbackRowOf(digest, season.prizeTable, d.band) : null) : (prizeRowOf(digest, season.prizeTable, d.band) ?? (season.emptyBand === "rows" && ladder ? fallbackRowOf(digest, season.prizeTable, d.band) : null));
      if (!row || row.valueDrops !== d.valueDrops || (row.token !== d.token && (d.token !== XRP_TOKEN || d.paidInXrp?.token !== row.token))) return bad(e.seq, "token prize doesn't reproduce");
      // Both reads sit at fixed ledgers, so nobody can shop for the one that strikes the fewest tokens.
      if (d.reads && (d.reads.now.ledger !== d.entropyLedger || d.reads.prior.ledger !== d.entropyLedger - TOKEN_POLICY.priorLedgers)) return bad(e.seq, "strike isn't from the pull's own ledger");
      if (d.paidInXrp?.code === "no_trust_line") {
        // Only a dust row can pay XRP for this, and it shows no pool reads because it never needed a price.
        if (!row.dust || d.reads) return bad(e.seq, "paid in XRP for a trust line where the table allows none");
      } else if (d.paidInXrp) {
        const why = xrpInsteadWhy(d.paidInXrp.code, d.reads, d.valueDrops);
        if (why) return bad(e.seq, why);
      }
      // Only XRP can wait on a top-up: a token prize is struck from what the treasury holds, or it pays in XRP.
      if (d.owed && d.token !== XRP_TOKEN) return bad(e.seq, "a token prize was struck with nothing to pay it");
      if (d.token === XRP_TOKEN) {
        if (d.amount !== d.valueDrops) return bad(e.seq, "XRP prize isn't its value");
      } else {
        if (!d.reads) return bad(e.seq, "strike isn't from the pull's own ledger");
        const check = checkPool(d.reads.now, d.reads.prior);
        if (!check.ok) return bad(e.seq, "struck on a price that should have paused it");
        if (strikeAmount(d.valueDrops, check.strike).toString() !== d.amount) return bad(e.seq, "struck amount doesn't reproduce");
      }
      pulls += 1;
    }
    if (e.type === "tx_intent" && e.data.kind === "prize_redeem") {
      const o = s.orders.get(e.data.ref);
      if (!o?.prize || o.pull !== "redeeming") return bad(e.seq, "payout for a prize that wasn't being redeemed");
      if (redeemed.has(o.id)) return bad(e.seq, "second payout after a prize was paid");
      const tx = e.data.tx as { Destination?: unknown; Amount?: unknown };
      const paid = typeof tx.Amount === "string" ? tx.Amount : (tx.Amount as { value?: string } | undefined)?.value;
      if (tx.Destination !== o.address || paid !== o.prize.amount) return bad(e.seq, "payout doesn't match the prize");
      const named = s.seasons.get(o.season)?.tokens.find((t) => t.id === o.prize?.token);
      const amount = tx.Amount as { currency?: string; issuer?: string };
      if (o.prize.token === XRP_TOKEN ? typeof tx.Amount !== "string" : amount.currency !== named?.currency || amount.issuer !== named?.issuer) return bad(e.seq, "payout is in a different token than the prize");
    }
    if (e.type === "log_genesis" && e.seq !== 1) return bad(e.seq, "genesis isn't first");
    if (e.type === "pool_change") {
      if ((e.data.v === 2 ? poolRootV2(e.data.price, e.data.adds, e.data.removes) : poolRoot(e.data.price, e.data.adds, e.data.removes)) !== e.data.root) return bad(e.seq, "pool change doesn't match its anchored root");
      for (const add of e.data.adds) {
        // An NFT a pull holds is a player's, however it got listed.
        if (held.has(add.nftId)) return bad(e.seq, "listed an NFT a player holds");
        // A lap can only bring a mark down. Only a person registering an NFT sets one, and that's a change of a different kind.
        const prior = s.lots.get(s.nftLot.get(add.nftId) ?? "");
        const lap = e.data.id.startsWith("relist-") || e.data.id.startsWith("release-");
        if (lap && (!prior || prior.status !== "returned")) return bad(e.seq, "sent back an NFT that wasn't sold back");
        if (lap && prior && BigInt(add.markDrops) > BigInt(prior.markDrops)) return bad(e.seq, "a sold-back NFT came back at a higher mark");
        if (e.data.id.startsWith("relist-") && prior && add.band !== prior.band) return bad(e.seq, "a sold-back NFT came back in another band");
        const bought = [...s.buys.values()].find((b) => b.nftId === add.nftId && b.status === "filled");
        if (bought && (bought.markDrops !== add.markDrops || bought.band !== add.band || bought.price !== e.data.price)) return bad(e.seq, "a bought NFT went in on other terms than it was bought for");
      }
    }
    if (e.type === "restock_buy_planned" && [...s.buys.values()].some((b) => b.nftId === e.data.nftId && b.status !== "ended")) return bad(e.seq, "the same NFT was bought twice");
    if (e.type === "tx_intent" && e.data.kind === "vault_buy") {
      const b = s.buys.get(e.data.ref);
      if (!b || b.status !== "planned") return bad(e.seq, "a buy nobody planned");
      const tx = e.data.tx as { TransactionType?: unknown; NFTokenSellOffer?: unknown; NFTokenID?: unknown; Amount?: unknown; Destination?: unknown };
      const asPlanned = b.route === "direct" ? tx.TransactionType === "NFTokenAcceptOffer" && tx.NFTokenSellOffer === b.offerIndex : tx.TransactionType === "NFTokenCreateOffer" && tx.NFTokenID === b.nftId && tx.Amount === b.offeredDrops && tx.Destination === b.broker;
      if (!asPlanned) return bad(e.seq, "a buy that isn't what was planned");
    }
    if (e.type === "tx_intent" && e.data.kind === "mirror_mint") {
      const c = s.cards.get(e.data.ref);
      // No mirror without a card proven in custody, and never two at once for one card.
      if (!c || c.hold !== "minting" || !c.proof) return bad(e.seq, "mint without a custody proof");
      if (c.mirror) return bad(e.seq, "second mirror for one card");
    }
    // A session isn't enough to send a card to an address, so every shipment points at what its wallet signed.
    if (e.type === "card_exit_requested" && e.data.kind === "ship" && (!e.data.shipTx || e.data.shipLedger === null || e.data.shipLedger === undefined || !e.data.addressHash)) return bad(e.seq, "a card asked to ship with no wallet's signature");
    if (e.type === "card_generating" && s.cards.get(e.data.order)?.status !== "paid") return bad(e.seq, "pack bought for an unpaid order");
    if (e.type === "swap_opened") {
      const d = e.data;
      if (s.swaps.has(d.id)) return bad(e.seq, "swap opened twice");
      if ([...s.swaps.values()].some((x) => x.orderId === d.orderId)) return bad(e.seq, "two swaps for one Relay order");
      const moved = d.accruals.map((id) => s.accruals.get(id));
      if (moved.some((a) => a?.status !== "owed")) return bad(e.seq, "a swap moved money that wasn't owed");
      if (d.accruals.length) {
        const dirOk = moved.every((a) => a?.dir === (d.dir === "xrp_to_usdc" ? "to_custody" : "to_treasury"));
        if (!dirOk || BigInt(d.inAmount) > moved.reduce((t, a) => t + BigInt(a?.amount ?? 0), 0n)) return bad(e.seq, "a swap moved more than its orders brought in");
      } else {
        const c = d.card ? s.cards.get(d.card) : null;
        if (d.dir !== "xrp_to_usdc" || !c || BigInt(d.inAmount) > BigInt(c.drops)) return bad(e.seq, "a swap moved more than its order paid");
      }
    }
    if (e.type === "tx_intent" && e.data.kind === "relay_deposit") {
      const x = s.swaps.get(e.data.ref);
      if (!x || x.status !== "quoted" || x.dir !== "xrp_to_usdc") return bad(e.seq, "a deposit for no open swap");
      const refused = depositRefusal(e.data.tx, x, opts.xrpDepositories);
      if (refused) return bad(e.seq, `a deposit doesn't match its swap: ${refused}`);
    }
    if (e.type === "swap_landed" || e.type === "swap_refunded") {
      const x = s.swaps.get(e.data.id);
      if (!x || x.status !== "deposited") return bad(e.seq, "a swap landed that wasn't out");
      const proof = e.data.txHash ?? e.data.signature;
      if (!proof) return bad(e.seq, "a swap landed with nothing to show for it");
      if (s.swapProofs.has(proof)) return bad(e.seq, "one delivery counted twice");
      if (e.data.txHash && !s.relayArrivals.has(e.data.txHash)) return bad(e.seq, "a swap landed on a payment that isn't logged");
    }
    if (e.type === "tx_intent" && e.data.kind === "card_sellback") {
      const c = s.cards.get(e.data.ref);
      const tx = e.data.tx as { Destination?: unknown; Amount?: unknown };
      if (!c || c.hold !== "selling") return bad(e.seq, "a card payout with no sale behind it");
      if (tx.Destination !== c.exit?.by || tx.Amount !== c.exit?.drops) return bad(e.seq, "a card payout doesn't match its sale");
    }
    if (e.type === "pull_refund_due") {
      const d = e.data;
      const o = s.orders.get(d.order);
      if (!o) return bad(e.seq, "refund for an unknown order");
      if (o.bundle && (d.drops !== o.drops || d.to !== o.address)) return bad(e.seq, "a bundle's pull refunded other than its own price, to its own wallet");
      const season = s.seasons.get(o.season);
      if (!season || o.index === null || !o.txHash) return bad(e.seq, "refund for an unpaid order");
      // A refunded pull has to show its work too, or a Chase could be voided by naming an empty band.
      if (!seedMatches(d.seed, o.index, season.commit)) return bad(e.seq, "refund's seed doesn't hash back to the commitment");
      const digest = digestOf({ season: o.season, index: o.index, seed: d.seed, txHash: o.txHash, ledgerHash: d.ledgerHash, address: o.address });
      if (digest !== d.digest || bandOf(digest, season.bandBps) !== d.band) return bad(e.seq, "refund's band doesn't reproduce");
      const row = season.nftOdds ? null : prizeRowOf(digest, season.prizeTable, d.band);
      if (season.nftOdds) {
        // Per-item odds give a pull's XRP back only where the item roll lands past every NFT's share in a band with no rows to pay.
        const pool = poolAt(s, o.price, d.band, o.ledger as number);
        if (itemPick(digest, itemWeights(season.nftOdds, season.prizeTable, d.band, pool.map((l) => l.markDrops), season.sellBps, season.priceDrops)) !== null) return bad(e.seq, "refunded a pull its roll gave an NFT");
        if (fallbackRowOf(digest, season.prizeTable, d.band)) return bad(e.seq, "refunded a pull its band's rows pay on this season");
      } else if (row) {
        // A prize's price never refunds a pull: its row pays in XRP. A short treasury used to give the money back, and now
        // strikes the prize as owed. The engine doesn't write this anymore, and a log that has one still replays.
        if (d.reason !== "float_short") return bad(e.seq, "refunded a prize, which pays its value in XRP");
      } else {
        const pool = poolAt(s, o.price, d.band, o.ledger as number);
        if (pool.length) return bad(e.seq, "refunded a pull while its band had stock");
        if (season.emptyBand === "rows" && fallbackRowOf(digest, season.prizeTable, d.band)) return bad(e.seq, "refunded a pull its band's rows pay on this season");
      }
    }
    if (e.type === "tx_intent" && (e.data.kind === "prize_redeem" || e.data.kind === "sellback") && s.orders.get(e.data.ref)?.payout) return bad(e.seq, "an item paid on its own while it's in a payout");
    // A claimed NFT left us. If it ever comes back to the vault, a later pull holding it again is no conflict.
    const leaving = e.type === "claim_accepted" ? s.orders.get(e.data.order) : null;
    apply(s, e);
    if (leaving?.pull === "claimed" && leaving.nftId) held.delete(leaving.nftId);
    if (e.type === "tx_final" && s.settled.get(e.data.id)?.kind === "prize_redeem" && e.data.result === "tesSUCCESS") redeemed.add(s.settled.get(e.data.id)?.ref ?? "");
    if (e.type === "tx_final" && s.settled.get(e.data.id)?.kind === "payout" && e.data.result === "tesSUCCESS") {
      const p = s.payouts.get(s.settled.get(e.data.id)?.ref ?? "");
      for (const item of p?.items ?? []) {
        const o = s.orders.get(item.order);
        if (item.action === "redeem") redeemed.add(item.order);
        // Selling back frees an NFT to go round again, the same as a single sale.
        else if (o?.nftId) held.delete(o.nftId);
      }
    }
    // Selling back frees the NFT to go round again.
    if (e.type === "tx_final" && s.settled.get(e.data.id)?.kind === "sellback" && e.data.result === "tesSUCCESS") {
      const o = s.orders.get(s.settled.get(e.data.id)?.ref ?? "");
      if (o?.nftId) held.delete(o.nftId);
    }
  }
  if (owing) return bad(s.head, "a bundle's pulls don't follow its payment");
  return { ok: true, pulls, state: s };
}

export type ChainCheck = { readonly ok: true; readonly payments: number; readonly anchors: number } | { readonly ok: false; readonly why: string };

/**
 * The second half: check the log against the ledger itself. Every commitment and pool change must be in a memo at the
 * ledger it claims, every ledger hash real, every pull's payment real, and every payment into the treasury accounted for.
 */
export async function verifyAgainstChain(events: readonly RipEvent[], chain: Chain, treasury: string, fromLedger: number, opts: { xrpDepositories?: readonly string[] } = {}): Promise<ChainCheck> {
  const replay = replayLog(events, opts);
  if (!replay.ok) return { ok: false, why: `log: ${replay.why} at ${replay.at}` };
  const hexText = (h: unknown) => Buffer.from(String(h), "hex").toString("utf8");
  const look = async (hash: string, account: string, ledger: number) => chain.tx(hash, { account, minLedger: ledger, maxLedger: ledger });
  let anchors = 0;
  for (const season of replay.state.seasons.values()) {
    if (!season.anchorTx) continue;
    const t = await look(season.anchorTx, treasury, season.anchorLedger as number);
    if (!t.found || !t.validated || t.tx.ledger !== season.anchorLedger || t.tx.tx.Account !== treasury) return { ok: false, why: `season ${season.season}: anchor isn't on the ledger` };
    const memos = JSON.stringify((t.tx.tx.Memos as { Memo: { MemoData: string } }[]).map((m) => hexText(m.Memo.MemoData)));
    if (!memos.includes(season.commit)) return { ok: false, why: `season ${season.season}: anchor memo doesn't hold the commitment` };
    if (!memos.includes(seasonTermsHash(season))) return { ok: false, why: `season ${season.season}: anchor memo doesn't hold the season's terms` };
    anchors += 1;
  }
  for (const p of replay.state.poolChanges.values()) {
    if (!p.anchorTx) continue;
    const t = await look(p.anchorTx, treasury, p.ledger as number);
    if (!t.found || !t.validated || t.tx.ledger !== p.ledger) return { ok: false, why: `pool ${p.id}: anchor isn't on the ledger` };
    const memos = JSON.stringify((t.tx.tx.Memos as { Memo: { MemoData: string } }[]).map((m) => hexText(m.Memo.MemoData)));
    if (!memos.includes(p.root)) return { ok: false, why: `pool ${p.id}: anchor memo doesn't hold the manifest root` };
    anchors += 1;
  }
  const accounted = new Set<string>();
  const redeems = new Map<string, Readonly<Record<string, unknown>>>();
  // Twenty pulls on one payment share a ledger, so they ask for its hash once.
  const hashes = new Map<number, Promise<string>>();
  const ledgerHashOf = (seq: number) => {
    if (!hashes.has(seq)) hashes.set(seq, chain.ledgerHash(seq));
    return hashes.get(seq) as Promise<string>;
  };
  const buys = new Set<string>();
  for (const e of events) {
    if (e.type === "tx_intent" && (e.data.kind === "prize_redeem" || e.data.kind === "payout" || e.data.kind === "refund" || e.data.kind === "sellback" || e.data.kind === "card_sellback")) redeems.set(e.data.id, e.data.tx);
    if (e.type === "tx_intent" && e.data.kind === "vault_buy") buys.add(e.data.id);
    // A buy the log says went through has to be on the ledger, from the vault.
    if (e.type === "tx_final" && e.data.result === "tesSUCCESS" && e.data.ledger !== null && buys.has(e.data.id)) {
      const vault = replay.state.genesis?.vault ?? "";
      const t = await look(e.data.hash, vault, e.data.ledger);
      if (!t.found || !t.validated || t.tx.result !== "tesSUCCESS" || t.tx.tx.Account !== vault) return { ok: false, why: `buy ${e.data.hash} isn't on the ledger` };
    }
    // A refund owes what the ledger delivered, to whoever sent it. Funding names no order, and it comes from who the log says.
    if (e.type === "payment_refund_due") {
      const t = await look(e.data.txHash, treasury, e.data.ledger);
      if (!t.found || !t.validated || t.tx.delivered !== e.data.drops || t.tx.tx.Account !== e.data.from) return { ok: false, why: `refund ${e.data.id}: the payment it refunds doesn't match the ledger` };
    }
    if (e.type === "payment_ignored") {
      const t = await look(e.data.txHash, treasury, e.data.ledger);
      const invoice = t.found && typeof t.tx.tx.InvoiceID === "string" ? t.tx.tx.InvoiceID.toUpperCase() : null;
      if (!t.found || !t.validated || t.tx.tx.Account !== e.data.from || (invoice && replay.state.orderByInvoice.has(invoice))) return { ok: false, why: `payment ${e.data.txHash}: set aside as funding, but it doesn't match the ledger or it names an order` };
    }
    if (e.type === "pull_paid" || e.type === "card_paid" || e.type === "payment_refund_due" || e.type === "payment_ignored" || e.type === "bundle_paid" || e.type === "relay_arrival") accounted.add(e.data.txHash);
    if (e.type === "relay_arrival") {
      const t = await look(e.data.txHash, treasury, e.data.ledger);
      if (!t.found || !t.validated || t.tx.result !== "tesSUCCESS" || t.tx.delivered !== e.data.drops || t.tx.tx.Account !== e.data.from || t.tx.tx.Destination !== treasury) return { ok: false, why: `Relay arrival ${e.data.txHash} doesn't match the ledger` };
    }
    if (e.type === "bundle_paid") {
      // The one payment has to be what all of its pulls rest on: the whole total, from the wallet, under the bundle's own invoice.
      const b = replay.state.bundles.get(e.data.bundle);
      const t = await look(e.data.txHash, treasury, e.data.ledger);
      if (!b || !t.found || !t.validated || t.tx.ledger !== e.data.ledger || t.tx.delivered !== e.data.drops || t.tx.tx.Account !== e.data.address || t.tx.tx.Destination !== treasury || String(t.tx.tx.InvoiceID ?? "").toUpperCase() !== b.invoice) return { ok: false, why: `bundle ${e.data.bundle}: payment doesn't match the ledger` };
    }
    // A bundle's pulls rest on the check above. It's the order that says so and not the transaction, so nothing else can lean on a bundle's payment.
    if (e.type === "card_paid" && !replay.state.cards.get(e.data.order)?.bundle) {
      const t = await look(e.data.txHash, treasury, e.data.ledger);
      if (!t.found || !t.validated || t.tx.ledger !== e.data.ledger || t.tx.delivered !== e.data.drops || t.tx.tx.Account !== e.data.address || t.tx.tx.Destination !== treasury) return { ok: false, why: `card ${e.data.order}: payment doesn't match the ledger` };
    }
    if (e.type === "pull_paid" && !replay.state.orders.get(e.data.order)?.bundle) {
      const t = await look(e.data.txHash, treasury, e.data.ledger);
      if (!t.found || !t.validated || t.tx.ledger !== e.data.ledger || t.tx.delivered !== e.data.drops || t.tx.tx.Account !== e.data.address || t.tx.tx.Destination !== treasury) return { ok: false, why: `pull ${e.data.order}: payment doesn't match the ledger` };
    }
    if (e.type === "card_exit_requested" && e.data.kind === "ship") {
      const t = await look(e.data.shipTx as string, e.data.by, e.data.shipLedger as number);
      if (!t.found || !t.validated || t.tx.result !== "tesSUCCESS" || t.tx.tx.Account !== e.data.by || !namesShipment(t.tx.tx.Memos, e.data.order, e.data.addressHash as string)) return { ok: false, why: `card ${e.data.order}: the wallet's signature to ship isn't on the ledger` };
    }
    if (e.type === "pull_prize_drawn") {
      if ((await ledgerHashOf(e.data.entropyLedger)).toUpperCase() !== e.data.ledgerHash.toUpperCase()) return { ok: false, why: `pull ${e.data.order}: ledger hash doesn't match` };
      const spec = replay.state.seasons.get(e.data.season)?.tokens.find((t) => t.id === (e.data.paidInXrp?.token ?? e.data.token));
      if (e.data.reads && spec && chain.ammPool) {
        for (const read of [e.data.reads.now, e.data.reads.prior]) {
          const onLedger = await chain.ammPool(spec, read.ledger);
          if (!onLedger || onLedger.xrpDrops !== read.xrpDrops || onLedger.tokenMicro !== read.tokenMicro) return { ok: false, why: `pull ${e.data.order}: the pool read doesn't match the ledger` };
        }
      }
    }
    if (e.type === "pull_drawn") {
      if ((await ledgerHashOf(e.data.entropyLedger)).toUpperCase() !== e.data.ledgerHash.toUpperCase()) return { ok: false, why: `pull ${e.data.order}: ledger hash doesn't match` };
    }
    if (e.type === "pull_refund_due") {
      // A made-up ledger hash could land a winning pull on an empty band.
      const entropy = replay.state.orders.get(e.data.order)?.entropyLedger;
      if (entropy === null || entropy === undefined || (await ledgerHashOf(entropy)).toUpperCase() !== e.data.ledgerHash.toUpperCase()) return { ok: false, why: `refund ${e.data.id}: ledger hash doesn't match` };
    }
    if (e.type === "tx_final" && e.data.result === "tesSUCCESS" && e.data.ledger !== null && redeems.has(e.data.id)) {
      // A prize marked paid has to be paid, in full, to the wallet that won it.
      const want = redeems.get(e.data.id) as { Destination?: unknown; Amount?: unknown };
      const t = await look(e.data.hash, treasury, e.data.ledger);
      const delivered = t.found ? t.tx.delivered : null;
      const amount = (v: unknown) => (typeof v === "string" ? v : (v as { value?: string } | null)?.value);
      if (!t.found || !t.validated || t.tx.result !== "tesSUCCESS" || t.tx.tx.Account !== treasury || t.tx.tx.Destination !== want.Destination || amount(delivered) !== amount(want.Amount)) return { ok: false, why: `prize payout ${e.data.hash} doesn't match the ledger` };
    }
  }
  let payments = 0;
  for (const t of await chain.accountTx(treasury, fromLedger)) {
    if (t.tx.TransactionType !== "Payment" || t.tx.Destination !== treasury || t.result !== "tesSUCCESS" || t.tx.Account === treasury) continue;
    payments += 1;
    // Dust that matches nothing, and tokens, are left off the log on purpose: a flood of them can't grow what every server has to replay.
    if (!accounted.has(t.hash) && (typeof t.delivered === "object" || (typeof t.delivered === "string" && BigInt(t.delivered) < DUST_DROPS))) continue;
    if (!accounted.has(t.hash)) return { ok: false, why: `payment ${t.hash} isn't in the log` };
  }
  return { ok: true, payments, anchors };
}

/** What the public gets: the log without signed blobs and what we paid. The event hashes already leave both out. */
export const publicEvents = (events: readonly RipEvent[]): RipEvent[] => events.map(stripPrivate);
