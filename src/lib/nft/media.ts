/** Public IPFS gateways, in the order to try them. One alone often says 429. */
export const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/", "https://nftstorage.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/"] as const;

const BARE_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,})(\/.*)?$/;

/** Every URL to try for a media reference on an NFT: ipfs://, a bare CID, a path through any IPFS gateway, ar:// or https://. Anything else has none. */
export function mediaUrls(ref: string): string[] {
  const value = ref.trim();
  const path = value.startsWith("ipfs://")
    ? value.slice(7).replace(/^ipfs\//, "")
    : BARE_CID.test(value)
      ? value
      : /^https:\/\/[^/]+\/ipfs\/(.+)$/.exec(value)?.[1] ?? null;
  if (path) {
    const clean = path.split("/").map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
    return IPFS_GATEWAYS.map((g) => g + clean);
  }
  if (value.startsWith("ar://")) return [`https://arweave.net/${value.slice(5)}`];
  return value.startsWith("https://") ? [value] : [];
}
