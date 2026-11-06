/**
 * Where packs can't be bought. A server-side refusal on the routes that open an order, from the location our host reports for
 * the connection. It goes by network location, so a VPN gets past it and a wrong reading can refuse someone: it's a floor, not
 * proof of where anyone is. A request with no location is allowed and logged.
 *
 * SEAL_RESTRICTED_PLACES replaces the default list: comma-separated ISO 3166 country codes (CU), or country and region (UA-43).
 * Default: comprehensively sanctioned places only, a starting point for the owner to extend.
 */
type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_RESTRICTED_PLACES: readonly string[] = ["CU", "IR", "KP", "SY", "UA-43", "UA-40", "UA-14", "UA-09"];

/** Region names for the codes the default list uses. Any other region shows its code. */
const REGION_NAMES: Readonly<Record<string, string>> = { "UA-43": "Crimea", "UA-40": "Sevastopol", "UA-14": "Donetsk", "UA-09": "Luhansk" };
const CODE = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/;

/** The configured list. Anything that isn't a code is dropped, and a list with nothing usable falls back to the default, so a typo can't open the gate. */
export function restrictedPlaces(env: Env): readonly string[] {
  const set = (env.SEAL_RESTRICTED_PLACES ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => CODE.test(s));
  return set.length ? [...new Set(set)] : DEFAULT_RESTRICTED_PLACES;
}

const countryName = (code: string) => new Intl.DisplayNames(["en-US"], { type: "region" }).of(code) ?? code;

const listed = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The list in plain words, for the terms. */
export function placesInWords(places: readonly string[]): string {
  const countries = places.filter((p) => !p.includes("-")).map(countryName);
  const byCountry = new Map<string, string[]>();
  for (const p of places.filter((x) => x.includes("-"))) byCountry.set(p.slice(0, 2), [...(byCountry.get(p.slice(0, 2)) ?? []), REGION_NAMES[p] ?? p]);
  const regions = [...byCountry].map(([c, names]) => `the ${listed(names)} ${names.length > 1 ? "regions" : "region"} of ${countryName(c)}`);
  return listed([...countries, ...regions]);
}

export type PlaceCheck = { readonly ok: true; readonly known: boolean } | { readonly ok: false; readonly place: string };

/** The decision, from Vercel's location headers. Our host sets these itself and overwrites whatever a client sends. */
export function checkPlace(headers: { get(name: string): string | null }, places: readonly string[]): PlaceCheck {
  const country = headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!country) return { ok: true, known: false };
  if (places.includes(country)) return { ok: false, place: country };
  const region = headers.get("x-vercel-ip-country-region")?.trim().toUpperCase();
  if (region && places.includes(`${country}-${region}`)) return { ok: false, place: `${country}-${region}` };
  return { ok: true, known: true };
}

export const PLACE_REFUSAL = "Break the Seal isn't available where you are. Nothing was charged.";
