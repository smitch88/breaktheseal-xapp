import { createHash } from "node:crypto";
import type { Chain, ChainTx, Signer, TxLookup } from "../src/lib/rip/types.ts";

/**
 * A small in-memory ledger with the rules that matter here: transactions apply when a ledger closes, sequence numbers and
 * LastLedgerSequence are enforced, balances and reserves are real, NFT offers move NFTs, and resubmitting the same bytes
 * can't apply twice. Ledger hashes are unguessable until the ledger closes.
 */
export const VAULT = "rVAULTvaultVAULTvaultVAULTvault";
export const TREASURY = "rTREASURYtreasuryTREASURYtreas";
export const MINTER = "rMINTERminterMINTERminterMINTER";
export const ISSUER = "rISSUERissuerISSUERissuerISSUER";

const FEE = 12n;
const RESERVE_BASE = 1_000_000n;
const RESERVE_INC = 200_000n;

interface Acct {
  balance: bigint;
  sequence: number;
  owner: number;
}
type Tx = Record<string, unknown> & { TransactionType: string; Account: string; Sequence?: number; LastLedgerSequence?: number; Fee?: string };

export const nftIdFor = (n: number, flags = 8, fee = 5000) => flags.toString(16).padStart(4, "0").toUpperCase() + fee.toString(16).padStart(4, "0").toUpperCase() + createHash("sha256").update(`nft${n}`).digest("hex").slice(0, 56).toUpperCase();

export function testLedger(seedText = "seed", networkId = 1, startLedger = 100) {
  const accounts = new Map<string, Acct>();
  const nfts = new Map<string, string>(); // id -> owner
  const offers = new Map<string, { nftId: string; owner: string; dest: string | null; amount?: bigint; isBuy?: boolean }>();
  const uris = new Map<string, string>();
  let listings = 0;
  const authorizedMinter = new Map<string, string>();
  const burnable = new Map<string, string>();
  /** token -> holder -> [balance, limit], whole tokens. The issuer is whoever the spec names; a Payment needs a line at the far end. */
  const lines = new Map<string, Map<string, { balance: bigint; limit: bigint; frozen: boolean }>>();
  const pools = new Map<string, Map<number, { xrpDrops: string; tokenMicro: string }>>();
  const issuers = new Map<string, { globalFreeze: boolean; transferRate: number; clawback: boolean }>();
  let poolDown = false;
  const refusing = new Map<string, string>();
  const refusingOffers = new Map<string, string>();
  const lineOf = (key: string, holder: string) => lines.get(key)?.get(holder) ?? null;
  let minted = 0;
  const offerOwners = new Map<string, string>();
  const history: ChainTx[] = [];
  const hashes = new Map<number, string>();
  let ledger = startLedger;
  let queue: { hash: string; tx: Tx; delivered?: bigint }[] = [];
  const applied = new Set<string>();
  const submitted: string[] = [];
  const hashOf = (blob: string) => createHash("sha256").update(blob).digest("hex").toUpperCase();

  const acct = (a: string) => accounts.get(a);
  const fund = (a: string, xrp: number) => {
    const cur = accounts.get(a);
    if (cur) cur.balance += BigInt(xrp) * 1_000_000n;
    else accounts.set(a, { balance: BigInt(xrp) * 1_000_000n, sequence: 1, owner: 0 });
  };
  hashes.set(startLedger, createHash("sha256").update(`${seedText}|${startLedger}`).digest("hex").toUpperCase());

  const applyTx = (hash: string, tx: Tx, index: number): ChainTx | null => {
    const a = accounts.get(tx.Account);
    if (!a) return null;
    if (tx.LastLedgerSequence !== undefined && ledger > tx.LastLedgerSequence) return null;
    if (tx.Sequence !== undefined && tx.Sequence !== a.sequence) return null;
    const fee = BigInt(tx.Fee ?? FEE.toString());
    a.balance -= fee;
    a.sequence += 1;
    const out = (result: string, delivered: unknown = null, offerId: string | null = null): ChainTx => ({ hash, ledger, txIndex: index, result, tx, delivered, offerId });
    switch (tx.TransactionType) {
      case "TrustSet": {
        const l = tx.LimitAmount as { currency: string; issuer: string; value: string };
        const key = `${l.currency}:${l.issuer}`;
        const book = lines.get(key) ?? new Map();
        lines.set(key, book);
        const cur = book.get(tx.Account);
        if (cur) cur.limit = BigInt(l.value);
        else {
          book.set(tx.Account, { balance: 0n, limit: BigInt(l.value), frozen: false });
          a.owner += 1;
        }
        return out("tesSUCCESS");
      }
      case "Payment": {
        const refused = refusing.get(String(tx.Destination));
        if (refused) return out(refused);
        if (typeof tx.Amount === "object" && tx.Amount !== null) {
          const amt = tx.Amount as { currency: string; issuer: string; value: string };
          const key = `${amt.currency}:${amt.issuer}`;
          const value = BigInt(amt.value);
          const from = lineOf(key, tx.Account);
          const to = lineOf(key, String(tx.Destination));
          if (!to) return out("tecPATH_DRY");
          if (!from || from.balance < value) return out("tecPATH_PARTIAL");
          if (to.limit - to.balance < value || to.frozen || from.frozen) return out("tecPATH_DRY");
          from.balance -= value;
          to.balance += value;
          return out("tesSUCCESS", amt);
        }
        const amount = BigInt(String(tx.Amount));
        const dest = String(tx.Destination);
        const reserve = RESERVE_BASE + RESERVE_INC * BigInt(a.owner);
        if (a.balance < amount + reserve) return out("tecUNFUNDED_PAYMENT");
        if (!accounts.has(dest) && amount < RESERVE_BASE) return out("tecNO_DST_INSUF_XRP");
        a.balance -= amount;
        fund(dest, 0);
        (accounts.get(dest) as Acct).balance += amount;
        return out("tesSUCCESS", amount.toString());
      }
      case "AccountSet":
        return out("tesSUCCESS");
      case "NFTokenCreateOffer": {
        const nftId = String(tx.NFTokenID);
        if (tx.Owner) {
          // A buy offer on someone else's NFT. Nothing moves until a broker matches it, and an open one holds a reserve.
          if (nfts.get(nftId) !== tx.Owner) return out("tecNO_ENTRY");
          const id = createHash("sha256").update(`offer${hash}`).digest("hex").toUpperCase();
          offers.set(id, { nftId, owner: tx.Account, dest: (tx.Destination as string) ?? null, amount: BigInt(String(tx.Amount)), isBuy: true });
          a.owner += 1;
          return out("tesSUCCESS", null, id);
        }
        if (nfts.get(nftId) !== tx.Account) return out("tecNO_ENTRY");
        const refused = refusingOffers.get(String(tx.Destination));
        if (refused) return out(refused);
        const id = createHash("sha256").update(`offer${hash}`).digest("hex").toUpperCase();
        offers.set(id, { nftId, owner: tx.Account, dest: (tx.Destination as string) ?? null });
        a.owner += 1;
        return out("tesSUCCESS", null, id);
      }
      case "NFTokenMint": {
        const issuer = String(tx.Issuer ?? tx.Account);
        if (issuer !== tx.Account && authorizedMinter.get(issuer) !== tx.Account) return out("tecNO_PERMISSION");
        // The offer in a mint goes through the same check as NFTokenCreateOffer, so a wallet refusing offers fails the mint.
        const mintRefused = refusingOffers.get(String(tx.Destination));
        if (mintRefused) return out(mintRefused);
        const nftId = nftIdFor(100_000 + ++minted, Number(tx.Flags ?? 0), Number(tx.TransferFee ?? 0));
        nfts.set(nftId, tx.Account);
        burnable.set(nftId, issuer);
        a.owner += 1;
        const offerId = createHash("sha256").update(`mintoffer${hash}`).digest("hex").toUpperCase();
        offers.set(offerId, { nftId, owner: tx.Account, dest: (tx.Destination as string) ?? null });
        return { ...out("tesSUCCESS", null, offerId), nftId };
      }
      case "NFTokenBurn": {
        const nftId = String(tx.NFTokenID);
        const owner = String(tx.Owner ?? tx.Account);
        if (nfts.get(nftId) !== owner) return out("tecNO_ENTRY");
        const issuer = burnable.get(nftId);
        if (owner !== tx.Account && !(parseInt(nftId.slice(0, 4), 16) & 1 && (issuer === tx.Account || authorizedMinter.get(issuer ?? "") === tx.Account))) return out("tecNO_PERMISSION");
        nfts.delete(nftId);
        for (const [id, o] of offers) if (o.nftId === nftId) offers.delete(id);
        return out("tesSUCCESS");
      }
      case "NFTokenCancelOffer": {
        // The real rule: an offer that's already gone is skipped, and the transaction still succeeds.
        const list = (tx.NFTokenOffers as string[]).filter((o) => offers.has(o));
        list.forEach((o) => offers.delete(o));
        a.owner -= list.length;
        return { ...out("tesSUCCESS"), deletedOffers: list };
      }
      case "NFTokenAcceptOffer": {
        const id = String(tx.NFTokenSellOffer);
        const o = offers.get(id);
        if (!o || (o.dest && o.dest !== tx.Account)) return out("tecNO_ENTRY");
        // An old owner's offer outlives the sale and can never fill.
        if (nfts.get(o.nftId) !== o.owner) return out("tecNO_PERMISSION");
        if (o.amount) {
          if (a.balance < o.amount + RESERVE_BASE + RESERVE_INC * BigInt(a.owner)) return out("tecINSUFFICIENT_FUNDS");
          a.balance -= o.amount;
          fund(o.owner, 0);
          (accounts.get(o.owner) as Acct).balance += o.amount;
        }
        nfts.set(o.nftId, tx.Account);
        offerOwners.set(id, o.owner);
        offers.delete(id);
        const seller = accounts.get(o.owner) as Acct;
        if (seller.owner > 0) seller.owner -= 1;
        return out("tesSUCCESS");
      }
      default:
        return out("temUNKNOWN");
    }
  };

  const chain: Chain = {
    networkId: async () => networkId,
    validatedLedger: async () => ledger,
    ledgerHash: async (seq) => {
      const h = hashes.get(seq);
      if (!h) throw new Error(`ledger ${seq} hasn't closed`);
      return h;
    },
    accountTx: async (account, from) => history.filter((t) => t.ledger >= from && (t.tx.Account === account || t.tx.Destination === account || (t.tx.TransactionType === "NFTokenAcceptOffer" && t.tx.__touches === account))),
    tx: async (hash): Promise<TxLookup> => {
      const t = history.find((x) => x.hash === hash);
      return t ? { found: true, validated: true, tx: t } : { found: false, definite: true };
    },
    submit: async (blob) => {
      const hash = hashOf(blob);
      submitted.push(hash);
      if (applied.has(hash) || queue.some((q) => q.hash === hash)) return { engineResult: "tefALREADY" };
      queue.push({ hash, tx: JSON.parse(blob) as Tx });
      return { engineResult: "tesSUCCESS" };
    },
    account: async (a) => {
      const x = accounts.get(a);
      return x ? { balance: x.balance.toString(), sequence: x.sequence, ownerCount: x.owner } : null;
    },
    offerOpen: async (id) => offers.has(id),
    accountNfts: async (a) => [...nfts.entries()].filter(([, o]) => o === a).map(([nftId]) => ({ nftId, issuer: "rISSUER", taxon: 0, flags: parseInt(nftId.slice(0, 4), 16), transferFee: parseInt(nftId.slice(4, 8), 16), uri: null })),
    nftSellOffers: async (nftId) => [...offers.entries()].filter(([, o]) => o.nftId === nftId && !o.isBuy && o.amount).map(([index, o]) => ({ nft_offer_index: index, amount: String(o.amount), owner: o.owner, ...(o.dest ? { destination: o.dest } : {}) })),
    nftInfo: async (nftId) => ({ owner: nfts.get(nftId) ?? null, burned: !nfts.has(nftId), uri: uris.get(nftId) ?? null }),
    reserves: async () => ({ base: RESERVE_BASE.toString(), inc: RESERVE_INC.toString() }),
    fee: async () => FEE.toString(),
    ammPool: async (spec, atLedger) => {
      if (poolDown) throw new Error("server can't answer");
      const hist = pools.get(`${spec.currency}:${spec.issuer}`);
      if (!hist) return null;
      let best: { xrpDrops: string; tokenMicro: string } | null = null;
      for (const k of [...hist.keys()].sort((a, b) => a - b)) if (k <= atLedger) best = hist.get(k) as { xrpDrops: string; tokenMicro: string };
      best ??= hist.get(Math.min(...hist.keys())) as { xrpDrops: string; tokenMicro: string };
      return { ledger: atLedger, xrpDrops: best.xrpDrops, tokenMicro: best.tokenMicro, closeMs: Date.now() };
    },
    trustLine: async (account, spec) => {
      const l = lineOf(`${spec.currency}:${spec.issuer}`, account);
      return l ? { balanceMicro: (l.balance * 1_000_000n).toString(), limitMicro: (l.limit * 1_000_000n).toString(), frozen: l.frozen } : null;
    },
    issuerState: async (issuer) => issuers.get(issuer) ?? { globalFreeze: false, transferRate: 0, clawback: false },
  };

  return {
    chain,
    fund,
    /** Set the XRP/token pool from this ledger on. */
    setPool(spec: { currency: string; issuer: string }, xrpDrops: string, tokenMicro: string, from = ledger) {
      const key = `${spec.currency}:${spec.issuer}`;
      const hist = pools.get(key) ?? new Map();
      hist.set(from, { xrpDrops, tokenMicro });
      pools.set(key, hist);
    },
    /** A wallet whose own settings refuse every payment, as Deposit Auth or a required tag would. */
    refusePayments(address: string, result: string | null) {
      if (result) refusing.set(address, result);
      else refusing.delete(address);
    },
    /** A wallet that turns away NFT offers, as lsfDisallowIncomingNFTokenOffer does. */
    refuseOffers(address: string, result: string | null) {
      if (result) refusingOffers.set(address, result);
      else refusingOffers.delete(address);
    },
    setPoolDown(down: boolean) {
      poolDown = down;
    },
    setIssuer(issuer: string, state: { globalFreeze: boolean; transferRate: number; clawback: boolean }) {
      issuers.set(issuer, state);
    },
    /** Give an account a trust line and a balance directly, as funding would. */
    setLine(spec: { currency: string; issuer: string }, holder: string, balance: bigint, limit = 10n ** 15n) {
      const key = `${spec.currency}:${spec.issuer}`;
      const book = lines.get(key) ?? new Map();
      lines.set(key, book);
      book.set(holder, { balance, limit, frozen: false });
    },
    /** Remove a trust line, as a player could. */
    dropLine(spec: { currency: string; issuer: string }, holder: string) {
      lines.get(`${spec.currency}:${spec.issuer}`)?.delete(holder);
    },
    tokenBalance: (spec: { currency: string; issuer: string }, holder: string) => lineOf(`${spec.currency}:${spec.issuer}`, holder)?.balance ?? null,
    mintTo: (nftId: string, owner: string) => nfts.set(nftId, owner),
    /** A real listing on the market: the seller holds the NFT and offers it at this price, through a broker or to anyone. Returns the offer's index. */
    listNft(nftId: string, seller: string, drops: number | bigint, opts: { destination?: string; uri?: string } = {}) {
      fund(seller, 0);
      if (!nfts.has(nftId)) nfts.set(nftId, seller);
      uris.set(nftId, opts.uri ?? `ipfs://meta/${nftId}.json`);
      const index = createHash("sha256").update(`listing${++listings}${nftId}`).digest("hex").toUpperCase();
      offers.set(index, { nftId, owner: seller, dest: opts.destination ?? null, amount: BigInt(drops) });
      return index;
    },
    /** The broker matching a buy offer against the holder's listing, as the mainnet one does. The buyer pays the buy offer, the seller gets the listing, the broker the gap. */
    brokerFill(buyOfferId: string) {
      const buy = offers.get(buyOfferId);
      if (!buy?.isBuy || !buy.amount) throw new Error("no such buy offer");
      const [sellId, sell] = [...offers.entries()].find(([, o]) => o.nftId === buy.nftId && !o.isBuy && o.amount && nfts.get(o.nftId) === o.owner) ?? [];
      if (!sellId || !sell?.amount) throw new Error("no live listing to match");
      const buyer = accounts.get(buy.owner) as Acct;
      buyer.balance -= buy.amount;
      (accounts.get(sell.owner) as Acct).balance += sell.amount;
      fund(String(buy.dest), 0);
      (accounts.get(String(buy.dest)) as Acct).balance += buy.amount - sell.amount;
      buyer.owner -= 1;
      nfts.set(buy.nftId, buy.owner);
      offers.delete(buyOfferId);
      offers.delete(sellId);
    },
    /** Moves an NFT without a sale, as the owner's own hand or an issuer's burn might. */
    moveNft: (nftId: string, owner: string | null) => (owner ? nfts.set(nftId, owner) : nfts.delete(nftId)),
    /** The account's balance, set outright: for a treasury run short by something this ledger doesn't model. */
    setBalance(address: string, xrp: number) {
      const a = acct(address);
      if (a) a.balance = BigInt(xrp) * 1_000_000n;
    },
    authorize: (issuer: string, minter: string) => authorizedMinter.set(issuer, minter),
    /** Every NFT that exists right now, for checking that nothing is minted twice. */
    allNfts: () => [...nfts.keys()],
    ownerOf: (nftId: string) => nfts.get(nftId) ?? null,
    balance: (a: string) => acct(a)?.balance ?? 0n,
    ledger: () => ledger,
    offers,
    history,
    submitted,
    /** A player's own transaction, as a wallet would submit it. */
    userSubmit(tx: Tx) {
      const a = accounts.get(tx.Account);
      const stamped = { ...tx, Sequence: a?.sequence ?? 1, Fee: "12" };
      const blob = JSON.stringify(stamped);
      queue.push({ hash: hashOf(blob), tx: stamped });
      return hashOf(blob);
    },
    /** Like userSubmit, but ahead of whatever is already queued for the next ledger. */
    queueFirst(tx: Tx) {
      const a = accounts.get(tx.Account);
      const stamped = { ...tx, Sequence: a?.sequence ?? 1, Fee: "12" };
      const blob = JSON.stringify(stamped);
      queue.unshift({ hash: hashOf(blob), tx: stamped });
    },
    /** Close one ledger: everything queued applies, in order. */
    close(n = 1) {
      for (let k = 0; k < n; k++) {
        ledger += 1;
        hashes.set(ledger, createHash("sha256").update(`${seedText}|${ledger}`).digest("hex").toUpperCase());
        const q = queue;
        queue = [];
        let i = 0;
        for (const item of q) {
          if (applied.has(item.hash)) continue;
          const t = applyTx(item.hash, item.tx, i);
          if (t) {
            applied.add(item.hash);
            if (t.tx.TransactionType === "NFTokenAcceptOffer") (t.tx as Record<string, unknown>).__touches = offerOwners.get(String(t.tx.NFTokenSellOffer)) ?? VAULT;
            history.push(t);
            i++;
          }
          // Not applied and not expired: a real server would hold it. Here it simply goes back in the queue.
          else if (item.tx.LastLedgerSequence === undefined || ledger <= item.tx.LastLedgerSequence) queue.push(item);
        }
      }
    },
  };
}

export function testSigner(): Signer {
  const addresses = { treasury: TREASURY, vault: VAULT, minter: MINTER };
  return {
    address: (role) => addresses[role],
    sign(_role, tx) {
      const blob = JSON.stringify(tx);
      return { blob, hash: createHash("sha256").update(blob).digest("hex").toUpperCase() };
    },
  };
}
