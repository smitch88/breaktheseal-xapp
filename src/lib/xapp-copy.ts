/**
 * The words the xApp's first screen says. Pure, so tests read exactly what Xaman's reviewers will.
 */

const prizeList = ({ seal, cards }: { readonly seal: boolean; readonly cards: boolean }) => {
  const prizes = [...(cards ? ["a graded trading card"] : []), "an XRPL NFT", "XRP", ...(seal ? ["SEAL"] : [])];
  return prizes.length > 2 ? `${prizes.slice(0, -1).join(", ")} or ${prizes.at(-1)}` : prizes.join(" or ");
};

/** The first-launch info sheet's one plain line on what Break the Seal is. */
export const infoLine = (s: { readonly seal: boolean; readonly cards: boolean }): string => `Break the Seal sells packs for XRP. Each one holds one random prize: ${prizeList(s)}.`;

/** What a pack is and what you can do with its prize, in one line. Cards only while card packs are on, SEAL only while it's a prize. */
export function aboutLine({ seal, cards }: { readonly seal: boolean; readonly cards: boolean }): string {
  const list = prizeList({ seal, cards });
  const acts = ["Stash it", "sell it back", ...(cards ? ["ship a card to your door"] : []), "claim it to your wallet"];
  return `Pay in XRP from your Xaman account. Each pack holds one random prize: ${list}. ${acts.slice(0, -1).join(", ")}, or ${acts.at(-1)}.`;
}

/** Who makes this, and that XRPL Labs and Xaman don't: Xaman asks every xApp to say so. The same words on every page of the xApp and in the terms. */
export const independence = (operator: string): string => `Break the Seal is developed by ${operator}. It isn't affiliated with or endorsed by XRPL Labs or Xaman.`;

/** Who makes this, that Xaman doesn't, who holds the cards, and the risk. */
export function aboutFine({ cards, operator }: { readonly cards: boolean; readonly operator: string }): string {
  return `${independence(operator)}${cards ? " Cards are held and shipped by a third-party graded card vault." : ""} Prizes are random and can be worth less than you paid.`;
}

/** Whether the first-launch info sheet shows, from the server's read of Xaman's userstore. Anything but a clear "seen" shows it. */
export const infoNeeded = (answer: unknown): boolean => !(answer !== null && typeof answer === "object" && (answer as { show?: unknown }).show === false);
