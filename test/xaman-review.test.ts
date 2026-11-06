/**
 * Xaman's xApp review list (docs.xaman.dev, xApp publishing and review), item by item where code can show it: signing only what a
 * player may be asked for, every wallet sheet saying what it is and what it costs, a launch that lands anywhere going to /xapp, and no
 * timer reading Xaman's request status. Functional and property tests only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import fc from "fast-check";
import { NETWORK_FEE, OWNER_RESERVE, SHIP_INTRO, acceptIntro, payIntro, trustIntro } from "../src/lib/live/sign-copy.ts";
import { PLAYER_TX_TYPES, playerTxRefusal } from "../src/lib/rip/player-tx.ts";
import { SEAL_ISSUER, trustSetTx } from "../src/lib/rip/tokens.ts";
import { requestPlayerSignature } from "../src/lib/rip/xaman.ts";
import config from "../next.config.mjs";

const PLAYER = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const TREASURY = "rLixKPQ3jGk4yYhAt3ybAwdrC8tvTLLvG";
const memo = { Memo: { MemoType: "7365616C2D726970732F7061636B", MemoData: "61" } };
const SIGN_IN = /\b(log ?in|log ?out|sign ?in|sign ?out|disconnect|reconnect|connect)\b/i;
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** Every shape the app asks a player to sign today, as the engine, the token code and the claim routes build them. */
const ASKED = [
  { TransactionType: "Payment", Account: PLAYER, Destination: TREASURY, Amount: "4000000", InvoiceID: "AB".repeat(32), LastLedgerSequence: 99, Memos: [memo] },
  { TransactionType: "NFTokenAcceptOffer", Account: PLAYER, NFTokenSellOffer: "CD".repeat(32) },
  trustSetTx(PLAYER, { currency: "5345414C00000000000000000000000000000000", issuer: SEAL_ISSUER } as never, 1_000_000n),
  { TransactionType: "AccountSet", Account: PLAYER, LastLedgerSequence: 99, Memos: [memo] },
];

test("signing: every transaction the app asks a player for is on the list, and none of them changes who controls an account", () => {
  for (const tx of ASKED) assert.equal(playerTxRefusal(tx), null, String(tx.TransactionType));
  assert.deepEqual([...PLAYER_TX_TYPES].sort(), ["AccountSet", "NFTokenAcceptOffer", "Payment", "TrustSet"]);
  // The code builds nothing else for a player: the only places that hand a transaction to the wallet sheet name these four.
  assert.match(read("src/app/api/rip/orders/[id]/claim/route.ts"), /TransactionType: "NFTokenAcceptOffer"/);
  assert.match(read("src/app/api/rip/cards/[id]/claim/route.ts"), /TransactionType: "NFTokenAcceptOffer"/);
});

test("signing, property: SetRegularKey, SignerListSet, AccountDelete or any other type is refused, whatever it carries", () => {
  for (const type of ["SetRegularKey", "SignerListSet", "AccountDelete", "DelegateSet", "DepositPreauth", "EscrowCreate", "OfferCreate", "Clawback", "NFTokenCreateOffer", "NFTokenBurn", "SignIn"]) {
    assert.notEqual(playerTxRefusal({ TransactionType: type, Account: PLAYER }), null, type);
  }
  fc.assert(
    fc.property(fc.string(), fc.dictionary(fc.string(), fc.jsonValue()), (type, rest) => {
      fc.pre(!(PLAYER_TX_TYPES as readonly string[]).includes(type));
      assert.notEqual(playerTxRefusal({ ...rest, TransactionType: type }), null);
    }),
  );
});

test("signing, property: an allowed type that would hand over the account, or an AccountSet that changes any setting, is refused", () => {
  fc.assert(
    fc.property(fc.constantFrom(...PLAYER_TX_TYPES), fc.constantFrom("RegularKey", "SignerEntries", "SignerQuorum", "NFTokenMinter", "Delegate"), fc.jsonValue(), (type, field, value) => {
      assert.notEqual(playerTxRefusal({ TransactionType: type, Account: PLAYER, [field]: value }), null);
    }),
  );
  for (const field of ["SetFlag", "ClearFlag", "Domain", "EmailHash", "MessageKey", "TransferRate", "TickSize", "WalletLocator"]) {
    assert.notEqual(playerTxRefusal({ TransactionType: "AccountSet", Account: PLAYER, Memos: [memo], [field]: 1 }), null, field);
  }
  // The trust line leaves rippling off and sets nothing else: no freeze, no authorizing.
  for (const flags of [0x00010000, 0x00040000, 0x00100000, 0x00020000 | 0x00100000]) assert.notEqual(playerTxRefusal({ TransactionType: "TrustSet", Account: PLAYER, Flags: flags }), null, String(flags));
});

test("signing: a refused transaction never reaches Xaman", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}");
  }) as unknown as typeof fetch;
  for (const txjson of [{ TransactionType: "SetRegularKey", Account: PLAYER, RegularKey: TREASURY }, { TransactionType: "SignerListSet", Account: PLAYER, SignerQuorum: 1, SignerEntries: [] }, { TransactionType: "AccountSet", Account: PLAYER, SetFlag: 4 }]) {
    await assert.rejects(requestPlayerSignature({ apiKey: "k", apiSecret: "s", txjson, instruction: "i", returnUrl: null, network: "TESTNET", identifier: "id", fetchImpl }));
  }
  assert.equal(calls, 0);
  // Every player request goes through this one door.
  const server = read("src/lib/rip/server.ts");
  assert.doesNotMatch(server, /requestSignature\(/);
  assert.equal(server.match(/requestPlayerSignature\(/g)?.length, 2);
});

test("explained first, property: every wallet sheet says what it is and every cost, in plain words, before its request can open", () => {
  fc.assert(
    fc.property(fc.option(fc.integer({ min: 1, max: 100_000 }).map(String), { nil: null }), fc.string({ minLength: 1, maxLength: 40 }).filter((n) => n.trim() === n && !SIGN_IN.test(n)), fc.integer({ min: 1, max: 20 }), fc.boolean(), (xrp, name, qty, testnet) => {
      const text = payIntro({ xrp, name, qty, testnet });
      if (xrp !== null) assert.ok(text.startsWith(`${xrp} XRP to Break the Seal for `), text);
      assert.ok(text.includes(qty > 1 ? `${qty} x ${name}, in one payment. You sign once.` : `one ${name}.`), text);
      assert.match(text, /No service fee/);
      assert.equal(/Testnet/.test(text), testnet);
    }),
  );
  const all = [payIntro({ xrp: "4", name: "$5 Copper pack", qty: 1, testnet: false }), trustIntro(SEAL_ISSUER), acceptIntro(false), acceptIntro(true), SHIP_INTRO];
  for (const text of all) {
    assert.ok(text.includes(`network fee, ${NETWORK_FEE}`) || text.includes(`network fee is ${NETWORK_FEE}`), text);
    assert.doesNotMatch(text, SIGN_IN, text);
    assert.doesNotMatch(text, /\b(colour|centre|licence|favourite|organis)/i, text);
  }
  assert.ok(trustIntro(SEAL_ISSUER).includes(SEAL_ISSUER), "the issuer to check");
  assert.match(trustIntro(SEAL_ISSUER), /Check the issuer/);
  for (const text of [trustIntro(SEAL_ISSUER), acceptIntro(false)]) assert.ok(text.includes(`${OWNER_RESERVE} in reserve`), text);
  // The sheets use exactly these words, and nothing opens a request but the Approve button under them.
  for (const [file, used] of [["src/components/live/LiveCheckout.tsx", "payIntro("], ["src/components/live/PrizeActions.tsx", "trustIntro("], ["src/components/live/AcceptOffer.tsx", "acceptIntro("], ["src/components/live/LiveItem.tsx", "intro={SHIP_INTRO}"]] as const) assert.ok(read(file).includes(used), file);
});

test("on a tap only: no request opens on load, from an effect, or by skipping checkout", () => {
  const sheet = read("src/components/live/WalletSheet.tsx");
  assert.equal(sheet.match(/openInXaman/g)?.length, 2, "defined once, and pressed once: <button onClick={openInXaman}>");
  assert.match(sheet, /onClick=\{openInXaman\}/);
  for (const file of ["src/lib/again.ts", "src/components/PackBuy.tsx", "src/components/live/LiveCheckout.tsx", "src/components/CheckoutFlow.tsx", "src/app/(site)/checkout/page.tsx"]) assert.doesNotMatch(read(file), /quickStart|go=1|\bgo\b: ?goRaw/, file);
  const boot = read("src/components/XappBoot.tsx");
  assert.doesNotMatch(boot, /openSignRequest|signInXaman|createSignIn/, "the launch asks for nothing");
});

test("no polling: Xaman's request status is read on its socket's word or a tap, never on a timer", () => {
  for (const file of ["src/components/ConnectSheet.tsx", "src/components/live/WalletSheet.tsx", "src/components/XappSignIn.tsx"]) assert.doesNotMatch(read(file), /setInterval|usePoll/, file);
  // The only reads of a Xaman request: a press that makes one, and the wallet-request route the sheet calls on a signal.
  const callers = ["src/lib/rip/server.ts", "src/app/api/rip/wallet-request/route.ts"];
  for (const file of callers) assert.match(read(file), /readRequest\(/, file);
});

/** Next's own matcher for a redirect source (the same compiled path-to-regexp it ships), strict as Next sets it. */
const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { pathToRegexp: (p: string, k?: unknown[], o?: Record<string, unknown>) => RegExp };

test("a launch that lands on any page goes to /xapp with its query, and /xapp, the API and Next's files are left alone", async () => {
  const rules = (await config.redirects!()) as { source: string; has?: { type: string; key: string }[]; destination: string; permanent: boolean }[];
  assert.ok(rules.length > 0);
  for (const r of rules) {
    assert.deepEqual(r.has, [{ type: "query", key: "xAppToken" }]);
    assert.equal(r.destination, "/xapp");
    assert.equal(r.permanent, false);
  }
  const redirected = (path: string) => rules.some((r) => pathToRegexp(r.source, [], { strict: true, sensitive: false, delimiter: "/" }).test(path));
  for (const path of ["/", "/packs", "/nft/5", "/collection", "/collection/rip_abc", "/support", "/xapp/extra", "/xappx"]) assert.equal(redirected(path), true, path);
  for (const path of ["/xapp", "/api/auth/xapp", "/api/rip/config", "/_next/static/chunks/a.js"]) assert.equal(redirected(path), false, path);
});

test("clearly independent: the terms, support, the first screen and every xApp page's footer say who makes it and that XRPL Labs and Xaman don't", async () => {
  const { PRIVACY, SUPPORT, TERMS } = await import("../src/lib/legal/content.ts");
  const { OPERATOR } = await import("../src/lib/legal/links.ts");
  const { independence } = await import("../src/lib/xapp-copy.ts");
  const { XAPP_TTL_S } = await import("../src/lib/auth/xapp.ts");
  const line = independence(OPERATOR);
  assert.match(line, /isn't affiliated with or endorsed by XRPL Labs or Xaman/);
  assert.ok(TERMS.intro.includes(line));
  assert.ok(SUPPORT.intro.some((p) => p.startsWith(line)));
  const shell = read("src/components/XappShell.tsx");
  assert.match(shell, /independence\(OPERATOR\)/);
  // Third parties are named, the card vault by what it does (the partner terms bar its name).
  const terms = JSON.stringify(TERMS);
  for (const named of ["Relay (relay.link)", "xrpl.to", "Xaman", "Solana", "third-party graded card vault"]) assert.ok(terms.includes(named), named);
  assert.doesNotMatch(terms, /collector\s*crypt/i);
  // What the xApp keeps, as the code keeps it.
  assert.ok(JSON.stringify(PRIVACY).includes(`lasts at most ${XAPP_TTL_S / 3600} hours`));
});

// ---- ready(), the chooser, and the first-launch info sheet ----

import { INFO_LINKS, NAV_HOME, READY_FALLBACK_MS, connectView, navBack, navScreen, navVisit, openOutside, readyGate, xappLink } from "../src/lib/auth/xapp-host.ts";
import { createXappClient } from "../src/lib/auth/xapp-client.ts";
import { INFO_KEY, createUserstore } from "../src/lib/auth/xapp-userstore.ts";
import { createXappService } from "../src/lib/auth/xapp.ts";
import { createAuthService } from "../src/lib/auth/service.ts";
import { memoryNonceStore } from "../src/lib/auth/nonces.ts";
import { infoNeeded } from "../src/lib/xapp-copy.ts";

/** A clock and timers the test moves by hand. */
function fakeTimers() {
  let now = 0;
  const due: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      due.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = due.findIndex((d) => d.id === id);
      if (i >= 0) due.splice(i, 1);
    },
    /** Moves the clock, firing each timer at its own moment on the way. */
    advance(ms: number) {
      const target = now + ms;
      for (let d = due.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0]; d; d = due.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0]) {
        due.splice(due.indexOf(d), 1);
        now = Math.max(now, d.at);
        d.fn();
      }
      now = target;
    },
    now: () => now,
  };
}

test("ready(), property: called exactly once, when the launch is known or at the fallback, whichever is first, and the page shows then too", () => {
  assert.ok(READY_FALLBACK_MS < 6000, "under Xaman's slow-to-respond mark");
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 9000 }), { maxLength: 5 }), fc.boolean(), (settleAt, cancelFirst) => {
      const t = fakeTimers();
      const readyAt: number[] = [];
      const shownAt: number[] = [];
      const gate = readyGate({ ready: () => readyAt.push(t.now()), reveal: () => shownAt.push(t.now()), setTimer: t.setTimer, clearTimer: t.clearTimer });
      const times = [...settleAt].sort((a, b) => a - b);
      let at = 0;
      for (const s of times) {
        t.advance(s - at);
        at = s;
        gate.settle();
      }
      t.advance(10_000);
      const expected = Math.min(times[0] ?? Infinity, READY_FALLBACK_MS);
      assert.deepEqual(readyAt, [expected]);
      assert.deepEqual(shownAt, [expected]);
      assert.equal(gate.settled, true);
      if (cancelFirst) {
        // A page that goes away before anything: nothing at all.
        const t2 = fakeTimers();
        const calls: number[] = [];
        const g2 = readyGate({ ready: () => calls.push(1), reveal: () => calls.push(2), setTimer: t2.setTimer, clearTimer: t2.clearTimer });
        g2.cancel();
        g2.settle();
        t2.advance(10_000);
        assert.deepEqual(calls, []);
      }
    }),
  );
});

test("ready(): the host calls it only through the gate, and the launch page settles it only once its screen is drawn", () => {
  const host = read("src/components/XappHost.tsx");
  assert.equal(host.match(/sdk\.ready\(\)/g)?.length, 1, "one call, inside readyGate's ready");
  assert.match(host, /readyGate\(\{ ready: \(\) => xappSdk\(\)\?\.then\(\(sdk\) => sdk\.ready\(\)\)/);
  const boot = read("src/components/XappBoot.tsx");
  assert.match(boot, /if \(view\.name !== "opening"\) settle\(\);/);
  assert.match(boot, /if \(view\.name === "opening"\) return <main className="pg xboot" aria-busy="true" \/>;/, "nothing of ours while the launch is open");
  assert.doesNotMatch(boot, /spin|Opening your account/);
});

test("the chooser, property: inside the xApp a press that needs a wallet never shows the website's Xaman-or-Joey chooser", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (open, xapp) => {
      const v = connectView({ open, xapp });
      if (!open) assert.equal(v, "none");
      if (xapp) assert.notEqual(v, "chooser");
      if (open && !xapp) assert.equal(v, "chooser");
    }),
  );
  assert.match(read("src/components/Providers.tsx"), /connectView\(\{ open, xapp: shell \|\| \(open && pageIsXapp\(\)\) \}\)/);
});

/** Xaman's userdata API, in memory: one store per player, picked by the JWT the way Xaman picks it. */
function xamanUserdata(opts: { failReads?: boolean; failWrites?: boolean } = {}) {
  const stores = new Map<string, Record<string, unknown>>();
  const calls: { method: string; url: string; auth: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    calls.push({ method: String(init.method), url: String(url), auth });
    const player = auth.replace(/^Bearer /, "");
    const store = stores.get(player) ?? {};
    stores.set(player, store);
    if (init.method === "GET") {
      if (opts.failReads) throw new Error("network");
      return new Response(JSON.stringify({ data: { [INFO_KEY]: store[INFO_KEY] } }));
    }
    if (opts.failWrites) return new Response("{}", { status: 503 });
    store[INFO_KEY] = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ persisted: true }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, stores };
}

test("info sheet: once per player, kept in Xaman's userstore, and only Got it marks it", async () => {
  const x = xamanUserdata();
  const store = createUserstore(x.fetchImpl);
  assert.equal(infoNeeded({ show: !(await store.infoSeen("jwt-alice")) }), true, "first launch shows it");
  assert.equal(await store.markInfoSeen("jwt-alice"), true);
  assert.equal(infoNeeded({ show: !(await store.infoSeen("jwt-alice")) }), false, "Alice's next launch doesn't");
  assert.equal(await store.infoSeen("jwt-bob"), false, "Bob hasn't seen it");
  for (const c of x.calls) {
    assert.equal(c.url, `https://xumm.app/api/v1/jwt/userdata/${INFO_KEY}`);
    assert.match(c.auth, /^Bearer jwt-/);
  }
  assert.match(INFO_KEY, /^[a-z0-9]{3,}$/, "Xaman's rule for userstore keys");
});

test("info sheet, property: if the userstore can't be read, or there's no JWT, it shows again rather than being skipped", async () => {
  assert.equal(await createUserstore(xamanUserdata({ failReads: true }).fetchImpl).infoSeen("jwt-alice"), false);
  assert.equal(await createUserstore(xamanUserdata().fetchImpl).infoSeen(null), false);
  assert.equal(await createUserstore(xamanUserdata({ failWrites: true }).fetchImpl).markInfoSeen("jwt-alice"), false);
  const answers = fc.oneof(fc.jsonValue(), fc.constant(new Response("not json")), fc.constantFrom(301, 400, 401, 403, 404, 429, 500, 503).map((status) => new Response("{}", { status })));
  await fc.assert(
    fc.asyncProperty(answers, async (answer) => {
      const fetchImpl = (async () => (answer instanceof Response ? answer.clone() : new Response(JSON.stringify(answer)))) as unknown as typeof fetch;
      const seen = await createUserstore(fetchImpl).infoSeen("jwt");
      const clear = !(answer instanceof Response) && (answer as { data?: Record<string, { seen?: unknown }> } | null)?.data?.[INFO_KEY]?.seen === true;
      assert.equal(seen, clear);
    }),
  );
  // What the page does with the server's answer: anything but a clear "seen" shows it.
  fc.assert(fc.property(fc.jsonValue(), (a) => assert.equal(infoNeeded(a), !(a !== null && typeof a === "object" && !Array.isArray(a) && (a as { show?: unknown }).show === false))));
});

test("in place: Support, Privacy and Terms are this site's own pages and open inside the xApp, from the info sheet, the landing, the footer and Help", () => {
  const origin = "https://breaktheseal.rip";
  assert.deepEqual(INFO_LINKS.map((l) => [l.path, l.label]), [["/support", "Support"], ["/privacy", "Privacy Policy"], ["/terms", "Terms"]]);
  // A tap on any of them is left to the webview, so it stays in the xApp: the host hands nothing to openBrowser.
  for (const path of ["/support", "/privacy", "/terms", "/terms#refunds", "/privacy#browser", "/how", "/rates", "/fair", "/xapp", "/packs"]) {
    for (const target of [null, undefined, "_self"]) assert.equal(xappLink(path, target, origin), null, `${path} ${target}`);
    assert.equal(xappLink(`${origin}${path}`, null, origin), null, `${origin}${path}`);
  }
  // The info sheet navigates in place, and the landing, footer and Help tab use plain links to the same pages.
  const shell = read("src/components/XappShell.tsx");
  const sheet = shell.slice(shell.indexOf("export function XappInfoSheet"));
  assert.match(sheet, /onClick=\{\(\) => router\.push\(l\.path\)\}/);
  assert.doesNotMatch(sheet, /openOutside|openBrowser|target=/);
  for (const file of ["src/components/XappBoot.tsx", "src/components/XappShell.tsx"]) assert.match(read(file), /LEGAL_LINKS\.map\(\(l\) => \(\s*<Link key=\{l\.href\} href=\{l\.href\}>/, file);
  assert.match(shell, /\{ href: "\/terms", label: "Terms" \},\s*\{ href: "\/privacy", label: "Privacy" \}/, "Help lists them");
});

test("off our site: Discord, X, xrpl.to and any other https site still go through Xaman's openBrowser, and email still goes to the mail app", async () => {
  const origin = "https://breaktheseal.rip";
  const asked: string[] = [];
  const sdk = Promise.resolve({ openBrowser: ({ url }: { url: string }) => void asked.push(url) });
  const outside = ["https://discord.gg/bearish", "https://x.com/bearish_af", "https://xrpl.to", "https://livenet.xrpl.org/accounts/rLixKPQ3jGk4yYhAt3ybAwdrC8tvTLLvG", "http://example.com/a"];
  for (const href of outside) {
    const url = xappLink(href, "_blank", origin);
    assert.ok(url?.startsWith("https://"), href);
    assert.equal(await openOutside(url!, { sdk, fallback: () => assert.fail("no tab while Xaman answers") }), "xaman");
  }
  assert.deepEqual(asked, ["https://discord.gg/bearish", "https://x.com/bearish_af", "https://xrpl.to/", "https://livenet.xrpl.org/accounts/rLixKPQ3jGk4yYhAt3ybAwdrC8tvTLLvG", "https://example.com/a"]);
  fc.assert(
    fc.property(fc.webUrl({ validSchemes: ["https"] }), fc.constantFrom(null, "_blank"), (href, target) => {
      fc.pre(new URL(href).origin !== origin);
      assert.equal(xappLink(href, target, origin), new URL(href).href);
    }),
  );
  assert.equal(xappLink("mailto:gm@bearish.af", null, origin), null);
});

test("Back, property: it returns to the screen the player came from, never leaves this site, and with nothing before goes to the packs", () => {
  // The landing, then the info sheet's Terms, then Back: the landing again. Packs, Help, Privacy, Back, Back: Help, then the packs.
  let s: string[] = [];
  for (const p of ["/xapp", "/terms"]) s = navVisit(s, p);
  assert.equal(navBack(s, "/terms"), "/xapp");
  s = navVisit(s, navBack(s, "/terms"));
  assert.deepEqual(s, ["/xapp"]);
  for (const p of ["/packs", "/support", "/privacy"]) s = navVisit(s, p);
  assert.equal(navBack(s, "/privacy"), "/support");
  s = navVisit(s, "/support");
  assert.equal(navBack(s, "/support"), "/packs");
  assert.equal(navBack([], "/terms"), NAV_HOME);
  // A launch's token and style are never part of a screen.
  assert.equal(navScreen("/xapp", "?xAppToken=3f0c2a8e-5b1d-4c7a-9e2f-1a2b3c4d5e6f&xAppStyle=DARK"), "/xapp");
  assert.equal(navScreen("/nft/5", "?again=1&xAppStyle=LIGHT"), "/nft/5?again=1");
  const screen = fc.oneof(fc.constantFrom("/xapp", "/packs", "/collection", "/support", "/terms", "/privacy", "/nft/5", "/packs/a?again=1"), fc.webPath().map((p) => `/${p.replace(/^\/+/, "")}`));
  const junk = fc.oneof(fc.webUrl(), fc.constantFrom("//evil.test/a", "https://evil.test", "javascript:alert(1)", "/\\evil.test"), fc.anything());
  fc.assert(
    fc.property(fc.array(fc.oneof(screen, junk), { maxLength: 40 }), screen, (visits, last) => {
      let list: string[] = [];
      for (const v of visits) list = navVisit(list, v as string);
      const before = list.at(-1);
      list = navVisit(list, last);
      const to = navBack(list, last);
      assert.ok(to.startsWith("/") && !to.startsWith("//") && !to.includes("\\"), to);
      // Only the packs, which shows no Back, can be its own way back.
      if (to === last) assert.equal(to, NAV_HOME);
      // Back from a new screen is the screen before it, whenever there was one and it wasn't this same screen or a step back.
      if (before && before !== last && list.at(-1) === last && list.length >= 2) assert.equal(to, list.at(-2));
    }),
  );
});

test("Back: the shell's Back uses the app's own list, never the browser's history, on every page but the two tab roots", () => {
  const shell = read("src/components/XappShell.tsx");
  assert.match(shell, /<button type="button" className="xback" onClick=\{back\}>/);
  assert.match(shell, /const ROOTS: readonly string\[\] = \["\/packs", "\/collection"\];/);
  const host = read("src/components/XappHost.tsx");
  assert.doesNotMatch(host + shell, /router\.back\(\)|history\.back\(\)|history\.go\(/);
  assert.match(host, /navBack\(readNav\(\), here\(\)\)/);
});

test("launch: resolved where Xaman issues the player's JWT, which rides only in the signed launch cookie; the platform endpoint stays the fallback", async () => {
  const token = "11111111-2222-4333-8444-555555555555";
  const account = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
  const ott = { account, accountaccess: "FULL", nodetype: "MAINNET", user: "u" };
  const viaJwt = (async (url: string) => (String(url).endsWith("/jwt/authorize") ? new Response(JSON.stringify({ ott, app: { name: "Break the Seal" }, jwt: "eyJ.player.jwt" })) : assert.fail("no second call"))) as unknown as typeof fetch;
  assert.deepEqual(await createXappClient("K", "S", viaJwt).getOtt(token), { kind: "data", data: ott, jwt: "eyJ.player.jwt" });
  // Through the service: the account is read from the same data as ever, and the JWT is only for the userstore.
  const SECRET = "test-secret-not-a-real-one";
  const store = memoryNonceStore();
  const auth = createAuthService({ secret: SECRET, store, xaman: null });
  const service = createXappService({ secret: SECRET, store, auth, network: "MAINNET", xaman: { getOtt: async () => ({ kind: "data", data: ott, jwt: "eyJ.player.jwt" }), createSignIn: async () => assert.fail() } });
  const started = await service.start({ token });
  assert.equal(started.state, "ready");
  const marker = (started as { marker?: string }).marker!;
  assert.equal(service.account(marker), account);
  assert.equal(service.userstoreJwt(marker), "eyJ.player.jwt");
  // Without a JWT (the platform fallback), the launch is just as good and the sheet simply shows.
  const plain = createXappService({ secret: SECRET, store: memoryNonceStore(), auth, network: "MAINNET", xaman: { getOtt: async () => ({ kind: "data", data: ott, jwt: null }), createSignIn: async () => assert.fail() } });
  const m2 = ((await plain.start({ token })) as { marker?: string }).marker!;
  assert.equal(plain.account(m2), account);
  assert.equal(plain.userstoreJwt(m2), null);
});
