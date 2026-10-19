"use client";

import { useState, useEffect, useCallback } from "react";
import { indexerEndpoint, shortAddress } from "@/lib/config";
import { ReputationBadge, ReputationLegend } from "@/components/ReputationBadge";
import { isCanonicalStellarAddress } from "@/lib/address";
// Issue #513: ReputationResponse is now the shared type from circleTypes.ts.
// parseReputationResponse validates the raw JSON at the network boundary
// instead of the previous bare `as ReputationResponse` cast.
import { type ReputationResponse, parseReputationResponse } from "@/lib/circleTypes";

// ─── Reputation event naming & total score semantics ──────────────────────────
//
// Issue #565: the indexer emits reputation events whose `type` field is a
// free-form string. Historically the UI rendered that raw string verbatim,
// which produced inconsistent, ambiguous labels (e.g. "tip_received" vs
// "Tip Received" vs "tip") and made the running total impossible to audit.
//
// We normalise the raw event type to a canonical, human-readable label and
// expose a single, well-defined total. The total is the sum of the signed
// `delta` of every event; it is NOT the sum of the displayed magnitudes, so a
// negative event (e.g. a slash) correctly reduces the total. This keeps the
// displayed total consistent with the on-chain reputation score.

/** Canonical reputation event kinds, in the order they are documented. */
export type ReputationEventKind =
  | "tip_received"
  | "tip_sent"
  | "slash"
  | "bonus"
  | "unknown";

/** Human-readable labels for each canonical event kind. */
const EVENT_LABELS: Record<ReputationEventKind, string> = {
  tip_received: "Tip received",
  tip_sent: "Tip sent",
  slash: "Slash",
  bonus: "Bonus",
  unknown: "Other activity",
};

/**
 * Normalise a raw indexer event type into a canonical kind.
 *
 * The indexer has emitted several spellings over time (snake_case, kebab-case,
 * and spaced variants). Mapping them here keeps the UI stable and unambiguous
 * regardless of which spelling the indexer currently uses.
 */
export function normaliseEventKind(raw: string): ReputationEventKind {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "tip_received":
    case "tipreceived":
    case "received_tip":
      return "tip_received";
    case "tip_sent":
    case "tipsent":
    case "sent_tip":
      return "tip_sent";
    case "slash":
    case "slashed":
    case "penalty":
      return "slash";
    case "bonus":
    case "reward":
      return "bonus";
    default:
      return "unknown";
  }
}

/** Human-readable label for a raw event type. */
export function eventLabel(raw: string): string {
  return EVENT_LABELS[normaliseEventKind(raw)];
}

/**
 * Compute the reputation total from a list of events.
 *
 * The total is the signed sum of every event's `delta`. Events with a
 * non-finite delta are ignored rather than poisoning the total with NaN, so a
 * single malformed event cannot silently blank out the whole score.
 */
export function computeTotal(events: ReadonlyArray<{ delta: number }>): number {
  return events.reduce(
    (sum, e) => (Number.isFinite(e.delta) ? sum + e.delta : sum),
    0,
  );
}

// ─── Data fetching ────────────────────────────────────────────────────────────

type FetchResult =
  | { ok: true; data: ReputationResponse }
  | {
      ok: false;
      reason:
        | "not_found"
        | "network"
        | "unknown"
        | "aborted"
        | "indexer_outage"
        | "misconfigured"
        | "malformed";
    };

async function fetchReputation(member: string, signal?: AbortSignal): Promise<FetchResult> {
  // Validate the route param before making any network request. A malformed
  // address (e.g. from a manually typed URL) would otherwise reach the indexer
  // and return a 404 that looks indistinguishable from "no activity yet".
  if (!isCanonicalStellarAddress(member)) {
    return { ok: false, reason: "not_found" };
  }
  // A misconfigured NEXT_PUBLIC_INDEXER_URL must not fall through to fetch():
  // a scheme-less value is a relative URL here, so the request would hit this
  // Next app, 404, and render "No reputation record found" for a real member.
  const url = indexerEndpoint(["reputation", member]);
  if (url === null) return { ok: false, reason: "misconfigured" };
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal,
    });
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status === 503) return { ok: false, reason: "indexer_outage" };
    if (!res.ok) return { ok: false, reason: "unknown" };
    // Issue #513: validate the response shape before returning it as typed data.
    // Structural errors return "malformed" so the UI displays explicit error messaging.
    const rawJson = await res.json();
    const parsed = parseReputationResponse(rawJson);
    if (!parsed) return { ok: false, reason: "malformed" };
    return { ok: true, data: parsed };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, reason: "aborted" };
    }
    return { ok: false, reason: "network" };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReputationClient({ member }: { member: string }) {
  const [result, setResult] = useState<FetchResult | undefined>(
    // undefined = loading
    undefined,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  // Tracks successful manual refreshes to announce completion to screen readers.
  // Increments on each successful manual refresh; the sr-only live region uses
  // this as a key so it remounts (and re-announces) on every new refresh.
  const [refreshCount, setRefreshCount] = useState(0);

  const load = useCallback(
    async (isManual = false, signal?: AbortSignal) => {
      if (isManual) setRefreshing(true);
      const fetched = await fetchReputation(member, signal);
      if (signal?.aborted) return;
      setResult(fetched);
      setLastRefreshed(new Date());
      if (isManual) {
        setRefreshing(false);
        if (fetched.ok) setRefreshCount((c) => c + 1);
      }
    },
    [member],
  );

  // Initial fetch on mount; cancel on unmount or member change
  useEffect(() => {
    const controller = new AbortController();
    load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  // ── Loading state ────────────────────────────────────────────────────────────

  if (result === undefined) {
    return (
      <div
        className="text-center py-16 text-slate-500"
        role="status"
        aria-label="Loading reputation data"
      >
        <div
          className="inline-block w-8 h-8 border-4 border-slate-200 border-t-brand-600 rounded-full animate-spin mb-4"
          aria-hidden="true"
        />
        <p className="text-sm">Loading reputation…</p>
      </div>
    );
  }

  // ── Error states ─────────────────────────────────────────────────────────────

  if (!result.ok) {
    // Aborted fetches (navigation away then back) should not show error UI
    if (result.reason === "aborted") return null;

    if (result.reason === "not_found") {
      return (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3" aria-hidden="true">🔍</div>
          <p className="font-medium text-slate-800">No reputation record found.</p>
          <p className="text-sm mt-1 text-slate-500">
            This address has no on-chain activity in CircleUp yet.
          </p>
          <p className="font-mono text-xs text-slate-400 mt-2 break-all max-w-xs mx-auto">
            {member}
          </p>
        </div>
      );
    }

    const errorMessages: Record<string, string> = {
      network: "The reputation service is unreachable. Check your connection and try again.",
      unknown: "An unexpected error occurred loading reputation data.",
      indexer_outage:
        "The indexer is running but currently degraded. Reputation data may be temporarily unavailable. Try again in a few minutes.",
      misconfigured:
        "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
        "Set a valid indexer URL in app/.env.local and restart the server.",
      malformed:
        "Malformed reputation data received from server. The response payload structure is invalid.",
    };
    // Retrying cannot fix a configuration error, so don't offer it.
    const canRetry = result.reason !== "misconfigured";

    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3" aria-hidden="true">⚠️</div>
        <p className="font-medium text-slate-800">Could not load reputation</p>
        <p className="text-sm mt-1 text-slate-500">
          {errorMessages[result.reason] ?? errorMessages.unknown}
        </p>
        {canRetry && (
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="mt-4 text-sm text-brand-600 hover:underline disabled:opacity-50"
          >
            {refreshing ? "Retrying…" : "Try again"}
          </button>
        )}
      </div>
    );
  }

  // ── Loaded ───────────────────────────────────────────────────────────────────

  const { data } = result;

  const events = data.events ?? [];
  const total = events.length > 0 ? computeTotal(events) : data.score;
  const isNoRecord = !data.found || (data.score === null && events.length === 0);

  return (
    <div className="max-w-xl mx-auto space-y-6">
      {/*
        Screen-reader announcement for manual refresh completion.
      */}
      {refreshCount > 0 && (
        <span
          key={refreshCount}
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {isNoRecord
            ? "Reputation data updated. No reputation record recorded yet."
            : `Reputation data updated. Total score: ${total}.`}
        </span>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reputation</h1>
          <p
            className="font-mono text-sm text-slate-500 mt-1 break-all"
            aria-label={`Member address: ${member}`}
          >
            {member}
          </p>
        </div>

        {/* Refresh button */}
        <div className="shrink-0 text-right">
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            aria-label="Refresh reputation data"
            className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {lastRefreshed && (
            <p className="text-xs text-slate-400 mt-1">
              Updated {lastRefreshed.toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>

      {/* State display card */}
      {isNoRecord ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center space-y-3">
          <div className="text-3xl" aria-hidden="true">🌱</div>
          <h2 className="text-lg font-semibold text-slate-800">No Reputation Record Yet</h2>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            {data.detail ??
              "This address has no on-chain reputation record or circle participation history on CircleUp yet."}
          </p>
          <div className="pt-2 flex justify-center">
            <ReputationBadge score={null} />
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm text-slate-500">Total reputation score</p>
          <p
            className="text-4xl font-bold text-slate-900 mt-1"
            aria-label={`Total reputation score: ${total}`}
          >
            {total ?? 0}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {events.length > 0
              ? "Signed sum of all reputation events."
              : "On-chain reputation score recorded by contract."}
          </p>
        </div>
      )}

      {/* Event list */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-2">
          Reputation events
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">No reputation events recorded.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {events.map((event, i) => (
              <li
                key={`${event.type}-${i}`}
                className="flex items-center justify-between px-4 py-3"
              >
                <span className="text-sm text-slate-700">
                  {eventLabel(event.type)}
                </span>
                <span
                  className={
                    event.delta >= 0
                      ? "text-sm font-medium text-emerald-600"
                      : "text-sm font-medium text-red-600"
                  }
                >
                  {event.delta >= 0 ? `+${event.delta}` : event.delta}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Badge + legend */}
      <div className="flex flex-col items-center gap-3">
        {!isNoRecord && <ReputationBadge score={total} />}
        <ReputationLegend />
      </div>
    </div>
  );
}
