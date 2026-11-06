/**
 * The little markup the legal copy uses: [words](/href) for a link, `text` for an address, [UPPER CASE] for a fact the owner
 * still has to fill in, and {{words}} for words only true on the website, which don't show inside Xaman. Everything else is plain text. Pure, so the pages and the review page read it the same way.
 */
export type InlinePart = { readonly kind: "text" | "code" | "placeholder" | "web"; readonly text: string } | { readonly kind: "link"; readonly text: string; readonly href: string };

const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\[([A-Z][A-Z0-9 ,'-]*)\]|\{\{([^}]+)\}\}/g;

export function inlineParts(source: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let at = 0;
  for (const m of source.matchAll(TOKEN)) {
    if (m.index > at) parts.push({ kind: "text", text: source.slice(at, m.index) });
    if (m[1] !== undefined) parts.push({ kind: "link", text: m[1], href: m[2] });
    else if (m[3] !== undefined) parts.push({ kind: "code", text: m[3] });
    else if (m[5] !== undefined) parts.push({ kind: "web", text: m[5] });
    else parts.push({ kind: "placeholder", text: `[${m[4]}]` });
    at = m.index + m[0].length;
  }
  if (at < source.length) parts.push({ kind: "text", text: source.slice(at) });
  return parts;
}

/** The words a reader sees: links lose their addresses and code loses its marks. */
export const plainText = (source: string) => inlineParts(source).map((p) => p.text).join("");

/** Glue the last two words of a block, so a wrapped line never ends in one lonely word. */
export function gluedParts(source: string): InlinePart[] {
  const parts = inlineParts(source);
  const last = parts.at(-1);
  if (last?.kind !== "text" && last?.kind !== "web") return parts;
  const body = last.text.trimEnd();
  const space = body.lastIndexOf(" ");
  if (space <= 0) return parts;
  return [...parts.slice(0, -1), { kind: last.kind, text: `${body.slice(0, space)} ${body.slice(space + 1)}` }];
}
