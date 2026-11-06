"use client";

import { getImageProps } from "next/image";
import { useState } from "react";
import { ART_ROUTE, NO_PICTURE } from "@/lib/rip/art-paths";

/**
 * An NFT's picture, never a blank box. One from the art route is sized and turned into webp by next/image; if that fails, the route's own bytes
 * are tried as they are (an SVG, say); if that fails too, or any other picture does, it says plainly that the picture isn't available.
 */
export function NftImg({ src, alt, className, sizes = "(min-width:760px) 380px, 80vw", loading, draggable, priority, style }: { src: string; alt: string; className?: string; sizes?: string; loading?: "lazy" | "eager"; draggable?: boolean; priority?: boolean; style?: React.CSSProperties }) {
  const [failed, setFailed] = useState<{ src: string; times: number }>({ src, times: 0 });
  const times = failed.src === src ? failed.times : 0;
  const routed = src.startsWith(ART_ROUTE);
  const shown = !src || times >= (routed ? 2 : 1) ? NO_PICTURE : src;
  let picked: { src: string; srcSet?: string; sizes?: string } = { src: shown };
  if (routed && shown === src && times === 0) {
    const { props } = getImageProps({ src, alt, width: 840, height: 840, sizes, priority });
    picked = { src: props.src as string, srcSet: props.srcSet, sizes: props.sizes };
  }
  const fail = () => {
    if (shown !== NO_PICTURE) setFailed({ src, times: times + 1 });
  };
  return (
    // A picture that failed before this page woke up never fires onError, so the ref looks too.
    /* eslint-disable-next-line @next/next/no-img-element */
    <img key={picked.src} ref={(el) => void (el?.complete && !el.naturalWidth && el.src && fail())} className={className} style={style} {...picked} alt={alt} loading={priority ? "eager" : loading} draggable={draggable} onError={fail} />
  );
}
