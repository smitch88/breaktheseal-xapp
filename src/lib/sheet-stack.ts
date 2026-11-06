"use client";

import { useEffect, useRef } from "react";

/** Open sheets, newest last. Esc and Back belong to the one on top. */
const stack: symbol[] = [];

export function useTopSheet(): () => boolean {
  const id = useRef(Symbol("sheet"));
  useEffect(() => {
    const me = id.current;
    stack.push(me);
    return () => {
      const at = stack.lastIndexOf(me);
      if (at >= 0) stack.splice(at, 1);
    };
  }, []);
  return () => stack.at(-1) === id.current;
}

/** With `on`, the phone's or browser's Back closes this view instead of leaving the page. Close through what this returns, so the history stays even. */
export function useBackClose(on: boolean, onClose: () => void, isTop: () => boolean): () => void {
  const close = useRef(onClose);
  close.current = onClose;
  const top = useRef(isTop);
  top.current = isTop;
  const pushed = useRef(false);
  useEffect(() => {
    if (!on) return;
    if (!pushed.current) {
      window.history.pushState(window.history.state, "");
      pushed.current = true;
    }
    const pop = () => {
      if (top.current()) close.current();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [on]);
  return on ? () => window.history.back() : () => close.current();
}
