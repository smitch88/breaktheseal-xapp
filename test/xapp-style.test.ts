import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { XAPP_HEAD_SCRIPT, XAPP_STYLES, XAPP_STYLE_KEY, xappStyle } from "../src/lib/xapp-style.ts";

const XAMAN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 xumm/xapp:3.4.0";
const anyCase = (s: string) => fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((up) => [...s].map((c, i) => (up[i] ? c.toUpperCase() : c)).join(""));

/** The head script, run against a stand-in page: its user agent, its address and its session storage. */
function runHead(input: { ua: string; search: string; stored?: Map<string, string>; storageThrows?: boolean }) {
  const dataset: Record<string, string> = {};
  const stored = input.stored ?? new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => {
      if (input.storageThrows) throw new Error("denied");
      return stored.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (input.storageThrows) throw new Error("denied");
      stored.set(k, v);
    },
  };
  new Function("navigator", "document", "location", "sessionStorage", XAPP_HEAD_SCRIPT)({ userAgent: input.ua }, { documentElement: { dataset } }, { search: input.search }, sessionStorage);
  return { dataset, stored };
}

test("style: Xaman's four palettes by name, in any case or spacing; anything else is the app's own dark", () => {
  fc.assert(
    fc.property(fc.constantFrom("LIGHT", "DARK", "MOONLIGHT", "ROYAL").chain((s) => fc.tuple(fc.constant(s), anyCase(s))), fc.constantFrom("", " ", "\t"), ([name, raw], pad) => {
      assert.equal(xappStyle(`${pad}${raw}${pad}`), name.toLowerCase());
    }),
  );
  fc.assert(
    fc.property(fc.option(fc.string(), { nil: undefined }), (raw) => {
      const s = xappStyle(raw);
      assert.ok((XAPP_STYLES as readonly string[]).includes(s));
      if (!XAPP_STYLES.some((n) => n === (raw ?? "").trim().toLowerCase())) assert.equal(s, "dark");
    }),
  );
});

test("head script: outside Xaman it changes nothing and stores nothing", () => {
  fc.assert(
    fc.property(
      fc.string().filter((ua) => !/xumm\/xapp/i.test(ua)),
      fc.constantFrom("", "?xAppStyle=LIGHT", "?xAppToken=x&xAppStyle=ROYAL"),
      (ua, search) => {
        const { dataset, stored } = runHead({ ua, search });
        assert.deepEqual(dataset, {});
        assert.equal(stored.size, 0);
      },
    ),
  );
});

test("head script: inside Xaman the launch's style is set before paint and kept for the pages after it", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constantFrom("LIGHT", "DARK", "MOONLIGHT", "ROYAL", "light"), fc.string({ minLength: 1 })), (style) => {
      const launch = runHead({ ua: XAMAN, search: `?xAppToken=t&xAppStyle=${encodeURIComponent(style)}` });
      assert.equal(launch.dataset.xapp, "1");
      assert.equal(launch.dataset.xstyle, xappStyle(style));
      // The launch page drops its query, and the next page has none: it reads the kept style.
      const next = runHead({ ua: XAMAN, search: "", stored: launch.stored });
      assert.equal(next.dataset.xstyle, xappStyle(style));
    }),
  );
});

test("head script: with storage refused, the address alone decides, and no style at all is dark", () => {
  assert.equal(runHead({ ua: XAMAN, search: "?xAppStyle=LIGHT", storageThrows: true }).dataset.xstyle, "light");
  assert.equal(runHead({ ua: XAMAN, search: "", storageThrows: true }).dataset.xstyle, "dark");
  assert.equal(runHead({ ua: XAMAN, search: "" }).dataset.xstyle, "dark");
  assert.equal(runHead({ ua: XAMAN, search: "", stored: new Map([[XAPP_STYLE_KEY, "ROYAL"]]) }).dataset.xstyle, "royal");
});

test("the root layout runs this script, and the xApp's CSS has a palette for every style but its own dark", () => {
  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /__html: XAPP_HEAD_SCRIPT/);
  const css = readFileSync(new URL("../src/app/xapp.css", import.meta.url), "utf8");
  for (const s of XAPP_STYLES.filter((s) => s !== "dark")) assert.match(css, new RegExp(`html\\[data-xapp\\]\\[data-xstyle=${s}\\]\\{`), s);
});
