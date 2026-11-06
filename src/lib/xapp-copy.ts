/**
 * The words the xApp's first screen says, and whether to show that screen. Pure, so tests read exactly what Xaman's reviewers will.
 */

/** What a pack is and what you can do with its prize, in one line. Cards only while card packs are on, SEAL only while it's a prize. */
export function aboutLine({ seal, cards }: { readonly seal: boolean; readonly cards: boolean }): string {
  const prizes = [...(cards ? ["a graded trading card"] : []), "an XRPL NFT", "XRP", ...(seal ? ["SEAL"] : [])];
  const list = prizes.length > 2 ? `${prizes.slice(0, -1).join(", ")} or ${prizes.at(-1)}` : prizes.join(" or ");
  const acts = ["Stash it", "sell it back", ...(cards ? ["ship a card to your door"] : []), "claim it to your wallet"];
  return `Pay in XRP from your Xaman account. Each pack holds one random prize: ${list}. ${acts.slice(0, -1).join(", ")}, or ${acts.at(-1)}.`;
}

/** Who runs this, that Xaman doesn't, who holds the cards, and the risk. */
export function aboutFine({ cards, operator }: { readonly cards: boolean; readonly operator: string }): string {
  return `A third-party app by ${operator}, not made or endorsed by Xaman or XRPL Labs.${cards ? " Cards are held and shipped by a third-party graded card vault." : ""} Prizes are random and can be worth less than you paid.`;
}

/** The device remembers that this screen was read, and only then do later launches go straight to the packs. */
export const WELCOMED_KEY = "seal:xapp-welcomed";
export const welcomeNeeded = (stored: string | null | undefined) => stored !== "1";
