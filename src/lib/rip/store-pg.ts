import type { EventStore, OnceStore, PrivateStore } from "./store.ts";
import type { RipEvent } from "./types.ts";

/** Any Postgres client with a parameterized query: a `pg` pool in production (pg-pool.ts), PGlite in tests. */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] } | readonly Record<string, unknown>[]>;
}

const rowsOf = (r: Awaited<ReturnType<SqlClient["query"]>>) => (Array.isArray(r) ? r : (r as { rows: readonly Record<string, unknown>[] }).rows);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS seal_rip_events (
  seq BIGINT PRIMARY KEY,
  body JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS seal_rip_once (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS seal_rip_private (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

/**
 * Append-only log on Postgres. The primary key on seq does the work: inserting a batch from head + 1 fails as a whole if
 * another server got there first, with no lock held across a network call and no session state on a pooled connection.
 */
export function pgStore(sql: SqlClient): EventStore & { ensureSchema(): Promise<void> } {
  return {
    async ensureSchema() {
      for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await sql.query(stmt);
    },
    async readFrom(after) {
      const rows = rowsOf(await sql.query("SELECT body FROM seal_rip_events WHERE seq > $1 ORDER BY seq", [after]));
      return rows.map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as RipEvent);
    },
    async append(expected, events) {
      if (!events.length) return true;
      if (events[0].seq !== expected + 1) throw new Error("events don't start at the head");
      const head = rowsOf(await sql.query("SELECT COALESCE(MAX(seq), 0) AS head FROM seal_rip_events"))[0];
      if (Number(head.head) !== expected) return false;
      // One statement, so it is one transaction on any driver. A duplicate seq fails the whole batch.
      const values = events.map((_, i) => `($${i * 2 + 1}::bigint, $${i * 2 + 2}::jsonb)`).join(",");
      const params = events.flatMap((e) => [e.seq, JSON.stringify(e)]);
      try {
        await sql.query(`INSERT INTO seal_rip_events (seq, body) VALUES ${values}`, params);
        return true;
      } catch (e) {
        if (String((e as { code?: unknown }).code) === "23505" || /duplicate key/i.test(String(e))) return false;
        throw e;
      }
    },
  };
}

/** Replay protection for sign-ins. A unique insert is atomic, which the runtime cache it replaces could not be. */
export function pgOnce(sql: SqlClient): OnceStore {
  return {
    async consume(id, ttl) {
      await sql.query("DELETE FROM seal_rip_once WHERE expires_at < now()");
      const rows = rowsOf(await sql.query("INSERT INTO seal_rip_once (id, expires_at) VALUES ($1, now() + ($2::int * interval '1 second')) ON CONFLICT (id) DO NOTHING RETURNING id", [id, ttl]));
      return rows.length === 1;
    },
  };
}

export function pgPrivate(sql: SqlClient): PrivateStore {
  return {
    async put(id, value) {
      await sql.query("INSERT INTO seal_rip_private (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = $2", [id, value]);
    },
    async get(id) {
      const rows = rowsOf(await sql.query("SELECT value FROM seal_rip_private WHERE id = $1", [id]));
      return rows.length ? String(rows[0].value) : null;
    },
  };
}
