import * as dotenv from "dotenv";
dotenv.config();

// Importing ./config validates all required env vars (DATABASE_URL,
// STELLAR_RPC_URL, CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS)
// and throws a single clear error listing what's missing if any are unset —
// deliberately before ./db/migrate and ./indexer run so a misconfigured
// deploy fails on boot instead of partway through migrations or polling.
import { PORT, SHUTDOWN_GRACE_PERIOD_MS, DB_CONNECT_MAX_RETRIES, DB_CONNECT_BASE_DELAY_MS } from "./config";
import { connectWithRetry, pool } from "./db/pool";
import { runMigrations, checkMigrationHealth } from "./db/migrate";
import { startIndexer, stopIndexer } from "./indexer";
import { createApp } from "./api";
import type { Server } from "http";

let shuttingDown = false;

async function gracefulShutdown(server: Server, signal: string): Promise<void> {
  if (shuttingDown) {
    console.log(
      `[circleup-indexer] ${signal} received but shutdown already in progress`,
    );
    return;
  }
  shuttingDown = true;

  console.log(
    `[circleup-indexer] Received ${signal} — shutting down gracefully ` +
      `(grace period: ${SHUTDOWN_GRACE_PERIOD_MS}ms)...`,
  );

  // Hard-kill timer: if graceful teardown hangs past the configured grace
  // period (e.g. an RPC call stuck waiting, a slow DB write, or the HTTP
  // server waiting for a keep-alive connection to drain), force-exit so the
  // process never blocks a rolling deployment indefinitely.
  //
  // The AbortController lets us propagate the deadline into stopIndexer so a
  // stuck in-flight poll cycle rejects early instead of silently holding open
  // the Postgres connection that the pool.end() call below needs to close.
  //
  // unref() prevents the timer from keeping the event loop alive on its own —
  // if everything closes cleanly before the deadline the process exits 0
  // without waiting for the timer to fire.
  const abortController = new AbortController();
  const forceExitTimer = setTimeout(() => {
    abortController.abort();
    console.error(
      `[circleup-indexer] Shutdown did not complete within ${SHUTDOWN_GRACE_PERIOD_MS}ms — forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_GRACE_PERIOD_MS);
  forceExitTimer.unref();

  try {
    // 1. Stop the poller first: refuse new ticks and wait for any in-flight
    //    ledger ingest to finish so we never exit mid-transaction.  Pass the
    //    AbortSignal so a stuck RPC call does not block past the grace period.
    await stopIndexer(abortController.signal);

    // 2. Stop accepting new HTTP requests.  Existing connections are allowed
    //    to finish (Node drains keep-alive sockets automatically when the
    //    server is closed).
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log("[circleup-indexer] HTTP server closed");

    // 3. Release all Postgres connections only after both the poller and the
    //    HTTP server have stopped issuing queries.
    await pool.end();
    console.log("[circleup-indexer] Database pool closed");

    clearTimeout(forceExitTimer);
    console.log("[circleup-indexer] Shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("[circleup-indexer] Error during graceful shutdown:", err);
    process.exit(1);
  }
}

async function main() {
  console.log("[circleup-indexer] Booting...");

  // Wait for Postgres to accept connections before migrating — it's common
  // for the DB container to still be starting up at this point.
  // Retry parameters are read from DB_CONNECT_MAX_RETRIES and
  // DB_CONNECT_BASE_DELAY_MS env vars (defaults: 5 retries, 1000 ms base delay).
  console.log(
    `[circleup-indexer] Connecting to Postgres ` +
      `(max ${DB_CONNECT_MAX_RETRIES} attempt(s), base delay ${DB_CONNECT_BASE_DELAY_MS}ms)...`,
  );
  await connectWithRetry();

  // Apply DB schema and all pending additive migrations.
  await runMigrations();

  // Post-migration health check.  runMigrations() applies every pending
  // migration, so the only non-clean states that can appear here are:
  //   drifted — a migration was applied in this environment but the file has
  //             since been deleted or renamed.  The indexer can still start
  //             (the tables exist), but the discrepancy should be investigated.
  //   partial — pending files AND missing-on-disk entries exist simultaneously.
  //             This is unusual and warrants immediate attention.
  //
  // Neither state aborts the process — the indexer is conservative and keeps
  // serving data rather than going down hard in ambiguous situations.  The
  // warning is prominent enough for ops tooling (log alerts, /health endpoint)
  // to surface it.
  const health = await checkMigrationHealth();
  if (health.state === "drifted" || health.state === "partial") {
    console.warn(
      `[circleup-indexer] SCHEMA WARNING (${health.state.toUpperCase()}): ${health.summary}`,
    );
    console.warn(
      "[circleup-indexer] The indexer will continue, but investigate the schema drift before the next deploy.",
    );
  } else {
    console.log(`[circleup-indexer] Schema health: ${health.summary}`);
  }

  // Start REST API — pass the migration health result so the /health endpoint
  // can surface schema drift without re-running the migration scan on every
  // health poll request.
  const app = createApp({ cachedMigrationHealth: health });
  const server = app.listen(PORT, () => {
    console.log(`[circleup-indexer] API listening on http://localhost:${PORT}`);
  });

  // Register signal handlers before startIndexer so a SIGTERM that races
  // the very first poll tick is still caught and handled cleanly rather than
  // being delivered to a process with no handler registered yet.
  process.once("SIGTERM", () => {
    void gracefulShutdown(server, "SIGTERM");
  });
  process.once("SIGINT", () => {
    void gracefulShutdown(server, "SIGINT");
  });

  // Start event indexer after signal handlers are in place.
  await startIndexer();
}

main().catch((err) => {
  console.error("[circleup-indexer] Fatal error:", err);
  process.exit(1);
});
