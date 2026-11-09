/** Who runs this and how to reach them, for the terms and for the small line inside Xaman. */
export const OPERATOR = "Reddington Thomas Capital LLC";
export const SUPPORT_EMAIL = "gm@bearish.af";
/** Where else to reach us, besides email. Web pages only: inside Xaman they open in the phone's browser. */
export const SUPPORT_CHANNELS = [
  { href: "https://discord.gg/bearish", label: "Discord" },
  { href: "https://x.com/sealonxrp", label: "X @sealonxrp" },
] as const;

/** The three legal pages, as the footer and checkout link them. Small on purpose: checkout is a client bundle. */
export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/support", label: "Support" },
] as const;
