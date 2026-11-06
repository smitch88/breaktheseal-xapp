import { randomBytes } from "node:crypto";
import { playerTxRefusal } from "./player-tx.ts";

export const XAMAN_API = "https://xumm.app/api/v1/platform";

export interface WalletRequest {
  readonly uuid: string;
  readonly open: string;
  readonly qr: string;
  readonly ws: string;
  /** Xaman confirmed it pushed this request to the player's phone. */
  readonly pushed?: boolean;
}

/** Where a player's Xaman push token is kept, privately and server side only. It's bound to our API key and to them, and Xaman ends it 30 days after their last signature. */
export const pushTokenKey = (address: string) => `xaman-user-token:${address}`;
export const isUserToken = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Ask Xaman to show a player one transaction to sign and submit. The player's wallet signs it, on their phone; no key of
 * theirs ever reaches us. `network` pins the request, so a testnet payment can't be signed against mainnet by mistake.
 */
/** Xaman refuses a repeated identifier, so asking again for the same order needs a new one. It is a label and nothing reads it back. */
const uniqueIdentifier = (id: string) => `${id.slice(0, 31)}-${randomBytes(4).toString("hex")}`;

/** Where one request stands, read from Xaman. Server side only. */
export async function readRequest(input: { apiKey: string; apiSecret: string; uuid: string; fetchImpl?: typeof fetch }): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`${XAMAN_API}/payload/${encodeURIComponent(input.uuid)}`, { method: "GET", headers: { "x-api-key": input.apiKey, "x-api-secret": input.apiSecret, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Xaman ${res.status}`);
  return res.json();
}

/**
 * A request a player is asked to sign, from the site or the xApp: only the four kinds a player ever signs (player-tx.ts), so no request
 * for anything that hands over or ends an account can leave this server. The owner's own deploy kit asks through requestSignature.
 */
export async function requestPlayerSignature(input: Parameters<typeof requestSignature>[0]): Promise<WalletRequest> {
  const refused = playerTxRefusal(input.txjson);
  if (refused) throw new Error(refused);
  return requestSignature(input);
}

export async function requestSignature(input: { apiKey: string; apiSecret: string; txjson: Readonly<Record<string, unknown>>; instruction: string; returnUrl: string | null; network: "TESTNET" | "MAINNET"; identifier: string; expireMinutes?: number; userToken?: string | null; fetchImpl?: typeof fetch }): Promise<WalletRequest> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`${XAMAN_API}/payload`, {
    method: "POST",
    headers: { "x-api-key": input.apiKey, "x-api-secret": input.apiSecret, "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      txjson: input.txjson,
      ...(input.userToken ? { user_token: input.userToken } : {}),
      // Xaman opens a return URL in the phone's browser after signing, so a request made inside the xApp has none.
      // `signers` makes Xaman itself refuse any account but the one this transaction names.
      options: { submit: true, expire: input.expireMinutes ?? 5, force_network: input.network, ...(typeof input.txjson.Account === "string" ? { signers: [input.txjson.Account] } : {}), ...(input.returnUrl === null ? {} : { return_url: { app: input.returnUrl, web: input.returnUrl } }) },
      custom_meta: { identifier: uniqueIdentifier(input.identifier), instruction: input.instruction },
    }),
  });
  if (!res.ok) throw new Error(`Xaman ${res.status}`);
  const body = (await res.json()) as { uuid?: string; pushed?: unknown; next?: { always?: string }; refs?: { qr_png?: string; websocket_status?: string } };
  const open = body.next?.always;
  const qr = body.refs?.qr_png;
  const ws = body.refs?.websocket_status;
  if (typeof body.uuid !== "string" || !open?.startsWith("https://") || !qr?.startsWith("https://") || !ws?.startsWith("wss://")) throw new Error("unexpected Xaman response");
  return { uuid: body.uuid, open, qr, ws, pushed: body.pushed === true };
}
