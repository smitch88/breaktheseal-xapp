import type { SessionTypes } from "@walletconnect/types";
import type UniversalProvider from "@walletconnect/universal-provider";
import { wrongNetworkText } from "./chain.ts";
import { WalletRefusal, type SignInApi } from "./joey-extension.ts";
import type { SignerTransport } from "./send.ts";

/**
 * Joey's phone app over WalletConnect, kept open after sign-in so payments can reach the phone. Joey's own docs name
 * `@walletconnect/universal-provider` as the supported way in for an app building its own UI. Joey ends a session when its
 * user switches account or network, and reports nothing else, so the session itself is the only account and network we believe.
 */
export const JOEY_METHODS = ["xrpl_signTransaction", "xrpl_signTransactionFor", "xrpl_signTransactionBulk"];
export const joeyPairLink = (uri: string) => `joey://settings/wc?uri=${encodeURIComponent(uri)}`;
/** Brings Joey to the front once a request has gone out. Requests themselves travel over the relay, not this link. */
export const JOEY_OPEN = "joey://settings/wc";
/** A sign-in's destination has to be a real address. Nothing is ever sent to it: the transaction can't apply. */
export const NO_DESTINATION = "rrrrrrrrrrrrrrrrrrrrrhoLvTp";

/** The parts of a Provider we use, so the tests can stand in for the relay. */
export type WcProvider = Pick<UniversalProvider, "connect" | "disconnect" | "request" | "on" | "off" | "session">;

export type JoeySession = Pick<SessionTypes.Struct, "topic" | "namespaces" | "expiry"> & { readonly sessionProperties?: Readonly<Record<string, string>> };

/** The one account a Joey session covers, on the one chain it covers. Null if there is none on this chain. */
export function sessionAccount(session: Pick<JoeySession, "namespaces"> | null | undefined, chain: string): string | null {
  const entry = session?.namespaces?.xrpl?.accounts?.find((a) => a.startsWith(`${chain}:`));
  return entry ? entry.slice(chain.length + 1) : null;
}

/** The chain a session is really on. Joey approves whichever network it's on, whatever was asked for. */
export function sessionChain(session: Pick<JoeySession, "namespaces"> | null | undefined): string | null {
  const [first] = session?.namespaces?.xrpl?.accounts ?? [];
  return first ? first.split(":").slice(0, 2).join(":") : null;
}

export const sessionLive = (session: Pick<JoeySession, "expiry"> | null | undefined, nowS = Date.now() / 1000) => !!session && session.expiry > nowS + 30;

const proposal = (chain: string) => ({ xrpl: { chains: [chain], methods: JOEY_METHODS, events: [] as string[] } });

/** Pair, asking Joey to sign in on the same screen if `signIn` is given. Resolves with the session once approved. */
export async function pair(provider: WcProvider, chain: string, signIn?: { challenge: string }): Promise<JoeySession> {
  const session = await provider.connect({
    namespaces: proposal(chain),
    ...(signIn ? { sessionProperties: { xrpl_signin_v1_challenge: signIn.challenge, xrpl_signin_v1_destination: NO_DESTINATION } } : {}),
  });
  if (!session) throw new WalletRefusal("Joey didn't connect.");
  return session as unknown as JoeySession;
}

const endQuietly = (provider: WcProvider) => provider.disconnect().catch(() => {});

/** A session on the wrong network can't sign anything here, so it ends right away and the player is told. */
function refuseWrongNetwork(provider: WcProvider, session: JoeySession, chain: string) {
  const found = sessionChain(session);
  if (found && found !== chain) {
    void endQuietly(provider);
    throw new WalletRefusal(wrongNetworkText(found, chain));
  }
}

/**
 * Sign in over WalletConnect. Joey signs the challenge on its connect screen, so one approval does both. If it comes back without
 * one, a normal sign request for a transaction that can't apply does the same job, on the session we now hold.
 */
export async function mobileSignIn(provider: WcProvider, api: SignInApi & { legacyChallenge(address: string): Promise<unknown>; legacyVerify(signed: unknown): Promise<{ address: string }> }): Promise<{ address: string }> {
  const start = await api.nonce();
  const session = await pair(provider, start.chain, { challenge: start.challenge });
  refuseWrongNetwork(provider, session, start.chain);
  const account = sessionAccount(session, start.chain);
  if (!account) {
    void endQuietly(provider);
    throw new WalletRefusal("Joey didn't share an account.");
  }
  const signedTx = session.sessionProperties?.xrpl_signin_v1_signed_tx;
  if (signedTx) {
    const done = await api.verify({ mode: "challenge-v1", signedTx });
    // The session and the signature have to be the same account, or payments would go to a wallet that can't sign them.
    if (done.address !== account) {
      void endQuietly(provider);
      throw new WalletRefusal("Joey signed with a different account than it connected. Try again.");
    }
    return done;
  }
  const tx = await api.legacyChallenge(account);
  const signed = await provider.request({ method: "xrpl_signTransaction", params: { tx_json: tx, autofill: false, submit: false } }, start.chain);
  return api.legacyVerify(signed);
}

/** Reconnect for someone already signed in. The session has to be for their account and this network. */
export async function mobileReconnect(provider: WcProvider, address: string, chain: string): Promise<void> {
  const session = await pair(provider, chain);
  refuseWrongNetwork(provider, session, chain);
  if (sessionAccount(session, chain) !== address) {
    void endQuietly(provider);
    throw new WalletRefusal("Joey connected a different account than the one you signed in with. Switch accounts in Joey and connect again, or sign out and sign in with that one.");
  }
}

export function mobileTransport(provider: WcProvider, opts: { onAsked?: () => void } = {}): SignerTransport {
  const live = () => (sessionLive(provider.session as JoeySession | undefined) ? (provider.session as unknown as JoeySession) : null);
  return {
    kind: "mobile",
    accounts: async () => {
      const session = live();
      const first = session?.namespaces?.xrpl?.accounts?.[0];
      return first ? [first.split(":")[2]] : [];
    },
    network: async () => sessionChain(live()),
    async signAndSubmit({ tx, chain }) {
      const asked = provider.request<{ tx_json?: Readonly<Record<string, unknown>> & { hash?: string } }>({ method: "xrpl_signTransaction", params: { tx_json: tx, submit: true, autofill: true } }, chain);
      opts.onAsked?.();
      const r = await asked;
      return { hash: r?.tx_json?.hash ?? null, signed: r?.tx_json ?? null };
    },
    onChange(fn) {
      const lost = () => fn("disconnect");
      provider.on("session_delete", lost);
      provider.on("session_expire", lost);
      return () => {
        provider.off("session_delete", lost);
        provider.off("session_expire", lost);
      };
    },
  };
}
