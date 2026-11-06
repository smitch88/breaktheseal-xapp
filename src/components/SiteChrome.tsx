import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { XappFoot, XappShell } from "@/components/XappShell";

/** The one place the site's header and footer (and the xApp's own bar and tabs) are drawn. Pages under (site) get it from their layout;
 *  the root not-found, which renders outside that layout for unknown URLs, wraps itself in it. Nothing else renders a Header. */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <Header />
      <XappShell />
      {children}
      <XappFoot />
      <Footer />
    </div>
  );
}
