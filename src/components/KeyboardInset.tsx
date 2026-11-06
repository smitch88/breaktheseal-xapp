"use client";

import { useEffect } from "react";

/** Keeps every input above the mobile keyboard: publishes the keyboard's height as --kb and centers the focused field. */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      if (!vv) return;
      root.style.setProperty("--kb", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.matches?.("input:not([type=checkbox]),select,textarea")) setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
    };
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    document.addEventListener("focusin", onFocus);
    update();
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
  return null;
}
