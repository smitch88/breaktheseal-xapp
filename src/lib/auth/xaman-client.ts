import type { XamanClient } from "./service.ts";

export const XAMAN_API = "https://xumm.app/api/v1/platform";

const https = (v: unknown, prefix: string): string => {
  if (typeof v !== "string" || !v.startsWith(prefix)) throw new Error("unexpected Xaman response");
  return v;
};

/** The Xaman platform API, server side only. The key and secret never reach a browser. */
export function createXamanClient(apiKey: string, apiSecret: string, fetchImpl: typeof fetch = fetch): XamanClient {
  const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret, "content-type": "application/json", accept: "application/json" };
  return {
    async createSignIn({ nonce, returnUrl }) {
      const res = await fetchImpl(`${XAMAN_API}/payload`, {
        method: "POST",
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          txjson: { TransactionType: "SignIn" },
          options: { submit: false, expire: 5, return_url: { app: returnUrl, web: returnUrl } },
          custom_meta: { identifier: nonce, instruction: "Sign in to Break the Seal. This moves no funds." },
        }),
      });
      if (!res.ok) throw new Error(`Xaman ${res.status}`);
      const body = (await res.json()) as { uuid?: string; next?: { always?: string }; refs?: { qr_png?: string; websocket_status?: string } };
      if (typeof body.uuid !== "string") throw new Error("unexpected Xaman response");
      return { uuid: body.uuid, open: https(body.next?.always, "https://"), qr: https(body.refs?.qr_png, "https://"), ws: https(body.refs?.websocket_status, "wss://") };
    },
    async getPayload(uuid) {
      const res = await fetchImpl(`${XAMAN_API}/payload/${encodeURIComponent(uuid)}`, { method: "GET", headers, cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Xaman ${res.status}`);
      return res.json();
    },
  };
}
