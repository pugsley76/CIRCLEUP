"use client";

import { useEffect } from "react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Heuristically detect whether the error is likely an indexer outage so we
 * can surface actionable guidance rather than a generic "something went wrong".
 *
 * We look for keywords in the error message because structured error codes are
 * not propagated through Next.js error boundaries — only the message string
 * and an opaque digest reach the client. This is best-effort; the generic
 * fallback is shown for all other cases.
 */
function isLikelyIndexerOutage(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("indexer") ||
    msg.includes("degraded") ||
    msg.includes("unreachable") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

export default function CircleError({ error, reset }: Props) {
  useEffect(() => {
    console.error("[circle-route-error]", error.digest ?? "(no digest)");
  }, [error]);

  const outage = isLikelyIndexerOutage(error);

  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-xl px-5 py-8 flex flex-col items-center gap-4 text-center"
    >
      <span className="text-3xl" aria-hidden="true">
        {outage ? "🔌" : "⚠️"}
      </span>
      <div>
        {outage ? (
          <>
            <p className="font-semibold text-red-800">
              Indexer unavailable
            </p>
            <p className="text-red-700 text-sm mt-1">
              The indexer is unreachable or currently degraded. Circle details
              cannot be loaded right now. This is usually temporary — try again
              in a few minutes.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold text-red-800">
              Something went wrong loading this circle.
            </p>
            <p className="text-red-700 text-sm mt-1">
              This is likely a temporary issue. Try resetting the page or
              navigating back.
            </p>
          </>
        )}
        {error.digest && (
          <p className="text-xs text-red-400 mt-2 font-mono">
            ref: {error.digest}
          </p>
        )}
      </div>
      <div className="flex gap-3">
        {outage && (
          <button
            onClick={reset}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
          >
            Try again
          </button>
        )}
        <a
          href="/"
          className="px-4 py-2 bg-white border border-red-200 text-red-700 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors"
        >
          Back to circles
        </a>
      </div>
    </div>
  );
}
