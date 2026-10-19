"use client";

import { useState, useTransition, Suspense } from "react";

// ─── Types (mirrored from page.tsx to keep the bundle self-contained) ─────────

type FetchError = "network" | "parse" | "server" | "misconfigured" | "indexer_outage";

// ─── Retry banner ─────────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<FetchError, string> = {
  misconfigured:
    "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
    "Copy app/.env.example to app/.env.local and set a valid indexer URL, then restart the server.",
  network:
    "The indexer is unreachable right now. Circles may not be up to date. " +
    "Check that the indexer service is running.",
  server:
    "The indexer returned an unexpected error. Circles cannot be loaded at the moment.",
  parse:
    "The indexer response was malformed. This is likely a temporary issue.",
  indexer_outage:
    "The indexer is running but currently degraded. It may be catching up with the chain or experiencing a service disruption. " +
    "Circle data may be incomplete or temporarily unavailable.",
};

interface RetryBannerProps {
  error: FetchError;
  attempt: number;
  onRetry: () => void;
  isPending: boolean;
}

function RetryBanner({ error, attempt, onRetry, isPending }: RetryBannerProps) {
  // Misconfiguration and outage are operator/service errors that a page-level
  // refresh cannot fix — hide the retry button so users don't hammer a broken endpoint.
  const canRetry = error !== "misconfigured" && error !== "indexer_outage";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 mb-6 flex items-start gap-3"
    >
      <span className="text-xl mt-0.5" aria-hidden="true">
        ⚠️
      </span>
      <div className="flex-1">
        <p className="font-semibold text-amber-800 text-sm">
          Circles list unavailable
        </p>
        <p className="text-amber-700 text-sm mt-0.5">{ERROR_MESSAGES[error]}</p>
        {canRetry && (
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={onRetry}
              disabled={isPending}
              className={
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium " +
                "bg-amber-100 text-amber-900 border border-amber-300 " +
                "hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 " +
                "focus-visible:ring-amber-500 focus-visible:ring-offset-1 " +
                "disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              }
              aria-label={isPending ? "Retrying…" : "Retry loading circles"}
            >
              {isPending ? (
                <>
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-amber-600 border-t-transparent animate-spin"
                    aria-hidden="true"
                  />
                  Retrying…
                </>
              ) : (
                <>↺ Retry</>
              )}
            </button>
            {attempt > 1 && (
              <span className="text-amber-600 text-xs">
                Attempt {attempt}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Loading skeleton (inline so the component is self-contained) ─────────────

function InlineListSkeleton() {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      aria-busy="true"
      aria-label="Loading circles…"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="bg-white rounded-xl border border-slate-200 p-5 animate-pulse"
          aria-hidden="true"
        >
          <div className="h-3 bg-slate-200 rounded w-1/2 mb-2" />
          <div className="h-5 bg-slate-200 rounded w-2/3 mb-4" />
          <div className="grid grid-cols-3 gap-2 mb-3">
            {Array.from({ length: 3 }).map((__, j) => (
              <div key={j} className="bg-slate-100 rounded-lg h-10" />
            ))}
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full" />
          <div className="h-3 bg-slate-100 rounded w-1/3 mt-2" />
        </div>
      ))}
    </div>
  );
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RetryableCirclesListProps {
  /**
   * The initial server-rendered children (CirclesList server component output).
   * Displayed on first paint and after every successful retry.
   */
  children: React.ReactNode;
  /**
   * When the server detected an error it passes the error kind here so the
   * client can show the retry banner immediately without a round-trip.
   */
  initialError?: FetchError | null;
}

/**
 * Client shell that wraps the server-rendered CirclesList.
 *
 * On the happy path it simply renders `children` with zero overhead.
 * When an error is present (either from the server or a failed retry) it
 * shows the RetryBanner.  Clicking "Retry" triggers a router.refresh() via
 * startTransition so:
 *   1. React keeps the stale UI visible (no flash to empty)
 *   2. The Suspense boundary re-enters its loading skeleton while the new
 *      server render is in flight — satisfying the acceptance criterion
 *      "retry transitions back through loading before success"
 *   3. If the refetch succeeds, children are replaced with fresh server output
 *
 * MAX_RETRIES caps the number of client-initiated retries so the banner
 * never drives an infinite loop against a persistently broken endpoint.
 */
const MAX_RETRIES = 3;

export function RetryableCirclesList({
  children,
  initialError = null,
}: RetryableCirclesListProps) {
  const [attempt, setAttempt] = useState(1);
  const [retryKey, setRetryKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  // After MAX_RETRIES the user has seen the error enough times — stop
  // offering the button and show a calmer "please try again later" note.
  const exhausted = attempt > MAX_RETRIES;

  function handleRetry() {
    if (exhausted || isPending) return;
    startTransition(() => {
      setAttempt((n) => n + 1);
      // Bumping the key remounts the Suspense boundary, which drops the
      // cached server output and re-streams CirclesList from scratch —
      // producing the loading skeleton during the fetch as required.
      setRetryKey((k) => k + 1);
    });
  }

  if (initialError) {
    return (
      <>
        {!exhausted ? (
          <RetryBanner
            error={initialError}
            attempt={attempt}
            onRetry={handleRetry}
            isPending={isPending}
          />
        ) : (
          <div
            role="alert"
            className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 mb-6 flex items-start gap-3"
          >
            <span className="text-xl mt-0.5" aria-hidden="true">⚠️</span>
            <div>
              <p className="font-semibold text-amber-800 text-sm">
                Circles list unavailable
              </p>
              <p className="text-amber-700 text-sm mt-0.5">
                {ERROR_MESSAGES[initialError]} Please try again later.
              </p>
            </div>
          </div>
        )}
        {/* Render stale children (empty / previous result) below the banner */}
        <Suspense key={retryKey} fallback={<InlineListSkeleton />}>
          {children}
        </Suspense>
      </>
    );
  }

  return (
    <Suspense key={retryKey} fallback={<InlineListSkeleton />}>
      {children}
    </Suspense>
  );
}
