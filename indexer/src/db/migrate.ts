import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { pool } from "./pool";

const migrationsDir = path.join(__dirname, "migrations");

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function migrationFilesOnDisk(): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic order, e.g. 001_..., 002_...
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  // Filenames recorded as applied in schema_migrations but missing on disk —
  // signals someone deleted/renamed a migration that already ran elsewhere.
  missingOnDisk: string[];
  // Filenames whose on-disk content no longer matches the stored hash —
  // signals an edit to an already-applied migration file.
  modified: string[];
  // The most recently applied migration, or null if none have run yet. This
  // doubles as the schema's version identifier since migrations are ordered
  // and cumulative.
  currentVersion: string | null;
}

// ─── Schema health ─────────────────────────────────────────────────────────

/**
 * Classification of the database's schema state relative to the migration
 * files on disk.  Returned by `checkMigrationHealth()` so callers can make
 * structured decisions (block boot, warn, proceed) without parsing strings.
 *
 * States:
 *   clean      — schema_migrations matches disk perfectly; nothing pending.
 *   pending    — migrations exist on disk that have not been applied yet; DB
 *                is behind but not corrupt.
 *   drifted    — one or more filenames recorded as applied in
 *                schema_migrations have no corresponding file on disk; this
 *                usually means a migration was renamed or deleted after it ran.
 *   modified   — one or more applied migration files have been edited since
 *                they were applied (content hash mismatch); this indicates
 *                environment drift that could silently alter future behaviour.
 *   partial    — both pending migrations AND missingOnDisk entries exist at the
 *                same time; the DB is neither fully up-to-date nor clean.
 *   uninitialized — schema_migrations table itself doesn't exist yet; no base
 *                   schema has been applied.
 */
export type SchemaHealthState =
  | "clean"
  | "pending"
  | "drifted"
  | "modified"
  | "partial"
  | "uninitialized";

export interface MigrationHealth {
  state: SchemaHealthState;
  status: MigrationStatus;
  // Human-readable summary of the health state, suitable for logs and the
  // /health endpoint.
  summary: string;
  // true when the indexer can start safely without running migrations first.
  // Only true for the "clean" state.
  canStartSafely: boolean;
}

/**
 * Reads applied-migration state from the DB and compares it against the
 * migration files on disk. Requires schema_migrations to already exist
 * (see schema.sql), so callers should run the base schema first.
 *
 * Accepts an optional existing PoolClient to reuse an open connection rather
 * than acquiring a new one from the pool.
 */
export async function getMigrationStatus(
  existingClient?: import("pg").PoolClient,
): Promise<MigrationStatus> {
  const filesOnDisk = migrationFilesOnDisk();

  let appliedRows: Array<{ filename: string; content_hash: string | null }>;
  try {
    const queryFn = existingClient
      ? (text: string) => existingClient.query<{ filename: string; content_hash: string | null }>(text)
      : (text: string) => pool.query<{ filename: string; content_hash: string | null }>(text);
    const { rows } = await queryFn(
      "SELECT filename, content_hash FROM schema_migrations ORDER BY filename",
    );
    appliedRows = rows;
  } catch (err) {
    // undefined_table — schema.sql hasn't been applied yet, so nothing has run.
    if ((err as { code?: string }).code === "42P01") {
      appliedRows = [];
    } else {
      throw err;
    }
  }

  const appliedSet = new Set(appliedRows.map((r) => r.filename));
  const hashMap = new Map(appliedRows.map((r) => [r.filename, r.content_hash]));

  const applied = filesOnDisk.filter((f) => appliedSet.has(f));
  const pending = filesOnDisk.filter((f) => !appliedSet.has(f));
  const missingOnDisk = [...appliedSet].filter((f) => !filesOnDisk.includes(f));

  // Detect files that exist on disk AND are applied but whose content has changed.
  const modified = applied.filter((f) => {
    const storedHash = hashMap.get(f);
    if (!storedHash) return false; // no hash stored yet — skip (backwards compat)
    const diskHash = sha256File(path.join(migrationsDir, f));
    return diskHash !== storedHash;
  });

  return {
    applied,
    pending,
    missingOnDisk,
    modified,
    currentVersion: applied.length > 0 ? applied[applied.length - 1] : null,
  };
}

/**
 * Inspects the database state and classifies it as one of the well-defined
 * SchemaHealthState values.  Does not mutate the DB — safe to call at any
 * time, including from the /health endpoint.
 *
 * Accepts an optional existing PoolClient so callers that already hold a
 * connection (e.g. runMigrations) can avoid acquiring a second one from the
 * pool and prevent potential pool exhaustion under low max-connection configs.
 *
 * Decision matrix:
 *   schema_migrations missing             → uninitialized
 *   pending > 0 AND missingOnDisk > 0     → partial
 *   missingOnDisk > 0                     → drifted
 *   pending > 0                           → pending
 *   (else)                                → clean
 */
export async function checkMigrationHealth(
  existingClient?: import("pg").PoolClient,
): Promise<MigrationHealth> {
  const query = existingClient
    ? (text: string) => existingClient.query(text)
    : (text: string) => pool.query(text);

  // Check whether the base schema (schema_migrations table) even exists yet.
  let schemaExists = true;
  try {
    await query("SELECT 1 FROM schema_migrations LIMIT 1");
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") {
      schemaExists = false;
    } else {
      throw err;
    }
  }

  if (!schemaExists) {
    const filesOnDisk = migrationFilesOnDisk();
    const status: MigrationStatus = {
      applied: [],
      pending: filesOnDisk,
      missingOnDisk: [],
      modified: [],
      currentVersion: null,
    };
    return {
      state: "uninitialized",
      status,
      summary:
        "Schema has not been initialized. Run `npm run migrate:dev` to apply the base schema and all pending migrations.",
      canStartSafely: false,
    };
  }

  const status = await getMigrationStatus(existingClient);
  const { pending, missingOnDisk, modified } = status;

  let state: SchemaHealthState;
  let summary: string;

  if (pending.length > 0 && missingOnDisk.length > 0) {
    state = "partial";
    summary =
      `Schema is in a partial state: ${pending.length} migration(s) pending on disk ` +
      `(${pending.join(", ")}) ` +
      `AND ${missingOnDisk.length} migration(s) recorded as applied but missing from disk ` +
      `(${missingOnDisk.join(", ")}). ` +
      `Investigate before running migrations — the missing files may indicate a renamed or deleted migration.`;
  } else if (missingOnDisk.length > 0) {
    state = "drifted";
    summary =
      `Schema has drifted: ${missingOnDisk.length} migration(s) recorded as applied in ` +
      `schema_migrations but no longer present on disk: ${missingOnDisk.join(", ")}. ` +
      `This usually means a migration file was renamed or deleted after it ran.`;
  } else if (modified.length > 0) {
    state = "modified";
    summary =
      `${modified.length} applied migration file(s) have been edited since they were applied: ` +
      `${modified.join(", ")}. ` +
      `Editing applied migrations causes environment drift and may silently alter future behaviour. ` +
      `Restore the original file(s) or create a new migration to make the change.`;
  } else if (pending.length > 0) {
    state = "pending";
    summary =
      `Schema is behind: ${pending.length} migration(s) pending — ` +
      `${pending.join(", ")}. Run \`npm run migrate:dev\` to apply them.`;
  } else {
    state = "clean";
    summary =
      status.currentVersion != null
        ? `Schema is up to date at version ${status.currentVersion}.`
        : "Schema is up to date (no additive migrations have been applied yet).";
  }

  return {
    state,
    status,
    summary,
    canStartSafely: state === "clean",
  };
}

function logStatus(status: MigrationStatus) {
  console.log(
    `[migrate] Schema version: ${status.currentVersion ?? "(none applied)"} ` +
      `— ${status.applied.length} applied, ${status.pending.length} pending`,
  );
  if (status.missingOnDisk.length > 0) {
    console.warn(
      `[migrate] Warning: ${status.missingOnDisk.length} migration(s) recorded ` +
        `as applied but missing from src/db/migrations/: ${status.missingOnDisk.join(", ")}`,
    );
  }
}

/**
 * Apply the base schema (idempotent CREATE TABLE IF NOT EXISTS statements)
 * followed by any additive .sql migration files in src/db/migrations/, ordered
 * by filename.  Each migration is wrapped in a transaction so a partial failure
 * leaves the DB in the last-good state.
 *
 * Drift is detected and logged before applying any migrations so operators
 * can see the health state in the same log run that applies fixes.  Drifted
 * or partial states do NOT abort the run — pending migrations are still
 * applied — but they produce a prominent warning so operators notice.
 */
export async function runMigrations(): Promise<MigrationStatus> {
  const client = await pool.connect();
  try {
    // ── Base schema ─────────────────────────────────────────────────────────
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    await client.query(schemaSql);
    console.log("[migrate] Base schema applied");

    // ── Health check before applying additive migrations ─────────────────────
    // We run this after the base schema so schema_migrations is guaranteed to
    // exist for the health query.  Pass the existing client so we reuse the
    // open connection rather than acquiring a second one from the pool.
    const health = await checkMigrationHealth(client);
    if (health.state === "drifted" || health.state === "partial" || health.state === "modified") {
      console.warn(`[migrate] WARNING — ${health.summary}`);
    } else if (health.state === "pending") {
      console.log(`[migrate] ${health.summary}`);
    }

    // ── Additive migrations ──────────────────────────────────────────────────
    const files = migrationFilesOnDisk();
    if (files.length === 0) {
      console.log("[migrate] No migrations directory found — skipping");
    }

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (rows.length > 0) {
        console.log(`[migrate] Already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const contentHash = crypto.createHash("sha256").update(sql, "utf8").digest("hex");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, content_hash) VALUES ($1, $2)",
          [file, contentHash],
        );
        await client.query("COMMIT");
        console.log(`[migrate] Applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`[migrate] Failed on ${file}: ${err}`);
      }
    }
  } finally {
    client.release();
  }

  // Client is released above — use pool directly for the final status read.
  const status = await getMigrationStatus();
  logStatus(status);
  return status;
}

// Run directly: npx ts-node src/db/migrate.ts [--status] [--check]
if (require.main === module) {
  const statusOnly = process.argv.includes("--status");
  const checkOnly = process.argv.includes("--check");

  async function run(): Promise<number> {
    if (checkOnly) {
      const health = await checkMigrationHealth();
      console.log(`[migrate] Health state: ${health.state}`);
      console.log(`[migrate] ${health.summary}`);
      logStatus(health.status);
      // Return 1 for any unhealthy state so CI scripts can gate on this.
      return health.canStartSafely ? 0 : 1;
    }

    if (statusOnly) {
      const status = await getMigrationStatus();
      logStatus(status);
      return 0;
    }

    await runMigrations();
    return 0;
  }

  run()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[migrate] Error:", err);
      process.exit(1);
    });
}
