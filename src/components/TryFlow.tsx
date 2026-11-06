"use client";

import Link from "next/link";
import { awardBack, pullMultiple } from "@/lib/pull-multiple";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { clampQty, parseQty, presetsFor } from "@/lib/live/multi";
import { demoDraw, demoDrawMany } from "@/lib/rails/demo-source";
import type { Award, PackRef } from "@/lib/rails/types";
import { TryMultiReveal } from "./DemoMulti.tsx";
import { useRails } from "./Providers.tsx";
import { RevealView } from "./RevealView.tsx";
import { Stage } from "./Stage.tsx";

export type TryOption = { value: string; label: string; name: string; price: number; art: string; pack: PackRef };

const DEFAULT = "pokemon_25";
const TRY_MAX = 20;

/** The free demo: a random example from any pack, no wallet, nothing kept. */
export function TryFlow({ options }: { options: readonly TryOption[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const asked = params?.get("pack") ?? DEFAULT;
  const force = params?.get("tier") ?? null;
  const { multi } = useRails();
  // Only with the switch on. Each draw is an example made in this browser, so no server limit applies.
  const [qty, setQty] = useState(() => (multi ? clampQty(parseQty(params?.get("qty")), TRY_MAX) : 1));
  const [many, setMany] = useState<readonly Award[]>([]);
  const first = options.find((o) => o.value === asked) ?? options.find((o) => o.value === DEFAULT) ?? options[0];
  const [pick, setPick] = useState(first?.value ?? "");
  const [run, setRun] = useState(0);
  const [award, setAward] = useState<Award | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const option = options.find((o) => o.value === pick) ?? first;

  useEffect(() => {
    if (!option) return;
    let live = true;
    setAward(null);
    setError(null);
    setRevealed(false);
    setMany([]);
    if (qty > 1) {
      demoDrawMany(option.pack, qty).then(
        (list) => {
          if (!live) return;
          setMany(list);
          setAward(list[0] ?? null);
        },
        () => live && setError("We couldn't reach this pack's items just now."),
      );
      return () => {
        live = false;
      };
    }
    demoDraw(option.pack, { force }).then(
      (a) => live && setAward(a),
      () => live && setError("We couldn't reach this pack's items just now."),
    );
    return () => {
      live = false;
    };
  }, [option, run, force, qty]);

  const close = useCallback(() => router.push("/"), [router]);
  const reveal = useCallback(() => setRevealed(true), []);
  const retry = useCallback(() => setRun((n) => n + 1), []);

  if (!option) {
    return (
      <div className="stage">
        <div className="err">
          <h3>No packs right now</h3>
          <div className="acts">
            <Link className="btn" href="/">
              Back home
            </Link>
          </div>
        </div>
      </div>
    );
  }
  if (revealed && qty > 1 && many.length) return <TryMultiReveal awards={many} name={option.name} price={option.price} art={option.art} onRetry={retry} onClose={close} />;
  if (revealed && award) {
    return (
      <RevealView
        award={award}
        packName={option.name}
        multiple={pullMultiple(awardBack(award), option.price)}
        onClose={close}
        actions={
          <div className="buy2">
            <button className="btn ol" onClick={retry}>
              Try again
            </button>
            <Link className="btn" href="/packs">
              See the packs
            </Link>
          </div>
        }
      />
    );
  }
  return (
    <Stage
      key={`${pick}-${run}-${qty}`}
      art={option.art}
      award={award}
      error={error}
      mode="try"
      onRetry={retry}
      onClose={close}
      onReveal={reveal}
      picker={
        <>
          <select className="pick" aria-label="Pick a pack" value={pick} onChange={(e) => setPick(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {multi ? (
            <select className="pick pickq" aria-label="How many packs" value={qty} onChange={(e) => setQty(clampQty(Number(e.target.value), TRY_MAX))}>
              {presetsFor(TRY_MAX).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 pack" : `${n} packs`}
                </option>
              ))}
            </select>
          ) : null}
        </>
      }
    />
  );
}
