import { XAMAN_JWT_API } from "./xapp-client.ts";

/**
 * Xaman's userstore: the per-player, per-app key/value store its SDK offers as `xumm.userstore`, through the same JWT `userdata` API
 * the SDK calls. Xaman asks xApps to keep anything about a player there, not in cookies or the browser's storage. Break the Seal keeps
 * one thing: that this player has read the first-launch info sheet. Every failure reads as not seen, so the sheet shows again rather
 * than being skipped. Server side, with the JWT from the player's own launch.
 */
export const INFO_KEY = "btsinfo";

export interface Userstore {
  /** True only when Xaman's store clearly says this player saw the info sheet. */
  infoSeen(jwt: string | null | undefined): Promise<boolean>;
  /** Remember it. False if it wasn't kept, which only means the sheet shows again next launch. */
  markInfoSeen(jwt: string | null | undefined): Promise<boolean>;
}

export function createUserstore(fetchImpl: typeof fetch = fetch): Userstore {
  const call = (jwt: string, init: RequestInit) =>
    fetchImpl(`${XAMAN_JWT_API}/userdata/${INFO_KEY}`, { ...init, headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
  return {
    async infoSeen(jwt) {
      if (!jwt) return false;
      try {
        const res = await call(jwt, { method: "GET" });
        if (!res.ok) return false;
        const body = (await res.json()) as { data?: Record<string, { seen?: unknown } | undefined> } | null;
        return body?.data?.[INFO_KEY]?.seen === true;
      } catch {
        return false;
      }
    },
    async markInfoSeen(jwt) {
      if (!jwt) return false;
      try {
        const res = await call(jwt, { method: "POST", body: JSON.stringify({ seen: true }) });
        if (!res.ok) return false;
        const body = (await res.json()) as { persisted?: unknown } | null;
        return body?.persisted === true;
      } catch {
        return false;
      }
    },
  };
}
