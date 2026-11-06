/**
 * Reads the fixed fields inside an NFTokenID. Layout, from the XRPL docs: Flags (2 bytes), TransferFee (2), Issuer (20),
 * scrambled Taxon (4), Sequence (4). Flags: 1 burnable by the issuer, 2 only XRP, 8 transferable.
 */
export const FLAG_BURNABLE = 0x0001;
export const FLAG_ONLY_XRP = 0x0002;
export const FLAG_TRANSFERABLE = 0x0008;
/** XLS-46: its issuer can change what its URI points at, so the art we saw isn't the art it keeps. */
export const FLAG_MUTABLE = 0x0010;

export function nftIdFlags(nftId: string): { flags: number; transferFee: number } {
  if (!/^[0-9A-Fa-f]{64}$/.test(nftId)) throw new Error("not an NFTokenID");
  return { flags: parseInt(nftId.slice(0, 4), 16), transferFee: parseInt(nftId.slice(4, 8), 16) };
}

/** Owner, 2026-11-01: SEAL #449 stays his. This exact token never enters a pool, whoever holds it. */
export const NEVER_POOL: readonly string[] = ["001813881F9C83FE46F4EEC59D5E8C0B017F1791F856B88291FB9B56061115BC"];

/** The issuer's account id and the taxon. The ledger scrambles the taxon with the NFT's sequence, so this undoes that. */
export function nftIdCollection(nftId: string): { issuerHex: string; taxon: number } {
  if (!/^[0-9A-Fa-f]{64}$/.test(nftId)) throw new Error("not an NFTokenID");
  const sequence = parseInt(nftId.slice(56, 64), 16);
  return { issuerHex: nftId.slice(8, 48).toUpperCase(), taxon: (parseInt(nftId.slice(48, 56), 16) ^ (Math.imul(384160001, sequence) + 2459)) >>> 0 };
}

/** This exact NFT is never registered, drawn or bought. */
export const isNeverPool = (nftId: string): boolean => NEVER_POOL.includes(nftId.toUpperCase());

/** Why this NFT can't go in a pool, or null. A non-transferable NFT can't reach a player. A burnable one can be destroyed in our vault by its issuer. */
export function poolRefusal(nftId: string, opts: { allowBurnable?: boolean } = {}): string | null {
  if (NEVER_POOL.includes(nftId.toUpperCase())) return "the owner keeps this one";
  const { flags } = nftIdFlags(nftId);
  if (!(flags & FLAG_TRANSFERABLE)) return "not transferable";
  if (flags & FLAG_BURNABLE && !opts.allowBurnable) return "its issuer can burn it";
  return null;
}
