/**
 * What Xaman shows at the top of a sign request, under "Details". It says what this transaction does, why, and what it costs,
 * and it changes nothing about the transaction. Xaman's limit is 280 characters. Ship has its own, in ship.ts.
 */
const xrpOf = (drops: string) => String(Number(drops) / 1e6);
const onTest = (mode: string) => (mode === "testnet" ? " Testnet XRP only." : "");

export const payInstruction = (drops: string, kind: "nft" | "card", mode: string) => `Pay ${xrpOf(drops)} XRP to Break the Seal, a third-party app, for one ${kind === "nft" ? "NFT" : "card"} pack. One prize is drawn at random after this payment, and it can be worth less than you paid.${onTest(mode)}`;

/** The same for several packs on one payment. It says what's being paid for, in the words a wallet shows, within Xaman's limit. */
export const payManyInstruction = (drops: string, qty: number, kind: "nft" | "card", mode: string) => `Pay ${xrpOf(drops)} XRP to Break the Seal, a third-party app, for ${qty} ${kind === "nft" ? "NFT" : "card"} packs in one payment. One prize per pack is drawn at random after this payment, and each can be worth less than you paid.${onTest(mode)}`;

export const acceptInstruction = (kind: "nft" | "card", mode: string) => `Accept ${kind === "nft" ? "your NFT" : "your card's NFT"} from Break the Seal into this wallet. The offer is free. The network takes its small fee, and your wallet may hold 0.2 XRP in reserve while you own it.${mode === "testnet" ? " Testnet only." : ""}`;

export const trustInstruction = (token: string) => `Let your wallet hold ${token} so your Break the Seal prize can reach it. This sends nothing and holds 0.2 XRP in reserve.`;
