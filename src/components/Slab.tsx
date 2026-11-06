"use client";

import Image from "next/image";
import { useState } from "react";
import { CARD_NO_PICTURE } from "@/lib/rip/art-paths";

/**
 * A real slab photo from the pack API. A few source images are missing or broken upstream, so a failed one drops out of a
 * fan, or, where the slot has to stay filled, shows the "No image yet" placeholder slab. Never the sealed pack (it read as
 * a pack that never opened) and never a made-up card.
 */
export function Slab({ src, alt, width, height, sizes, className, style, priority, onFail = "hide" }: { src: string; alt: string; width: number; height: number; sizes: string; className?: string; style?: React.CSSProperties; priority?: boolean; onFail?: "hide" | "placeholder" }) {
  const [broken, setBroken] = useState<string | null>(null);
  const failed = !src || broken === src;
  if (failed && onFail === "hide") return null;
  if (failed) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img className={className} src={CARD_NO_PICTURE} width={width} height={height} alt={alt ? `${alt}: card image not available yet` : ""} style={style} />;
  }
  return (
    <Image
      className={className}
      src={src}
      alt={alt}
      width={width}
      height={height}
      sizes={sizes}
      style={style}
      priority={priority}
      onError={() => setBroken(src)}
      // A picture that failed before this page woke up never fires onError, so the ref looks too.
      ref={(el) => void (el?.complete && !el.naturalWidth && el.currentSrc && setBroken(src))}
    />
  );
}
