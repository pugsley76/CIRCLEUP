// ΓöÇΓöÇΓöÇ Deadline display model (Issue: stale ledger data must not look exact) ΓöÇΓöÇΓöÇ
//
// Deadline indicators are derived from ledger estimates (deadline_ledger from
// the indexer, latestLedger from the indexer's tip). Ledger production (~5 s
// per ledger) and indexing can lag, so a countdown that ticks down to the
// second looks far more precise than its inputs justify.  This module defines
// the shared display model so every deadline surface communicates freshness
// honestly:
//
//   ΓÇó "unavailable"  ΓÇö deadline_ledger or latestLedger is missing ΓåÆ no countdown
//   ΓÇó "stale"        ΓÇö data older than MAX_DATA_AGE_MS ΓåÆ last-known value shown
//                      as a static estimate, never as a live countdown
//   ΓÇó "fresh"        ΓåÆ countdown shown, still labelled as an estimate (~5 s/
//                      ledger is an approximation, not a wall-clock promise)
//
// Contract validation (lib/gating.ts) remains authoritative for every
// deadline-sensitive action; this module only concerns presentation.

/** Maximum age of indexed data before the deadline is treated as stale. */
export const DEADLINE_MAX_DATA_AGE_MS = 2 * 60 * 1000; // 2 minutes

/** Approximate seconds per Stellar ledger. Wall-clock conversion is always an estimate. */
export const SECONDS_PER_LEDGER = 5;

export type DeadlineDataKind = "fresh" | "stale" | "unavailable";

export interface DeadlineDisplay {
  /** Whether the underlying ledger data is fresh, stale, or unavailable. */
  readonly kind: DeadlineDataKind;
  /** Ledgers between the latest indexed ledger and the deadline ledger. */
  readonly ledgersRemaining: number | null;
  /** Seconds remaining (ledgersRemaining ├ù ~5 s). Always an estimate. */
  readonly secondsRemaining: number | null;
  /** Human-readable duration, e.g. "2h 15m". Null when unavailable. */
  readonly human: string;
  readonly isOverdue: boolean;
  readonly urgency: "green" | "yellow" | "red";
  /** Label shown above the countdown. Always signals estimate status. */
  readonly label: string;
  /** Wall-clock age of the data in ms (null when unavailable). */
  readonly dataAgeMs: number | null;
  /** Wall-clock timing is always an estimate ΓÇö never presented as exact. */
  readonly isEstimate: true;
  /**
   * ISO-8601 checkpoint timestamp from the indexer, forwarded for display.
   * null when the field was absent from the response — absence must never be
   * treated as a healthy or "fresh" signal.
   */
  readonly checkpointTime: string | null;
}

export function ledgersToHuman(ledgers: number): string {
  if (ledgers <= 0) return "overdue";
  const totalSeconds = ledgers * SECONDS_PER_LEDGER;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Compute how a round deadline should be displayed, given the indexed ledger
 * heights and the age of the data.
 *
 * The boundary for staleness is inclusive: data exactly `maxDataAgeMs` old is
 * already stale.
 */
export function computeDeadlineDisplay({
  deadlineLedger,
  latestLedger,
  status,
  fetchedAtMs,
  checkpointTime = null,
  nowMs = Date.now(),
  maxDataAgeMs = DEADLINE_MAX_DATA_AGE_MS,
}: {
  deadlineLedger: number | null | undefined;
  latestLedger: number | null | undefined;
  status: string;
  fetchedAtMs: number;
  checkpointTime?: string | null;
  nowMs?: number;
  maxDataAgeMs?: number;
}): DeadlineDisplay {
  // Missing ledger data ΓåÆ never fabricate a countdown.
  if (deadlineLedger == null || latestLedger == null) {
    return {
      kind: "unavailable",
      ledgersRemaining: null,
      secondsRemaining: null,
      human: "ΓÇö",
      isOverdue: false,
      urgency: "green",
      label: "Deadline data not available",
      dataAgeMs: null,
      isEstimate: true,
      checkpointTime,
    };
  }

  const dataAgeMs = nowMs - fetchedAtMs;
  const isStale = dataAgeMs >= maxDataAgeMs;

  const ledgersRemaining = deadlineLedger - latestLedger;
  const isOverdue = ledgersRemaining <= 0;
  const secondsRemaining = ledgersRemaining * SECONDS_PER_LEDGER;
  const human = ledgersToHuman(ledgersRemaining);

  const urgency =
    isOverdue || secondsRemaining < 86_400
      ? "red"
      : secondsRemaining < 2 * 86_400
      ? "yellow"
      : "green";

  const label = isOverdue
    ? "Payout overdue"
    : urgency === "yellow"
      ? "Deadline approaching"
      : "Time remaining";

  return {
    kind: isStale ? "stale" : "fresh",
    ledgersRemaining,
    secondsRemaining,
    human,
    isOverdue,
    urgency,
    label: isStale ? `${label} (data may be stale)` : `${label} (estimate)`,
    dataAgeMs,
    isEstimate: true,
    checkpointTime,
  };
}
