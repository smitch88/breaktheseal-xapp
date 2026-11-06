import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { refusalText } from "../src/lib/auth/xapp-host.ts";
import { OPERATOR } from "../src/lib/legal/links.ts";
import { aboutFine, aboutLine, independence } from "../src/lib/xapp-copy.ts";

/** Xaman's review list, as the first screen inside Xaman has to meet it. */
const SIGN_IN = /\b(log ?in|log ?out|sign ?in|sign ?out|disconnect|reconnect|connect)\b/i;
const CARD_SOURCE = /collector\s*crypt|\bCC\b/i;
const BRITISH = /\b(colour|centre|licence|favourite|organis|realis)/i;

test("first screen: says what a pack holds and what you can do with it, cards and SEAL only when they're on", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (seal, cards) => {
      const line = aboutLine({ seal, cards });
      assert.match(line, /^Pay in XRP from your Xaman account\. Each pack holds one random prize: /);
      assert.equal(/graded trading card/.test(line), cards, line);
      assert.equal(/\bship\b/.test(line), cards, line);
      assert.equal(/\bSEAL\b/.test(line), seal, line);
      assert.match(line, /Stash it, sell it back, .*claim it to your wallet\.$/);
      assert.match(line, /an XRPL NFT/);
      for (const bad of [SIGN_IN, CARD_SOURCE, BRITISH, /partner/i, /\s{2}|\s[,.]|,,/]) assert.doesNotMatch(line, bad, line);
    }),
  );
});

test("first screen: who runs it, that Xaman doesn't, who holds the cards, and the risk, never a partner or the card source's name", () => {
  fc.assert(
    fc.property(fc.boolean(), (cards) => {
      const fine = aboutFine({ cards, operator: OPERATOR });
      assert.ok(fine.startsWith(independence(OPERATOR)));
      assert.equal(independence(OPERATOR), `Break the Seal is developed by ${OPERATOR}. It isn't affiliated with or endorsed by XRPL Labs or Xaman.`);
      assert.equal(/third-party graded card vault/.test(fine), cards);
      assert.match(fine, /can be worth less than you paid\.$/);
      for (const bad of [SIGN_IN, CARD_SOURCE, BRITISH, /partner/i]) assert.doesNotMatch(fine, bad);
    }),
  );
});


test("an ended session says how to get back, in plain words, and never asks to sign in or connect", () => {
  for (const s of ["wrong-network", "read-only", "no-account", "wrong-account", "unavailable", "invalid", "used", undefined]) {
    const text = refusalText(s);
    assert.doesNotMatch(text, SIGN_IN, text);
    assert.doesNotMatch(text, /\blaunch\b/i, text);
  }
  assert.match(refusalText(undefined), /open it again from Xaman/);
});
