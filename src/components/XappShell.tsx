"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDemo } from "@/lib/demo/store";
import { noOrphan } from "@/lib/format";
import { INFO_LINKS } from "@/lib/auth/xapp-host";
import { LEGAL_LINKS, OPERATOR, SUPPORT_CHANNELS, SUPPORT_EMAIL } from "@/lib/legal/links";
import { aboutFine, aboutLine, independence, infoLine } from "@/lib/xapp-copy";
import { usePendingCount } from "@/lib/live/hooks";
import { useRails } from "./Providers.tsx";
import { Sheet } from "./Sheet.tsx";
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
/** Tab screens with no Back. Help is a tab too, but its pages are also where Support, Terms and Privacy open, so it keeps Back. */
const ROOTS: readonly string[] = ["/packs", "/collection"];

/** The app's own header and tabs inside Xaman, in place of the site's. The site's are hidden by CSS before first paint, so neither flashes. */
export function XappShell() {
  const { shell, back } = useXapp();
  const path = usePathname() ?? "/";
  const router = useRouter();
  const demo = useDemo();
  const { mode } = useRails();
  const pending = usePendingCount(shell && mode !== "demo" && demo.signed && demo.wallet !== "demo", path);

  useEffect(() => {
    if (shell && path === "/") router.replace("/packs");
  }, [shell, path, router]);

  if (!shell) return null;
  // Xaman's own bar already names the app, so the main tabs start with their content. Every other page, the legal ones included, gets Back,
  // to the screen the player came from: the landing, the packs, or wherever they tapped. It never leaves the xApp.
  return (
    <>
      {ROOTS.includes(path) ? null : (
        <header className="xhead">
          <button type="button" className="xback" onClick={back}>
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

/** What this is, who makes it, and that it isn't Xaman's own. The first thing anyone reads inside Xaman. */
export function XappAbout({ seal, cards }: { seal: boolean; cards: boolean }) {
  return (
    <section className="xabout">
      <h2>Open a pack, get one prize</h2>
      <p>{noOrphan(aboutLine({ seal, cards }))}</p>
      <p className="fine">{noOrphan(aboutFine({ cards, operator: OPERATOR }))}</p>
    </section>
  );
}

/** The small line under every page: who makes this and that Xaman doesn't, the risk, and the three links Xaman asks for. */
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
        {noOrphan(`${independence(OPERATOR)} 18+. Pack results are random, so only spend what you can afford to lose.`)} XRP price:{" "}
        <a href="https://xrpl.to" target="_blank" rel="noopener">
          Data by xrpl.to
        </a>
        .
      </p>
    </footer>
  );
}

/** The Help tab's pages: the terms and privacy first, then how it all works, the odds, and the proof. The site has them in its footer, which Xaman doesn't show. */
export const HELP_TOPICS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/how", label: "How packs work" },
  { href: "/rates", label: "Rarity rates" },
  { href: "/fair", label: "How the draw works" },
] as const;

/** Tap-to-reach support, inside Xaman, on top of the support page, and the way to every other help page. */
export function XappSupport() {
  const { shell } = useXapp();
  const [copied, setCopied] = useState(false);
  if (!shell) return null;
  const copy = () => void navigator.clipboard?.writeText(SUPPORT_EMAIL).then(() => setCopied(true), () => {});
  return (
    <section className="xabout">
      <p>{noOrphan(`${independence(OPERATOR)} Xaman Support can't help with your order, so contact us directly.`)}</p>
      {/* An email link stays in the webview, which hands it to the phone's mail app. The address is there to copy as well. */}
      <div className="xmail">
        <a className="btn full" href={`mailto:${SUPPORT_EMAIL}`}>
          Email {SUPPORT_EMAIL}
        </a>
        <button type="button" className="btn ol" onClick={copy} aria-label={`Copy ${SUPPORT_EMAIL}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="xreach">
        {SUPPORT_CHANNELS.map((c) => (
          <a key={c.href} className="btn ol full" href={c.href} target="_blank" rel="noopener">
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

/**
 * The first-launch info sheet inside Xaman, and the same sheet from About: what this is, who makes it, and Support, the Privacy Policy
 * and the Terms, which open in place, inside the xApp, with Back at their top to this landing. Got it is the only thing that marks it read.
 */
export function XappInfoSheet({ seal, cards, onClose, onGotIt }: { seal: boolean; cards: boolean; onClose: () => void; onGotIt: () => void }) {
  const router = useRouter();
  return (
    <Sheet onClose={onClose} label="About Break the Seal" className="xinfo">
      {(close) => (
        <>
          <h3>About Break the Seal</h3>
          <p>{noOrphan(infoLine({ seal, cards }))}</p>
          <p className="fine">{noOrphan(independence(OPERATOR))}</p>
          <div className="xinfolinks">
            {INFO_LINKS.map((l) => (
              <button key={l.path} type="button" className="btn ol full" onClick={() => router.push(l.path)}>
                {l.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn full"
            onClick={() => {
              onGotIt();
              close();
            }}
          >
            Got it
          </button>
        </>
      )}
    </Sheet>
  );
}
