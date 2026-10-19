/**
 * Indexer health model — ledger lag + checkpoint age.
 *
 * ## Why this module exists
 *
 * Raw ledger sequence differences are not actionable by themselves: a gap of
 * 500 ledgers means ~42 minutes on a live Stellar network (5 s/ledger) but
 * could represent several hours on a slow private chain or during an RPC
 * outage. Operators need *both* the sequence difference *and* an approximate
 * wall-clock age derived from a durable checkpoint timestamp to diagnose lag.
 *
 * ## Terminology
 *
 * - **ledger lag**      Raw sequence difference: tip − latestIndexedLedger.
 *                       Unit: ledgers. Chain-cadence-agnostic.
 * - **checkpoint age**  Wall-clock seconds since the indexer last confirmed
 *                       it processed a ledger. Derived from a timestamp the
 *                       indexer embeds in every API response (`checkpointTime`).
 * - **checkpoint source** Where the timestamp came from: "indexer_response"
 *                       when the field was present, "absent" when it was not.
 *
 * ## Freshness classification
 *
 * | State       | Condition                                                  |
 * |-------------|-----------------------------------------------------------|
 * | `healthy`   | lag ≤ lagThreshold AND age ≤ ageThresholdSeconds          |
 * | `degraded`  | lag > lagThreshold OR age > ageThresholdSeconds           |
 * | `unknown`   | checkpointTime absent AND latestLedger absent             |
 * | `rpc_outage`| latestLedger present, age > rpcOutageThresholdSeconds     |
 *
 * `unknown` is NEVER treated as healthy — a caller that wants to allow an
 * action on unknown freshness must do so explicitly and accept the risk.
 *
 * ## Configurability
 *
 * All thresholds have sensible defaults but can be overridden per-call so
 * operators running non-standard chains (different cadence, different expected
 * lag) can tune the classification without forking.
 */

// ─── Source label ─────────────────────────────────────────────────────────────

/**
 * Where the checkpoint timestamp came from.
 *
 * `"indexer_response"` — the indexer included a `checkpointTime` ISO-8601
 *   string in its response.  The age figure is as accurate as the indexer
 *   clock (which may be off by NTP skew, typically < 1 s).
 *
 * `"absent"` — the field was missing from the response.  The age is unknown;
 *   callers must treat freshness as `"unknown"`.
 */
export type CheckpointTimestampSource = "indexer_response" | "absent";

// ─── Health classification ────────────────────────────────────────────────────

/**
 * Coarse health classification for the indexer/chain connection.
 *
 * `healthy`    Both ledger lag and checkpoint age are within configured limits.
 * `degraded`   Either ledger lag or checkpoint age exceeds a configured limit.
 *              The indexer may be catching up, or the chain may be slow.
 * `rpc_outage` The indexer has a recent ledger number but the checkpoint age
 *              far exceeds what even a slow chain could explain — the RPC node
 *              is likely unreachable or the indexer process has stalled.
 * `unknown`    No checkpoint time and no latestLedger available — cannot
 *              classify.  Must never be mapped to healthy.
 */
export type IndexerHealthStatus = "healthy" | "degraded" | "rpc_outage" | "unknown";

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Configuration knobs for {@link classifyIndexerHealth}.
 * All values have safe, conservative defaults.
 */
export interface IndexerHealthThresholds {
  /**
   * Maximum tolerated ledger lag before the status is `degraded`.
   * Default: 100 ledgers (~8 minutes at 5 s/ledger).
   */
  maxLedgerLag?: number;
  /**
   * Maximum tolerated checkpoint age (seconds) before the status is `degraded`.
   * Default: 300 s (5 minutes) — generous enough for typical RPC jitter.
   */
  maxCheckpointAgeSec?: number;
  /**
   * Checkpoint age (seconds) that indicates the RPC node or indexer process
   * has completely stalled rather than just being slow.
   * Default: 1800 s (30 minutes).
   */
  rpcOutageThresholdSec?: number;
  /**
   * Wall-clock time used as "now" for age calculations.
   * Injected in tests to avoid real-time coupling; defaults to Date.now() / 1000.
   */
  nowSec?: number;
}

const DEFAULT_MAX_LEDGER_LAG      = 100;
const DEFAULT_MAX_CHECKPOINT_AGE  = 300;  // seconds
const DEFAULT_RPC_OUTAGE_THRESHOLD = 1800; // seconds

// ─── Result ───────────────────────────────────────────────────────────────────

/**
 * Full health picture for the indexer/chain connection.
 *
 * Consumers must always consult `status` first — individual fields may be
 * null when data is unavailable, and `status === "unknown"` must never be
 * mapped to a healthy outcome.
 */
export interface IndexerHealth {
  /**
   * Coarse classification — the single value operators act on.
   * Never `"healthy"` when `checkpointTimestampSource === "absent"`.
   */
  readonly status: IndexerHealthStatus;

  /**
   * Raw sequence difference: chainTip − latestIndexedLedger.
   * null when `latestLedger` was not in the indexer response.
   */
  readonly ledgerLag: number | null;

  /**
   * Latest ledger sequence number the indexer has confirmed it processed.
   * null when absent from the response.
   */
  readonly latestLedger: number | null;

  /**
   * Approximate wall-clock seconds since the indexer last processed a ledger,
   * derived from `checkpointTime`.
   * null when `checkpointTimestampSource === "absent"` or when the timestamp
   * was unparseable.
   */
  readonly checkpointAgeSec: number | null;

  /**
   * The raw ISO-8601 checkpoint timestamp string from the indexer, exactly
   * as received. null when the field was absent from the response.
   * Preserved so callers can format it independently (e.g. "last seen 3 m ago").
   */
  readonly checkpointTime: string | null;

  /**
   * Where the checkpoint timestamp came from.
   * Always present so callers can explain the provenance of the age figure.
   */
  readonly checkpointTimestampSource: CheckpointTimestampSource;

  /**
   * Human-readable explanation of the current status, suitable for display in
   * an operator-facing diagnostic panel. Never null — even `unknown` gets a
   * description that does not pretend to be healthy.
   */
  readonly statusDescription: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify indexer health from available data.
 *
 * Pure function — no I/O, safe to call in tests without mocking.
 *
 * @param latestLedger     The highest ledger the indexer reports having processed.
 *                         null when absent from the indexer response.
 * @param chainTipLedger   The current chain-tip ledger from an RPC call.
 *                         null when the RPC is unreachable.
 * @param checkpointTime   ISO-8601 timestamp string from the indexer response,
 *                         or null when the field was absent.
 * @param thresholds       Optional overrides for classification thresholds.
 */
export function classifyIndexerHealth(
  latestLedger: number | null,
  chainTipLedger: number | null,
  checkpointTime: string | null,
  thresholds: IndexerHealthThresholds = {},
): IndexerHealth {
  const maxLag      = thresholds.maxLedgerLag           ?? DEFAULT_MAX_LEDGER_LAG;
  const maxAge      = thresholds.maxCheckpointAgeSec    ?? DEFAULT_MAX_CHECKPOINT_AGE;
  const outageLimit = thresholds.rpcOutageThresholdSec  ?? DEFAULT_RPC_OUTAGE_THRESHOLD;
  const nowSec      = thresholds.nowSec                 ?? Date.now() / 1000;

  // ── Checkpoint age ──────────────────────────────────────────────────────────

  const source: CheckpointTimestampSource =
    checkpointTime != null ? "indexer_response" : "absent";

  let checkpointAgeSec: number | null = null;
  if (checkpointTime != null) {
    const parsed = Date.parse(checkpointTime);
    if (!isNaN(parsed)) {
      // Guard against clock skew: clamp to zero so a future timestamp (e.g.
      // the indexer's clock is slightly ahead of the client) doesn't produce
      // a negative age.
      checkpointAgeSec = Math.max(0, nowSec - parsed / 1000);
    }
  }

  // ── Ledger lag ──────────────────────────────────────────────────────────────

  const ledgerLag: number | null =
    chainTipLedger != null && latestLedger != null
      ? chainTipLedger - latestLedger
      : null;

  // ── Classification ──────────────────────────────────────────────────────────
  //
  // Priority order:
  //   1. unknown  — no checkpoint AND no latestLedger (no signal at all)
  //   2. rpc_outage — age wildly exceeds the outage threshold
  //   3. degraded — either lag or age exceeds its soft limit
  //   4. healthy  — both within limits

  if (source === "absent" && latestLedger == null) {
    return build("unknown", latestLedger, ledgerLag, checkpointAgeSec, checkpointTime, source,
      "No checkpoint timestamp and no latest-ledger sequence available. " +
      "Indexer freshness cannot be determined.");
  }

  // RPC outage: checkpoint is available and extremely stale
  if (checkpointAgeSec != null && checkpointAgeSec > outageLimit) {
    return build("rpc_outage", latestLedger, ledgerLag, checkpointAgeSec, checkpointTime, source,
      `Indexer checkpoint is ${formatAge(checkpointAgeSec)} old, which exceeds the ` +
      `${formatAge(outageLimit)} outage threshold. The RPC node or indexer process may have stalled.`);
  }

  // Degraded: age exceeds soft limit
  if (checkpointAgeSec != null && checkpointAgeSec > maxAge) {
    return build("degraded", latestLedger, ledgerLag, checkpointAgeSec, checkpointTime, source,
      `Indexer checkpoint is ${formatAge(checkpointAgeSec)} old (limit: ${formatAge(maxAge)}). ` +
      "The indexer may be catching up with the chain.");
  }

  // Degraded: ledger lag exceeds soft limit
  if (ledgerLag != null && ledgerLag > maxLag) {
    return build("degraded", latestLedger, ledgerLag, checkpointAgeSec, checkpointTime, source,
      `Ledger lag is ${ledgerLag} (limit: ${maxLag}). ` +
      "The indexer may be behind the chain tip.");
  }

  // No checkpoint but latestLedger is present: partial signal.
  // We can report the ledger number but cannot assess age — degrade rather
  // than claim healthy.
  if (source === "absent" && latestLedger != null) {
    // If we also have lag data and it exceeds the limit, degrade on that.
    if (ledgerLag != null && ledgerLag > maxLag) {
      return build("degraded", latestLedger, ledgerLag, null, null, source,
        `Ledger lag is ${ledgerLag} (limit: ${maxLag}). ` +
        "No checkpoint timestamp available to assess processing age.");
    }
    // Lag OK but no age data — cannot confirm healthy.
    return build("degraded", latestLedger, ledgerLag, null, null, source,
      "No checkpoint timestamp in the indexer response. " +
      "Processing age is unknown; treating as degraded to avoid false-healthy signal.");
  }

  // All limits satisfied
  const agePart = checkpointAgeSec != null
    ? ` Checkpoint age: ${formatAge(checkpointAgeSec)}.`
    : "";
  const lagPart = ledgerLag != null ? ` Ledger lag: ${ledgerLag}.` : "";
  return build("healthy", latestLedger, ledgerLag, checkpointAgeSec, checkpointTime, source,
    `Indexer is current.${lagPart}${agePart}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function build(
  status: IndexerHealthStatus,
  latestLedger: number | null,
  ledgerLag: number | null,
  checkpointAgeSec: number | null,
  checkpointTime: string | null,
  checkpointTimestampSource: CheckpointTimestampSource,
  statusDescription: string,
): IndexerHealth {
  return {
    status,
    ledgerLag,
    latestLedger,
    checkpointAgeSec,
    checkpointTime,
    checkpointTimestampSource,
    statusDescription,
  };
}

/** Format a duration in seconds as a human-readable string for status messages. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
