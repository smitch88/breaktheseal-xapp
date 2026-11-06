import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayRefused, simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { ORDER_LEDGERS } from "../src/lib/rip/engine.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { replayLog } from "../src/lib/rip/verify.ts";
import { MINTER, TREASURY, addressOf, sha, world, type World } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);
// In the order the route stores it, so the test can look up the same key.
const ADDRESS = { name: "A Player", street: "1 Main St", city: "Town", region: "NY", zip: "10001", country: "US" };

async function ready(opts: Parameters<typeof world>[0] = {}) {
  const w = await world({ cards: true, ...opts });
  await w.engine.advance();
  const me = w.client(PLAYER);
  const other = w.client(OTHER);
  w.fund(me);
  w.fund(other);
  return { w, me, other };
}

/** Claim all the way to a mirror in the player's wallet. */
async function mirrored(w: World, me: ReturnType<World["client"]>, id: string) {
  await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  await w.pump(2);
  const claim = await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  assert.equal(claim.body.tx.TransactionType, "NFTokenAcceptOffer");
  w.ledger.userSubmit(claim.body.tx);
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "mirrored");
  return w.cardOf(id)?.mirror?.nftId as string;
}

const status = async (w: World, id: string) => (await w.call("GET", `/api/mirror/${id}`)).body.attributes?.find((a: { trait_type: string }) => a.trait_type === "Status")?.value;

test("happy path by route: order, pay, opened, proven, stashed, listed, sold once", async () => {
  const { w, me } = await ready();
  const made = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } });
  assert.equal(made.status, 200);
  assert.equal(made.body.tx.Destination, TREASURY);
  assert.equal(made.body.order.status, "quoted");
  // $25 at 1.25 with 0.5% room, rounded up to 0.01 XRP.
  assert.equal(made.body.tx.Amount, "20100000");
  w.ledger.userSubmit(made.body.tx);
  await w.pump(6);
  const id = made.body.order.id;
  const polled = await w.call("GET", `/api/rip/cards/${id}`);
  assert.equal(polled.body.order.status, "held");
  assert.equal(polled.body.order.hold, "stashed");
  const list = await w.call("GET", "/api/rip/cards", { as: me });
  assert.deepEqual(list.body.cards.map((c: { id: string }) => c.id), [id]);
  const quote = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me });
  assert.equal(quote.status, 200);
  const before = w.ledger.balance(PLAYER);
  const sold = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: quote.body.drops } });
  assert.equal(sold.status, 200);
  await w.pump(4);
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(w.ledger.balance(PLAYER) - before, BigInt(quote.body.drops));
  assert.equal(replayLog((await w.call("GET", "/api/rip/log")).body.events).ok, true);
});

test("card line off, a bad code, an unknown machine, no price, no float: each is its own refusal with no order", async () => {
  const off = await world();
  await off.engine.advance();
  assert.equal((await off.call("POST", "/api/rip/cards", { as: off.client(PLAYER), body: { code: "pokemon_25" } })).body.code, "card_off");
  assert.equal((await off.call("GET", "/api/rip/cards/x")).status, 404);
  assert.equal((await off.call("GET", "/api/mirror/x")).status, 404);
  const { w, me } = await ready();
  for (const code of ["", "../x", "a b", "x".repeat(61), 5, null]) assert.equal((await w.call("POST", "/api/rip/cards", { as: me, body: { code } })).status, 400, String(code));
  assert.equal((await w.call("POST", "/api/rip/cards", { as: me, body: { code: "no_such_pack" } })).body.code, "no_machine");
  w.state.rate = null;
  assert.equal((await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } })).body.code, "no_rate");
  const dry = await ready({ gateway: simulatedGateway({ floatMicro: 1_000_000n }) });
  assert.equal((await dry.w.call("POST", "/api/rip/cards", { as: dry.me, body: { code: "pokemon_25" } })).body.code, "restocking");
  assert.equal(w.engine.state.cards.size, 0);
});

test("double tap on a card order makes one order, and float is reserved for what's already open", async () => {
  const { w, me, other } = await ready({ gateway: simulatedGateway({ floatMicro: 25_000_000n }) });
  const answers = await Promise.all(Array.from({ length: 4 }, () => w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } })));
  assert.ok(answers.every((a) => a.status === 200), JSON.stringify(answers.map((a) => a.body)));
  assert.equal(new Set(answers.map((a) => a.body.order.id)).size, 1);
  assert.equal(w.engine.state.cards.size, 1);
  assert.equal((await w.call("POST", "/api/rip/cards", { as: other, body: { code: "pokemon_25" } })).body.code, "restocking");
});

test("declined signature on a card: the order ends, no charge, and a late send comes back whole", async () => {
  const { w, me } = await ready();
  const made = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } });
  const id = made.body.order.id;
  w.ledger.close(ORDER_LEDGERS + 2);
  await w.engine.advance();
  assert.equal((await w.call("GET", `/api/rip/cards/${id}`)).body.order.status, "expired");
  const { LastLedgerSequence: _drop, ...late } = made.body.tx;
  const before = w.ledger.balance(PLAYER);
  w.ledger.userSubmit(late);
  await w.pump(4);
  const polled = await w.call("GET", `/api/rip/cards/${id}`);
  assert.equal(polled.body.order.refund.reason, "late");
  assert.equal(before - w.ledger.balance(PLAYER), 12n);
});

test("wrong wallet or wrong amount on a card comes back whole and leaves the order open", async () => {
  const { w, me } = await ready();
  const made = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } });
  const id = made.body.order.id;
  const beforeOther = w.ledger.balance(OTHER);
  w.ledger.userSubmit({ ...made.body.tx, Account: OTHER });
  w.ledger.userSubmit({ ...made.body.tx, Amount: "1000000" });
  await w.pump(4);
  assert.equal(beforeOther - w.ledger.balance(OTHER), 12n);
  assert.equal(w.cardOf(id)?.status, "quoted");
  assert.deepEqual([...w.engine.state.refunds.values()].map((r) => r.reason).sort(), ["wrong_amount", "wrong_wallet"]);
});

test("provider refuses, or won't answer: both refund whole, a lost answer never asks twice, and nothing a player can do reaches the card", async () => {
  let mode: "refuse" | "lost" | null = "refuse";
  let generates = 0;
  const base = simulatedGateway({ failNext: () => mode });
  const gateway: CardGateway = { ...base, generate: (code, ref) => (generates++, base.generate(code, ref)) };
  const { w, me } = await ready({ gateway });
  const refused = await w.cardPull(me);
  assert.equal(w.cardOf(refused)?.status, "refunded");
  assert.equal((await w.call("GET", `/api/rip/cards/${refused}`)).body.order.refund.reason, "source_refused");
  mode = "lost";
  const lost = await w.cardPull(me);
  assert.equal(w.cardOf(lost)?.status, "refunded");
  assert.equal((await w.call("GET", `/api/rip/cards/${lost}`)).body.order.refund.reason, "source_unknown");
  const count = generates;
  await w.pump(5);
  assert.equal(generates, count);
  assert.equal((await w.call("POST", `/api/rip/cards/${lost}/claim`, { as: me })).body.code, "not_stashed");
  assert.equal((await w.call("POST", `/api/rip/cards/${lost}/sell`, { as: me })).body.code, "not_stashed");
  assert.equal((await w.call("POST", `/api/rip/cards/${lost}/ship`, { as: me, body: ADDRESS })).body.code, "not_stashed");
  assert.ok(GatewayRefused);
});

test("SEAL_MACHINE_CODES limits what can be bought, not only what shows: naming a hidden pack charges nothing and opens nothing", async () => {
  const { w, me } = await ready();
  process.env.SEAL_MACHINE_CODES = "other_25, other_50";
  try {
    const hidden = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } });
    assert.equal(hidden.status, 409);
    assert.equal(hidden.body.code, "no_machine");
    assert.equal(w.engine.state.cards.size, 0);
    process.env.SEAL_MACHINE_CODES = "pokemon_25";
    assert.equal((await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" } })).status, 200);
  } finally {
    delete process.env.SEAL_MACHINE_CODES;
  }
});

test("a wallet's or market's browser can read a mirror's metadata, and an unknown one stays a plain 404", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  const shown = await w.call("GET", `/api/mirror/${id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers?.get("access-control-allow-origin"), "*");
  assert.equal((await w.call("GET", "/api/mirror/nope")).status, 404);
});

test("claim as NFT: double tap mints one mirror, custody is proven first, metadata stands for it, and it's retired on every way out", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  const taps = await Promise.all(Array.from({ length: 4 }, () => w.call("POST", `/api/rip/cards/${id}/claim`, { as: me })));
  assert.ok(taps.every((t) => t.status === 200));
  await w.pump(2);
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenMint").length, 1);
  assert.equal(await status(w, id), "Active");
  const claim = await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  w.ledger.userSubmit(claim.body.tx);
  await w.pump(3);
  assert.equal(await status(w, id), "Active");
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } });
  // Each step of the way out: from the moment the mirror is burned it can't read as standing for the card.
  for (let i = 0; i < 6; i++) {
    await w.engine.advance();
    if (!w.cardOf(id)?.mirror) assert.equal(await status(w, id), "Retired", `at ${w.cardOf(id)?.hold}`);
    w.ledger.close();
  }
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(await status(w, id), "Retired");
  assert.equal((await w.call("GET", "/api/mirror/nope")).status, 404);
});

test("no custody proof, no mirror: a card that left custody stops for a person", async () => {
  const base = simulatedGateway();
  let held = true;
  const gateway: CardGateway = { ...base, prove: async (m) => (held ? base.prove(m) : { held: false, slot: 0, proof: "" }) };
  const { w, me } = await ready({ gateway });
  const id = await w.cardPull(me);
  held = false;
  const r = await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  assert.equal(r.body.code, "custody");
  assert.equal(w.cardOf(id)?.status, "review");
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenMint").length, 0);
});

test("declined accept on a mirror: the offer waits, and the card can still be sold or shipped", async () => {
  const { w, me } = await ready();
  const sellId = await w.cardPull(me);
  await w.call("POST", `/api/rip/cards/${sellId}/claim`, { as: me });
  await w.pump(2);
  assert.equal(w.cardOf(sellId)?.hold, "offered");
  const { drops } = (await w.call("POST", `/api/rip/cards/${sellId}/sell`, { as: me })).body;
  assert.equal((await w.call("POST", `/api/rip/cards/${sellId}/sell`, { as: me, body: { drops } })).status, 200);
  await w.pump(4);
  assert.equal(w.cardOf(sellId)?.hold, "sold");
  assert.equal(w.ledger.offers.size, 0);
  const shipId = await w.cardPull(me);
  await w.call("POST", `/api/rip/cards/${shipId}/claim`, { as: me });
  await w.pump(2);
  assert.equal((await w.shipSigned(me, shipId, ADDRESS)).status, 200);
  await w.pump(3);
  assert.equal(w.cardOf(shipId)?.hold, "ship_queue");
});

test("card sale: a client can't name its price, the quote holds within half a percent, and a double tap sells once", async () => {
  const { w, me } = await ready();
  let sold = 0;
  const id = await w.cardPull(me);
  const quote = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me });
  const today = BigInt(quote.body.drops);
  for (const bad of [(today * 1006n) / 1000n, (today * 994n) / 1000n, 0n, 1n]) {
    const r = await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: bad.toString() } });
    assert.equal(r.body.code, "price_changed", bad.toString());
    assert.ok(r.body.drops);
  }
  for (const junk of ["1e9", "abc", "-5", { a: 1 }, ""]) assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: junk } })).body.code, "price_changed");
  w.state.rate = null;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body.code, "no_rate");
  w.state.rate = 1.25;
  const taps = await Promise.all(Array.from({ length: 5 }, () => w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: quote.body.drops } })));
  assert.ok(taps.every((t) => t.status === 200), JSON.stringify(taps.map((t) => t.body.code)));
  await w.pump(4);
  sold = w.paidTo(PLAYER).length;
  assert.equal(sold, 1);
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops: quote.body.drops } })).status, 200);
  await w.pump(2);
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("a stale price on a card sale, or a paused sale, refuses and leaves the card stashed", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  w.state.rate = 1.5;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } })).body.code, "price_changed");
  w.state.rate = 1.25;
  process.env.SEAL_SELLBACK_PAUSED = "1";
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } })).body.code, "sell_paused");
  delete process.env.SEAL_SELLBACK_PAUSED;
  assert.equal(w.cardOf(id)?.hold, "stashed");
});

test("the treasury can't cover a card sale: paused, and the card stays where it was", async () => {
  const { w, me } = await ready({ treasuryXrp: 11 });
  const id = await w.cardPull(me);
  w.ledger.userSubmit({ TransactionType: "Payment", Account: TREASURY, Destination: OTHER, Amount: "20000000" });
  await w.pump(2);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } })).body.code, "sell_paused");
  assert.equal(w.cardOf(id)?.hold, "stashed");
});

test("wrong wallet on a card: every action refused, and a stranger can't plant a shipping address", async () => {
  const { w, me, other } = await ready();
  const id = await w.cardPull(me);
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/claim`, { as: other })).body.code, "not_yours");
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: other })).body.code, "not_yours");
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/ship`, { as: other, body: ADDRESS })).body.code, "not_yours");

  assert.deepEqual(w.secretWrites.filter((k) => k.startsWith("ship:")), [], "a stranger's address was stored");
  assert.deepEqual((await w.call("GET", "/api/rip/cards", { as: other })).body.cards, []);
  // And the real holder's does get stored, so the check above can't pass by storing nothing at all.
  assert.equal((await w.shipSigned(me, id, ADDRESS)).status, 200);
  assert.equal(w.secretWrites.filter((k) => k.startsWith("ship:")).length, 1);
});

test("a mirror that changes hands moves the rights with it: the old wallet is refused and the new one can act", async () => {
  const { w, me, other } = await ready();
  const id = await w.cardPull(me);
  const nftId = await mirrored(w, me, id);
  w.ledger.mintTo(nftId, OTHER);
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body.code, "not_yours");
  assert.deepEqual((await w.call("GET", "/api/rip/cards", { as: me })).body.cards, []);
  assert.equal((await w.call("GET", "/api/rip/cards", { as: other })).body.cards[0].id, id);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: other })).body;
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: other, body: { drops } })).status, 200);
  await w.pump(4);
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(w.paidTo(OTHER).length, 1);
  assert.equal(w.paidTo(PLAYER).length, 0);
});

test("ship: incomplete or oversized addresses are refused, only the hash reaches the log, a double tap queues once", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  for (const body of [{}, { ...ADDRESS, name: "" }, { ...ADDRESS, street: "   " }, { ...ADDRESS, zip: 5 }, { ...ADDRESS, city: "x".repeat(200) }, { ...ADDRESS, region: "x".repeat(5000) }, { ...ADDRESS, country: "x".repeat(5000) }, { ...ADDRESS, region: { a: 1 } }]) {
    assert.equal((await w.call("POST", `/api/rip/cards/${id}/ship`, { as: me, body })).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(w.cardOf(id)?.hold, "stashed");
  const taps = await Promise.all(Array.from({ length: 3 }, () => w.call("POST", `/api/rip/cards/${id}/ship`, { as: me, body: ADDRESS })));
  assert.ok(taps.every((t) => t.status === 200));
  assert.equal(w.cardOf(id)?.hold, "stashed", "asking moves nothing");
  w.ledger.userSubmit(taps[0].body.tx);
  w.ledger.close();
  const confirms = await Promise.all(Array.from({ length: 3 }, () => w.call("POST", `/api/rip/cards/${id}/ship`, { as: me, body: { confirm: taps[0].body.hash } })));
  assert.ok(confirms.every((t) => t.status === 200));
  await w.pump(2);
  assert.equal(w.cardOf(id)?.hold, "ship_queue");
  const log = JSON.stringify((await w.call("GET", "/api/rip/log")).body.events);
  assert.ok(!log.includes("1 Main St"));
  assert.ok(log.includes(w.cardOf(id)?.exit?.addressHash as string));
  // Queued to ship: it can't also be sold or claimed.
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body.code, "not_stashed");
  assert.equal((await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me })).body.code, "not_stashed");
});

test("ship with a mirror: the burn comes first, a burn that fails puts it back, and the address stays private", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  await mirrored(w, me, id);
  assert.equal((await w.shipSigned(me, id, ADDRESS)).status, 200);
  await w.pump(3);
  assert.equal(w.cardOf(id)?.hold, "ship_queue");
  assert.equal(w.cardOf(id)?.mirror, null);
  assert.equal(w.ledger.history.filter((t) => t.tx.TransactionType === "NFTokenBurn" && t.tx.Account === MINTER).length, 1);
});

test("a server dies mid-sale: a cold start finishes it, and the player is paid once", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  await mirrored(w, me, id);
  const { drops } = (await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me })).body;
  await w.call("POST", `/api/rip/cards/${id}/sell`, { as: me, body: { drops } });
  w.restart();
  await w.pump(5);
  assert.equal(w.cardOf(id)?.hold, "sold");
  assert.equal(w.paidTo(PLAYER).length, 1);
});

test("a card NFT keeps its details after card packs close", async () => {
  const store = memoryStore();
  const { w, me } = await ready({ store });
  const id = await w.cardPull(me);
  await mirrored(w, me, id);
  const closed = await world({ store });
  await closed.engine.sync();
  assert.equal(await status(closed, id), "Active");
  assert.equal((await closed.call("GET", "/api/mirror/nope")).status, 404);
});
