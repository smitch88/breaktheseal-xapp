import Link from "next/link";
import { chipList } from "./chip-list.ts";

/** On Discover a chip goes straight to the filtered Packs page. */
export function CategoryChips({ cats }: { cats: readonly string[] }) {
  return (
    <div className="filters row" role="group" aria-label="Filter pack categories">
      {chipList(cats).map((c) => (
        <Link key={c} className="fchip" aria-current={c === "All" ? "true" : undefined} style={c === "All" ? { background: "#ffd91a14", borderColor: "#b79c12", color: "var(--y)" } : undefined} href={c === "All" ? "/packs" : `/packs?cat=${encodeURIComponent(c)}`}>
          {c}
        </Link>
      ))}
    </div>
  );
}
