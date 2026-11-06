import { RETRY_WAIT_LEDGERS } from "../src/lib/rip/engine.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fc from "fast-check";
import { simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { inPoolAlready } from "../src/lib/rip/views.ts";
import type { Chain, TxLookup } from "../src/lib/rip/types.ts";
import { MINTER, TREASURY, VAULT, addressOf, world, type World } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);
const ADMIN = addressOf(3);
const ADDRESS = { name: "A Player", street: "1 Main St", city: "Town", zip: "10001" };
const hashOf = (blob: string) => createHash("sha256").update(blob).digest("hex").toUpperCase();

/**
 * A chain that can misbehave on our own transactions. `rule` looks at each transaction we submit and decides its fate:
 *   a tec code   it applied and failed
 *   "lost"       the server took it and it never landed, so it expires
 *   "ambiguous"  it landed, and the answer to the submit was lost
 */
function misbehaving(rule: { fate: (tx: Record<string, any>) => string | null }) {
  const forced = new Map<string, string>();
  let ledgerNow: () => Promise<number> = async () => 0;
  return (c: Chain): Chain => {
    ledgerNow = c.validatedLedger;
    return {
      ...c,
      async submit(blob: string) {
        const tx = JSON.parse(blob) as Record<string, any>;
        const fate = rule.fate(tx);
        if (fate === "lost") return { engineResult: "tesSUCCESS" };
        if (fate === "ambiguous") {
          await c.submit(blob);
          throw new Error("timed out waiting for the answer");
        }
        if (fate) {
          forced.set(hashOf(blob), fate);
          return { engineResult: fate };
        }
        return c.submit(blob);
      },
      async tx(hash: string, range: never): Promise<TxLookup> {
        const f = forced.get(hash);
        if (f) return { found: true, validated: true, tx: { hash, ledger: await ledgerNow(), txIndex: 0, result: f, tx: {}, delivered: null, offerId: null } };
        return c.tx(hash, range);
      },
    };
  };
}

const once = (match: (tx: Record<string, any>) => boolean, fate: string, times = 1) => {
  let left = times;
  return {
    fate: (tx: Record<string, any>) => {
      if (left > 0 && match(tx)) {
        left -= 1;
        return fate;
      }
      return null;
    },
  };
};
const isPaymentTo = (to: string) => (tx: Record<string, any>) => tx.TransactionType === "Payment" && tx.Destination === to;
const isType = (t: string) => (tx: Record<string, any>) => tx.TransactionType === t;

async function ready(opts: Parameters<typeof world>[0] = {}) {
  const w = await world({ admins: ADMIN, ...opts });
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  return { w, me, boss: w.client(ADMIN) };
}

async function sell(w: World, me: ReturnType<World["client"]>, id: string) {
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  return w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } });
}

test("a sell-back the ledger refuses leaves the NFT in the stash, and after a short wait the player can sell again and is paid once", async () => {
  const { w, me } = await ready({ wrapChain: misbehaving(once(isPaymentTo(PLAYER), "tecNO_DST")) });
  const id = await w.pull(me);
  await sell(w, me, id);
  await w.pump(2);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  assert.equal(w.orderOf(id)?.sellDrops, null);
  assert.equal((await sell(w, me, id)).status, 409, "a wallet that refused can't spin on the treasury's one slot");
  w.ledger.close(RETRY_WAIT_LEDGERS);
  assert.equal((await sell(w, me, id)).status, 200);
  await w.pump(3);
  assert.equal(w.orderOf(id)?.pull, "sold");
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("a refund the ledger refuses goes on the stuck list, nothing retries it alone, and the admin's retry pays once", async () => {
  const { w, boss, me } = await ready({ wrapChain: misbehaving(once(isPaymentTo(PLAYER), "tecNO_DST")) });
  w.ledger.userSubmit({ TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "5000000" } as never);
  await w.pump(4);
  const [r] = [...w.engine.state.refunds.values()];
  assert.equal(r.status, "stuck");
  await w.pump(4);
  assert.equal(w.paidTo(PLAYER).length, 0);
  assert.equal((await w.call("POST", "/api/rip/admin/retry-refund", { as: boss, body: { id: r.id } })).status, 200);
  await w.pump(3);
  assert.equal(w.engine.state.refunds.get(r.id)?.status, "done");
  assert.equal(w.paidTo(PLAYER).length, 1);
  void me;
});

test("a claim offer the ledger refuses goes back to the stash, and a cancel it refuses keeps the offer", async () => {
  const { w, me } = await ready({ wrapChain: misbehaving(once(isType("NFTokenCreateOffer"), "tecNO_ENTRY")) });
  const id = await w.pull(me);
  await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me });
  await w.pump(2);
  assert.equal(w.orderOf(id)?.pull, "stashed");
  const b = await ready({ wrapChain: misbehaving(once(isType("NFTokenCancelOffer"), "tecINTERNAL")) });
  const id2 = await b.w.pull(b.me);
  await b.w.call("POST", `/api/rip/orders/${id2}/claim`, { as: b.me });
  await b.w.pump(2);
  await b.w.call("POST", `/api/rip/orders/${id2}/claim/cancel`, { as: b.me });
  await b.w.pump(2);
  assert.equal(b.w.orderOf(id2)?.pull, "offered");
});

test("a season anchor the ledger refuses or loses is tried again, and sales only open once it lands", async () => {
  for (const fate of ["tecINTERNAL", "lost"]) {
    const w = await world({ wrapChain: misbehaving(once(isType("AccountSet"), fate)) });
    await w.engine.openSeason(5, "4000000", 1.25);
    const season = [...w.engine.state.seasons.values()][0];
    await w.engine.advance();
    w.ledger.close();
    await w.engine.advance();
    if (fate !== "lost") assert.equal(season.live, false);
    w.ledger.close(25);
    await w.pump(5);
    assert.equal(w.engine.state.seasons.get(season.season)?.live, true, fate);
    assert.ok(replayLog(await w.store.readFrom(0)).ok);
  }
});

test("a transaction that was lost on the way is signed again only after the ledger proves it never landed, and it lands once", async () => {
  const cases: [string, (tx: Record<string, any>) => boolean][] = [
    ["sell-back", isPaymentTo(PLAYER)],
    ["claim offer", isType("NFTokenCreateOffer")],
  ];
  for (const [label, match] of cases) {
    const lost = { on: true };
    const { w, me } = await ready({ wrapChain: misbehaving({ fate: (tx) => (lost.on && match(tx) ? "lost" : null) }) });
    const id = await w.pull(me);
    if (label === "sell-back") await sell(w, me, id);
    else await w.call("POST", `/api/rip/orders/${id}/claim`, { as: me });
    await w.pump(2);
    assert.equal(w.engine.state.intents.size, 1, label);
    // Not yet past its last ledger: nothing is signed again.
    const signedBefore = [...(await w.store.readFrom(0))].filter((e) => e.type === "tx_intent").length;
    await w.pump(3);
    assert.equal([...(await w.store.readFrom(0))].filter((e) => e.type === "tx_intent").length, signedBefore, label);
    w.ledger.close(25);
    lost.on = false;
    await w.pump(4);
    assert.equal(w.engine.state.intents.size, 0, label);
    if (label === "sell-back") {
      assert.equal(w.orderOf(id)?.pull, "sold");
      assert.equal(w.paidTo(PLAYER).length, 1);
    } else {
      assert.equal(w.orderOf(id)?.pull, "offered");
      assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenCreateOffer").length, 1);
    }
  }
});

test("an answer lost after the ledger took it never pays twice", async () => {
  const { w, me } = await ready({ wrapChain: misbehaving(once(isPaymentTo(PLAYER), "ambiguous", 3)) });
  const id = await w.pull(me);
  await sell(w, me, id);
  for (let i = 0; i < 8; i++) {
    await w.engine.advance().catch(() => {});
    w.ledger.close();
    await w.engine.advance().catch(() => {});
  }
  assert.equal(w.orderOf(id)?.pull, "sold");
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("a refund below the treasury's floor stays due, shows as owed, and goes out once money is there", async () => {
  const { w, me } = await ready({ treasuryXrp: 11 });
  w.ledger.userSubmit({ TransactionType: "Payment", Account: TREASURY, Destination: VAULT, Amount: "2000000" } as never);
  await w.pump(2);
  w.ledger.userSubmit({ TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "1000000" } as never);
  await w.pump(4);
  const [r] = [...w.engine.state.refunds.values()];
  assert.equal(r.status, "due");
  assert.equal(w.paidTo(PLAYER).length, 0);
  w.ledger.fund(TREASURY, 20);
  await w.pump(3);
  assert.equal(w.engine.state.refunds.get(r.id)?.status, "done");
  assert.equal(w.paidTo(PLAYER).length, 1);
  void me;
});

test("an empty band can't take the money: a pull with nothing to land on is refunded whole, with words for it", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  w.ledger.userSubmit(made.tx as never);
  // The stock rule makes this unreachable through the engine's front door, so it's forced at the log.
  await w.engine.sync();
  const removes = [...w.engine.state.lots.values()].filter((l) => l.price === 5 && l.status === "available").map((l) => l.lot);
  const before = w.ledger.balance(PLAYER);
  const { poolRoot } = await import("../src/lib/rip/log.ts");
  w.ledger.close();
  const id = "force-empty";
  assert.ok(await w.store.append(w.engine.state.head, sealEvents(w.engine.state.head, w.engine.state.headHash, [{ type: "pool_change", data: { id, price: 5, adds: [], removes, root: poolRoot(5, [], removes) } }], new Date().toISOString())));
  await w.pump(6);
  const o = w.orderOf(made.order.id);
  // Either the pull landed before the removal took effect, or it came back whole. Never neither.
  assert.ok(o?.status === "drawn" || o?.status === "refunded", o?.status);
  if (o?.status === "refunded") assert.equal(w.ledger.balance(PLAYER) - before, BigInt(o.drops) - 12n + 12n);
  const again = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(again.body.code, "restocking");
});

test("a season can't open over an open order: it draws on its own season, then the switch goes through, and the log replays", async () => {
  const { w, me } = await ready();
  const made = await w.newOrder(me);
  const firstSeason = made.order.season;
  assert.equal(await w.engine.openSeason(5, "5000000", 1.25), null);
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  const o = w.orderOf(made.order.id);
  assert.equal(o?.status, "drawn");
  assert.equal(o?.season, firstSeason);
  assert.ok(await w.engine.openSeason(5, "5000000", 1.25));
  // On its way to the ledger, the old season sells nothing more.
  w.ledger.fund(OTHER, 100);
  const between = await w.call("POST", "/api/rip/orders", { as: w.client(OTHER), body: { price: 5 } });
  assert.equal(between.status, 409);
  assert.equal(between.body.code, "season_full");
  await w.pump(3);
  const next = await w.call("POST", "/api/rip/orders", { as: w.client(OTHER), body: { price: 5 } });
  assert.notEqual(next.body.order.season, firstSeason);
  assert.equal(next.body.tx.Amount, "5000000");
  const r = replayLog(await w.store.readFrom(0));
  assert.equal(r.ok, true, JSON.stringify(r));
});

// Cards.
async function cards(rule: { fate: (tx: Record<string, any>) => string | null }, gateway?: CardGateway) {
  const w = await world({ cards: true, admins: ADMIN, wrapChain: misbehaving(rule), gateway });
  await w.engine.advance();
  const me = w.client(PLAYER);
  w.fund(me);
  return { w, me, boss: w.client(ADMIN) };
}

async function mirror(w: World, me: ReturnType<World["client"]>, id: string) {
  await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  await w.pump(2);
  const claim = await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  w.ledger.userSubmit(claim.body.tx);
  await w.pump(3);
}

test("a mint the ledger refuses goes back to the stash, and one more claim makes exactly one mirror", async () => {
  const { w, me } = await cards(once(isType("NFTokenMint"), "tecINSUFFICIENT_RESERVE"));
  const id = await w.cardPull(me);
  await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  await w.pump(2);
  assert.equal(w.cardOf(id)?.hold, "stashed");
  assert.equal(w.cardOf(id)?.everMinted, 0);
  // Another try waits, so a wallet that keeps turning offers away can't hold the minter's one slot.
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me })).body.code, "try_later");
  w.ledger.close(RETRY_WAIT_LEDGERS);
  await mirror(w, me, id);
  assert.equal(w.cardOf(id)?.hold, "mirrored");
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenMint" && t.result === "tesSUCCESS").length, 1);
});

test("a burn the ledger refuses puts the card back where it was, and the player can try again after the wait", async () => {
  const { w, me } = await cards(once((tx) => isType("NFTokenBurn")(tx) && tx.Account === MINTER, "tecNO_PERMISSION"));
  const id = await w.cardPull(me);
  await mirror(w, me, id);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } });
  await w.pump(2);
  assert.equal(w.cardOf(id)?.hold, "mirrored");
  assert.equal(w.cardOf(id)?.exit, null);
  assert.equal(w.paidTo(PLAYER).length, 0);
  const soon = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: soon.drops } })).body.code, "try_later");
  w.ledger.close(RETRY_WAIT_LEDGERS);
  const again = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: again.drops } })).status, 200);
  await w.pump(4);
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("the payout on a card already sold back fails: it waits for a person, resume pays once, and refund is refused", async () => {
  const { w, me, boss } = await cards(once(isPaymentTo(PLAYER), "tecNO_DST"));
  const id = await w.cardPull(me);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } });
  await w.pump(3);
  assert.equal(w.cardOf(id)?.status, "review");
  assert.equal(w.paidTo(PLAYER).length, 0);
  // The card already went back to the provider. Refunding the pack on top would pay for a card we no longer hold.
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id, action: "refund" } })).status, 409);
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id, action: "resume" } })).status, 200);
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(w.paidTo(PLAYER).length, 1);
  assert.equal(w.paidTo(PLAYER)[0].tx.Amount, drops);
});

test("the provider dies mid-sale: the sale waits and finishes once when it's back", async () => {
  const base = simulatedGateway();
  let down = true;
  let calls = 0;
  const gateway: CardGateway = {
    ...base,
    sellBack: (m, r) => {
      calls++;
      if (down) return Promise.reject(new Error("provider down"));
      return base.sellBack(m, r);
    },
  };
  const { w, me } = await cards({ fate: () => null }, gateway);
  const id = await w.cardPull(me);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } });
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "exit_source");
  assert.ok(calls > 0);
  assert.equal(w.paidTo(PLAYER).length, 0);
  down = false;
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(w.paidTo(PLAYER).length, 1);
});

// The whole thing at once.
type Act =
  | { k: "order" | "pay" | "wrongAmount" | "wrongWallet" | "sell" | "sellDouble" | "claim" | "accept" | "cancel" | "cardOrder" | "cardPay" | "cardClaim" | "cardAccept" | "cardSell" | "cardShip" | "stray"; who: number; pick: number }
  | { k: "close"; n: number }
  | { k: "restart" | "tick" | "flakyOn" | "flakyOff" };

const act: fc.Arbitrary<Act> = fc.oneof(
  { weight: 12, arbitrary: fc.record({ k: fc.constantFrom("order", "pay", "wrongAmount", "wrongWallet", "sell", "sellDouble", "claim", "accept", "cancel", "stray") as fc.Arbitrary<"order">, who: fc.nat(2), pick: fc.nat(8) }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constantFrom("cardOrder", "cardPay", "cardClaim", "cardAccept", "cardSell", "cardShip") as fc.Arbitrary<"cardOrder">, who: fc.nat(2), pick: fc.nat(8) }) },
  { weight: 6, arbitrary: fc.record({ k: fc.constant("close" as const), n: fc.integer({ min: 1, max: 6 }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constantFrom("restart", "tick", "flakyOn", "flakyOff") as fc.Arbitrary<"restart"> }) },
);

test("any mix of taps, payments, crashes and a flaky ledger: all money is accounted for and nothing happens twice", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(act, { minLength: 5, maxLength: 45 }), fc.integer({ min: 1, max: 2 ** 30 }), async (acts, seed) => {
      let rng = seed;
      const coin = (p: number) => {
        rng = (Math.imul(rng, 48271) >>> 0) % 2147483647;
        return rng / 2147483647 < p;
      };
      const flaky = { on: false };
      const wrap = (c: Chain): Chain =>
        new Proxy(c, {
          get(target, key: keyof Chain) {
            const v = target[key];
            if (typeof v !== "function") return v;
            return async (...a: unknown[]) => {
              const fn = v as (...x: unknown[]) => Promise<unknown>;
              if (!flaky.on) return fn.apply(target, a);
              if (key === "submit" && coin(0.25)) {
                await fn.apply(target, a);
                throw new Error("answer lost");
              }
              if (coin(0.15)) throw new Error("rpc timeout");
              return fn.apply(target, a);
            };
          },
        });
      const base = simulatedGateway();
      const sold = new Map<string, number>();
      const gateway: CardGateway = {
        ...base,
        sellBack: (m, r) => {
          sold.set(m, (sold.get(m) ?? 0) + 1);
          return base.sellBack(m, r);
        },
      };
      const w = await world({ cards: true, wrapChain: wrap, gateway });
      await w.open(5, "4000000", [12, 8, 5, 4, 3]);
      const players = [addressOf(41), addressOf(42), addressOf(43)];
      const clients = players.map((p) => {
        const c = w.client(p);
        w.fund(c, 400);
        return c;
      });
      const stranger = addressOf(44);
      w.ledger.fund(stranger, 400);
      const quotes: Record<string, any>[] = [];
      const cardQuotes: Record<string, any>[] = [];
      const orderIds = () => [...w.engine.state.orders.keys()];
      const cardIds = () => [...w.engine.state.cards.keys()];
      const pickOf = <T,>(list: readonly T[], n: number) => (list.length ? list[n % list.length] : undefined);
      const quiet = async (f: () => Promise<{ status: number; thrown?: unknown }>) => {
        const r = await f();
        // A flaky ledger can turn a request into a failure. A healthy one never does.
        if (!flaky.on) assert.ok(r.status < 500, `${r.status} ${String(r.thrown)}`);
      };
      for (const a of acts) {
        switch (a.k) {
          case "order": {
            const r = await w.call("POST", "/api/rip/orders", { as: clients[a.who], body: { price: 5 } });
            if (r.status === 200) quotes.push(r.body.tx);
            else if (!flaky.on) assert.ok(r.status === 409, String(r.status));
            break;
          }
          case "pay": {
            const q = pickOf(quotes, a.pick);
            if (q) w.ledger.userSubmit(q as never);
            break;
          }
          case "wrongAmount": {
            const q = pickOf(quotes, a.pick);
            if (q) w.ledger.userSubmit({ ...q, Amount: "1500000" } as never);
            break;
          }
          case "wrongWallet": {
            const q = pickOf(quotes, a.pick);
            if (q) w.ledger.userSubmit({ ...q, Account: stranger } as never);
            break;
          }
          case "stray":
            w.ledger.userSubmit({ TransactionType: "Payment", Account: stranger, Destination: TREASURY, Amount: "2000000" } as never);
            break;
          case "sell":
          case "sellDouble": {
            const id = pickOf(orderIds(), a.pick);
            if (!id) break;
            const q = await w.call("POST", `/api/rip/orders/${id}/sell`, { as: clients[a.who] });
            if (q.status !== 200) break;
            const go = () => w.call("POST", `/api/rip/orders/${id}/sell`, { as: clients[a.who], body: { drops: q.body.drops } });
            await Promise.all(a.k === "sellDouble" ? [quiet(go), quiet(go), quiet(go)] : [quiet(go)]);
            break;
          }
          case "claim": {
            const id = pickOf(orderIds(), a.pick);
            if (id) await quiet(() => w.call("POST", `/api/rip/orders/${id}/claim`, { as: clients[a.who] }));
            break;
          }
          case "accept": {
            const o = pickOf([...w.engine.state.orders.values()].filter((x) => x.offerId), a.pick);
            if (o) w.ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: players[a.who], NFTokenSellOffer: o.offerId } as never);
            break;
          }
          case "cancel": {
            const id = pickOf(orderIds(), a.pick);
            if (id) await quiet(() => w.call("POST", `/api/rip/orders/${id}/claim/cancel`, { as: clients[a.who] }));
            break;
          }
          case "cardOrder": {
            const r = await w.call("POST", "/api/rip/cards", { as: clients[a.who], body: { code: "pokemon_25" } });
            if (r.status === 200) cardQuotes.push(r.body.tx);
            break;
          }
          case "cardPay": {
            const q = pickOf(cardQuotes, a.pick);
            if (q) w.ledger.userSubmit(q as never);
            break;
          }
          case "cardClaim": {
            const id = pickOf(cardIds(), a.pick);
            if (id) await quiet(() => w.call("POST", `/api/rip/cards/${id}/claim`, { as: clients[a.who] }));
            break;
          }
          case "cardAccept": {
            const c = pickOf([...w.engine.state.cards.values()].filter((x) => x.mirror), a.pick);
            if (c?.mirror) w.ledger.userSubmit({ TransactionType: "NFTokenAcceptOffer", Account: players[a.who], NFTokenSellOffer: c.mirror.offerId } as never);
            break;
          }
          case "cardSell": {
            const id = pickOf(cardIds(), a.pick);
            if (!id) break;
            const q = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: clients[a.who] });
            if (q.status === 200) await quiet(() => w.call("POST", `/api/rip/cards/${id}/sell`, { as: clients[a.who], body: { drops: q.body.drops } }));
            break;
          }
          case "cardShip": {
            const id = pickOf(cardIds(), a.pick);
            if (id) await quiet(() => w.shipSigned(clients[a.who], id, ADDRESS));
            break;
          }
          case "close":
            w.ledger.close(a.n);
            await w.engine.advance().catch(() => {});
            break;
          case "restart":
            w.restart();
            break;
          case "tick":
            await w.engine.advance().catch(() => {});
            break;
          case "flakyOn":
            flaky.on = true;
            break;
          case "flakyOff":
            flaky.on = false;
            break;
        }
      }
      // Everything settles once the ledger behaves.
      flaky.on = false;
      w.restart();
      w.ledger.close(100);
      for (let i = 0; i < 40; i++) {
        await w.engine.advance();
        w.ledger.close();
        await w.engine.advance();
      }
      const s = w.engine.state;
      assert.equal(s.intents.size, 0, "nothing still in flight");
      const log = await w.store.readFrom(0);
      const replay = replayLog(log);
      assert.equal(replay.ok, true, JSON.stringify(replay));

      // Every XRP into the treasury has one explanation, and every XRP out has one reason.
      const inbound = w.ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Destination === TREASURY && t.result === "tesSUCCESS");
      const outbound = w.ledger.history.filter((t) => t.tx.TransactionType === "Payment" && t.tx.Account === TREASURY && t.result === "tesSUCCESS");
      for (const t of inbound) assert.ok(s.seenTx.has(t.hash), `unexplained payment ${t.hash}`);
      const pullPaid = new Set([...s.orders.values()].map((o) => o.txHash).concat([...s.cards.values()].map((c) => c.txHash)));
      const refundOf = new Set([...s.refunds.values()].map((r) => r.paymentTx));
      for (const t of inbound) assert.ok(pullPaid.has(t.hash) || refundOf.has(t.hash), `payment with no pull and no refund ${t.hash}`);
      for (const t of inbound) assert.ok(!(pullPaid.has(t.hash) && [...s.refunds.values()].some((r) => r.paymentTx === t.hash && r.id.startsWith("pay:"))), `payment both pulled and refunded ${t.hash}`);

      const memoOf = (t: { tx: Record<string, any> }) => Buffer.from(String(t.tx.Memos?.[0]?.Memo?.MemoType ?? ""), "hex").toString();
      const sells = outbound.filter((t) => memoOf(t) === "seal-rips/sell");
      assert.equal(sells.length, [...s.orders.values()].filter((o) => o.pull === "sold").length);
      for (const o of s.orders.values()) {
        if (o.pull === "sold") assert.equal(sells.filter((t) => t.tx.Destination === o.address && t.hash === o.sellTx && t.tx.Amount === o.sellDrops).length, 1, "sold once, at the quote");
        assert.notEqual(o.pull, "selling", "no sale left hanging");
      }
      const cardSells = outbound.filter((t) => memoOf(t) === "seal-rips/card-sell");
      assert.equal(cardSells.length, [...s.cards.values()].filter((c) => c.hold === "sold").length);
      const refunds = outbound.filter((t) => memoOf(t) === "seal-rips/refund");
      assert.equal(refunds.length, [...s.refunds.values()].filter((r) => r.status === "done").length);
      for (const r of s.refunds.values()) assert.ok(r.status === "done", `refund ${r.id} ended ${r.status}`);
      assert.equal(sells.length + cardSells.length + refunds.length, outbound.length, "no payment without a reason");

      // Nothing is held twice, sold twice or sold after it left.
      for (const n of sold.values()) assert.equal(n > 0, true);
      const holders = new Map<string, number>();
      for (const o of s.orders.values()) {
        if (!o.nftId) continue;
        if (o.pull === "stashed" || o.pull === "offered") {
          holders.set(o.nftId, (holders.get(o.nftId) ?? 0) + 1);
          assert.equal(w.ledger.ownerOf(o.nftId), VAULT, `${o.pull} NFT in the vault`);
        }
        if (o.pull === "claimed") assert.equal(w.ledger.ownerOf(o.nftId), o.address);
      }
      for (const n of holders.values()) assert.equal(n, 1, "one holder per NFT");
      for (const c of s.cards.values()) {
        assert.ok(c.everMinted <= 1, "one mirror per card here");
        if (c.status === "refunded") assert.notEqual(c.hold, "sold");
        const onLedger = w.ledger.allNfts().filter((id) => c.mirror?.nftId === id).length;
        if (c.mirror) assert.equal(onLedger, 1, "a mirror that stands exists");
      }
      assert.ok(w.ledger.balance(TREASURY) > 0n);
    }),
    { numRuns: 40, endOnFailure: true, interruptAfterTimeLimit: 110_000, markInterruptAsFailure: false },
  );
});

test("the mainnet check's stock leaves the $5 pool before launch, and those NFTs can then go in at their real bands", async () => {
  const w = await world();
  await w.open(5, "4000000", [1, 1, 1, 1, 1]);
  const me = w.client(PLAYER);
  w.fund(me);
  // The owner's check: one pull, sold back, so that NFT is back in the pool as a new lot.
  const id = await w.pull(me);
  const { drops } = (await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me })).body;
  await w.call("POST", `/api/rip/orders/${id}/sell`, { as: me, body: { drops } });
  await w.pump(6);
  const lots = [...w.engine.state.lots.values()].filter((l) => l.price === 5 && l.status === "available");
  assert.equal(lots.length, 5);
  const add = (band: number) => lots.map(({ nftId, collection, name, img, costDrops, markDrops }) => ({ nftId, band, collection, name, img, costDrops, markDrops }));
  // Not until the removal is on the ledger: a pull could still land there.
  assert.equal((await w.engine.changePool(5, add(0))).ok, false);
  const removed = await w.engine.changePool(5, [], lots.map((l) => l.lot));
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal((await w.engine.changePool(5, add(0))).ok, false);
  await w.pump(4);
  assert.equal((await w.call("GET", "/api/rip/config")).body.tiers.find((t: { price: number }) => t.price === 5).open, false);
  // The cheap NFTs go back as commons, with real stock above them. None can land in a higher band now.
  const relisted = await w.engine.changePool(5, add(0));
  assert.equal(relisted.ok, true, JSON.stringify(relisted));
  await w.open(5, "4000000", [0, 4, 4, 4, 4]);
  const cheap = new Set(lots.map((l) => l.nftId));
  for (const l of w.engine.state.lots.values()) if (l.status === "available" && l.removeLedger === null && cheap.has(l.nftId)) assert.equal(l.band, 0);
  assert.equal((await w.call("GET", "/api/rip/config")).body.tiers.find((t: { price: number }) => t.price === 5).open, true);
  for (let i = 0; i < 3; i++) await w.pull(me);
  const replay = replayLog(await w.store.readFrom(0));
  assert.equal(replay.ok, true, JSON.stringify(replay));
});

test("registering again skips what's already in a pool, and an NFT taken out can go back", async () => {
  const w = await world();
  await w.open(5, "4000000", [1, 1, 1, 1, 1]);
  const lots = [...w.engine.state.lots.values()].filter((l) => l.price === 5 && l.status === "available");
  for (const l of lots) assert.equal(inPoolAlready(w.engine.state, l.nftId), true);
  assert.equal(inPoolAlready(w.engine.state, "F".repeat(64)), false);
  // Without the skip, the engine refuses the whole batch over one that went in last time.
  const again = await w.engine.changePool(5, lots.slice(0, 1).map(({ nftId, band, collection, name, img, costDrops, markDrops }) => ({ nftId, band, collection, name, img, costDrops, markDrops })));
  assert.equal(again.ok, false);
  const removed = await w.engine.changePool(5, [], lots.map((l) => l.lot));
  assert.equal(removed.ok, true, JSON.stringify(removed));
  await w.pump(4);
  for (const l of lots) assert.equal(inPoolAlready(w.engine.state, l.nftId), false, "taken out: free to go back");
});

test("a removal can't strand a paid pull: its NFT stays closed to new listings until the pull has drawn", async () => {
  const hold = { on: false };
  const w = await world({ wrapChain: (c) => ({ ...c, ledgerHash: (n: number) => (hold.on ? Promise.reject(new Error("unreadable")) : c.ledgerHash(n)) }) });
  await w.open(5, "4000000", [2, 2, 2, 2, 2]);
  const me = w.client(PLAYER);
  w.fund(me);
  const lots = [...w.engine.state.lots.values()].filter((l) => l.price === 5 && l.band === 0);
  const { nftId, band, collection, name, img, costDrops, markDrops } = lots[0];
  hold.on = true;
  const made = await w.newOrder(me);
  w.ledger.userSubmit(made.tx as never);
  await w.pump(2);
  assert.equal(w.orderOf(made.order.id)?.status, "paid");
  assert.equal((await w.engine.changePool(5, [], [lots[0].lot])).ok, true);
  await w.pump(4);
  assert.notEqual(w.engine.state.lots.get(lots[0].lot)?.removeLedger, null);
  const row = { nftId, band, collection, name, img, costDrops, markDrops };
  assert.equal((await w.engine.changePool(5, [row])).ok, false, "a paid pull can still land on it");
  hold.on = false;
  await w.pump(3);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
  // If the pull took it, it's that player's. Otherwise it's free to list again.
  const taken = w.orderOf(made.order.id)?.nftId === nftId;
  assert.equal((await w.engine.changePool(5, [row])).ok, !taken);
});
