import { Pool, PoolClient, QueryResultRow } from "pg";
import * as dotenv from "dotenv";
import { DB_CONNECT_MAX_RETRIES, DB_CONNECT_BASE_DELAY_MS } from "../config";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

// Node surfaces a refused/unreachable TCP connection (the common case while
// Postgres is still starting) as an AggregateError whose own `.message` is
// "" — the useful text lives in `.errors[]` instead. Falling back to
// `String(err)` for that case would just print "AggregateError", so this
// unwraps it (and falls back to `.code`, e.g. "ECONNREFUSED") to keep the
// retry/failure logs actually readable.
function describeConnectionError(err: unknown): string {
  if (err && typeof err === "object") {
    const { message, code, errors } = err as {
      message?: string;
      code?: string;
      errors?: unknown[];
    };
    if (message) return message;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    }
    if (code) return code;
  }
  return String(err);
}

/**
 * Verifies Postgres is reachable, retrying with exponential backoff.
 *
 * Postgres frequently isn't accepting connections yet the moment the indexer
 * starts (e.g. `docker compose up` racing the app against the DB container's
 * boot time), and the default single-shot `pool.connect()` would otherwise
 * fail the whole process on that first, likely-transient error. Call this
 * once at startup, before any query that assumes a live connection.
 *
 * The default `maxRetries` and `baseDelayMs` are read from the
 * `DB_CONNECT_MAX_RETRIES` and `DB_CONNECT_BASE_DELAY_MS` environment
 * variables (validated and exported by `../config`), so operators can tune
 * retry behaviour without a code change.
 */
export async function connectWithRetry({
  pool: targetPool = pool,
  maxRetries = DB_CONNECT_MAX_RETRIES,
  baseDelayMs = DB_CONNECT_BASE_DELAY_MS,
}: {
  pool?: Pick<Pool, "connect">;
  maxRetries?: number;
  baseDelayMs?: number;
} = {}): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await targetPool.connect();
      client.release();
      if (attempt > 1) {
        console.log(`[db] Connected to Postgres (attempt ${attempt}/${maxRetries})`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[db] Postgres connection attempt ${attempt}/${maxRetries} failed: ` +
          `${describeConnectionError(err)} — retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `[db] Could not connect to Postgres after ${maxRetries} attempt(s): ` +
      describeConnectionError(lastErr),
  );
}

/**
 * Execute a parameterised SQL query and return all matching rows as a typed
 * array.
 *
 * Use this for queries that may legitimately return zero, one, or many rows.
 * For single-row lookups prefer {@link queryOne} (returns `T | null`) or
 * {@link queryExact} (throws when no row is found) — both communicate intent
 * more clearly at the call-site and eliminate the `const [row] = await
 * query(...)` pattern that silently discards type-safety on `undefined`.
 *
 * @param text   Parameterised SQL string — parameters are referenced as `$1`,
 *               `$2`, … (never interpolated directly).
 * @param params Query parameter values, in `$N` order.
 * @returns      Typed array of result rows; empty when no rows match.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const res = await client.query<T>(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * Execute a parameterised SQL query and return the first matching row, or
 * `null` when no rows are returned.
 *
 * This is the canonical helper for point lookups (e.g. `SELECT … WHERE id =
 * $1`) — it replaces the fragile `const [row] = await query(...)` pattern
 * that silently produces `undefined` (typed as `T`) when no row exists.
 *
 * **Invariant**: if the query returns more than one row, only the first is
 * returned; add a `LIMIT 1` clause when the query does not already guarantee
 * at most one row.
 *
 * @param text   Parameterised SQL string.
 * @param params Query parameter values, in `$N` order.
 * @returns      First row typed as `T`, or `null` if the result set is empty.
 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Execute a parameterised SQL query and return the first matching row,
 * throwing a descriptive `Error` when the result set is empty.
 *
 * Use this helper when the caller has already confirmed (via a prior
 * constraint or business rule) that a row must exist — the thrown error
 * surfaces the problem immediately rather than letting `undefined` propagate
 * and produce a confusing downstream failure.
 *
 * @param text        Parameterised SQL string.
 * @param params      Query parameter values, in `$N` order.
 * @param errorMessage Optional message for the thrown error; defaults to
 *                    `"Expected exactly one row but got none"`.
 * @returns           First row typed as `T`.
 * @throws            `Error` when the query returns zero rows.
 */
export async function queryExact<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
  errorMessage = "Expected exactly one row but got none",
): Promise<T> {
  const row = await queryOne<T>(text, params);
  if (row === null) {
    throw new Error(errorMessage);
  }
  return row;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
