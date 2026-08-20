/**
 * Replay / re-index tooling for the CircleUp indexer.
 *
 * A "replay" resets the indexer's ledger cursor so the polling loop re-ingests
 * all on-chain events from a given ledger forward.  It does this by:
 *
 *   1. Truncating (or selectively deleting from) the derived event tables
 *      (circles, circle_members, contributions, payouts, defaults, reputation)
 *      so stale rows don't survive into the rebuilt state.
 *   2. Clearing the ingested_events dedup table for ledgers >= fromLedger so
 *      previously seen events are re-processed.  Events before fromLedger are
 *      intentionally preserved — a partial replay leaves earlier history intact.
 *   3. Resetting the indexer_state cursor to (fromLedger - 1) so the poller
 *      picks up exactly from fromLedger on its next tick.
 *
 * All three steps happen inside a single Postgres transaction so the database
 * is never left in a half-reset state if the process crashes mid-replay.
 *
 * Safety properties:
 *   - Idempotent: calling prepareReplay(N) twice has the same effect as once.
 *   - Non-blocking read path: the transaction is short; Postgres row-level
 *     locks are held only for the duration of the TRUNCATE / DELETE / UPDATE,
 *     not for the subsequent re-index.
 *   - Full vs partial replays:
 *       full   (fromLedger = 0 or START_LEDGER) — all derived data wiped.
 *       partial (fromLedger > 0)                — only rows whose ledger >=
 *               fromLedger are removed; earlier rounds remain readable.
 */

import { pool, withTransaction } from "./pool";
import type { PoolClient } from "pg";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Ledger to restart indexing from. 0 means re-index from the very beginning. */
  fromLedger: number;
  /**
   * When true (default), derived tables are fully truncated regardless of
   * fromLedger.  This is safe for a fresh re-index and is faster than
   * ledger-scoped DELETEs on large tables.
   *
   * Set to false for a partial replay where you only want to re-ingest events
   * from fromLedger onward while preserving earlier indexed history.
   */
  fullWipe?: boolean;
  /**
   * Optional logger, defaults to console.log.  Injected in tests to suppress
   * output.
   */
  log?: (msg: string) => void;
}

export interface ReplayResult {
  fromLedger: number;
  fullWipe: boolean;
  // How many rows were removed from ingested_events.
  eventsCleared: number;
  // How many rows were removed from each derived table.  Populated only when
  // fullWipe is false (TRUNCATE doesn't return row counts).
  rowsRemovedByTable: Partial<Record<string, number>>;
}

// The tables that hold derived, re-computable state.  Order matters for
// truncation: tables with FK dependencies on `circles` must come first.
const DERIVED_TABLES = [
  "contributions",
  "payouts",
  "defaults",
  "circle_members",
  "reputation",
  "circles",
] as const;

type DerivedTable = (typeof DERIVED_TABLES)[number];

// ─── Core implementation ──────────────────────────────────────────────────────

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
  const counts: Partial<Record<DerivedTable, number>> = {};
  // Delete in FK-safe dependency order: child tables before parent tables.
  for (const table of DERIVED_TABLES) {
    const res = await client.query(`DELETE FROM ${table}`);
    counts[table] = res.rowCount ?? 0;
    log(`[replay] Deleted ${counts[table]} rows from ${table}`);
  }
  return counts;
}

/**
 * Partial wipe: delete only rows at or after fromLedger from each derived
 * table.  Rows in earlier ledgers are kept so the app can still serve
 * historical data while the replay catches up.
 *
 * Tables without a `ledger` column (circle_members, reputation, circles) are
 * left intact for a partial replay.  Their state will be rebuilt incrementally
 * as the poller re-processes events from fromLedger onward.  Deleting them
 * while contribution/payout/default rows with ledger < fromLedger still
 * reference circles(address) would break FK integrity on the preserved rows.
 */
async function wipeFromLedger(
  client: PoolClient,
  fromLedger: number,
  log: (msg: string) => void,
): Promise<Partial<Record<DerivedTable, number>>> {
  const counts: Partial<Record<DerivedTable, number>> = {};

  // Tables with a `ledger` column — delete rows at or beyond fromLedger.
  // Delete child tables before parent to respect FK constraints.
  const ledgerTables: DerivedTable[] = [
    "contributions",
    "payouts",
    "defaults",
  ];
  for (const table of ledgerTables) {
    const res = await client.query(
      `DELETE FROM ${table} WHERE ledger >= $1`,
      [fromLedger],
    );
    counts[table] = res.rowCount ?? 0;
    log(`[replay] Deleted ${counts[table]} rows from ${table} (ledger >= ${fromLedger})`);
  }

  // circle_members, reputation, and circles have no single `ledger` column
  // covering their full lifecycle.  For a partial replay we leave them in
  // place — deleting them would orphan the contribution/payout/default rows
  // with ledger < fromLedger that we intentionally preserved above.
  // The poller will upsert/update these rows as it re-processes events.
  const preservedTables: DerivedTable[] = ["circle_members", "reputation", "circles"];
  for (const table of preservedTables) {
    counts[table] = 0; // no rows removed
    log(`[replay] Preserved table: ${table} (no ledger column — kept for partial replay)`);
  }

  return counts;
}

/**
 * Prepare the database for a re-index run starting at `fromLedger`.
 *
 * This is the primary entry point for replay operations.  It runs inside a
 * single transaction so a crash mid-operation leaves the database unchanged.
 *
 * After this returns the caller should restart (or let the poller resume) the
 * event ingest loop — the cursor is now positioned at fromLedger - 1 so the
 * first poll tick will fetch events from exactly fromLedger.
 *
 * @throws if fromLedger is negative or not an integer.
 * @throws if the database is unreachable or the transaction is rolled back.
 */
export async function prepareReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const { fromLedger, fullWipe = true, log = console.log } = opts;

  if (!Number.isInteger(fromLedger) || fromLedger < 0) {
    throw new Error(
      `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
    );
  }

  log(
    `[replay] Preparing ${fullWipe ? "full" : "partial"} replay from ledger ${fromLedger}...`,
  );

  return withTransaction(async (client) => {
    // ── 1. Wipe derived tables ──────────────────────────────────────────────
    let rowsRemovedByTable: Partial<Record<string, number>>;
    if (fullWipe || fromLedger === 0) {
      rowsRemovedByTable = await wipeAllDerivedTables(client, log);
    } else {
      rowsRemovedByTable = await wipeFromLedger(client, fromLedger, log);
    }

    // ── 2. Clear ingested_events for the replay range ───────────────────────
    // Removing dedup keys is what actually allows the poller to re-process
    // events — without this, `ingestEvent()` would see "already processed"
    // and skip every event.  We only clear events for ledgers >= fromLedger
    // even on a fullWipe so that a full reset still takes this path cleanly.
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
    const newCursor = fromLedger === 0 ? 0 : fromLedger - 1;
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
      fullWipe: fullWipe || fromLedger === 0,
      eventsCleared,
      rowsRemovedByTable,
    };
  });
}

// ─── Health / preflight check ─────────────────────────────────────────────────

export interface ReplayPreflightResult {
  /** Whether the replay can safely proceed. */
  safe: boolean;
  /**
   * Estimated number of ingested_events rows that would be cleared.
   * This is an approximation based on a count query; the actual number
   * deleted inside the transaction may differ slightly under concurrent writes.
   */
  estimatedEventsToReplay: number;
  /** Current last_ledger cursor from indexer_state. */
  currentLedger: number;
  warnings: string[];
}

/**
 * Non-destructive preflight check before running a replay.
 * Useful for operator dry-runs and the CLI --dry-run flag.
 */
export async function replayPreflight(fromLedger: number): Promise<ReplayPreflightResult> {
  if (!Number.isInteger(fromLedger) || fromLedger < 0) {
    throw new Error(
      `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
    );
  }

  const warnings: string[] = [];

  const [stateRow] = (
    await pool.query<{ last_ledger: string }>(
      "SELECT last_ledger FROM indexer_state WHERE id = 1",
    )
  ).rows;
  const currentLedger = stateRow ? Number(stateRow.last_ledger) : 0;

  if (fromLedger > currentLedger) {
    warnings.push(
      `fromLedger (${fromLedger}) is ahead of the current cursor (${currentLedger}). ` +
        `The replay range would be empty — the indexer is not yet that far ahead.`,
    );
  }

  const countQuery =
    fromLedger === 0
      ? "SELECT COUNT(*) as count FROM ingested_events"
      : "SELECT COUNT(*) as count FROM ingested_events WHERE ledger >= $1";
  const countParams = fromLedger === 0 ? [] : [fromLedger];
  const [countRow] = (
    await pool.query<{ count: string }>(countQuery, countParams)
  ).rows;
  const estimatedEventsToReplay = Number(countRow?.count ?? 0);

  if (estimatedEventsToReplay === 0 && fromLedger <= currentLedger) {
    warnings.push(
      "No ingested_events rows found for the given ledger range. " +
        "The replay will still reset the cursor but won't re-process any events.",
    );
  }

  return {
    safe: true, // preflight never blocks — caller decides based on warnings
    estimatedEventsToReplay,
    currentLedger,
    warnings,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
//
// Run directly: npx ts-node src/db/replay.ts --from=<ledger> [--partial] [--dry-run]
//
// Flags:
//   --from=<n>   Required. Ledger number to replay from (0 = genesis).
//   --partial    Keep rows from ledgers < fromLedger in derived tables.
//   --dry-run    Print what would happen without touching the database.

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const fromArg = args.find((a) => a.startsWith("--from="));
    const partial = args.includes("--partial");
    const dryRun = args.includes("--dry-run");

    if (!fromArg) {
      console.error("[replay] Usage: ts-node src/db/replay.ts --from=<ledger> [--partial] [--dry-run]");
      process.exit(1);
    }

    const fromLedger = Number(fromArg.replace("--from=", ""));
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      console.error(`[replay] --from must be a non-negative integer, got: "${fromArg}"`);
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
      process.exit(0);
    }

    try {
      const result = await prepareReplay({
        fromLedger,
        fullWipe: !partial,
      });
      console.log(`[replay] Done. Events cleared: ${result.eventsCleared}`);
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error("[replay] Error:", err);
      await pool.end();
      process.exit(1);
    }
  })();
}
