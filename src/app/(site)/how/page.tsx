import Link from "next/link";
import { noOrphan } from "@/lib/format";
import { howCopy } from "@/lib/legal/how";
import { sealTokenSpec } from "@/lib/rip/tokens";
import { railsConfig } from "@/lib/rip/mode";
import { cardRailsSet, SEAL_SITE } from "@/lib/site";
import { SEO, pageMeta } from "@/lib/seo";

export const metadata = pageMeta(SEO.how);

export default function HowPage() {
  const copy = howCopy(railsConfig(process.env).mode, cardRailsSet(process.env), !!sealTokenSpec(process.env));
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          How packs work<em>.</em>
        </h1>
      </div>
      <div className="steps3">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src="/assets/c-pick.webp" alt="Three sealed packs" />
          <h3>Pick</h3>
          <p>{noOrphan(copy.pick)}</p>
        </div>
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src="/assets/c-open.webp" alt="A pack between the seal's fangs" />
          <h3>Approve and bite</h3>
          <p>One payment from your wallet. Your pull is fixed moments after it lands, then the seal shows it to&nbsp;you.</p>
        </div>
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src="/assets/c-reveal.webp" alt="A graded card pops out of the seal's grin" />
          <h3>{copy.thirdTitle}</h3>
          <p>{noOrphan(copy.third)}</p>
        </div>
      </div>
      <p className="freshness">{copy.note}</p>
      <div className="legal">
        <section id="about">
          <h2>About</h2>
          <p>{noOrphan(copy.about)}</p>
          <p>
            Powered by{" "}
            <a href={SEAL_SITE.url} target="_blank" rel="noopener noreferrer">
              {SEAL_SITE.name}
            </a>
            , the SEAL community&apos;s home on the XRP Ledger.
          </p>
        </section>
        <section id="terms">
          <h2>Terms</h2>
          <p>{noOrphan(copy.terms)} <Link href="/terms">Terms</Link>.</p>
        </section>
        <section id="privacy">
          <h2>Privacy</h2>
          <p>{noOrphan(copy.privacy)} <Link href="/privacy">Privacy</Link>.</p>
        </section>
        <section id="support">
          <h2>Support</h2>
          <p>{noOrphan(copy.support)} <Link href="/support">Support</Link>.</p>
        </section>
      </div>
    </main>
  );
}
