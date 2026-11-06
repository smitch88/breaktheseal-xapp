"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatch } from "@/lib/demo/store";
import { shortAddress } from "@/lib/format";
import { useConnect } from "./Providers.tsx";

type Answer = { state?: string; session?: { address: string; wallet: "xaman" | "joey" }; wanted?: string };
type View = { name: "checking" } | { name: "signed"; address: string } | { name: "other"; current: string; wanted: string } | { name: "end"; title: string; text: string; action: string };

/** Xaman answers within a moment of its button being pressed. This is how long we give it. */
const TRIES = 14;
const GAP_MS = 1500;
const CONNECT_AGAIN = "Connect again";

function endView(state: string | undefined, qr: boolean): Extract<View, { name: "end" }> {
  if (state === "declined") return { name: "end", title: "You said no in Xaman", text: "Nothing changed.", action: CONNECT_AGAIN };
  if (state === "used") return { name: "end", title: "That sign-in link was already used", text: "A link like this works once. Connect again and you'll be right back.", action: CONNECT_AGAIN };
  if (state === "expired") return { name: "end", title: "That sign-in ran out", text: "Sign-in requests only last a few minutes. Connect again and it takes a moment.", action: CONNECT_AGAIN };
  if (state === "pending") return { name: "end", title: "We haven't seen your approval", text: "If you approved it in Xaman, connect again and it takes a moment. Nothing moved.", action: CONNECT_AGAIN };
  if (qr) return { name: "end", title: "Approved on your phone?", text: "The screen showing the code signs in by itself. To use this phone too, connect here.", action: "Connect on this phone" };
  return { name: "end", title: "We couldn't finish that sign-in here", text: "Nothing moved. Connect again and it takes a moment.", action: CONNECT_AGAIN };
}

const ask = async (body: unknown): Promise<Answer> => {
  const res = await fetch("/api/auth/xaman/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => ({ state: "pending" }))) as Answer) : { state: "pending" };
};

/**
 * Where Xaman sends a phone back. Its operating system picks the browser, and neither iOS nor Android returns to the tab that
 * started, so this has to finish wherever it lands: from the sign-in cookie in the browser that started, or from the link in any
 * other. Then it goes back to the page the player left. If it truly can't finish, it says why and offers one thing to do.
 */
export function AuthReturn() {
  const router = useRouter();
  const connect = useConnect();
  const [view, setView] = useState<View>({ name: "checking" });
  const link = useRef<{ xp: string | null; k: string | null; to: string; qr: boolean } | null>(null);
  const live = useRef(true);

  const go = useCallback(() => router.replace(link.current?.to ?? "/packs"), [router]);
  const finish = useCallback(
    (session: NonNullable<Answer["session"]>) => {
      dispatch({ type: "connect", address: session.address, wallet: session.wallet });
      setView({ name: "signed", address: session.address });
      go();
    },
    [go],
  );

  const check = useCallback(
    async (replace = false) => {
      for (let tries = 0; tries < TRIES && live.current; tries++) {
        const { xp, k, qr } = link.current as NonNullable<typeof link.current>;
        const body = await ask({ xp, k, ...(replace ? { replace: true } : {}) });
        if (!live.current) return;
        if (body.state === "signed" && body.session) return finish(body.session);
        if (body.state === "other-account" && body.session && body.wanted) return setView({ name: "other", current: body.session.address, wanted: body.wanted });
        if (body.state !== "pending") return setView(endView(body.state, qr));
        if (tries === TRIES - 1) return setView(endView("pending", qr));
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    },
    [finish],
  );

  useEffect(() => {
    live.current = true;
    if (!link.current) {
      const q = new URLSearchParams(window.location.search);
      const to = q.get("to");
      link.current = { xp: q.get("xp"), k: q.get("k"), qr: q.get("qr") === "1", to: to?.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/packs" };
      // The link did its job. It shouldn't sit in the address bar, the history or a shared screenshot.
      if (q.has("xp") || q.has("k")) {
        q.delete("xp");
        q.delete("k");
        window.history.replaceState(window.history.state, "", `/auth/return${q.size ? `?${q}` : ""}`);
      }
      void check();
    }
    return () => {
      live.current = false;
    };
  }, [check]);

  if (view.name === "other") {
    return (
      <main className="pg">
        <div className="emptyc">
          <h3>You&apos;re already signed in</h3>
          <p>
            This browser is signed in as {shortAddress(view.current)}. The sign-in you approved is for {shortAddress(view.wanted)}.
          </p>
          <div className="two">
            <button className="btn ol" onClick={go}>
              Stay as {shortAddress(view.current)}
            </button>
            <button
              className="btn"
              onClick={() => {
                setView({ name: "checking" });
                void check(true);
              }}
            >
              Use {shortAddress(view.wanted)}
            </button>
          </div>
        </div>
      </main>
    );
  }
  if (view.name === "end") {
    return (
      <main className="pg">
        <div className="emptyc">
          <h3>{view.title}</h3>
          <p>{view.text}</p>
          <button className="btn" onClick={() => connect(go)}>
            {view.action}
          </button>
        </div>
      </main>
    );
  }
  return (
    <main className="pg">
      <div className="emptyc" role="status">
        <h3>{view.name === "signed" ? "You're signed in" : "Checking your sign-in"}</h3>
        {view.name === "signed" ? <p>Signed in as {shortAddress(view.address)}. Taking you back.</p> : null}
      </div>
    </main>
  );
}
