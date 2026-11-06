import Link from "next/link";

/** The 404 itself, without any chrome: whoever renders it already sits inside SiteChrome. */
export function NotFoundBody() {
  return (
    <main className="pg">
      <div className="emptyc">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/404.webp" alt="A confused seal with foil in its teeth" />
        <h3>That page got eaten</h3>
        <Link className="btn" href="/packs">
          Back to packs
        </Link>
      </div>
    </main>
  );
}
