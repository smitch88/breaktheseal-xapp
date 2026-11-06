"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { rumble, setSound, soundOn, wake } from "@/lib/audio";
import { HERO_ART, HERO_BOX } from "@/lib/hero-art";
import { RIP_LAYERS, RIP_RAYS, ripParts } from "@/lib/rip-art";
import type { Award } from "@/lib/rails/types";
import { TIER_COLOR, TIER_NAMES } from "@/lib/tiers";
import { STAGE_POSES, playBite, reducedMotion, run, type BiteLook } from "./bite-run.ts";
import { SealLayers, SheenLayers, box, newPackEls, newSealEls, origin } from "./idle-seal.tsx";
import { Slab } from "./Slab.tsx";
import { NftImg } from "./NftImg.tsx";
import { SoundIcon } from "./SoundIcon.tsx";
import { startStageIdle, type EyeGlints } from "./stage-idle-run.ts";

export type StageMode = "order" | "try" | "live";

type Props = {
  /** The pack on the stage. */
  art: string;
  /** Finished before the bite: the stage shows an award, it can't choose one. Null while it is still on its way. */
  award: Award | null;
  error: string | null;
  mode: StageMode;
  picker?: React.ReactNode;
  onRetry?: () => void;
  onClose: () => void;
  onReveal: () => void;
  /** Real rails only: what this pull is, in the hint line (TESTNET, SIMULATED CARD). */
  networkTag?: string;
  /** Real rails only: where the pull stands. The stage just shows it. */
  steps?: readonly { readonly done: boolean; readonly wait: string; readonly yes: string }[];
  /** Real rails only: a way back, for someone who got here without paying. */
  waitingOn?: React.ReactNode;
  /** Which pack of a multi order this is (PACK 2 OF 10), at the front of the hint line. */
  count?: string;
  /** The award was fixed before this stage opened, as for every pack after a multi order's first: no build-up while it's "picked". */
  held?: boolean;
};

/** The full-screen bite: the seal clamps the wax, tears the top off the pack and the item rises out. It only shows an award. */
export function Stage({ art, award, error, mode, picker, onRetry, onClose, onReveal, networkTag, steps, waitingOn, count, held }: Props) {
  const [phase, setPhase] = useState<"pulling" | "ready" | "biting">("pulling");
  const [dwelled, setDwelled] = useState(mode === "try" || !!held);
  const [picked, setPicked] = useState(!!held);
  const [layers, setLayers] = useState(false);
  const [sound, setSoundState] = useState(true);
  const [still, setStill] = useState(true);
  const parts = ripParts(art);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const finished = useRef(false);
  const zone = useRef<HTMLDivElement>(null);
  const hot = useRef<HTMLImageElement>(null);
  const star = useRef<HTMLImageElement>(null);
  const cam = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const rays = useRef<HTMLImageElement>(null);
  const whole = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLImageElement>(null);
  const body = useRef<HTMLImageElement>(null);
  const top = useRef<HTMLImageElement>(null);
  const rise = useRef<HTMLDivElement>(null);
  const yank = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const open = useRef<HTMLDivElement>(null);
  const clamp = useRef<HTMLImageElement>(null);
  const pow = useRef<HTMLImageElement>(null);
  const fx = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const seal = useRef(newSealEls());
  const pack = useRef(newPackEls());
  const glints = useRef<EyeGlints>({ far: null, near: null });
  const idle = useRef<{ settle: () => void } | null>(null);

  const later = useCallback((f: () => void, ms: number) => {
    timers.current.push(setTimeout(f, ms));
  }, []);

  useEffect(() => {
    setSoundState(soundOn());
    setStill(reducedMotion());
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (mode === "try") return;
    const a = setTimeout(() => setPicked(true), 2200);
    const b = setTimeout(() => setDwelled(true), 2800);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [mode]);

  // Hold the tap until the layers are decoded, so the bite can't play with a part missing. A slow network doesn't get to stall it.
  useEffect(() => {
    let live = true;
    const srcs = [parts.whole, parts.top, parts.body, parts.back, ...RIP_LAYERS];
    const decoded = Promise.all(
      srcs.map((src) => {
        const i = new window.Image();
        i.src = src;
        return i.decode().catch(() => undefined);
      }),
    );
    const cap = new Promise((r) => setTimeout(r, 2500));
    void Promise.race([decoded, cap]).then(() => live && setLayers(true));
    return () => {
      live = false;
    };
  }, [parts.whole, parts.top, parts.body, parts.back]);

  // Ready once the award is in hand and the short build-up has played.
  useEffect(() => {
    if (phase !== "pulling" || !award || !dwelled || !layers) return;
    setPhase("ready");
    if (mode !== "try") rumble();
    whole.current?.classList.add("shake");
    zone.current?.focus({ preventScroll: true });
  }, [phase, award, dwelled, layers, mode]);

  // Alive only while it waits for the bite, and not at all under reduced motion: these layers load then, not before.
  const alive = phase !== "pulling" && !still;
  useEffect(() => {
    if (phase !== "ready" || still) return;
    pack.current.whole = whole.current;
    const loop = startStageIdle({ zone: zone.current, rays: rays.current, cam: cam.current, anchor: anchor.current, pack: pack.current, seal: seal.current, glints: glints.current }, parts.sheen.length);
    idle.current = loop;
    return () => {
      loop.stop();
      idle.current = null;
    };
  }, [phase, still, parts.sheen.length]);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    timers.current.forEach(clearTimeout);
    onReveal();
  }, [onReveal]);

  const look: BiteLook = {
    ...STAGE_POSES,
    exitExtra: () => 0,
    flash: (color, peak, ms, easing) => run(flash.current, [{ opacity: peak, background: color }, { opacity: 0, background: color }], ms, easing),
  };

  const bite = () => {
    if (phase !== "ready" || !award) return;
    wake();
    idle.current?.settle();
    setPhase("biting");
    const els = { zone: zone.current, hot: hot.current, star: star.current, cam: cam.current, rig: rig.current, whole: whole.current, back: back.current, body: body.current, top: top.current, rise: rise.current, yank: yank.current, anchor: anchor.current, open: open.current, clamp: clamp.current, pow: pow.current, fx: fx.current };
    playBite(els, parts, TIER_NAMES.indexOf(award.tier), TIER_COLOR[award.tier], later, look, finish);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      bite();
    }
  };

  const ready = phase === "ready";
  const tagged = (text: string) => (networkTag ? `${networkTag} · ${text}` : text);
  const said = error ? "COULDN'T LOAD THE PACK" : mode === "live" ? tagged(ready ? "BITE THE SEAL OR TAP" : "WAITING ON THE LEDGER") : ready ? "BITE THE SEAL OR TAP" : mode === "try" ? "DEMO PULL" : "DEMO PULL";
  const hint = count && !error ? `${count} · ${said}` : said;
  const rigVars = { "--ar": parts.w / parts.h, "--wx": `${parts.wx}%`, "--wy": `${parts.wy}%`, "--seal": `${parts.seal}%`, "--tear": `${parts.tear}%` } as React.CSSProperties;

  return (
    <div className="stage">
      <div className={`stop ${picker ? "has-pick" : ""}`}>
        <div className="tl">
          <button className="sq" aria-label="Close" onClick={onClose}>
            ×
          </button>
          <button
            className="sq"
            aria-label={`Sound ${sound ? "on" : "off"}`}
            aria-pressed={sound}
            onClick={() => {
              setSound(!sound);
              setSoundState(!sound);
            }}
          >
            <SoundIcon on={sound} />
          </button>
          {picker}
        </div>
        <div className="hint">{hint}</div>
        <button className="skip" onClick={finish} disabled={!award}>
          SKIP
        </button>
      </div>
      {error ? (
        <div className="err">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/404.webp" alt="A confused seal with foil in its teeth" width={260} />
          <h3>The pack didn&apos;t load</h3>
          <p>{error} Nothing was charged.</p>
          <div className="acts">
            {onRetry ? (
              <button className="btn" onClick={onRetry}>
                Try again
              </button>
            ) : null}
            <button className="btn ol" onClick={onClose}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div ref={zone} className={`zone ${ready ? "tap" : ""}`} tabIndex={ready ? 0 : -1} role={ready ? "button" : undefined} aria-label={ready ? "Tap to bite the seal" : undefined} onClick={ready ? bite : undefined} onKeyDown={ready ? onKey : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="burst" ref={rays} src={RIP_RAYS} alt="" />
          {/* Every layer is a plain image moved by transform and opacity: no filters and no blend modes, for phone memory. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="rbg" ref={hot} src="/assets/rip/bg.webp" alt="" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="rstar" ref={star} src="/assets/rip/star.webp" alt="" />
          <div className="cam" ref={cam}>
            <div className="rig" ref={rig} style={rigVars}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="pk off" ref={back} src={parts.back} alt="" />
              <div className={`rise off ${award?.kind === "nft" ? "nft" : ""}`} ref={rise}>
                {award ? <RisingAward award={award} /> : null}
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="pk off" ref={body} src={parts.body} alt="" />
              <div className="pk hpack" ref={whole}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="pk" src={parts.whole} alt="Sealed pack" />
                {alive ? <SheenLayers els={pack} srcs={parts.sheen} /> : null}
                {alive && parts.wax ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    className="hwax"
                    ref={(el) => {
                      pack.current.wax = el;
                    }}
                    src={parts.wax}
                    style={{ ...box(HERO_BOX.wax), transformOrigin: origin(HERO_BOX.waxOrigin) }}
                    alt=""
                  />
                ) : null}
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="rpow" ref={pow} src="/assets/rip/pow.webp" alt="" />
              <div className="yank" ref={yank}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="pk off" ref={top} src={parts.top} alt="" />
                <div className="anchor" ref={anchor}>
                  <div className="sl sl-open hseal" ref={open}>
                    <div
                      className="hbreath"
                      ref={(el) => {
                        seal.current.breath = el;
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className="hbase" src={HERO_ART.seal} width={640} height={700} alt="" />
                      {alive ? <SealLayers els={seal} eyes={<SealEyes glints={glints} />} /> : null}
                    </div>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="sl sl-clamp off" ref={clamp} src="/assets/rip/seal-clamp.webp" alt="" />
                </div>
              </div>
            </div>
          </div>
          <div className="fx" ref={fx} />
          <div className="fl" ref={flash} />
          {phase === "biting" ? null : (
            <div className="prompt">
              {ready ? (
                <>
                  <h3>Tap to bite the seal</h3>
                  {mode === "live" ? null : <div className="sub2">{mode === "try" ? "A random example from this pack. Nothing is drawn or paid." : "A demo pull: an example you don't own. The bite only shows it."}</div>}
                </>
              ) : mode === "live" ? (
                <>
                  <h3>Your pack is on its way</h3>
                  <div className="steps">
                    {(steps ?? []).map((s) => (s.done ? <span key={s.yes} className="y">✓ {s.yes}</span> : <span key={s.wait}>… {s.wait}</span>))}
                    {waitingOn ? <span>{waitingOn}</span> : null}
                  </div>
                </>
              ) : mode === "order" ? (
                <>
                  <h3>Your pack is on its way</h3>
                  <div className="steps">
                    <span className="y">✓ Demo payment confirmed</span>
                    {picked && award ? <span className="y">✓ Picked</span> : <span>… Picking</span>}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The eyes' highlights, lifted off the sprite so they can follow the pointer. At rest the layers add up to the sprite exactly, and they arrive together: a clean layer on its own would be an eye with no light in it. */
function SealEyes({ glints }: { glints: React.MutableRefObject<EyeGlints> }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const srcs = Object.values(HERO_ART.eye).flatMap((e) => [e.clean, e.glint]);
    void Promise.all(
      srcs.map((src) => {
        const i = new window.Image();
        i.src = src;
        return i.decode();
      }),
    ).then(
      () => live && setLoaded(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (!loaded) return null;
  return (
    <>
      {(["far", "near"] as const).map((eye) => {
        const b = box(eye === "far" ? HERO_BOX.lidFar : HERO_BOX.lidNear);
        return (
          <Fragment key={eye}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="heye" src={HERO_ART.eye[eye].clean} style={b} alt="" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="heye glint"
              ref={(el) => {
                glints.current[eye] = el;
              }}
              src={HERO_ART.eye[eye].glint}
              style={b}
              alt=""
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** The item coming out of the pack, and the head start on the reveal's image: same source and sizes, so it's cached by then. */
function RisingAward({ award }: { award: Award }) {
  if (award.kind === "nft") return <NftImg src={award.img} alt="" sizes={REVEAL_SIZES} priority />;
  return <Slab src={award.img} alt="" width={400} height={560} sizes={REVEAL_SIZES} priority onFail="placeholder" />;
}

export const REVEAL_SIZES = "(max-width: 760px) 92vw, 480px";
