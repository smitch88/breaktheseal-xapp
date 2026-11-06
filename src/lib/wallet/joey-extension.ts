import type { Joey } from "@joeywallet/wallet-sdk";
import { wrongNetworkText } from "./chain.ts";
import type { SignerTransport } from "./send.ts";

/** The part of Joey's extension client we use. Tests run a fake with the same shape; the browser gets the real one. */
export type JoeyExtension = Pick<Joey, "connect" | "disconnect" | "getAccounts" | "getNetwork" | "signIn" | "signAndSubmitTransaction" | "on">;

/** Loads Joey's SDK, which has no dependencies. Nothing reaches this until someone picks Joey. */
export async function detectExtension(timeoutMs = 1200): Promise<JoeyExtension | null> {
  const sdk = await import("@joeywallet/wallet-sdk");
  return sdk.waitForJoey({ timeoutMs }).catch(() => null);
}

export function extensionTransport(joey: JoeyExtension): SignerTransport {
  return {
    kind: "extension",
    accounts: async () => joey.getAccounts(),
    network: async () => (await joey.getNetwork()).chain,
    async signAndSubmit({ tx, account, chain }) {
      // Joey fills in the fee and sequence and adds nothing else. `chain` makes it refuse if the network changed since we looked.
      const r = await joey.signAndSubmitTransaction({ tx_json: tx as never, account, chain: chain as never });
      return { hash: r.hash, engineResult: r.engine_result, signed: r.tx_json };
    },
    onChange(fn) {
      const off = [joey.on("accountsChanged", () => fn("account")), joey.on("networkChanged", () => fn("network")), joey.on("disconnect", () => fn("disconnect"))];
      return () => off.forEach((f) => f());
    },
  };
}

export class WalletRefusal extends Error {}

export interface SignInApi {
  nonce(): Promise<{ nonce: string; statement: string; challenge: string; chain: string }>;
  verify(proof: unknown): Promise<{ address: string }>;
}

/**
 * Connect and prove the address, in one go from the player's press. A wallet on the wrong network is refused before it's asked
 * to sign anything.
 */
export async function extensionSignIn(joey: JoeyExtension, api: SignInApi): Promise<{ address: string }> {
  const { accounts } = await joey.connect({ name: "Break the Seal" });
  if (!accounts.length) throw new WalletRefusal("Joey didn't share an account.");
  const start = await api.nonce();
  const network = await joey.getNetwork();
  if (network.chain !== start.chain) throw new WalletRefusal(wrongNetworkText(network.chain, start.chain));
  const proof = await joey.signIn({ statement: start.statement, nonce: start.nonce });
  return api.verify(proof);
}

/**
 * Connect only, for someone already signed in whose wallet connection went away. Their account has to be among those shared. An
 * existing grant answers without a prompt, so a grant missing this account is dropped once, to let them pick it in Joey.
 */
export async function extensionReconnect(joey: JoeyExtension, address: string, chain: string): Promise<void> {
  let { accounts } = await joey.connect({ name: "Break the Seal" });
  if (!accounts.some((a) => a.address === address)) {
    await joey.disconnect();
    ({ accounts } = await joey.connect({ name: "Break the Seal" }));
  }
  if (!accounts.some((a) => a.address === address)) throw new WalletRefusal(`Joey didn't share the account you signed in with. Pick it in Joey and connect again, or sign out and sign in with that one. Nothing was signed.`);
  const network = await joey.getNetwork();
  if (network.chain !== chain) throw new WalletRefusal(wrongNetworkText(network.chain, chain));
}
