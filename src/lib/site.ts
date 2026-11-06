/** The name a person sees. Memo types, env vars, cookies and the package name keep their old spelling on purpose: see test/brand.test.ts. */
export const SITE_NAME = "Break the Seal";
/** The launch domain. */
export const OFFICIAL_DOMAIN = "breaktheseal.rip";
/** The SEAL community's own site: the "Powered by" link in the hero and the footer. */
export const SEAL_SITE = { name: "Seal on XRP", url: "https://sealonxrp.com" } as const;

type Env = Readonly<Record<string, string | undefined>>;

/** This site's own address: SEAL_PUBLIC_ORIGIN if set, the official domain on a production deploy, otherwise null. */
export function publicOrigin(env: Env): string | null {
  const set = env.SEAL_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
  if (set) return set;
  return env.VERCEL_ENV === "production" ? `https://${OFFICIAL_DOMAIN}` : null;
}

/** Card rails have their own switch. Until it's set, no page offers to ship or sell a card. */
export const cardRailsSet = (env: Env) => !!env.SEAL_CARD_RAILS?.trim();
