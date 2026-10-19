import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  indexerEndpoint,
  INDEXER_TIMEOUT_MS,
  formatUsdc,
  formatPot,
} from "@/lib/config";
import { parseMemberRows } from "@/lib/members";
import { getStatusMeta } from "@/components/CircleCard";
// Issue #513: use shared parsers ΓÇö eliminates the unsafe `as CircleRound[]`
// and `as CircleDetailData["circle"]` casts that were previously here.
import {
  parseCircleState,
  parseRoundsResponse,
} from "@/lib/circleTypes";
import {
  CircleDetailClient,
  type CircleDetailData,
} from "./CircleDetailClient";
import CircleErrorBody from "./CircleErrorBody";
// Canonical address validator ΓÇö the single source of truth for Soroban contract
// IDs. Replaces the inline `/^C[A-Z2-7]{55}$/` regex that was previously used
// in generateMetadata only, and extends the guard to the page render path so
// a malformed address never reaches the indexer, CircleHeader, or
// CircleDetailClient.
import { isSorobanContractId } from "@/lib/address";

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  const rawAddress = typeof params?.address === "string" ? params.address.trim() : "";
  const safeAddress = isSorobanContractId(rawAddress) ? rawAddress : null;

  if (!safeAddress) {
    return {
      title: "Circle ΓÇö CircleUp",
      description: "Savings circle on CircleUp.",
      twitter: {
        card: "summary",
        title: "Circle ΓÇö CircleUp",
        description: "Savings circle on CircleUp.",
      },
    };
  }

  try {
    const result = await getCircleDetail(safeAddress);
    if (result.ok) {
      const { circle } = result.data;
      const status = String(circle.status).replace(/[<>"'&]/g, "");
      const pot = `$${formatPot(circle.round_amount, circle.member_count)}`;
      const roundAmount = `$${formatUsdc(circle.round_amount)}`;
      return {
        title: `${roundAmount}/round Circle (${status}) ΓÇö CircleUp`,
        description:
          `${pot} pot ┬╖ ${circle.member_count} members ┬╖ round ${circle.current_round} of ${circle.total_rounds}. ` +
          `Savings circle at ${safeAddress} on CircleUp.`,
        alternates: {
          canonical: `/circles/${safeAddress}`,
        },
        openGraph: {
          title: `${roundAmount}/round Circle (${status}) ΓÇö CircleUp`,
          description:
            `${pot} pot ┬╖ ${circle.member_count} members ┬╖ round ${circle.current_round} of ${circle.total_rounds}.`,
          url: `/circles/${safeAddress}`,
          type: "website",
        },
        twitter: {
          card: "summary",
          title: `${roundAmount}/round Circle (${status}) ΓÇö CircleUp`,
          description:
            `${pot} pot ┬╖ ${circle.member_count} members ┬╖ round ${circle.current_round} of ${circle.total_rounds}.`,
        },
      };
    } else if (result.error === "not_found") {
      return {
        title: "Circle Not Found ΓÇö CircleUp",
        description: "The requested savings circle address was not found on CircleUp.",
        twitter: {
          card: "summary",
          title: "Circle Not Found ΓÇö CircleUp",
          description: "The requested savings circle address was not found on CircleUp.",
        },
      };
    }
  } catch {
    // Silently fall through to default fallback below
  }

  const shortAddr = safeAddress.slice(0, 8);
  return {
    title: `Circle ${shortAddr}ΓÇª ΓÇö CircleUp`,
    description: `Savings circle at ${safeAddress} on CircleUp. Track rotation order, round progress, and contribution history.`,
    alternates: {
      canonical: `/circles/${safeAddress}`,
    },
    twitter: {
      card: "summary",
      title: `Circle ${shortAddr}ΓÇª ΓÇö CircleUp`,
      description: `Savings circle at ${safeAddress} on CircleUp.`,
    },
  };
}

// ΓöÇΓöÇΓöÇ Types ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

type FetchError = "network" | "server" | "parse" | "misconfigured" | "indexer_outage";

// not_found is handled separately: the page calls notFound() which triggers
// Next.js's built-in 404 route ΓÇö CircleErrorBody is never rendered for it.
type FetchResult =
  | { ok: true; data: CircleDetailData }
  | { ok: false; error: "not_found" | FetchError };

// ΓöÇΓöÇΓöÇ Data fetching ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async function getCircleDetail(address: string): Promise<FetchResult> {
  // Guard against a misconfigured NEXT_PUBLIC_INDEXER_URL before touching the
  // network (see indexerEndpoint in lib/config.ts).
  const circleUrl = indexerEndpoint(["circles", address]);
  const roundsUrl = indexerEndpoint(["circles", address, "rounds"]);
  if (circleUrl === null || roundsUrl === null) {
    return { ok: false, error: "misconfigured" };
  }

  let circleRes: Response;
  let roundsRes: Response;

  try {
    // `cache: "no-store"` rather than `next: { revalidate: 5 }`: when the
    // indexer URL points at a port nothing listens on, Next's revalidate-cache
    // wrapper leaves a rejected promise unawaited and the page 500s after a long
    // hang instead of reaching the "network" branch below. Same fix as the
    // home page. The timeout covers an unroutable host.
    const init: RequestInit = {
      cache: "no-store",
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    };
    [circleRes, roundsRes] = await Promise.all([
      fetch(circleUrl, init),
      fetch(roundsUrl, init),
    ]);
  } catch {
    return { ok: false, error: "network" };
  }

  if (circleRes.status === 404) {
    return { ok: false, error: "not_found" };
  }
  if (circleRes.status === 503) {
    return { ok: false, error: "indexer_outage" };
  }
  if (!circleRes.ok) {
    return { ok: false, error: "server" };
  }

  let circleData: Record<string, unknown>;
  let roundsData: Record<string, unknown>;

  try {
    circleData = (await circleRes.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "parse" };
  }

  try {
    roundsData = roundsRes.ok
      ? ((await roundsRes.json()) as Record<string, unknown>)
      : { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };
  } catch {
    roundsData = { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };
  }

  // Validate the shape we depend on to avoid runtime errors in the render tree.
  // Issue #513: parseCircleState replaces the bare `as CircleDetailData["circle"]`
  // cast ΓÇö if the indexer returns a malformed object, we return a parse error
  // rather than letting a broken value propagate into the render tree.
  if (
    typeof circleData.circle !== "object" ||
    circleData.circle === null
  ) {
    return { ok: false, error: "parse" };
  }

  const circleState = parseCircleState(circleData.circle);
  if (!circleState) {
    return { ok: false, error: "parse" };
  }

  // Members are optional ΓÇö if the indexer omits the field (e.g. during
  // re-indexing or for very new circles) or sends rows we cannot trust, we
  // fall back to an empty array and CircleDetailClient renders its "member
  // data unavailable" fallback in the rotation view instead of crashing.
  const members = parseMemberRows(circleData.members);

  // Issue #513: parseRoundsResponse replaces the four inline `as CircleRound[]`
  // and `as CirclePendingDefault[]` casts ΓÇö validates rounds, openRounds,
  // pendingDefaults and currentRound, dropping malformed rows rather than
  // surfacing them in the render tree.
  const roundsPayload = parseRoundsResponse(roundsData);

  return {
    ok: true,
    data: {
      circle: circleState,
      members,
      rounds: roundsPayload.rounds,
      // openRounds: unpaid rounds with activity that are not the current round.
      // Previously invisible to the client because the old /rounds endpoint
      // only iterated payouts (issue #170).
      openRounds: roundsPayload.openRounds,
      pendingDefaults: roundsPayload.pendingDefaults,
      latestLedger:
        typeof circleData.latestLedger === "number"
          ? circleData.latestLedger
          : null,
      checkpointTime:
        typeof circleData.checkpointTime === "string" && circleData.checkpointTime.trim() !== ""
          ? circleData.checkpointTime
          : null,
      // currentRound from the /rounds response contains the actual
      // contributions list for the in-progress round ΓÇö used by
      // CircleDetailClient to accurately gate the Contribute button.
      currentRound: roundsPayload.currentRound,
    },
  };
}

// ΓöÇΓöÇΓöÇ Read-only circle header ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
//
// Always rendered ΓÇö even when the data fetch fails ΓÇö so the user always sees
// the circle address and a coherent page structure instead of a blank screen.
//
// When `circle` is provided the real stats are shown; when it is absent
// (error / not-found) each stat cell renders a muted "ΓÇö" placeholder so the
// layout is preserved and clearly communicates "unknown, not broken UI".

interface CircleHeaderProps {
  address: string;
  circle?: CircleDetailData["circle"] | null;
}

function CircleHeader({ address, circle }: CircleHeaderProps) {
  const stats: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Status",
      value: circle ? (() => {
        const s = getStatusMeta(circle.status);
        return (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${s.chipClasses}`}
            title={s.description}
            aria-label={`Status: ${s.label}. ${s.description}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${s.dotClasses}`} aria-hidden="true" />
            {s.label}
          </span>
        );
      })() : (
        <span className="text-slate-300" aria-hidden="true">ΓÇö</span>
      ),
    },
    {
      label: "Round",
      value: circle ? (
        `${circle.current_round} / ${circle.total_rounds}`
      ) : (
        <span className="text-slate-300" aria-hidden="true">ΓÇö</span>
      ),
    },
    {
      label: "Members",
      value: circle ? (
        circle.member_count
      ) : (
        <span className="text-slate-300" aria-hidden="true">ΓÇö</span>
      ),
    },
    {
      label: "Pot/round",
      value: circle ? (
        `$${formatPot(circle.round_amount, circle.member_count)}`
      ) : (
        <span className="text-slate-300" aria-hidden="true">ΓÇö</span>
      ),
    },
  ];

  return (
    <div className="mb-8" aria-label="Circle overview">
      <div className="flex items-start gap-3 mb-2">
        <span className="text-3xl" aria-hidden="true">≡ƒöä</span>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug">
            {circle
              ? `$${formatUsdc(circle.round_amount)} / round Circle`
              : "Circle"}
          </h1>
          <p className="font-mono text-sm text-slate-500 break-all select-all">
            {address}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-white rounded-xl border border-slate-200 p-4 text-center"
          >
            <p className="text-lg font-bold text-slate-900">{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ΓöÇΓöÇΓöÇ Page ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export default async function CircleDetailPage({
  params,
}: {
  params: { address: string };
}) {
  // ΓöÇΓöÇ Address validation ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  //
  // Validate params.address before any network call. Without this guard a
  // malformed segment (e.g. "/circles/../../etc/passwd", a G-key mistakenly
  // pasted into a circle URL, or a truncated address) would:
  //   1. Reach indexerEndpoint() ΓÇö which URL-encodes it and fires a real fetch.
  //   2. Be displayed verbatim in CircleHeader's monospace address field.
  //   3. Be passed to CircleDetailClient, which guards its action buttons but
  //      not the invite-URL builder or the address display.
  //
  // isSorobanContractId is the canonical check for circle addresses; it is the
  // same rule used in getCircleStatus / getCircleConfig in stellar.ts and in
  // getMalformedContractAddresses in config.ts.  A 404 is the correct HTTP
  // signal ΓÇö it matches what the indexer would return for an unknown address,
  // and it keeps the not-found.tsx error UI consistent.
  if (!isSorobanContractId(params.address)) {
    notFound();
  }

  const result = await getCircleDetail(params.address);

  if (!result.ok) {
    if (result.error === "not_found") {
      notFound();
    }
    // At this point result.error is narrowed to FetchError (never "not_found")
    return (
      <div>
        <CircleHeader address={params.address} circle={null} />
        <CircleErrorBody error={result.error} />
      </div>
    );
  }

  const { data } = result;

  return (
    <div>
      <CircleHeader address={params.address} circle={data.circle} />

      <CircleDetailClient
        circleAddress={params.address}
        circleData={data}
      />
    </div>
  );
}
