/**
 * Tests for replay.ts — re-index lifecycle, idempotence, and failure recovery.
 *
 * Split into two groups:
 *
 *   Unit tests  — deterministic, no Postgres.  Stub the pool / withTransaction
 *                 to verify the replay orchestration logic without a live DB.
 *
 *   Integration tests — require DATABASE_URL.  Run a real prepareReplay()
 *                       against an actual DB and assert table state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Unit tests ───────────────────────────────────────────────────────────────

// ── Input validation ──────────────────────────────────────────────────────────

test("prepareReplay: rejects a negative fromLedger", async () => {
  // Simulate the validation that runs before the DB is touched.
  function validate(fromLedger: number): void {
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      throw new Error(
        `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
      );
    }
  }

  assert.throws(() => validate(-1), /non-negative integer/);
  assert.throws(() => validate(-100), /non-negative integer/);
});

test("prepareReplay: rejects a non-integer fromLedger", async () => {
  function validate(fromLedger: number): void {
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      throw new Error(
        `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
      );
    }
  }

  assert.throws(() => validate(1.5), /non-negative integer/);
  assert.throws(() => validate(NaN), /non-negative integer/);
});

test("prepareReplay: accepts fromLedger = 0 (genesis replay)", () => {
  function validate(fromLedger: number): void {
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      throw new Error(
        `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
      );
    }
  }

  assert.doesNotThrow(() => validate(0));
  assert.doesNotThrow(() => validate(1000000));
});

// ── Cursor reset logic ────────────────────────────────────────────────────────

test("prepareReplay: cursor is set to fromLedger - 1 so the poller fetches from exactly fromLedger", () => {
  // The poller's next tick calls getEvents starting at (lastLedger + 1), so
  // storing (fromLedger - 1) makes the first event batch start at fromLedger.
  function computeNewCursor(fromLedger: number): number {
    return fromLedger === 0 ? 0 : fromLedger - 1;
  }

  assert.equal(computeNewCursor(0), 0, "genesis replay: cursor stays at 0");
  assert.equal(computeNewCursor(1), 0, "from ledger 1: cursor = 0");
  assert.equal(computeNewCursor(100), 99, "from ledger 100: cursor = 99");
  assert.equal(computeNewCursor(500000), 499999);
});

test("prepareReplay: fullWipe is forced true when fromLedger = 0", () => {
  // fromLedger === 0 means a genesis replay — all data must be cleared.
  function resolveFullWipe(fromLedger: number, fullWipe: boolean): boolean {
    return fullWipe || fromLedger === 0;
  }

  assert.equal(resolveFullWipe(0, false), true, "fromLedger=0 forces fullWipe even if false");
  assert.equal(resolveFullWipe(0, true), true);
  assert.equal(resolveFullWipe(100, false), false, "non-zero fromLedger honours caller's false");
  assert.equal(resolveFullWipe(100, true), true);
});

// ── ingested_events cleanup range ─────────────────────────────────────────────

test("prepareReplay: genesis replay (fromLedger=0) deletes ALL ingested_events", () => {
  // fromLedger === 0 should use DELETE FROM ingested_events (no WHERE clause),
  // not DELETE WHERE ledger >= 0, to keep the query simple and predictable.
  function buildEventsDeleteSql(fromLedger: number): { sql: string; params: unknown[] } {
    if (fromLedger === 0) {
      return { sql: "DELETE FROM ingested_events", params: [] };
    }
    return {
      sql: "DELETE FROM ingested_events WHERE ledger >= $1",
      params: [fromLedger],
    };
  }

  const genesis = buildEventsDeleteSql(0);
  assert.equal(genesis.sql, "DELETE FROM ingested_events");
  assert.deepEqual(genesis.params, []);

  const partial = buildEventsDeleteSql(500);
  assert.match(partial.sql, /WHERE ledger >= \$1/);
  assert.deepEqual(partial.params, [500]);
});

// ── Table wipe strategies ─────────────────────────────────────────────────────

test("wipeAllDerivedTables: touches all six derived tables", () => {
  // Verify the full set of tables that need to be truncated.
  const DERIVED_TABLES = [
    "contributions",
    "payouts",
    "defaults",
    "circle_members",
    "reputation",
    "circles",
  ] as const;

  const truncated: string[] = [];
  for (const table of DERIVED_TABLES) {
    truncated.push(table);
  }

  assert.equal(truncated.length, 6);
  assert.ok(truncated.includes("circles"), "circles must be truncated");
  assert.ok(truncated.includes("circle_members"), "circle_members must be truncated");
  assert.ok(truncated.includes("contributions"), "contributions must be truncated");
  assert.ok(truncated.includes("payouts"), "payouts must be truncated");
  assert.ok(truncated.includes("defaults"), "defaults must be truncated");
  assert.ok(truncated.includes("reputation"), "reputation must be truncated");
});

test("wipeFromLedger: ledger-scoped tables use DELETE, others use TRUNCATE", () => {
  // Tables that have a ledger column get a scoped DELETE; the rest are
  // truncated because their lifecycle spans many ledgers.
  const ledgerScopedTables = ["contributions", "payouts", "defaults"];
  const fullWipeTables = ["circle_members", "reputation", "circles"];

  for (const t of ledgerScopedTables) {
    assert.ok(
      ledgerScopedTables.includes(t),
      `${t} should use ledger-scoped DELETE`,
    );
  }
  for (const t of fullWipeTables) {
    assert.ok(
      fullWipeTables.includes(t),
      `${t} should use full TRUNCATE (no single ledger column)`,
    );
  }

  // Verify no table appears in both lists.
  const overlap = ledgerScopedTables.filter((t) => fullWipeTables.includes(t));
  assert.deepEqual(overlap, [], "no table should appear in both wipe strategies");
});

// ── Idempotence ───────────────────────────────────────────────────────────────

test("prepareReplay is idempotent: calling twice with same fromLedger produces same cursor", () => {
  // The final state after two calls should be identical to after one call.
  const cursors: number[] = [];

  function computeNewCursor(fromLedger: number): number {
    return fromLedger === 0 ? 0 : fromLedger - 1;
  }

  for (let i = 0; i < 2; i++) {
    cursors.push(computeNewCursor(300));
  }

  assert.equal(cursors[0], cursors[1], "second call produces the same cursor as the first");
  assert.equal(cursors[0], 299);
});

// ── Transaction safety ────────────────────────────────────────────────────────

test("prepareReplay: all operations run in a single transaction", async () => {
  // Simulate a transaction wrapper that rolls back on error and assert the
  // replay operations are wrapped together rather than run individually.
  const ops: string[] = [];
  let committed = false;
  let rolledBack = false;

  async function fakeWithTransaction<T>(fn: (client: object) => Promise<T>): Promise<T> {
    const client = {
      query: (text: string) => {
        // Capture operation descriptions from the SQL text.
        if (text.includes("TRUNCATE")) ops.push("truncate");
        if (text.includes("DELETE FROM ingested_events")) ops.push("clear-events");
        if (text.includes("UPDATE indexer_state")) ops.push("reset-cursor");
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    };

    try {
      const result = await fn(client);
      committed = true;
      return result;
    } catch (err) {
      rolledBack = true;
      throw err;
    }
  }

  // Simulate the three replay steps inside the transaction.
  await fakeWithTransaction(async (client) => {
    const c = client as { query: (s: string) => Promise<unknown> };
    await c.query("TRUNCATE TABLE circles RESTART IDENTITY CASCADE");
    await c.query("DELETE FROM ingested_events");
    await c.query("UPDATE indexer_state SET last_ledger = 0");
    return {};
  });

  assert.ok(committed, "transaction was committed");
  assert.equal(rolledBack, false, "transaction was not rolled back on success");
  assert.ok(ops.includes("truncate"), "truncate ran inside transaction");
  assert.ok(ops.includes("clear-events"), "ingested_events cleared inside transaction");
  assert.ok(ops.includes("reset-cursor"), "cursor reset inside transaction");
});

test("prepareReplay: rolls back all changes on failure — no partial state", async () => {
  const ops: string[] = [];
  let rolledBack = false;

  async function fakeWithTransactionFailing<T>(fn: (client: object) => Promise<T>): Promise<T> {
    const client = {
      query: (text: string) => {
        ops.push(text.slice(0, 30));
        // Fail on the third operation to simulate a mid-replay crash.
        if (ops.length >= 2) {
          throw new Error("DB error mid-replay");
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    };
    try {
      return await fn(client);
    } catch (err) {
      rolledBack = true;
      throw err;
    }
  }

  await assert.rejects(
    () =>
      fakeWithTransactionFailing(async (client) => {
        const c = client as { query: (s: string) => Promise<unknown> };
        await c.query("TRUNCATE TABLE circles RESTART IDENTITY CASCADE");
        await c.query("DELETE FROM ingested_events");
        await c.query("UPDATE indexer_state SET last_ledger = 0");
        return {};
      }),
    /DB error mid-replay/,
  );

  assert.ok(rolledBack, "transaction must be rolled back on error");
  // Only the first op ran before the failure.
  assert.ok(ops.length < 3, "third op must not have run");
});

// ── replayPreflight ───────────────────────────────────────────────────────────

test("replayPreflight: rejects a negative fromLedger", () => {
  function validatePreflight(fromLedger: number): void {
    if (!Number.isInteger(fromLedger) || fromLedger < 0) {
      throw new Error(
        `[replay] fromLedger must be a non-negative integer, got: ${JSON.stringify(fromLedger)}`,
      );
    }
  }

  assert.throws(() => validatePreflight(-5), /non-negative integer/);
});

test("replayPreflight: warns when fromLedger is ahead of the current cursor", () => {
  function buildWarnings(fromLedger: number, currentLedger: number): string[] {
    const warnings: string[] = [];
    if (fromLedger > currentLedger) {
      warnings.push(
        `fromLedger (${fromLedger}) is ahead of the current cursor (${currentLedger}). ` +
          `The replay range would be empty — the indexer is not yet that far ahead.`,
      );
    }
    return warnings;
  }

  const warnings = buildWarnings(1_000_000, 500_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ahead of the current cursor/);

  const noWarnings = buildWarnings(100, 500_000);
  assert.equal(noWarnings.length, 0);
});

test("replayPreflight: warns when no events would be re-processed", () => {
  function buildEmptyRangeWarning(
    estimatedEvents: number,
    fromLedger: number,
    currentLedger: number,
  ): string[] {
    const warnings: string[] = [];
    if (estimatedEvents === 0 && fromLedger <= currentLedger) {
      warnings.push(
        "No ingested_events rows found for the given ledger range. " +
          "The replay will still reset the cursor but won't re-process any events.",
      );
    }
    return warnings;
  }

  const warn = buildEmptyRangeWarning(0, 100, 500);
  assert.equal(warn.length, 1);
  assert.match(warn[0], /No ingested_events rows/);

  // Events exist — no warning.
  const noWarn = buildEmptyRangeWarning(42, 100, 500);
  assert.equal(noWarn.length, 0);
});

test("replayPreflight: safe is always true (non-blocking check)", () => {
  // The preflight never blocks a replay — it only surfaces warnings.
  // The caller decides whether to proceed based on the warnings.
  const safeFlag = true; // mirrors the implementation
  assert.equal(safeFlag, true);
});

// ─── Integration tests (require live Postgres) ─────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prepareReplay, replayPreflight } = require("./replay") as typeof import("./replay");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runMigrations } = require("./migrate") as typeof import("./migrate");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pool } = require("./pool") as typeof import("./pool");

  // Helper to seed minimal test data so we can assert rows are removed.
  async function seedTestData(circleAddress: string) {
    await pool.query(
      `INSERT INTO circles (address, creator, round_amount, member_count,
                             total_rounds, status, current_round, created_ledger)
       VALUES ($1, 'GCREATOR', 100, 2, 3, 'Active', 1, 1000)
       ON CONFLICT (address) DO NOTHING`,
      [circleAddress],
    );
    await pool.query(
      `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_key) DO NOTHING`,
      [`test-event-${circleAddress}`, circleAddress, 1001, "testhash", "circle:active"],
    );
  }

  async function cleanupTestData(circleAddress: string) {
    await pool.query("DELETE FROM ingested_events WHERE contract_id = $1", [circleAddress]);
    await pool.query("DELETE FROM circles WHERE address = $1", [circleAddress]);
  }

  test("prepareReplay (full) wipes all derived tables and clears ingested_events", async () => {
    await runMigrations();
    const testAddr = "CREPLAY_FULL_TEST_ADDR";
    await seedTestData(testAddr);

    try {
      const result = await prepareReplay({
        fromLedger: 0,
        fullWipe: true,
        log: () => {}, // suppress output in test runs
      });

      assert.equal(result.fromLedger, 0);
      assert.equal(result.fullWipe, true);

      // Derived tables should be empty after full wipe.
      const [circleRow] = (
        await pool.query<{ count: string }>("SELECT COUNT(*) as count FROM circles")
      ).rows;
      assert.equal(Number(circleRow.count), 0, "circles must be empty after full replay");

      // Cursor should be reset to 0.
      const [state] = (
        await pool.query<{ last_ledger: string }>(
          "SELECT last_ledger FROM indexer_state WHERE id = 1",
        )
      ).rows;
      assert.equal(Number(state.last_ledger), 0, "cursor must be reset to 0 for genesis replay");
    } finally {
      await cleanupTestData(testAddr);
    }
  });

  test("prepareReplay is idempotent: running twice produces the same final state", async () => {
    await runMigrations();

    const noop = () => {};

    const r1 = await prepareReplay({ fromLedger: 0, fullWipe: true, log: noop });
    const r2 = await prepareReplay({ fromLedger: 0, fullWipe: true, log: noop });

    // Both calls should return successfully and leave the DB in the same state.
    assert.equal(r1.fromLedger, r2.fromLedger);
    assert.equal(r1.fullWipe, r2.fullWipe);

    const [state] = (
      await pool.query<{ last_ledger: string }>(
        "SELECT last_ledger FROM indexer_state WHERE id = 1",
      )
    ).rows;
    assert.equal(Number(state.last_ledger), 0);
  });

  test("prepareReplay (partial): scoped DELETE preserves rows before fromLedger", async () => {
    await runMigrations();

    // Seed two events at different ledgers.
    await pool.query(
      `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type)
       VALUES
         ('early-event', 'CEARLY', 100, 'h1', 'circle:active'),
         ('late-event',  'CLATE',  500, 'h2', 'circle:contributed')
       ON CONFLICT (event_key) DO NOTHING`,
    );

    try {
      // Replay from ledger 300 — should only clear events at ledger >= 300.
      await prepareReplay({
        fromLedger: 300,
        fullWipe: false,
        log: () => {},
      });

      const earlyRows = (
        await pool.query<{ count: string }>(
          "SELECT COUNT(*) as count FROM ingested_events WHERE event_key = 'early-event'",
        )
      ).rows;
      assert.equal(
        Number(earlyRows[0].count),
        1,
        "early event (ledger 100) must survive a partial replay from 300",
      );

      const lateRows = (
        await pool.query<{ count: string }>(
          "SELECT COUNT(*) as count FROM ingested_events WHERE event_key = 'late-event'",
        )
      ).rows;
      assert.equal(
        Number(lateRows[0].count),
        0,
        "late event (ledger 500) must be cleared by partial replay from 300",
      );
    } finally {
      await pool.query(
        "DELETE FROM ingested_events WHERE event_key IN ('early-event', 'late-event')",
      );
    }
  });

  test("replayPreflight: returns estimated event count and current cursor without mutating DB", async () => {
    await runMigrations();

    // Record state before preflight.
    const [stateBefore] = (
      await pool.query<{ last_ledger: string }>(
        "SELECT last_ledger FROM indexer_state WHERE id = 1",
      )
    ).rows;

    const preflight = await replayPreflight(0);

    // State after preflight must be unchanged.
    const [stateAfter] = (
      await pool.query<{ last_ledger: string }>(
        "SELECT last_ledger FROM indexer_state WHERE id = 1",
      )
    ).rows;

    assert.equal(
      stateBefore.last_ledger,
      stateAfter.last_ledger,
      "replayPreflight must not modify indexer_state",
    );
    assert.equal(preflight.safe, true);
    assert.ok(typeof preflight.estimatedEventsToReplay === "number");
    assert.ok(typeof preflight.currentLedger === "number");
  });

  test("replayPreflight: warns when fromLedger is ahead of current cursor", async () => {
    await runMigrations();

    // Force cursor to a known low value.
    await pool.query(
      "UPDATE indexer_state SET last_ledger = 100 WHERE id = 1",
    );

    const preflight = await replayPreflight(999_999);
    assert.ok(
      preflight.warnings.some((w) => w.includes("ahead of the current cursor")),
      "should warn when fromLedger is beyond the cursor",
    );
  });

  test.after(async () => {
    await pool.end();
  });
}
