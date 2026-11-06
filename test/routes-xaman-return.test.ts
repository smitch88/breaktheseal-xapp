import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKeypair, sign } from "ripple-keypairs";
import { encode, encodeForSigning } from "xrpl-binary-codec-prerelease";
import { walletOf, world, type World } from "./support-routes.ts";

const alice = walletOf(41);
const bob = walletOf(42);
const TO = "/checkout?nft=5";

const blob = (w = alice) => {
  const kp = deriveKeypair(w.seed as string);
  const tx = { TransactionType: "AccountSet", Account: w.classicAddress, Fee: "0", Sequence: 0, SigningPubKey: kp.publicKey };
  return encode({ ...tx, TxnSignature: sign(encodeForSigning(tx as never), kp.privateKey) });
};

/** What Xaman's API answers for a signed sign-in, for the request the site just made. */
const signedBy = (w: World, who = alice, over: Record<string, unknown> = {}) => ({
  meta: { exists: true, resolved: true, signed: true },
  payload: { tx_type: "SignIn", created_at: new Date().toISOString() },
  custom_meta: { identifier: w.xaman.calls.at(-1)!.custom_meta.identifier },
  response: { hex: blob(who), account: who.classicAddress, resolved_at: new Date().toISOString() },
  ...over,
});

/** A phone starts a sign-in. Returns what Xaman would send it back with, with its `{id}` filled in. */
async function phoneStart(w: World, browser = w.client(), to = TO) {
  const start = await w.call("POST", "/api/auth/xaman/start", { as: browser, body: { to, phone: true } });
  assert.equal(start.status, 200);
  const uuid = String(start.body.open).split("/").pop() as string;
  const back = new URL(w.xaman.calls.at(-1)!.options.return_url.app.replace("{id}", uuid));
  return { browser, uuid, key: back.searchParams.get("k"), to: back.searchParams.get("to"), back };
}
const returned = (w: World, as: ReturnType<World["client"]>, s: { uuid: string; key: string | null }, extra: Record<string, unknown> = {}) => w.call("POST", "/api/auth/xaman/return", { as, body: { xp: s.uuid, k: s.key, ...extra } });

test("a phone's sign-in carries Xaman's id placeholder and a key, and keeps the place it left", async () => {
  const w = await world({ xaman: true });
  await w.call("POST", "/api/auth/xaman/start", { as: w.client(), body: { to: TO, phone: true } });
  const sent = w.xaman.calls.at(-1)!.options.return_url;
  assert.match(sent.app, /\/auth\/return\?xp=\{id\}&k=[0-9a-f]{32,}&to=%2Fcheckout%3Fnft%3D5$/);
  assert.equal(sent.web, sent.app);
});

test("a desktop QR's return link carries no key, so seeing the QR can't finish a sign-in elsewhere", async () => {
  const w = await world({ xaman: true });
  await w.call("POST", "/api/auth/xaman/start", { as: w.client(), body: { to: TO } });
  assert.equal(w.xaman.calls.at(-1)!.options.return_url.app, `${w.SITE}/auth/return?qr=1&to=%2Fcheckout%3Fnft%3D5`);
});

test("same browser: the return page signs in from the cookie", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  w.xaman.payload = signedBy(w);
  const r = await returned(w, s.browser, s);
  assert.equal(r.body.state, "signed");
  assert.deepEqual(r.body.session, { address: alice.classicAddress, wallet: "xaman" });
  assert.equal(s.browser.jar.has("seal_challenge"), false);
  assert.equal((await w.call("GET", "/api/auth/session", { as: s.browser })).body.session.address, alice.classicAddress);
});

test("the bug: the first tab finished the sign-in, then the return page in the same browser still ends signed in", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  w.xaman.payload = signedBy(w);
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: s.browser })).body.state, "signed");
  assert.equal(s.browser.jar.has("seal_challenge"), false);
  const r = await returned(w, s.browser, s);
  assert.equal(r.body.state, "signed");
  assert.equal(r.body.session.address, alice.classicAddress);
});

test("the bug: a different browser, with no cookie at all, finishes the sign-in by itself", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  const other = w.client();
  w.xaman.payload = signedBy(w);
  const r = await returned(w, other, s);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "signed");
  assert.deepEqual(r.body.session, { address: alice.classicAddress, wallet: "xaman" });
  assert.equal((await w.call("GET", "/api/auth/session", { as: other })).body.session.address, alice.classicAddress);
});

test("the link works once: a third browser is refused, and reloading in the browser that used it still reads signed in", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  const other = w.client();
  w.xaman.payload = signedBy(w);
  assert.equal((await returned(w, other, s)).body.state, "signed");
  const third = w.client();
  assert.equal((await returned(w, third, s)).body.state, "used");
  assert.equal(third.jar.has("seal_session"), false);
  assert.equal((await returned(w, other, s)).body.state, "signed");
});

test("either order finishes in both: the starting tab can't strand the return browser, or the other way round", async () => {
  const w = await world({ xaman: true });
  const first = await phoneStart(w);
  w.xaman.payload = signedBy(w);
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: first.browser })).body.state, "signed");
  const elsewhere = w.client();
  assert.equal((await returned(w, elsewhere, first)).body.state, "signed");

  const second = await phoneStart(w);
  w.xaman.payload = signedBy(w);
  const elsewhere2 = w.client();
  assert.equal((await returned(w, elsewhere2, second)).body.state, "signed");
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: second.browser })).body.state, "signed");
  // The cookie is spent too: playing it back gets nothing more.
  const thief = w.client();
  assert.equal((await w.call("POST", "/api/auth/xaman/status", { as: thief })).body.state, "expired");
});

test("no key, or a wrong one, finishes nothing: knowing the id from a QR isn't enough", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  w.xaman.payload = signedBy(w);
  for (const key of [null, "", "00".repeat(32), `${s.key}0`, 5]) {
    const stranger = w.client();
    const r = await w.call("POST", "/api/auth/xaman/return", { as: stranger, body: { xp: s.uuid, k: key } });
    assert.equal(r.body.state, "gone", String(key));
    assert.equal(stranger.jar.has("seal_session"), false);
  }
});

test("a key for one sign-in can't open another", async () => {
  const w = await world({ xaman: true });
  const a = await phoneStart(w);
  const b = await phoneStart(w);
  w.xaman.payload = signedBy(w);
  const stranger = w.client();
  assert.equal((await returned(w, stranger, { uuid: b.uuid, key: a.key })).body.state, "gone");
  assert.equal(stranger.jar.has("seal_session"), false);
});

test("nothing short of a signed sign-in, checked here, makes a session", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  const good = signedBy(w);
  const old = new Date(Date.now() - 3600_000).toISOString();
  const cases: [string, unknown, string][] = [
    ["waiting", { ...good, meta: { exists: true, resolved: false } }, "pending"],
    ["declined", { ...good, meta: { exists: true, resolved: true, signed: false } }, "declined"],
    ["expired", { ...good, meta: { exists: true, expired: true } }, "expired"],
    ["cancelled", { ...good, meta: { exists: true, cancelled: true } }, "expired"],
    ["a payment, not a sign-in", { ...good, payload: { ...good.payload, tx_type: "Payment" } }, "gone"],
    ["no signature", { ...good, response: { ...good.response, hex: null } }, "gone"],
    ["signed by someone else", { ...good, response: { ...good.response, hex: blob(bob) } }, "gone"],
    ["signed long ago", { ...good, response: { ...good.response, resolved_at: old } }, "expired"],
    ["no time on it", { ...good, response: { ...good.response, resolved_at: undefined } }, "expired"],
    ["made long ago", { ...good, payload: { ...good.payload, created_at: old } }, "expired"],
  ];
  for (const [what, payload, want] of cases) {
    w.xaman.payload = payload;
    const stranger = w.client();
    const r = await returned(w, stranger, s);
    assert.equal(r.body.state, want, what);
    assert.equal(stranger.jar.has("seal_session"), false, what);
  }
});

test("a failed try spends nothing: the real return still works", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  const other = w.client();
  w.xaman.payload = { ...signedBy(w), meta: { exists: true, resolved: false } };
  assert.equal((await returned(w, other, s)).body.state, "pending");
  w.xaman.payload = signedBy(w);
  assert.equal((await returned(w, w.client(), { uuid: s.uuid, key: "bad" })).body.state, "gone");
  assert.equal((await returned(w, other, s)).body.state, "signed");
});

test("login CSRF: a link for someone else's account doesn't replace who is signed in here without a press", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  const victim = w.client(bob.classicAddress);
  const before = victim.jar.get("seal_session");
  w.xaman.payload = signedBy(w);
  const r = await returned(w, victim, s);
  assert.equal(r.body.state, "other-account");
  assert.equal(r.body.session.address, bob.classicAddress);
  assert.equal(r.body.wanted, alice.classicAddress);
  assert.equal(victim.jar.get("seal_session"), before);
  // Unspent, so it can still be taken up on purpose.
  const swap = await returned(w, victim, s, { replace: true });
  assert.equal(swap.body.state, "signed");
  assert.equal((await w.call("GET", "/api/auth/session", { as: victim })).body.session.address, alice.classicAddress);
});

test("a return page with nothing to go on says so, and a signed-in browser stays signed in", async () => {
  const w = await world({ xaman: true });
  assert.equal((await w.call("POST", "/api/auth/xaman/return", { as: w.client(), body: {} })).body.state, "gone");
  const held = w.client(bob.classicAddress);
  const r = await w.call("POST", "/api/auth/xaman/return", { as: held, body: {} });
  assert.equal(r.body.state, "signed");
  assert.equal(r.body.session.address, bob.classicAddress);
});

test("the return route: from elsewhere is refused, junk is harmless, unset-up says so, a Xaman outage reads as waiting", async () => {
  const w = await world({ xaman: true });
  const s = await phoneStart(w);
  assert.equal((await w.call("POST", "/api/auth/xaman/return", { as: w.client(), body: { xp: s.uuid, k: s.key }, origin: "https://evil.test" })).status, 403);
  assert.equal((await w.call("POST", "/api/auth/xaman/return", { as: w.client(), raw: "junk" })).body.state, "gone");
  assert.equal((await w.call("POST", "/api/auth/xaman/return", { as: w.client(), body: { xp: "../../etc", k: s.key } })).body.state, "gone");
  w.xaman.mode = "down";
  assert.equal((await returned(w, w.client(), s)).body.state, "pending");
  delete process.env.SEAL_SESSION_SECRET;
  assert.equal((await returned(w, w.client(), s)).status, 503);
});

test("a stale cookie from an older sign-in doesn't get in the way of the one that came back", async () => {
  const w = await world({ xaman: true });
  const browser = w.client();
  await phoneStart(w, browser);
  const other = w.client();
  const newer = await phoneStart(w, other);
  // `browser` holds a cookie for the first request, and comes back with the link for the second.
  w.xaman.payload = signedBy(w);
  const r = await returned(w, browser, newer);
  assert.equal(r.body.state, "signed");
});
