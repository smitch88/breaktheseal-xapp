import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { encodeForSigning } from "xrpl-binary-codec-prerelease";
import { JOEY_STATEMENT, verifyCaip122, verifyChallengeV1 } from "../src/lib/auth/joey-proof.ts";
import { memoryNonceStore } from "../src/lib/auth/nonces.ts";
import { SESSION_TTL_S, createAuthService, joeyChallenge } from "../src/lib/auth/service.ts";

/**
 * A real answer from the real Joey extension (1.0.5, provider 1.1.0), on testnet, from a throwaway wallet on 2026-11-02. It pins
 * the message format and the signature scheme: if Joey changes either, this file says so before a player finds out.
 */
const REAL = {
  address: "rnCcwvB4oAEsLR5rcsSYTUe3GPiaw2XcCW",
  message: "localhost:5391 wants you to sign in with your XRPL account:\nrnCcwvB4oAEsLR5rcsSYTUe3GPiaw2XcCW\n\nSign in to SEAL Rips. This moves no funds.\n\nURI: http://localhost:5391\nVersion: 1\nChain ID: xrpl:1\nNonce: abcdef0123456789\nIssued At: 2026-11-02T19:04:35.084Z",
  signature: "FA22AB47AA772F9F62034CDFCC2CBCEC2555E4FFAF696323F9979C3277D39E648B4AD63F8E1E3CFEE63802863BEB6F45B4245850378E7F64CFC1451DCF14E307",
  publicKey: "EDEFD949253BF9A587408C84F81BF07C7DBF61814DB9D7E9AE5DDA4D813D3DDCB6",
  mode: "caip122",
};
const REAL_NOW = Math.floor(Date.parse("2026-11-02T19:04:40Z") / 1000);
const REAL_WANT = { host: "localhost:5391", origin: "http://localhost:5391", chain: "xrpl:1", nonce: "abcdef0123456789", nowS: REAL_NOW, statement: "Sign in to SEAL Rips. This moves no funds." };

test("Joey's real sign-in answer verifies, for its own address", () => {
  assert.deepEqual(verifyCaip122(REAL, REAL_WANT), { ok: true, address: REAL.address });
});

test("that same real answer fails for any other site, network, nonce or time", () => {
  for (const [what, want] of Object.entries({
    host: { ...REAL_WANT, host: "breaktheseal.rip" },
    origin: { ...REAL_WANT, origin: "https://localhost:5391" },
    chain: { ...REAL_WANT, chain: "xrpl:0" },
    nonce: { ...REAL_WANT, nonce: "abcdef0123456780" },
    late: { ...REAL_WANT, nowS: REAL_NOW + 3600 },
    early: { ...REAL_WANT, nowS: REAL_NOW - 3600 },
  })) {
    assert.equal(verifyCaip122(REAL, want).ok, false, what);
  }
});

test("any change to the message, signature, key or address fails", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: REAL.message.length - 1 }), fc.integer({ min: 1, max: 90 }), (at, delta) => {
      const message = REAL.message.slice(0, at) + String.fromCharCode(32 + ((REAL.message.charCodeAt(at) - 32 + delta) % 95)) + REAL.message.slice(at + 1);
      fc.pre(message !== REAL.message);
      assert.equal(verifyCaip122({ ...REAL, message }, REAL_WANT).ok, false);
    }),
    { numRuns: 60 },
  );
  const other = deriveKeypair(generateSeed());
  assert.equal(verifyCaip122({ ...REAL, publicKey: other.publicKey }, REAL_WANT).ok, false);
  assert.equal(verifyCaip122({ ...REAL, address: deriveAddress(other.publicKey) }, REAL_WANT).ok, false);
  assert.equal(verifyCaip122({ ...REAL, signature: "00".repeat(64) }, REAL_WANT).ok, false);
  for (const junk of [null, undefined, "x", 1, {}, { address: REAL.address }, { ...REAL, message: 5 }]) assert.equal(verifyCaip122(junk, REAL_WANT).ok, false);
});

const wallet = () => {
  const keys = deriveKeypair(generateSeed());
  return { ...keys, address: deriveAddress(keys.publicKey) };
};
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const memoOf = (challenge: string) => ({ Memo: { MemoData: hex(JSON.stringify({ wallet: "joey", challenge })) } });

/** The transaction Joey's docs describe for a Ledger account and for the phone app's sign-in screen. */
function challengeTx(w: ReturnType<typeof wallet>, challenge: string, over: Record<string, unknown> = {}) {
  const tx = { TransactionType: "Payment", Account: w.address, Destination: w.address, Amount: "1", Fee: "10", Sequence: 0, SigningPubKey: w.publicKey, Memos: [memoOf(challenge)], ...over };
  return { ...tx, TxnSignature: sign(encodeForSigning(tx as never), w.privateKey) };
}

test("challenge-v1: the signer gets the session, as JSON text or an object, with any destination", () => {
  const w = wallet();
  const tx = challengeTx(w, "c1");
  assert.deepEqual(verifyChallengeV1(JSON.stringify(tx), ["c1"]), { ok: true, address: w.address });
  assert.deepEqual(verifyChallengeV1(tx, ["c1"]), { ok: true, address: w.address });
  assert.equal(verifyChallengeV1(challengeTx(w, "c1", { Destination: "rrrrrrrrrrrrrrrrrrrrrhoLvTp" }), ["c1"]).ok, true);
});

test("challenge-v1: refused unless it can never apply and carries our challenge", () => {
  const w = wallet();
  const cases: [string, unknown][] = [
    ["other challenge", challengeTx(w, "other")],
    ["a sequence that could apply", challengeTx(w, "c1", { Sequence: 5 })],
    ["a ticket that could apply", challengeTx(w, "c1", { TicketSequence: 5 })],
    ["more than a drop", challengeTx(w, "c1", { Amount: "1000000" })],
    ["another type", challengeTx(w, "c1", { TransactionType: "AccountSet", Amount: undefined, Destination: undefined })],
    ["no memo", challengeTx(w, "c1", { Memos: undefined })],
    ["unreadable", "{not json"],
    ["nothing", null],
  ];
  for (const [what, proof] of cases) assert.equal(verifyChallengeV1(proof, ["c1"]).ok, false, what);
});

test("challenge-v1: claiming someone else's account, or changing a signed field, fails", () => {
  const alice = wallet();
  const mallory = wallet();
  const signedByMallory = { ...challengeTx(mallory, "c1"), Account: alice.address };
  assert.equal(verifyChallengeV1(signedByMallory, ["c1"]).ok, false);
  const tampered = { ...challengeTx(alice, "c1"), Destination: mallory.address };
  assert.equal(verifyChallengeV1(tampered, ["c1"]).ok, false);
  const stripped = challengeTx(alice, "c1") as Record<string, unknown>;
  delete stripped.TxnSignature;
  assert.equal(verifyChallengeV1(stripped, ["c1"]).ok, false);
});

const SITE = { host: "breaktheseal.rip", origin: "https://breaktheseal.rip", chain: "xrpl:0" };
const harness = (start = 1_800_000_000) => {
  let now = start;
  return { service: createAuthService({ secret: "test-secret-not-a-real-one", store: memoryNonceStore(() => now * 1000), xaman: null, nowS: () => now }), tick: (s: number) => (now += s), now: () => now };
};
const caip122 = (w: ReturnType<typeof wallet>, nonce: string, issuedS: number, site = SITE) => {
  const message = [`${site.host} wants you to sign in with your XRPL account:`, w.address, "", JOEY_STATEMENT, "", `URI: ${site.origin}`, "Version: 1", `Chain ID: ${site.chain}`, `Nonce: ${nonce}`, `Issued At: ${new Date(issuedS * 1000).toISOString()}`].join("\n");
  return { address: w.address, publicKey: w.publicKey, message, signature: sign(Buffer.from(message).toString("hex"), w.privateKey), mode: "caip122" };
};

test("a verified sign-in is keyed to the signer, marked Joey, and short-lived", async () => {
  const { service, tick, now } = harness();
  const alice = wallet();
  const { nonce, cookie } = service.joeySignInStart();
  const done = await service.joeySignIn(cookie, caip122(alice, nonce, now()), SITE);
  assert.ok(done.ok);
  assert.deepEqual(service.readSession(done.cookie), { address: alice.address, wallet: "joey" });
  tick(SESSION_TTL_S);
  assert.equal(service.readSession(done.cookie), null);
});

test("replay: one nonce signs in once, across both proof kinds", async () => {
  const { service, now } = harness();
  const alice = wallet();
  const { nonce, cookie } = service.joeySignInStart();
  const proof = caip122(alice, nonce, now());
  assert.equal((await service.joeySignIn(cookie, proof, SITE)).ok, true);
  assert.deepEqual(await service.joeySignIn(cookie, proof, SITE), { ok: false, reason: "challenge already used" });
  assert.deepEqual(await service.joeySignIn(cookie, { mode: "challenge-v1", signedTx: challengeTx(alice, nonce) }, SITE), { ok: false, reason: "challenge already used" });
});

test("a failed attempt doesn't burn the nonce, and a cookie from another kind is refused", async () => {
  const { service, now } = harness();
  const alice = wallet();
  const { nonce, cookie } = service.joeySignInStart();
  assert.equal((await service.joeySignIn(cookie, caip122(alice, "wrong-nonce", now()), SITE)).ok, false);
  assert.equal((await service.joeySignIn(cookie, caip122(alice, nonce, now()), SITE)).ok, true);
  const legacy = service.joeyChallenge(alice.address);
  assert.ok(legacy);
  const { nonce: n2 } = service.joeySignInStart();
  assert.deepEqual(await service.joeySignIn(legacy.cookie, caip122(alice, n2, now()), SITE), { ok: false, reason: "challenge expired" });
});

test("a message signed for another site can't sign in here: the host comes from the server", async () => {
  const { service, now } = harness();
  const victim = wallet();
  const { nonce, cookie } = service.joeySignInStart();
  const phished = caip122(victim, nonce, now(), { host: "evil.example", origin: "https://evil.example", chain: "xrpl:0" });
  assert.equal((await service.joeySignIn(cookie, phished, SITE)).ok, false);
  const testnet = caip122(victim, nonce, now(), { ...SITE, chain: "xrpl:1" });
  assert.equal((await service.joeySignIn(cookie, testnet, SITE)).ok, false);
});

test("the phone app's challenge names the site, and either challenge form signs in only with its own nonce", async () => {
  const { service } = harness();
  const alice = wallet();
  const a = service.joeySignInStart();
  assert.equal((await service.joeySignIn(a.cookie, { mode: "challenge-v1", signedTx: JSON.stringify(challengeTx(alice, joeyChallenge(SITE.host, a.nonce))) }, SITE)).ok, true);
  const b = service.joeySignInStart();
  assert.equal((await service.joeySignIn(b.cookie, { mode: "challenge-v1", signedTx: challengeTx(alice, b.nonce) }, SITE)).ok, true);
  const c = service.joeySignInStart();
  assert.equal((await service.joeySignIn(c.cookie, { mode: "challenge-v1", signedTx: challengeTx(alice, joeyChallenge("evil.example", c.nonce)) }, SITE)).ok, false);
});

test("nonces expire", async () => {
  const { service, tick, now } = harness();
  const { nonce, cookie } = service.joeySignInStart();
  tick(301);
  assert.deepEqual(await service.joeySignIn(cookie, caip122(wallet(), nonce, now()), SITE), { ok: false, reason: "challenge expired" });
});
