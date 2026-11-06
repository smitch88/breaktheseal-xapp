/** Who runs this and how to reach them, for the terms and for the small line inside Xaman. */
export const OPERATOR = "Reddington Thomas Capital LLC";
export const SUPPORT_EMAIL = "gm@bearish.af";
export const SUPPORT_CHANNELS = [
  { href: `mailto:${SUPPORT_EMAIL}`, label: "Email support" },
  { href: "https://discord.gg/bearish", label: "Discord" },
  { href: "https://x.com/bearish_af", label: "X" },
] as const;

/** The three legal pages, as the footer and checkout link them. Small on purpose: checkout is a client bundle. */
export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/support", label: "Support" },
] as const;
