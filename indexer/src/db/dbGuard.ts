/**
 * Database identity guard for destructive operations.
 *
 * The indexer's replay, reset, and test-setup commands wipe or rewrite large
 * portions of the database.  Running them against a staging or production URL
 * that somehow ends up in a local shell — via a copy-paste, an inherited env
 * var, or a misconfigured .env file — would be catastrophic and silent.
 *
 * This module enforces a single rule before any destructive operation runs:
 * the DATABASE_URL must refer to a local Postgres instance.  "Local" is
 * defined conservatively as:
 *
 *   1. Host is localhost, 127.0.0.1, or ::1.
 *   2. OR the database name ends with _test or _dev (explicit opt-in for
 *      non-local CI environments that provision an isolated test DB).
 *
 * Anything else — a remote host, an RDS endpoint, a Cloud SQL proxy, a
 * Heroku DATABASE_URL — is rejected with a clear error message that names
 * the offending URL (with credentials redacted) and explains the safeguard.
 *
 * The guard is intentionally conservative.  If you are running a legitimate
 * destructive operation against a non-local test database in CI, set the
 * database name to end with `_test` and the check will pass.
 */

export interface DbIdentity {
  host: string;
  database: string;
  /** Redacted URL safe to include in error messages and logs. */
  redactedUrl: string;
}

/**
 * Parse a postgres connection string into its host and database components.
 *
 * Accepts both URL format (postgres://user:pass@host:port/dbname) and the
 * subset of key=value DSN format (host=... dbname=...) used in some configs.
 * Returns null if the string cannot be parsed — callers treat an unparseable
 * URL as an unsafe target.
 */
export function parseDbIdentity(url: string): DbIdentity | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // ── URL format ────────────────────────────────────────────────────────────
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") {
      const host = parsed.hostname || "localhost";
      // pathname is "/dbname"; strip the leading slash
      const database = parsed.pathname.replace(/^\//, "") || "";
      const redactedUrl = trimmed
        .replace(/:([^@/]+)@/, ":***@") // mask password
        .replace(/\/\/[^:@/]+:[^@/]+@/, "//:***@"); // double-guard
      return { host, database, redactedUrl };
    }
  } catch {
    // Not a URL — try DSN format below
  }

  // ── Key=value DSN format ──────────────────────────────────────────────────
  const hostMatch = trimmed.match(/(?:^|[ ;])host=([^ ;]+)/i);
  const dbMatch = trimmed.match(/(?:^|[ ;])dbname=([^ ;]+)/i);
  if (dbMatch) {
    const host = hostMatch?.[1] ?? "localhost";
    const database = dbMatch[1];
    const redactedUrl = trimmed.replace(/password=[^ ;]+/gi, "password=***");
    return { host, database, redactedUrl };
  }

  return null;
}

/**
 * Return true when the database identity is considered safe for destructive
 * operations (local host OR test/dev database name).
 */
export function isLocalDatabase(identity: DbIdentity): boolean {
  const { host, database } = identity;

  const isLocalHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";

  const isTestOrDevDb =
    database.endsWith("_test") || database.endsWith("_dev");

  return isLocalHost || isTestOrDevDb;
}

/**
 * Throw an error if `databaseUrl` does not refer to a local or test database.
 *
 * Call this at the top of any CLI entry point that performs destructive
 * operations (replay, reset, schema wipe).  The check is intentionally
 * synchronous and cheap — it parses the URL only, no network call.
 *
 * @param databaseUrl  The DATABASE_URL to validate (defaults to process.env.DATABASE_URL).
 * @param operation    Human-readable name of the operation, used in the error message.
 *
 * @throws if the URL targets a non-local, non-test database.
 * @throws if the URL is absent or unparseable (fail-closed).
 */
export function assertLocalDatabase(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  operation = "this operation",
): void {
  if (!databaseUrl || databaseUrl.trim() === "") {
    throw new Error(
      `[db-guard] DATABASE_URL is not set. ` +
        `${operation} refuses to run without a confirmed local database target.\n` +
        `Set DATABASE_URL to a local Postgres instance (e.g. postgresql://postgres:password@localhost:5432/circleup_test).`,
    );
  }

  const identity = parseDbIdentity(databaseUrl);

  if (identity === null) {
    throw new Error(
      `[db-guard] DATABASE_URL could not be parsed: "${databaseUrl.slice(0, 60)}…"\n` +
        `${operation} refuses to run against an unrecognised connection string.\n` +
        `Use a standard postgres:// URL or a key=value DSN.`,
    );
  }

  if (!isLocalDatabase(identity)) {
    throw new Error(
      `[db-guard] Refusing to run ${operation} against a non-local database.\n` +
        `  Target:   ${identity.redactedUrl}\n` +
        `  Host:     ${identity.host}\n` +
        `  Database: ${identity.database}\n\n` +
        `Destructive operations are only permitted when:\n` +
        `  • host is localhost, 127.0.0.1, or ::1, OR\n` +
        `  • database name ends with _test or _dev.\n\n` +
        `If you are intentionally targeting a non-local test database, rename it to end with _test.`,
    );
  }
}
