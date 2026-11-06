"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { HOME, faceOf, nudge, panBy, pinchTo, rotateBy, toFace, wheelBy, type Camera } from "@/lib/card-viewer";
import { noOrphan } from "@/lib/format";
import { DetailSheet } from "./DetailSheet.tsx";
import { NftImg } from "./NftImg.tsx";

const FACE_SIZES = "(min-width:760px) 60vw, 100vw";
/** What next/image's `fill` does, for an NFT's picture, which isn't one. */
const FILL: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%" };

/**
 * A close look at one prize's real photos: pinch, wheel or + and - to zoom, drag to turn it, or to move around once zoomed in. Collector
 * Crypt has two photos of a card and no scan or video of one, so this turns a flat two-sided card. It doesn't pretend to show its edges.
 */
export default function CardViewer({ name, front, back, square, onClose }: { name: string; front: string; back?: string | null; square?: boolean; onClose: () => void }) {
  const twoSided = !!back;
  const [cam, setCam] = useState<Camera>(HOME);
  const [moving, setMoving] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; zoom: number } | null>(null);
  const size = useCallback(() => ({ w: stage.current?.clientWidth ?? 400, h: stage.current?.clientHeight ?? 600 }), []);

  // A wheel has to be stopped from scrolling the page, which only a listener added this way can do.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setCam((c) => wheelBy(c, e.deltaY));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.focus();
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const gapOf = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setMoving(true);
    if (pointers.current.size === 2) setCam((c) => ((pinch.current = { gap: gapOf(), zoom: c.zoom }), c));
  };
  const move = (e: React.PointerEvent) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinch.current;
    if (p) setCam((c) => pinchTo(c, p.zoom, p.gap, gapOf()));
    else if (pointers.current.size === 1) setCam((c) => (c.zoom > 1 ? panBy(c, dx, dy, size()) : rotateBy(c, dx, dy, twoSided)));
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) setMoving(false);
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key.startsWith("Arrow") || ["+", "=", "-", "0", "f", "F"].includes(e.key)) {
      e.preventDefault();
      setCam((c) => nudge(c, e.key, twoSided, size()));
    }
  };
  const side = faceOf(cam.ry);
  const pose = `translate3d(${cam.px}px,${cam.py}px,0) scale(${cam.zoom}) rotateX(${cam.rx}deg) rotateY(${cam.ry}deg)`;
  return (
    <DetailSheet label={`A close look at ${name}`} onClose={onClose} className="viewer" top>
      <div ref={stage} className={moving ? "cvstage moving" : "cvstage"} tabIndex={0} role="img" aria-label={`${name}, ${side}. Arrow keys turn it, plus and minus zoom.`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} onDoubleClick={() => setCam((c) => (c.zoom > 1 ? HOME : { ...c, zoom: 2.5 }))}>
        <div className={square ? "cvcard square" : "cvcard"} style={{ transform: pose }}>
          <div className="cvface">
            {square ? <NftImg src={front} alt="" sizes={FACE_SIZES} draggable={false} priority style={FILL} /> : <Image src={front} alt="" fill sizes={FACE_SIZES} draggable={false} priority />}
          </div>
          {back ? (
            <div className="cvface cvback">
              <Image src={back} alt="" fill sizes={FACE_SIZES} draggable={false} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="cvbar">
        {twoSided ? (
          <>
            <button aria-pressed={side === "front"} onClick={() => setCam((c) => toFace(c, "front"))}>
              Front
            </button>
            <button aria-pressed={side === "back"} onClick={() => setCam((c) => toFace(c, "back"))}>
              Back
            </button>
          </>
        ) : null}
        <button aria-label="Zoom out" disabled={cam.zoom <= 1} onClick={() => setCam((c) => nudge(c, "-", twoSided, size()))}>
          −
        </button>
        <button aria-label="Zoom in" disabled={cam.zoom >= 5} onClick={() => setCam((c) => nudge(c, "+", twoSided, size()))}>
          +
        </button>
        <button disabled={cam === HOME} onClick={() => setCam(HOME)}>
          Reset
        </button>
      </div>
      <p className="fine cvnote">{noOrphan(twoSided ? "Drag to turn it, and pinch or scroll to zoom. These are the two real photos of this item, so it turns like a flat card. There's no 3D scan." : "Pinch or scroll to zoom, then drag to move around.")}</p>
    </DetailSheet>
  );
}
