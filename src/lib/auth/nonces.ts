/** Spends one-time ids. `consume` is true the first time an id is seen and false after that. */
export interface NonceStore {
  consume(id: string, ttlSeconds: number): Promise<boolean>;
}

export function memoryNonceStore(nowMs: () => number = Date.now): NonceStore {
  const spent = new Map<string, number>();
  return {
    async consume(id, ttlSeconds) {
      const now = nowMs();
      for (const [k, until] of spent) if (until <= now) spent.delete(k);
      if (spent.has(id)) return false;
      spent.set(id, now + ttlSeconds * 1000);
      return true;
    },
  };
}
