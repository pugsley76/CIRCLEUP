import * as dotenv from "dotenv";
dotenv.config();

// Importing ./config validates all required env vars (DATABASE_URL,
// STELLAR_RPC_URL, CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS)
// and throws a single clear error listing what's missing if any are unset —
// deliberately before ./db/migrate and ./indexer run so a misconfigured
// deploy fails on boot instead of partway through migrations or polling.
import { PORT } from "./config";
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
    `[circleup-indexer] Received ${signal} — shutting down gracefully...`,
  );

  try {
    // Stop accepting new poll ticks and wait for any in-flight ingest to finish
    // before tearing down the HTTP server or Postgres pool.
    await stopIndexer();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log("[circleup-indexer] HTTP server closed");

    await pool.end();
    console.log("[circleup-indexer] Database pool closed");

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

  // Start REST API
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[circleup-indexer] API listening on http://localhost:${PORT}`);
  });

  // Start event indexer
  await startIndexer();

  // Docker/K8s send SIGTERM on stop; Ctrl-C sends SIGINT locally.
  process.once("SIGTERM", () => {
    void gracefulShutdown(server, "SIGTERM");
  });
  process.once("SIGINT", () => {
    void gracefulShutdown(server, "SIGINT");
  });
}

main().catch((err) => {
  console.error("[circleup-indexer] Fatal error:", err);
  process.exit(1);
});
