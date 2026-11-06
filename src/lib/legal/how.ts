/** The words on /how. They read true with rails off or on, and name card shipping and selling only while the card line is set. */
export interface HowCopy {
  readonly hero: string;
  readonly note: string;
  readonly pick: string;
  readonly thirdTitle: string;
  readonly third: string;
  readonly about: string;
  readonly terms: string;
  readonly privacy: string;
  readonly support: string;
}

export function howCopy(mode: "demo" | "testnet" | "mainnet", cards: boolean, sealOn = true): HowCopy {
  const demo = mode === "demo";
  const shelf = cards ? "Graded cards and XRPL NFTs" : "XRPL NFTs";
  // With SEAL prizes off (SEAL_TOKEN_PRIZES=off) every prize row pays XRP, so the copy doesn't promise any SEAL.
  const copy: HowCopy = {
    hero: demo
      ? `${shelf}. One pack, one bite. Every pull here is a demo, and no real money moves.`
      : mode === "testnet"
        ? `${shelf} on the XRPL testnet. One pack, one bite, paid in play XRP with no value.`
        : `${shelf}, paid in XRP. One pack, one bite, one prize: ${cards ? "a card, an NFT" : "an NFT"}, XRP or SEAL.`,
    note: demo
      ? "This is a preview. Packs, prices and rarity rates are real, but every pull is a demo: no real money moves, and what you pull is an example you don't own."
      : mode === "testnet"
        ? "This is a test run on the XRPL testnet. Payments use play XRP with no value, and prizes may be test stand-ins."
        : "Packs here are paid in real XRP. Rarity rates are real, and every pull can be checked on the ledger.",
    pick: cards ? "Card packs come from a third-party graded card vault, and NFT packs from our own pools of real XRPL NFTs, with XRP and SEAL prizes. Rarity rates are always shown." : "NFT packs draw from our own pools of real XRPL NFTs, with XRP and SEAL prizes. Most pulls pay a small XRP or SEAL prize. Rarity rates are always shown.",
    thirdTitle: cards ? "Stash, ship or sell" : "Stash, sell or claim",
    third: cards
      ? "Keep a prize in your stash, redeem XRP or SEAL, sell an NFT or SEAL prize back, or claim an NFT. Ship or sell a card too; a card's sale offer lasts about 72 hours. A stashed prize doesn't expire, but a sale price can move, and an NFT's sell-back ends once you claim it."
      : "Keep a prize in your stash, redeem XRP or SEAL to your wallet, sell an NFT or SEAL prize back, or claim an NFT. A stashed prize doesn't expire, but a SEAL sale price moves, and an NFT's sell-back ends once you claim it.",
    about: cards ? "Break the Seal is a BEARISH app for graded collectibles and XRPL NFTs, built in the look of SEAL on XRPL." : "Break the Seal is a BEARISH app for XRPL NFT packs, built in the look of SEAL on XRPL.",
    terms: demo ? "Demo pulls are free and sell nothing, so no purchase terms apply to them. Paid packs are sold under our terms." : "Paid packs are sold under our terms. Please read them before you buy.",
    privacy: demo ? "Demo pulls and your demo collection stay in your browser, and none of that is sent to us. Our privacy page covers paid packs." : "Our privacy page says what we collect when you use your wallet here and open a pack, and how long we keep it.",
    support: demo ? "A demo pull has nothing to refund. Our support page covers paid packs." : "For help with an order, a refund or a prize, go to our support page.",
  };
  if (sealOn) return copy;
  const xrpOnly = (t: string) => t.replace(/, XRP or SEAL\./, " or XRP.").replace(/XRP and SEAL prizes/g, "XRP prizes").replace(/XRP or SEAL/g, "XRP").replace(/an NFT or SEAL prize back/g, "an NFT back").replace(/a SEAL sale price moves, and an NFT's sell-back ends/, "an NFT's sell-back ends");
  return Object.fromEntries(Object.entries(copy).map(([k, v]) => [k, xrpOnly(v)])) as unknown as HowCopy;
}
