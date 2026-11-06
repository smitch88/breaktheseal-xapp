import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { shipInstruction, shipMemoText } from "../src/lib/rip/ship.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { memoryStore } from "../src/lib/rip/store.ts";
import { simulatedGateway } from "../src/lib/rip/card-gateway.ts";
import { createEngine } from "../src/lib/rip/engine.ts";
import { replayLog, verifyAgainstChain } from "../src/lib/rip/verify.ts";
import { ISSUER, MINTER, TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";
import { addressOf, world, type World } from "./support-routes.ts";

/**
 * A session says a wallet signed in, somewhere. Sign-in nonces can be relayed from another site, so a session alone can't be
 * what sends a physical card to an address. Each of these fails first on d61a94fb1.
 */
const ADDRESS = { name: "Pat Holder", street: "1 Main St", city: "Springfield", region: "IL", zip: "62701", country: "US" };
const THIEF_ADDRESS = { name: "Mallory Thief", street: "9 Dark Alley", city: "Elsewhere", zip: "00000" };

async function ready() {
  const w: World = await world({ cards: true });
  await w.engine.advance();
  const me = w.client(addressOf(1));
  const thief = w.client(addressOf(2));
  w.fund(me);
  w.fund(thief);
  return { w, me, thief };
}

const ask = (w: World, id: string, as: unknown, body: unknown = ADDRESS) => w.call("POST", `/api/rip/cards/${id}/ship`, { as: as as never, body });
const confirm = (w: World, id: string, as: unknown, hash: string) => ask(w, id, as, { confirm: hash });

test("a session alone ships nothing: asking returns what to sign, and the card doesn't move until the wallet's signature is on the ledger", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  const first = await ask(w, id, me);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(w.cardOf(id)?.hold, "stashed", "asking isn't shipping");
  assert.equal(w.cardOf(id)?.exit, null);
  assert.equal(first.body.tx.TransactionType, "AccountSet", "moves nothing, and costs only the network fee");
  assert.equal(first.body.tx.Account, addressOf(1));
  assert.ok(first.body.tx.LastLedgerSequence > w.ledger.ledger());
  const hash = first.body.hash as string;

  const early = await confirm(w, id, me, hash);
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "ship_unsigned");
  assert.equal(w.cardOf(id)?.exit, null);

  w.ledger.userSubmit(first.body.tx);
  w.ledger.close();
  const done = await confirm(w, id, me, hash);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  await w.pump(2);
  assert.equal(w.cardOf(id)?.hold, "ship_queue");
  assert.equal(w.cardOf(id)?.exit?.addressHash, hash);
  const raw = await w.store.readFrom(0);
  assert.ok(!JSON.stringify(raw).includes("1 Main St"), "the address stays off the log");
  assert.ok(raw.some((e) => e.type === "card_exit_requested" && e.data.kind === "ship" && typeof e.data.shipTx === "string"));
  assert.ok(replayLog(raw).ok);
  assert.equal((await confirm(w, id, me, hash)).status, 200, "a repeat is the same request");
});

test("the relay attack: a thief holding the victim's session can't move the card, and the victim's own signature can't be pointed at the thief's address", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  // The stolen session is the victim's session: these calls are `as: me`, from the thief's machine.
  const theirs = await ask(w, id, me, THIEF_ADDRESS);
  assert.equal(theirs.status, 200);
  assert.equal((await confirm(w, id, me, theirs.body.hash)).body.code, "ship_unsigned");
  // The victim, on their own, signs to ship to their own address.
  const mine = await ask(w, id, me);
  w.ledger.userSubmit(mine.body.tx);
  w.ledger.close();
  assert.equal((await confirm(w, id, me, theirs.body.hash)).body.code, "ship_unsigned", "that signature names a different address");
  assert.equal(w.cardOf(id)?.exit, null);
  assert.equal((await confirm(w, id, me, mine.body.hash)).status, 200);
  assert.equal(w.cardOf(id)?.exit?.addressHash, mine.body.hash);
});

test("only the wallet with the card can sign for it: another wallet's transaction with the same words counts for nothing", async () => {
  const { w, me, thief } = await ready();
  const id = await w.cardPull(me);
  const asked = await ask(w, id, me);
  w.ledger.userSubmit({ ...asked.body.tx, Account: addressOf(2) });
  w.ledger.close();
  assert.equal((await confirm(w, id, me, asked.body.hash)).body.code, "ship_unsigned");
  assert.equal((await ask(w, id, thief)).status, 409, "and a wallet that isn't the holder can't ask");
  assert.equal((await confirm(w, id, thief, asked.body.hash)).status, 409);
});

test("a confirmation for a hash nobody asked for is refused, and it can't reach another card's request", async () => {
  const { w, me } = await ready();
  const a = await w.cardPull(me);
  const b = await w.cardPull(me);
  const asked = await ask(w, a, me);
  w.ledger.userSubmit(asked.body.tx);
  w.ledger.close();
  assert.equal((await confirm(w, a, me, "0".repeat(64))).body.code, "ship_unsigned");
  assert.equal((await confirm(w, b, me, asked.body.hash)).body.code, "ship_unsigned", "signed for card a, not card b");
  assert.equal(w.cardOf(b)?.exit, null);
});

test("a signature from a former holder doesn't travel with the mirror", async () => {
  const { w, me, thief: buyer } = await ready();
  const id = await w.cardPull(me);
  const claim = await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  assert.equal(claim.status, 200);
  await w.pump(2);
  const offered = await w.call("POST", `/api/rip/cards/${id}/claim`, { as: me });
  w.ledger.userSubmit(offered.body.tx);
  await w.pump(2);
  const nftId = w.cardOf(id)!.mirror!.nftId;
  const asked = await ask(w, id, me);
  w.ledger.userSubmit(asked.body.tx);
  w.ledger.close();
  w.ledger.mintTo(nftId, addressOf(2));
  assert.equal((await confirm(w, id, me, asked.body.hash)).status, 409, "the old holder no longer holds it");
  assert.equal((await confirm(w, id, buyer, asked.body.hash)).body.code, "ship_unsigned", "and the new one never signed");
  assert.equal(w.cardOf(id)?.exit, null);
});

test("a signature that failed on the ledger doesn't count", async () => {
  const ledger = testLedger();
  const PLAYER = "rPLAYERplayerPLAYERplayerPLAYER";
  for (const [a, x] of [[TREASURY, 500], [VAULT, 50], [MINTER, 50], [ISSUER, 50], [PLAYER, 500]] as const) ledger.fund(a, x);
  ledger.authorize(ISSUER, MINTER);
  const chain = { ...ledger.chain, accountTx: async (a: string, f: number) => (await ledger.chain.accountTx(a, f)).map((t) => (t.tx.TransactionType === "AccountSet" ? { ...t, result: "tecNO_PERMISSION" } : t)) };
  const engine = createEngine({ store: memoryStore(), chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1, gateway: simulatedGateway(), mirror: { issuer: ISSUER, transferFee: 2000, taxon: 1, origin: "https://example.test" } });
  await engine.advance();
  const q = await engine.createCardOrder(PLAYER, "pokemon_25", 1.25);
  assert.ok(q.ok);
  ledger.userSubmit(q.tx as never);
  for (let i = 0; i < 4; i++) {
    await engine.advance();
    ledger.close();
  }
  const hash = createHash("sha256").update("x").digest("hex");
  const asked = await engine.shipAuthorization(PLAYER, q.order.id, hash);
  assert.ok(asked.ok);
  ledger.userSubmit(asked.tx as never);
  ledger.close();
  const r = await engine.shipCard(PLAYER, q.order.id, hash, asked.fromLedger);
  assert.equal((r as { code: string }).code, "ship_unsigned");
});

test("what the wallet is shown says it isn't a sign-in before anything a stranger typed, and names the address", () => {
  const text = shipInstruction({ ...THIEF_ADDRESS, region: "", country: "US", name: "Sign in to SEAL Rips ".repeat(40) });
  assert.ok(text.startsWith("This isn't a sign-in."), "an address can't push the warning off the screen");
  assert.ok(text.length <= 280, "Xaman's limit");
  const shown = shipInstruction({ name: "Pat Holder", street: "1 Main St", city: "Springfield", region: "IL", zip: "62701", country: "US" });
  for (const part of ["Pat Holder", "1 Main St", "Springfield", "62701"]) assert.ok(shown.includes(part), part);
  const memo = shipMemoText("card1", "abc");
  assert.ok(memo.startsWith("This isn't a sign-in."));
  assert.ok(memo.includes("card1") && memo.includes("abc"));
  assert.ok(!memo.includes("Main St"), "only the hash goes on the ledger");
});

test("the public log has to show the signature: a ship with none fails replay, and one the ledger doesn't hold fails the check against it", async () => {
  const { w, me } = await ready();
  const id = await w.cardPull(me);
  const asked = await ask(w, id, me);
  w.ledger.userSubmit(asked.body.tx);
  w.ledger.close();
  assert.equal((await confirm(w, id, me, asked.body.hash)).status, 200);
  const events = await w.store.readFrom(0);
  const good = await verifyAgainstChain(events, w.chain, TREASURY, 0);
  assert.ok(good.ok, JSON.stringify(good));

  const at = events.findIndex((e) => e.type === "card_exit_requested");
  const before = events[at - 1];
  const draft = events[at] as Extract<(typeof events)[number], { type: "card_exit_requested" }>;
  const reseal = (shipTx: string | null) => [...events.slice(0, at), ...sealEvents(before.seq, before.hash, [{ type: "card_exit_requested", data: { ...draft.data, shipTx } }], draft.at)];
  const none = replayLog(reseal(null));
  assert.equal(none.ok, false);
  assert.match((none as { why: string }).why, /ship/);
  const made = await verifyAgainstChain(reseal("F".repeat(64)), w.chain, TREASURY, 0);
  assert.equal(made.ok, false);
  assert.match((made as { why: string }).why, /ship/);
});
