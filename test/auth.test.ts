import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { encode, encodeForSigning } from "xrpl-binary-codec-prerelease";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { memoryNonceStore } from "../src/lib/auth/nonces.ts";
import { CHALLENGE_TTL_S, SESSION_TTL_S, createAuthService, type XamanClient } from "../src/lib/auth/service.ts";
import { readToken, signToken } from "../src/lib/auth/tokens.ts";
import { MEMO_TYPE, challengeTx, isAddress, readXamanPayload, verifyChallengeProof, type ChallengeTx, type XamanPayloadResult } from "../src/lib/auth/xrpl.ts";
import { createXamanClient } from "../src/lib/auth/xaman-client.ts";
import { parseAllowlist } from "../src/config/machines.ts";

const SECRET = "test-secret-not-a-real-one";

const wallet = (entropy?: number[]) => {
  const seed = generateSeed(entropy ? { entropy: Uint8Array.from(entropy) as never } : undefined);
  const keys = deriveKeypair(seed);
  return { ...keys, address: deriveAddress(keys.publicKey) };
};
const alice = wallet();
const mallory = wallet();

/** What a wallet does: fill in the key and sign the exact fields. */
function signTx(tx: Record<string, unknown>, w = alice) {
  const prepared = { ...tx, SigningPubKey: w.publicKey };
  return { ...prepared, TxnSignature: sign(encodeForSigning(prepared), w.privateKey) };
}

function harness(start = 1_800_000_000) {
  let now = start;
  const service = createAuthService({ secret: SECRET, store: memoryNonceStore(() => now * 1000), xaman: null, nowS: () => now });
  return { service, tick: (s: number) => (now += s) };
}

const challengeFor = (service: ReturnType<typeof harness>["service"], address = alice.address) => {
  const out = service.joeyChallenge(address);
  assert.ok(out);
  return out;
};

test("a real signature over the challenge signs you in, keyed to that address", async () => {
  const { service } = harness();
  const { tx, cookie } = challengeFor(service);
  const result = await service.joeyVerify(cookie, { tx_json: signTx(tx as never) });
  assert.ok(result.ok);
  assert.deepEqual(result.session, { address: alice.address, wallet: "joey" });
  assert.deepEqual(service.readSession(result.cookie), { address: alice.address, wallet: "joey" });
});

test("a signed blob works the same as tx_json", async () => {
  const { service } = harness();
  const { tx, cookie } = challengeFor(service);
  const result = await service.joeyVerify(cookie, { hex: encode(signTx(tx as never)) });
  assert.ok(result.ok);
});

test("replay: the same proof can't sign in twice", async () => {
  const { service } = harness();
  const { tx, cookie } = challengeFor(service);
  const proof = { tx_json: signTx(tx as never) };
  assert.equal((await service.joeyVerify(cookie, proof)).ok, true);
  const again = await service.joeyVerify(cookie, proof);
  assert.deepEqual(again, { ok: false, reason: "challenge already used" });
});

test("a failed attempt doesn't burn the nonce, so the real signer can still finish", async () => {
  const { service } = harness();
  const { tx, cookie } = challengeFor(service);
  assert.equal((await service.joeyVerify(cookie, { tx_json: signTx(tx as never, mallory) })).ok, false);
  assert.equal((await service.joeyVerify(cookie, { tx_json: signTx(tx as never) })).ok, true);
});

test("expiry: a challenge dies at its time, and any later moment", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: CHALLENGE_TTL_S, max: 10 * CHALLENGE_TTL_S }), async (wait) => {
      const { service, tick } = harness();
      const { tx, cookie } = challengeFor(service);
      tick(wait);
      assert.deepEqual(await service.joeyVerify(cookie, { tx_json: signTx(tx as never) }), { ok: false, reason: "challenge expired" });
    }),
    { numRuns: 25 },
  );
});

test("expiry: anything before it still works", async () => {
  const { service, tick } = harness();
  const { tx, cookie } = challengeFor(service);
  tick(CHALLENGE_TTL_S - 1);
  assert.equal((await service.joeyVerify(cookie, { tx_json: signTx(tx as never) })).ok, true);
});

test("sessions are short-lived", async () => {
  const { service, tick } = harness();
  const { tx, cookie } = challengeFor(service);
  const result = await service.joeyVerify(cookie, { tx_json: signTx(tx as never) });
  assert.ok(result.ok);
  tick(SESSION_TTL_S - 1);
  assert.ok(service.readSession(result.cookie));
  tick(1);
  assert.equal(service.readSession(result.cookie), null);
});

test("a wrong address is rejected: someone else's key over your challenge", () => {
  const expected = challengeTx(alice.address, "n1", 100);
  const proof = verifyChallengeProof({ tx_json: signTx(expected as never, mallory) }, expected);
  assert.deepEqual(proof, { ok: false, reason: "signed by a different account" });
});

test("a wrong address is rejected: their own valid proof doesn't pass for your account", () => {
  const theirs = challengeTx(mallory.address, "n1", 100);
  const proof = verifyChallengeProof({ tx_json: signTx(theirs as never, mallory) }, challengeTx(alice.address, "n1", 100));
  assert.equal(proof.ok, false);
});

test("a signature for a different nonce is rejected", () => {
  const other = challengeTx(alice.address, "other", 100);
  const proof = verifyChallengeProof({ tx_json: signTx(other as never) }, challengeTx(alice.address, "n1", 100));
  assert.deepEqual(proof, { ok: false, reason: "memo differs from the challenge" });
});

test("no edit to a signed challenge survives verification", () => {
  const expected = challengeTx(alice.address, "n1", 100);
  const good = signTx(expected as never);
  assert.deepEqual(verifyChallengeProof({ tx_json: good }, expected), { ok: true, address: alice.address });
  const edits: Record<string, unknown>[] = [
    { ...good, Fee: "12" },
    { ...good, Sequence: 9 },
    { ...good, LastLedgerSequence: 999999999 },
    { ...good, TransactionType: "Payment" },
    { ...good, Destination: mallory.address, Amount: "1000000" },
    { ...good, Flags: 65536 },
    { ...good, SetFlag: 8 },
    { ...good, TxnSignature: "" },
    { ...good, SigningPubKey: "" },
    { ...good, TxnSignature: good.TxnSignature.replace(/^../, "00") },
    { ...good, TxnSignature: undefined },
  ];
  for (const e of edits) assert.equal(verifyChallengeProof({ tx_json: e }, expected).ok, false, JSON.stringify(Object.keys(e)));
});

test("verification never throws on junk", () => {
  const expected = challengeTx(alice.address, "n1", 100);
  fc.assert(
    fc.property(fc.anything(), (junk) => {
      assert.equal(verifyChallengeProof(junk, expected).ok, false);
      assert.equal(verifyChallengeProof({ tx_json: junk }, expected).ok, false);
      assert.equal(verifyChallengeProof({ hex: typeof junk === "string" ? junk : "ZZ" }, expected).ok, false);
    }),
    { numRuns: 200 },
  );
});

test("what Joey signs can't move funds and can't land", () => {
  fc.assert(
    fc.property(fc.hexaString({ minLength: 8, maxLength: 40 }), fc.integer({ min: 1, max: 2_000_000_000 }), (nonce, exp) => {
      const tx: ChallengeTx = challengeTx(alice.address, nonce, exp);
      assert.equal(tx.TransactionType, "AccountSet");
      assert.equal(tx.LastLedgerSequence, 1, "already in the past");
      assert.equal(tx.Fee, "0", "under the minimum fee");
      for (const key of ["Destination", "Amount", "SetFlag", "ClearFlag", "Flags", "Domain", "TransferRate"]) assert.ok(!(key in tx), key);
      assert.equal(tx.Memos[0].Memo.MemoType, MEMO_TYPE);
      assert.ok(Buffer.from(tx.Memos[0].Memo.MemoData, "hex").toString("utf8").includes(nonce));
    }),
  );
});

test("only real XRPL addresses get a challenge", () => {
  const { service } = harness();
  for (const bad of [null, "", "rNope", "0xabc", 7, {}, alice.address + "x", alice.address.replace(/.$/, alice.address.endsWith("a") ? "b" : "a")]) assert.equal(service.joeyChallenge(bad), null, String(bad));
  assert.ok(isAddress(alice.address));
});

test("tokens: tampering, a wrong secret, or the wrong kind reads as nothing", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 1000 }), (address, ttl) => {
      const raw = signToken({ k: "session", a: address, w: "xaman", exp: 5000 + ttl }, SECRET);
      assert.ok(readToken(raw, SECRET, ["session"], 5000));
      assert.equal(readToken(raw, "other", ["session"], 5000), null);
      assert.equal(readToken(raw, SECRET, ["joey", "xaman"], 5000), null);
      assert.equal(readToken(raw, SECRET, ["session"], 5000 + ttl), null);
      const [body, mac] = raw.split(".");
      const forged = Buffer.from(JSON.stringify({ k: "session", a: "rEvil", w: "xaman", exp: 99999 })).toString("base64url");
      assert.equal(readToken(`${forged}.${mac}`, SECRET, ["session"], 5000), null);
      assert.equal(readToken(body, SECRET, ["session"], 5000), null);
    }),
  );
  fc.assert(fc.property(fc.string(), (junk) => assert.equal(readToken(junk, SECRET, ["session"], 0), null)));
});

test("a challenge cookie can't be used as a session, nor a Joey challenge on Xaman", async () => {
  const { service } = harness();
  const { cookie } = challengeFor(service);
  assert.equal(service.readSession(cookie), null);
  assert.deepEqual(await service.xamanStatus(cookie), { state: "invalid" });
});

/** A signed blob like the one Xaman returns for a SignIn. */
const blob = (w = alice) => encode(signTx({ TransactionType: "AccountSet", Account: w.address, Fee: "0", Sequence: 0 }, w));
const signedPayload = (o: Partial<XamanPayloadResult> = {}, w = alice): XamanPayloadResult => ({
  meta: { exists: true, resolved: true, signed: true },
  payload: { tx_type: "SignIn" },
  custom_meta: { identifier: "nonce-1" },
  response: { hex: blob(w), account: w.address },
  ...o,
});

test("Xaman: a signed SignIn verifies against the signature itself", () => {
  assert.deepEqual(readXamanPayload(signedPayload(), "nonce-1"), { state: "signed", address: alice.address });
});

test("Xaman: each payload state reads correctly", () => {
  assert.deepEqual(readXamanPayload({ meta: { exists: true, resolved: false } }, "n"), { state: "pending" });
  assert.deepEqual(readXamanPayload({ meta: { exists: true, resolved: true, signed: false } }, "n"), { state: "declined" });
  assert.deepEqual(readXamanPayload({ meta: { exists: true, expired: true } }, "n"), { state: "expired" });
  assert.deepEqual(readXamanPayload({ meta: { exists: false } }, "n"), { state: "expired" });
  assert.deepEqual(readXamanPayload({ meta: { exists: true, cancelled: true } }, "n"), { state: "expired" });
});

test("Xaman: nothing is believed without a matching signature", () => {
  const cases: [string, XamanPayloadResult][] = [
    ["wrong nonce", signedPayload({ custom_meta: { identifier: "other" } })],
    ["not a SignIn", signedPayload({ payload: { tx_type: "Payment" } })],
    ["no hex", signedPayload({ response: { account: alice.address } })],
    ["claims another account", signedPayload({ response: { hex: blob(mallory), account: alice.address } })],
    ["bad account", signedPayload({ response: { hex: blob(), account: "rNope" } })],
    ["junk hex", signedPayload({ response: { hex: "ABCD", account: alice.address } })],
    ["tampered signature", signedPayload({ response: { hex: blob().replace(/[0-9A-F]{8}$/, "00000000"), account: alice.address } })],
  ];
  for (const [label, p] of cases) assert.equal(readXamanPayload(p, "nonce-1").state, "invalid", label);
});

const fakeXaman = (payload: () => XamanPayloadResult): XamanClient & { created: unknown[] } => {
  const created: unknown[] = [];
  return {
    created,
    async createSignIn(input) {
      created.push(input);
      return { uuid: "uuid-1", open: "https://xumm.app/sign/uuid-1", qr: "https://xumm.app/sign/uuid-1_q.png", ws: "wss://xumm.app/sign/uuid-1" };
    },
    async getPayload() {
      return payload();
    },
  };
};

test("Xaman end to end: start, wait, sign, session, and no replay", async () => {
  let state: XamanPayloadResult = { meta: { exists: true, resolved: false } };
  const fake = fakeXaman(() => state);
  const service = createAuthService({ secret: SECRET, store: memoryNonceStore(), xaman: fake, newNonce: () => "nonce-1" });
  const started = await service.startXaman("https://seal.example");
  assert.deepEqual(fake.created, [{ nonce: "nonce-1", returnUrl: "https://seal.example/auth/return?qr=1" }]);
  assert.equal(JSON.stringify(started).includes("uuid-1_q"), true);
  assert.deepEqual(await service.xamanStatus(started.cookie), { state: "pending" });
  state = signedPayload();
  const done = await service.xamanStatus(started.cookie);
  assert.equal(done.state, "signed");
  if (done.state === "signed") assert.deepEqual(service.readSession(done.cookie), { address: alice.address, wallet: "xaman" });
  assert.deepEqual(await service.xamanStatus(started.cookie), { state: "used" });
});

test("Xaman: an expired challenge cookie stops the check before it calls Xaman", async () => {
  let now = 1000;
  let calls = 0;
  const service = createAuthService({ secret: SECRET, store: memoryNonceStore(), nowS: () => now, xaman: fakeXaman(() => (calls++, signedPayload())) });
  const { cookie } = await service.startXaman("https://seal.example");
  now += CHALLENGE_TTL_S + 61;
  assert.deepEqual(await service.xamanStatus(cookie), { state: "expired" });
  assert.equal(calls, 0);
});

test("Xaman client: the only thing it asks for is a SignIn, and the secret stays in headers", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const client = createXamanClient("key", "secret", (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ uuid: "u", next: { always: "https://xumm.app/sign/u" }, refs: { qr_png: "https://xumm.app/sign/u_q.png", websocket_status: "wss://xumm.app/sign/u" } }));
  }) as never);
  const out = await client.createSignIn({ nonce: "n", returnUrl: "https://seal.example/auth/return?qr=1" });
  assert.equal(out.uuid, "u");
  const body = JSON.parse(String(seen[0].init.body));
  assert.deepEqual(body.txjson, { TransactionType: "SignIn" });
  assert.equal(body.options.submit, false);
  assert.ok(!String(seen[0].init.body).includes("secret"));
});

test("a spent id is refused until long after its token could still be read", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 20 }), async (ids) => {
      const store = memoryNonceStore(() => 0);
      const seen = new Set<string>();
      for (const id of ids) {
        assert.equal(await store.consume(id, 60), !seen.has(id));
        seen.add(id);
      }
    }),
  );
});

test("machine codes are configurable", () => {
  assert.equal(parseAllowlist(undefined), null);
  assert.equal(parseAllowlist(" , "), null);
  assert.deepEqual([...(parseAllowlist("a_1, b_2,") ?? [])], ["a_1", "b_2"]);
});
