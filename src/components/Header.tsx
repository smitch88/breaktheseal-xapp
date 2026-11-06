"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDemo } from "@/lib/demo/store";
import { shortAddress } from "@/lib/format";
import { usePendingCount } from "@/lib/live/hooks";
import { Logo } from "./Logo.tsx";
import { useConnect, useRails } from "./Providers.tsx";
import { useXapp } from "./XappHost.tsx";

const NAV = [
  { href: "/", label: "discover", match: (p: string) => p === "/" },
  { href: "/packs", label: "packs", match: (p: string) => p.startsWith("/packs") || p.startsWith("/nft") || p.startsWith("/checkout") },
  { href: "/collection", label: "collection", match: (p: string) => p.startsWith("/collection") || p.startsWith("/sell") || p.startsWith("/ship") },
];

export function Header() {
  const path = usePathname() ?? "/";
  const demo = useDemo();
  const connect = useConnect();
  const { mode } = useRails();
  // Inside Xaman this header is hidden and the app's own shell asks instead.
  const { shell } = useXapp();
  const pending = usePendingCount(!shell && mode !== "demo" && demo.signed && demo.wallet !== "demo", path);
  return (
    <header className="hdr">
      <Link className="logo" href="/" aria-label="Break the Seal home">
        <Logo />
      </Link>
      <nav aria-label="Main navigation">
        {NAV.map((n) => (
          <Link key={n.href} className={n.match(path) ? "on" : ""} href={n.href}>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="end">
        {demo.signed ? (
          <>
            {demo.wallet === "demo" ? (
              <span className="ctl">
                <b className="dot" />
                1,240 XRP demo
              </span>
            ) : null}
            <Link className="ctl" href="/profile" aria-label={pending ? `Profile, ${pending} waiting for you to accept` : "Profile"}>
              {shortAddress(demo.address)}
              {pending ? <b className="count">{pending}</b> : null}
            </Link>
          </>
        ) : (
          <button className="ctl y" onClick={() => connect()}>
            Connect
          </button>
        )}
      </div>
    </header>
  );
}
