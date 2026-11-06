import "server-only";
import { cookies } from "next/headers";
import { railsConfig } from "../rip/mode.ts";
import { authService, cookieBase, nonceStore } from "./server.ts";
import { createXappClient } from "./xapp-client.ts";
import { XAPP_COOKIE, XAPP_TTL_S, createXappService, xappEnabled, xappNetwork, type XappService } from "./xapp.ts";

export const xappOn = () => xappEnabled(process.env);
export const currentXappNetwork = () => xappNetwork(railsConfig(process.env).mode);

export function xappService(): XappService | null {
  const secret = process.env.SEAL_SESSION_SECRET;
  const auth = authService();
  if (!xappOn() || !secret || !auth) return null;
  const key = process.env.XAMAN_API_KEY;
  const apiSecret = process.env.XAMAN_API_SECRET;
  return createXappService({ secret, store: nonceStore, auth, xaman: key && apiSecret ? createXappClient(key, apiSecret) : null, network: currentXappNetwork() });
}

export const xappCookieOptions = (req: Request) => ({ ...cookieBase(req), maxAge: XAPP_TTL_S });

/** The account of this browser's confirmed launch. With the flag off this reads nothing at all. */
export async function xappAccount(): Promise<string | null> {
  const service = xappService();
  if (!service) return null;
  return service.account((await cookies()).get(XAPP_COOKIE)?.value);
}
