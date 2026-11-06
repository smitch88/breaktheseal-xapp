import { XAMAN_API } from "./xaman-client.ts";
import type { XappNetwork, XappXaman } from "./xapp.ts";

/** Xaman's JWT endpoints, where its own SDK resolves a launch token in an xApp. */
export const XAMAN_JWT_API = "https://xumm.app/api/v1/jwt";

/**
 * Xaman's xApp endpoints, server side only. A launch token is resolved the way Xaman's own SDK does it, at the JWT authorize endpoint
 * with the API key alone: that answers with the same launch data and a JWT for this player, good for 24 hours, which is what reads
 * and writes their userstore. If that doesn't answer with launch data, the platform endpoint is asked, as before, and there's no JWT.
 * A 4xx or an error body is Xaman refusing the token; anything else that fails throws.
 */
export function createXappClient(apiKey: string, apiSecret: string, fetchImpl: typeof fetch = fetch): XappXaman {
  const headers = { "x-api-key": apiKey, "x-api-secret": apiSecret, "content-type": "application/json", accept: "application/json" };
  return {
    async getOtt(token) {
      const viaJwt = await fetchImpl(`${XAMAN_JWT_API}/authorize`, { method: "GET", headers: { "x-api-key": apiKey, "x-api-ott": token, accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) }).catch(() => null);
      const jwtBody = viaJwt?.ok ? ((await viaJwt.json().catch(() => null)) as { ott?: unknown; jwt?: unknown; error?: unknown } | null) : null;
      // The launch data reads exactly as the platform's would (readOtt decides what it allows), so a launch with no account still says so.
      const ott = jwtBody && !jwtBody.error && jwtBody.ott && typeof jwtBody.ott === "object" && !Array.isArray(jwtBody.ott) ? jwtBody.ott : null;
      if (ott) return { kind: "data", data: ott, jwt: typeof jwtBody?.jwt === "string" ? jwtBody.jwt : null };
      const res = await fetchImpl(`${XAMAN_API}/xapp/ott/${encodeURIComponent(token)}`, { method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return { kind: "refused" };
      if (!res.ok) throw new Error(`Xaman ${res.status}`);
      const data = (await res.json()) as { error?: unknown } | null;
      return !data || typeof data !== "object" || data.error ? { kind: "refused" } : { kind: "data", data, jwt: null };
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
          custom_meta: { identifier: nonce, instruction: "Approve Break the Seal acting on your stash for the next 2 hours, only when you ask: selling back, cashing out, claiming or shipping a prize. This moves no funds and costs nothing." },
        }),
      });
      if (!res.ok) throw new Error(`Xaman ${res.status}`);
      const body = (await res.json()) as { uuid?: unknown };
      if (typeof body.uuid !== "string") throw new Error("unexpected Xaman response");
      return { uuid: body.uuid };
    },
  };
}
