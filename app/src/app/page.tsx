import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { indexerEndpoint, INDEXER_TIMEOUT_MS } from "@/lib/config";
import { CircleCard, parseCircleRow } from "@/components/CircleCard";
import type { Circle } from "@/components/CircleCard";
import { RetryableCirclesList } from "@/components/RetryableCirclesList";
import { CircleStatusFilter as CircleStatusFilterNav } from "@/components/CircleStatusFilter";
import {
  isValidStatusFilter,
  getBrowseState,
  type CircleStatusFilter,
} from "@/lib/circleTypes";

export const metadata: Metadata = {
  title: "CircleUp — Trustless Savings Circles on Stellar",
  description:
    "Start a savings circle on Stellar. Ajo, Esusu, Tanda, and Chama — on-chain. Everyone pays in once a round, and the smart contract hands the pot to whoever's turn it is.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "CircleUp — Trustless Savings Circles on Stellar",
    description:
      "Ajo, Esusu, Tanda, and Chama on Stellar. Everyone pays in once a round, and the contract hands the whole pot to whoever's turn it is.",
    url: "/",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "CircleUp — Trustless Savings Circles on Stellar",
    description:
      "Ajo, Esusu, Tanda, and Chama on Stellar. Everyone pays in once a round, and the contract hands the whole pot to whoever's turn it is.",
  },
};

import {
  CIRCLE_STATUS_OPTIONS,
  isValidStatusFilter,
  isValidUrl,
  PROTOCOL_GUARANTEES,
  getBrowseState,
  type CircleStatusFilter as StatusFilterType,
  type BrowseState,
  type FetchResult,
} from "@/lib/homeHero";

// ─── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch circles from the indexer, optionally filtered by status.
 *
 * The function is wrapped with `unstable_cache` per status value so that:
 *   - The unfiltered list, the Active-only list, the Pending-only list, etc.
 *     each get their own 10 s cache bucket.
 *   - Multiple server components on the same page that request the same
 *     (status, filter) combination share a single in-flight fetch.
 *
 * `total` comes from the indexer's pagination envelope so the heading can
 * show the accurate filtered count without a second request.
 */
function makeGetCircles(status: StatusFilterType | undefined) {
  const cacheKey = status ? `circles-homepage-${status}` : "circles-homepage";

  return unstable_cache(
    async function fetchCircles(): Promise<FetchResult> {
      // Build the URL: encode the status param when present so a crafted value
      // can never inject additional query-string segments.
      const segments: string[] = ["circles"];
      const base = indexerEndpoint(segments);
      if (base === null) {
        return { ok: false, error: "misconfigured" };
      }
      const url = status
        ? `${base}?${new URLSearchParams({ status }).toString()}`
        : base;

      let res: Response;
      try {
        res = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: "network" };
      }

      if (!res.ok) {
        if (res.status === 503) return { ok: false, error: "indexer_outage" };
        return { ok: false, error: "server" };
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { ok: false, error: "parse" };
      }

      if (
        typeof data !== "object" ||
        data === null ||
        !Array.isArray((data as Record<string, unknown>).circles)
      ) {
        return { ok: false, error: "parse" };
      }

      const rawCircles = (data as { circles: unknown[]; pagination?: { total?: unknown } }).circles;
      const rawTotal = (data as { pagination?: { total?: unknown } }).pagination?.total;
      // `total` from the pagination envelope is the authoritative filtered count.
      // Fall back to the length of the validated list when the field is absent
      // (e.g. older indexer versions that don't return the envelope yet).
      let total = typeof rawTotal === "number" && rawTotal >= 0 ? rawTotal : -1;

      // Each row is validated independently — a single malformed row is dropped
      // rather than crashing the render.  Deduplicate by address: the indexer
      // should never return duplicates, but guard here so a transient bug never
      // causes a React key collision or a misleading count in the heading.
      const seen = new Set<string>();
      const circles: Circle[] = [];
      for (const rawCircle of rawCircles) {
        const circle = parseCircleRow(rawCircle);
        if (!circle || seen.has(circle.address)) continue;
        seen.add(circle.address);
        circles.push(circle);
      }

      if (total < 0) total = circles.length;

      return { ok: true, circles, total };
    },
    [cacheKey],
    { revalidate: 10 },
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function IndexerErrorBanner({
  error,
}: {
  error: "network" | "parse" | "server" | "misconfigured" | "indexer_outage";
}) {
  const messages: Record<string, string> = {
    misconfigured:
      "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
      "Copy app/.env.example to app/.env.local and set a valid indexer URL, then restart the server.",
    network:
      "The indexer is unreachable right now. Circles may not be up to date. Check that the indexer service is running.",
    server:
      "The indexer returned an unexpected error. Circles cannot be loaded at the moment.",
    parse:
      "The indexer response was malformed. This is likely a temporary issue — try refreshing.",
    indexer_outage:
      "The indexer is running but currently degraded (it may be catching up with the chain or experiencing a service disruption). " +
      "Circle data may be incomplete or temporarily unavailable. Try refreshing in a few minutes.",
  };

  return (
    <div
      role="alert"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 mb-6 flex items-start gap-3"
    >
      <span className="text-xl mt-0.5" aria-hidden="true">!</span>
      <div>
        <p className="font-semibold text-amber-800 text-sm">
          Circles list unavailable
        </p>
        <p className="text-amber-700 text-sm mt-0.5">{messages[error]}</p>
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────
//
// Shown via Suspense while the async circles fetch is in flight. Renders the
// same grid layout as the real list so there is no layout shift on hydration.

function CircleListSkeleton() {
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
          {/* Address line */}
          <div className="h-3 bg-slate-200 rounded w-1/2 mb-2" />
          {/* Amount line */}
          <div className="h-5 bg-slate-200 rounded w-2/3 mb-4" />
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {Array.from({ length: 3 }).map((__, j) => (
              <div key={j} className="bg-slate-100 rounded-lg h-10" />
            ))}
          </div>
          {/* Progress bar */}
          <div className="h-1.5 bg-slate-100 rounded-full" />
          {/* Creator line */}
          <div className="h-3 bg-slate-100 rounded w-1/3 mt-2" />
        </div>
      ))}
    </div>
  );
}

// ─── Circles list (async server component) ────────────────────────────────────

async function CirclesList({
  status,
}: {
  status: StatusFilterType | undefined;
}) {
  const getCircles = makeGetCircles(status);
  const result = await getCircles();

  if (!result.ok) {
    return (
      <>
        <span
          data-circles-fetch-error={result.error}
          aria-hidden="true"
          className="hidden"
        />
        <IndexerErrorBanner error={result.error} />
      </>
    );
  }

  if (result.circles.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3">NEW</div>
        <p className="font-medium">
          {status
            ? `No ${status.toLowerCase()} circles found.`
            : "No circles yet."}
        </p>
        {!status && (
          <p className="text-sm mt-1">
            <Link href="/create" className="text-brand-600 underline">
              Create the first one
            </Link>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {result.circles.map((circle) => (
        <CircleCard key={circle.address} circle={circle} />
      ))}
    </div>
  );
}

// ─── Error-aware list wrapper (server component) ──────────────────────────────

async function CirclesListWithRetry({
  status,
}: {
  status: StatusFilterType | undefined;
}) {
  const getCircles = makeGetCircles(status);
  const result = await getCircles().catch(() => null);
  const initialError =
    !result || !result.ok ? (result?.error ?? "network") : null;

  return (
    <RetryableCirclesList initialError={initialError}>
      <CirclesList status={status} />
    </RetryableCirclesList>
  );
}

// ─── Circle count badge ───────────────────────────────────────────────────────
//
// Shows the filtered total beside the section heading. Omitted entirely when the
// fetch failed — a stale or missing number is never presented as fact.

async function CircleCount({
  status,
}: {
  status: StatusFilterType | undefined;
}) {
  const getCircles = makeGetCircles(status);
  const result = await getCircles().catch(() => null);
  if (!result || !result.ok) return null;

  return (
    <span className="ml-2 text-sm font-normal text-slate-400">
      ({result.total})
    </span>
  );
}

interface ProtocolGuarantee {
  emoji: string;
  title: string;
  desc: string;
}

const PROTOCOL_GUARANTEES: readonly ProtocolGuarantee[] = [
  {
    emoji: "🔒",
    title: "No rug-pulls",
    desc: "The smart contract holds all funds until payout. No single member or organizer can withdraw money prematurely.",
  },
  {
    emoji: "🔄",
    title: "Deterministic rotation",
    desc: "Payout order and rotation schedule are fixed on-chain upon circle creation and cannot be tampered with.",
  },
  {
    emoji: "🛡️",
    title: "Collateral-backed defaults",
    desc: "Members lock collateral upfront. If anyone defaults on a round, their collateral compensates affected members.",
  },
  {
    emoji: "⭐",
    title: "On-chain reputation",
    desc: "Successful contributions build an immutable reputation score across circles on the Stellar network.",
  },
] as const;




/**
 * Shared button geometry so the two CTAs line up and share focus styling.
 */
const CTA_BASE =
  "inline-block px-6 py-3 rounded-xl font-semibold text-lg transition-colors " +
  "border border-brand-600 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50";

async function HeroSecondaryCta() {
  // Always use the unfiltered count for the hero CTA.
  const getCircles = makeGetCircles(undefined);
  const result = await getCircles().catch(() => null);
  const browse = getBrowseState(result);

  return (
    <>
      {browse.kind === "browse" && (
        <a
          href="#circles"
          className={`${CTA_BASE} bg-white text-brand-700 hover:bg-brand-50`}
        >
          Browse {browse.count} open{" "}
          {browse.count === 1 ? "circle" : "circles"}
        </a>
      )}

      {browse.kind === "empty" && (
        <p className="text-slate-500 text-sm sm:self-center">
          No circles have been created yet. Yours would be the first.
        </p>
      )}

      {browse.kind === "unavailable" && (
        <p className="text-slate-500 text-sm sm:self-center">
          Existing circles cannot be listed right now. See the notice below.
        </p>
      )}
    </>
  );
}

function HeroSecondaryCtaFallback() {
  return (
    <span className={`${CTA_BASE} invisible`} aria-hidden="true">
      Browse open circles
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  // Resolve the async searchParams (Next.js 15 dynamic API)
  const params = await searchParams;
  const rawStatus = Array.isArray(params.status) ? params.status[0] : params.status;
  // Guard the raw query-string value: only pass it through when it matches a
  // known status so a crafted URL can never inject an arbitrary string into the
  // fetch URL or the heading label.
  const activeStatus: StatusFilterType | undefined = isValidStatusFilter(rawStatus)
    ? rawStatus
    : undefined;

  // Label for the list section heading.
  const sectionLabel = activeStatus ? `${activeStatus} Circles` : "All Circles";

  return (
    <div>
      {/* Hero */}
      <section aria-labelledby="hero-heading" className="text-center py-12">
        <div className="text-5xl mb-4" aria-hidden="true">🔄</div>
        <h1
          id="hero-heading"
          className="text-3xl font-bold text-slate-900 mb-3"
        >
          Start a savings circle no one can run off with
        </h1>
        <p className="text-slate-600 max-w-xl mx-auto mb-8 text-lg">
          Ajo, Esusu, Tanda, and Chama, on Stellar. Everyone pays in once a
          round, and the contract hands the whole pot to whoever&apos;s turn it
          is. Funds sit in the contract, never with an organizer.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          <Link
            href="/create"
            className={`${CTA_BASE} bg-brand-600 text-white hover:bg-brand-700`}
          >
            Create a circle
          </Link>

          <Suspense fallback={<HeroSecondaryCtaFallback />}>
            <HeroSecondaryCta />
          </Suspense>
        </div>

        <p className="text-slate-500 text-sm mt-4">
          Setting one up takes about a minute. You will need a Freighter wallet
          and the Stellar addresses of 2 to 20 members.
        </p>
      </section>

      {/* How it works */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        {[
          {
            emoji: "👥",
            title: "Form a circle",
            desc: "Invite members, set the contribution amount and rotation order.",
          },
          {
            emoji: "💰",
            title: "Each round, everyone contributes",
            desc: "The smart contract holds the pot. No one can withdraw early.",
          },
          {
            emoji: "🎯",
            title: "The pot rotates",
            desc: "Each member receives the full pot exactly once. Miss a round → penalty.",
          },
        ].map((step) => (
          <div
            key={step.title}
            className="bg-white rounded-xl border border-slate-200 p-5 text-center"
          >
            <div className="text-3xl mb-2">{step.emoji}</div>
            <h3 className="font-semibold text-slate-800 mb-1">{step.title}</h3>
            <p className="text-slate-500 text-sm">{step.desc}</p>
          </div>
        ))}
      </div>

      {/* Protocol guarantees */}
      <div className="mb-12">
        <h2 className="text-xl font-bold text-slate-800 mb-4">
          🔐 Protocol Guarantees
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PROTOCOL_GUARANTEES.map((g) => (
            <div
              key={g.title}
              className="bg-white rounded-xl border border-slate-200 p-5 flex gap-4 items-start"
            >
              <span className="text-2xl mt-0.5" aria-hidden="true">
                {g.emoji}
              </span>
              <div>
                <h3 className="font-semibold text-slate-800 mb-1">{g.title}</h3>
                <p className="text-slate-500 text-sm">{g.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Circles list ─────────────────────────────────────────────────────────
          `id="circles"` is the anchor target of the hero's "Browse" CTA.
          `scroll-mt-6` keeps the heading clear of the viewport top.         */}
      <div
        id="circles"
        className="scroll-mt-6 mb-5"
      >
        {/* Heading row: label + count on the left, New circle link on the right */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-bold text-slate-800">
            {sectionLabel}
            <Suspense fallback={null}>
              <CircleCount status={activeStatus} />
            </Suspense>
          </h2>
          <Link
            href="/create"
            className="text-brand-600 text-sm font-medium hover:underline"
          >
            + New circle
          </Link>
        </div>

        {/* Status filter tabs — client component so selection updates the URL
            without a full page reload. The active value is read back from
            searchParams on the server so the correct circles are streamed
            immediately, even on a direct URL visit or a hard refresh.        */}
        <CircleStatusFilter activeStatus={activeStatus} />
      </div>

      <Suspense fallback={<CircleListSkeleton />}>
        <CirclesListWithRetry status={activeStatus} />
      </Suspense>
    </div>
  );
}
