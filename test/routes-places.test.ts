import assert from "node:assert/strict";
import { test } from "node:test";
import { TERMS_VERSION } from "../src/lib/legal/content.ts";
import { addressOf, world } from "./support-routes.ts";

const PLAYER = addressOf(1);

async function ready(opts?: Parameters<typeof world>[0]) {
  const w = await world(opts);
  const me = w.client(PLAYER);
  w.fund(me);
  await w.open(5, "4000000");
  return { w, me };
}
const orders = (w: Awaited<ReturnType<typeof world>>) => w.engine.state.orders.size;

test("a restricted place is refused before any order, nothing held, nothing recorded, and it says so plainly", async () => {
  const { w, me } = await ready();
  const refused: Record<string, string>[] = [{ "x-vercel-ip-country": "IR" }, { "x-vercel-ip-country": "kp" }, { "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "43" }];
  for (const h of refused) {
    const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 }, headers: h });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "place_restricted");
    assert.match(r.body.error, /Nothing was charged/);
  }
  assert.equal(orders(w), 0);
  assert.deepEqual(w.secretWrites, []);
  assert.equal(w.xaman.calls.length, 0, "no wallet request");
});

test("the rest of Ukraine, an undecided country and a missing location all pass", async () => {
  const passed: Record<string, string>[] = [{ "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "30" }, { "x-vercel-ip-country": "KR" }, {}];
  for (const h of passed) {
    const { w, me } = await ready();
    assert.equal((await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 }, headers: h })).status, 200, JSON.stringify(h));
  }
});

test("the same refusal covers the card route", async () => {
  const { w, me } = await ready({ cards: true } as never);
  const r = await w.call("POST", "/api/rip/cards", { as: me, body: { code: "pokemon_25" }, headers: { "x-vercel-ip-country": "CU" } });
  assert.equal(r.body.code, "place_restricted");
});

test("no ticked box, no order: anything but true is refused", async () => {
  const { w, me } = await ready();
  for (const acceptedTerms of [false, "true", 1, null]) {
    const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5, acceptedTerms } });
    assert.equal(r.body.code, "terms_required", String(acceptedTerms));
  }
  assert.equal((await w.call("POST", "/api/rip/orders", { as: me, raw: JSON.stringify({ price: 5 }) })).body.code, "terms_required");
  assert.equal(orders(w), 0);
});

test("an order keeps which terms it was opened under, when and from which wallet, privately and off the public log", async () => {
  const { w, me } = await ready();
  const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  assert.equal(r.status, 200);
  const stored = JSON.parse((await w.secrets.get(`terms:order:${r.body.order.id}`)) as string);
  assert.equal(stored.version, TERMS_VERSION);
  assert.equal(stored.address, PLAYER);
  assert.ok(Math.abs(Date.now() - Date.parse(stored.at)) < 60_000);
  const log = await w.call("GET", "/api/rip/log");
  assert.ok(!JSON.stringify(log.body).includes(TERMS_VERSION), "the public log doesn't carry it");
});

test("if the record can't be written, no payment is offered", async () => {
  const { w, me } = await ready();
  const put = w.secrets.put;
  w.secrets.put = async () => {
    throw new Error("store down");
  };
  const r = await w.call("POST", "/api/rip/orders", { as: me, body: { price: 5 } });
  w.secrets.put = put;
  assert.equal(r.status, 503);
  assert.equal(r.body.tx, undefined);
  assert.match(r.body.error, /Nothing was charged/);
});
