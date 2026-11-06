"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { setSound, soundOn, wake } from "@/lib/audio";
import { HERO_ART, HERO_BOX, HERO_DRIPS, HERO_PACK, HERO_SAMPLE_LAYERS } from "@/lib/hero-art";
import { SHELF_PRICES } from "@/config/nft-packs";
import { nextSample, sampleSrc as sampleImg, shortSampleName, withLiveNfts, type HeroSample } from "@/lib/hero-samples";
import { useLivePool, useRipConfig } from "@/lib/live/hooks";
import { SHELF_LOOK_MS, shelfRestocking } from "@/lib/live/restock";
import { nftTitle } from "@/lib/nft/view";
import { RestockMark } from "./live/Restock.tsx";
import { useRails } from "./Providers.tsx";
import { approach, idleRuns, makeIdle, sampleNext, seeded, type SampleEvent, type SampleState } from "@/lib/hero-idle";
import { EASE_OUT, SNAP, playBite, reducedMotion, run, type BiteEls, type BiteLook } from "./bite-run.ts";
import { SealLayers, SheenLayers, box, newPackEls, newSealEls, origin, paintPack, paintSeal, restPack, restSeal } from "./idle-seal.tsx";
import { SoundIcon } from "./SoundIcon.tsx";

const IDLE = "translate(74.5%,41%) scale(.8)";
const REAR = "translate(84%,37%) scale(.78) rotate(6deg)";
const RIG = "translateX(-57%)";
const OFF_RIGHT = "translate(150%,52%) scale(.8)";
const HOLD_MS = 2100;
const ARM_CAP_MS = 6000;
const LEVEL = 0;
const FLASH = "#ffd91a";

/** The home hero. A pack and a seal that are alive before anyone touches them, and a bite you can watch right here. It's a sample: no draw and no API call, and the slab is a generic card back. */
export function HeroStage({ samples: cardsOrDemo = [] }: { samples?: readonly HeroSample[] }) {
  const { mode } = useRails();
  const live = mode !== "demo";
  // Rails on, the NFTs come from what's in the pools now, not the shelf's plan. They only change when someone loads the page, which is fine for a sample.
  const pools = [useLivePool(SHELF_PRICES[0], live, 120000), useLivePool(SHELF_PRICES[1], live, 120000)];
  const poolKey = pools.map((p) => p?.bands.map((b) => b.nfts.map((n) => n.id).join()).join()).join();
  const samples = useMemo(() => (live ? withLiveNfts(cardsOrDemo, pools.flatMap((p) => [...(p?.bands ?? [])].reverse().flatMap((b) => b.nfts.map((n) => ({ img: n.img, name: nftTitle(n.collection, n.name) }))))) : cardsOrDemo), [live, cardsOrDemo, poolKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The hero's pack stands for the whole shelf, so it's stamped only when nothing on the shelf can be bought.
  const shelfClosed = shelfRestocking(mode, useRipConfig(live, SHELF_LOOK_MS), SHELF_PRICES);
  const [state, setState] = useState<SampleState>("idle");
  const [played, setPlayed] = useState(false);
  const [sampleSrc, setSampleSrc] = useState(false);
  const [sound, setSoundState] = useState(true);
  const [shown, setShown] = useState<HeroSample | null>(null);
  const lastSample = useRef(-1);
  const stateRef = useRef<SampleState>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const arming = useRef<Promise<boolean> | null>(null);
  const engine = useRef<{ sync: () => void } | null>(null);

  const section = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const rays = useRef<HTMLImageElement>(null);
  const star = useRef<HTMLImageElement>(null);
  const cam = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const whole = useRef<HTMLDivElement>(null);
  const pack = useRef(newPackEls());
  const back = useRef<HTMLImageElement>(null);
  const body = useRef<HTMLImageElement>(null);
  const top = useRef<HTMLImageElement>(null);
  const rise = useRef<HTMLDivElement>(null);
  const yank = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const open = useRef<HTMLDivElement>(null);
  const seal = useRef(newSealEls());
  const clamp = useRef<HTMLImageElement>(null);
  const pow = useRef<HTMLImageElement>(null);
  const fx = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const nudge = useRef(0);
  const hovering = useRef(false);

  const send = useCallback((event: SampleEvent) => {
    const next = sampleNext(stateRef.current, event);
    if (next === stateRef.current) return false;
    stateRef.current = next;
    setState(next);
    engine.current?.sync();
    return true;
  }, []);

  const later = useCallback((f: () => void, ms: number) => {
    timers.current.push(setTimeout(f, ms));
  }, []);

  /** Decodes what only the bite shows. False if it can't be had in time: then the tap does nothing rather than play with a part missing. */
  const arm = useCallback(() => {
    if (!arming.current) {
      setSampleSrc(true);
      const decoded = Promise.all(
        HERO_SAMPLE_LAYERS.map((src) => {
          const i = new window.Image();
          i.src = src;
          return i.decode().then(() => true);
        }),
      ).then(
        () => true,
        () => false,
      );
      const cap = new Promise<boolean>((r) => setTimeout(() => r(false), ARM_CAP_MS));
      arming.current = Promise.race([decoded, cap]).then((ok) => {
        if (!ok) arming.current = null;
        return ok;
      });
    }
    return arming.current;
  }, []);

  // The bite's layers come after the page, so they never compete with its first paint.
  useEffect(() => {
    const start = () => void arm();
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(start, { timeout: 2500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(start, 1200);
    return () => clearTimeout(t);
  }, [arm]);

  useEffect(() => {
    setSoundState(soundOn());
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);

  // The idle: one loop writing transforms and opacity to plain images. It stops off screen, in a hidden tab, during a bite and under reduced motion.
  useEffect(() => {
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const idle = makeIdle(seeded(seed), { sheenLayers: HERO_ART.sheen.length, drips: HERO_DRIPS.length });
    const still = reducedMotion();
    let onScreen = true;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let spriteH = 0;
    const lidMem = { lids: "" };
    pack.current.whole = whole.current;

    const neutral = () => {
      restPack(pack.current);
      restSeal(seal.current, lidMem);
    };

    const frame = (now: number) => {
      const dt = last ? Math.min(now - last, 50) : 16;
      last = now;
      clock += dt;
      nudge.current = approach(nudge.current, hovering.current ? 1 : 0, dt);
      const p = idle.at(clock, nudge.current);
      paintPack(pack.current, p);
      paintSeal(seal.current, p, spriteH, lidMem);
      raf = requestAnimationFrame(frame);
    };

    const sync = () => {
      const go = idleRuns(stateRef.current, onScreen, !document.hidden, still);
      if (go && !raf) {
        last = 0;
        spriteH = seal.current.breath?.offsetHeight ?? 0;
        raf = requestAnimationFrame(frame);
      } else if (!go && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        if (stateRef.current !== "idle" && stateRef.current !== "arming") neutral();
      }
    };

    engine.current = { sync };
    const onResize = () => {
      spriteH = seal.current.breath?.offsetHeight ?? 0;
    };
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      sync();
    });
    if (section.current) io.observe(section.current);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", onResize);
    neutral();
    sync();
    return () => {
      engine.current = null;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const biteEls = useCallback((): BiteEls => ({ zone: zone.current, star: star.current, cam: cam.current, rig: rig.current, whole: whole.current, back: back.current, body: body.current, top: top.current, rise: rise.current, yank: yank.current, anchor: anchor.current, open: open.current, clamp: clamp.current, pow: pow.current, fx: fx.current }), []);

  const look = useCallback(
    (): BiteLook => ({
      idle: IDLE,
      rear: REAR,
      rig: RIG,
      biteY: 0.56,
      landing: { h: 0.86, w: 0.58, y: 0.5 },
      star: { w: 0.92, h: 1.32, y: 0.34 },
      // Far enough past the hero's top edge that the seal, which is bigger than the pack, is gone by the time it stops.
      exitExtra: () => {
        const s = section.current;
        const z = zone.current;
        const r = rig.current;
        return s && z && r ? Math.max(0, z.getBoundingClientRect().top - (s.closest(".hero") ?? s).getBoundingClientRect().top) + r.offsetWidth * 2.2 : 0;
      },
      stillMs: 700,
      flash: (color, peak, ms, easing) => {
        const el = flash.current;
        if (!el) return;
        el.style.setProperty("--flash", color === "#fff" ? "#fff" : FLASH);
        run(el, [{ opacity: peak }, { opacity: 0 }], ms, easing);
      },
    }),
    [],
  );

  /** The next real item, decoded so it's there when the pack tears. One that won't load is skipped; if none will, the sealed sample slab shows instead. */
  const pickSample = useCallback(async () => {
    for (let tries = 0; tries < Math.min(4, samples.length); tries++) {
      const i = nextSample(samples.length, lastSample.current);
      lastSample.current = i;
      const img = new window.Image();
      img.src = sampleImg(samples[i]);
      const ok = await Promise.race([img.decode().then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), ARM_CAP_MS / 2))]);
      if (ok) return samples[i];
    }
    return null;
  }, [samples]);

  /** Every layer the bite moved goes back where the page drew it. */
  const restore = useCallback(() => {
    const els = biteEls();
    for (const el of [els.zone, els.star, els.cam, els.rig, els.whole, els.back, els.body, els.top, els.rise, els.yank, els.anchor, els.open, els.clamp, els.pow, flash.current]) {
      if (!el) continue;
      el.getAnimations().forEach((a) => a.cancel());
      el.style.visibility = "";
    }
    if (els.star) els.star.style.opacity = "";
    if (els.rise) els.rise.style.transform = "";
    if (els.rig) els.rig.style.transform = "";
    if (fx.current) fx.current.textContent = "";
  }, [biteEls]);

  const comeBack = useCallback(() => {
    if (!send("release")) return;
    if (reducedMotion()) {
      restore();
      send("returned");
      return;
    }
    run(star.current, [{ opacity: 1 }, { opacity: 0 }], 150, "ease-in");
    run(rise.current, [{ opacity: 1 }, { opacity: 0 }], 150, "ease-in");
    later(() => {
      restore();
      // A fresh pack drops in, the seal slides back beside it.
      run(whole.current, [{ transform: "translateY(16%) scale(.9)", opacity: 0.35 }, { transform: "none", opacity: 1 }], 380, SNAP);
      run(anchor.current, [{ transform: OFF_RIGHT }, { transform: IDLE }], 460, EASE_OUT);
      later(() => {
        whole.current?.getAnimations().forEach((a) => a.cancel());
        anchor.current?.getAnimations().forEach((a) => a.cancel());
        send("returned");
      }, 480);
    }, 150);
  }, [later, restore, send]);

  const tap = useCallback(() => {
    if (!send("tap")) return;
    wake();
    void Promise.all([arm(), pickSample()]).then(([ok, sample]) => {
      if (!ok) {
        send("failed");
        return;
      }
      if (!send("armed")) return;
      // The bite measures the item as it starts, so it has to be on the page first.
      flushSync(() => setShown(sample));
      setPlayed(true);
      playBite(biteEls(), HERO_PACK, LEVEL, FLASH, later, look(), () => {
        send("played");
        later(comeBack, HOLD_MS);
      });
    });
  }, [arm, biteEls, comeBack, later, look, pickSample, send]);

  const busy = state !== "idle";
  const cue = state === "holding" || state === "playing" ? (shown ? `Sample: ${shortSampleName(shown.name)}. No draw, no prize.` : "A sample bite. No draw, no prize.") : played ? "Tap to bite again" : "Tap the seal";
  const rigVars = { "--ar": HERO_PACK.w / HERO_PACK.h, "--wx": `${HERO_PACK.wx}%`, "--wy": `${HERO_PACK.wy}%`, "--seal": `${HERO_PACK.seal}%`, "--tear": `${HERO_PACK.tear}%` } as React.CSSProperties;
  const src = (s: string) => (sampleSrc ? s : undefined);

  return (
    <div className="ha" ref={section}>
      <div className="hstage zone" ref={zone}>
        {/* Every layer is a plain image moved by transform and opacity: no filters, no blend modes, no masks. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hrays" ref={rays} src={HERO_ART.rays} alt="" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="rstar" ref={star} src={src("/assets/rip/star.webp")} alt="" />
        <div className="cam" ref={cam}>
          <div className="rig" ref={rig} style={rigVars}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk off" ref={back} src={src(HERO_ART.back)} alt="" />
            <div className={`rise off hslab ${shown ? `real ${shown.kind}` : ""}`} ref={rise}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shown ? sampleImg(shown) : src(HERO_ART.slab)} alt={shown ? `Sample: ${shown.name}` : ""} />
              <span className="hsample">Sample</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk off" ref={body} src={src(HERO_ART.body)} alt="" />
            <div className="pk hpack" ref={whole}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="pk" src={HERO_ART.pack} width={HERO_PACK.w} height={HERO_PACK.h} fetchPriority="high" alt="A silver foil pack with a red wax seal" />
              <SheenLayers els={pack} srcs={HERO_ART.sheen} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="hwax"
                ref={(el) => {
                  pack.current.wax = el;
                }}
                src={HERO_ART.wax}
                style={{ ...box(HERO_BOX.wax), transformOrigin: origin(HERO_BOX.waxOrigin) }}
                alt=""
              />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="rpow" ref={pow} src={src("/assets/rip/pow.webp")} alt="" />
            <div className="yank" ref={yank}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="pk off" ref={top} src={src(HERO_ART.top)} alt="" />
              <div className="anchor" ref={anchor}>
                <div className="sl sl-open hseal" ref={open}>
                  <div
                    className="hbreath"
                    ref={(el) => {
                      seal.current.breath = el;
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="hbase" src={HERO_ART.seal} width={640} height={700} fetchPriority="high" alt="A grey seal in a backward cap, jaws wide open and drooling" />
                    <SealLayers els={seal} />
                  </div>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sl sl-clamp off" ref={clamp} src={src("/assets/rip/seal-clamp.webp")} alt="" />
              </div>
            </div>
          </div>
        </div>
        <div className="fx" ref={fx} />
        <div className="fl hflash" ref={flash} />
        {shelfClosed && !busy ? <RestockMark /> : null}
        <button
          type="button"
          className="hhit"
          aria-label="Play a sample bite: the seal rips the pack open. Nothing is drawn or paid."
          aria-disabled={busy}
          onClick={tap}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") hovering.current = true;
          }}
          onPointerLeave={() => {
            hovering.current = false;
          }}
          onFocus={(e) => {
            if (e.target.matches(":focus-visible")) hovering.current = true;
          }}
          onBlur={() => {
            hovering.current = false;
          }}
        />
      </div>
      <div className="hcue">
        <span className={`hcue-t ${played ? "" : "first"}`} role="status">
          {played || busy ? null : (
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 8l4-4 4 4" />
            </svg>
          )}
          {cue}
        </span>
        {played && !busy ? (
          <Link className="hcue-l" href="/packs">
            See the packs <span aria-hidden="true">→</span>
          </Link>
        ) : null}
        <button
          type="button"
          className="hsnd"
          aria-label={`Sound ${sound ? "on" : "off"}`}
          aria-pressed={sound}
          onClick={() => {
            setSound(!sound);
            setSoundState(!sound);
          }}
        >
          <SoundIcon on={sound} />
        </button>
      </div>
    </div>
  );
}

