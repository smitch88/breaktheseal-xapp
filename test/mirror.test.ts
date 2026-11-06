import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { GatewayRefused, cardSellMicro, simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { MIRROR_FLAGS, createEngine } from "../src/lib/rip/engine.ts";
import { memoryStore, type EventStore } from "../src/lib/rip/store.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { ISSUER, MINTER, TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
const BUYER = "rBUYERbuyerBUYERbuyerBUYERbuyer";
const RATE = 1.25;
const mirror = { issuer: ISSUER, transferFee: 2000, taxon: 1, origin: "https://example.test" };

function setup(opts: { gateway?: CardGateway; store?: EventStore; treasuryXrp?: number } = {}) {
  const ledger = testLedger();
  for (const [a, x] of [[TREASURY, opts.treasuryXrp ?? 500], [VAULT, 50], [MINTER, 50], [ISSUER, 50], [PLAYER, 500], [BUYER, 100]] as const) ledger.fund(a, x);
  ledger.authorize(ISSUER, MINTER);
  const store = opts.store ?? memoryStore();
  const gateway = opts.gateway ?? simulatedGateway();
  const make = (extra: Partial<Parameters<typeof createEngine>[0]> = {}) => createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, gateway, mirror, ...extra });
  return { ledger, store, gateway, make, engine: make() };
}

async function run(engine: ReturnType<typeof createEngine>, ledger: ReturnType<typeof testLedger>, passes = 4) {
  for (let i = 0; i < passes; i++) {
    await engine.advance();
    ledger.close();
    await engine.advance();
  }
}

/** The wallet approves the address on the ledger, then the card can start to ship. */
async function signedShip(engine: ReturnType<typeof createEngine>, ledger: ReturnType<typeof testLedger>, by: string, id: string, hash: string) {
  const asked = await engine.shipAuthorization(by, id, hash);
  if (!asked.ok) return asked;
  ledger.userSubmit(asked.tx as never);
  ledger.close();
  return engine.shipCard(by, id, hash, asked.fromLedger);
}

async function pull(engine: ReturnType<typeof createEngine>, ledger: ReturnType<typeof testLedger>) {
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(q.ok, JSON.stringify(q));
  ledger.userSubmit(q.tx as never);
  await run(engine, ledger, 4);
  return q.order.id;
}

test("the sell-back rule is the one the card pages show: $14 at 85%, less the 2% sell fee, pays $11.66", () => {
  assert.equal(cardSellMicro("14000000", 85), 11_660_000n);
  fc.assert(fc.property(fc.integer({ min: 1, max: 5_000_000_000 }), fc.integer({ min: 1, max: 100 }), (ins, pct) => cardSellMicro(String(ins), pct) <= BigInt(ins)));
});

test("a mirror is issued only after payment and a custody proof, with the right flags, and is free to accept", async () => {
  const { ledger, engine, store } = setup();
  await engine.advance();
  await engine.openSeason(5, "4000000").catch(() => {});
  const id = await pull(engine, ledger);
  const card = engine.state.cards.get(id)!;
  assert.equal(card.status, "held");
  assert.equal(card.hold, "stashed");
  assert.equal(card.mirror, null, "nothing is minted just for pulling");
  assert.deepEqual(ledger.allNfts(), []);

  assert.deepEqual(await engine.claimCard(PLAYER, id), { ok: true });
  await run(engine, ledger, 2);
  const offered = engine.state.cards.get(id)!;
  assert.equal(offered.hold, "offered");
  assert.equal(parseInt(offered.mirror!.nftId.slice(0, 4), 16), MIRROR_FLAGS);
  assert.equal(parseInt(offered.mirror!.nftId.slice(4, 8), 16), 2000);
  const before = ledger.balance(PLAYER);
  ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offered.mirror!.offerId });
  await run(engine, ledger, 2);
  assert.equal(engine.state.cards.get(id)!.hold, "mirrored");
  assert.equal(ledger.ownerOf(offered.mirror!.nftId), PLAYER);
  assert.equal(ledger.balance(PLAYER), before - 12n, "only the network fee");
  const r = replayLog(await store.readFrom(0));
  assert.ok(r.ok, JSON.stringify(r));
});

test("no custody proof means no mirror: a card that left custody can't be minted", async () => {
  const base = simulatedGateway();
  const gateway: CardGateway = { ...base, prove: async (m) => ({ ...(await base.prove(m)), held: false }) };
  const { ledger, engine } = setup({ gateway });
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(q.ok);
  ledger.userSubmit(q.tx as never);
  await run(engine, ledger, 6);
  const c = engine.state.cards.get(q.order.id)!;
  assert.equal(c.status, "opened", "stays unproven");
  assert.equal(c.hold, null);
  assert.equal((await engine.claimCard(PLAYER, c.id)).ok, false);
  assert.deepEqual(ledger.allNfts(), []);
});

test("selling a mirrored card burns the mirror, sells the card once, then pays XRP once to the wallet that holds it", async () => {
  const { ledger, engine, store, gateway } = setup();
  const id = await pull(engine, ledger);
  await engine.claimCard(PLAYER, id);
  await run(engine, ledger, 2);
  const offered = engine.state.cards.get(id)!;
  ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offered.mirror!.offerId });
  await run(engine, ledger, 2);

  // The mirror changes hands on the market. The old holder loses every right; the new one inherits them.
  const nftId = offered.mirror!.nftId;
  ledger.mintTo(nftId, BUYER);
  assert.equal((await engine.cardSellPrice(PLAYER, id, RATE)).ok, false, "a former holder is refused");
  assert.equal((await engine.claimCard(PLAYER, id)).ok, false);
  const quote = await engine.cardSellPrice(BUYER, id, RATE);
  assert.ok(quote.ok);
  const before = ledger.balance(BUYER);
  assert.deepEqual(await engine.sellCard(BUYER, id, quote), { ok: true });
  assert.deepEqual(await engine.sellCard(BUYER, id, quote), { ok: true }, "a repeat is the same sale");
  await run(engine, ledger, 5);
  const sold = engine.state.cards.get(id)!;
  assert.equal(sold.hold, "sold");
  assert.equal(sold.mirror, null);
  assert.equal(ledger.ownerOf(nftId), null, "burned");
  assert.equal(ledger.balance(BUYER), before + BigInt(quote.drops));
  assert.equal(ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Destination === BUYER).length, 1);
  assert.equal((await gateway.prove(sold.mint!)).held, false, "the card went back to the provider");
  assert.ok(replayLog(await store.readFrom(0)).ok);
});

test("shipping retires the mirror and queues the card; the address hash, never the address, reaches the log", async () => {
  const { ledger, engine, store } = setup();
  const id = await pull(engine, ledger);
  await engine.claimCard(PLAYER, id);
  await run(engine, ledger, 2);
  const offered = engine.state.cards.get(id)!;
  const nftId = offered.mirror!.nftId;
  ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offered.mirror!.offerId });
  await run(engine, ledger, 2);
  assert.deepEqual(await signedShip(engine, ledger, PLAYER, id, "hash-of-address"), { ok: true });
  await run(engine, ledger, 3);
  const c = engine.state.cards.get(id)!;
  assert.equal(c.hold, "ship_queue");
  assert.equal(ledger.ownerOf(nftId), null);
  await engine.markShipped(id, "operator", "TRACK1");
  assert.equal(engine.state.cards.get(id)!.hold, "shipped");
  assert.ok(!JSON.stringify(await store.readFrom(0)).includes("Street"));
});

test("selling a card with no mirror needs no burn; it can't be claimed afterward", async () => {
  const { ledger, engine } = setup();
  const id = await pull(engine, ledger);
  const q = await engine.cardSellPrice(PLAYER, id, RATE);
  assert.ok(q.ok);
  await engine.sellCard(PLAYER, id, q);
  await run(engine, ledger, 4);
  assert.equal(engine.state.cards.get(id)!.hold, "sold");
  assert.equal(ledger.allNfts().length, 0);
  assert.equal((await engine.claimCard(PLAYER, id)).ok, false);
});

test("an unaccepted offer can still exit: the burn removes the offer with the mirror", async () => {
  const { ledger, engine } = setup();
  const id = await pull(engine, ledger);
  await engine.claimCard(PLAYER, id);
  await run(engine, ledger, 2);
  assert.equal(ledger.offers.size, 1);
  const q = await engine.cardSellPrice(PLAYER, id, RATE);
  assert.ok(q.ok);
  await engine.sellCard(PLAYER, id, q);
  await run(engine, ledger, 4);
  assert.equal(engine.state.cards.get(id)!.hold, "sold");
  assert.equal(ledger.offers.size, 0);
});

test("a stalled paid card reaches a person, and a refunded card can't also be sold", async () => {
  const base = simulatedGateway();
  let t = Date.parse("2026-11-01T00:00:00Z");
  const gateway: CardGateway = { ...base, open: async () => null };
  const { ledger, make } = setup({ gateway });
  const engine = make({ now: () => new Date(t) });
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(q.ok);
  ledger.userSubmit(q.tx as never);
  await run(engine, ledger, 5);
  assert.equal(engine.state.cards.get(q.order.id)!.status, "source_paid", "the provider hasn't revealed");
  t += 31 * 60_000;
  await run(engine, ledger, 2);
  assert.equal(engine.state.cards.get(q.order.id)!.review, "stalled_at_source_paid");
  await engine.resolveCard(q.order.id, "operator", "refund");
  await run(engine, ledger, 3);
  const c = engine.state.cards.get(q.order.id)!;
  assert.equal(c.status, "refunded");
  assert.equal(c.hold, null);
  assert.equal((await engine.cardSellPrice(PLAYER, c.id, RATE)).ok, false);
});

test("a lost answer from the provider never buys a second pack, and a lost answer or a clear refusal refunds whole: nothing was signed", async () => {
  const calls: string[] = [];
  let mode: "refuse" | "lost" | null = "lost";
  const base = simulatedGateway({ failNext: () => mode });
  const gateway: CardGateway = {
    ...base,
    generate: async (c, r) => {
      calls.push(r);
      return base.generate(c, r);
    },
  };
  const { ledger, engine } = setup({ gateway });
  await engine.advance();
  const before = ledger.balance(PLAYER);
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(q.ok);
  ledger.userSubmit(q.tx as never);
  await run(engine, ledger, 5);
  assert.equal(engine.state.cards.get(q.order.id)!.status, "refunded");
  assert.equal(calls.length, 1, "asked once");
  assert.equal(ledger.balance(PLAYER), before - 12n);

  mode = "refuse";
  const again = ledger.balance(PLAYER);
  const r = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(r.ok);
  ledger.userSubmit(r.tx as never);
  await run(engine, ledger, 5);
  assert.equal(engine.state.cards.get(r.order.id)!.status, "refunded");
  assert.equal(ledger.balance(PLAYER), again - 12n);
  assert.equal(calls.length, 2);
});

test("card orders can't outrun the float, and wrong payments come back", async () => {
  const { ledger, engine } = setup({ gateway: simulatedGateway({ floatMicro: 30_000_000n }) });
  await engine.advance();
  const a = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
  assert.ok(a.ok);
  const b = await engine.createCardOrder(BUYER, "pokemon_25", RATE);
  assert.equal(b.ok, false, "$30 of float can't cover two $25 packs");
  const before = ledger.balance(PLAYER);
  ledger.userSubmit({ ...(a.tx as object), Amount: "1000000" } as never);
  await run(engine, ledger, 3);
  assert.equal(ledger.balance(PLAYER), before - 12n);
  assert.equal(engine.state.cards.get(a.order.id)!.status, "quoted");
});

test("crash anywhere in the card line: never two mirrors, never two sales, every paid card ends somewhere known", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.nat(40), { minLength: 1, maxLength: 12 }), fc.array(fc.constantFrom("pay", "claim", "accept", "sell", "ship", "none"), { minLength: 4, maxLength: 12 }), async (crashAt, moves) => {
      const inner = memoryStore();
      let ticks = 0;
      const plan = new Set(crashAt);
      const maybe = () => {
        if (plan.delete(++ticks)) throw new Error("crash");
      };
      const store: EventStore = {
        readFrom: (a) => inner.readFrom(a),
        append: async (h, ev) => {
          maybe();
          const ok = await inner.append(h, ev);
          maybe();
          return ok;
        },
      };
      const gateway = simulatedGateway();
      const sim = setup({ store: inner, gateway });
      const { ledger } = sim;
      const chain = {
        ...ledger.chain,
        submit: async (blob: string) => {
          maybe();
          const r = await ledger.chain.submit(blob);
          maybe();
          return r;
        },
      };
      const fresh = () => createEngine({ store, chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, gateway, mirror });
      let engine = fresh();
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch {
          engine = fresh();
        }
      };
      await attempt(() => engine.advance());
      for (const move of moves) {
        await attempt(() => engine.advance());
        ledger.close();
        const held = [...engine.state.cards.values()];
        const stash = held.find((c) => c.hold === "stashed");
        const offered = held.find((c) => c.hold === "offered");
        const mirrored = held.find((c) => c.hold === "mirrored");
        if (move === "pay") await attempt(async () => {
          const q = await engine.createCardOrder(PLAYER, "pokemon_25", RATE);
          if (q.ok && q.order.status === "quoted" && q.order.createdLedger === ledger.ledger()) ledger.userSubmit(q.tx as never);
        });
        else if (move === "claim" && stash) await attempt(() => engine.claimCard(PLAYER, stash.id));
        else if (move === "accept" && offered) ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: offered.mirror!.offerId });
        else if (move === "sell" && (mirrored ?? stash)) await attempt(async () => {
          const id = (mirrored ?? stash)!.id;
          const q = await engine.cardSellPrice(PLAYER, id, RATE);
          if (q.ok) await engine.sellCard(PLAYER, id, q);
        });
        else if (move === "ship" && (mirrored ?? stash)) await attempt(() => signedShip(engine, ledger, PLAYER, (mirrored ?? stash)!.id, "h"));
      }
      plan.clear();
      // Later on, with the wait for a lost answer over.
      engine = createEngine({ store, chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, gateway, mirror, now: () => new Date(Date.now() + 3 * 60_000) });
      for (let i = 0; i < 10; i++) {
        await engine.advance();
        ledger.close();
      }
      const cards = [...engine.state.cards.values()];
      for (const c of cards) {
        assert.ok(["quoted", "expired", "held", "review", "refunded", "opened", "refund_due"].includes(c.status), `ended ${c.status}`);
        assert.ok(c.everMinted <= 2, "minted more than a claim-burn-claim could");
      }
      const mints = ledger.history.filter((t) => t.tx.TransactionType === "NFTokenMint" && t.result === "tesSUCCESS");
      const byCard = new Map<string, number>();
      for (const t of mints) {
        const k = JSON.stringify(t.tx.URI);
        byCard.set(k, (byCard.get(k) ?? 0) + 1);
      }
      for (const [k, n] of byCard) assert.equal(n, 1, `minted twice: ${k}`);
      // Exits are one-way, and a sale pays once.
      const paid = new Map<string, number>();
      for (const t of ledger.history) {
        if (t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.result === "tesSUCCESS") {
          const k = JSON.stringify(t.tx.Memos);
          paid.set(k, (paid.get(k) ?? 0) + 1);
        }
      }
      for (const [k, n] of paid) assert.equal(n, 1, `paid twice: ${k}`);
      for (const c of cards) if (c.mirror) assert.ok(ledger.ownerOf(c.mirror.nftId), "a live mirror exists on the ledger");
      const replay = replayLog(await inner.readFrom(0));
      assert.ok(replay.ok, JSON.stringify(replay));
      void GatewayRefused;
      return true;
    }),
    { numRuns: 40 },
  );
});
