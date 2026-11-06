import Link from "next/link";
import { LEGAL_LINKS } from "@/lib/legal/links";
import { SEAL_SITE, cardRailsSet } from "@/lib/site";
import { Logo } from "./Logo.tsx";

export function Footer() {
  const cards = cardRailsSet(process.env);
  return (
    <footer className="foot">
      <div className="cols">
        <div className="brand">
          <Link className="logo small" href="/" aria-label="Break the Seal home">
            <Logo />
          </Link>
          <p>Real graded collectibles and XRPL NFTs, one bite at a time.</p>
          <p>
            Powered by{" "}
            <a href={SEAL_SITE.url} target="_blank" rel="noopener noreferrer">
              {SEAL_SITE.name}
            </a>
            .
          </p>
        </div>
        <nav aria-label="Product">
          <h4>Product</h4>
          <Link href="/packs">Open packs</Link>
          <Link href="/try">Try a free pack</Link>
          <Link href="/collection">Collection</Link>
          <Link href="/sell">Sell back</Link>
          {cards ? <Link href="/ship">Ship</Link> : null}
        </nav>
        <nav aria-label="Learn">
          <h4>Learn</h4>
          <Link href="/how">How packs work</Link>
          <Link href="/rates">Rarity rates</Link>
          <Link href="/fair">How the draw works</Link>
          <Link href="/how">{cards ? "Stash, ship and sell" : "Stash, sell and claim"}</Link>
        </nav>
        <nav aria-label="Company">
          <h4>Company</h4>
          <Link href="/how#about">About</Link>
          <a href={SEAL_SITE.url} target="_blank" rel="noopener noreferrer">
            {SEAL_SITE.name} <span aria-hidden="true">↗</span>
          </a>
          {LEGAL_LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="footbar">
        <span className="ctl">
          <b className="dot" />
          Built on XRPL
        </span>
      </div>
      <p className="fine">
        © 2026 Break the Seal. Pack results are random. Set a limit, open for the fun of it, and only spend what you can afford to lose. 18+. NFT floors and XRP price:{" "}
        <a href="https://xrpl.to" target="_blank" rel="noopener">
          Data by xrpl.to
        </a>
        .
      </p>
    </footer>
  );
}
