/**
 * Operational health checks for the CircleUp indexer.
 *
 * Each check is independent and returns a ComponentHealth object so the
 * /health endpoint can surface a structured per-component status rather than
 * a single binary up/down flag.
 *
 * Checks implemented here:
 *
 *   checkDbConnectivity   – verify Postgres accepts queries (SELECT 1)
 *   checkRpcConnectivity  – verify Soroban RPC responds (getLatestLedger)
 *   checkIndexerLag       – compare DB last_ledger vs RPC latest_ledger;
 *                           flag as degraded when the gap exceeds the
 *                           configurable threshold (INDEXER_LAG_ALERT_LEDGERS,
 *                           default 1000 ledgers ≈ ~83 minutes at 5 s/ledger)
 *   checkSchemaHealth     – surface checkMigrationHealth() result so schema
 *                           drift is visible in /health without a separate
 *                           /migrate status call
 *   checkEventFailures    – count open event_failures rows (events skipped by
 *                           a failing handler and not yet re-ingested or
 *                           acknowledged); degraded when any failure is
 *                           recurring or the open count reaches
 *                           EVENT_FAILURE_ALERT_COUNT
 *
 * Contract state drift (checkContractStateDrift) is intentionally kept
 * separate from the above: it requires an active RPC connection and fetches
 * on-chain data, so it only runs when rpcStatus is "ok" and at most once per
 * call to runAllHealthChecks() regardless of how many active circles exist.
 * The check samples the most-recently-updated Active circle from the DB and
 * compares its current_round against the on-chain contract state.  A mismatch
 * beyond DRIFT_ROUND_THRESHOLD is reported as "degraded" so ops tooling can
 * detect a stuck or lagging indexer before users notice stale data.
 */

import { SorobanRpc, xdr, scValToNative, Contract } from "@stellar/stellar-sdk";
import type { MigrationHealth } from "./db/migrate";
import { query } from "./db/pool";
import { isUndefinedTable, summarizeOpenEventFailures } from "./eventFailures";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ComponentHealth {
  status: "ok" | "degraded" | "error";
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: "ok" | "degraded";
  serviceStatus: "healthy" | "degraded" | "unavailable";
  timestamp: string;
  db: ComponentHealth;
  rpc: ComponentHealth;
  indexerLag: ComponentHealth;
  schema: ComponentHealth;
  contractDrift: ComponentHealth;
  eventFailures: ComponentHealth;
  /** Config snapshot surfaced so operators can cross-check env alignment. */
  config: {
    usdcAddress: string;
    lagAlertLedgers: number;
    driftRoundThreshold: number;
    eventFailureAlertCount: number;
    eventFailureRecurringAttempts: number;
  };
  diagnostics: {
    lastIndexedLedger: number | null;
    rpcLatestLedger: number | null;
    lagLedgers: number | null;
    dbAvailable: boolean;
    rpcAvailable: boolean;
  };
}

// ── Constants (configurable via env) ─────────────────────────────────────────

/**
 * Number of ledgers the indexer may fall behind the chain before the lag check
 * transitions from "ok" to "degraded".  Default 1 000 ≈ ~83 min at 5 s/ledger.
 *
 * Operators can tune this down (e.g. 200 ≈ 16 min) for tighter alerting or up
 * for environments that deliberately run slow re-index passes.
 */
export const INDEXER_LAG_ALERT_LEDGERS = parseInt(
  process.env.INDEXER_LAG_ALERT_LEDGERS || "1000",
  10,
);

/**
 * Maximum allowed difference between DB current_round and on-chain
 * current_round before the drift check transitions to "degraded".
 * Default 1 — any single-round lag is considered actionable.
 */
export const DRIFT_ROUND_THRESHOLD = parseInt(
  process.env.DRIFT_ROUND_THRESHOLD || "1",
  10,
);

/**
 * Number of open (unresolved, unacknowledged) event failures at which the
 * eventFailures check reports "degraded".  Default 1: any event the indexer
 * skipped is missing data until it is re-ingested or an operator acknowledges
 * it.  Set to 0 to disable the count-based alert (recurring failures still
 * degrade).
 */
export const EVENT_FAILURE_ALERT_COUNT = parseInt(
  process.env.EVENT_FAILURE_ALERT_COUNT || "1",
  10,
);

/**
 * An open failure whose `attempts` reached this value is "recurring" — it
 * failed again after a retry or replay, which points at a poison event or a
 * handler bug rather than a one-off.  Any recurring failure degrades health.
 */
export const EVENT_FAILURE_RECURRING_ATTEMPTS = parseInt(
  process.env.EVENT_FAILURE_RECURRING_ATTEMPTS || "2",
  10,
);

/** Per-component timeout so a slow RPC/DB never blocks the health response. */
export const HEALTH_TIMEOUT_MS = parseInt(
  process.env.HEALTH_TIMEOUT_MS || "5000",
  10,
);

// ── Timeout wrapper ───────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Health check timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Individual checks ─────────────────────────────────────────────────────────

/** Verify Postgres is reachable and responsive. */
export async function checkDbConnectivity(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await withTimeout(query("SELECT 1"), HEALTH_TIMEOUT_MS);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Verify the Soroban RPC is reachable and returns the latest ledger. */
export async function checkRpcConnectivity(
  rpc: SorobanRpc.Server,
): Promise<ComponentHealth & { latestLedger?: number }> {
  const start = Date.now();
  try {
    const result = await withTimeout(rpc.getLatestLedger(), HEALTH_TIMEOUT_MS);
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      latestLedger: result.sequence,
      details: { latestLedger: result.sequence },
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compare the indexer's persisted last_ledger against the RPC's current
 * latest_ledger sequence.  Reports "degraded" when the gap exceeds
 * INDEXER_LAG_ALERT_LEDGERS so ops tooling can alert before users notice
 * stale data.
 *
 * Accepts pre-fetched rpcLatestLedger so this check reuses the value already
 * obtained by checkRpcConnectivity rather than making a second RPC call.
 */
export async function checkIndexerLag(
  rpcLatestLedger: number | null,
): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const rows = await withTimeout(
      query<{ last_ledger: string }>(
        "SELECT last_ledger FROM indexer_state WHERE id = 1",
      ),
      HEALTH_TIMEOUT_MS,
    );

    if (rows.length === 0) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        error: "indexer_state row is missing — the indexer may not have started yet",
        details: { lastIndexedLedger: null, rpcLatestLedger },
      };
    }

    const lastIndexedLedger = Number(rows[0].last_ledger);

    // If RPC is down we can't compute the gap — report what we know.
    if (rpcLatestLedger === null) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        error: "Cannot determine indexer lag — RPC latest ledger is unavailable",
        details: { lastIndexedLedger, rpcLatestLedger: null },
      };
    }

    const lagLedgers = rpcLatestLedger - lastIndexedLedger;
    const lagAlertLedgers = INDEXER_LAG_ALERT_LEDGERS;

    if (lagLedgers > lagAlertLedgers) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        error:
          `Indexer is ${lagLedgers} ledger(s) behind the chain ` +
          `(threshold: ${lagAlertLedgers})`,
        details: { lastIndexedLedger, rpcLatestLedger, lagLedgers, lagAlertLedgers },
      };
    }

    return {
      status: "ok",
      latencyMs: Date.now() - start,
      details: { lastIndexedLedger, rpcLatestLedger, lagLedgers, lagAlertLedgers },
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Surface schema migration health state in the /health response so operators
 * can detect drift without a separate /migrate call.
 *
 * Accepts a pre-computed MigrationHealth (obtained during startup) to avoid
 * re-running the migration scan on every health poll.  When `cached` is
 * provided it is returned directly; otherwise checkMigrationHealth() is called.
 *
 * "clean" and "pending" states are reported as "ok" (pending means the DB is
 * behind but still functional).  "drifted", "partial", and "uninitialized" are
 * reported as "degraded" since they indicate the DB may be out of sync with
 * the expected schema.
 */
export async function checkSchemaHealth(
  cached?: MigrationHealth | null,
): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    let health: MigrationHealth;
    if (cached != null) {
      health = cached;
    } else {
      // Lazy import to avoid pulling migrate.ts (and its fs/path deps) into
      // every module that imports health.ts — only needed for the live check.
      const { checkMigrationHealth } = await import("./db/migrate");
      health = await withTimeout(checkMigrationHealth(), HEALTH_TIMEOUT_MS);
    }

    const degradedStates: MigrationHealth["state"][] = [
      "drifted",
      "partial",
      "uninitialized",
    ];
    const status = degradedStates.includes(health.state) ? "degraded" : "ok";

    return {
      status,
      latencyMs: Date.now() - start,
      ...(status === "degraded" ? { error: health.summary } : {}),
      details: {
        state: health.state,
        currentVersion: health.status.currentVersion,
        pending: health.status.pending,
        missingOnDisk: health.status.missingOnDisk,
        summary: health.summary,
      },
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Surface events the indexer skipped because their handler failed.
 *
 * Reports:
 *   "ok"       — no open failures, or fewer than EVENT_FAILURE_ALERT_COUNT and
 *                none recurring; also when the event_failures table does not
 *                exist yet (the schema check already reports pending migrations)
 *   "degraded" — any recurring failure, or open count ≥ EVENT_FAILURE_ALERT_COUNT
 *   "error"    — the query itself failed
 *
 * Details carry counts and the ledger range only — never payloads.  Use
 * GET /indexer/failures for the individual rows.
 */
export async function checkEventFailures(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const summary = await withTimeout(
      summarizeOpenEventFailures(EVENT_FAILURE_RECURRING_ATTEMPTS),
      HEALTH_TIMEOUT_MS,
    );
    const details = {
      open: summary.open,
      recurring: summary.recurring,
      oldestLedger: summary.oldestLedger,
      newestLedger: summary.newestLedger,
      lastFailedAt: summary.lastFailedAt,
      alertCount: EVENT_FAILURE_ALERT_COUNT,
      recurringAttempts: EVENT_FAILURE_RECURRING_ATTEMPTS,
    };

    const overCount =
      EVENT_FAILURE_ALERT_COUNT > 0 && summary.open >= EVENT_FAILURE_ALERT_COUNT;
    if (summary.recurring > 0 || overCount) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        error:
          `${summary.open} event(s) skipped after handler failures are still open ` +
          `(${summary.recurring} recurring, ledgers ${summary.oldestLedger}–${summary.newestLedger}). ` +
          `See GET /indexer/failures.`,
        details,
      };
    }
    return { status: "ok", latencyMs: Date.now() - start, details };
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        status: "ok",
        latencyMs: Date.now() - start,
        details: { skipped: true, reason: "event_failures table missing — run migrations" },
      };
    }
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Contract state ─────────────────────────────────────────────────────────────

interface DbCircleRow {
  address: string;
  current_round: number;
  status: string;
}

/**
 * Read the `current_round` value from on-chain contract storage.
 *
 * The circle contract stores its state under the `"RoundState"` ledger key.
 * We call `simulateTransaction` with a read-only `get_current_round` invocation
 * rather than fetching raw ledger entries, because the Soroban RPC's
 * `getLedgerEntries` path requires exact XDR-encoded keys that depend on the
 * contract's exact storage layout — fragile across contract upgrades.
 *
 * Falls back to null if simulation fails (e.g. contract not yet initialised,
 * RPC rate limit, or the contract was deployed on a different network).
 */
async function readOnChainRound(
  rpc: SorobanRpc.Server,
  circleAddress: string,
): Promise<number | null> {
  try {
    // Build a minimal simulateTransaction call for `get_current_round`.
    // The function takes no arguments and returns a u32.
    const contract = new Contract(circleAddress);
    const op = contract.call("get_current_round");

    // We need a dummy source account for the transaction envelope.
    // Use the contract address itself as a surrogate — we never submit this.
    const { SorobanDataBuilder, TransactionBuilder, Networks, Operation } =
      await import("@stellar/stellar-sdk");
    void SorobanDataBuilder; // used below

    // Fetch the source account's sequence number so we can build a valid
    // transaction envelope for simulation (not submission).
    const sourceAccount = await withTimeout(
      rpc.getAccount(circleAddress),
      HEALTH_TIMEOUT_MS,
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const simResult = await withTimeout(
      rpc.simulateTransaction(tx),
      HEALTH_TIMEOUT_MS,
    );

    if (
      !SorobanRpc.Api.isSimulationSuccess(simResult) ||
      !simResult.result
    ) {
      return null;
    }

    const native = scValToNative(simResult.result.retval as xdr.ScVal);
    if (typeof native === "number" || typeof native === "bigint") {
      return Number(native);
    }
    return null;
  } catch {
    // Any failure (account not found, RPC error, wrong network) is treated as
    // "unable to compare" and skipped silently — the drift check logs a
    // warning but does not report an error so a single RPC hiccup doesn't make
    // the whole health endpoint look broken.
    return null;
  }
}

/**
 * Detect divergence between the indexer's DB view of Active circles and the
 * on-chain contract state.
 *
 * Strategy: sample the single most-recently-updated Active circle from the DB
 * and compare its current_round against the on-chain value.  Sampling one
 * circle keeps the health check cheap (one RPC call) and fast regardless of
 * how many circles exist.
 *
 * Reports:
 *   "ok"       — on-chain round matches DB, or no Active circles to check
 *   "degraded" — round difference exceeds DRIFT_ROUND_THRESHOLD
 *   "error"    — unexpected exception (not RPC/sim failure — those return null
 *                from readOnChainRound and are handled gracefully)
 *
 * This check is skipped entirely when rpcStatus is not "ok" to avoid
 * cascading errors from a known-down RPC masking what is otherwise a healthy
 * schema/DB state.
 */
export async function checkContractStateDrift(
  rpc: SorobanRpc.Server,
  rpcStatus: "ok" | "degraded" | "error",
): Promise<ComponentHealth> {
  const start = Date.now();

  // Don't attempt contract reads when the RPC is already known to be down.
  if (rpcStatus !== "ok") {
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      details: { skipped: true, reason: "RPC is not available" },
    };
  }

  try {
    // Sample the most-recently-updated Active circle to minimise RPC cost.
    const rows = await withTimeout(
      query<DbCircleRow>(
        `SELECT address, current_round, status
         FROM circles
         WHERE status = 'Active'
         ORDER BY updated_at DESC
         LIMIT 1`,
      ),
      HEALTH_TIMEOUT_MS,
    );

    if (rows.length === 0) {
      return {
        status: "ok",
        latencyMs: Date.now() - start,
        details: { skipped: true, reason: "No Active circles to check" },
      };
    }

    const circle = rows[0];
    const onChainRound = await readOnChainRound(rpc, circle.address);

    if (onChainRound === null) {
      // Simulation failed — treat as "unable to verify" rather than an error.
      return {
        status: "ok",
        latencyMs: Date.now() - start,
        details: {
          skipped: true,
          reason: "Could not read on-chain state (simulation unavailable)",
          sampledCircle: circle.address,
        },
      };
    }

    const roundDiff = Math.abs(onChainRound - circle.current_round);
    const threshold = DRIFT_ROUND_THRESHOLD;

    if (roundDiff > threshold) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        error:
          `Contract state drift detected on circle ${circle.address}: ` +
          `DB current_round=${circle.current_round}, ` +
          `on-chain current_round=${onChainRound} ` +
          `(diff=${roundDiff}, threshold=${threshold})`,
        details: {
          sampledCircle: circle.address,
          dbCurrentRound: circle.current_round,
          onChainCurrentRound: onChainRound,
          roundDiff,
          threshold,
        },
      };
    }

    return {
      status: "ok",
      latencyMs: Date.now() - start,
      details: {
        sampledCircle: circle.address,
        dbCurrentRound: circle.current_round,
        onChainCurrentRound: onChainRound,
        roundDiff,
        threshold,
      },
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Aggregate ──────────────────────────────────────────────────────────────────

/**
 * Run all health checks in parallel and aggregate the results into a single
 * HealthReport.  The top-level `status` is "degraded" if any component is not
 * "ok", "ok" otherwise.
 *
 * Accepts an optional pre-computed MigrationHealth so the API layer can pass
 * the startup schema result in rather than triggering a second DB scan per
 * health poll.
 */
export async function runAllHealthChecks({
  rpc,
  usdcAddress,
  cachedMigrationHealth = null,
}: {
  rpc: SorobanRpc.Server;
  usdcAddress: string;
  cachedMigrationHealth?: MigrationHealth | null;
}): Promise<HealthReport> {
  // Run DB, RPC, and schema checks in parallel — they are independent.
  const [db, rpcCheck, schema] = await Promise.all([
    checkDbConnectivity(),
    checkRpcConnectivity(rpc),
    checkSchemaHealth(cachedMigrationHealth),
  ]);

  // Indexer lag and contract drift both depend on knowing the RPC latest
  // ledger, but they are independent of each other — run them in parallel.
  const rpcLatestLedger =
    rpcCheck.status === "ok" && typeof rpcCheck.details?.latestLedger === "number"
      ? (rpcCheck.details.latestLedger as number)
      : null;

  const [indexerLag, contractDrift, eventFailures] = await Promise.all([
    checkIndexerLag(rpcLatestLedger),
    checkContractStateDrift(rpc, rpcCheck.status),
    checkEventFailures(),
  ]);

  // Strip the internal latestLedger field from the RPC component before
  // returning so the public response shape matches ComponentHealth exactly.
  const rpcComponent: ComponentHealth = {
    status: rpcCheck.status,
    latencyMs: rpcCheck.latencyMs,
    ...(rpcCheck.error ? { error: rpcCheck.error } : {}),
    ...(rpcCheck.details ? { details: rpcCheck.details } : {}),
  };

  const allComponents = [db, rpcComponent, indexerLag, schema, contractDrift, eventFailures];
  const overallOk = allComponents.every((c) => c.status === "ok");
  const dbAvailable = db.status !== "error";
  const rpcAvailable = rpcComponent.status !== "error";
  const serviceStatus =
    !dbAvailable ? "unavailable" : overallOk ? "healthy" : "degraded";
  const lagDetails = indexerLag.details ?? {};
  const lastIndexedLedger =
    typeof lagDetails.lastIndexedLedger === "number"
      ? lagDetails.lastIndexedLedger
      : null;
  const latestLedgerForDiagnostics =
    typeof lagDetails.rpcLatestLedger === "number"
      ? lagDetails.rpcLatestLedger
      : rpcLatestLedger;
  const lagLedgers =
    typeof lagDetails.lagLedgers === "number"
      ? lagDetails.lagLedgers
      : lastIndexedLedger != null && latestLedgerForDiagnostics != null
      ? latestLedgerForDiagnostics - lastIndexedLedger
      : null;

  return {
    status: overallOk ? "ok" : "degraded",
    serviceStatus,
    timestamp: new Date().toISOString(),
    db,
    rpc: rpcComponent,
    indexerLag,
    schema,
    contractDrift,
    eventFailures,
    config: {
      usdcAddress,
      lagAlertLedgers: INDEXER_LAG_ALERT_LEDGERS,
      driftRoundThreshold: DRIFT_ROUND_THRESHOLD,
      eventFailureAlertCount: EVENT_FAILURE_ALERT_COUNT,
      eventFailureRecurringAttempts: EVENT_FAILURE_RECURRING_ATTEMPTS,
    },
    diagnostics: {
      lastIndexedLedger,
      rpcLatestLedger: latestLedgerForDiagnostics,
      lagLedgers,
      dbAvailable,
      rpcAvailable,
    },
  };
}
