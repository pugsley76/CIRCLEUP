/**
 * Issue #463: Structured log schema for CircleUp indexer lifecycle events.
 *
 * Replaces scattered `console.error` / `console.warn` / `console.log` calls
 * with a single `log()` helper that emits machine-parseable JSON lines.
 * Every event has a `level`, `msg`, and `ts` (ISO timestamp) field; optional
 * contextual fields narrow to specific subtypes so log aggregators can filter
 * and alert on individual lifecycle stages without string-matching.
 *
 * Levels follow the standard syslog-inspired scale:
 *   debug   — high-frequency lifecycle chatter (event ingested, ledger advanced)
 *   info    — normal operational milestones (indexer started, poll completed)
 *   warn    — recoverable anomalies (transient RPC failure, backoff applied)
 *   error   — non-fatal failures (event handler error, DB write failed for one event)
 *   fatal   — process-level failures that will terminate (missing config, migration error)
 *
 * Transport: structured JSON to stdout by default, which is what log
 * aggregators (CloudWatch Logs, Loki, Datadog, etc.) expect when running
 * in a container. Override with `configureLogger({ transport })` to swap in
 * a different sink (e.g. pino, winston, or a test spy).
 *
 * Privacy: addresses and transaction hashes are redacted via the shared
 * `redactAddress` / `redactTxHash` helpers before being embedded in log fields.
 * Raw Stellar addresses and full hashes must never appear in log output.
 *
 * Usage:
 *   import { log } from "./logger";
 *
 *   log("info", "poll_completed", {
 *     fromLedger: 1000,
 *     toLedger: 1010,
 *     eventsProcessed: 3,
 *     eventsFailed: 0,
 *     durationMs: 120,
 *   });
 *
 *   log("warn", "rpc_retry", {
 *     attempt: 2,
 *     maxAttempts: 4,
 *     delayMs: 1000,
 *     error: "ECONNRESET",
 *     label: "getEvents(factory+reputation)",
 *   });
 */

import { redactAddress, redactTxHash } from "./redact";

// ─── Log level ────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

// ─── Event catalogue ──────────────────────────────────────────────────────────
//
// Every distinct log event has a stable string key. Consumers can alert on
// these keys without parsing the human-readable message. Keys are snake_case
// and organised by lifecycle area:
//
//   indexer_*   — process / poller lifecycle
//   poll_*      — one poll cycle
//   ledger_*    — per-ledger processing
//   event_*     — individual Soroban event ingest
//   rpc_*       — Soroban RPC interactions
//   db_*        — Postgres interactions
//   health_*    — health check results
//   config_*    — startup validation
//   migration_* — schema migration
//   api_*       — HTTP API request / response

export type LogEventKey =
  // Indexer lifecycle
  | "indexer_started"
  | "indexer_stopped"
  | "indexer_already_running"
  | "indexer_tick_skipped"          // previous poll still in flight
  // Poll cycle
  | "poll_completed"
  | "poll_failed"
  | "poll_backoff"                  // consecutive failures, backoff applied
  // Ledger processing
  | "ledger_processed"
  | "ledger_gap_detected"           // ledgers with no events in the range
  // Soroban event ingest
  | "event_ingested"
  | "event_skipped"                 // duplicate — already in ingested_events
  | "event_handler_error"           // handler threw; savepoint rolled back
  | "event_failure_evidence_failed" // could not persist event_failures evidence
  // RPC
  | "rpc_retry"                     // transient error, retrying with backoff
  | "rpc_failed"                    // all retry attempts exhausted
  | "rpc_stale"                     // ledger height unchanged across polls
  // Database
  | "db_error"
  // Health checks
  | "health_check_completed"
  | "health_check_degraded"
  // Config / startup
  | "config_missing_vars"
  | "config_invalid_value"
  // Migration
  | "migration_applied"
  | "migration_failed"
  | "migration_drifted"
  // HTTP API
  | "api_request"                   // route request completed
  | "api_request_error"             // unhandled error in a route handler
  | "api_cors_rejected";            // request rejected by CORS policy

// ─── Per-event context types ──────────────────────────────────────────────────
//
// Each event key narrows to a specific context shape. The union here acts as
// documentation and provides IntelliSense when calling log(). Strings that
// might carry addresses or hashes are redacted before storage — see log().

export interface IndexerStartedCtx {
  pollIntervalMs: number;
  eventsLimit: number;
  startLedger: number;
}

export interface PollCompletedCtx {
  fromLedger: number;
  toLedger: number;
  eventsProcessed: number;
  eventsFailed: number;
  durationMs: number;
}

export interface PollFailedCtx {
  error: string;
  consecutiveFailures: number;
  backoffMs: number;
}

export interface PollBackoffCtx {
  consecutiveFailures: number;
  currentIntervalMs: number;
}

export interface LedgerProcessedCtx {
  ledger: number;
  processed: number;
  failed: number;
  /** Wall-clock time in milliseconds for the entire per-ledger transaction. */
  latencyMs?: number;
  /** Number of events that were skipped as duplicates (already in ingested_events). */
  skipped?: number;
}

export interface LedgerGapCtx {
  gaps: number[];
  fromLedger: number;
  toLedger: number;
}

export interface EventIngestedCtx {
  ledger: number;
  eventType: string;          // e.g. "circle:contributed"
  contractId: string;         // REDACTED before log
  txHash?: string;            // REDACTED before log
}

export interface EventSkippedCtx {
  ledger: number;
  eventType: string;
  contractId: string;         // REDACTED before log
}

export interface EventHandlerErrorCtx {
  ledger: number;
  eventType: string;
  contractId: string;         // REDACTED before log
  txHash?: string;            // REDACTED before log
  /** RPC event id — payload-free; matches event_failures.event_id. */
  eventId?: string;
  /** "transient" (ledger rolled back, will retry) or "permanent" (skipped). */
  errorClass?: "transient" | "permanent";
  error: string;
}

export interface RpcRetryCtx {
  label: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
}

export interface RpcFailedCtx {
  label: string;
  attempts: number;
  error: string;
}

export interface DbErrorCtx {
  operation: string;
  error: string;
}

export interface HealthCheckCompletedCtx {
  status: "ok" | "degraded";
  db: string;
  rpc: string;
  indexerLag: string;
  schema: string;
  contractDrift: string;
  durationMs: number;
}

export interface HealthCheckDegradedCtx {
  component: string;
  reason: string;
}

export interface ConfigCtx {
  missingVars?: string[];
  invalidKey?: string;
  detail?: string;
}

export interface MigrationCtx {
  version?: string;
  error?: string;
  summary?: string;
}

export interface ApiRequestCtx {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}

export interface ApiRequestErrorCtx {
  method: string;
  path: string;
  statusCode?: number;
  error: string;
}

export interface ApiCorsRejectedCtx {
  method: string;
  path: string;
  origin?: string;
}

// Generic fallback for events without a specific shape
export type LogContext = Record<string, unknown>;

// ─── Transport ────────────────────────────────────────────────────────────────

export type LogTransport = (entry: LogEntry) => void;

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: LogEventKey;
  msg: string;
  [key: string]: unknown;
}

function defaultTransport(entry: LogEntry): void {
  // JSON-per-line format: compatible with CloudWatch, Loki, Datadog, etc.
  // eslint-disable-next-line no-console
  const output = JSON.stringify(entry, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (entry.level === "error" || entry.level === "fatal") {
    // eslint-disable-next-line no-console
    console.error(output);
  } else if (entry.level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(output);
  } else {
    // eslint-disable-next-line no-console
    console.log(output);
  }
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _transport: LogTransport = defaultTransport;
let _minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

/**
 * Override the log transport or minimum level.
 *
 * Call once at startup (e.g. in index.ts) before the first log event.  Useful
 * in tests to install a spy or suppress output.
 *
 * @example
 * configureLogger({ minLevel: "debug" });
 *
 * // In tests:
 * const events: LogEntry[] = [];
 * configureLogger({ transport: (e) => events.push(e) });
 */
export function configureLogger(opts: {
  transport?: LogTransport;
  minLevel?: LogLevel;
}): void {
  if (opts.transport !== undefined) _transport = opts.transport;
  if (opts.minLevel !== undefined) _minLevel = opts.minLevel;
}

/** Reset to defaults (for tests). */
export function resetLogger(): void {
  _transport = defaultTransport;
  _minLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
}

// ─── Core log function ────────────────────────────────────────────────────────

/**
 * Emit one structured log event.
 *
 * Addresses (`contractId`, `txHash`) in the context are automatically redacted
 * via the shared `redactAddress` / `redactTxHash` helpers so raw Stellar
 * addresses never appear in log output.
 *
 * The call is fire-and-forget: a throwing transport never affects the caller.
 *
 * @param level   Severity level.
 * @param event   Stable machine-readable event key.
 * @param ctx     Optional contextual fields merged into the log entry.
 * @param msg     Optional human-readable override; defaults to the event key.
 */
export function log(
  level: LogLevel,
  event: LogEventKey,
  ctx: LogContext = {},
  msg?: string,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[_minLevel]) return;

  try {
    const redacted = redactContext(ctx);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      msg: msg ?? event,
      ...redacted,
    };
    _transport(entry);
  } catch {
    // A misbehaving transport must never affect the indexer.
  }
}

// ─── Address / hash redaction ─────────────────────────────────────────────────

/**
 * Redact known sensitive fields in a log context object.
 *
 * Recursively processes the context, applying address and hash redaction to
 * any string value under the keys `contractId`, `txHash`, `circleAddress`,
 * `memberAddress`, `creator`, and `recipient`.  Other fields pass through
 * unchanged.
 */
function redactContext(ctx: LogContext): LogContext {
  const ADDRESS_KEYS = new Set([
    "contractId", "circleAddress", "memberAddress", "creator", "recipient",
  ]);
  const HASH_KEYS = new Set(["txHash"]);

  const out: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (typeof value === "string") {
      if (ADDRESS_KEYS.has(key)) {
        out[key] = redactAddress(value);
      } else if (HASH_KEYS.has(key)) {
        out[key] = redactTxHash(value);
      } else {
        out[key] = value;
      }
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactContext(value as LogContext);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────
//
// Named wrappers for each lifecycle event so call-sites don't have to remember
// which context shape belongs to which key. IDE completion surfaces the right
// fields automatically.

/** Indexer process started. */
export function logIndexerStarted(ctx: IndexerStartedCtx): void {
  log("info", "indexer_started", ctx as LogContext,
    `CircleUp indexer started (poll: ${ctx.pollIntervalMs}ms, limit: ${ctx.eventsLimit})`);
}

/** Indexer process stopped cleanly. */
export function logIndexerStopped(): void {
  log("info", "indexer_stopped", {}, "Event poller stopped cleanly");
}

/** A poll tick was skipped because the previous one is still running. */
export function logTickSkipped(): void {
  log("warn", "indexer_tick_skipped", {}, "Previous poll still in flight — skipping overlapping tick");
}

/** A poll cycle completed successfully. */
export function logPollCompleted(ctx: PollCompletedCtx): void {
  log(
    ctx.eventsFailed > 0 ? "warn" : "info",
    "poll_completed",
    ctx as LogContext,
    `Processed ledgers ${ctx.fromLedger}-${ctx.toLedger}: ` +
      `${ctx.eventsProcessed} event(s), ${ctx.eventsFailed} failed, ${ctx.durationMs}ms`,
  );
}

/** A poll cycle failed (after retries). */
export function logPollFailed(ctx: PollFailedCtx): void {
  log("error", "poll_failed", ctx as LogContext,
    `Poll error (consecutive failures: ${ctx.consecutiveFailures}): ${ctx.error}`);
}

/** Repeated poll failures — backoff is active. */
export function logPollBackoff(ctx: PollBackoffCtx): void {
  log("warn", "poll_backoff", ctx as LogContext,
    `Poll has failed ${ctx.consecutiveFailures} consecutive times. ` +
      `Backoff interval: ${Math.floor(ctx.currentIntervalMs / 1000)}s`);
}

/** One ledger's event batch was processed. */
export function logLedgerProcessed(ctx: LedgerProcessedCtx): void {
  const latencyStr = ctx.latencyMs !== undefined ? `, ${ctx.latencyMs}ms` : "";
  const skippedStr = ctx.skipped !== undefined && ctx.skipped > 0 ? `, ${ctx.skipped} skipped` : "";
  log("debug", "ledger_processed", ctx as LogContext,
    `Ledger ${ctx.ledger}: ${ctx.processed} processed, ${ctx.failed} failed${skippedStr}${latencyStr}`);
}

/** Ledger gaps detected in a poll range. */
export function logLedgerGaps(ctx: LedgerGapCtx): void {
  log("debug", "ledger_gap_detected", ctx as LogContext,
    `${ctx.gaps.length} ledger gap(s) in ${ctx.fromLedger}-${ctx.toLedger}`);
}

/** A Soroban event was successfully ingested. */
export function logEventIngested(ctx: EventIngestedCtx): void {
  log("debug", "event_ingested", ctx as LogContext,
    `Event ingested: ${ctx.eventType} at ledger ${ctx.ledger}`);
}

/** A Soroban event was skipped as a duplicate. */
export function logEventSkipped(ctx: EventSkippedCtx): void {
  log("debug", "event_skipped", ctx as LogContext,
    `Event skipped (duplicate): ${ctx.eventType} at ledger ${ctx.ledger}`);
}

/** An event handler threw; savepoint was rolled back. */
export function logEventHandlerError(ctx: EventHandlerErrorCtx): void {
  const outcome =
    ctx.errorClass === "transient" ? " (transient — ledger will be retried)" : "";
  log("error", "event_handler_error", ctx as LogContext,
    `Failed to process ${ctx.eventType} event at ledger ${ctx.ledger}${outcome}: ${ctx.error}`);
}

/** A transient RPC call is being retried. */
export function logRpcRetry(ctx: RpcRetryCtx): void {
  log("warn", "rpc_retry", ctx as LogContext,
    `Transient RPC failure during ${ctx.label} ` +
      `(attempt ${ctx.attempt}/${ctx.maxAttempts}): ${ctx.error} — retrying in ${ctx.delayMs}ms`);
}

/** All RPC retry attempts exhausted. */
export function logRpcFailed(ctx: RpcFailedCtx): void {
  log("error", "rpc_failed", ctx as LogContext,
    `Soroban RPC ${ctx.label} failed after ${ctx.attempts} attempt(s): ${ctx.error}`);
}

/** A health check completed. */
export function logHealthCheck(ctx: HealthCheckCompletedCtx): void {
  log(
    ctx.status === "ok" ? "debug" : "warn",
    ctx.status === "ok" ? "health_check_completed" : "health_check_degraded",
    ctx as LogContext,
    `Health check: ${ctx.status} (${ctx.durationMs}ms)`,
  );
}

/** Startup failed due to missing environment variables. */
export function logConfigMissing(vars: string[]): void {
  log("fatal", "config_missing_vars", { missingVars: vars } as LogContext,
    `Missing required environment variable(s): ${vars.join(", ")}`);
}

/** A migration was applied. */
export function logMigrationApplied(ctx: MigrationCtx): void {
  log("info", "migration_applied", ctx as LogContext,
    `Migration applied: ${ctx.version ?? "unknown"}`);
}

/** A migration failed. */
export function logMigrationFailed(ctx: MigrationCtx): void {
  log("fatal", "migration_failed", ctx as LogContext,
    `Migration failed: ${ctx.error ?? "unknown error"}`);
}

/** A REST API request completed successfully or with a client error. */
export function logApiRequest(ctx: ApiRequestCtx): void {
  log(
    ctx.statusCode >= 500 ? "error" : ctx.statusCode >= 400 ? "warn" : "info",
    "api_request",
    ctx as LogContext,
    `${ctx.method} ${ctx.path} -> ${ctx.statusCode} (${ctx.durationMs}ms)`,
  );
}

/** A REST API request failed and was converted to an HTTP error response. */
export function logApiRequestError(ctx: ApiRequestErrorCtx): void {
  log(
    "error",
    "api_request_error",
    ctx as LogContext,
    `${ctx.method} ${ctx.path} failed: ${ctx.error}`,
  );
}

/** A CORS request was rejected before the route handler ran. */
export function logApiCorsRejected(ctx: ApiCorsRejectedCtx): void {
  log(
    "warn",
    "api_cors_rejected",
    ctx as LogContext,
    `CORS rejected for ${ctx.method} ${ctx.path}${ctx.origin ? ` from ${ctx.origin}` : ""}`,
  );
}
/**
 * Issue #463: Tests for the structured logger (indexer/src/logger.ts).
 *
 * Verifies that:
 *   - Every log event produces a well-formed JSON-line entry with ts, level,
 *     event, and msg fields.
 *   - The minimum log level filter suppresses events below the threshold.
 *   - Sensitive fields (contractId, txHash) are redacted before emission.
 *   - The transport is fire-and-forget: a throwing transport never propagates.
 *   - All named convenience wrappers emit the correct event key and level.
 *   - configureLogger / resetLogger work correctly.
 */
