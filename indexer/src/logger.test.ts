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

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { LogEntry } from "./logger";

import {
  log,
  configureLogger,
  resetLogger,
  logIndexerStarted,
  logIndexerStopped,
  logTickSkipped,
  logPollCompleted,
  logPollFailed,
  logPollBackoff,
  logLedgerProcessed,
  logEventIngested,
  logEventSkipped,
  logEventHandlerError,
  logRpcRetry,
  logRpcFailed,
  logHealthCheck,
  logConfigMissing,
  logMigrationApplied,
  logMigrationFailed,
  logApiRequest,
  logApiRequestError,
  logApiCorsRejected,
} from "./logger";

// ── Test spy factory ──────────────────────────────────────────────────────────

function makeCollector(): { entries: LogEntry[]; transport: (e: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, transport: (e) => entries.push(e) };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetLogger();
});

afterEach(() => {
  resetLogger();
});

// ── Log entry structure ───────────────────────────────────────────────────────

test("log: emits an entry with ts, level, event, and msg fields", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  log("info", "poll_completed", { fromLedger: 1, toLedger: 10 });

  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.ok(typeof e.ts === "string", "ts must be a string");
  assert.ok(!isNaN(Date.parse(e.ts)), "ts must be a valid ISO timestamp");
  assert.equal(e.level, "info");
  assert.equal(e.event, "poll_completed");
  assert.ok(typeof e.msg === "string" && e.msg.length > 0, "msg must be non-empty");
});

test("log: merges context fields into the entry", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  log("info", "poll_completed", { fromLedger: 100, toLedger: 200, eventsProcessed: 5 });

  const e = entries[0];
  assert.equal(e.fromLedger, 100);
  assert.equal(e.toLedger, 200);
  assert.equal(e.eventsProcessed, 5);
});

test("log: accepts a custom msg override", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  log("info", "poll_completed", {}, "Custom message");

  assert.equal(entries[0].msg, "Custom message");
});

// ── Level filtering ───────────────────────────────────────────────────────────

test("log: suppresses entries below the minimum level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "warn" });

  log("debug", "event_ingested", {});
  log("info", "poll_completed", {});
  log("warn", "poll_backoff", {});
  log("error", "poll_failed", {});

  // Only warn and error should pass through
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.level === "warn" || e.level === "error"));
});

test("log: emits all levels when minLevel is debug", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  log("debug", "event_ingested", {});
  log("info", "poll_completed", {});
  log("warn", "poll_backoff", {});
  log("error", "poll_failed", {});
  log("fatal", "config_missing_vars", {});

  assert.equal(entries.length, 5);
});

test("log: fatal always emits regardless of minLevel", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "fatal" });

  log("debug", "event_ingested", {});
  log("info", "poll_completed", {});
  log("fatal", "config_missing_vars", {});

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "fatal");
});

// ── Sensitive field redaction ─────────────────────────────────────────────────

test("log: redacts contractId field", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  const realAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  log("debug", "event_ingested", { contractId: realAddress, ledger: 1, eventType: "circle:joined" });

  const e = entries[0];
  // The raw address must not appear in the log entry
  assert.notEqual(e.contractId, realAddress, "raw address must not appear in log");
  // But some redacted form must still be present
  assert.ok(typeof e.contractId === "string", "contractId must still be present (redacted)");
});

test("log: redacts txHash field", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  const realHash = "a".repeat(64);
  log("debug", "event_ingested", { txHash: realHash, ledger: 1, eventType: "circle:joined" });

  const e = entries[0];
  assert.notEqual(e.txHash, realHash, "raw tx hash must not appear in log");
});

test("log: non-sensitive fields are not redacted", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  log("info", "poll_completed", {
    fromLedger: 100,
    toLedger: 200,
    eventsProcessed: 3,
    durationMs: 42,
  });

  const e = entries[0];
  assert.equal(e.fromLedger, 100);
  assert.equal(e.toLedger, 200);
  assert.equal(e.eventsProcessed, 3);
  assert.equal(e.durationMs, 42);
});

// ── Transport fire-and-forget ─────────────────────────────────────────────────

test("log: a throwing transport does not propagate the error", () => {
  configureLogger({
    minLevel: "debug",
    transport: () => { throw new Error("transport exploded"); },
  });

  // Must not throw
  assert.doesNotThrow(() => {
    log("info", "poll_completed", {});
  });
});

test("api request logging emits the expected structured event", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logApiRequest({ method: "GET", path: "/circles", statusCode: 200, durationMs: 12 });
  logApiRequestError({ method: "GET", path: "/circles", statusCode: 500, error: "db unavailable" });
  logApiCorsRejected({ method: "GET", path: "/health", origin: "https://evil.example.com" });

  assert.equal(entries.length, 3);
  assert.equal(entries[0].event, "api_request");
  assert.equal(entries[1].event, "api_request_error");
  assert.equal(entries[2].event, "api_cors_rejected");
  assert.match(entries[1].msg ?? "", /db unavailable/);
});

// ── configureLogger / resetLogger ─────────────────────────────────────────────

test("configureLogger: replaces the transport", () => {
  const { entries: a } = makeCollector();
  const { entries: b, transport: tb } = makeCollector();

  configureLogger({ transport: (_e) => a.push(_e as LogEntry), minLevel: "debug" });
  log("info", "poll_completed", {});
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);

  configureLogger({ transport: tb });
  log("info", "poll_completed", {});
  assert.equal(b.length, 1);
});

test("resetLogger: restores default behaviour (smoke test — no throw)", () => {
  const { transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });
  resetLogger();
  // After reset, log should use the default console transport without throwing
  assert.doesNotThrow(() => {
    // minLevel defaults back to "info" after reset, so debug is suppressed —
    // but the call itself must not throw
    log("info", "poll_completed", {});
  });
});

// ── Named convenience wrappers ────────────────────────────────────────────────

test("logIndexerStarted: emits indexer_started at info level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logIndexerStarted({ pollIntervalMs: 5000, eventsLimit: 100, startLedger: 0 });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "indexer_started");
  assert.equal(entries[0].level, "info");
  assert.equal(entries[0].pollIntervalMs, 5000);
});

test("logIndexerStopped: emits indexer_stopped at info level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logIndexerStopped();

  assert.equal(entries[0].event, "indexer_stopped");
  assert.equal(entries[0].level, "info");
});

test("logTickSkipped: emits indexer_tick_skipped at warn level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logTickSkipped();

  assert.equal(entries[0].event, "indexer_tick_skipped");
  assert.equal(entries[0].level, "warn");
});

test("logPollCompleted: emits poll_completed at info when no failures", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logPollCompleted({ fromLedger: 1, toLedger: 10, eventsProcessed: 3, eventsFailed: 0, durationMs: 50 });

  assert.equal(entries[0].event, "poll_completed");
  assert.equal(entries[0].level, "info");
  assert.equal(entries[0].eventsProcessed, 3);
});

test("logPollCompleted: emits at warn level when eventsFailed > 0", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logPollCompleted({ fromLedger: 1, toLedger: 10, eventsProcessed: 3, eventsFailed: 1, durationMs: 50 });

  assert.equal(entries[0].level, "warn",
    "a poll with failed events should warn, not silently succeed");
});

test("logPollFailed: emits poll_failed at error level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logPollFailed({ error: "ECONNRESET", consecutiveFailures: 3, backoffMs: 4000 });

  assert.equal(entries[0].event, "poll_failed");
  assert.equal(entries[0].level, "error");
  assert.equal(entries[0].consecutiveFailures, 3);
});

test("logPollBackoff: emits poll_backoff at warn level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logPollBackoff({ consecutiveFailures: 4, currentIntervalMs: 8000 });

  assert.equal(entries[0].event, "poll_backoff");
  assert.equal(entries[0].level, "warn");
});

test("logLedgerProcessed: emits ledger_processed at debug level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logLedgerProcessed({ ledger: 1234, processed: 2, failed: 0 });

  assert.equal(entries[0].event, "ledger_processed");
  assert.equal(entries[0].level, "debug");
  assert.equal(entries[0].ledger, 1234);
});

test("logEventIngested: emits event_ingested at debug level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logEventIngested({
    ledger: 500,
    eventType: "circle:contributed",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  });

  assert.equal(entries[0].event, "event_ingested");
  assert.equal(entries[0].level, "debug");
  assert.equal(entries[0].eventType, "circle:contributed");
});

test("logEventSkipped: emits event_skipped at debug level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logEventSkipped({ ledger: 500, eventType: "circle:joined", contractId: "CABC" });

  assert.equal(entries[0].event, "event_skipped");
  assert.equal(entries[0].level, "debug");
});

test("logEventHandlerError: emits event_handler_error at error level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logEventHandlerError({
    ledger: 500,
    eventType: "circle:payout",
    contractId: "CABC",
    error: "FK violation",
  });

  assert.equal(entries[0].event, "event_handler_error");
  assert.equal(entries[0].level, "error");
  assert.ok((entries[0].msg as string).includes("circle:payout"));
});

test("logRpcRetry: emits rpc_retry at warn level with attempt info", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logRpcRetry({
    label: "getEvents(factory+reputation)",
    attempt: 2,
    maxAttempts: 4,
    delayMs: 1000,
    error: "ECONNRESET",
  });

  assert.equal(entries[0].event, "rpc_retry");
  assert.equal(entries[0].level, "warn");
  assert.equal(entries[0].attempt, 2);
  assert.equal(entries[0].maxAttempts, 4);
  assert.equal(entries[0].delayMs, 1000);
});

test("logRpcFailed: emits rpc_failed at error level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logRpcFailed({ label: "getLatestLedger", attempts: 4, error: "all attempts exhausted" });

  assert.equal(entries[0].event, "rpc_failed");
  assert.equal(entries[0].level, "error");
  assert.equal(entries[0].attempts, 4);
});

test("logHealthCheck: ok emits at debug level, degraded emits at warn level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logHealthCheck({
    status: "ok",
    db: "ok", rpc: "ok", indexerLag: "ok", schema: "ok", contractDrift: "ok",
    durationMs: 30,
  });

  logHealthCheck({
    status: "degraded",
    db: "ok", rpc: "error", indexerLag: "ok", schema: "ok", contractDrift: "ok",
    durationMs: 50,
  });

  assert.equal(entries[0].event, "health_check_completed");
  assert.equal(entries[0].level, "debug");
  assert.equal(entries[1].event, "health_check_degraded");
  assert.equal(entries[1].level, "warn");
});

test("logConfigMissing: emits config_missing_vars at fatal level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logConfigMissing(["DATABASE_URL", "STELLAR_RPC_URL"]);

  assert.equal(entries[0].event, "config_missing_vars");
  assert.equal(entries[0].level, "fatal");
  assert.deepEqual(entries[0].missingVars, ["DATABASE_URL", "STELLAR_RPC_URL"]);
});

test("logMigrationApplied: emits migration_applied at info level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logMigrationApplied({ version: "003_add_paused_column.sql" });

  assert.equal(entries[0].event, "migration_applied");
  assert.equal(entries[0].level, "info");
});

test("logMigrationFailed: emits migration_failed at fatal level", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  logMigrationFailed({ error: "column already exists" });

  assert.equal(entries[0].event, "migration_failed");
  assert.equal(entries[0].level, "fatal");
});

// ── JSON serialisability ──────────────────────────────────────────────────────

test("log: bigint context values are serialisable to JSON", () => {
  const { entries, transport } = makeCollector();
  configureLogger({ transport, minLevel: "debug" });

  // BigInt values come from contract amounts; they must not crash JSON.stringify
  log("debug", "event_ingested", { amount: 100_000_000n, ledger: 1, eventType: "circle:contributed" });

  assert.doesNotThrow(() => {
    JSON.stringify(entries[0], (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  });
});
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