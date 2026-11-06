"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SecHead } from "./ui.tsx";

/** Similar packs, side by side. The arrows only show when there's more to see than fits. */
export function SimCarousel({ label, children }: { label: string; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ back: false, next: false });
  const look = useCallback(() => {
    const t = track.current;
    if (t) setEdge({ back: t.scrollLeft > 4, next: t.scrollLeft + t.clientWidth < t.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    look();
    window.addEventListener("resize", look);
    return () => window.removeEventListener("resize", look);
  }, [look]);
  const move = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <>
      <SecHead
        title={label}
        right={
          edge.back || edge.next ? (
            <span className="simnav">
              <button type="button" onClick={() => move(-1)} disabled={!edge.back} aria-label="Previous packs">
                ←
              </button>
              <button type="button" onClick={() => move(1)} disabled={!edge.next} aria-label="More packs">
                →
              </button>
            </span>
          ) : undefined
        }
      />
      <div className="sim" ref={track} onScroll={look} tabIndex={0} aria-label={label}>
        {children}
      </div>
    </>
  );
}
