import type { Metadata } from "next";
import Link from "next/link";

// ─── Metadata ─────────────────────────────────────────────────────────────────
//
// A static title and description for the 404 page. Next.js will use these when
// the page is served in response to a notFound() call from any route (including
// /circles/[address] for unknown circle addresses).

export const metadata: Metadata = {
  title: "Page Not Found — CircleUp",
  description:
    "The page, circle, or reputation record you are looking for does not exist or may have moved. " +
    "Check the address and try again, or browse all circles on CircleUp.",
};

// ─── 404 page ─────────────────────────────────────────────────────────────────
//
// This component is rendered whenever any route in the app calls notFound().
// The most common triggers are:
//   • /circles/[address]   — unknown or un-indexed circle address
//   • /reputation/[member] — unknown reputation member (no recorded activity)
//   • Any typo'd URL
//
// The copy is deliberately broad so it reads well for all three cases while
// still giving circle-specific guidance ("the address may be incorrect").

export default function NotFound() {
  return (
    <div className="text-center py-24 max-w-md mx-auto">
      <div className="text-6xl mb-4" aria-hidden="true">🔍</div>

      <h1 className="text-2xl font-bold text-slate-900 mb-3">Page not found</h1>

      <p className="text-slate-500 mb-2">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <p className="text-slate-500 mb-8">
        If you followed a circle or reputation link, double-check the address —
        it may be incorrect, the circle may not have been indexed yet, or the
        member may have no recorded activity on CircleUp yet.
      </p>

      {/* Suggestions */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-600 text-left mb-8">
        <p className="font-semibold text-slate-700 mb-2">Things to try:</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>Make sure the contract address in the URL is correct.</li>
          <li>
            Wait a moment — newly created circles can take a few seconds for
            the indexer to process before they become accessible.
          </li>
          <li>Browse the full circle list to find the one you&apos;re after.</li>
        </ul>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          href="/"
          className="bg-brand-600 text-white px-5 py-2.5 rounded-lg hover:bg-brand-700 transition-colors font-medium"
        >
          Browse all circles
        </Link>
        <Link
          href="/create"
          className="border border-brand-600 text-brand-700 px-5 py-2.5 rounded-lg hover:bg-brand-50 transition-colors font-medium"
        >
          Create a circle
        </Link>
      </div>
    </div>
  );
}
