"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="pg">
      <div className="emptyc">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/404.webp" alt="A confused seal with foil in its teeth" />
        <h3>Something bit back</h3>
        <p>Nothing was charged. Give it another try.</p>
        <div className="acts">
          <button className="btn" onClick={reset}>
            Try again
          </button>
          <Link className="btn ol" href="/packs">
            Back to packs
          </Link>
        </div>
      </div>
    </main>
  );
}
