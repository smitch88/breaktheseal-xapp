import { Wallet, hashes } from "xrpl";
import type { Role, Signer } from "./types.ts";

/**
 * The only file in the app that holds a key or signs. Seeds come from the server environment, and each is checked against
 * the public address it should open, so a wrong or swapped seed stops the server instead of signing from the wrong wallet.
 */
export function createSigner(input: { treasurySeed: string; treasuryAddress: string; vaultSeed: string; vaultAddress: string; minterSeed?: string; minterAddress?: string }): Signer {
  const wallets: Partial<Record<Role, Wallet>> = { treasury: Wallet.fromSeed(input.treasurySeed), vault: Wallet.fromSeed(input.vaultSeed) };
  if (wallets.treasury?.classicAddress !== input.treasuryAddress) throw new Error("treasury seed doesn't match its address");
  if (wallets.vault?.classicAddress !== input.vaultAddress) throw new Error("vault seed doesn't match its address");
  if (input.treasuryAddress === input.vaultAddress) throw new Error("treasury and vault must be separate wallets");
  if (input.minterSeed) {
    wallets.minter = Wallet.fromSeed(input.minterSeed);
    if (wallets.minter.classicAddress !== input.minterAddress) throw new Error("minter seed doesn't match its address");
  }
  const wallet = (role: Role) => {
    const w = wallets[role];
    if (!w) throw new Error(`no ${role} wallet is configured`);
    return w;
  };
  return {
    address: (role) => wallet(role).classicAddress,
    sign(role, tx) {
      const signed = wallet(role).sign(tx as never);
      return { blob: signed.tx_blob, hash: signed.hash ?? hashes.hashSignedTx(signed.tx_blob) };
    },
  };
}
