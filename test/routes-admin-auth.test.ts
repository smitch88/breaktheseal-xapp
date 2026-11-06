import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKeypair, sign } from "ripple-keypairs";
import { encodeForSigning } from "xrpl-binary-codec-prerelease";
import { signToken } from "../src/lib/auth/tokens.ts";
import { simulatedGateway, type CardGateway } from "../src/lib/rip/card-gateway.ts";
import { adminView, publicCard, publicOrder } from "../src/lib/rip/views.ts";
import { SECRET, TREASURY, addressOf, walletOf, world, type World } from "./support-routes.ts";

const PLAYER = addressOf(1);
const OTHER = addressOf(2);
const ADMIN = addressOf(3);
const ADDRESS = { name: "A Player", street: "1 Main St", city: "Town", zip: "10001" };

async function ready(opts: Parameters<typeof world>[0] = {}) {
  const w = await world({ cards: true, admins: ADMIN, ...opts });
  await w.open();
  const me = w.client(PLAYER);
  const boss = w.client(ADMIN);
  w.fund(me);
  w.fund(boss);
  return { w, me, boss };
}

/** A refund that the ledger refused: the destination vanished or won't take it. */
async function stuckRefund(w: World) {
  const id = "pay:STUCK";
  await w.engine.sync();
  const sealed = (await import("../src/lib/rip/log.ts")).sealEvents(w.engine.state.head, w.engine.state.headHash, [
    { type: "payment_refund_due", data: { id, txHash: "STUCKTX", ledger: 1, txIndex: 0, from: PLAYER, drops: "1000000", reason: "no_order", order: null, sourceTag: null } },
    { type: "tx_intent", data: { id: "refund:H", kind: "refund", ref: id, account: TREASURY, sequence: 1, lastLedger: 1, hash: "H", tx: {}, blob: "" } },
    { type: "tx_final", data: { id: "refund:H", hash: "H", result: "tecNO_DST", ledger: 1 } },
  ], new Date().toISOString());
  assert.equal(await w.store.append(w.engine.state.head, sealed), true);
  await w.engine.sync();
  assert.equal(w.engine.state.refunds.get(id)?.status, "stuck");
  return id;
}

test("admin routes: a player, a stranger and a signed-out visitor all get a plain 404, and a good admin from elsewhere a 403", async () => {
  const { w, me, boss } = await ready();
  for (const p of ["/api/rip/admin/autobuy", "/api/rip/admin/mark-shipped", "/api/rip/admin/resolve-card", "/api/rip/admin/resolve-swap", "/api/rip/admin/retry-refund"]) {
    assert.equal((await w.call("POST", p, { as: me, body: { id: "x" } })).status, 404, p);
    assert.equal((await w.call("POST", p, { as: w.client(), body: { id: "x" } })).status, 404, p);
    assert.equal((await w.call("POST", p, { as: boss, origin: "https://evil.test", body: { id: "x" } })).status, 403, p);
    assert.equal((await w.call("POST", p, { as: boss, raw: "junk" })).status, 400, p);
  }
});

test("the buyer's kill switch: only an admin can flip it, it's on the log, and flipping it twice is one change", async () => {
  const { w, boss } = await ready();
  assert.equal((await w.call("POST", "/api/rip/admin/autobuy", { as: boss, body: { on: "no" } })).status, 400);
  assert.equal((await w.call("POST", "/api/rip/admin/autobuy", { as: boss, body: { on: false, why: "looks wrong" } })).status, 200);
  assert.equal(w.engine.state.autobuyOff?.why, "looks wrong");
  assert.equal(w.engine.state.autobuyOff?.by, ADMIN);
  const head = w.engine.state.head;
  assert.equal((await w.call("POST", "/api/rip/admin/autobuy", { as: boss, body: { on: false } })).status, 200);
  assert.equal(w.engine.state.head, head);
  assert.equal((await w.call("POST", "/api/rip/admin/autobuy", { as: boss, body: { on: true } })).status, 200);
  assert.equal(w.engine.state.autobuyOff, null);
});

test("retry a stuck refund: it goes out once, and a refund that isn't stuck says so instead of pretending", async () => {
  const { w, boss } = await ready();
  const id = await stuckRefund(w);
  assert.equal((await w.call("POST", "/api/rip/admin/retry-refund", { as: boss, body: { id: "no-such-refund" } })).status, 409);
  const before = w.ledger.balance(PLAYER);
  assert.equal((await w.call("POST", "/api/rip/admin/retry-refund", { as: boss, body: { id } })).status, 200);
  assert.equal(w.engine.state.refunds.get(id)?.status, "due");
  assert.equal((await w.call("POST", "/api/rip/admin/retry-refund", { as: boss, body: { id } })).status, 409);
  await w.pump(3);
  assert.equal(w.engine.state.refunds.get(id)?.status, "done");
  assert.equal(w.ledger.balance(PLAYER) - before, 1_000_000n);
  assert.equal((await w.call("POST", "/api/rip/admin/retry-refund", { as: boss, body: { id } })).status, 409);
});

test("mark shipped: only a queued card moves, tracking is required and capped, a second tap can't rewrite it", async () => {
  const { w, me, boss } = await ready();
  const id = await w.cardPull(me);
  for (const body of [{ id }, { id, ref: "" }, { id, ref: "   " }, { ref: "T1" }, { id: 5, ref: "T1" }]) assert.equal((await w.call("POST", "/api/rip/admin/mark-shipped", { as: boss, body })).status, 400, JSON.stringify(body));
  assert.equal((await w.call("POST", "/api/rip/admin/mark-shipped", { as: boss, body: { id, ref: "T0" } })).status, 409, "stashed isn't queued");
  assert.equal((await w.call("POST", "/api/rip/admin/mark-shipped", { as: boss, body: { id: "nope", ref: "T0" } })).status, 409, "no such card");
  await w.shipSigned(me, id, ADDRESS);
  await w.pump(2);
  assert.equal((await w.call("POST", "/api/rip/admin/mark-shipped", { as: boss, body: { id, ref: `T1${"x".repeat(300)}` } })).status, 200);
  assert.equal(w.cardOf(id)?.hold, "shipped");
  assert.equal(w.cardOf(id)?.shipRef?.length, 120);
  assert.equal((await w.call("POST", "/api/rip/admin/mark-shipped", { as: boss, body: { id, ref: "T2" } })).status, 409);
  assert.ok(w.cardOf(id)?.shipRef?.startsWith("T1"));
});

test("resolve a held card: resume picks up where it stopped, refund pays whole once, a live mirror blocks a refund", async () => {
  let reveal = false;
  const base = simulatedGateway();
  const gateway: CardGateway = { ...base, open: (memo) => (reveal ? base.open(memo) : Promise.resolve(null)) };
  const { w, me, boss } = await ready({ gateway });
  const { sealEvents } = await import("../src/lib/rip/log.ts");
  /** A card this far along only reaches a person after half an hour, so the test puts it there. */
  const hold = async (order: string, reason: string) => {
    await w.engine.sync();
    await w.store.append(w.engine.state.head, sealEvents(w.engine.state.head, w.engine.state.headHash, [{ type: "card_review", data: { order, reason } }], new Date().toISOString()));
    await w.engine.sync();
  };
  const a = await w.cardPull(me);
  await hold(a, "stalled_at_source_paid");
  assert.equal(w.cardOf(a)?.status, "review");
  for (const body of [{ id: a }, { id: a, action: "delete" }, { action: "resume" }]) assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body })).status, 400);
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id: "nope", action: "resume" } })).status, 409);
  const before = w.ledger.balance(PLAYER);
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id: a, action: "refund" } })).status, 200);
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id: a, action: "refund" } })).status, 409, "twice");
  await w.pump(3);
  assert.equal(w.cardOf(a)?.status, "refunded");
  assert.equal(w.ledger.balance(PLAYER) - before, BigInt(w.cardOf(a)?.drops as string));
  const b = await w.cardPull(me);
  await hold(b, "stalled_at_source_paid");
  reveal = true;
  assert.equal(w.cardOf(b)?.status, "review");
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id: b, action: "resume" } })).status, 200);
  await w.pump(6);
  assert.equal(w.cardOf(b)?.status, "held");
  await w.call("POST", `/api/rip/cards/${b}/claim`, { as: me });
  await w.pump(2);
  assert.ok(w.cardOf(b)?.mirror);
  // A card with a mirror that lands in review can't be refunded while the mirror stands.
  await hold(b, "custody_check_failed");
  assert.equal((await w.call("POST", "/api/rip/admin/resolve-card", { as: boss, body: { id: b, action: "refund" } })).status, 409);
});

test("what a player can read never has cost, signed bytes or a secret; the admin view has the cost and no bytes", async () => {
  const { w, me } = await ready();
  const id = await w.pull(me);
  const card = await w.cardPull(me);
  const shown = JSON.stringify([publicOrder(w.engine.state, w.orderOf(id) as never), publicCard(w.cardOf(card) as never)]);
  for (const word of ["costDrops", "costXrp", "blob", "bytes", "transaction", "drawSecret", "seed"]) assert.ok(!shown.includes(word), word);
  const admin = JSON.stringify(await adminView({ engine: w.engine, chain: w.chain, treasury: TREASURY, vault: "x", mode: "mainnet" } as never));
  assert.ok(admin.includes("costXrp"));
  assert.ok(!admin.includes('"blob"') && !admin.includes('"bytes"'));
});

// Sign-in.
const joeyProof = (seedWallet: ReturnType<typeof walletOf>, tx: Record<string, unknown>) => {
  const kp = deriveKeypair(seedWallet.seed as string);
  const prepared = { ...tx, SigningPubKey: kp.publicKey };
  return { ...prepared, TxnSignature: sign(encodeForSigning(prepared as never), kp.privateKey) };
};

test("Joey sign-in by route: real signature gets a session, a replay is refused, a wrong key is refused", async () => {
  const w = await world({ joey: true, off: false });
  const alice = walletOf(21);
  const c = w.client();
  assert.equal((await w.call("POST", "/api/auth/joey/challenge", { as: c, body: { address: "not-an-address" } })).status, 400);
  const ch = await w.call("POST", "/api/auth/joey/challenge", { as: c, body: { address: alice.classicAddress } });
  assert.equal(ch.status, 200);
  assert.ok(ch.setCookies.some((s) => /seal_challenge=/.test(s) && /httponly/i.test(s) && /samesite=lax/i.test(s)));
  const challengeCookie = c.jar.get("seal_challenge") as string;
  // Someone else's key over Alice's challenge.
  const mallory = walletOf(22);
  assert.equal((await w.call("POST", "/api/auth/joey/verify", { as: c, body: joeyProof(mallory, ch.body.tx) })).status, 401);
  assert.equal((await w.call("GET", "/api/auth/session", { as: c })).body.session, null);
  const proof = joeyProof(alice, ch.body.tx);
  const ok = await w.call("POST", "/api/auth/joey/verify", { as: c, body: proof });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session.address, alice.classicAddress);
  assert.ok(ok.setCookies.some((s) => /seal_session=/.test(s) && /httponly/i.test(s)));
  assert.equal(c.jar.has("seal_challenge"), false);
  assert.equal((await w.call("GET", "/api/auth/session", { as: c })).body.session.address, alice.classicAddress);
  // The same proof, played back with the same cookie.
  const thief = w.client();
  thief.jar.set("seal_challenge", challengeCookie);
  assert.equal((await w.call("POST", "/api/auth/joey/verify", { as: thief, body: proof })).status, 401);
  assert.equal(thief.jar.has("seal_session"), false);
});

test("Joey verify: no cookie, a junk body and a call from elsewhere are refused, and unset-up says so", async () => {
  const w = await world({ joey: true });
  assert.equal((await w.call("POST", "/api/auth/joey/verify", { as: w.client(), raw: "junk" })).status, 401);
  assert.equal((await w.call("POST", "/api/auth/joey/verify", { as: w.client(), origin: "https://evil.test" })).status, 403);
  assert.equal((await w.call("POST", "/api/auth/joey/challenge", { as: w.client(), origin: null, body: { address: PLAYER } })).status, 403);
  const bare = await world();
  assert.equal((await bare.call("POST", "/api/auth/joey/challenge", { as: bare.client(), body: { address: PLAYER } })).status, 503);
  delete process.env.SEAL_SESSION_SECRET;
  assert.equal((await bare.call("POST", "/api/auth/joey/verify", { as: bare.client(), body: {} })).status, 503);
  assert.equal((await bare.call("GET", "/api/auth/session", { as: bare.client(PLAYER) })).body.session, null);
  assert.deepEqual((await bare.call("GET", "/api/auth/config")).body, { xaman: false, joey: false, joeyMobile: false, reownProjectId: null });
});

test("sign-in attempts are rate limited per client", async () => {
  const w = await world({ joey: true });
  const c = w.client();
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) codes.push((await w.call("POST", "/api/auth/joey/challenge", { as: c, body: { address: PLAYER } })).status);
  assert.equal(codes[19], 200);
  assert.equal(codes[20], 429);
  assert.equal((await w.call("POST", "/api/auth/joey/challenge", { as: w.client(), body: { address: PLAYER } })).status, 200);
});

test("Xaman sign-in by route: pending, declined, expired and an outage never make a session", async () => {
  const w = await world({ xaman: true });
  const c = w.client();
  const start = await w.call("POST", "/api/auth/xaman/start", { as: c });
  assert.equal(start.status, 200);
  assert.ok(start.body.open && start.body.qr);
  assert.ok(!JSON.stringify(start.body).includes("api-secret"));
  assert.equal(w.xaman.calls[0].txjson.TransactionType, "SignIn");
  assert.equal(w.xaman.calls[0].options.submit, false);
  w.xaman.payload = { meta: { exists: true, resolved: false } };
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: c })).body.state, "pending");
  w.xaman.payload = { meta: { exists: true, resolved: true, signed: false } };
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: c })).body.state, "declined");
  w.xaman.payload = { meta: { exists: true, expired: true } };
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: c })).body.state, "expired");
  w.xaman.mode = "down";
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: c })).body.state, "pending");
  assert.equal(c.jar.has("seal_session"), false);
  assert.equal((await w.call("POST", "/api/auth/xaman/start", { as: w.client() })).status, 502);
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: w.client() })).body.state, "expired");
  const off = await world();
  assert.equal((await off.call("POST", "/api/auth/xaman/start", { as: off.client() })).status, 503);
  assert.equal((await off.call("POST", "/api/auth/xaman/status", { as: off.client() })).body.state, "invalid");
});

test("logout ends the session on this browser, and guarded routes say connect again", async () => {
  const w = await world();
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).status, 200);
  assert.equal((await w.call("POST", "/api/auth/logout", { as: me, origin: "https://evil.test" })).status, 403);
  assert.equal(me.jar.has("seal_session"), true);
  assert.equal((await w.call("POST", "/api/auth/logout", { as: me })).status, 200);
  assert.equal(me.jar.has("seal_session"), false);
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } })).status, 401);
});

test("the session's wallet is the only wallet: an order is always for the signed-in address, whatever the body says", async () => {
  const w = await world();
  await w.open();
  const me = w.client(PLAYER);
  w.fund(me);
  const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5, address: OTHER, Account: OTHER } });
  assert.equal(r.body.tx.Account, PLAYER);
  assert.ok(signToken);
  assert.ok(SECRET);
});
