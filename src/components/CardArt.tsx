"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Slab } from "./Slab.tsx";
import { NftImg } from "./NftImg.tsx";

/** Loaded the first time someone asks for a closer look, so no page carries it until then. */
const CardViewer = dynamic(() => import("./CardViewer.tsx"), { ssr: false });

/** One prize's picture: front and back where there's a back, and a press opens the close look. The same on every page that shows one. */
export function CardArt({ name, front, back, nft, className, sizes, priority }: { name: string; front: string; back?: string | null; nft?: boolean; className?: string; sizes: string; priority?: boolean }) {
  const [side, setSide] = useState<"front" | "back">("front");
  const [looking, setLooking] = useState(false);
  const shown = side === "back" && back ? back : front;
  return (
    <>
      <button className="artopen" aria-label={`Zoom in on ${name}`} onClick={() => setLooking(true)}>
        {nft ? (
          <NftImg className={className} src={front} alt={name} sizes={sizes} priority={priority} />
        ) : (
          <Slab key={shown} className={className} src={shown} alt={`${name}, ${side}`} width={400} height={560} sizes={sizes} priority={priority} onFail="placeholder" />
        )}
      </button>
      <div className="flip" role="group" aria-label="Picture">
        {back ? (
          <>
            <button aria-pressed={side === "front"} onClick={() => setSide("front")}>
              Front
            </button>
            <button aria-pressed={side === "back"} onClick={() => setSide("back")}>
              Back
            </button>
          </>
        ) : null}
        <button onClick={() => setLooking(true)}>Zoom</button>
      </div>
      {/* On the page itself, so a parent sheet's transform can't shrink or clip it. */}
      {looking ? createPortal(<CardViewer name={name} front={front} back={back} square={nft} onClose={() => setLooking(false)} />, document.body) : null}
    </>
  );
}
