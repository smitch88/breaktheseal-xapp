"use client";

import { useSyncExternalStore } from "react";
import { EMPTY, reduce, revive, type DemoAction, type DemoState } from "./state.ts";

const KEY = "seal-rips-demo-v1";

let state: DemoState = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    state = revive(window.localStorage.getItem(KEY));
  } catch {
    state = EMPTY;
  }
}

export function dispatch(action: DemoAction): DemoState {
  load();
  state = reduce(state, action);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Private window or full storage: the demo keeps working for this visit. */
  }
  listeners.forEach((l) => l());
  return state;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const readDemo = (): DemoState => {
  load();
  return state;
};

/** The server and the first client render both see EMPTY. Stored state arrives right after hydration. */
export function useDemo(): DemoState {
  return useSyncExternalStore(subscribe, readDemo, () => EMPTY);
}

const noSubscribe = () => () => {};
/** False only while hydrating a fresh page load. A move between pages already has the store, so it never shows a blank frame. */
export const useHydrated = () => useSyncExternalStore(noSubscribe, () => true, () => false);
