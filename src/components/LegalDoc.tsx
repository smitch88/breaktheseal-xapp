import Link from "next/link";
import type { LegalBlock, LegalDocument } from "@/lib/legal/content";
import { gluedParts } from "@/lib/legal/inline";
import styles from "./LegalDoc.module.css";

function Inline({ source }: { source: string }) {
  return (
    <>
      {gluedParts(source).map((p, i) => {
        if (p.kind === "code") return <code key={i}>{p.text}</code>;
        if (p.kind === "web") return <span key={i} className="webonly">{p.text}</span>;
        if (p.kind === "placeholder") return <mark key={i}>{p.text}</mark>;
        if (p.kind !== "link") return p.text;
        if (p.href.startsWith("/api/") || p.href.startsWith("http")) {
          return (
            <a key={i} href={p.href} target="_blank" rel="noopener">
              {p.text}
            </a>
          );
        }
        return (
          <Link key={i} href={p.href}>
            {p.text}
          </Link>
        );
      })}
    </>
  );
}

function Block({ block }: { block: LegalBlock }) {
  if (typeof block === "string") {
    return (
      <p>
        <Inline source={block} />
      </p>
    );
  }
  if ("note" in block) {
    return (
      <p className={styles.note}>
        <Inline source={block.note} />
      </p>
    );
  }
  return (
    <ul>
      {block.items.map((item) => (
        <li key={item}>
          <Inline source={item} />
        </li>
      ))}
    </ul>
  );
}

/** One legal page: a plain reading column, with a list of what's on it for the long ones. */
export function LegalDoc({ doc, top }: { doc: LegalDocument; top?: React.ReactNode }) {
  return (
    <main className="pg">
      <div className="ptitle">
        <h1>
          {doc.title}
          <em>.</em>
        </h1>
      </div>
      {top}
      <div className={styles.doc}>
        {doc.intro.map((text) => (
          <p key={text}>
            <Inline source={text} />
          </p>
        ))}
        <details className={styles.toc}>
          <summary>On this page</summary>
          <nav aria-label={`${doc.title} sections`}>
            {doc.sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.heading}
              </a>
            ))}
          </nav>
        </details>
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id}>
            <h2>{s.heading}</h2>
            {s.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
