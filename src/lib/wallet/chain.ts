/** The XRPL chain ids Joey speaks, and which one this site runs on. A demo site signs nothing, so it just asks for mainnet. */
export type WalletChain = "xrpl:0" | "xrpl:1" | "xrpl:2";

export const chainForMode = (mode: string): WalletChain => (mode === "testnet" ? "xrpl:1" : "xrpl:0");

const NAMES: Readonly<Record<string, string>> = { "xrpl:0": "Mainnet", "xrpl:1": "Testnet", "xrpl:2": "Devnet" };
export const chainName = (chain: string | null | undefined) => (chain && NAMES[chain]) || "another network";

export const wrongNetworkText = (found: string | null | undefined, wanted: string) => `Joey is on ${chainName(found)}. This site runs on ${chainName(wanted)}. Switch networks in Joey, then try again. Nothing was signed.`;
