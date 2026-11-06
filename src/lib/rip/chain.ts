import { nftIdFlags } from "./nftid.ts";
import { iouToMicro } from "./tokens.ts";
import type { Chain, ChainTx, TxLookup } from "./types.ts";

export const TESTNET_RPC = "https://s.altnet.rippletest.net:51234/";
export const TESTNET_ID = 1;
export const MAINNET_ID = 0;
const CLIO_RPC = "https://s2.ripple.com:51234/";
/** Testnet's public rippled doesn't answer nft_info, and mainnet's Clio can't see testnet NFTs. Found in the testnet rehearsal. */
export const TESTNET_CLIO_RPC = "https://clio.altnet.rippletest.net:51234/";

type Json = Record<string, unknown>;

/** Ripple's epoch-free reads: a plain JSON-RPC client over fetch, which is all a serverless function can count on. */
export function rpcChain(url: string, fetchImpl: typeof fetch = fetch, opts: { readonly clioUrl?: string } = {}): Chain {
  const call = async (method: string, params: Json = {}, at: string = url): Promise<Json> => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(at, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [{ api_version: 1, ...params }] }), signal: AbortSignal.timeout(15000), cache: "no-store" });
        if (res.status === 429 || res.status >= 500) throw new Error(`XRPL ${method}: ${res.status}`);
        const body = (await res.json()) as { result?: Json };
        if (!body.result) throw new Error(`XRPL ${method}: empty`);
        return body.result;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw last instanceof Error ? last : new Error(`XRPL ${method} failed`);
  };

  const fail = (method: string, r: Json): never => {
    throw new Error(`XRPL ${method}: ${String(r.error_message ?? r.error ?? "error")}`);
  };

  /** The offer an NFTokenCreateOffer made. Newer servers report it, and the created ledger node always shows it. */
  const offerIdOf = (meta: Json): string | null => {
    if (typeof meta.offer_id === "string") return meta.offer_id;
    for (const n of (meta.AffectedNodes as Json[]) ?? []) {
      const c = n.CreatedNode as Json | undefined;
      if (c?.LedgerEntryType === "NFTokenOffer") return String(c.LedgerIndex);
    }
    return null;
  };

  const toChainTx = (hash: string, tx: Json, meta: Json, ledger: number): ChainTx => ({
    hash,
    ledger,
    txIndex: Number(meta.TransactionIndex ?? 0),
    result: String(meta.TransactionResult),
    tx,
    delivered: meta.delivered_amount ?? meta.DeliveredAmount ?? null,
    offerId: offerIdOf(meta),
    nftId: typeof meta.nftoken_id === "string" ? meta.nftoken_id : null,
    deletedOffers: ((meta.AffectedNodes as Json[]) ?? []).flatMap((n) => {
      const d = n.DeletedNode as Json | undefined;
      return d?.LedgerEntryType === "NFTokenOffer" ? [String(d.LedgerIndex)] : [];
    }),
  });

  /** One account's validated transactions in a ledger range, every page of them. */
  const accountTxPages = async (account: string, min: number, max: number) => {
    const out: ChainTx[] = [];
    let marker: unknown;
    // A server that doesn't say what it searched has searched nothing we can rely on.
    let range = { min: Infinity, max: -Infinity };
    do {
      const r = await call("account_tx", { account, ledger_index_min: min, ledger_index_max: max, forward: true, limit: 200, ...(marker ? { marker } : {}) });
      if (r.status !== "success") fail("account_tx", r);
      if (typeof r.ledger_index_min === "number" && typeof r.ledger_index_max === "number") range = { min: r.ledger_index_min, max: r.ledger_index_max };
      for (const row of r.transactions as Json[]) {
        if (row.validated === false) continue;
        const tx = row.tx as Json;
        const meta = row.meta as Json;
        out.push(toChainTx(String(tx.hash), tx, meta, Number(tx.ledger_index ?? tx.inLedger ?? row.ledger_index)));
      }
      marker = r.marker;
    } while (marker);
    out.sort((a, b) => a.ledger - b.ledger || a.txIndex - b.txIndex);
    return { txs: out, range };
  };

  return {
    async networkId() {
      const r = await call("server_info");
      const id = (r.info as Json | undefined)?.network_id;
      if (typeof id === "number") return id;
      // Mainnet servers can leave this out. Anything we can't read is not testnet.
      return MAINNET_ID;
    },
    async validatedLedger() {
      const r = await call("ledger", { ledger_index: "validated" });
      if (r.status !== "success") fail("ledger", r);
      return Number(r.ledger_index ?? (r.ledger as Json).ledger_index);
    },
    async ledgerHash(seq) {
      const r = await call("ledger", { ledger_index: seq });
      if (r.status !== "success" || r.validated !== true) throw new Error(`ledger ${seq} isn't validated`);
      return String(r.ledger_hash ?? (r.ledger as Json).ledger_hash).toUpperCase();
    },
    async accountTx(account, fromLedger) {
      const { txs, range } = await accountTxPages(account, fromLedger, -1);
      // A server whose history starts later silently answers for less. Reading on would move the cursor past a payment.
      if (!(range.min <= fromLedger)) throw new Error(`XRPL history starts at ${range.min}, after ${fromLedger}`);
      return txs;
    },
    async tx(hash, range): Promise<TxLookup> {
      const r = await call("tx", { transaction: hash });
      // Only validated counts. A server can keep an unapplied transaction cached forever, and that must not read as live.
      if (r.status === "success" && r.validated === true && r.meta) return { found: true, validated: true, tx: toChainTx(hash, r, r.meta as Json, Number(r.ledger_index ?? r.inLedger)) };
      if (r.status !== "success" && r.error !== "txnNotFound") throw new Error(`XRPL tx: ${String(r.error)}`);
      // "Not found" alone proves nothing. Only a look through the account's own history across the transaction's whole
      // valid range, on a server that says it has that range, can say it never applied.
      const pages = await accountTxPages(range.account, range.minLedger, range.maxLedger).catch(() => null);
      if (!pages) return { found: false, definite: false };
      const hit = pages.txs.find((t) => t.hash === hash);
      if (hit) return { found: true, validated: true, tx: hit };
      return { found: false, definite: pages.range.min <= range.minLedger && pages.range.max >= range.maxLedger };
    },
    async submit(blob) {
      const r = await call("submit", { tx_blob: blob });
      if (r.status !== "success") fail("submit", r);
      return { engineResult: String(r.engine_result) };
    },
    async account(address, atLedger) {
      const r = await call("account_info", { account: address, ledger_index: atLedger ?? "validated" });
      if (r.error === "actNotFound") return null;
      if (r.status !== "success") fail("account_info", r);
      const data = r.account_data as Json;
      return { balance: String(data.Balance), sequence: Number(data.Sequence), ownerCount: Number(data.OwnerCount ?? 0) };
    },
    async offerOpen(offerId) {
      const r = await call("ledger_entry", { index: offerId, ledger_index: "validated" });
      if (r.error === "entryNotFound" || r.error === "objectNotFound") return false;
      if (r.status !== "success") fail("ledger_entry", r);
      return true;
    },
    async accountNfts(address, atLedger) {
      const out: { nftId: string; issuer: string; taxon: number; flags: number; transferFee: number; uri: string | null }[] = [];
      let marker: unknown;
      do {
        const r = await call("account_nfts", { account: address, ledger_index: atLedger ?? "validated", limit: 400, ...(marker ? { marker } : {}) });
        if (r.status !== "success") fail("account_nfts", r);
        for (const n of r.account_nfts as Json[]) {
          const nftId = String(n.NFTokenID);
          const parsed = nftIdFlags(nftId);
          out.push({ nftId, issuer: String(n.Issuer), taxon: Number(n.NFTokenTaxon), flags: parsed.flags, transferFee: parsed.transferFee, uri: typeof n.URI === "string" ? n.URI : null });
        }
        marker = r.marker;
      } while (marker);
      return out;
    },
    async nftSellOffers(nftId) {
      const r = await call("nft_sell_offers", { nft_id: nftId, limit: 50, ledger_index: "validated" });
      if (r.error === "objectNotFound") return [];
      if (r.status !== "success") fail("nft_sell_offers", r);
      return (r.offers as Json[]) ?? [];
    },
    async nftInfo(nftId) {
      // Only a Clio server answers this. A paid rippled says so, and the question goes to a public Clio server.
      let r = await call("nft_info", { nft_id: nftId, ledger_index: "validated" });
      if (r.error === "unknownCmd" || r.error === "notSupported") r = await call("nft_info", { nft_id: nftId, ledger_index: "validated" }, opts.clioUrl ?? CLIO_RPC);
      if (r.status !== "success") fail("nft_info", r);
      return { owner: typeof r.owner === "string" ? r.owner : null, burned: r.is_burned === true, uri: typeof r.uri === "string" && r.uri ? Buffer.from(r.uri, "hex").toString("utf8") : null };
    },
    async reserves() {
      const r = await call("server_info");
      const v = (r.info as Json).validated_ledger as Json;
      return { base: String(Math.round(Number(v.reserve_base_xrp) * 1e6)), inc: String(Math.round(Number(v.reserve_inc_xrp) * 1e6)) };
    },
    async xrpUsd() {
      // Best bid and ask for XRP against RLUSD, from the ledger itself: no third party, and no hour-old cache.
      const RLUSD = { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" };
      const side = async (taker_gets: unknown, taker_pays: unknown): Promise<number | null> => {
        const r = await call("book_offers", { taker_gets, taker_pays, limit: 5, ledger_index: "validated" });
        const o = (r.offers as Json[] | undefined)?.[0];
        if (!o) return null;
        const gets = o.TakerGets as string | { value: string };
        const pays = o.TakerPays as string | { value: string };
        const usd = Number(typeof gets === "string" ? (pays as { value: string }).value : gets.value);
        const xrp = Number(typeof gets === "string" ? gets : pays) / 1e6;
        return usd > 0 && xrp > 0 ? usd / xrp : null;
      };
      const [ask, bid] = await Promise.all([side(RLUSD, { currency: "XRP" }), side({ currency: "XRP" }, RLUSD)]);
      if (!ask || !bid) return null;
      // A wide or crossed book isn't a price.
      if (Math.abs(ask - bid) / bid > 0.03) return null;
      return (ask + bid) / 2;
    },
    async ammPool(spec, atLedger) {
      const r = await call("amm_info", { asset: { currency: "XRP" }, asset2: { currency: spec.currency, issuer: spec.issuer }, ledger_index: atLedger });
      if (r.error === "actNotFound") return null;
      if (r.status !== "success") fail("amm_info", r);
      const amm = r.amm as { amount: string; amount2: { value: string } };
      const led = await call("ledger", { ledger_index: atLedger });
      if (led.status !== "success" || led.validated !== true) fail("ledger", led);
      const close = (led.ledger as Json | undefined)?.close_time;
      return { ledger: atLedger, xrpDrops: String(amm.amount), tokenMicro: iouToMicro(amm.amount2.value), closeMs: typeof close === "number" ? (close + 946684800) * 1000 : null };
    },
    async trustLine(account, spec) {
      const r = await call("account_lines", { account, peer: spec.issuer, ledger_index: "validated", limit: 400 });
      if (r.error === "actNotFound") return null;
      if (r.status !== "success") fail("account_lines", r);
      const line = (r.lines as Json[]).find((l) => l.currency === spec.currency);
      if (!line) return null;
      return { balanceMicro: iouToMicro(String(line.balance)), limitMicro: iouToMicro(String(line.limit)), frozen: line.freeze_peer === true };
    },
    async issuerState(issuer) {
      const r = await call("account_info", { account: issuer, ledger_index: "validated" });
      if (r.status !== "success") return null;
      const data = r.account_data as Json;
      const flags = Number(data.Flags ?? 0);
      // lsfGlobalFreeze and lsfAllowTrustLineClawback. TransferRate is absent or 1e9 when there's no fee.
      return { globalFreeze: (flags & 0x00400000) !== 0, clawback: (flags & 0x80000000) !== 0, transferRate: data.TransferRate === undefined || Number(data.TransferRate) === 1_000_000_000 ? 0 : Number(data.TransferRate) };
    },
    async fee() {
      const r = await call("fee");
      const open = Number((r.drops as Json | undefined)?.open_ledger_fee ?? 12);
      // Pay enough to get in under load, and never more than 0.001 XRP on our own.
      return String(Math.min(1000, Math.max(12, Math.ceil(open * 1.2))));
    },
  };
}
