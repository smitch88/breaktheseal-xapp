"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CardDetails } from "./proof.ts";
import { api, nextHoldings, type LiveCard, type LiveHoldings, type LiveOrder, type LivePool, type RipConfig } from "./client.ts";
import type { PullFeed } from "../rip/recent-pulls.ts";
import type { OpenCheckouts } from "./restock.ts";
import { sharedPoll } from "./shared-poll.ts";

/** Call `fn` now and every `ms`, one at a time, until the page goes away or `stop` is true. */
export function usePoll(fn: () => Promise<void> | void, ms: number, stop = false) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (stop) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await latest.current();
      } catch {
        /* A failed look is just a look that comes around again. */
      }
      if (live) timer = setTimeout(() => void tick(), ms);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [ms, stop]);
}

const sharedConfig = sharedPoll<RipConfig>(async () => {
  const r = await api<RipConfig>("/api/rip/config");
  return r.ok ? r.body : null;
});
if (typeof document !== "undefined") document.addEventListener("visibilitychange", sharedConfig.wake);

/** The server's word on what's open, or null until it answers. It's the only source for treasury and tiers. Every caller on a page shares one read, since each read costs ledger calls. */
export function useRipConfig(enabled: boolean, ms = 15000): RipConfig | null {
  const [config, setConfig] = useState<RipConfig | null>(null);
  useEffect(() => (enabled ? sharedConfig.subscribe(setConfig, ms) : undefined), [enabled, ms]);
  return config;
}

const sharedPulls = sharedPoll<PullFeed>(async () => {
  const r = await api<PullFeed>("/api/rip/pulls");
  return r.ok ? r.body : null;
});
if (typeof document !== "undefined") document.addEventListener("visibilitychange", sharedPulls.wake);

/** The latest real pulls, or null until the first answer. Stops while the tab is hidden, and the answer comes from the CDN's copy. */
export function useRecentPulls(enabled: boolean, ms = 20_000): PullFeed | null {
  const [feed, setFeed] = useState<PullFeed | null>(null);
  useEffect(() => (enabled ? sharedPulls.subscribe(setFeed, ms) : undefined), [enabled, ms]);
  return feed;
}

/** The checkouts this wallet could still pay, asked once it matters. Null until the server answers. */
export function useOpenCheckouts(enabled: boolean): OpenCheckouts | null {
  const [open, setOpen] = useState<OpenCheckouts | null>(null);
  usePoll(
    async () => {
      const r = await api<{ open: OpenCheckouts }>("/api/rip/orders");
      if (r.ok) setOpen(r.body.open);
    },
    15000,
    !enabled || open !== null,
  );
  return open;
}

/** What's really in a pack's pool this season. `undefined` until it answers; null if no season is live. */
export function useLivePool(price: number, enabled = true, ms = 20000): LivePool | null | undefined {
  const [pool, setPool] = useState<LivePool | null | undefined>(undefined);
  usePoll(
    async () => {
      const r = await api<{ pool: LivePool | null }>(`/api/rip/pool/${price}`);
      if (r.ok) setPool(r.body.pool);
    },
    ms,
    !enabled,
  );
  return pool;
}

/** The signed-in wallet's real pulls and cards. */
export function useLiveHoldings(enabled: boolean, address: string | null): LiveHoldings & { refresh: () => void } {
  const [state, setState] = useState<LiveHoldings>({ nfts: [], cards: [], loaded: false });
  const look = useCallback(async () => {
    const [a, b] = await Promise.all([api<{ orders: LiveOrder[] }>("/api/rip/holdings"), api<{ cards: LiveCard[] }>("/api/rip/cards")]);
    setState((prev) => nextHoldings(prev, a, b));
  }, []);
  usePoll(look, 6000, !enabled || !address);
  return { ...state, refresh: () => void look() };
}

/** What Collector Crypt says a card is. Asked once a page: it doesn't change, and the server caches it. */
export function useCardDetails(id: string | null): CardDetails | null {
  const [details, setDetails] = useState<CardDetails | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void api<{ details: CardDetails | null }>(`/api/rip/cards/${encodeURIComponent(id)}/details`)
      .then((r) => {
        if (live && r.ok) setDetails(r.body.details);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  return details;
}

/** How many offers wait on this wallet. Asked on arriving at a page or coming back to the tab, never on a timer, and it costs no ledger read. */
export function usePendingCount(enabled: boolean, page: string): number {
  const [count, setCount] = useState(0);
  const look = useCallback(() => {
    void api<{ count: number }>("/api/rip/pending")
      .then((r) => setCount(r.ok ? r.body.count : 0))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    look();
    const back = () => {
      if (document.visibilityState === "visible") look();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [enabled, page, look]);
  return count;
}
