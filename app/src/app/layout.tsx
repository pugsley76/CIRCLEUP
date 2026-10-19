import type { Metadata } from "next";
import "./globals.css";
import { WalletButton } from "@/components/WalletButton";
import { WalletRepLink } from "@/components/WalletRepLink";

// ─── Site origin ──────────────────────────────────────────────────────────────
//
// NEXT_PUBLIC_SITE_URL should be set to the canonical origin (e.g.
// "https://circleup.app") in production.  In development it falls back to
// localhost.  We never use `new URL(req.url)` here because this is a Server
// Component that cannot access the request object directly in the App Router
// metadata export.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "http://localhost:3000";

export const metadata: Metadata = {
  title: {
    default: "CircleUp — On-Chain Savings Circles",
    template: "%s — CircleUp",
  },
  description:
    "Rotating savings & credit associations (Ajo / Esusu / Tanda / Chama) on Stellar Soroban",
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: "/",
  },
  // Allow search engines to index the app and follow links. Search crawlers
  // (e.g. Googlebot, Bingbot) use this as the baseline for every route — page
  // routes may override it, but none of the current routes opt out.
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    siteName: "CircleUp",
    type: "website",
    locale: "en_US",
  },
  // Base social card for rich link previews (Slack, Discord, X, WhatsApp).
  // Individual page routes inherit this and enrich the title/description with
  // route-specific values that merge in from their `metadata`/`generateMetadata`.
  twitter: {
    card: "summary",
    title: "CircleUp",
    description: "On-chain savings circles on Stellar Soroban",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50">
        <nav className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <span className="text-2xl" aria-hidden="true">🔄</span>
          <span className="font-bold text-slate-800 text-lg">CircleUp</span>
          <span className="text-slate-400 text-sm hidden sm:block">
            Trustless savings circles on Stellar
          </span>
          <div className="ml-auto flex gap-4 text-sm">
            <a href="/" className="text-slate-600 hover:text-brand-600 transition-colors">
              Circles
            </a>
            <a href="/create" className="text-slate-600 hover:text-brand-600 transition-colors">
              Create
            </a>
            <WalletRepLink />
            <WalletButton />
          </div>
        </nav>
        <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
        <footer className="text-center text-xs text-slate-400 py-8">
          Built on Stellar Soroban · Testnet
        </footer>
      </body>
    </html>
  );
}
