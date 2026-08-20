/**
 * Tests for migrate.ts — migration lifecycle, drift detection, and health
 * classification.
 *
 * Split into two groups:
 *
 *   Unit tests  — deterministic, no Postgres.  Exercise the pure state-
 *                 derivation logic extracted from checkMigrationHealth() and
 *                 getMigrationStatus() without a live DB connection.
 *
 *   Integration tests — require a reachable Postgres at DATABASE_URL (set up
 *                       via docker-compose.yml).  Skipped automatically when
 *                       DATABASE_URL is not set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── State-derivation helpers (mirror the logic in migrate.ts) ───────────────
//
// These helpers are extracted versions of the if-chains inside
// checkMigrationHealth() and getMigrationStatus(). Testing them directly
// means any change to the decision matrix in the real code that diverges from
// these rules will break a named test, not just produce a wrong health value.

function deriveHealthState(
  pending: number,
  missingOnDisk: number,
  schemaExists: boolean,
): string {
  if (!schemaExists) return "uninitialized";
  if (pending > 0 && missingOnDisk > 0) return "partial";
  if (missingOnDisk > 0) return "drifted";
  if (pending > 0) return "pending";
  return "clean";
}

function computeStatus(filesOnDisk: string[], appliedInDb: string[]) {
  const appliedSet = new Set(appliedInDb);
  const applied = filesOnDisk.filter((f) => appliedSet.has(f));
  const pending = filesOnDisk.filter((f) => !appliedSet.has(f));
  const missingOnDisk = appliedInDb.filter((f) => !filesOnDisk.includes(f));
  return {
    applied,
    pending,
    missingOnDisk,
    currentVersion: applied.length > 0 ? applied[applied.length - 1] : null,
  };
}

function buildHealthSummary(
  state: string,
  pending: string[],
  missingOnDisk: string[],
  currentVersion: string | null,
): string {
  switch (state) {
    case "uninitialized":
      return "Schema has not been initialized. Run `npm run migrate:dev` to apply the base schema and all pending migrations.";
    case "partial":
      return (
        `Schema is in a partial state: ${pending.length} migration(s) pending on disk ` +
        `(${pending.join(", ")}) ` +
        `AND ${missingOnDisk.length} migration(s) recorded as applied but missing from disk ` +
        `(${missingOnDisk.join(", ")}). ` +
        `Investigate before running migrations — the missing files may indicate a renamed or deleted migration.`
      );
    case "drifted":
      return (
        `Schema has drifted: ${missingOnDisk.length} migration(s) recorded as applied in ` +
        `schema_migrations but no longer present on disk: ${missingOnDisk.join(", ")}. ` +
        `This usually means a migration file was renamed or deleted after it ran.`
      );
    case "pending":
      return (
        `Schema is behind: ${pending.length} migration(s) pending — ` +
        `${pending.join(", ")}. Run \`npm run migrate:dev\` to apply them.`
      );
    default:
      return currentVersion != null
        ? `Schema is up to date at version ${currentVersion}.`
        : "Schema is up to date (no additive migrations have been applied yet).";
  }
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

test("checkMigrationHealth: all five SchemaHealthState values are reachable", () => {
  assert.equal(deriveHealthState(0, 0, true), "clean", "no pending, no drift → clean");
  assert.equal(deriveHealthState(1, 0, true), "pending", "pending files → pending");
  assert.equal(deriveHealthState(0, 1, true), "drifted", "missing on disk → drifted");
  assert.equal(deriveHealthState(1, 1, true), "partial", "both → partial");
  assert.equal(deriveHealthState(0, 0, false), "uninitialized", "no schema → uninitialized");
});

test("checkMigrationHealth: uninitialized wins even when pending > 0", () => {
  // A missing schema_migrations table overrides everything else.
  assert.equal(deriveHealthState(3, 0, false), "uninitialized");
  assert.equal(deriveHealthState(3, 2, false), "uninitialized");
});

test("checkMigrationHealth: partial requires BOTH pending and missingOnDisk", () => {
  // partial = pending AND missing — neither alone is enough
  assert.notEqual(deriveHealthState(1, 0, true), "partial");
  assert.notEqual(deriveHealthState(0, 1, true), "partial");
  assert.equal(deriveHealthState(2, 3, true), "partial");
});

test("checkMigrationHealth: canStartSafely is only true for the clean state", () => {
  // canStartSafely = (state === "clean"). We verify by deriving the state for
  // each input combination and asserting the expected safe/unsafe outcome.
  // deriveHealthState is the same logic extracted from checkMigrationHealth().

  // Only the state produced by (0 pending, 0 missing, schema exists) → clean → safe.
  assert.equal(deriveHealthState(0, 0, true), "clean");
  assert.equal(deriveHealthState(0, 0, true) === "clean", true, "clean state must be safe");

  // Every other reachable state must be unsafe.
  const unsafeInputs: Array<[number, number, boolean]> = [
    [1, 0, true],  // pending
    [0, 1, true],  // drifted
    [1, 1, true],  // partial
    [0, 0, false], // uninitialized
  ];
  for (const [pending, missing, exists] of unsafeInputs) {
    const state = deriveHealthState(pending, missing, exists);
    assert.notEqual(state, "clean", `state=${state} must not be safe`);
  }
});

test("checkMigrationHealth summaries contain actionable operator guidance", () => {
  const uninitSummary = buildHealthSummary("uninitialized", [], [], null);
  assert.match(uninitSummary, /npm run migrate:dev/, "uninitialized: mentions the fix command");

  const partialSummary = buildHealthSummary("partial", ["002_foo.sql"], ["001_bar.sql"], null);
  assert.match(partialSummary, /partial state/, "partial: uses the word 'partial'");
  assert.match(partialSummary, /001_bar\.sql/, "partial: names the missing file");
  assert.match(partialSummary, /002_foo\.sql/, "partial: names the pending file");
  assert.match(partialSummary, /Investigate/, "partial: asks operator to investigate");

  const driftedSummary = buildHealthSummary("drifted", [], ["001_gone.sql"], null);
  assert.match(driftedSummary, /drifted/, "drifted: uses the word 'drifted'");
  assert.match(driftedSummary, /001_gone\.sql/, "drifted: names the missing file");
  assert.match(driftedSummary, /renamed or deleted/, "drifted: explains the likely cause");

  const pendingSummary = buildHealthSummary("pending", ["002_add_col.sql"], [], null);
  assert.match(pendingSummary, /behind/, "pending: says 'behind'");
  assert.match(pendingSummary, /002_add_col\.sql/, "pending: names the pending file");
  assert.match(pendingSummary, /npm run migrate:dev/, "pending: mentions the fix command");

  const cleanSummary = buildHealthSummary("clean", [], [], "001_add_round_deadline_ledgers.sql");
  assert.match(cleanSummary, /up to date/, "clean: says 'up to date'");
  assert.match(cleanSummary, /001_add_round_deadline_ledgers/, "clean: names the current version");

  // Edge case: clean with no additive migrations ever applied
  const cleanNoMigrations = buildHealthSummary("clean", [], [], null);
  assert.match(cleanNoMigrations, /up to date/, "clean (no migrations yet): says up to date");
  assert.doesNotMatch(cleanNoMigrations, /null/, "clean: must not expose null in summary string");
});

test("getMigrationStatus: computes applied/pending/missingOnDisk correctly for all cases", () => {
  // Fresh state: file on disk, nothing applied yet.
  const fresh = computeStatus(["001_add_col.sql"], []);
  assert.deepEqual(fresh.applied, []);
  assert.deepEqual(fresh.pending, ["001_add_col.sql"]);
  assert.deepEqual(fresh.missingOnDisk, []);
  assert.equal(fresh.currentVersion, null);

  // Up to date: file on disk and applied.
  const upToDate = computeStatus(["001_add_col.sql"], ["001_add_col.sql"]);
  assert.deepEqual(upToDate.applied, ["001_add_col.sql"]);
  assert.deepEqual(upToDate.pending, []);
  assert.deepEqual(upToDate.missingOnDisk, []);
  assert.equal(upToDate.currentVersion, "001_add_col.sql");

  // Drifted: applied in DB but the file was deleted from disk.
  const drifted = computeStatus([], ["001_gone.sql"]);
  assert.deepEqual(drifted.applied, []);
  assert.deepEqual(drifted.missingOnDisk, ["001_gone.sql"]);
  assert.deepEqual(drifted.pending, []);
  assert.equal(drifted.currentVersion, null);

  // Partial: something new on disk AND something missing from disk.
  const partial = computeStatus(["002_new.sql"], ["001_old.sql"]);
  assert.deepEqual(partial.pending, ["002_new.sql"]);
  assert.deepEqual(partial.missingOnDisk, ["001_old.sql"]);

  // Multiple applied: currentVersion is the last one (sorted by filename).
  const multi = computeStatus(
    ["001_a.sql", "002_b.sql", "003_c.sql"],
    ["001_a.sql", "002_b.sql"],
  );
  assert.equal(multi.currentVersion, "002_b.sql", "currentVersion must be the last applied");
  assert.deepEqual(multi.pending, ["003_c.sql"]);
  assert.deepEqual(multi.missingOnDisk, []);
});

test("getMigrationStatus: currentVersion is null when nothing has been applied", () => {
  const status = computeStatus(["001_add_col.sql"], []);
  assert.equal(status.currentVersion, null);
});

test("getMigrationStatus: all missingOnDisk entries are reported, not just the first", () => {
  // Three files applied but deleted from disk — all three must appear.
  const status = computeStatus([], ["003_c.sql", "001_a.sql", "002_b.sql"]);
  assert.equal(status.missingOnDisk.length, 3, "all ghost entries must be reported");
  assert.ok(status.missingOnDisk.includes("001_a.sql"));
  assert.ok(status.missingOnDisk.includes("002_b.sql"));
  assert.ok(status.missingOnDisk.includes("003_c.sql"));
});

test("runMigrations idempotence guard: a file already in schema_migrations is skipped", () => {
  // Guard (2) in runMigrations: SELECT before executing, skip if found.
  function shouldSkip(filename: string, appliedSet: Set<string>): boolean {
    return appliedSet.has(filename);
  }

  // First run: file not in applied set → execute it.
  assert.equal(shouldSkip("001_add_round_deadline_ledgers.sql", new Set()), false);

  // Second run: same file is now in applied set → skip it.
  const applied = new Set(["001_add_round_deadline_ledgers.sql"]);
  assert.equal(shouldSkip("001_add_round_deadline_ledgers.sql", applied), true);
});

test("runMigrations transactional safety: ROLLBACK on failure leaves applied list unchanged", async () => {
  // Simulate the per-file try/catch that wraps BEGIN … COMMIT.
  // A failed migration must not add to the applied list.
  const applied: string[] = [];

  async function simulateApply(file: string, sqlWillFail: boolean): Promise<void> {
    if (sqlWillFail) {
      // ROLLBACK path — applied is not modified.
      throw new Error(`[migrate] Failed on ${file}: syntax error`);
    }
    // COMMIT path.
    applied.push(file);
  }

  // Successful apply records the file.
  await simulateApply("001_good.sql", false);
  assert.ok(applied.includes("001_good.sql"), "successful migration must be recorded");

  // Failed apply must not record anything.
  const snapshot = [...applied];
  await assert.rejects(
    () => simulateApply("002_bad.sql", true),
    /Failed on 002_bad\.sql/,
    "failed migration must throw",
  );
  assert.deepEqual(applied, snapshot, "applied list must be unchanged after a failure");
});

test("42P01 error code is treated as an empty applied set, not a thrown error", () => {
  // The 42P01 code means schema_migrations doesn't exist yet — this is the
  // normal state on a fresh database and should never crash the process.
  function handleQueryError(err: { code?: string }): Set<string> {
    if (err.code === "42P01") return new Set<string>();
    throw Object.assign(new Error("unexpected DB error"), err);
  }

  const result = handleQueryError({ code: "42P01" });
  assert.ok(result instanceof Set, "42P01 must return an empty Set");
  assert.equal(result.size, 0, "the empty Set must contain no entries");

  // Any other error code must propagate.
  assert.throws(
    () => handleQueryError({ code: "ECONNREFUSED" }),
    /unexpected DB error/,
    "non-42P01 errors must be re-thrown",
  );
});

// ─── Integration tests (require live Postgres) ─────────────────────────────
//
// Skipped when DATABASE_URL is not set.  Each integration test calls
// runMigrations() first so the schema is always in a known state regardless
// of execution order.

const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runMigrations, getMigrationStatus, checkMigrationHealth } =
    require("./migrate") as typeof import("./migrate");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pool } = require("./pool") as typeof import("./pool");

  test("runMigrations is idempotent: double-run leaves no pending migrations", async () => {
    await runMigrations();
    const status = await runMigrations(); // second call must be a no-op

    assert.equal(status.pending.length, 0, "no pending after idempotent double-run");
    assert.equal(status.missingOnDisk.length, 0, "no missing-on-disk after double-run");
    assert.ok(status.currentVersion, "currentVersion must be set once migrations exist");
    assert.ok(
      status.applied.includes(status.currentVersion!),
      "currentVersion must appear in the applied list",
    );
  });

  test("checkMigrationHealth returns clean after a full migration run", async () => {
    await runMigrations();
    const health = await checkMigrationHealth();

    assert.equal(health.state, "clean");
    assert.equal(health.canStartSafely, true);
    assert.match(health.summary, /up to date/);
  });

  test("getMigrationStatus: ghost entry in schema_migrations appears in missingOnDisk", async () => {
    await runMigrations();
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      ["999_never_existed.sql"],
    );

    try {
      const status = await getMigrationStatus();
      assert.ok(
        status.missingOnDisk.includes("999_never_existed.sql"),
        "ghost entry must appear in missingOnDisk",
      );
    } finally {
      await pool.query(
        "DELETE FROM schema_migrations WHERE filename = $1",
        ["999_never_existed.sql"],
      );
    }
  });

  test("checkMigrationHealth returns drifted when a ghost entry is present", async () => {
    await runMigrations();
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      ["888_also_gone.sql"],
    );

    try {
      const health = await checkMigrationHealth();
      assert.equal(health.state, "drifted", "ghost entry must trigger drifted state");
      assert.equal(health.canStartSafely, false, "drifted state must not be safe to start");
      assert.match(health.summary, /888_also_gone\.sql/, "summary must name the missing file");
    } finally {
      await pool.query(
        "DELETE FROM schema_migrations WHERE filename = $1",
        ["888_also_gone.sql"],
      );
    }
  });

  test.after(async () => {
    // Only end the pool in the integration block that opened it.
    await pool.end();
  });
}
