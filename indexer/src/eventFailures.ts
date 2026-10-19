/**
 * Event-handler failure evidence for the CircleUp indexer.
 *
 * processLedger isolates each event in a savepoint, so a handler that throws
 * rolls back only that event — including its `ingested_events` dedup row — and
 * the ledger still commits and advances the cursor.  Without a durable record
 * such an event is skipped silently forever.  This module provides that
 * record.
 *
 * Model
 * ─────
 *   event_failures holds one row per failed event, keyed by the RPC event id
 *   (a ledger/transaction/event-position identifier that carries no payload).
 *   Every repeat failure of the same event increments `attempts`, so a poison
 *   event that fails on every re-ingest is distinguishable from a one-off.
 *
 *   A row is *open* until either
 *     - the event later ingests successfully (`resolved_at` is set by
 *       processLedger in the same transaction that commits the projection), or
 *     - an operator accepts the skip (`acknowledged_at`, set manually — see
 *       docs/INDEXER_RELIABILITY.md).
 *
 *   Open failures are surfaced by the `eventFailures` component of /health
 *   and listed by GET /indexer/failures.
 *
 * Transient vs permanent
 * ──────────────────────
 *   A handler error caused by the database itself (deadlock, serialization
 *   failure, lost connection, statement timeout, resource exhaustion) says
 *   nothing about the event.  Skipping the event for such an error would lose
 *   data for no reason, so processLedger rethrows transient errors: the whole
 *   ledger transaction rolls back, the cursor stays put, and the poll loop's
 *   backoff retries the ledger.  Every other error is treated as permanent for
 *   this event: it is skipped, recorded here, and ingestion continues.
 *
 * Privacy
 * ───────
 *   Evidence never contains the event's topics or value (the payload), nor the
 *   `ingested_events.event_key` (which embeds the payload).  The stored error
 *   message is redacted (addresses / hashes shortened, long blobs elided) and
 *   truncated, because handler errors can echo decoded argument values.
 */

import type { PoolClient } from "pg";
import { query } from "./db/pool";
import { redactAddress, redactTxHash } from "./redact";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Whether an error says something about the event or only about the DB. */
export type HandlerErrorClass = "transient" | "permanent";

/** Payload-free evidence for one failed event, as written to event_failures. */
export interface EventFailureEvidence {
  /** Stable identity: the RPC event id, or a composite fallback. */
  eventId: string;
  ledger: number;
  txHash: string | null;
  contractId: string | null;
  /** e.g. "circle/joined". */
  eventType: string;
  errorClass: HandlerErrorClass;
  /** Error constructor name, or the Postgres SQLSTATE when present. */
  errorName: string;
  /** Redacted, truncated error message. */
  errorMessage: string;
}

/** An open (unresolved, unacknowledged) failure row as returned to operators. */
export interface OpenEventFailure {
  eventId: string;
  ledger: number;
  txHash: string | null;
  contractId: string | null;
  eventType: string | null;
  errorClass: string;
  errorName: string | null;
  errorMessage: string | null;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

/** Aggregate view of open failures used by the health check. */
export interface EventFailureSummary {
  open: number;
  /** Open failures that have failed at least `recurringAttempts` times. */
  recurring: number;
  oldestLedger: number | null;
  newestLedger: number | null;
  lastFailedAt: string | null;
}

// ─── Identity ─────────────────────────────────────────────────────────────────

interface IdentifiableEvent {
  id?: string;
  ledger?: number;
  txHash?: string;
}

/**
 * Stable, payload-free identity for an event.
 *
 * The Soroban RPC event id encodes the ledger, the transaction's position in
 * it, and the event's position in the transaction, so it is unique and stable
 * across re-fetches.  When it is missing (malformed RPC response) a composite
 * of ledger, tx hash, contract and event type is used instead — still free of
 * the event's topics/value.
 */
export function eventFailureId(
  event: IdentifiableEvent,
  contractId: string | null,
  eventType: string,
): string {
  if (typeof event.id === "string" && event.id.length > 0) return event.id;
  return [event.ledger ?? 0, event.txHash ?? "", contractId ?? "", eventType].join(":");
}

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * SQLSTATE classes / codes that describe the database, not the event:
 *   08xxx  connection exception
 *   40xxx  transaction rollback (serialization failure, deadlock)
 *   53xxx  insufficient resources (disk full, out of memory, too many conns)
 *   57014  query_canceled (statement timeout)
 *   57Pxx  operator intervention (admin shutdown, crash shutdown)
 *   55P03  lock_not_available
 */
const TRANSIENT_SQLSTATE_RE = /^(08|40|53)[0-9A-Z]{3}$|^57014$|^57P[0-9A-Z]{2}$|^55P03$/;

/** Node-level network errors that mean the connection to Postgres broke. */
const TRANSIENT_ERRNO = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);

/**
 * Decide whether a handler error is transient (retry the whole ledger) or
 * permanent for this event (skip it and record evidence).
 */
export function classifyHandlerError(err: unknown): HandlerErrorClass {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (TRANSIENT_SQLSTATE_RE.test(code)) return "transient";
    if (TRANSIENT_ERRNO.has(code)) return "transient";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/Connection terminated|connection is closed|Client has encountered a connection error/i.test(message)) {
    return "transient";
  }
  return "permanent";
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/** Maximum stored error-message length. */
export const MAX_FAILURE_MESSAGE_LENGTH = 300;

/**
 * Redact an error message for durable storage: shorten Stellar addresses and
 * transaction hashes, elide long base64/hex blobs (XDR, payload dumps), and
 * truncate.
 */
export function sanitizeFailureMessage(message: string): string {
  const redacted = message
    .replace(/\b[GC][A-Z2-7]{55}\b/g, (m) => redactAddress(m))
    .replace(/\b[0-9a-fA-F]{64}\b/g, (m) => redactTxHash(m))
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[blob elided]");
  return redacted.length > MAX_FAILURE_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}…`
    : redacted;
}

/** Build the evidence row for a failed event. */
export function buildFailureEvidence(args: {
  event: IdentifiableEvent;
  contractId: string | null;
  eventType: string;
  error: unknown;
}): EventFailureEvidence {
  const { event, contractId, eventType, error } = args;
  const code = (error as { code?: unknown } | null)?.code;
  const errorName =
    typeof code === "string" && code.length > 0
      ? code
      : error instanceof Error
        ? error.name
        : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    eventId: eventFailureId(event, contractId, eventType),
    ledger: event.ledger ?? 0,
    txHash: event.txHash ?? null,
    contractId,
    eventType,
    errorClass: classifyHandlerError(error),
    errorName,
    errorMessage: sanitizeFailureMessage(rawMessage),
  };
}

// ─── Writes (caller owns the transaction) ─────────────────────────────────────

/**
 * Persist failure evidence and mark previously failed events that have now
 * ingested successfully as resolved — both inside the caller's open ledger
 * transaction, so evidence commits or rolls back together with the ledger's
 * projections and checkpoint.
 *
 * Runs inside its own savepoint: if the evidence write itself fails (for
 * example the event_failures migration has not been applied) only the
 * evidence is rolled back and the ledger still commits — failing to record a
 * failure must never block ingestion.  Returns false in that case so the
 * caller can log it.
 */
export async function recordLedgerFailureEvidence(
  client: PoolClient,
  failures: EventFailureEvidence[],
  succeededEventIds: string[],
): Promise<boolean> {
  if (failures.length === 0 && succeededEventIds.length === 0) return true;

  await client.query("SAVEPOINT sp_event_failures");
  try {
    for (const f of failures) {
      await client.query(
        `INSERT INTO event_failures
           (event_id, ledger, tx_hash, contract_id, event_type,
            error_class, error_name, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO UPDATE
           SET attempts       = event_failures.attempts + 1,
               last_failed_at = NOW(),
               error_class    = EXCLUDED.error_class,
               error_name     = EXCLUDED.error_name,
               error_message  = EXCLUDED.error_message,
               resolved_at    = NULL`,
        [
          f.eventId,
          f.ledger,
          f.txHash,
          f.contractId,
          f.eventType,
          f.errorClass,
          f.errorName,
          f.errorMessage,
        ],
      );
    }
    if (succeededEventIds.length > 0) {
      await client.query(
        `UPDATE event_failures
            SET resolved_at = NOW()
          WHERE event_id = ANY($1::text[])
            AND resolved_at IS NULL`,
        [succeededEventIds],
      );
    }
    await client.query("RELEASE SAVEPOINT sp_event_failures");
    return true;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT sp_event_failures");
    return false;
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Postgres "relation does not exist" — the migration has not been applied. */
export function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

const OPEN_FAILURE_PREDICATE = "resolved_at IS NULL AND acknowledged_at IS NULL";

/** Aggregate open failures for the health check. */
export async function summarizeOpenEventFailures(
  recurringAttempts: number,
): Promise<EventFailureSummary> {
  const rows = await query<{
    open: string | number | null;
    recurring: string | number | null;
    oldest_ledger: string | number | null;
    newest_ledger: string | number | null;
    last_failed_at: string | Date | null;
  }>(
    `SELECT COUNT(*)                                  AS open,
            COUNT(*) FILTER (WHERE attempts >= $1)    AS recurring,
            MIN(ledger)                               AS oldest_ledger,
            MAX(ledger)                               AS newest_ledger,
            MAX(last_failed_at)                       AS last_failed_at
       FROM event_failures
      WHERE ${OPEN_FAILURE_PREDICATE}`,
    [recurringAttempts],
  );
  const row = rows[0];
  const toNumberOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    // COUNT(*) always yields a row; a missing value means no open failures.
    open: Number(row?.open ?? 0),
    recurring: Number(row?.recurring ?? 0),
    oldestLedger: toNumberOrNull(row?.oldest_ledger),
    newestLedger: toNumberOrNull(row?.newest_ledger),
    lastFailedAt:
      row?.last_failed_at instanceof Date
        ? row.last_failed_at.toISOString()
        : (row?.last_failed_at ?? null),
  };
}

/**
 * List open failures, oldest ledger first, optionally restricted to a single
 * ledger or to a single event id.
 */
export async function listOpenEventFailures(filter: {
  ledger?: number;
  eventId?: string;
  limit: number;
}): Promise<OpenEventFailure[]> {
  const conditions = [OPEN_FAILURE_PREDICATE];
  const params: unknown[] = [];
  if (filter.ledger !== undefined) {
    params.push(filter.ledger);
    conditions.push(`ledger = $${params.length}`);
  }
  if (filter.eventId !== undefined) {
    params.push(filter.eventId);
    conditions.push(`event_id = $${params.length}`);
  }
  params.push(filter.limit);

  const rows = await query<{
    event_id: string;
    ledger: string | number;
    tx_hash: string | null;
    contract_id: string | null;
    event_type: string | null;
    error_class: string;
    error_name: string | null;
    error_message: string | null;
    attempts: number;
    first_failed_at: string | Date;
    last_failed_at: string | Date;
  }>(
    `SELECT event_id, ledger, tx_hash, contract_id, event_type, error_class,
            error_name, error_message, attempts, first_failed_at, last_failed_at
       FROM event_failures
      WHERE ${conditions.join(" AND ")}
      ORDER BY ledger ASC, event_id ASC
      LIMIT $${params.length}`,
    params,
  );

  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : v);
  return rows.map((r) => ({
    eventId: r.event_id,
    ledger: Number(r.ledger),
    txHash: r.tx_hash,
    contractId: r.contract_id,
    eventType: r.event_type,
    errorClass: r.error_class,
    errorName: r.error_name,
    errorMessage: r.error_message,
    attempts: Number(r.attempts),
    firstFailedAt: iso(r.first_failed_at),
    lastFailedAt: iso(r.last_failed_at),
  }));
}
