import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKeypair, sign } from "ripple-keypairs";
import { encodeForSigning } from "xrpl-binary-codec-prerelease";
import { readRequestState, readXamanSocket } from "../src/lib/wallet/xaman-socket.ts";
import { addressOf, walletOf, world } from "./support-routes.ts";

const PLAYER = addressOf(1);

const caip = (w: ReturnType<typeof walletOf>, nonce: string, over: { host?: string; origin?: string; chain?: string; issued?: string } = {}) => {
  const message = [`${over.host ?? "seal.test"} wants you to sign in with your XRPL account:`, w.classicAddress, "", "Sign in to Break the Seal. This moves no funds.", "", `URI: ${over.origin ?? "https://seal.test"}`, "Version: 1", `Chain ID: ${over.chain ?? "xrpl:0"}`, `Nonce: ${nonce}`, `Issued At: ${over.issued ?? new Date().toISOString()}`].join("\n");
  return { address: w.classicAddress, publicKey: w.publicKey, message, signature: sign(Buffer.from(message).toString("hex"), w.privateKey), mode: "caip122" };
};

test("Joey extension sign-in by route: needs no Reown id, verifies, sets the cookie, and can't be replayed", async () => {
  const w = await world();
  const alice = walletOf(31);
  const c = w.client();
  const config = await w.call("GET", "/api/auth/config");
  assert.deepEqual(config.body, { xaman: false, joey: true, joeyMobile: false, reownProjectId: null });
  const start = await w.call("POST", "/api/auth/joey/nonce", { as: c });
  assert.equal(start.status, 200);
  assert.equal(start.body.chain, "xrpl:0");
  assert.equal(start.body.challenge, `seal.test:${start.body.nonce}`);
  const cookie = c.jar.get("seal_challenge") as string;
  const proof = caip(alice, start.body.nonce);
  const ok = await w.call("POST", "/api/auth/joey/signin", { as: c, body: proof });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.session, { address: alice.classicAddress, wallet: "joey" });
  assert.equal(c.jar.has("seal_challenge"), false);
  assert.deepEqual((await w.call("GET", "/api/auth/session", { as: c })).body.session, { address: alice.classicAddress, wallet: "joey" });
  const thief = w.client();
  thief.jar.set("seal_challenge", cookie);
  assert.equal((await w.call("POST", "/api/auth/joey/signin", { as: thief, body: proof })).status, 401);
  assert.equal(thief.jar.has("seal_session"), false);
});

test("Joey sign-in: another site, another network, another nonce, a forged address and a foreign origin all fail", async () => {
  const w = await world();
  const alice = walletOf(31);
  const mallory = walletOf(32);
  const c = w.client();
  const { nonce } = (await w.call("POST", "/api/auth/joey/nonce", { as: c })).body;
  for (const proof of [caip(alice, nonce, { host: "evil.example" }), caip(alice, nonce, { origin: "https://evil.example" }), caip(alice, nonce, { chain: "xrpl:1" }), caip(alice, "someone-elses-nonce"), caip(alice, nonce, { issued: "2020-01-01T00:00:00.000Z" }), { ...caip(mallory, nonce), address: alice.classicAddress }, {}, null]) {
    assert.equal((await w.call("POST", "/api/auth/joey/signin", { as: c, body: proof })).status, 401, JSON.stringify(proof));
  }
  assert.equal(c.jar.has("seal_session"), false);
  assert.equal((await w.call("POST", "/api/auth/joey/signin", { as: c, body: caip(alice, nonce), origin: "https://evil.example" })).status, 403);
  assert.equal((await w.call("POST", "/api/auth/joey/nonce", { as: w.client(), origin: null })).status, 403);
  // The real answer still works after every failure: a bad try spends nothing.
  assert.equal((await w.call("POST", "/api/auth/joey/signin", { as: c, body: caip(alice, nonce) })).status, 200);
});

test("the phone app's challenge-v1 answer signs in by route, for whoever signed", async () => {
  const w = await world({ joey: true });
  const alice = walletOf(33);
  const kp = deriveKeypair(alice.seed as string);
  const c = w.client();
  const { challenge } = (await w.call("POST", "/api/auth/joey/nonce", { as: c })).body;
  const tx = { TransactionType: "Payment", Account: alice.classicAddress, Destination: alice.classicAddress, Amount: "1", Fee: "10", Sequence: 0, SigningPubKey: kp.publicKey, Memos: [{ Memo: { MemoData: Buffer.from(JSON.stringify({ wallet: "joey", challenge })).toString("hex").toUpperCase() } }] };
  const signed = { ...tx, TxnSignature: sign(encodeForSigning(tx as never), kp.privateKey) };
  const ok = await w.call("POST", "/api/auth/joey/signin", { as: c, body: { mode: "challenge-v1", signedTx: JSON.stringify(signed) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session.address, alice.classicAddress);
});

test("Joey's phone route stays dark without a Reown id, while the extension route works", async () => {
  const w = await world();
  assert.equal((await w.call("POST", "/api/auth/joey/challenge", { as: w.client(), body: { address: PLAYER } })).status, 503);
  assert.equal((await w.call("POST", "/api/auth/joey/nonce", { as: w.client() })).status, 200);
  const on = await world({ joey: true });
  assert.deepEqual((await on.call("GET", "/api/auth/config")).body, { xaman: false, joey: true, joeyMobile: true, reownProjectId: "route-test" });
});

test("a Joey player's order offers the transaction and no Xaman request, even with Xaman set up", async () => {
  const w = await world({ xaman: true });
  await w.open();
  const c = w.client(PLAYER, true, "joey");
  w.fund(c);
  const made = await w.newOrder(c);
  assert.equal(made.wallet, null);
  assert.equal(w.xaman.calls.length, 0);
  assert.equal(made.tx.Account, PLAYER);
  assert.equal(made.tx.Amount, made.order.xrp * 1e6 + "");
  assert.ok(made.tx.InvoiceID && made.tx.LastLedgerSequence);
  assert.equal(made.tx.NetworkID, undefined);
});

test("a client saying it paid moves nothing: only the ledger does", async () => {
  const w = await world();
  await w.open();
  const c = w.client(PLAYER, true, "joey");
  w.fund(c);
  const made = await w.newOrder(c);
  const id = made.order.id as string;
  // There is no route that takes a wallet's answer, and a body claiming one changes nothing.
  await w.call("POST", "/api/rip/orders", { as: c, body: { price: 5, paid: true, hash: "AB".repeat(32), engine_result: "tesSUCCESS" } });
  await w.call("GET", `/api/rip/orders/${id}`, { as: c });
  await w.pump(3);
  assert.equal(w.orderOf(id)?.status, "quoted");
  w.ledger.userSubmit(made.tx as never);
  await w.pump(5);
  assert.equal(w.orderOf(id)?.status, "drawn");
});

test("two presses get the same order and the same transaction", async () => {
  const w = await world();
  await w.open();
  const c = w.client(PLAYER, true, "joey");
  w.fund(c);
  const [a, b] = await Promise.all([w.newOrder(c), w.newOrder(c)]);
  assert.equal(a.order.id, b.order.id);
  assert.deepEqual(a.tx, b.tx);
  const again = await w.newOrder(c);
  assert.deepEqual(again.tx, a.tx);
});

test("a second payment for one order is refunded whole, whatever a wallet did", async () => {
  const w = await world();
  await w.open();
  const c = w.client(PLAYER, true, "joey");
  w.fund(c);
  const made = await w.newOrder(c);
  w.ledger.userSubmit(made.tx as never);
  await w.pump(1);
  w.ledger.userSubmit(made.tx as never);
  await w.pump(6);
  assert.equal(w.orderOf(made.order.id)?.status, "drawn");
  assert.equal(w.paidTo(PLAYER).length, 1, "the extra came back");
});

test("a Xaman player pressing twice gets one live request; a new one only once Xaman says the first ended", async () => {
  const w = await world({ xaman: true });
  await w.open();
  const c = w.client(PLAYER);
  w.fund(c);
  const first = await w.newOrder(c);
  const second = await w.newOrder(c);
  assert.equal(w.xaman.calls.length, 1);
  assert.deepEqual(second.wallet, first.wallet);
  // Declined in Xaman.
  w.xaman.payload = { meta: { exists: true, resolved: true, signed: false } };
  const third = await w.newOrder(c);
  assert.equal(w.xaman.calls.length, 2);
  assert.notDeepEqual(third.wallet, first.wallet);
  // Expired.
  w.xaman.payload = { meta: { exists: true, expired: true } };
  await w.newOrder(c);
  assert.equal(w.xaman.calls.length, 3);
  // Signed: the same request stands while the ledger catches up, and no new one can pay twice.
  w.xaman.payload = { meta: { exists: true, resolved: true, signed: true }, response: { dispatched_result: "tesSUCCESS" } };
  const fourth = await w.newOrder(c);
  assert.equal(w.xaman.calls.length, 3);
  assert.ok(fourth.wallet);
  // Signed, but the ledger refused it at submit: nothing moved, so a new request is right.
  w.xaman.payload = { meta: { exists: true, resolved: true, signed: true }, response: { dispatched_result: "tecUNFUNDED_PAYMENT" } };
  await w.newOrder(c);
  assert.equal(w.xaman.calls.length, 4);
});

test("a Xaman request only that account can sign, on this network, for the server's exact transaction", async () => {
  const w = await world({ xaman: true });
  await w.open();
  const c = w.client(PLAYER);
  w.fund(c);
  const made = await w.newOrder(c);
  const sent = w.xaman.calls.at(-1)!;
  assert.deepEqual(sent.options.signers, [PLAYER]);
  assert.equal(sent.options.force_network, "MAINNET");
  assert.equal(sent.options.submit, true);
  assert.deepEqual(sent.txjson, made.tx);
});

test("Xaman being down still gets the transaction, and a request can't be read back as anyone else", async () => {
  const w = await world({ xaman: true });
  await w.open();
  const c = w.client(PLAYER);
  w.fund(c);
  const made = await w.newOrder(c);
  const uuid = (made.wallet as { uuid: string }).uuid;
  w.xaman.payload = { meta: { exists: true, resolved: true, signed: false }, payload: { request_json: { Account: PLAYER } } };
  assert.deepEqual((await w.call("POST", "/api/rip/wallet-request", { as: c, body: { uuid } })).body, { state: "declined" });
  const stranger = w.client(addressOf(2));
  assert.equal((await w.call("POST", "/api/rip/wallet-request", { as: stranger, body: { uuid } })).status, 404);
  assert.equal((await w.call("POST", "/api/rip/wallet-request", { as: c, body: { uuid: "../../etc" } })).status, 404);
  assert.equal((await w.call("POST", "/api/rip/wallet-request", { as: w.client(), body: { uuid } })).status, 401);
  w.xaman.mode = "down";
  assert.deepEqual((await w.call("POST", "/api/rip/wallet-request", { as: c, body: { uuid } })).body, { state: "pending" });
  const held = await w.newOrder(c);
  assert.equal(held.wallet, null);
  assert.ok(held.tx);
});

test("a phone returning to sign-in lands where it left, and never on another host", async () => {
  const w = await world({ xaman: true });
  await w.call("POST", "/api/auth/xaman/start", { as: w.client(), body: { to: "/checkout?nft=5" } });
  const url = w.xaman.calls.at(-1)!.options.return_url.app;
  assert.equal(url, `${w.SITE}/auth/return?qr=1&to=${encodeURIComponent("/checkout?nft=5")}`);
  for (const to of ["https://evil.example/", "//evil.example", "/\\evil.example", "/auth/return", "x", 5, null, `/${"a".repeat(300)}`]) {
    await w.call("POST", "/api/auth/xaman/start", { as: w.client(), body: { to } });
    assert.equal(w.xaman.calls.at(-1)!.options.return_url.app, `${w.SITE}/auth/return?qr=1`, String(to));
  }
});

test("Xaman's status socket and payload reads, in plain states", () => {
  assert.equal(readXamanSocket('{"signed":true,"txid":"A"}'), "signed");
  assert.equal(readXamanSocket('{"signed":false}'), "declined");
  assert.equal(readXamanSocket('{"expired":true}'), "expired");
  assert.equal(readXamanSocket('{"expires_in_seconds":0}'), "expired");
  for (const chatter of ['{"message":"Welcome"}', '{"opened":true}', '{"devapp_fetched":true}', '{"expires_in_seconds":200}', "not json", "null", ""]) assert.equal(readXamanSocket(chatter), null, chatter);
  assert.equal(readRequestState({ meta: { exists: true, resolved: false } }), "pending");
  assert.equal(readRequestState({ meta: { exists: false } }), "expired");
  assert.equal(readRequestState({ meta: { exists: true, cancelled: true } }), "expired");
  assert.equal(readRequestState({ meta: { exists: true, resolved: true, signed: false } }), "declined");
  assert.equal(readRequestState({ meta: { exists: true, resolved: true, signed: true } }), "signed");
  assert.equal(readRequestState({ meta: { resolved: true, signed: true }, response: { dispatched_result: "tefALREADY" } }), "signed");
  assert.equal(readRequestState({ meta: { resolved: true, signed: true }, response: { dispatched_result: "tecNO_DST" } }), "declined");
  assert.equal(readRequestState(null), "pending");
});
