import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { clearedCookie, cookieAttrs, fromXaman } from "../src/lib/auth/cookie-attrs.ts";
import config from "../next.config.mjs";

const XAMAN_AGENTS = ["xumm/xapp:5.3.0 (ott:d1944654-055c-46d6-8023-c92fdde9472b)", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 xumm/xapp", "Mozilla/5.0 (iPhone) XUMM/XAPP:5.4.1"];
const browserAgent = fc.string().filter((s) => !/xumm\/xapp/i.test(s));

type Rule = { source: string; has?: { key: string; value: string }[]; missing?: { key: string; value: string }[]; headers: { key: string; value: string }[] };

/** What a request with this user agent gets on a page, by the same has/missing rules Next applies. */
async function pageHeaders(userAgent: string) {
  const rules = (await config.headers!()) as Rule[];
  const matches = (c: { key: string; value: string }) => c.key === "user-agent" && new RegExp(`^(?:${c.value})$`).test(userAgent);
  const out = new Map<string, string>();
  for (const r of rules.filter((r) => r.source === "/:path*")) {
    if (r.has && !r.has.every(matches)) continue;
    if (r.missing && r.missing.some(matches)) continue;
    for (const h of r.headers) out.set(h.key, h.value);
  }
  return out;
}

test("framing: any browser that isn't Xaman is still refused a frame from another site", async () => {
  await fc.assert(
    fc.asyncProperty(browserAgent, async (ua) => {
      const h = await pageHeaders(ua);
      assert.equal(h.get("Content-Security-Policy"), "frame-ancestors 'self'");
      assert.equal(h.has("Access-Control-Allow-Origin"), false);
    }),
  );
});

test("framing: Xaman's webview, by either user agent it sends, can frame the app as its docs ask", async () => {
  for (const ua of XAMAN_AGENTS) {
    const h = await pageHeaders(ua);
    assert.equal(h.has("Content-Security-Policy"), false, ua);
    assert.equal(h.get("Access-Control-Allow-Origin"), "*", ua);
    assert.equal(h.get("X-Content-Type-Options"), "nosniff", ua);
  }
});

test("cookies: every other browser keeps the Lax cookies it had, and nothing partitioned", () => {
  fc.assert(
    fc.property(browserAgent, fc.boolean(), (ua, prod) => {
      assert.deepEqual(cookieAttrs(ua, prod), { httpOnly: true, secure: prod, sameSite: "lax", path: "/" });
    }),
  );
});

test("cookies: inside Xaman they are sent in the frame, always secure, and kept to that top-level site", () => {
  for (const ua of XAMAN_AGENTS) {
    for (const prod of [true, false]) {
      assert.ok(fromXaman(ua));
      assert.deepEqual(cookieAttrs(ua, prod), { httpOnly: true, secure: true, sameSite: "none", path: "/", partitioned: true });
    }
  }
});

test("cookies: a removal goes to the same jar the cookie was set in, and expires at once", () => {
  fc.assert(
    fc.property(fc.oneof(browserAgent, fc.constantFrom(...XAMAN_AGENTS)), fc.boolean(), (ua, prod) => {
      const { maxAge, ...rest } = clearedCookie(ua, prod);
      assert.equal(maxAge, 0);
      assert.deepEqual(rest, cookieAttrs(ua, prod));
    }),
  );
});
