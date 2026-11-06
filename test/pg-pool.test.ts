import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TLSSocket } from "node:tls";
import fc from "fast-check";
import { Pool } from "pg";
import { createEngine } from "../src/lib/rip/engine.ts";
import { sealEvents } from "../src/lib/rip/log.ts";
import { pgClient, pgConfig } from "../src/lib/rip/pg-pool.ts";
import { GENESIS_HASH } from "../src/lib/rip/state.ts";
import { pgOnce, pgPrivate, pgStore, type SqlClient } from "../src/lib/rip/store-pg.ts";
import { TREASURY, VAULT, testLedger, testSigner } from "./support-ledger.ts";

const REMOTE = "postgres://user:s3cret-pw@db.example.com:6432/seal";

test("a remote URL has to verify the certificate, and is split into fields so nothing in it can override that", () => {
  const c = pgConfig(`${REMOTE}?sslmode=verify-full`);
  assert.deepEqual(c.ssl, { rejectUnauthorized: true });
  assert.equal(c.connectionString, undefined, "pg would let the URL's query override the code");
  assert.deepEqual([c.host, c.port, c.user, c.password, c.database], ["db.example.com", 6432, "user", "s3cret-pw", "seal"]);
  assert.equal(pgConfig("postgresql://a%40b:p%2Fw%25@db.example.com/x?sslmode=verify-full").password, "p/w%");
  assert.equal(pgConfig("postgresql://a%40b:p%2Fw%25@db.example.com/x?sslmode=verify-full").user, "a@b");
});

test("anything weaker on a remote host is refused, and no refusal ever repeats the password", () => {
  const weakened = fc.oneof(
    fc.constant(""),
    fc.constantFrom("disable", "allow", "prefer", "require", "verify-ca", "no-verify", "VERIFY-FULL", "").map((m) => `?sslmode=${m}`),
    // pg reads the last of these and a naive check the first.
    fc.constantFrom("no-verify", "disable", "verify-full").map((m) => `?sslmode=verify-full&sslmode=${m}`),
    fc.constantFrom("ssl=0", "ssl=false", "ssl=no-verify", "sslrootcert=system", "uselibpqcompat=true", "host=evil.example", "password=x", "options=-c%20x%3D1", "statement_timeout=1", "sslnegotiation=direct").map((p) => `?sslmode=verify-full&${p}`),
  );
  const secret = fc.stringMatching(/^[A-Za-z0-9]{12,30}$/);
  fc.assert(
    fc.property(weakened, secret, fc.constantFrom("db.example.com", "10.0.0.1", "localhost.example.com"), (query, password, host) => {
      const url = `postgres://user:${password}@${host}:6432/seal${query}`;
      try {
        pgConfig(url);
      } catch (e) {
        assert.ok(!JSON.stringify({ m: String(e), ...(e as object) }).includes(password));
        return;
      }
      assert.fail(`accepted ${query}`);
    }),
  );
  for (const bad of ["postgres://user:s3cret-pw@", "not a url s3cret-pw", "mysql://user:s3cret-pw@db.example.com/x?sslmode=verify-full"]) {
    try {
      pgConfig(bad);
      assert.fail("accepted");
    } catch (e) {
      assert.ok(!JSON.stringify({ m: String(e), ...(e as object) }).includes("s3cret-pw"));
    }
  }
});

test("plain TCP is for loopback only, and the limits are small and all client-side", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(pgConfig(`postgres://u@${host}:5432/x`).ssl, false);
    assert.deepEqual(pgConfig(`postgres://u@${host}:5432/x?sslmode=verify-full`).ssl, { rejectUnauthorized: true });
  }
  assert.equal(pgConfig("postgres://u@[::1]:5432/x").host, "::1");
  assert.throws(() => pgConfig("postgres://u@127.0.0.1:5432/x?sslmode=disable"), /verify-full/);
  const c = pgConfig(`${REMOTE}?sslmode=verify-full`);
  assert.ok(c.max! > 0 && c.max! <= 5);
  assert.ok(c.idleTimeoutMillis! > 0 && c.idleTimeoutMillis! <= 10_000);
  assert.ok(c.connectionTimeoutMillis! > 0 && c.query_timeout! > 0);
  // pg sends these as startup parameters, and PgBouncer turns away a connection that has them.
  for (const k of ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "options", "application_name"]) assert.equal(k in c, false, k);
});

test("the rails and sign-in share one pool per URL", () => {
  const url = "postgres://shared@127.0.0.1:1/x";
  assert.equal(pgClient(url), pgClient(url));
  assert.notEqual(pgClient(url), pgClient("postgres://other@127.0.0.1:1/x"));
});

/** Just enough of a Postgres server to see what the real driver sends, and to misbehave. */
type Fake = { port: number; startups: Record<string, string>[]; sent: Buffer[]; sockets: Socket[]; sslRequests: number; close: () => Promise<void> };
async function fakePg(behave: { ssl?: "S" | "N"; hang?: "connect" | "ssl" | "query"; cert?: { key: string; cert: string } } = {}): Promise<Fake> {
  const fake: Fake = { port: 0, startups: [], sent: [], sockets: [], sslRequests: 0, close: async () => {} };
  const message = (type: string, body: Buffer = Buffer.alloc(0)) => {
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4);
    return Buffer.concat([Buffer.from(type), len, body]);
  };
  const ready = message("Z", Buffer.from("I"));
  const done = message("C", Buffer.from("SELECT 0\0"));
  const speak = (s: Socket) => {
    let started = false;
    s.on("error", () => {});
    s.on("data", (d: Buffer) => {
      if (!started && d.length >= 8 && d.readInt32BE(4) === 80877103) {
        fake.sslRequests++;
        if (behave.hang === "ssl") {
          s.removeAllListeners("data");
          s.write("S");
          return;
        }
        s.write(behave.ssl ?? "N");
        if (behave.ssl === "S" && behave.cert) {
          s.removeAllListeners("data");
          const secure = new TLSSocket(s, { isServer: true, key: behave.cert.key, cert: behave.cert.cert });
          fake.sockets.push(secure);
          speak(secure);
        }
        return;
      }
      if (!started) {
        started = true;
        const parts = d.subarray(8).toString().split("\0").filter(Boolean);
        fake.startups.push(Object.fromEntries(parts.flatMap((_, i) => (i % 2 ? [] : [[parts[i], parts[i + 1]]]))));
        const ok = Buffer.alloc(4);
        s.write(Buffer.concat([message("R", ok), ready]));
        return;
      }
      fake.sent.push(d);
      if (behave.hang === "query") return;
      if (d[0] === 0x51) s.write(Buffer.concat([done, ready]));
      else s.write(Buffer.concat([message("1"), message("2"), message("n"), done, ready]));
    });
  };
  const server: Server = createServer((s) => {
    // A failing test skips the close, and open handles would hang the run instead of reporting it.
    s.unref();
    fake.sockets.push(s);
    if (behave.hang !== "connect") speak(s);
    else s.on("error", () => {});
  });
  server.unref();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.port = (server.address() as { port: number }).port;
  fake.close = async () => {
    fake.sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  };
  return fake;
}

const smallPool = (fake: Fake, extra: object = {}, query = "") => {
  const pool = new Pool({ ...pgConfig(`postgres://u:p@127.0.0.1:${fake.port}/x${query}`), connectionTimeoutMillis: 200, query_timeout: 200, ...extra });
  pool.on("error", () => {});
  const sql: SqlClient = { query: (t, p) => pool.query(t, p ? [...p] : []) as never };
  return { pool, sql };
};
const stop = async (pool: Pool, fake: Fake) => {
  await fake.close();
  await pool.end();
};

test("on the wire: no session settings at startup and no named statements, which is what transaction pooling needs", async () => {
  const fake = await fakePg();
  const { pool, sql } = smallPool(fake);
  await pgStore(sql).append(0, sealEvents(0, GENESIS_HASH, [{ type: "scan_cursor", data: { account: "r", ledger: 1 } }], new Date().toISOString())).catch(() => {});
  await sql.query("SELECT value FROM seal_rip_private WHERE id = $1", ["k"]);
  await sql.query("SELECT value FROM seal_rip_private WHERE id = $1", ["k"]);
  assert.deepEqual(Object.keys(fake.startups[0]).sort(), ["client_encoding", "database", "user"]);
  const parses = fake.sent.filter((d) => d[0] === 0x50);
  assert.ok(parses.length >= 2);
  for (const d of parses) assert.equal(d[5], 0, "the statement's name is empty");
  await stop(pool, fake);
});

test("a server that never answers fails the connection, at every stage, in bounded time", async () => {
  for (const hang of ["connect", "ssl"] as const) {
    const fake = await fakePg({ hang });
    const { pool, sql } = smallPool(fake, {}, hang === "ssl" ? "?sslmode=verify-full" : "");
    const started = Date.now();
    await assert.rejects(sql.query("SELECT 1"), hang);
    assert.ok(Date.now() - started < 2000, hang);
    await stop(pool, fake);
  }
});

test("a query that never comes back is an error everywhere that matters: never a lost race, an accepted id or a missing row", async () => {
  const fake = await fakePg({ hang: "query" });
  const { pool, sql } = smallPool(fake);
  const store = pgStore(sql);
  const events = sealEvents(0, GENESIS_HASH, [{ type: "scan_cursor", data: { account: "r", ledger: 1 } }], new Date().toISOString());
  await assert.rejects(store.append(0, events), /timeout/i);
  await assert.rejects(store.readFrom(0), /timeout/i);
  await assert.rejects(pgOnce(sql).consume("id", 60), /timeout/i);
  await assert.rejects(pgPrivate(sql).get("id"), /timeout/i);
  await assert.rejects(pgPrivate(sql).put("id", "v"), /timeout/i);
  // And the engine moves no money on it.
  const ledger = testLedger("pg-hang");
  ledger.fund(TREASURY, 100);
  ledger.fund(VAULT, 100);
  const engine = createEngine({ store, chain: ledger.chain, signer: testSigner(), drawSecret: "s", expectedNetworkId: 1 });
  await assert.rejects(engine.advance());
  await assert.rejects(engine.openSeason(5, "4000000"));
  assert.equal(ledger.history.filter((t) => t.tx.Account === TREASURY || t.tx.Account === VAULT).length, 0);
  await stop(pool, fake);
});

test("a full pool waits a bounded time, then fails", async () => {
  const fake = await fakePg({ hang: "query" });
  const { pool, sql } = smallPool(fake, { max: 1, query_timeout: 5000 });
  const held = sql.query("SELECT 1");
  held.catch(() => {});
  await assert.rejects(sql.query("SELECT 2"), /timeout/i);
  await stop(pool, fake);
  await held.catch(() => {});
});

test("the pooler dropping an idle connection doesn't crash the process, and the next query reconnects", async () => {
  const fake = await fakePg();
  const sql = pgClient(`postgres://idle@127.0.0.1:${fake.port}/x`);
  await sql.query("SELECT 1");
  const logged = console.error;
  const lines: string[] = [];
  console.error = (l: string) => void lines.push(l);
  fake.sockets.forEach((s) => s.destroy());
  await new Promise((r) => setTimeout(r, 50));
  console.error = logged;
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("idle@"));
  await sql.query("SELECT 2");
  assert.equal(fake.startups.length, 2);
  await fake.close();
  await new Promise((r) => setTimeout(r, 50));
});

test("a server that won't do TLS is refused before a username goes out", async () => {
  const fake = await fakePg({ ssl: "N" });
  const { pool, sql } = smallPool(fake, {}, "?sslmode=verify-full");
  await assert.rejects(sql.query("SELECT 1"), /does not support SSL/);
  assert.equal(fake.sslRequests, 1);
  assert.equal(fake.startups.length, 0);
  await stop(pool, fake);
});

function selfSigned(dir: string, name: string, san: string) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=${san}`, "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`)], { stdio: "ignore" });
  return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.crt`), "utf8") };
}
let openssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  openssl = false;
}

test("verify-full means it: only a trusted certificate for this host gets a username", { skip: openssl ? false : "no openssl" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "seal-pg-tls-"));
  const right = selfSigned(dir, "right", "IP:127.0.0.1");
  const wrong = selfSigned(dir, "wrong", "DNS:other.example.com");
  const sane = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    // An untrusted certificate, with the override that would turn off a default rejectUnauthorized.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    let fake = await fakePg({ ssl: "S", cert: right });
    let p = smallPool(fake, {}, "?sslmode=verify-full");
    await assert.rejects(p.sql.query("SELECT 1"), /self.signed/i);
    assert.equal(fake.startups.length, 0);
    await stop(p.pool, fake);
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    // A trusted certificate for some other host.
    fake = await fakePg({ ssl: "S", cert: wrong });
    p = smallPool(fake, { ssl: { rejectUnauthorized: true, ca: wrong.cert } }, "?sslmode=verify-full");
    await assert.rejects(p.sql.query("SELECT 1"), /altnames|does not match|not in the cert/i);
    assert.equal(fake.startups.length, 0);
    await stop(p.pool, fake);

    // The right one connects.
    fake = await fakePg({ ssl: "S", cert: right });
    p = smallPool(fake, { ssl: { rejectUnauthorized: true, ca: right.cert } }, "?sslmode=verify-full");
    await p.sql.query("SELECT 1");
    assert.equal(fake.startups.length, 1);
    await stop(p.pool, fake);
  } finally {
    if (sane === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = sane;
    rmSync(dir, { recursive: true });
  }
});
