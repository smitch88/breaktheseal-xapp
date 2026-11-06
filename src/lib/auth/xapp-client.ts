import { XAMAN_API } from "./xaman-client.ts";
import type { XappNetwork, XappXaman } from "./xapp.ts";

/** Xaman's xApp endpoints, server side only. A 4xx or an error body is Xaman refusing the token; anything else that fails throws. */
export function createXappClient(apiKey: string, apiSecret: string, fetchImpl: typeof fetch = fetch): XappXaman {
  const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret, "content-type": "application/json", accept: "application/json" };
  return {
    async getOtt(token) {
      const res = await fetchImpl(`${XAMAN_API}/xapp/ott/${encodeURIComponent(token)}`, { method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return { kind: "refused" };
      if (!res.ok) throw new Error(`Xaman ${res.status}`);
      const data = (await res.json()) as { error?: unknown } | null;
      return !data || typeof data !== "object" || data.error ? { kind: "refused" } : { kind: "data", data };
    },
    async createSignIn({ nonce, account, network }: { nonce: string; account: string; network: XappNetwork }) {
      const res = await fetchImpl(`${XAMAN_API}/payload`, {
        method: "POST",
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          txjson: { TransactionType: "SignIn" },
          // No return URL: inside the xApp, Xaman would open it in the phone's browser.
          options: { submit: false, expire: 5, signers: [account], force_network: network },
          custom_meta: { identifier: nonce, instruction: "Confirm this account is yours, so Break the Seal can act on what it holds when you ask. This moves no funds." },
        }),
      });
      if (!res.ok) throw new Error(`Xaman ${res.status}`);
      const body = (await res.json()) as { uuid?: unknown };
      if (typeof body.uuid !== "string") throw new Error("unexpected Xaman response");
      return { uuid: body.uuid };
    },
  };
}
