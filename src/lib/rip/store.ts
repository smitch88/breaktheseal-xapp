import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { RipEvent } from "./types.ts";

export { canonical, sealEvents } from "./log.ts";

/**
 * The only storage the system needs: an append-only log. `append` writes everything or nothing, and only when the log's
 * head is still where the caller last read it. That one rule is what keeps two servers from doing the same work twice.
 * Real money needs the Postgres store in store-pg.ts. Memory is for tests and the file store for one local process.
 */
export interface EventStore {
  readFrom(afterSeq: number): Promise<readonly RipEvent[]>;
  /** False if the head moved. Nothing is written in that case. */
  append(expectedHead: number, events: readonly RipEvent[]): Promise<boolean>;
}

/** One-time ids (wallet sign-in challenges). Atomic: of any number of callers, exactly one gets true. */
export interface OnceStore {
  consume(id: string, ttlSeconds: number): Promise<boolean>;
}

/** Shipping addresses and anything else that must stay off the public log. */
export interface PrivateStore {
  put(id: string, value: string): Promise<void>;
  get(id: string): Promise<string | null>;
}

export function memoryPrivate(): PrivateStore {
  const m = new Map<string, string>();
  return { put: async (k, v) => void m.set(k, v), get: async (k) => m.get(k) ?? null };
}

export function filePrivate(path: string): PrivateStore {
  mkdirSync(dirname(path), { recursive: true });
  const read = (): Record<string, string> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  return {
    async put(k, v) {
      const all = read();
      all[k] = v;
      writeFileSync(path, JSON.stringify(all), { mode: 0o600 });
    },
    get: async (k) => read()[k] ?? null,
  };
}

export function memoryStore(): EventStore & { all(): RipEvent[] } {
  const log: RipEvent[] = [];
  return {
    all: () => [...log],
    async readFrom(after) {
      return log.filter((e) => e.seq > after);
    },
    async append(expected, events) {
      if ((log.at(-1)?.seq ?? 0) !== expected) return false;
      log.push(...events);
      return true;
    },
  };
}

export function memoryOnce(nowMs: () => number = Date.now): OnceStore {
  const spent = new Map<string, number>();
  return {
    async consume(id, ttl) {
      const now = nowMs();
      for (const [k, until] of spent) if (until <= now) spent.delete(k);
      if (spent.has(id)) return false;
      spent.set(id, now + ttl * 1000);
      return true;
    },
  };
}

/** One JSON line per event, for a single machine. A lock directory makes the head check and the write one step. */
export function fileStore(path: string): EventStore {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const read = (): RipEvent[] =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as RipEvent)
      : [];
  const withLock = async <T>(fn: () => T): Promise<T> => {
    for (let tries = 0; ; tries++) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        if (tries > 400) throw new Error("event log lock is stuck");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  };
  return {
    readFrom: (after) => withLock(() => read().filter((e) => e.seq > after)),
    append: (expected, events) =>
      withLock(() => {
        if ((read().at(-1)?.seq ?? 0) !== expected) return false;
        const fd = openSync(path, "a", 0o600);
        try {
          writeSync(fd, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
        } finally {
          closeSync(fd);
        }
        return true;
      }),
  };
}
