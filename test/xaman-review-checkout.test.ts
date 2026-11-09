/**
 * Xaman's second review (2026-11-09): checkout said "Waiting for your payment" before the player had pressed anything, as if a sign
 * request were already open. Now a payment's sheet reads "Ready to pay" with "Continue to payment" until Xaman has really opened the
 * request, and only then "Waiting for payment confirmation". Functional and property tests only.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { CONTINUE_TO_PAYMENT, READY_TO_PAY, WAITING_CONFIRMATION, payCopy, payStep, type PayStep } from "../src/lib/live/sign-copy.ts";
import { signInXaman } from "../src/lib/auth/xapp-host.ts";
import { readXamanSocket, socketOpened } from "../src/lib/wallet/xaman-socket.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const SIGN_IN = /\b(log ?in|log ?out|sign ?in|sign ?out|disconnect|reconnect|connect)\b/i;
const STEPS: readonly PayStep[] = ["ready", "opening", "open", "signed", "ended"];

test("checkout wording, property: nothing says waiting until Xaman has opened the request, and Ready to pay / Continue to payment until then", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (opening, opened, signed, ended) => {
      const step = payStep({ opening, opened, signed, ended });
      const copy = payCopy(step);
      const said = [copy.title, copy.action, copy.status].filter(Boolean).join(" | ");
      // The one rule Xaman asked for: "waiting" only after the request was opened (a signature means it was).
      if (/wait/i.test(said)) assert.ok((opened || signed) && !ended, `${step}: ${said}`);
      if (ended) {
        assert.equal(step, "ended");
        assert.equal(copy.title, READY_TO_PAY);
      } else if (opened || signed) {
        assert.equal(copy.title, WAITING_CONFIRMATION, step);
      } else {
        assert.equal(copy.title, READY_TO_PAY, step);
        assert.equal(copy.status, null, "no spinner line before the request is open");
        if (!opening) assert.equal(copy.action, CONTINUE_TO_PAYMENT);
      }
    }),
  );
});

test("checkout wording: every step's words, and the copy rules (US spelling, no one-word button or heading, no sign-in words)", () => {
  assert.deepEqual(
    STEPS.map((s) => [s, payCopy(s).title, payCopy(s).action, payCopy(s).status]),
    [
      ["ready", "Ready to pay", "Continue to payment", null],
      ["opening", "Ready to pay", "Opening Xaman…", null],
      ["open", "Waiting for payment confirmation", "Show the request again", "Approve the payment in Xaman"],
      ["signed", "Waiting for payment confirmation", null, "Signed. Checking the ledger"],
      ["ended", "Ready to pay", "Try again", null],
    ],
  );
  for (const s of STEPS) {
    for (const t of [payCopy(s).title, payCopy(s).action, payCopy(s).status]) {
      if (!t) continue;
      assert.ok(t.trim().split(/\s+/).length >= 2, `one word can't wrap alone: ${t}`);
      assert.doesNotMatch(t, SIGN_IN, t);
      assert.doesNotMatch(t, /\b(colour|centre|licence|favourite|organis|cancelled)/i, t);
      assert.doesNotMatch(t, /Waiting for your payment/);
    }
  }
});

/** A stand-in for Xaman's SDK: what openSignRequest answers, and the payload events it can send. */
function fakeSdk(answer: () => unknown) {
  const listeners = new Set<(e: unknown) => void>();
  const opened: string[] = [];
  return {
    sdk: {
      openSignRequest: (o: { uuid: string }) => {
        opened.push(o.uuid);
        return answer();
      },
      on: (_: "payload", fn: (e: unknown) => void) => void listeners.add(fn),
      off: (_: "payload", fn: (e: unknown) => void) => void listeners.delete(fn),
    },
    emit: (e: unknown) => [...listeners].forEach((fn) => fn(e)),
    listeners,
    opened,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("opened, property: the sheet hears 'opened' once, only after Xaman's SDK took the request, and the outcome only from that request's own event", async () => {
  const answers = ["true", "undefined", "error", "reject"] as const;
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...answers),
      fc.array(fc.record({ mine: fc.boolean(), reason: fc.constantFrom("SIGNED", "DECLINED", "CANCELLED", undefined) }), { maxLength: 6 }),
      async (answer, events) => {
        const uuid = randomUUID();
        const f = fakeSdk(() => (answer === "true" ? Promise.resolve(true) : answer === "undefined" ? undefined : answer === "error" ? Promise.resolve(new Error("could not contact Xumm App Host")) : Promise.reject(new Error("Invalid payload UUID"))));
        let openedCalls = 0;
        const said: string[] = [];
        const done = signInXaman(uuid, () => void (openedCalls++, said.push("opened")), { sdk: Promise.resolve(f.sdk) }).then(
          (o) => void said.push(o),
          () => void said.push("refused"),
        );
        await settle();
        await settle();
        assert.deepEqual(f.opened, [uuid], "one request, the player's");
        const takes = answer === "true" || answer === "undefined";
        if (!takes) {
          await done;
          assert.deepEqual(said, ["refused"], "a request Xaman never took is never 'opened'");
          assert.equal(f.listeners.size, 0);
          return;
        }
        assert.deepEqual(said, ["opened"], "opened as soon as Xaman took it, before any answer");
        for (const e of events) f.emit({ uuid: e.mine ? uuid : randomUUID(), reason: e.reason });
        const first = events.find((e) => e.mine && (e.reason === "SIGNED" || e.reason === "DECLINED"));
        if (!first) {
          assert.deepEqual(said, ["opened"], "no answer of its own yet: still waiting");
          f.emit({ uuid, reason: "DECLINED" });
        }
        await done;
        assert.equal(openedCalls, 1);
        assert.deepEqual(said, ["opened", first ? (first.reason === "SIGNED" ? "signed" : "declined") : "declined"]);
        assert.equal(f.listeners.size, 0, "stops listening once answered");
      },
    ),
    { numRuns: 200 },
  );
  // Outside Xaman there is no SDK, and nothing is opened.
  await assert.rejects(signInXaman(randomUUID(), () => assert.fail("opened"), { sdk: null }), /not in Xaman/);
});

test("opened: Xaman's socket saying the request was opened on the phone counts; anything else doesn't, and it is never an answer", () => {
  assert.equal(socketOpened('{"opened":true}'), true);
  for (const other of ['{"opened":false}', '{"message":"Welcome"}', '{"signed":true}', '{"expired":true}', '{"devapp_fetched":true}', "not json", "null", "", "true"]) assert.equal(socketOpened(other), false, other);
  assert.equal(readXamanSocket('{"opened":true}'), null, "opened says nothing about signed or declined");
});

/** Every source file under src. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

test("checkout wording: the old line is gone everywhere, and the payment sheet's waiting words come only from payCopy", () => {
  const src = new URL("../src", import.meta.url).pathname;
  for (const f of files(src)) assert.doesNotMatch(readFileSync(f, "utf8"), /Waiting for your (one )?payment/, f);
  const checkout = read("src/components/live/LiveCheckout.tsx");
  assert.match(checkout, /<WalletSheet pay title=\{READY_TO_PAY\}/, "checkout's sheet is a payment's");
  assert.doesNotMatch(checkout, /Waiting|waitrow/, "no waiting line of its own under the sheet");
  const sheet = read("src/components/live/WalletSheet.tsx");
  assert.doesNotMatch(sheet.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""), /"[^"]*Waiting[^"]*"/, "the sheet has no waiting words of its own");
  assert.match(sheet, /const step = payStep\(\{ opening, opened, signed, ended: mode === "ended" \}\);/);
  // The spinner line shows only with Xaman's request: in the xApp, or on the website's Xaman link (QR or app link).
  assert.match(sheet, /const status = pay && \(mode === "xapp" \|\| mode === "link"\) \? copy\.status : null;/);
  // Opened comes from the SDK taking the request, Xaman's socket, or the website's own tap on the app link. Nothing else.
  assert.equal(sheet.match(/setOpened\(true\)/g)?.length, 3);
  // The open pages' first step uses the same words.
  for (const f of ["src/components/live/LiveOpen.tsx", "src/components/live/MultiOpen.tsx"]) assert.match(read(f), /wait: WAITING_CONFIRMATION, yes: "Payment on the ledger"/, f);
});

test("account approval: 'Approve the request in Xaman' shows only once Xaman has taken the request", () => {
  const signIn = read("src/components/XappSignIn.tsx");
  const start = signIn.slice(signIn.indexOf("const start = useCallback"), signIn.indexOf("}, [check, finish, refresh]);"));
  assert.ok(start.length > 0);
  // The waiting view is set only inside signInXaman's opened callback.
  assert.equal(start.match(/setView\(\{ name: "waiting"/g)?.length, 1);
  assert.match(start, /signInXaman\(uuid, \(\) => \{\n\s+if \(live\.current\) setView\(\{ name: "waiting", uuid \}\);/);
});
