"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { shellBack } from "@/lib/again";
import { useDemo } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { LEGAL_LINKS, OPERATOR, SUPPORT_CHANNELS } from "@/lib/legal/links";
import { aboutFine, aboutLine } from "@/lib/xapp-copy";
import { usePendingCount } from "@/lib/live/hooks";
import { useRails } from "./Providers.tsx";
import { useXapp } from "./XappHost.tsx";

const icon = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const HELP = ["/support", "/terms", "/privacy", "/how", "/rates", "/fair"];
const TABS = [
  { href: "/packs", label: "Packs", match: (p: string) => p === "/packs" || p.startsWith("/nft") || p.startsWith("/packs/") || p.startsWith("/checkout"), art: icon(<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.3 7 12 12l8.7-5M12 22V12" /></>) },
  { href: "/collection", label: "Stash", match: (p: string) => p.startsWith("/collection") || p.startsWith("/sell") || p.startsWith("/ship") || p.startsWith("/profile"), art: icon(<><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" /></>) },
  { href: "/support", label: "Help", match: (p: string) => HELP.some((h) => p.startsWith(h)), art: icon(<><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></>) },
] as const;
const ROOTS: readonly string[] = TABS.map((t) => t.href);

/** The app's own header and tabs inside Xaman, in place of the site's. The site's are hidden by CSS before first paint, so neither flashes. */
export function XappShell() {
  const { shell } = useXapp();
  const path = usePathname() ?? "/";
  const router = useRouter();
  const demo = useDemo();
  const { mode } = useRails();
  const pending = usePendingCount(shell && mode !== "demo" && demo.signed && demo.wallet !== "demo", path);

  useEffect(() => {
    if (shell && path === "/") router.replace("/packs");
  }, [shell, path, router]);

  if (!shell) return null;
  // Xaman's own bar already names the app, so the main tabs start with their content. Deeper pages get a way back. A pack page reached by
  // Open another goes back to the shelf, not into the sale before it.
  return (
    <>
      {ROOTS.includes(path) ? null : (
        <header className="xhead">
          <button type="button" className="xback" onClick={() => (shellBack(window.location.search) === "packs" || window.history.length <= 1 ? router.push("/packs") : router.back())}>
            {icon(<path d="m15 18-6-6 6-6" />)} Back
          </button>
        </header>
      )}
      <nav className="xtabs" aria-label="Main navigation">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className={t.match(path) ? "on" : ""} aria-current={t.match(path) ? "page" : undefined} aria-label={t.label === "Stash" && pending ? `Stash, ${pending} waiting for you to accept` : t.label}>
            {t.art}
            <span>{t.label}</span>
            {t.label === "Stash" && pending ? <b className="count">{pending}</b> : null}
          </Link>
        ))}
      </nav>
    </>
  );
}

/** What this is, who runs it, and that it isn't Xaman's own. The first thing anyone reads inside Xaman. */
export function XappAbout({ seal, cards }: { seal: boolean; cards: boolean }) {
  return (
    <section className="xabout">
      <h2>Open a pack, get one prize</h2>
      <p>{noOrphan(aboutLine({ seal, cards }))}</p>
      <p className="fine">{noOrphan(aboutFine({ cards, operator: OPERATOR }))}</p>
    </section>
  );
}

/** The small line under every page: who runs this, the risk, and the three links Xaman asks for. */
export function XappFoot() {
  if (!useXapp().shell) return null;
  return (
    <footer className="xfoot">
      <p className="xlegal">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
      </p>
      <p className="fine">
        {noOrphan(`Third-party app by ${OPERATOR}. 18+. Pack results are random, so only spend what you can afford to lose.`)} XRP price:{" "}
        <a href="https://xrpl.to" target="_blank" rel="noopener">
          Data by xrpl.to
        </a>
        .
      </p>
    </footer>
  );
}

/** The Help tab's other pages: how it all works, the odds, and the proof. The site has them in its footer, which Xaman doesn't show. */
const HELP_TOPICS = [
  { href: "/how", label: "How packs work" },
  { href: "/rates", label: "Rarity rates" },
  { href: "/fair", label: "How the draw works" },
] as const;

/** Tap-to-reach support, inside Xaman, on top of the support page, and the way to every other help page. */
export function XappSupport() {
  if (!useXapp().shell) return null;
  return (
    <section className="xabout">
      <p>{noOrphan(`Break the Seal is a third-party app run by ${OPERATOR}. Xaman and XRPL Labs can't help with your order, so contact us directly.`)}</p>
      <div className="xreach">
        {SUPPORT_CHANNELS.map((c, i) => (
          <a key={c.href} className={`btn${i ? " ol" : ""} full`} href={c.href} target="_blank" rel="noopener">
            {c.label}
          </a>
        ))}
      </div>
      <nav className="xtopics" aria-label="Help topics">
        {HELP_TOPICS.map((t) => (
          <Link key={t.href} href={t.href}>
            <span>{t.label}</span>
            {icon(<path d="m9 18 6-6-6-6" />)}
          </Link>
        ))}
      </nav>
    </section>
  );
}
