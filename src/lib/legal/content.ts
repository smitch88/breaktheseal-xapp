/**
 * The words on /terms, /privacy and /support, written from what the code does. test/legal.test.ts ties the numbers here to
 * the constants in the code, so a change in one fails until the other follows. Rarity rates are left to /rates on purpose:
 * one place to read them means nothing here can contradict them.
 *
 * Markup is in inline.ts. To fill in a fact, change it once in FACTS.
 */
import { sha256Hex } from "../rip/draw.ts";
import { placesInWords, restrictedPlaces } from "../rip/places.ts";
import { SEAL_ISSUER } from "../rip/tokens.ts";
import { OFFICIAL_DOMAIN, cardRailsSet } from "../site.ts";
import { independence } from "../xapp-copy.ts";
import { OPERATOR, SUPPORT_EMAIL } from "./links.ts";

export const FACTS = {
  entity: OPERATOR,
  address: "3301 Chetumal Street, Belize City, Belize",
  supportEmail: SUPPORT_EMAIL,
  privacyEmail: SUPPORT_EMAIL,
  domain: OFFICIAL_DOMAIN,
  socials: "x.com/sealonxrp and discord.gg/bearish",
  effective: "November 4, 2026",
  restricted: placesInWords(restrictedPlaces(process.env)),
  cap: "the greater of US$100 or what you paid us in the 12 months before the claim",
  shipCountries: "the United States and Canada",
  shipFees: "Any shipping fee or insurance is shown before you confirm.",
  mirrorFee: "2%",
  closureNotice: "30 days",
  supportHours: "business days, US Eastern time",
  addressRetention: "kept until the shipment and any problem with it are finished, and removed on request after that",
  supportRetention: "kept as long as we need them to help you and keep records of what happened",
  hostRegions: "the United States",
} as const;

const F = FACTS;
/** Said ahead of anything about cards while the card line is off, so the terms don't read as if cards were on sale. */
const CARDS_LATER = cardRailsSet(process.env) ? "" : "Card packs aren't on sale right now. If they open: ";

export type LegalBlock = string | { readonly items: readonly string[] } | { readonly note: string };
export interface LegalSection {
  readonly id: string;
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}
export interface LegalDocument {
  readonly path: "/terms" | "/privacy" | "/support";
  readonly title: string;
  readonly intro: readonly string[];
  readonly sections: readonly LegalSection[];
}

export const TERMS: LegalDocument = {
  path: "/terms",
  title: "Terms",
  intro: [
    `These terms cover your use of Break the Seal at ${F.domain} and inside the Xaman app. Break the Seal is run by ${F.entity}, called "we" here. By connecting a wallet or paying for a pack, you agree to them.`,
    independence(F.entity),
    `Effective ${F.effective}.`,
  ],
  sections: [
    {
      id: "who",
      heading: "Who can play",
      blocks: [
        {
          items: [
            "You must be 18 or older, and of legal age where you live if that age is higher.",
            `You can't use Break the Seal from ${F.restricted}, or from anywhere else that paid packs with random results, NFTs or crypto tokens aren't legal for you.`,
            "You can't use Break the Seal if you're on a government sanctions list or acting for someone who is.",
            "You must use a wallet you control, and act for yourself.",
          ],
        },
        "At checkout you confirm your age and accept these terms, and we keep which version you accepted and when, with your order. We refuse a new order when our web host reports your connection coming from a place listed above. That goes by network location, so it can be wrong or be missing, and we still open the order if it's missing. We don't check your age or identity, so following these rules is up to you. Being able to open the site doesn't mean it's legal where you are.",
      ],
    },
    {
      id: "packs",
      heading: "What a pack is",
      blocks: [
        "A pack is one paid pull. For one payment in XRP you get one prize chosen at random from that pack's pools. You don't choose the prize and no one can tell you what it will be. Most pulls pay a small XRP or SEAL prize, not an NFT.",
        {
          items: [
            "NFT packs are priced in whole XRP, and the price holds for a season. The dollar figure on a pack is a rough label. The XRP amount at checkout is what you pay. At launch the packs on sale are the $5 and $10 NFT packs.",
            "Card packs are sold only when their checkout shows a real XRP price with no demo label. The third-party card vault that supplies them sets their dollar price. We convert it to XRP at the rate on the ledger when you check out, with 0.5% added for the rate moving, or 1% added while we convert each pack's XRP to dollars as it sells, and your wallet shows the exact amount.",
            "A free try or a demo pull is only an example. No XRP moves and you don't own what it shows.",
          ],
        },
        "We charge no separate service fee at checkout. The XRP Ledger charges its own network fee, usually under 0.001 XRP, and that goes to the network.",
        "A prize can be worth far less than you paid, and you should expect most pulls to be worth less than the pack price. Open packs for the fun of it, and only spend what you can afford to lose.",
      ],
    },
    {
      id: "checkout",
      heading: "Checkout and payment",
      blocks: [
        {
          items: [
            "An order holds your place for about five minutes. Nothing is charged until your payment is on the ledger.",
            "Your wallet must pay the exact amount, from the wallet that opened the order, with the order's invoice ID, before the order ends. Your wallet's request fills all of this in for you.",
            "You can have up to 3 checkouts open at once for each kind of pack. If you let 3 lapse unpaid in about an hour, you'll need to wait before opening another.",
            "A payment counts only once it's in a validated ledger. A screen in your wallet saying it was sent isn't enough.",
          ],
        },
      ],
    },
    {
      id: "draw",
      heading: "How the draw works",
      blocks: [
        "This is how NFT packs and their XRP and SEAL prizes are drawn. [How the draw works](/fair) explains it in more detail and lets you check it yourself.",
        {
          items: [
            "Before a season sells, we put a commitment to a chain of secret seeds in a public memo on the XRP Ledger. It locks in the seeds without showing them.",
            "You pay. Your payment's place on the ledger gives you the season's next seed.",
            "We wait for the ledger that closes 3 ledgers after your payment. Its hash didn't exist when you signed.",
            "Your result comes from that seed, your payment's hash, that ledger's hash and your wallet address, together.",
            "That result picks a band at the pack's rarity rates. If the band has XRP or SEAL prizes, one more roll says whether this pull pays one. If not, it picks one NFT from everything in the band's pool, across collections. On a season that says so when it opens, a band with no NFTs left pays one of its own XRP or SEAL prizes instead, picked by one more roll at their published shares. On a season with each NFT at its own odds, one more roll picks an NFT by its own share of the band, which is shown on the pack's page, and pays the band's XRP or SEAL prizes for whatever share its NFTs don't take.",
          ],
        },
        "Restocks go on the ledger first and only reach pulls paid after that, so a pool can't be changed under a pull that's already paid.",
        "The check shows that a pull followed these rules. It doesn't show what a prize is worth. It also can't make us act on time: a delay would show in the record, but the ledger doesn't prevent one.",
        "Card packs are drawn by the third-party card vault on its own systems. Our record shows which card came back and proves we hold it, but not how it was chosen, so our check doesn't cover a card draw.",
      ],
    },
    {
      id: "record",
      heading: "The public record",
      blocks: [
        "We publish a running record of commitments, pool changes, orders, payments, pulls, sales, refunds and shipments. You can read and verify it on [How the draw works](/fair), or download it from [/api/rip/log](/api/rip/log). Each entry is chained by hash to the one before, so a later edit would show.",
        "The record names wallet addresses and what each one pulled. It leaves out what we paid for NFTs and our signed transaction bytes. [Privacy](/privacy#public) says more about what's public.",
      ],
    },
    {
      id: "rates",
      heading: "Rarity rates",
      blocks: [
        "The rates for each pack are on the [Rarity rates](/rates) page, and the share of a band paid in XRP or SEAL is on the pack's own page.",
        {
          items: [
            "An NFT pack's rates are set when its season opens and go in the public record. They stay the same for every pull in that season, however many packs have sold, so there's no deck to count.",
            "A new season can have different rates.",
            "If a band runs short, the pack pauses for a restock, unless its season says that band's XRP or SEAL prizes pay in its NFTs' place until then. Its rates don't change.",
            "Card pack rates come from the third-party card vault. We show them, but we don't set them and they can change.",
          ],
        },
        "A rate is a chance and not a promise of any result. Prizes in the same band can differ in value.",
      ],
    },
    {
      id: "prizes",
      heading: "Prizes",
      blocks: [
        {
          items: [
            "NFTs are real XRPL NFTs from other creators' collections, which we buy and put in the pools. An NFT gives you only what its own issuer offers, if anything. Some issuers can change an NFT's art or details.",
            "XRP prizes are a fixed amount of XRP.",
            "SEAL prizes are a fixed number of SEAL tokens, set at your pull from the XRP/SEAL pool on the ledger, using the higher of that ledger's price and the price about half an hour earlier, and rounded down. After that the number of tokens doesn't change, but what they're worth does.",
            "Cards are graded physical cards held in a third-party graded card vault. The listed value we show comes from the vault's data, which calls it insured value. It isn't an offer to buy, it isn't what a card would sell for, and it doesn't mean we insure the card.",
            "A mirror NFT is an NFT on the XRP Ledger that stands for one card while we hold that card. It's explained under [Claim and redeem](/terms#claim).",
          ],
        },
        "The marked value of an NFT is a number we set when it goes in a pool. It's the basis for its sell price, and it isn't a market price or a promise that anyone else would pay it.",
      ],
    },
    {
      id: "seal-token",
      heading: "SEAL token prizes",
      blocks: [
        `SEAL is a token on the XRP Ledger. Its issuer is \`${SEAL_ISSUER}\`. It's a separate thing from SEAL NFT collections, and other tokens use the same name, so always check the issuer.`,
        "A SEAL prize isn't an investment, a share, a deposit or a claim on us or on anyone else. We make no promise about its value, price, market or future use. It could lose all its value, and you might not be able to sell it.",
        "We hold SEAL to pay prizes, and we may add to or sell what we hold. People connected with us may hold it too. Nothing we say about SEAL is financial advice.",
      ],
    },
    {
      id: "stash",
      heading: "Stash",
      blocks: [
        "Every prize starts in your stash. Your stash is our record that a prize belongs to the wallet that bought it. NFTs, XRP and SEAL sit in public Break the Seal wallets you can look up on the ledger, and cards stay in a third-party graded card vault.",
        {
          items: [
            "Stashing is free and a stashed prize doesn't expire.",
            "A stash earns nothing. It isn't a bank account or a deposit, and it isn't insured.",
            "A stash belongs to the wallet that bought the prize. The site has no way to move it to another wallet, except that a mirror NFT carries its card with it.",
            "Stashed prizes sit in wallets and with services outside your control. A hack, a bug or a failure on our side or a third party's could affect them.",
          ],
        },
      ],
    },
    {
      id: "ship",
      heading: "Ship",
      blocks: [
        `${CARDS_LATER}You can ask us to ship a stashed card, and your wallet approves the address on the ledger before it moves. NFTs and tokens don't ship.`,
        {
          items: [
            `We ship to ${F.shipCountries}. ${F.shipFees}`,
            "If the card has a mirror NFT, the mirror is retired first. Whoever holds the mirror is the one who can ask.",
            "Shipping is arranged by a person from a queue, so we can't promise a delivery date. Tracking appears on the card's page once we have it.",
            "The site can't cancel a shipment or change an address after you've asked. Contact [Support](/support) right away if something is wrong.",
            "Once a card ships, it can't be sold back here and it leaves our custody. You're responsible for any customs duties or taxes.",
          ],
        },
      ],
    },
    {
      id: "sell",
      heading: "Sell",
      blocks: [
        `You can sell a stashed NFT or SEAL prize back to us for XRP${cardRailsSet(process.env) ? ", and a stashed card too" : ""}. We show the XRP price before you confirm. A sale can't be undone.`,
        {
          items: [
            "An NFT sells for 97% of its marked value, less our 2% sell fee. Once you claim it to your wallet, this sale ends.",
            "A SEAL prize sells for 85% of its live value on the XRP/SEAL pool, using the lower of the price now and the price about half an hour earlier.",
            "An XRP prize has no sale. You redeem it instead.",
            `${CARDS_LATER}A card sells for the card vault's own buyback quote, less our 2% sell fee, converted to XRP at the rate on the ledger. The vault limits how long it offers this, currently about 72 hours from the pull. After that you may not be offered a price, and the card can still be stashed or shipped.`,
            "A card with a mirror NFT is sold in this order: the mirror is retired, the card goes back to the card vault, then XRP is paid to the wallet that asked.",
          ],
        },
      ],
    },
    {
      id: "claim",
      heading: "Claim and redeem",
      blocks: [
        "These move a prize from your stash to your own wallet.",
        {
          items: [
            "Claim an NFT: we make a free offer that only your wallet can take, and you accept it in your wallet. You can take back an offer you haven't accepted. Accepting holds at most 0.2 XRP in your wallet's reserve and ends the instant sale.",
            "Redeem XRP: we send it straight to your wallet.",
            "A Common prize pays XRP, at the same value, if your wallet has no SEAL trust line, or one with too low a limit to hold the prize, when the pull is drawn. There's nothing to set up.",
            `Redeem SEAL: your wallet first needs a trust line for SEAL from the issuer \`${SEAL_ISSUER}\`. Setting one up sends nothing and holds 0.2 XRP in reserve. If you say no, the prize stays in your stash. Once the line is there, we send the fixed amount.`,
            `Claim a card as a mirror NFT: we check again that we hold the card, then make the NFT with a free offer for your wallet. Accepting holds at most 0.2 XRP in reserve. Mirrors can be resold for XRP, and a transfer fee of ${F.mirrorFee} set on the NFT goes to us on any paid resale. A free claim pays no fee.`,
          ],
        },
        "A mirror NFT works only through Break the Seal, and only while we hold the card. Whoever holds it can ship or sell the card, including someone who bought it from you, and a former holder can't. We can retire a mirror, and we do when its card is shipped or sold. A retired mirror no longer stands for anything.",
        "If your wallet can't take a prize, or a redemption doesn't land, it goes back to your stash. A redemption can also wait until we have enough on hand to pay it.",
      ],
    },
    {
      id: "pauses",
      heading: "Pauses",
      blocks: [
        "Packs and sales pause themselves instead of running on a bad price or short stock. A pack can pause when:",
        {
          items: [
            "a band is short of stock, or we can't cover the prizes for places already held",
            "XRP has moved too far from the price the season opened at, or its price can't be read",
            "the SEAL price is stale, thin, moving fast or can't be read",
          ],
        },
        "Selling and redeeming can pause too, if a price can't be trusted or our wallets are short right now. A pause doesn't touch your stash, and a pack you've already paid for is still drawn. We can also close or pause any pack, or end a season, at any time.",
      ],
    },
    {
      id: "refunds",
      heading: "No refunds, with these exceptions",
      blocks: [
        "Pack sales are final. You don't get a refund because you dislike a pull, because a price fell, or because you lost access to a wallet.",
        "XRP goes back, in full, to the wallet that paid, only in these cases:",
        {
          items: [
            "The payment wasn't the exact amount, came from a different wallet, landed after the order ended, was for an order already paid, or matched no order.",
            "A pull had no prize to land on, or, on a season with each NFT at its own odds, landed on an NFT someone had already pulled in a band with no XRP or SEAL prize to pay instead.",
            "A card pack couldn't be bought from the card vault, closed before it could open, or couldn't be opened in time.",
            "We looked into a paid card held for checking and decided to refund it. We can't do this once a mirror exists or a sale or shipment has started.",
          ],
        },
        "A prize you won isn't refunded. A SEAL prize whose price moved too far, couldn't be read for about ten minutes, or that we didn't hold enough SEAL for pays its value in XRP instead. If our wallet is short of XRP when you win, the prize is still yours: it's owed to you, and we send it as soon as we top up.",
        "These don't come back: a payment under 1 XRP that isn't the exact amount of an order, a payment in any token other than XRP, and your network fee.",
        "Refunds are sent on the ledger. One can wait if our wallet is short, and one the ledger rejects waits for a person. If you pay from an exchange, the refund goes to the exchange's wallet and may not reach you, so pay from your own wallet.",
      ],
    },
    {
      id: "finality",
      heading: "Blockchain finality",
      blocks: [
        "Transactions on the XRP Ledger are final once validated. No one can reverse them, including us. Check the amount and the destination before you sign. The ledger, its servers and Solana can slow down or stop, and when they do, draws, refunds and sales wait.",
      ],
    },
    {
      id: "wallet",
      heading: "Your wallet",
      blocks: [
        "You sign in with Xaman, or another wallet the site lists, and you approve every payment in that wallet. We never see your keys.",
        "Your wallet, its seed or secret numbers, its PIN and your device are your responsibility. If you lose them or someone else gets them, we can't get your wallet back, and we can't move your stash to a new one. Xaman and other wallets are separate products with their own terms.",
      ],
    },
    {
      id: "risk",
      heading: "Price risk",
      blocks: [
        "XRP, SEAL, NFTs and collectible cards can all lose value quickly, and some can't be resold at any price. Floors, marks, listed values and dollar figures on the site are estimates that can be stale or wrong. Nothing on the site is financial, legal or tax advice. You're responsible for any taxes on your packs, prizes and sales.",
      ],
    },
    {
      id: "third-parties",
      heading: "Third-party services and data",
      blocks: [
        "Break the Seal depends on services we don't run, and we aren't responsible for them:",
        {
          items: [
            "A third-party graded card vault, reached through its API, which holds the cards and answers for its packs and buybacks. It doesn't run or endorse Break the Seal.",
            "NFT marketplaces. You choose whether to use one after you claim an NFT, on its terms and with its fees. Collections can also charge a transfer fee on resale.",
            "Xaman and other wallets, the XRP Ledger, Solana, and the servers and explorers we link to. XRPL Labs, which makes Xaman, doesn't run, support or endorse Break the Seal, and can't help with an order.",
            "Relay (relay.link), which converts the XRP paid for a card pack into the dollars that buy the card. It works with our own wallets, never yours.",
            "xrpl.to, which supplies NFT floors and XRP price data shown on the site. [Data by xrpl.to](https://xrpl.to).",
          ],
        },
      ],
    },
    {
      id: "ip",
      heading: "Art and names",
      blocks: [
        "The Break the Seal site, its art and its logo belong to us or to their other owners. You may not copy them for your own products without permission.",
        "The names and art of NFT collections, card brands and grading companies belong to their owners. We show them to describe what's in a pack and what you pulled. That doesn't mean those owners sponsor or approve of Break the Seal.",
        "Owning an NFT or a card gives you that item. It doesn't give you the copyright or trademarks in it, except for any rights its creator grants.",
      ],
    },
    {
      id: "conduct",
      heading: "Using the site fairly",
      blocks: [
        "Don't attack the site, get around a limit or a pause, use bots to hold places on packs, or take advantage of a bug. Don't use Break the Seal to launder money or for anything illegal. We can refuse orders from a wallet that does.",
      ],
    },
    {
      id: "closing",
      heading: "If we change or close the service",
      blocks: [
        `We can change or stop any part of Break the Seal. If we close it, we'll post notice on the site at least ${F.closureNotice} ahead, so you can claim, redeem, ship or sell what's in your stash.`,
      ],
    },
    {
      id: "liability",
      heading: "Limits of liability",
      blocks: [
        "Break the Seal is provided as is and as available. To the extent the law allows, we make no promises beyond what these terms say, including that the site will always work or that a prize will hold any value.",
        `To the extent the law allows, we aren't liable for indirect or consequential losses, lost profits, or losses from price moves, ledger or third-party failures, or a lost or compromised wallet. Our total liability to you is limited to ${F.cap}. Some places don't allow these limits, so they may not all apply to you, and nothing here removes rights the law says can't be removed.`,
      ],
    },
    {
      id: "disputes",
      heading: "Disputes",
      blocks: [
        `Please contact [Support](/support) first, with your order ID, so we can try to fix it.`,
      ],
    },
    {
      id: "changes",
      heading: "Changes to these terms",
      blocks: [
        "We can change these terms by posting a new version here with a new effective date. A change doesn't reach back to a pack you've already paid for. If you keep using Break the Seal after a change, the new terms apply.",
      ],
    },
    {
      id: "contact",
      heading: "Contact",
      blocks: [`${F.entity}, ${F.address}. ${F.supportEmail}. ${independence(F.entity)}`],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  path: "/privacy",
  title: "Privacy",
  intro: [
    `This page says what ${F.entity} collects when you use Break the Seal, who it goes to, and how long it stays. Break the Seal works from your wallet, and most of what it records is public by design.`,
    `Effective ${F.effective}.`,
  ],
  sections: [
    {
      id: "collect",
      heading: "What we collect",
      blocks: [
        {
          items: [
            "Your wallet address, when you sign in, open an order or pay.",
            "Your wallet type, such as Xaman or Joey, and a one-time sign-in ID that proves a sign-in wasn't replayed.",
            "If you sign in with Xaman, a token from Xaman that lets a request you start appear in your Xaman app by itself. We keep it privately and send it only to Xaman.",
            "Orders and pulls: pack, amount, transaction hashes, ledger numbers, times, what you pulled, and whether you stashed, sold, claimed, redeemed or shipped it.",
            "Shipping details, only if you ship a card: full name, street, city, ZIP, state or region and country if given, and the tracking number once there is one.",
            "Your internet address, for rate limits. Our app holds it only in a server's memory and doesn't save it. Our web host also keeps its own request logs.",
            "The country and region our web host works out from your internet address, when you open an order, to refuse restricted places. We use it for that decision and don't save it with your order. Our server logs record a refused country, or that none was given, without your wallet or address.",
            "That you accepted the terms: which version, when, and from which wallet, kept privately against your order.",
            "Anything you send to support.",
          ],
        },
      ],
    },
    {
      id: "not-collected",
      heading: "What we don't collect",
      blocks: [
        {
          items: [
            "Your seed, secret numbers, private keys or PIN. If anyone asks for these, it's a scam.",
            "A password or account profile. Your wallet is your sign-in.",
            "ID documents. We don't run identity checks.",
            "Email or phone number, unless you write to us from them.",
          ],
        },
        "The site runs no analytics or advertising trackers, and we don't sell your information.",
      ],
    },
    {
      id: "public",
      heading: "What's public",
      blocks: [
        "Two things can be read by anyone, forever:",
        {
          items: [
            "The XRP Ledger. Your payments, NFT transfers, trust lines and wallet balances are on it, whether or not you use Break the Seal.",
            "Our public record, at [How the draw works](/fair) and [/api/rip/log](/api/rip/log). It names your wallet address next to each order, payment, pull, sale, claim, refund and shipment, with times.",
          ],
        },
        "Anyone can download a copy of the record, so copies can outlast the site. A wallet address isn't a name, but if anyone links yours to you, all of this is linked too.",
        "When a card ships, the tracking number goes in the public record. Your name and address don't. Only a scrambled, salted fingerprint of the address goes in, which can't be turned back into the address.",
      ],
    },
    {
      id: "browser",
      heading: "Cookies and browser storage",
      blocks: [
        {
          items: [
            "`seal_session` keeps you signed in for 2 hours. It holds your wallet address and wallet type, is signed by us, and scripts on the page can't read it.",
            "`seal_challenge` lasts about 6 minutes while a sign-in is happening.",
            "`seal-rips-demo-v1` in your browser's local storage holds your demo pulls and the address you last connected. It stays on your device until you clear it. Inside the Xaman app it's kept in session storage instead, and goes when the app closes.",
            "`seal.joey.via` and `seal.wallet.sent` in your browser's storage remember how you connected Joey and what you were last asked to sign, so a reload doesn't ask twice. If you use Joey's phone app, WalletConnect keeps its session data there too. All of this stays on your device.",
            "`seal_xapp` is a cookie set only if you open Break the Seal inside the Xaman app. It holds the account Xaman opened it on and the token Xaman issues for that visit, is signed by us, scripts on the page can't read it, and it lasts at most 24 hours. `seal:xapp` and `seal:xstyle` in session storage remember that the tab is inside Xaman and which of Xaman's color styles it uses, and go when the app closes. Inside Xaman nothing else about you is kept on your phone: that you've read the About sheet is kept in Xaman's own storage for this app, under your Xaman account.",
          ],
        },
        "We use no other cookies. Signing out removes the session cookie.",
      ],
    },
    {
      id: "sharing",
      heading: "Who it goes to",
      blocks: [
        {
          items: [
            "Xaman, when you use it: each transaction you're asked to sign, which names your wallet, along with your order ID. Its QR codes and status updates load from Xaman directly, so it also sees your internet address. Inside the Xaman app, Xaman also keeps, for us, whether you've read the About sheet.",
            "Joey, when you use it: each transaction you're asked to sign, which names your wallet, along with your order ID. If you use Joey's phone app, those requests also pass through WalletConnect, which sees your internet address.",
            "The XRPL servers we read from, which see the wallet addresses we look up.",
            "The service providers that host the site and store its data. They process this data for us.",
            "Whoever handles a shipment, which can include the card vault and the carrier, who get the name and address on it.",
            "Break the Seal operators, who can see the shipping queue and addresses on our admin page.",
            "Authorities or others, if the law requires it or to protect people or the service.",
          ],
        },
        "The card vault doesn't get your wallet address when you open a card pack. We buy from it with our own wallet. Clicking a link to a ledger explorer or to xrpl.to takes you to their site, under their privacy terms.",
      ],
    },
    {
      id: "retention",
      heading: "How long we keep it",
      blocks: [
        {
          items: [
            "The public record: for as long as Break the Seal runs. It's built so that entries aren't removed.",
            "The XRP Ledger: permanently, and out of our hands.",
            `Shipping details: ${F.addressRetention}. Nothing deletes them automatically today, so removal is done by hand.`,
            "One-time sign-in IDs: about 7 minutes, then removed at a later sign-in.",
            "Your Xaman token: until you sign out or your next Xaman sign-in replaces it. Xaman ends it 30 days after your last signature, and you can revoke it in Xaman's settings.",
            "Rate-limit entries: only until that server process restarts or clears them.",
            "Terms acceptance: for as long as Break the Seal runs, so we can show what you agreed to.",
            `Support messages: ${F.supportRetention}.`,
            "Our host's request logs: as long as its service keeps them.",
          ],
        },
      ],
    },
    {
      id: "rights",
      heading: "Your choices, and what can't be deleted",
      blocks: [
        `You can write to ${F.privacyEmail} to ask what we hold about your wallet, or to correct or delete it. Your state or country may give you more rights. We'll need you to show the wallet is yours, and we'll never ask for your seed to do that.`,
        "What we can do: remove your shipping details once a card has been delivered or the request has ended, unless we need them to meet a legal duty or settle a dispute, and delete your support messages.",
        "What we can't do: remove anything from the XRP Ledger, which no one can change, or remove your wallet address, pulls or tracking number from the public record. Each entry is chained to the next, so removing one would break every player's ability to check the draw.",
        "You can clear the demo data with your browser's settings, and stop using the site at any time. If you don't want a tracking number tied to your wallet in public, don't ask us to ship a card.",
      ],
    },
    {
      id: "security",
      heading: "Keeping it safe",
      blocks: [
        "Shipping details are kept private, apart from the public record, where only our operators and the service provider that stores them can reach them. No system is fully safe, and we can't promise your information will never be exposed. You keep your own keys, so a breach on our side can't reveal them.",
      ],
    },
    {
      id: "where",
      heading: "Where it's processed",
      blocks: [`Our services run in ${F.hostRegions}, and the XRP Ledger's servers are spread around the world. Using Break the Seal means your information may leave your country.`],
    },
    {
      id: "age",
      heading: "Age",
      blocks: ["Break the Seal isn't for anyone under 18, and we don't knowingly collect their information. If you think someone under 18 has given us shipping details, tell us and we'll remove them."],
    },
    {
      id: "changes",
      heading: "Changes and contact",
      blocks: [`We'll post any change here with a new effective date. Questions go to ${F.privacyEmail}, or ${F.entity}, ${F.address}.`],
    },
  ],
};

export const SUPPORT: LegalDocument = {
  path: "/support",
  title: "Support",
  intro: [`Email ${F.supportEmail}. We answer during ${F.supportHours}. Your stash stays where it is while you wait.`, `${independence(F.entity)} Xaman's own support can't help with an order here, so write to us.`],
  sections: [
    {
      id: "include",
      heading: "What to include",
      blocks: [
        {
          items: [
            "Your order ID. It's the end of the pull's page address, after /collection/ or /open/, and starts with rip_ or card_.",
            "Your wallet address, the public one that starts with r.",
            "The transaction hash, if you paid. Find it in your wallet's history, or under Your payment on the pull's page.",
            "The pack, the time, and what you saw on screen. A screenshot helps.",
          ],
        },
        { note: "Never send a seed, secret numbers, a private key or a PIN, and never send a photo of them. No one needs them to help you." },
      ],
    },
    {
      id: "paid-nothing",
      heading: "I paid and nothing happened",
      blocks: [
        "Don't pay again. A second payment only comes back later as a refund.",
        {
          items: [
            "Wait a minute. A pull is fixed about 3 ledgers after your payment, which is usually seconds, but a slow ledger or a busy server can take longer. Pulls keep moving even if you close the page.",
            "Open [your collection](/collection). {{If you're signed out, connect the same wallet again.}}",
            "Look up the transaction in your wallet. If it failed or never landed, nothing was charged.",
            "If the payment landed but was the wrong amount, from another wallet, after the order ended, or for an order already paid, the XRP goes back to the wallet that paid. The order page says which.",
            "Still nothing after a few minutes? Write to us with your order ID and transaction hash.",
          ],
        },
        "A payment under 1 XRP that isn't the exact amount of an order, or a payment in any token other than XRP, doesn't come back. [The terms](/terms#refunds) list every refund case.",
      ],
    },
    {
      id: "declined",
      heading: "I declined the signature, or the checkout ended",
      blocks: [
        "Nothing was charged. An order ends by itself after about five minutes if it isn't paid, and you can start again. If you let 3 lapse in about an hour, the site asks you to wait. If it says the wallet doesn't hold enough XRP, remember that your wallet's reserve can't be spent.",
      ],
    },
    {
      id: "trust-line",
      heading: "My SEAL prize needs a trust line",
      blocks: [
        "Your wallet can't hold SEAL until it trusts the issuer. Tap Redeem to wallet and we'll ask your wallet to set up the line. It sends nothing and holds 0.2 XRP in reserve. Then tap Redeem to wallet again, or I signed it, send my prize.",
        `Check the issuer before you sign: \`${SEAL_ISSUER}\`. Other tokens use the name SEAL. If you say no, the prize stays in your stash and its amount doesn't change. You can also sell it for XRP, which needs no trust line.`,
      ],
    },
    {
      id: "paused",
      heading: "A pack or prize is paused",
      blocks: [
        {
          items: [
            "Restocking. Check back soon. The pack can't be bought for now and nothing was charged. You can still look through its prizes and odds, and it reopens by itself.",
            "Selling is paused, or redeeming is paused. Your prize is safe in your stash, so try again later.",
          ],
        },
        "If a pull's SEAL price moved too far after you paid, that prize pays its value in XRP instead. If a prize shows as owed to you, our wallet was short when you won. It's still yours, and we send it as soon as we top up, with nothing for you to do. We can't lift a pause by hand for one player.",
      ],
    },
    {
      id: "claim",
      heading: "My NFT claim or card is stuck",
      blocks: [
        {
          items: [
            "Waiting for you to accept means a free offer is open. Tap Accept in wallet, which needs at most 0.2 XRP free for your wallet's reserve, or take the offer back and keep the prize in your stash. You never have to accept it.",
            "We're checking on this one means a person needs to look at a card. It stays in your collection. Don't pay again, and write to us with the order ID.",
            "Sell shows no price for a card if the card vault isn't offering a buyback right now, which usually means about 72 hours have passed since the pull. You can still stash or ship it.",
          ],
        },
      ],
    },
    {
      id: "shipping",
      heading: "Shipping",
      blocks: [
        "A person ships cards from a queue, so it can take a while. Shipping means we have your request. Tracking appears on the card's page as soon as we have it.",
        "Wrote the wrong address? Tell us right away with the order ID. The site can't change it, and we can only help before the card goes out. For a card that's lost or damaged in the mail, send the order ID, the tracking number and photos.",
      ],
    },
    {
      id: "wallet",
      heading: "Sign-in and lost wallets",
      blocks: [
        "{{A sign-in lasts 2 hours, so you may just need to connect again. A sign-in request moves no funds.}}",
        "If you've lost your wallet, restore it from your own backup. We can't recover it or move your stash to another wallet.",
      ],
    },
    {
      id: "scams",
      heading: "Watch out for scams",
      blocks: [
        {
          note: `Our only places are ${F.domain}, ${F.supportEmail} and ${F.socials}. We don't message you first. Anyone offering to fix a problem, unlock a prize or speed up a refund in a direct message is trying to rob you.`,
        },
        "Your wallet will only ever be asked to sign these for Break the Seal, and only after you tapped something on our site:",
        {
          items: [
            "A sign-in, which moves no funds.",
            "One payment of the exact pack price in XRP, to Break the Seal.",
            "Accepting a free NFT offer, with nothing to pay but the network fee.",
            `A trust line for SEAL, from the issuer \`${SEAL_ISSUER}\`.`,
          ],
        },
        "If your wallet shows anything else, decline it.",
      ],
    },
    {
      id: "never",
      heading: "What support will never ask for",
      blocks: [
        {
          items: [
            "Your seed, secret numbers, private key, PIN or a photo of them.",
            "A payment to verify your wallet, unlock a prize, release a refund or cover a fee.",
            "A signature on a transaction you didn't start.",
            "Control of your screen, or an app or a browser extension to install.",
          ],
        },
      ],
    },
    {
      id: "limits",
      heading: "What support can't do",
      blocks: [
        "We can look into an order, send a stuck refund again, settle a card held for checking and post tracking. We can't reverse a ledger transaction, change a pull, move a stash to another wallet, or promise what a prize is worth.",
      ],
    },
  ],
};

/** Added to What a pack is while multi-pack orders are on. With the switch off, the terms stay exactly as they were, and so does their version. */
export const MULTI_TERMS_BLOCK = "When a checkout offers more than one pack, you can buy several in one order. That's one payment in XRP for the exact total, and that checkout stays open for about three minutes. Each pack in it is still its own pull at the same rates, with its own prize and its own record. If we can't deliver one, that pack's price goes back to your wallet, whole, and the rest stand. A payment that isn't the exact total goes back whole, and nothing is drawn. If you sell or send several prizes together, they go in one payment: it all lands or none of it does, and anything that doesn't stays in your stash.";

export const TERMS_WITH_MULTI: LegalDocument = {
  ...TERMS,
  sections: TERMS.sections.map((s) => (s.id === "packs" ? { ...s, blocks: [s.blocks[0], MULTI_TERMS_BLOCK, ...s.blocks.slice(1)] } : s)),
};

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [TERMS, PRIVACY, SUPPORT];

/** Which terms an order was opened under: a fingerprint of the words themselves, so any change to them is a new version. */
export const TERMS_VERSION = sha256Hex(JSON.stringify(TERMS)).slice(0, 16);
/** The version a multi-pack order is opened under. */
export const TERMS_MULTI_VERSION = sha256Hex(JSON.stringify(TERMS_WITH_MULTI)).slice(0, 16);
