import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { FAILED_LOCK_MS, SENT_LOCK_MS, gate, memorySentLog, readEngineResult, readWalletError, sendTx, signedMatches, txKey, type SignerTransport, type Tx } from "../src/lib/wallet/send.ts";
import { wrongNetworkText } from "../src/lib/wallet/chain.ts";

const ME = "rnCcwvB4oAEsLR5rcsSYTUe3GPiaw2XcCW";
const OTHER = "rMQn4KDyuz429Le57wcfbNTSaTGNR7wuxK";
const PAY: Tx = { TransactionType: "Payment", Account: ME, Destination: OTHER, Amount: "4000000", InvoiceID: "AB".repeat(32), LastLedgerSequence: 100 };

function fake(over: Partial<SignerTransport> & { account?: string[]; net?: string } = {}) {
  const asked: { tx: Tx; account: string; chain: string }[] = [];
  const t: SignerTransport = {
    kind: "extension",
    accounts: async () => over.account ?? [ME],
    network: async () => over.net ?? "xrpl:0",
    signAndSubmit: async (req) => (asked.push(req), { hash: "H1", engineResult: "tesSUCCESS", signed: { ...req.tx, Fee: "12", Sequence: 7, TxnSignature: "SIG" } }),
    onChange: () => () => {},
    ...over,
  };
  return { t, asked };
}
const ctx = (over = {}) => ({ sessionAddress: ME, expectedChain: "xrpl:0", log: memorySentLog(), flights: new Map(), ...over });

test("the wallet signs exactly what the server gave it, for the signed-in account, on this network", async () => {
  const { t, asked } = fake();
  const out = await sendTx(t, PAY, ctx());
  assert.deepEqual(out, { state: "sent", hash: "H1" });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { tx: PAY, account: ME, chain: "xrpl:0" });
});

test("a different account in the wallet is refused before signing, with a plain message", async () => {
  const { t, asked } = fake({ account: [OTHER] });
  const out = await sendTx(t, PAY, ctx());
  assert.equal(out.state, "refused");
  assert.equal(out.state === "refused" && out.code, "wrong_account");
  assert.match(out.state === "refused" ? out.text : "", /signed in with/);
  assert.equal(asked.length, 0);
});

test("any account that isn't the session's can't be paid from, whatever else the wallet shares", () =>
  fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom(OTHER, "rUmoi1vt8apeKsqFYKMRSiMvWixFDMC8Jz", "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"), { maxLength: 4 }), async (accounts) => {
      const { t, asked } = fake({ account: accounts });
      const out = await sendTx(t, PAY, ctx());
      assert.equal(out.state, "refused");
      assert.equal(asked.length, 0);
    }),
    { numRuns: 30 },
  ));

test("a transaction made out to another account is refused before anything else", async () => {
  const { t, asked } = fake();
  const out = await sendTx(t, { ...PAY, Account: OTHER }, ctx());
  assert.equal(out.state === "refused" && out.code, "wrong_account");
  assert.equal(asked.length, 0);
});

test("mainnet site with a wallet on testnet is refused before signing, and the message names both", async () => {
  const { t, asked } = fake({ net: "xrpl:1" });
  const out = await sendTx(t, PAY, ctx());
  assert.equal(out.state === "refused" && out.code, "wrong_network");
  assert.equal(out.state === "refused" && out.text, wrongNetworkText("xrpl:1", "xrpl:0"));
  assert.equal(asked.length, 0);
});

test("a wallet connected to nothing asks to reconnect, and nothing is signed", async () => {
  const { t, asked } = fake({ account: [] });
  const out = await sendTx(t, PAY, ctx());
  assert.equal(out.state === "refused" && out.code, "not_connected");
  assert.equal(asked.length, 0);
});

test("a double press makes one request, however many presses and however they land", () =>
  fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (presses) => {
      const { t, asked } = fake();
      const c = ctx();
      const outs = await Promise.all(Array.from({ length: presses }, () => sendTx(t, PAY, c)));
      assert.equal(asked.length, 1);
      assert.ok(outs.every((o) => o.state === "sent"));
      // A press straight after it landed joins the same answer too.
      assert.deepEqual(await sendTx(t, PAY, c), { state: "sent", hash: "H1", already: true });
      assert.equal(asked.length, 1);
    }),
    { numRuns: 20 },
  ));

test("after a reload a sent transaction isn't sent again until its lock runs out, and then only if the order is still open", async () => {
  const { t, asked } = fake();
  let now = 1000;
  const log = memorySentLog();
  await sendTx(t, PAY, ctx({ log, now: () => now }));
  now += SENT_LOCK_MS - 1;
  // A fresh page: nothing in memory, the log still knows.
  assert.equal((await sendTx(t, PAY, ctx({ log, now: () => now, force: true }))).state, "sent");
  assert.equal(asked.length, 1);
  now += 2;
  await sendTx(t, PAY, ctx({ log, now: () => now, force: true }));
  assert.equal(asked.length, 2);
});

test("a request the wallet may still be holding isn't repeated by itself, only by a press", async () => {
  let release: (v: { hash: string }) => void = () => {};
  const pending = new Promise<{ hash: string }>((r) => (release = r));
  const { t } = fake({ signAndSubmit: () => pending });
  const log = memorySentLog();
  void sendTx(t, PAY, ctx({ log }));
  await new Promise((r) => setTimeout(r, 5));
  const second = fake();
  // Reloaded: a new page with the same log.
  assert.deepEqual(await sendTx(second.t, PAY, ctx({ log })), { state: "asked" });
  assert.equal(second.asked.length, 0);
  assert.equal((await sendTx(second.t, PAY, ctx({ log, force: true }))).state, "sent");
  assert.equal(second.asked.length, 1);
  release({ hash: "late" });
});

test("two different orders are two requests", async () => {
  const { t, asked } = fake();
  const c = ctx();
  await Promise.all([sendTx(t, PAY, c), sendTx(t, { ...PAY, InvoiceID: "CD".repeat(32) }, c)]);
  assert.equal(asked.length, 2);
});

test("a decline ends cleanly and can be asked again", async () => {
  let no = true;
  const { t, asked } = fake();
  const wrapped: SignerTransport = { ...t, signAndSubmit: async (r) => { if (no) { no = false; throw Object.assign(new Error("User rejected"), { code: 4001 }); } return t.signAndSubmit(r); } };
  const c = ctx();
  assert.deepEqual(await sendTx(wrapped, PAY, c), { state: "declined" });
  assert.equal((await sendTx(wrapped, PAY, c)).state, "sent");
  assert.equal(asked.length, 1);
});

test("a thrown error we can't place may have landed: it says so, and holds off a resend", async () => {
  let now = 1000;
  const { t } = fake({ signAndSubmit: async () => { throw Object.assign(new Error("boom"), { code: -32603 }); } });
  const log = memorySentLog();
  const out = await sendTx(t, PAY, ctx({ log, now: () => now }));
  assert.equal(out.state, "unknown");
  now += 1000;
  const second = fake();
  assert.equal((await sendTx(second.t, PAY, ctx({ log, now: () => now, force: true }))).state, "sent");
  assert.equal(second.asked.length, 0);
});

test("a wallet that changes the transaction is reported, not celebrated", async () => {
  const { t } = fake({ signAndSubmit: async (r) => ({ hash: "H", engineResult: "tesSUCCESS", signed: { ...r.tx, Destination: "rUmoi1vt8apeKsqFYKMRSiMvWixFDMC8Jz" } }) });
  assert.equal((await sendTx(t, PAY, ctx())).state, "unknown");
});

test("signed answers: fee and sequence may be added; destination, amount and invoice may not change", () => {
  assert.equal(signedMatches(PAY, null), true);
  assert.equal(signedMatches(PAY, { ...PAY, Fee: "12", Sequence: 9, SigningPubKey: "AA", TxnSignature: "BB" }), true);
  assert.equal(signedMatches(PAY, { ...PAY, InvoiceID: String(PAY.InvoiceID).toLowerCase() }), true);
  for (const f of ["Account", "Destination", "Amount", "InvoiceID"]) assert.equal(signedMatches(PAY, { ...PAY, [f]: "changed" }), false, f);
  const trust: Tx = { TransactionType: "TrustSet", Account: ME, LimitAmount: { currency: "SEAL", issuer: OTHER, value: "10" } };
  assert.equal(signedMatches(trust, { ...trust, LimitAmount: { currency: "SEAL", issuer: ME, value: "10" } }), false);
});

test("a first answer from the ledger, read honestly", () => {
  assert.deepEqual(readEngineResult("tesSUCCESS", "H"), { state: "sent", hash: "H" });
  assert.deepEqual(readEngineResult("terQUEUED", "H"), { state: "sent", hash: "H" });
  assert.deepEqual(readEngineResult(null, "H"), { state: "sent", hash: "H" });
  assert.deepEqual(readEngineResult("tefALREADY", "H"), { state: "sent", hash: "H", already: true });
  for (const c of ["tecUNFUNDED_PAYMENT", "tecINSUFFICIENT_RESERVE", "tecNO_ENTRY", "tecSOMETHING_NEW", "tefPAST_SEQ", "telINSUF_FEE_P", "temMALFORMED"]) {
    const r = readEngineResult(c, "H");
    assert.equal(r.state, "failed", c);
    assert.match(r.state === "failed" ? r.text : "", /moved/, c);
  }
  assert.equal(readEngineResult("whatever", null).state, "unknown");
});

test("failed sends hold off a retry for a beat and then allow it", async () => {
  let now = 1000;
  const { t, asked } = fake({ signAndSubmit: async () => ({ hash: "H", engineResult: "tecUNFUNDED_PAYMENT" }) });
  const log = memorySentLog();
  assert.equal((await sendTx(t, PAY, ctx({ log, now: () => now }))).state, "failed");
  const early = await sendTx(t, PAY, ctx({ log, now: () => now }));
  assert.equal(early.state === "failed" && early.code, "wait");
  assert.equal(asked.length, 0);
  now += FAILED_LOCK_MS;
  assert.equal(gate(log.get(txKey(PAY)), now).open, true);
});

test("every wallet error code gets a plain answer, and none of them claims success", () => {
  const cases: [SignerTransport["kind"], unknown, string][] = [
    ["extension", { code: 4001, message: "rejected" }, "declined"],
    ["mobile", { code: 5000, message: "User rejected." }, "declined"],
    ["extension", { code: 4100 }, "refused"],
    ["extension", { code: 4300 }, "refused"],
    ["extension", { code: 4900 }, "refused"],
    ["extension", { code: 4901 }, "refused"],
    ["mobile", { code: 5100 }, "refused"],
    ["mobile", { code: 5103 }, "refused"],
    ["mobile", { code: 8000 }, "refused"],
    ["extension", { code: -32005 }, "refused"],
    ["extension", { code: -32602, message: "bad field" }, "refused"],
    ["mobile", { code: -32003, message: "tecPATH_PARTIAL" }, "failed"],
    ["mobile", { code: -32003, message: "could not confirm" }, "unknown"],
    ["mobile", { code: -32003, message: "tesSUCCESS" }, "unknown"],
    ["mobile", { message: "No matching key. session topic doesn't exist" }, "refused"],
    ["extension", new Error("something else"), "unknown"],
    ["extension", undefined, "unknown"],
  ];
  for (const [kind, err, want] of cases) assert.equal(readWalletError(kind, err).state, want, JSON.stringify(err));
});

test("one order, offer or trust line is one key, whatever else a wallet adds", () => {
  assert.equal(txKey(PAY), txKey({ ...PAY, Fee: "12", Sequence: 3 }));
  const accept = { TransactionType: "NFTokenAcceptOffer", Account: ME, NFTokenSellOffer: "AA" };
  assert.notEqual(txKey(accept), txKey({ ...accept, NFTokenSellOffer: "BB" }));
  const trust = { TransactionType: "TrustSet", Account: ME, LimitAmount: { currency: "SEAL", issuer: OTHER, value: "1" } };
  assert.equal(txKey(trust), txKey({ ...trust, LimitAmount: { currency: "SEAL", issuer: OTHER, value: "2" } }));
});
