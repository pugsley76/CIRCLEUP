/**
 * Replay / re-index tooling for the CircleUp indexer.
 *
 * A "replay" resets the indexer's ledger cursor so the polling loop re-ingests
 * on-chain events from a given ledger forward.  Three modes exist:
 *
 *   full          Delete every row from every derived table, clear the
 *                 ingested_events dedup rows for ledgers >= fromLedger, and
 *                 reset the cursor.  With fromLedger = 0 this is a clean
 *                 rebuild.  With fromLedger > 0 it is LOSSY: rows derived from
 *                 events before fromLedger are deleted, but those events keep
 *                 their dedup rows and are never re-ingested — the preflight
 *                 quantifies exactly how much history that discards.
 *
 *   partial       Delete only ledger-scoped rows at or after fromLedger
 *                 (contributions, payouts, defaults, circle_audit_events),
 *                 keep circles / circle_members / reputation, clear dedup rows
 *                 >= fromLedger and reset the cursor.  Re-applied events update
 *                 the kept rows in place; the one non-idempotent effect
 *                 (circle_members.defaults += 1 per circle/default event) is
 *                 counted by the preflight.
 *
 *   retry-failed  Delete nothing.  Only rewind the cursor (to just before the
 *                 oldest open event_failures row, or to fromLedger) so events
 *                 that were skipped by a failing handler are attempted again.
 *                 Every event that already committed still has its dedup row,
 *                 so it is skipped on re-ingest: no projection is applied
 *                 twice.
 *
 * Every mode runs inside a single Postgres transaction, so a crash mid-replay
 * leaves the database unchanged.
 *
 * Safety properties:
 *   - Explicit intent: prepareReplay / prepareFailedEventRetry refuse to run
 *     unless `confirm` equals the plan's confirmation token
 *     (see replayConfirmationToken).  The check happens before any
 *     connection is opened, so a missing or wrong confirmation — and an
 *     operator who cancels at the CLI prompt — never mutates anything.
 *   - Read-only preflight: replayPreflight runs every count inside a
 *     READ ONLY, REPEATABLE READ transaction (Postgres itself rejects writes)
 *     and reports a value it cannot determine as `null` plus an entry in
 *     `unknowns`, never as 0.
 *   - Idempotent: calling prepareReplay(N) twice has the same effect as once.
 */

import { pool, withTransaction } from "./pool";
import { assertLocalDatabase } from "./dbGuard";
import type { PoolClient } from "pg";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReplayMode = "full" | "partial" | "retry-failed";

export interface ReplayOptions {
  /** Ledger to restart indexing from. 0 means re-index from the very beginning. */
  fromLedger: number;
  /**
   * When true (default), derived tables are fully wiped regardless of
   * fromLedger.  Set to false for a partial replay that only removes rows from
   * fromLedger onward while preserving earlier indexed history.
   */
  fullWipe?: boolean;
  /**
   * Explicit confirmation.  Must equal
   * `replayConfirmationToken(mode, fromLedger)` (also reported by
   * replayPreflight as `confirmationToken`), otherwise the replay is refused
   * before touching the database.
   */
  confirm?: string;
  /**
   * Optional logger, defaults to console.log.  Injected in tests to suppress
   * output.
   */
  log?: (msg: string) => void;
  /** Transaction runner; defaults to the shared pool. Injected in tests. */
  transaction?: typeof withTransaction;
}

export interface ReplayResult {
  fromLedger: number;
  fullWipe: boolean;
  // How many rows were removed from ingested_events.
  eventsCleared: number;
  // How many rows were removed from each derived table (0 for tables a
  // partial replay preserves).
  rowsRemovedByTable: Partial<Record<string, number>>;
}

/** Thrown when a replay is attempted without matching explicit confirmation. */
export class ReplayConfirmationError extends Error {
  constructor(
    readonly expectedToken: string,
    received: string | undefined,
  ) {
    super(
      received === undefined
        ? `[replay] Refusing to run without explicit confirmation. ` +
            `Re-run the preflight and pass confirm="${expectedToken}".`
        : `[replay] Confirmation "${received}" does not match this plan ` +
            `("${expectedToken}"). Nothing was changed.`,
    );
    this.name = "ReplayConfirmationError";
  }
}

// The tables that hold derived, re-computable state.  Order matters for
// deletion: tables with FK dependencies on `circles` must come first.
const DERIVED_TABLES = [
  "contributions",
  "payouts",
  "defaults",
  "circle_audit_events",
  "circle_members",
  "reputation",
  "circles",
] as const;

type DerivedTable = (typeof DERIVED_TABLES)[number];

/**
 * Derived tables a partial replay trims by ledger.  Each has a `ledger`
 * column recording the event that produced the row.
 */
const LEDGER_SCOPED_TABLES: readonly DerivedTable[] = [
  "contributions",
  "payouts",
  "defaults",
  "circle_audit_events",
];

/**
 * Derived tables a partial replay keeps.  They have no single ledger column
 * covering their full lifecycle, and deleting them would orphan the
 * ledger-scoped rows preserved before fromLedger (FK on circles(address)).
 */
const PRESERVED_IN_PARTIAL: readonly DerivedTable[] = [
  "circle_members",
  "reputation",
  "circles",
];

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Validate fromLedger; throws on anything but a non-negative integer. */
export function assertValidFromLedger(fromLedger: number): void {
  if (!Number.isInteger(fromLedger) || fromLedger < 0) {
    throw new Error(
      `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
    );
  }
}

/** Resolve the effective destructive mode (genesis always means full). */
export function resolveReplayMode(fromLedger: number, fullWipe = true): "full" | "partial" {
  return fullWipe || fromLedger === 0 ? "full" : "partial";
}

/** Cursor value written by a replay: the poller fetches from cursor + 1. */
export function cursorAfterReplay(fromLedger: number): number {
  return fromLedger === 0 ? 0 : fromLedger - 1;
}

/**
 * The confirmation token for a plan.  Binding the token to the mode and the
 * starting ledger means a confirmation typed (or scripted) for one plan can
 * never authorise a different, possibly more destructive, one.  It does not
 * include the moving cursor, so it stays stable for automation.
 */
export function replayConfirmationToken(mode: ReplayMode, fromLedger: number): string {
  return `replay-${mode}-from-${fromLedger}`;
}

/** Throw unless `confirm` matches the plan's token. */
export function assertReplayConfirmed(
  mode: ReplayMode,
  fromLedger: number,
  confirm: string | undefined,
): void {
  const expected = replayConfirmationToken(mode, fromLedger);
  if (confirm !== expected) {
    throw new ReplayConfirmationError(expected, confirm);
  }
}

// ─── Core implementation ──────────────────────────────────────────────────────

/** Whether a table exists, without aborting the surrounding transaction. */
async function tableExists(
  run: QueryFn,
  table: string,
): Promise<boolean> {
  const { rows } = await run("SELECT to_regclass($1) AS oid", [table]);
  return rows[0]?.oid != null;
}

/**
 * Wipe all derived tables so a full re-index starts clean.
 * Uses DELETE instead of TRUNCATE so the operation is fully transactional —
 * if the wrapping transaction rolls back, all rows are restored.
 * TRUNCATE with RESTART IDENTITY is intentionally avoided: sequence resets
 * are not transactional in Postgres and would not roll back on failure.
 */
async function wipeAllDerivedTables(
  client: PoolClient,
  log: (msg: string) => void,
): Promise<Partial<Record<DerivedTable, number>>> {
  const run = clientQueryFn(client);
  const counts: Partial<Record<DerivedTable, number>> = {};
  // Delete in FK-safe dependency order: child tables before parent tables.
  for (const table of DERIVED_TABLES) {
    if (!(await tableExists(run, table))) {
      log(`[replay] Skipped ${table} (table does not exist — migrations pending?)`);
      continue;
    }
    const res = await client.query(`DELETE FROM ${table}`);
    counts[table] = res.rowCount ?? 0;
    log(`[replay] Deleted ${counts[table]} rows from ${table}`);
  }
  return counts;
}

/**
 * Partial wipe: delete only rows at or after fromLedger from each
 * ledger-scoped derived table.  Rows in earlier ledgers are kept so the app
 * can still serve historical data while the replay catches up.
 */
async function wipeFromLedger(
  client: PoolClient,
  fromLedger: number,
  log: (msg: string) => void,
): Promise<Partial<Record<DerivedTable, number>>> {
  const run = clientQueryFn(client);
  const counts: Partial<Record<DerivedTable, number>> = {};

  // Delete child tables before parent to respect FK constraints.
  for (const table of LEDGER_SCOPED_TABLES) {
    if (!(await tableExists(run, table))) {
      log(`[replay] Skipped ${table} (table does not exist — migrations pending?)`);
      continue;
    }
    const res = await client.query(
      `DELETE FROM ${table} WHERE ledger >= $1`,
      [fromLedger],
    );
    counts[table] = res.rowCount ?? 0;
    log(`[replay] Deleted ${counts[table]} rows from ${table} (ledger >= ${fromLedger})`);
  }

  // The poller will upsert/update these rows as it re-processes events.
  for (const table of PRESERVED_IN_PARTIAL) {
    counts[table] = 0; // no rows removed
    log(`[replay] Preserved table: ${table} (no ledger column — kept for partial replay)`);
  }

  return counts;
}

/**
 * Prepare the database for a re-index run starting at `fromLedger`.
 *
 * This is the primary entry point for destructive replay operations.  It
 * runs inside a single transaction so a crash mid-operation leaves the
 * database unchanged.
 *
 * After this returns the caller should restart (or let the poller resume) the
 * event ingest loop — the cursor is now positioned at fromLedger - 1 so the
 * first poll tick will fetch events from exactly fromLedger.
 *
 * @throws if fromLedger is negative or not an integer.
 * @throws ReplayConfirmationError if `confirm` does not match the plan —
 *         before any database access.
 * @throws if the database is unreachable or the transaction is rolled back.
 */
export async function prepareReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const {
    fromLedger,
    fullWipe = true,
    log = console.log,
    transaction = withTransaction,
  } = opts;

  assertValidFromLedger(fromLedger);
  const mode = resolveReplayMode(fromLedger, fullWipe);
  // Explicit intent is checked before a connection is even opened.
  assertReplayConfirmed(mode, fromLedger, opts.confirm);

  log(`[replay] Preparing ${mode} replay from ledger ${fromLedger}...`);

  return transaction(async (client) => {
    // ── 1. Wipe derived tables ──────────────────────────────────────────────
    const rowsRemovedByTable: Partial<Record<string, number>> =
      mode === "full"
        ? await wipeAllDerivedTables(client, log)
        : await wipeFromLedger(client, fromLedger, log);

    // ── 2. Clear ingested_events for the replay range ───────────────────────
    // Removing dedup keys is what actually allows the poller to re-process
    // events — without this, `ingestEvent()` would see "already processed"
    // and skip every event.  Events before fromLedger keep their dedup rows
    // even on a full wipe (see the module header for what that implies).
    const eventsRes = await client.query(
      fromLedger === 0
        ? "DELETE FROM ingested_events"
        : "DELETE FROM ingested_events WHERE ledger >= $1",
      fromLedger === 0 ? [] : [fromLedger],
    );
    const eventsCleared = eventsRes.rowCount ?? 0;
    log(
      fromLedger === 0
        ? `[replay] Cleared all ${eventsCleared} ingested_events rows`
        : `[replay] Cleared ${eventsCleared} ingested_events rows (ledger >= ${fromLedger})`,
    );

    // ── 3. Reset ledger cursor ──────────────────────────────────────────────
    // Set to (fromLedger - 1) so the first poll tick fetches events starting
    // at exactly fromLedger.  For a genesis replay (fromLedger = 0), set to 0
    // which the poller treats as "start from START_LEDGER config value".
    const newCursor = cursorAfterReplay(fromLedger);
    await client.query(
      "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
      [newCursor],
    );
    log(`[replay] Reset indexer_state.last_ledger to ${newCursor}`);

    log(
      `[replay] Replay prepared — indexer will re-ingest from ledger ${fromLedger} on next poll cycle.`,
    );

    return {
      fromLedger,
      fullWipe: mode === "full",
      eventsCleared,
      rowsRemovedByTable,
    };
  });
}

// ─── Failed-event retry (non-destructive) ─────────────────────────────────────

export interface FailedEventRetryOptions {
  /**
   * Ledger to rewind to.  Defaults to the oldest open event_failures ledger.
   * Must not be later than the oldest open failure you intend to retry.
   */
  fromLedger?: number;
  /** Must equal `replayConfirmationToken("retry-failed", fromLedger)`. */
  confirm?: string;
  log?: (msg: string) => void;
  transaction?: typeof withTransaction;
}

export interface FailedEventRetryResult {
  /** Ledger the poller will resume from; null when there was nothing to retry. */
  fromLedger: number | null;
  /** Open failures at or after fromLedger that will be re-attempted. */
  openFailures: number;
  /** Previous cursor value (the poller will catch back up to it). */
  previousCursor: number;
  newCursor: number | null;
}

/**
 * Rewind the cursor so events skipped by a failing handler are attempted
 * again, without deleting anything.
 *
 * Safe against duplicate projections by construction: a failed event's
 * ingested_events row was rolled back with its savepoint, so it is
 * re-processed, while every event that committed still has its dedup row and
 * is skipped by ingestEventInTx.  A retried event that now succeeds marks its
 * event_failures row resolved; one that fails again increments `attempts`.
 *
 * Only possible while the target ledger is still inside the RPC's event
 * retention window — run replayPreflight first.
 *
 * When `fromLedger` is omitted the oldest open failure is used and the
 * confirmation token must be built from that ledger (as reported by
 * replayPreflight).
 */
export async function prepareFailedEventRetry(
  opts: FailedEventRetryOptions,
): Promise<FailedEventRetryResult> {
  const { log = console.log, transaction = withTransaction } = opts;
  if (opts.fromLedger !== undefined) {
    assertValidFromLedger(opts.fromLedger);
    // Check intent up front when the target is already known.
    assertReplayConfirmed("retry-failed", opts.fromLedger, opts.confirm);
  }

  return transaction(async (client) => {
    const [state] = (
      await client.query<{ last_ledger: string }>(
        "SELECT last_ledger FROM indexer_state WHERE id = 1 FOR UPDATE",
      )
    ).rows;
    const previousCursor = state ? Number(state.last_ledger) : 0;

    const [oldest] = (
      await client.query<{ ledger: string | null }>(
        `SELECT MIN(ledger) AS ledger FROM event_failures
          WHERE resolved_at IS NULL AND acknowledged_at IS NULL`,
      )
    ).rows;
    const oldestOpen = oldest?.ledger != null ? Number(oldest.ledger) : null;
    const fromLedger = opts.fromLedger ?? oldestOpen;

    if (fromLedger === null) {
      log("[replay] No open event failures — nothing to retry.");
      return { fromLedger: null, openFailures: 0, previousCursor, newCursor: null };
    }
    // Resolved from the table: confirmation still has to name this ledger.
    // Throwing here rolls back the (read-only so far) transaction.
    assertReplayConfirmed("retry-failed", fromLedger, opts.confirm);

    const [countRow] = (
      await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM event_failures
          WHERE resolved_at IS NULL AND acknowledged_at IS NULL AND ledger >= $1`,
        [fromLedger],
      )
    ).rows;
    const openFailures = Number(countRow?.count ?? 0);

    if (fromLedger > previousCursor) {
      log(
        `[replay] Ledger ${fromLedger} is ahead of the cursor (${previousCursor}) — ` +
          `the poller has not passed it yet; nothing to rewind.`,
      );
      return { fromLedger, openFailures, previousCursor, newCursor: null };
    }

    const newCursor = cursorAfterReplay(fromLedger);
    await client.query(
      "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
      [newCursor],
    );
    log(
      `[replay] Rewound indexer_state.last_ledger ${previousCursor} → ${newCursor}; ` +
        `${openFailures} open failure(s) will be retried. No rows were deleted.`,
    );
    return { fromLedger, openFailures, previousCursor, newCursor };
  });
}

// ─── Preflight (read-only impact report) ──────────────────────────────────────

/** Minimal query interface so the preflight can run against a stub in tests. */
export type QueryFn = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

function clientQueryFn(client: PoolClient): QueryFn {
  return (text, params) => client.query(text, params as unknown[]);
}

/** What a replay will do to one table. */
export interface ReplayTableImpact {
  table: string;
  action:
    | "delete_all"          // every row deleted
    | "delete_from_ledger"  // rows with ledger >= fromLedger deleted
    | "preserved"           // untouched by the replay itself
    | "updated";            // rows rewritten in place (cursor)
  /**
   * Rows the replay itself would delete (or, for "preserved"/"updated", the
   * rows in the replay range that re-ingest will touch).  `null` when it
   * could not be determined — see `unknowns`.
   */
  rows: number | null;
  note?: string;
}

export interface ReplayPrerequisite {
  name: "indexer_stopped" | "backup_taken" | "schema_clean" | "rpc_retention";
  /** true = satisfied, false = not satisfied, null = cannot be verified here. */
  ok: boolean | null;
  detail: string;
}

export interface ReplayPreflightOptions {
  /** Same meaning as ReplayOptions.fullWipe. Default true. Ignored for retry-failed. */
  fullWipe?: boolean;
  /** Plan a non-destructive failed-event retry instead of a replay. */
  retryFailed?: boolean;
  /** Query function; defaults to a READ ONLY transaction on the shared pool. */
  db?: QueryFn;
  /**
   * Report the oldest ledger the RPC still serves events for, or null when
   * unknown.  Omitted → the rpc_retention prerequisite is reported unknown.
   */
  rpcOldestLedger?: () => Promise<number | null>;
  /** Report migration state; omitted → schema_clean is reported unknown. */
  schemaState?: () => Promise<{ clean: boolean; summary: string } | null>;
  /** Clock seam for tests. */
  now?: () => Date;
}

export interface ReplayPreflightResult {
  /**
   * Preflight never blocks — it describes the plan and the operator decides.
   * Destructive execution is gated by `confirmationToken` instead.
   */
  safe: boolean;
  mode: ReplayMode;
  /** The ledger re-ingestion starts from (resolved for retry-failed). */
  fromLedger: number;
  /**
   * Already-indexed range that will be re-ingested: [fromLedger, cursor].
   * After that the poller continues to the chain head as usual.  `null`
   * toLedger means the range is empty (fromLedger is ahead of the cursor).
   */
  targetRange: { fromLedger: number; toLedger: number | null };
  /** Estimated ingested_events rows that would be cleared. */
  estimatedEventsToReplay: number;
  /**
   * ingested_events rows before fromLedger that stay in place; those events
   * will NOT be re-processed.
   */
  eventsPreservedBeforeRange: number;
  /** Current last_ledger cursor from indexer_state. */
  currentLedger: number;
  cursor: {
    current: number;
    afterReplay: number;
    /** ISO time of the last cursor update, or null if unknown. */
    lastUpdatedAt: string | null;
  };
  tables: ReplayTableImpact[];
  /** Open event_failures rows at or after fromLedger (re-attempted by any mode). */
  openFailuresInRange: number | null;
  prerequisites: ReplayPrerequisite[];
  /** Values that could not be determined, with the reason. Never reported as 0. */
  unknowns: string[];
  warnings: string[];
  /** Pass as `confirm` (or `--confirm=`) to execute exactly this plan. */
  confirmationToken: string;
}

/** A cursor updated more recently than this suggests a live poller. */
const RUNNING_INDEXER_WINDOW_MS = 60_000;

/**
 * Run `fn` against a READ ONLY, REPEATABLE READ snapshot on the shared pool.
 * Postgres rejects any write attempted inside it, and every count sees the
 * same snapshot.  The transaction is always rolled back.
 */
async function withReadOnlySnapshot<T>(fn: (run: QueryFn) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await fn(clientQueryFn(client));
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

/**
 * Non-destructive impact report for a replay or failed-event retry: target
 * range, affected tables with row counts, cursor state, open failures in
 * range, prerequisites, and the confirmation token required to execute it.
 *
 * Every query is a SELECT, run in a read-only snapshot.  Missing tables and
 * unverifiable prerequisites are reported as unknown rather than guessed.
 *
 * Accepts the legacy single-argument form `replayPreflight(fromLedger)`,
 * which plans a full replay.
 */
export async function replayPreflight(
  fromLedger: number,
  options: ReplayPreflightOptions = {},
): Promise<ReplayPreflightResult> {
  assertValidFromLedger(fromLedger);
  if (options.db) return buildPreflight(options.db, fromLedger, options);
  return withReadOnlySnapshot((run) => buildPreflight(run, fromLedger, options));
}

async function buildPreflight(
  run: QueryFn,
  requestedFromLedger: number,
  options: ReplayPreflightOptions,
): Promise<ReplayPreflightResult> {
  const warnings: string[] = [];
  const unknowns: string[] = [];
  const now = options.now ?? (() => new Date());

  // ── Cursor ────────────────────────────────────────────────────────────────
  const [stateRow] = (
    await run("SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1")
  ).rows;
  const currentLedger = stateRow ? Number(stateRow.last_ledger) : 0;
  if (!stateRow) unknowns.push("indexer_state row is missing — cursor assumed 0");
  const lastUpdatedAt =
    stateRow?.updated_at instanceof Date
      ? stateRow.updated_at.toISOString()
      : (stateRow?.updated_at ?? null);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const existing = new Map<string, boolean>();
  async function exists(table: string): Promise<boolean> {
    if (!existing.has(table)) existing.set(table, await tableExists(run, table));
    return existing.get(table)!;
  }
  async function count(table: string, where = "", params: unknown[] = []): Promise<number | null> {
    if (!(await exists(table))) {
      unknowns.push(`${table}: table does not exist (migrations pending?) — row count unknown`);
      return null;
    }
    const [row] = (
      await run(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`, params)
    ).rows;
    return Number(row?.count ?? 0);
  }

  // ── Mode and effective starting ledger ────────────────────────────────────
  let mode: ReplayMode;
  let fromLedger = requestedFromLedger;
  if (options.retryFailed) {
    mode = "retry-failed";
    if (requestedFromLedger === 0 && (await exists("event_failures"))) {
      const [row] = (
        await run(
          `SELECT MIN(ledger) AS ledger FROM event_failures
            WHERE resolved_at IS NULL AND acknowledged_at IS NULL`,
        )
      ).rows;
      if (row?.ledger != null) fromLedger = Number(row.ledger);
    }
  } else {
    mode = resolveReplayMode(requestedFromLedger, options.fullWipe ?? true);
  }

  // ── ingested_events ───────────────────────────────────────────────────────
  const inRange = fromLedger === 0 ? "" : "ledger >= $1";
  const inRangeParams = fromLedger === 0 ? [] : [fromLedger];
  const eventsInRange = (await count("ingested_events", inRange, inRangeParams)) ?? 0;
  const eventsBefore =
    fromLedger === 0 ? 0 : ((await count("ingested_events", "ledger < $1", [fromLedger])) ?? 0);

  // ── Derived tables ────────────────────────────────────────────────────────
  const tables: ReplayTableImpact[] = [];
  let lostHistoryRows = 0;
  let lostHistoryKnown = true;

  for (const table of DERIVED_TABLES) {
    if (mode === "full") {
      const rows = await count(table);
      tables.push({ table, action: "delete_all", rows });
      if (fromLedger > 0) {
        // Rows produced before fromLedger are deleted but never rebuilt.
        const before = LEDGER_SCOPED_TABLES.includes(table)
          ? await count(table, "ledger < $1", [fromLedger])
          : table === "circles"
            ? await count(table, "created_ledger < $1", [fromLedger])
            : null;
        if (before === null) {
          if (LEDGER_SCOPED_TABLES.includes(table) || table === "circles") lostHistoryKnown = false;
        } else {
          lostHistoryRows += before;
        }
      }
    } else if (mode === "partial" && LEDGER_SCOPED_TABLES.includes(table)) {
      tables.push({
        table,
        action: "delete_from_ledger",
        rows: await count(table, "ledger >= $1", [fromLedger]),
      });
    } else {
      tables.push({
        table,
        action: "preserved",
        rows: 0,
        note:
          mode === "partial"
            ? "kept; re-applied events update rows in place"
            : "kept; already-committed events are skipped by dedup",
      });
    }
  }

  tables.push({
    table: "ingested_events",
    action: mode === "retry-failed" ? "preserved" : fromLedger === 0 ? "delete_all" : "delete_from_ledger",
    rows: mode === "retry-failed" ? 0 : eventsInRange,
    note:
      mode === "retry-failed"
        ? "kept; committed events stay deduplicated so nothing is applied twice"
        : fromLedger > 0
          ? `${eventsBefore} row(s) before ledger ${fromLedger} are kept — those events are not re-processed`
          : undefined,
  });

  const checkpointsInRange = await count("ledger_checkpoints", inRange, inRangeParams);
  tables.push({
    table: "ledger_checkpoints",
    action: "preserved",
    rows: checkpointsInRange,
    note: "not deleted; rows in range are overwritten as ledgers are re-processed",
  });

  const openFailuresInRange = await count(
    "event_failures",
    `resolved_at IS NULL AND acknowledged_at IS NULL${fromLedger === 0 ? "" : " AND ledger >= $1"}`,
    inRangeParams,
  );
  tables.push({
    table: "event_failures",
    action: "preserved",
    rows: openFailuresInRange,
    note: "kept as history; open rows in range are re-attempted and resolve on success",
  });

  const newCursor = cursorAfterReplay(fromLedger);
  tables.push({
    table: "indexer_state",
    action: "updated",
    rows: stateRow ? 1 : 0,
    note: `last_ledger ${currentLedger} → ${newCursor}`,
  });

  // ── Warnings ──────────────────────────────────────────────────────────────
  if (fromLedger > currentLedger) {
    warnings.push(
      `fromLedger (${fromLedger}) is ahead of the current cursor (${currentLedger}). ` +
        `The replay range would be empty — the indexer is not yet that far ahead.`,
    );
  }
  if (mode !== "retry-failed" && eventsInRange === 0 && fromLedger <= currentLedger) {
    warnings.push(
      "No ingested_events rows found for the given ledger range. " +
        "The replay will still reset the cursor but won't re-process any events.",
    );
  }
  if (mode === "full" && fromLedger > 0) {
    warnings.push(
      `A full wipe from ledger ${fromLedger} deletes all derived rows, but the ${eventsBefore} ` +
        `event(s) before that ledger keep their dedup rows and will not be re-ingested — ` +
        (lostHistoryKnown
          ? `at least ${lostHistoryRows} derived row(s) produced before ledger ${fromLedger} ` +
            `(plus the circle_members / reputation rows of those circles) will be lost permanently. `
          : `an unknown number of derived rows produced before ledger ${fromLedger} will be lost permanently. `) +
        `Use --partial, or replay from ledger 0.`,
    );
  }
  if (mode === "partial") {
    const reappliedDefaults = await count("defaults", "ledger >= $1", [fromLedger]);
    if (reappliedDefaults === null || reappliedDefaults > 0) {
      warnings.push(
        `circle_members.defaults is a counter that is not reset by a partial replay: ` +
          `re-applying ${reappliedDefaults ?? "an unknown number of"} circle/default event(s) ` +
          `will increase it again. Run \`npm run reconcile\` afterwards, or use a full replay from ledger 0.`,
      );
    }
  }
  if (mode === "retry-failed" && openFailuresInRange === 0) {
    warnings.push("No open event failures at or after this ledger — a retry would only re-fetch events.");
  }

  // ── Prerequisites ─────────────────────────────────────────────────────────
  const prerequisites: ReplayPrerequisite[] = [];

  const updatedMs = lastUpdatedAt ? Date.parse(lastUpdatedAt) : NaN;
  const ageMs = Number.isFinite(updatedMs) ? now().getTime() - updatedMs : null;
  prerequisites.push(
    ageMs !== null && ageMs < RUNNING_INDEXER_WINDOW_MS
      ? {
          name: "indexer_stopped",
          ok: false,
          detail:
            `The cursor moved ${Math.round(ageMs / 1000)}s ago — the indexer appears to be running. ` +
            `Stop it first, or it may overwrite the reset cursor.`,
        }
      : {
          name: "indexer_stopped",
          ok: null,
          detail:
            `Cannot be verified from the database (cursor last moved ${lastUpdatedAt ?? "at an unknown time"}). ` +
            `Stop the poller before executing.`,
        },
  );

  prerequisites.push({
    name: "backup_taken",
    ok: mode === "retry-failed" ? true : null,
    detail:
      mode === "retry-failed"
        ? "Not required: a failed-event retry deletes nothing."
        : "Cannot be verified here. Take a pg_dump before executing (docs/RUNBOOK.md → Backup).",
  });

  if (options.schemaState) {
    const schema = await options.schemaState().catch(() => null);
    prerequisites.push(
      schema === null
        ? { name: "schema_clean", ok: null, detail: "Migration state could not be read." }
        : { name: "schema_clean", ok: schema.clean, detail: schema.summary },
    );
  } else {
    prerequisites.push({
      name: "schema_clean",
      ok: null,
      detail: "Not checked — run `npm run migrate:check`.",
    });
  }

  const startLedger = fromLedger;
  if (options.rpcOldestLedger) {
    const oldest = await options.rpcOldestLedger().catch(() => null);
    prerequisites.push(
      oldest === null
        ? {
            name: "rpc_retention",
            ok: null,
            detail: "The RPC did not report its oldest retained ledger.",
          }
        : {
            name: "rpc_retention",
            ok: startLedger === 0 ? null : startLedger >= oldest,
            detail:
              startLedger === 0
                ? `The RPC retains events from ledger ${oldest}; a genesis replay starts at START_LEDGER — make sure START_LEDGER >= ${oldest}.`
                : startLedger >= oldest
                  ? `Ledger ${startLedger} is within the RPC's retention window (oldest ${oldest}).`
                  : `Ledger ${startLedger} is older than the RPC's retention window (oldest ${oldest}) — ` +
                    `events before ${oldest} cannot be re-fetched and would be lost.`,
          },
    );
  } else {
    prerequisites.push({
      name: "rpc_retention",
      ok: null,
      detail:
        "Not checked — Soroban RPC only serves events for a limited window; " +
        "confirm the target ledger is still retained before executing.",
    });
  }

  return {
    safe: true, // preflight never blocks — confirmation gates execution
    mode,
    fromLedger,
    targetRange: {
      fromLedger,
      toLedger: fromLedger <= currentLedger ? currentLedger : null,
    },
    estimatedEventsToReplay: mode === "retry-failed" ? 0 : eventsInRange,
    eventsPreservedBeforeRange: eventsBefore,
    currentLedger,
    cursor: { current: currentLedger, afterReplay: newCursor, lastUpdatedAt },
    tables,
    openFailuresInRange,
    prerequisites,
    unknowns: [...new Set(unknowns)],
    warnings,
    confirmationToken: replayConfirmationToken(mode, fromLedger),
  };
}

/** Render a preflight report as human-readable lines for the CLI. */
export function formatPreflightReport(p: ReplayPreflightResult): string[] {
  const fmt = (n: number | null) => (n === null ? "unknown" : String(n));
  const lines = [
    `[replay] Mode: ${p.mode}`,
    `[replay] Target range: ledger ${p.targetRange.fromLedger} → ` +
      (p.targetRange.toLedger === null ? "(empty — ahead of cursor)" : `${p.targetRange.toLedger} (current cursor), then chain head`),
    `[replay] Cursor: ${p.cursor.current} → ${p.cursor.afterReplay} (last moved ${p.cursor.lastUpdatedAt ?? "unknown"})`,
    `[replay] Events to re-process: ${p.estimatedEventsToReplay}` +
      (p.eventsPreservedBeforeRange > 0 ? ` (${p.eventsPreservedBeforeRange} earlier event(s) kept, not re-processed)` : ""),
    `[replay] Open event failures in range: ${fmt(p.openFailuresInRange)}`,
    "[replay] Tables:",
    ...p.tables.map(
      (t) => `[replay]   ${t.table.padEnd(20)} ${t.action.padEnd(18)} rows=${fmt(t.rows)}${t.note ? `  — ${t.note}` : ""}`,
    ),
    "[replay] Prerequisites:",
    ...p.prerequisites.map(
      (r) => `[replay]   [${r.ok === true ? "ok" : r.ok === false ? "FAIL" : "??"}] ${r.name}: ${r.detail}`,
    ),
  ];
  for (const u of p.unknowns) lines.push(`[replay] Unknown: ${u}`);
  for (const w of p.warnings) lines.push(`[replay] Warning: ${w}`);
  lines.push(`[replay] Confirmation token: ${p.confirmationToken}`);
  return lines;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
//
// Run directly: npx ts-node src/db/replay.ts --from=<ledger> [--partial | --retry-failed]
//               [--dry-run] [--confirm=<token>] [--json]
//
// Flags:
//   --from=<n>         Ledger number to replay from (0 = genesis).  The last
//                      occurrence wins, so `npm run replay:dry-run -- --from=N`
//                      overrides the script's default --from=0.  Optional with
//                      --retry-failed (defaults to the oldest open failure).
//   --partial          Keep rows from ledgers < fromLedger in derived tables.
//   --retry-failed     Non-destructive: only rewind the cursor so failed
//                      events are re-attempted.
//   --dry-run          Print the impact report without touching the database.
//   --confirm=<token>  Execute without prompting (automation).  Must equal the
//                      token printed by the preflight for this exact plan.
//   --json             Print the preflight report as JSON.
//
// Without --confirm the CLI prompts on an interactive terminal and refuses to
// run on a non-interactive one.  A cancelled or mismatched confirmation exits
// with code 2 and changes nothing.

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const fromArg = [...args].reverse().find((a) => a.startsWith("--from="));
    const confirmArg = [...args].reverse().find((a) => a.startsWith("--confirm="));
    const partial = args.includes("--partial");
    const retryFailed = args.includes("--retry-failed");
    const dryRun = args.includes("--dry-run");
    const json = args.includes("--json");

    const usage =
      "[replay] Usage: ts-node src/db/replay.ts --from=<ledger> [--partial | --retry-failed] " +
      "[--dry-run] [--confirm=<token>] [--json]";
    if (!fromArg && !retryFailed) {
      console.error(usage);
      process.exit(1);
    }
    if (partial && retryFailed) {
      console.error("[replay] --partial and --retry-failed are mutually exclusive.");
      process.exit(1);
    }

    const fromLedger = fromArg ? Number(fromArg.replace("--from=", "")) : 0;
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      console.error(`[replay] --from must be a non-negative integer, got: "${fromArg}"`);
      process.exit(1);
    }

    // Refuse to run against staging or production — this operation wipes tables.
    try {
      assertLocalDatabase(process.env.DATABASE_URL, "replay");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (dryRun) {
      console.log(`[replay] --dry-run: checking preflight for replay from ledger ${fromLedger}...`);
      const preflight = await replayPreflight(fromLedger);
      console.log(`[replay] Current indexer cursor: ledger ${preflight.currentLedger}`);
      console.log(`[replay] Estimated events to re-process: ${preflight.estimatedEventsToReplay}`);
      console.log(`[replay] Wipe mode: ${!partial || fromLedger === 0 ? "full" : "partial"}`);
      if (preflight.warnings.length > 0) {
        for (const w of preflight.warnings) {
          console.warn(`[replay] Warning: ${w}`);
        }
      }
      console.log("[replay] Dry run complete — no changes made.");
      await pool.end();
      process.exit(code);
    };

    try {
      const preflight = await replayPreflight(fromLedger, {
        fullWipe: !partial,
        retryFailed,
        schemaState: async () => {
          const { checkMigrationHealth } = await import("./migrate");
          const health = await checkMigrationHealth();
          return { clean: health.state === "clean", summary: health.summary };
        },
        rpcOldestLedger: process.env.STELLAR_RPC_URL
          ? async () => {
              const { SorobanRpc } = await import("@stellar/stellar-sdk");
              const rpc = new SorobanRpc.Server(process.env.STELLAR_RPC_URL!, { allowHttp: true });
              // Newer RPCs report oldestLedger on getHealth; older ones do not.
              const health = (await rpc.getHealth()) as unknown as { oldestLedger?: unknown };
              return typeof health.oldestLedger === "number" ? health.oldestLedger : null;
            }
          : undefined,
      });

      if (json) console.log(JSON.stringify(preflight, null, 2));
      else for (const line of formatPreflightReport(preflight)) console.log(line);

      if (dryRun) {
        console.log("[replay] Dry run complete — no changes made.");
        return finish(0);
      }

      if (retryFailed && preflight.openFailuresInRange === 0) {
        console.log("[replay] Nothing to retry — no changes made.");
        return finish(0);
      }

      let confirm = confirmArg?.replace("--confirm=", "");
      if (confirm === undefined) {
        if (!process.stdin.isTTY) {
          console.error(
            `[replay] Refusing to run non-interactively without --confirm=${preflight.confirmationToken}. ` +
              `No changes made.`,
          );
          return finish(2);
        }
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        confirm = await new Promise<string>((resolve) =>
          rl.question(`[replay] Type "${preflight.confirmationToken}" to proceed: `, (answer) => {
            rl.close();
            resolve(answer.trim());
          }),
        );
      }

      if (confirm !== preflight.confirmationToken) {
        console.error("[replay] Confirmation did not match — cancelled. No changes made.");
        return finish(2);
      }

      if (retryFailed) {
        const result = await prepareFailedEventRetry({
          fromLedger: preflight.fromLedger,
          confirm,
        });
        console.log(`[replay] Done. Open failures to retry: ${result.openFailures}`);
      } else {
        const result = await prepareReplay({ fromLedger, fullWipe: !partial, confirm });
        console.log(`[replay] Done. Events cleared: ${result.eventsCleared}`);
      }
      return finish(0);
    } catch (err) {
      console.error("[replay] Error:", err);
      return finish(1);
    }
  })();
}
