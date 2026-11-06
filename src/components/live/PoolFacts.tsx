"use client";

import { NFT_TIERS } from "@/lib/nft/bands";
import { NFT_LADDERS, type NftPrice } from "@/config/nft-packs";
import { useRipConfig } from "@/lib/live/hooks";
import { noOrphan } from "@/lib/format";
import { useRails } from "../Providers.tsx";
import { RatesGrid } from "../ui.tsx";

/** With real rails on, how much is in this pack's pool now. It says nothing about what comes next: rates never change. */
export function PoolFacts({ price }: { price: number }) {
  const { mode } = useRails();
  const live = mode !== "demo";
  const config = useRipConfig(live, 20000);
  if (!live) return null;
  const tier = config?.tiers.find((t) => t.price === price);
  return (
    <div>
      <dt>NFTs in the pool</dt>
      <dd>{tier ? noOrphan(`${tier.nfts} across ${tier.collections} ${tier.collections === 1 ? "collection" : "collections"}`) : "…"}</dd>
    </div>
  );
}

/** With real rails on, what this season's pulls can pay: from the season on the ledger, not the plan. */
export function LiveInPack({ price }: { price: number }) {
  const config = useRipConfig(true, 20000);
  const tier = config?.tiers.find((t) => t.price === price);
  const tokens = tier?.prizeTokens ?? [];
  const words = tokens.includes("SEAL") ? "XRP, SEAL or an XRPL NFT" : tokens.includes("XRP") ? "XRP or an XRPL NFT" : "An XRPL NFT";
  return (
    <div>
      <dt>In the pack</dt>
      <dd>{tier ? `One prize: ${words}` : "…"}</dd>
    </div>
  );
}

/** One pack's rates on /rates: what its live season committed to on the ledger, or the ladder's until one is open. */
export function PackRates({ price }: { price: NftPrice }) {
  const { mode } = useRails();
  const config = useRipConfig(mode !== "demo", 60000);
  const b = config?.tiers.find((t) => t.price === price)?.bandBps ?? NFT_LADDERS[price].bandBps;
  return <>{NFT_TIERS.map((tier, i) => `${tier} ${b[i] / 100}%`).join(" · ")}</>;
}

/** Rarity rates. Every pull rolls these on its own, so they read the same however many packs have been opened. */
export function NftRates({ price }: { price: NftPrice }) {
  const rows = [4, 3, 2, 1, 0].map((i) => ({ tier: NFT_TIERS[i], rate: NFT_LADDERS[price].bandBps[i] / 100 }));
  return <RatesGrid rows={rows} />;
}
