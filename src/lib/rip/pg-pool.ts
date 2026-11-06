import { attachDatabasePool } from "@vercel/functions";
import { Pool, type PoolConfig } from "pg";
import type { SqlClient } from "./store-pg.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Pool settings from DATABASE_URL, split into explicit fields because `pg` lets anything in the URL's query override what
 * it's given in code: `ssl=0`, a second sslmode, even `host=`. So a remote URL carries sslmode=verify-full and nothing
 * else, or it's refused. Plain TCP is for loopback only.
 *
 * Port 6432 is PgBouncer in transaction mode, which refuses unknown startup parameters and can't hold session state.
 * `pg` sends statement_timeout and lock_timeout as startup parameters, so the only limits here are client-side.
 */
export function pgConfig(url: string): PoolConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Not the original error: it carries the whole URL, password included.
    throw new Error("DATABASE_URL isn't a valid URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("DATABASE_URL isn't a Postgres URL");
  const extra = [...u.searchParams.keys()].filter((k) => k !== "sslmode");
  if (extra.length) throw new Error(`DATABASE_URL has settings this app refuses: ${extra.join(", ")}`);
  const modes = u.searchParams.getAll("sslmode");
  const verified = modes.length === 1 && modes[0] === "verify-full";
  if (!verified && !(LOOPBACK.has(u.hostname) && !modes.length)) throw new Error("DATABASE_URL must use sslmode=verify-full");
  return {
    host: u.hostname.replace(/^\[(.+)\]$/, "$1"),
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    // Explicit, so neither PGSSLMODE nor NODE_TLS_REJECT_UNAUTHORIZED can weaken it. `pg` names the host for SNI and Node checks it.
    ssl: verified ? { rejectUnauthorized: true } : false,
    // Every instance holds this many, so a burst of instances can't use up the pooler. A request past it waits, then fails.
    max: 3,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    allowExitOnIdle: true,
  };
}

const shared = globalThis as typeof globalThis & { __sealPgClients?: Map<string, SqlClient> };
const clients = (shared.__sealPgClients ??= new Map<string, SqlClient>());

/**
 * One pool per URL per instance: the rails and sign-in each build their own stores, and Next can load this module once per
 * route. A timeout or a lost connection rejects, as any store error does, and nothing here retries: a write that timed out
 * may still have landed, so the engine has to read the log again and decide.
 */
export function pgClient(url: string): SqlClient {
  const found = clients.get(url);
  if (found) return found;
  const pool = new Pool(pgConfig(url));
  // Without a listener, the pooler dropping an idle connection would take the whole instance down.
  pool.on("error", (e) => console.error(`database: idle connection lost: ${e.message}`));
  // Keeps the instance alive long enough to close idle connections instead of freezing with them open. Does nothing off Vercel.
  attachDatabasePool(pool);
  const client: SqlClient = { query: (text, params) => pool.query(text, params ? [...params] : []) };
  clients.set(url, client);
  return client;
}
