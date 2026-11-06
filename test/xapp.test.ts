import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { deriveAddress, deriveKeypair, generateSeed } from "ripple-keypairs";
import { memoryNonceStore } from "../src/lib/auth/nonces.ts";
import { createAuthService, type XamanClient } from "../src/lib/auth/service.ts";
import { readToken, signToken } from "../src/lib/auth/tokens.ts";
import { externalUrl, inXamanWebview, isXamanHost, launchToken, outcomeOf, pacedHost, refusalText, sheetMode, xappLink, xappSdk } from "../src/lib/auth/xapp-host.ts";
import { createXappClient } from "../src/lib/auth/xapp-client.ts";
import { ripAgainHref } from "../src/lib/live/client.ts";
import { XAPP_TTL_S, createXappService, ottShape, readOtt, xappEnabled, xappNetwork, type XappXaman } from "../src/lib/auth/xapp.ts";
import { SUPPORT } from "../src/lib/legal/content.ts";
import { inlineParts, plainText } from "../src/lib/legal/inline.ts";
import { requestSignature } from "../src/lib/rip/xaman.ts";
import { XAPP_HEAD_SCRIPT } from "../src/lib/xapp-style.ts";

const SECRET = "test-secret-not-a-real-one";
const address = () => deriveAddress(deriveKeypair(generateSeed()).publicKey);
const alice = address();
const mallory = address();
const mock = "00000000-1337-4000-9000-000000000000";
const answered = (over: Record<string, unknown> = {}) => ({ account: alice, accountaccess: "FULL", nodetype: "MAINNET", user: randomUUID(), ...over });

function harness(opts: { ott?: (token: string) => Awaited<ReturnType<XappXaman["getOtt"]>> | Promise<never> } = {}) {
  let now = 1_800_000_000;
  const seen: string[] = [];
  const signIns: { nonce: string; account: string; network: string }[] = [];
  const store = memoryNonceStore(() => now * 1000);
  const xaman: XappXaman = {
    async getOtt(token) {
      seen.push(token);
      return opts.ott ? opts.ott(token) : { kind: "data", data: answered() };
    },
    async createSignIn(input) {
      signIns.push(input);
      return { uuid: randomUUID() };
    },
  };
  const payload: { result: unknown } = { result: { meta: { exists: true, resolved: false } } };
  const platform: XamanClient = {
    createSignIn: async () => assert.fail("the xApp never uses the QR sign-in"),
    getPayload: async () => payload.result as never,
  };
  const auth = createAuthService({ secret: SECRET, store, xaman: platform, nowS: () => now });
  const service = createXappService({ secret: SECRET, store, auth, xaman, network: "MAINNET", nowS: () => now });
  return { service, auth, seen, signIns, payload, tick: (s: number) => (now += s) };
}

test("the flag is the exact word: anything else leaves the xApp off", () => {
  assert.equal(xappEnabled({ SEAL_XAPP: "on" }), true);
  assert.equal(xappEnabled({ SEAL_XAPP: " on " }), true);
  assert.equal(xappEnabled({}), false);
  fc.assert(
    fc.property(fc.string(), (v) => {
      fc.pre(v.trim() !== "on");
      assert.equal(xappEnabled({ SEAL_XAPP: v }), false);
    }),
  );
});

test("a token that isn't a UUID v4 never reaches Xaman", async () => {
  const h = harness();
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.string(), fc.uuid().filter((u) => !/^.{14}4.{3}-[89ab]/.test(u)), fc.constant("../payload"), fc.constant(`${randomUUID()}/hash`), fc.integer(), fc.object()), async (token) => {
      fc.pre(token !== undefined && token !== null);
      assert.deepEqual(await h.service.start({ token }), { state: "invalid" });
    }),
  );
  assert.deepEqual(h.seen, []);
});

test("the SDK's mock token is refused before it can reach Xaman, in any case", async () => {
  const h = harness();
  for (const token of [mock, mock.toUpperCase()]) {
    assert.equal(ottShape(token), false);
    assert.deepEqual(await h.service.start({ token }), { state: "invalid" });
  }
  assert.deepEqual(h.seen, []);
});

test("forged or expired: Xaman refuses it, and nothing is issued or spent", async () => {
  const h = harness({ ott: () => ({ kind: "refused" }) });
  const token = randomUUID();
  assert.deepEqual(await h.service.start({ token }), { state: "invalid" });
  assert.deepEqual(h.signIns, []);
});

test("replay: Xaman answering twice (its debug replay) still gets one launch, whatever the case of the token", async () => {
  const h = harness();
  await fc.assert(
    fc.asyncProperty(fc.integer().map(() => randomUUID()), async (token) => {
      const first = await h.service.start({ token });
      assert.equal(first.state, "ready");
      for (const again of [token, token.toUpperCase()]) assert.deepEqual(await h.service.start({ token: again }), { state: "used" });
    }),
    { numRuns: 20 },
  );
});

test("replay under load: of many at once, exactly one launch goes through", async () => {
  const h = harness();
  const token = randomUUID();
  const results = await Promise.all(Array.from({ length: 25 }, () => h.service.start({ token })));
  assert.equal(results.filter((r) => r.state === "ready").length, 1);
  assert.equal(results.filter((r) => r.state === "used").length, 24);
  assert.equal(h.signIns.length, 0);
});

test("an answered token: only a full-access account on the right network gets anywhere", () => {
  assert.deepEqual(readOtt(answered(), "MAINNET"), { ok: true, account: alice });
  assert.deepEqual(readOtt(answered({ nodetype: "TESTNET" }), "MAINNET"), { ok: false, state: "wrong-network" });
  assert.deepEqual(readOtt(answered({ nodetype: "MAINNET" }), "TESTNET"), { ok: false, state: "wrong-network" });
  assert.deepEqual(readOtt(answered({ accountaccess: "READONLY" }), "MAINNET"), { ok: false, state: "read-only" });
  assert.deepEqual(readOtt(answered({ accountaccess: "Full" }), "MAINNET"), { ok: true, account: alice });
  assert.deepEqual(readOtt(answered({ account: undefined }), "MAINNET"), { ok: false, state: "no-account" });
  fc.assert(
    fc.property(fc.anything(), fc.anything(), fc.anything(), (account, accountaccess, nodetype) => {
      const r = readOtt({ account, accountaccess, nodetype }, "MAINNET");
      assert.equal(r.ok, account === alice && typeof accountaccess === "string" && accountaccess.toUpperCase() === "FULL" && nodetype === "MAINNET");
    }),
  );
  for (const bad of [null, undefined, "x", 1, []]) assert.equal(readOtt(bad, "MAINNET").ok, false);
});

test("read-only: watching someone's address in Xaman gets no sign-in request for it, even if their session cookie is here", async () => {
  const h = harness({ ott: () => ({ kind: "data", data: answered({ accountaccess: "READONLY" }) }) });
  assert.deepEqual(await h.service.start({ token: randomUUID() }), { state: "read-only" });
  assert.deepEqual(h.signIns, []);
});

test("the network follows the rails: only testnet rails ask for TESTNET", () => {
  assert.equal(xappNetwork("testnet"), "TESTNET");
  for (const m of ["mainnet", "demo", "", "Testnet"]) assert.equal(xappNetwork(m), "MAINNET");
});

test("a good token alone makes no session and no sign request: the app opens on that account", async () => {
  const h = harness();
  const r = await h.service.start({ token: randomUUID() });
  assert.ok(r.state === "ready");
  assert.equal(r.account, alice);
  assert.equal(r.session, null);
  assert.deepEqual(h.signIns, [], "nothing to sign until the player presses for it");
  assert.equal(h.auth.readSession(r.marker), null);
  assert.equal(h.service.account(r.marker), alice);
});

test("confirming, which only a press does, asks that account for a SignIn on that network", async () => {
  const h = harness();
  const launch = await h.service.start({ token: randomUUID() });
  assert.ok(launch.state === "ready");
  const r = await h.service.start({ marker: launch.marker });
  assert.ok(r.state === "sign");
  assert.equal(h.signIns[0].account, alice);
  assert.equal(h.signIns[0].network, "MAINNET");
  assert.equal(h.auth.readSession(r.challenge), null);
});

test("a held session for this very account stands; one for any other account does not", async () => {
  const h = harness();
  const session = (a: string) => signToken({ k: "session", a, w: "xaman", exp: 1_900_000_000 }, SECRET);
  const same = await h.service.start({ token: randomUUID(), session: session(alice) });
  assert.ok(same.state === "ready");
  assert.equal(same.session?.address, alice);
  assert.equal((await h.service.start({ marker: same.marker, session: session(alice) })).state, "signed");
  assert.equal(h.signIns.length, 0);
  const other = await h.service.start({ token: randomUUID(), session: session(mallory) });
  assert.ok(other.state === "ready");
  assert.equal(other.session, null);
  assert.equal(other.account, alice);
});

test("loading the same page again spends nothing new and grants nothing new", async () => {
  const h = harness();
  const token = randomUUID();
  const first = await h.service.start({ token });
  assert.ok(first.state === "ready");
  assert.equal(h.seen.length, 1);
  const again = await h.service.start({ token, marker: first.marker });
  assert.equal(again.state, "ready");
  assert.equal(h.seen.length, 1, "no second call to Xaman");
  // Another browser, with no cookie, is a plain replay.
  assert.deepEqual(await h.service.start({ token }), { state: "used" });
});

test("the launch cookie only works as itself: forged, expired, or another kind of token is nothing", async () => {
  const h = harness();
  const launch = await h.service.start({ token: randomUUID() });
  assert.ok(launch.state === "ready");
  const good = await h.service.start({ marker: launch.marker });
  assert.ok(good.state === "sign");
  assert.equal(h.service.account(signToken({ k: "xapp", a: alice, h: "x", exp: 1_900_000_000 }, "another-secret")), null);
  assert.equal(h.service.account(signToken({ k: "session", a: alice, w: "xaman", exp: 1_900_000_000 }, SECRET)), null);
  assert.equal(h.service.account(signToken({ k: "xapp", a: "rNotAnAddress", h: "x", exp: 1_900_000_000 }, SECRET)), null);
  assert.equal(h.service.account(good.challenge), null);
  fc.assert(fc.property(fc.string(), (raw) => assert.equal(h.service.account(raw), null)));
  h.tick(XAPP_TTL_S + 1);
  assert.equal(h.service.account(launch.marker), null);
  assert.deepEqual(await h.service.start({ marker: launch.marker }), { state: "invalid" });
  assert.deepEqual(await h.service.status(good.challenge, launch.marker), { state: "expired" });
});

test("asking again needs a confirmed launch: no cookie, no request", async () => {
  const h = harness();
  assert.deepEqual(await h.service.start({}), { state: "invalid" });
  assert.deepEqual(h.signIns, []);
});

test("Xaman down: fails closed, tells the two apart, and the token isn't marked spent", async () => {
  let up = false;
  const h = harness({ ott: () => (up ? { kind: "data", data: answered() } : Promise.reject(new Error("timeout"))) });
  const token = randomUUID();
  assert.deepEqual(await h.service.start({ token }), { state: "unavailable" });
  up = true;
  assert.equal((await h.service.start({ token })).state, "ready");
});

test("a store that fails spends nothing and signs no one in", async () => {
  const store = { consume: async () => Promise.reject(new Error("db down")) };
  const platform: XamanClient = { createSignIn: async () => assert.fail(), getPayload: async () => assert.fail() };
  const xaman: XappXaman = { getOtt: async () => ({ kind: "data", data: answered() }), createSignIn: async () => assert.fail() };
  const auth = createAuthService({ secret: SECRET, store, xaman: platform });
  assert.deepEqual(await createXappService({ secret: SECRET, store, auth, xaman, network: "MAINNET" }).start({ token: randomUUID() }), { state: "unavailable" });
});

test("no Xaman credentials: nothing is confirmed", async () => {
  const store = memoryNonceStore();
  const auth = createAuthService({ secret: SECRET, store, xaman: null });
  assert.deepEqual(await createXappService({ secret: SECRET, store, auth, xaman: null, network: "MAINNET" }).start({ token: randomUUID() }), { state: "unavailable" });
});

test("Xaman's API client: key and secret go in headers, only to the OTT path, and 4xx or an error body is a refusal", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const respond = (status: number, body: unknown) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const token = randomUUID();
  const data = answered();
  assert.deepEqual(await createXappClient("KEY", "SECRET", respond(200, data)).getOtt(token), { kind: "data", data });
  assert.equal(calls[0].url, `https://xumm.app/api/v1/platform/xapp/ott/${token}`);
  assert.equal(calls[0].headers["x-api-key"], "KEY");
  assert.equal(calls[0].headers["x-api-secret"], "SECRET");
  for (const status of [400, 401, 403, 404, 410]) assert.deepEqual(await createXappClient("K", "S", respond(status, {})).getOtt(token), { kind: "refused" });
  assert.deepEqual(await createXappClient("K", "S", respond(200, { error: { reference: "x", code: 812 } })).getOtt(token), { kind: "refused" });
  for (const status of [429, 500, 503]) await assert.rejects(createXappClient("K", "S", respond(status, {})).getOtt(token));
});

test("the xApp's SignIn request: bound to the one signer and network, never submitted, no return URL", async () => {
  let sent: Record<string, any> = {};
  const client = createXappClient("K", "S", (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ uuid: "u-1" }));
  }) as unknown as typeof fetch);
  assert.deepEqual(await client.createSignIn({ nonce: "n", account: alice, network: "TESTNET" }), { uuid: "u-1" });
  assert.deepEqual(sent.txjson, { TransactionType: "SignIn" });
  assert.deepEqual(sent.options, { submit: false, expire: 5, signers: [alice], force_network: "TESTNET" });
  assert.equal(sent.custom_meta.identifier, "n");
  assert.match(sent.custom_meta.instruction, /moves no funds/);
});

test("signing: outside the xApp the request is exactly today's; inside it only loses the return URL", async () => {
  const bodies: Record<string, any>[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ uuid: "u", next: { always: "https://a" }, refs: { qr_png: "https://b", websocket_status: "wss://c" } }));
  }) as unknown as typeof fetch;
  const base = { apiKey: "K", apiSecret: "S", txjson: { TransactionType: "Payment", Account: alice }, instruction: "i", network: "MAINNET" as const, identifier: "id", fetchImpl };
  await requestSignature({ ...base, returnUrl: "https://site/open/x" });
  await requestSignature({ ...base, returnUrl: null });
  assert.deepEqual(bodies[0].options, { submit: true, expire: 5, force_network: "MAINNET", signers: [alice], return_url: { app: "https://site/open/x", web: "https://site/open/x" } });
  assert.deepEqual(bodies[1].options, { submit: true, expire: 5, force_network: "MAINNET", signers: [alice] });
  assert.deepEqual(bodies[1].txjson, bodies[0].txjson);
});

test("a payload event only counts for the request we opened, and only with Xaman's exact reasons", () => {
  assert.equal(outcomeOf({ uuid: "a", reason: "SIGNED" }, "a"), "signed");
  assert.equal(outcomeOf({ uuid: "a", reason: "DECLINED" }, "a"), "declined");
  fc.assert(
    fc.property(fc.anything(), fc.anything(), (uuid, reason) => {
      const got = outcomeOf({ uuid, reason }, "a");
      if (uuid !== "a" || (reason !== "SIGNED" && reason !== "DECLINED")) assert.equal(got, null);
    }),
  );
  for (const junk of [null, undefined, 1, "SIGNED"]) assert.equal(outcomeOf(junk, "a"), null);
});

test("links: only those leaving this site go to the phone's browser", () => {
  const o = "https://seal.test";
  assert.equal(externalUrl("https://livenet.xrpl.org/transactions/AB", o), "https://livenet.xrpl.org/transactions/AB");
  for (const stay of ["/packs", "packs", "https://seal.test/fair", "#x", "", null, undefined, "javascript:alert(1)", "mailto:a@b.c", "xumm://x", "http://["]) assert.equal(externalUrl(stay, o), null, String(stay));
  fc.assert(fc.property(fc.webPath(), (p) => assert.equal(externalUrl(p.startsWith("//") ? `/x${p}` : p || "/", o), null)));
});

test("no tap leaves the webview: off-site links, new windows and email go through Xaman, and plain in-app links stay", () => {
  const origin = "https://breaktheseal.rip";
  assert.equal(xappLink("https://xrpl.to", null, origin), "https://xrpl.to/");
  assert.equal(xappLink("/api/rip/log", "_blank", origin), "https://breaktheseal.rip/api/rip/log");
  assert.equal(xappLink("mailto:gm@bearish.af", "_blank", origin), "mailto:gm@bearish.af");
  for (const inside of ["/packs", "/terms#refunds", "#who", "/collection/rip_1"]) assert.equal(xappLink(inside, null, origin), null);
  for (const nothing of [null, undefined, "", "javascript:alert(1)"]) assert.equal(xappLink(nothing, "_blank", origin), null);
  fc.assert(
    fc.property(fc.webUrl({ validSchemes: ["https"] }), fc.constantFrom(null, "_blank"), (url, target) => {
      const out = xappLink(url, target, origin);
      if (new URL(url).origin === origin) assert.equal(out !== null, target === "_blank");
      else assert.equal(out, new URL(url).href);
    }),
  );
});

test("the shell's one fact about Xaman's user agent is what the head script checks, and it matches nothing else", () => {
  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /__html: XAPP_HEAD_SCRIPT/);
  assert.match(XAPP_HEAD_SCRIPT, /indexOf\("xumm\/xapp"\)<0\)return;/);
  const css = readFileSync(new URL("../src/app/xapp.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // The site is untouched: every rule either needs the attribute or styles the shell's own classes.
  for (const rule of css.match(/[^{}]+(?=\{)/g) ?? []) for (const sel of rule.split(",")) assert.match(sel.trim(), /^(html\[data-xapp\]|\.x[a-z])/, sel);
});

test("support's website-only words are marked as such, and read the same to anyone not inside Xaman", () => {
  assert.deepEqual(inlineParts("Open it. {{Connect again.}}"), [{ kind: "text", text: "Open it. " }, { kind: "web", text: "Connect again." }]);
  assert.equal(plainText("Open it. {{Connect again.}}"), "Open it. Connect again.");
  const inXapp = SUPPORT.sections.flatMap((s) => s.blocks).flatMap((b) => (typeof b === "string" ? [b] : "items" in b ? b.items : [b.note])).flatMap((t) => inlineParts(t)).filter((p) => p.kind !== "web").map((p) => p.text).join(" ");
  assert.doesNotMatch(inXapp, /\bconnect\b/i);
});

test("rip again stays in the app: a plain checkout link, whose payment opens in Xaman like any other", () => {
  assert.equal(externalUrl(ripAgainHref(5), "https://seal.test"), null);
});

test("refusal copy tells the player what to do, in the app's words", () => {
  assert.match(refusalText("wrong-network", "MAINNET"), /Mainnet/);
  assert.match(refusalText("wrong-network", "TESTNET"), /Testnet/);
  for (const s of ["wrong-network", "read-only", "no-account", "wrong-account", "unavailable", "invalid", "used", undefined]) assert.doesNotMatch(refusalText(s), /\b(RTP|house edge|colour|licence|QR)\b/i);
});

test("tokens: the launch cookie has its own kind, so it can't be read as a session or a challenge", () => {
  const raw = signToken({ k: "xapp", a: alice, h: "h", exp: 1_900_000_000 }, SECRET);
  assert.equal(readToken(raw, SECRET, ["session"], 1), null);
  assert.equal(readToken(raw, SECRET, ["xaman", "joey"], 1), null);
  assert.equal(readToken(raw, SECRET, ["xapp"], 1)?.a, alice);
});

test("the launch token comes from the address, or from Xaman's user agent", () => {
  const ott = "11111111-2222-4333-8444-555555555555";
  assert.equal(launchToken(`?xAppToken=${ott}`, "anything"), ott);
  assert.equal(launchToken("", `Mozilla/5.0 xumm/xapp:5.4.0.123 (ott:${ott})`), ott);
  assert.equal(launchToken("", `xumm/xapp:5.4.0 foo ott:${ott}`), ott);
  assert.equal(launchToken("", "Mozilla/5.0 Safari"), "");
  assert.equal(launchToken("", `Mozilla/5.0 (ott:${ott})`), "", "only Xaman's own user agent counts");
});

test("only Xaman's own webview counts as Xaman: any other React Native browser, like Joey's, gets the plain site", () => {
  const ua = "xumm/xapp:5.4.0.123 (ott:11111111-2222-4333-8444-555555555555)";
  assert.equal(isXamanHost({ postMessage() {} }, ua), true);
  assert.equal(isXamanHost(undefined, ua), false, "the user agent alone is anyone's to type");
  fc.assert(
    fc.property(fc.string(), (other) => {
      fc.pre(!/xumm\/xapp/i.test(other));
      assert.equal(isXamanHost({ postMessage() {} }, other), false);
    }),
  );
  assert.equal(inXamanWebview(), false);
  assert.equal(xappSdk(), null);
});

/** Xaman's onMessage, from its source: a message under 1500ms after the last accepted one is dropped with no error. Times are floored to the second. */
function xamanHost(clock: { now: number }) {
  let last = 0;
  const got: string[] = [];
  const message = (name: string) => {
    if (last && clock.now - last * 1000 < 1500) return true;
    last = Math.floor(clock.now / 1000);
    got.push(name);
    return true;
  };
  const sdk = { ready: () => message("ready"), close: () => message("close"), openBrowser: () => message("browser"), openSignRequest: ({ uuid }: { uuid: string }) => message(uuid), on() {}, off() {} };
  return { sdk, got };
}

test("the boot order that loses the sign-in without pacing: ready, ready again, then the request, all at once", async () => {
  const clock = { now: 1_800_000_000_250 };
  const raw = xamanHost(clock);
  raw.sdk.ready();
  clock.now += 900;
  raw.sdk.ready();
  raw.sdk.openSignRequest({ uuid: "u" });
  assert.deepEqual(raw.got, ["ready"], "Xaman's own rule drops the request");

  const host = xamanHost(clock);
  const paced = pacedHost(host.sdk as never, () => clock.now, async (ms) => void (clock.now += ms));
  await paced.ready();
  clock.now += 900;
  await Promise.all([paced.ready(), paced.openSignRequest({ uuid: "u" })]);
  assert.deepEqual(host.got, ["ready", "u"]);
});

test("paced: whatever the page sends and whenever, every command reaches Xaman, in order, and ready only once", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.integer({ min: 0, max: 4000 }), fc.constantFrom("ready", "close", "browser", "sign")), { maxLength: 12 }), fc.integer({ min: 0, max: 999 }), async (steps, start) => {
      const clock = { now: 1_800_000_000_000 + start };
      const host = xamanHost(clock);
      const paced = pacedHost(host.sdk as never, () => clock.now, async (ms) => void (clock.now += ms));
      const want: string[] = [];
      const running: Promise<unknown>[] = [];
      let readied = false;
      for (const [gap, kind] of steps) {
        clock.now += gap;
        if (kind === "ready") {
          if (!readied) want.push("ready");
          readied = true;
          running.push(Promise.resolve(paced.ready()));
        } else if (kind === "close") {
          want.push("close");
          running.push(Promise.resolve(paced.close()));
        } else if (kind === "browser") {
          want.push("browser");
          running.push(Promise.resolve(paced.openBrowser({ url: "https://x.test" })));
        } else {
          want.push("sign");
          running.push(Promise.resolve(paced.openSignRequest({ uuid: "sign" })));
        }
        // The next tap comes after the page has had its turn.
        await new Promise((r) => setImmediate(r));
      }
      await Promise.all(running);
      assert.deepEqual(host.got, want);
    }),
    { numRuns: 200 },
  );
});

test("paced: a command that fails doesn't stop the next one, and the page hears about it", async () => {
  const clock = { now: 1_800_000_000_000 };
  let calls = 0;
  const sdk = { ready() {}, close() {}, openBrowser() {}, on() {}, off() {}, openSignRequest: () => (++calls === 1 ? Promise.reject(new Error("no host")) : true) };
  const paced = pacedHost(sdk as never, () => clock.now, async (ms) => void (clock.now += ms));
  await assert.rejects(Promise.resolve(paced.openSignRequest({ uuid: "a" })));
  assert.equal(await paced.openSignRequest({ uuid: "b" }), true);
});

test("the wallet sheet: a request that ended is never offered again; outside the xApp nothing changes", () => {
  const modes = (i: { signedWith?: string | null; inXapp: boolean; hasWallet: boolean; ended: "declined" | "expired" | null }) => sheetMode(i);
  for (const ended of ["declined", "expired"] as const) assert.equal(modes({ inXapp: true, hasWallet: true, ended }), "ended");
  assert.equal(modes({ inXapp: true, hasWallet: true, ended: null }), "xapp");
  assert.equal(modes({ inXapp: false, hasWallet: true, ended: "expired" }), "ended");
  assert.equal(modes({ inXapp: false, hasWallet: true, ended: null }), "link");
  assert.equal(modes({ inXapp: false, hasWallet: false, ended: null }), "manual");
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), fc.constantFrom("declined" as const, "expired" as const, null), (inXapp, hasWallet, ended) => {
      assert.equal(modes({ signedWith: "joey", inXapp, hasWallet, ended }), "joey");
    }),
  );
});

test("audit, property: whatever a link says, the only things handed to Xaman's browser are http, https and mailto, and a same-site link stays put", () => {
  const origin = "https://breaktheseal.rip";
  fc.assert(
    fc.property(fc.oneof(fc.webUrl(), fc.string(), fc.constantFrom("javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "file:///etc/passwd", "xumm://x", "//evil.test/a", "\\\\evil.test", "/\\evil.test", "/packs", "tel:1")), fc.constantFrom(null, undefined, "_blank", "_self"), (href, target) => {
      const out = xappLink(href, target, origin);
      if (out !== null) assert.match(out, /^(https?:|mailto:)/i);
      if (/^\s*javascript:|^data:|^file:|^xumm:|^tel:/i.test(href)) assert.equal(out, null);
      if (href === "/packs" && target !== "_blank") assert.equal(out, null);
      if (href.startsWith("//evil.test")) assert.equal(out, "https://evil.test/a");
    }),
  );
});
