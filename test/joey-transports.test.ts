import assert from "node:assert/strict";
import { test } from "node:test";
import { JOEY_METHODS, NO_DESTINATION, joeyPairLink, mobileReconnect, mobileSignIn, mobileTransport, pair, sessionAccount, sessionChain, sessionLive, type JoeySession, type WcProvider } from "../src/lib/wallet/joey-mobile.ts";
import { WalletRefusal, extensionReconnect, extensionSignIn, extensionTransport, type JoeyExtension, type SignInApi } from "../src/lib/wallet/joey-extension.ts";
import { memorySentLog, sendTx } from "../src/lib/wallet/send.ts";

const ME = "rnCcwvB4oAEsLR5rcsSYTUe3GPiaw2XcCW";
const OTHER = "rMQn4KDyuz429Le57wcfbNTSaTGNR7wuxK";
const PAY = { TransactionType: "Payment", Account: ME, Destination: OTHER, Amount: "4000000", InvoiceID: "AB".repeat(32), LastLedgerSequence: 100 };

/** Stands in for the injected provider, with the shapes Joey's docs and its real extension give. */
function fakeJoey(over: { accounts?: string[]; chain?: string; signIn?: unknown; submit?: (p: unknown) => unknown } = {}) {
  const calls: { method: string; params?: unknown }[] = [];
  const listeners = new Map<string, () => void>();
  const accounts = over.accounts ?? [ME];
  const chain = over.chain ?? "xrpl:0";
  const joey = {
    connect: async (p?: unknown) => (calls.push({ method: "connect", params: p }), { accounts: accounts.map((address) => ({ address })), chain, networkId: Number(chain.slice(5)) }),
    disconnect: async () => void calls.push({ method: "disconnect" }),
    getAccounts: async () => accounts,
    getNetwork: async () => ({ chain, networkId: Number(chain.slice(5)), name: "x" }),
    signIn: async (p: unknown) => (calls.push({ method: "signIn", params: p }), over.signIn ?? { address: ME, publicKey: "K", signature: "S", message: "M" }),
    signAndSubmitTransaction: async (p: { tx_json: Record<string, unknown> }) => {
      calls.push({ method: "signAndSubmitTransaction", params: p });
      if (over.submit) return over.submit(p);
      return { hash: "HASH", engine_result: "tesSUCCESS", tx_blob: "AA", tx_json: { ...p.tx_json, Fee: "12", Sequence: 1, TxnSignature: "S" } };
    },
    on: (event: string, fn: () => void) => (listeners.set(event, fn), () => listeners.delete(event)),
  } as unknown as JoeyExtension;
  return { joey, calls, listeners };
}

const api = (chain = "xrpl:0"): SignInApi & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return { seen, nonce: async () => ({ nonce: "N", statement: "S", challenge: "site:N", chain }), verify: async (proof) => (seen.push(proof), { address: ME }) };
};

test("extension sign-in: connect, check the network, sign the server's nonce, and let the server decide", async () => {
  const { joey, calls } = fakeJoey();
  const a = api();
  assert.deepEqual(await extensionSignIn(joey, a), { address: ME });
  assert.deepEqual(calls.map((c) => c.method), ["connect", "signIn"]);
  assert.deepEqual(calls[1].params, { statement: "S", nonce: "N" });
  assert.equal(a.seen.length, 1);
});

test("extension sign-in on the wrong network is refused before anything is signed", async () => {
  const { joey, calls } = fakeJoey({ chain: "xrpl:1" });
  await assert.rejects(extensionSignIn(joey, api()), (e) => e instanceof WalletRefusal && /Testnet/.test((e as Error).message) && /Mainnet/.test((e as Error).message));
  assert.ok(!calls.some((c) => c.method === "signIn"));
});

test("extension reconnect has to come back with the same account, on this network", async () => {
  await extensionReconnect(fakeJoey().joey, ME, "xrpl:0");
  await assert.rejects(extensionReconnect(fakeJoey({ accounts: [OTHER] }).joey, ME, "xrpl:0"), WalletRefusal);
  await assert.rejects(extensionReconnect(fakeJoey({ chain: "xrpl:1" }).joey, ME, "xrpl:0"), WalletRefusal);
});

test("extension signing names the account and chain, sends the server's fields untouched, and asks for no NetworkID", async () => {
  const { joey, calls } = fakeJoey();
  const out = await sendTx(extensionTransport(joey), PAY, { sessionAddress: ME, expectedChain: "xrpl:0", log: memorySentLog(), flights: new Map() });
  assert.deepEqual(out, { state: "sent", hash: "HASH" });
  const sent = calls.find((c) => c.method === "signAndSubmitTransaction")?.params as Record<string, unknown>;
  assert.deepEqual(sent, { tx_json: PAY, account: ME, chain: "xrpl:0" });
  assert.equal((sent.tx_json as Record<string, unknown>).NetworkID, undefined);
});

test("extension: a wrong account or network never reaches a signing call", async () => {
  for (const f of [fakeJoey({ accounts: [OTHER] }), fakeJoey({ chain: "xrpl:1" })]) {
    const out = await sendTx(extensionTransport(f.joey), PAY, { sessionAddress: ME, expectedChain: "xrpl:0", log: memorySentLog(), flights: new Map() });
    assert.equal(out.state, "refused");
    assert.ok(!f.calls.some((c) => c.method === "signAndSubmitTransaction"));
  }
});

test("extension: changes in the wallet reach the sheet, and stop when it closes", () => {
  const { joey, listeners } = fakeJoey();
  const seen: string[] = [];
  const stop = extensionTransport(joey).onChange((w) => seen.push(w));
  listeners.get("accountsChanged")?.();
  listeners.get("networkChanged")?.();
  listeners.get("disconnect")?.();
  assert.deepEqual(seen, ["account", "network", "disconnect"]);
  stop();
  assert.equal(listeners.size, 0);
});

const session = (account = ME, chain = "xrpl:0", extra: Record<string, string> = {}) =>
  ({ topic: "t", expiry: Math.floor(Date.now() / 1000) + 1000, namespaces: { xrpl: { chains: [chain], accounts: [`${chain}:${account}`], methods: JOEY_METHODS, events: [] } }, sessionProperties: extra }) as unknown as JoeySession;

/** Stands in for the WalletConnect relay: whatever Joey's docs say it answers. */
function fakeProvider(over: { session?: JoeySession | null; onConnect?: (o: unknown) => JoeySession | undefined; onRequest?: (a: unknown, chain?: string) => unknown } = {}) {
  const calls: { method: string; args?: unknown; chain?: string }[] = [];
  const on = new Map<string, (...a: unknown[]) => void>();
  const p = {
    session: over.session ?? undefined,
    connect: async (o: unknown) => {
      calls.push({ method: "connect", args: o });
      const s = over.onConnect ? over.onConnect(o) : session();
      p.session = s;
      return s;
    },
    disconnect: async () => {
      calls.push({ method: "disconnect" });
      p.session = undefined;
    },
    request: async (a: unknown, chain?: string) => {
      calls.push({ method: "request", args: a, chain });
      return over.onRequest ? over.onRequest(a, chain) : { tx_json: { ...(a as { params: { tx_json: object } }).params.tx_json, hash: "WC_HASH", Fee: "12", Sequence: 2 } };
    },
    on: (e: string, f: (...a: unknown[]) => void) => void on.set(e, f),
    off: (e: string) => void on.delete(e),
  };
  return { provider: p as unknown as WcProvider, raw: p, calls, on };
}

const mobileApi = (chain = "xrpl:0", address = ME) => {
  const log: Record<string, unknown[]> = { verify: [], legacy: [] };
  return { log, nonce: async () => ({ nonce: "N", statement: "S", challenge: "site:N", chain }), verify: async (proof: unknown) => (log.verify.push(proof), { address }), legacyChallenge: async () => ({ TransactionType: "AccountSet", Account: address }), legacyVerify: async (s: unknown) => (log.legacy.push(s), { address }) };
};

test("a session reads as one account on one chain", () => {
  assert.equal(sessionAccount(session(), "xrpl:0"), ME);
  assert.equal(sessionAccount(session(), "xrpl:1"), null);
  assert.equal(sessionChain(session(ME, "xrpl:1")), "xrpl:1");
  assert.equal(sessionChain(null), null);
  assert.equal(sessionLive(session()), true);
  assert.equal(sessionLive(null), false);
  assert.equal(sessionLive({ expiry: 100 }, 200), false);
  assert.equal(joeyPairLink("wc:a@2?x=1&y=2"), "joey://settings/wc?uri=wc%3Aa%402%3Fx%3D1%26y%3D2");
});

test("pairing asks for the xrpl namespace on this chain only, and for sign-in on one screen when signing in", async () => {
  const f = fakeProvider();
  await pair(f.provider, "xrpl:1", { challenge: "c" });
  assert.deepEqual(f.calls[0].args, { namespaces: { xrpl: { chains: ["xrpl:1"], methods: JOEY_METHODS, events: [] } }, sessionProperties: { xrpl_signin_v1_challenge: "c", xrpl_signin_v1_destination: NO_DESTINATION } });
  const g = fakeProvider();
  await pair(g.provider, "xrpl:0");
  assert.equal((g.calls[0].args as Record<string, unknown>).sessionProperties, undefined);
});

test("mobile sign-in: one approval, the proof goes to the server, and the session stays open for payments", async () => {
  const f = fakeProvider({ onConnect: () => session(ME, "xrpl:0", { xrpl_signin_v1_signed_tx: "{json}" }) });
  const a = mobileApi();
  assert.deepEqual(await mobileSignIn(f.provider, a), { address: ME });
  assert.deepEqual(a.log.verify, [{ mode: "challenge-v1", signedTx: "{json}" }]);
  assert.ok(!f.calls.some((c) => c.method === "disconnect"), "kept open");
  assert.ok(!f.calls.some((c) => c.method === "request"), "no second approval");
});

test("mobile sign-in falls back to a sign-only request when Joey's screen didn't sign", async () => {
  const f = fakeProvider({ onRequest: () => ({ tx_json: { hash: "x" } }) });
  const a = mobileApi();
  await mobileSignIn(f.provider, a);
  const req = f.calls.find((c) => c.method === "request");
  assert.equal((req?.args as { params: { submit: boolean; autofill: boolean } }).params.submit, false);
  assert.equal((req?.args as { params: { submit: boolean; autofill: boolean } }).params.autofill, false);
  assert.equal(req?.chain, "xrpl:0");
  assert.equal(a.log.legacy.length, 1);
});

test("mobile sign-in: a wrong network ends the session before anything counts, and a mismatch is refused", async () => {
  const wrongNet = fakeProvider({ onConnect: () => session(ME, "xrpl:1", { xrpl_signin_v1_signed_tx: "{json}" }) });
  const a = mobileApi();
  await assert.rejects(mobileSignIn(wrongNet.provider, a), WalletRefusal);
  assert.equal(a.log.verify.length, 0);
  assert.ok(wrongNet.calls.some((c) => c.method === "disconnect"));
  const mismatch = fakeProvider({ onConnect: () => session(OTHER, "xrpl:0", { xrpl_signin_v1_signed_tx: "{json}" }) });
  await assert.rejects(mobileSignIn(mismatch.provider, mobileApi()), WalletRefusal);
  assert.ok(mismatch.calls.some((c) => c.method === "disconnect"));
});

test("mobile reconnect has to be the same account on this network", async () => {
  await mobileReconnect(fakeProvider().provider, ME, "xrpl:0");
  for (const s of [session(OTHER), session(ME, "xrpl:1")]) {
    const f = fakeProvider({ onConnect: () => s });
    await assert.rejects(mobileReconnect(f.provider, ME, "xrpl:0"), WalletRefusal);
    assert.ok(f.calls.some((c) => c.method === "disconnect"));
  }
});

test("mobile signing submits from the phone, with the server's fields, and brings Joey forward once asked", async () => {
  const f = fakeProvider({ session: session() });
  let asked = 0;
  const out = await sendTx(mobileTransport(f.provider, { onAsked: () => asked++ }), PAY, { sessionAddress: ME, expectedChain: "xrpl:0", log: memorySentLog(), flights: new Map() });
  assert.deepEqual(out, { state: "sent", hash: "WC_HASH" });
  const req = f.calls.find((c) => c.method === "request");
  assert.deepEqual(req?.args, { method: "xrpl_signTransaction", params: { tx_json: PAY, submit: true, autofill: true } });
  assert.equal(req?.chain, "xrpl:0");
  assert.equal(asked, 1);
});

test("mobile: a session lost on reload, or for another account or network, signs nothing", async () => {
  const cases = [{ s: undefined, code: "not_connected" }, { s: session(OTHER), code: "wrong_account" }, { s: session(ME, "xrpl:1"), code: "wrong_network" }, { s: { ...session(), expiry: 1 } as JoeySession, code: "not_connected" }];
  for (const { s, code } of cases) {
    const f = fakeProvider({ session: s });
    const out = await sendTx(mobileTransport(f.provider), PAY, { sessionAddress: ME, expectedChain: "xrpl:0", log: memorySentLog(), flights: new Map() });
    assert.equal(out.state === "refused" && out.code, code);
    assert.ok(!f.calls.some((c) => c.method === "request"));
  }
});

test("mobile: Joey's error codes read plainly, and a submit the ledger refused says so", async () => {
  for (const [err, state] of [[{ code: 5000, message: "User rejected." }, "declined"], [{ code: 5100, message: "Joey is on xrpl:1" }, "refused"], [{ code: 5103, message: "switch" }, "refused"], [{ code: -32003, message: "tecUNFUNDED_PAYMENT", data: '{"failedIndex":0}' }, "failed"], [{ code: -32003, message: "timed out" }, "unknown"]] as const) {
    const f = fakeProvider({ session: session(), onRequest: () => { throw err; } });
    const out = await sendTx(mobileTransport(f.provider), PAY, { sessionAddress: ME, expectedChain: "xrpl:0", log: memorySentLog(), flights: new Map() });
    assert.equal(out.state, state, JSON.stringify(err));
  }
});

test("mobile: Joey ending the session reaches the sheet, and stops when it closes", () => {
  const f = fakeProvider({ session: session() });
  const seen: string[] = [];
  const stop = mobileTransport(f.provider).onChange((w) => seen.push(w));
  f.on.get("session_delete")?.();
  assert.deepEqual(seen, ["disconnect"]);
  stop();
  assert.equal(f.on.size, 0);
});
