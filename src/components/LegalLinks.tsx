import Link from "next/link";
import { LEGAL_LINKS } from "@/lib/legal/links";

/** Terms, privacy and support, right by the buy button. */
export function LegalLinks() {
  return (
    <p className="fine">
      {LEGAL_LINKS.map((l, i) => (
        <span key={l.href}>
          {i ? " · " : ""}
          <Link href={l.href}>{l.label}</Link>
        </span>
      ))}
    </p>
  );
}
