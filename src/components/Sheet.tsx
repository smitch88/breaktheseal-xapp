"use client";

import { useEffect, useRef } from "react";
import { useBackClose, useTopSheet } from "@/lib/sheet-stack";

/**
 * Half-sheet on phones, centered panel from 760 px up (see .sheet in globals.css). The sheet rises with the mobile
 * keyboard through --kb, set by KeyboardInset. With another sheet open over it, Esc and Back belong to that one.
 */
export function Sheet({ children, onClose, top, label, className, backCloses }: { children: React.ReactNode | ((close: () => void) => React.ReactNode); onClose: () => void; top?: boolean; label: string; className?: string; backCloses?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const isTop = useTopSheet();
  const leave = useBackClose(!!backCloses, onClose, isTop);
  const close = useRef(leave);
  close.current = leave;
  const topNow = useRef(isTop);
  topNow.current = isTop;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && topNow.current()) close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);
  return (
    <div>
      <div className="dim" style={top ? { zIndex: 90 } : undefined} onClick={leave} />
      <div ref={ref} tabIndex={-1} className={className ? `sheet ${className}` : "sheet"} style={top ? { zIndex: 91 } : undefined} role="dialog" aria-modal="true" aria-label={label}>
        {backCloses ? (
          <button className="sheetx" aria-label="Close" onClick={leave}>
            ×
          </button>
        ) : null}
        {/* A sheet that closes itself from inside passes a function, and gets the close that keeps Back's history even. */}
        {typeof children === "function" ? children(leave) : children}
      </div>
    </div>
  );
}
