"use client";

import { noOrphan } from "@/lib/format";
import { useConnect } from "../Providers.tsx";
import { useXapp } from "../XappHost.tsx";

/**
 * A pull stays with the wallet that paid, and anyone can look at it. A phone landing here in a browser that isn't signed in
 * still sees what happened, and this is the way to act on it.
 */
export function SignInToAct({ text = "Connect the wallet that paid to sell, claim or ship this. It stays yours until you do." }: { text?: string }) {
  const connect = useConnect();
  // Inside Xaman the launch names the account, so this only means it hasn't arrived yet.
  if (useXapp().shell) return null;
  return (
    <>
      <p className="fine">{noOrphan(text)}</p>
      <button className="btn full" onClick={() => connect()}>
        Connect your wallet
      </button>
    </>
  );
}
