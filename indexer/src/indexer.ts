/**
 * CircleUp Event Indexer
 *
 * Polls the Stellar Soroban RPC for events emitted by the factory, circle,
 * and reputation contracts and writes them into Postgres.
 *
 * Events consumed:
 *   factory/circle_created        → inserts circles + circle_members rows
 *   circle/initialized            → updates circles.member_count, round_amount,
 *                                   total_rounds, round_deadline_ledgers
 *   circle/joined                 → updates circle_members.joined_at
 *   circle/active                 → updates circles.status = 'Active'
 *   circle/contributed            → inserts contributions row
 *   circle/payout                 → inserts payouts row, updates circles.current_round
 *   circle/default                → inserts defaults row
 *   circle/round_started          → updates circles.current_round to the new round index
 *   circle/exceptional_settlement → inserts payouts row (partial pot), increments
 *                                   affected members' defaults, updates current_round
 *   circle/completed              → updates circles.status = 'Completed'
 *   circle/cancelled              → updates circles.status = 'Cancelled',
 *                                   writes circle_audit_events row
 *   circle/closed                 → updates circles status/total_released/close_reason,
 *                                   writes circle_audit_events row
 *   circle/paused                 → updates circles.paused = TRUE
 *   circle/resumed                → updates circles.paused = FALSE
 *   reputation/increment          → upserts reputation row
 *
 * Ordering model
 * ──────────────
 * Events are fetched for a ledger range [fromLedger, toLedger], sorted by
 * (ledger ASC, event-id ASC) for canonical on-chain ordering, and processed
 * one ledger at a time.  Each ledger's batch is wrapped in a single Postgres
 * transaction that also advances the indexer_state cursor and writes a
 * ledger_checkpoints record, so either the full ledger commits or nothing
 * does.  Individual event failures use savepoints — a bad event handler rolls
 * back only its own writes and lets the rest of the ledger proceed.
 *
 * Recovery
 * ────────
 * On crash/restart the cursor is read from DB (never from memory), so the
 * indexer resumes exactly from the last durable ledger boundary.  Events
 * already recorded in ingested_events are skipped by the dedup check inside
 * ingestEventInTx, giving exactly-once semantics across restarts.
 */

import { SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./db/pool";
import {
  STELLAR_RPC_URL,
  CIRCLE_FACTORY_ADDRESS,
  REPUTATION_ADDRESS,
  USDC_ADDRESS,
  START_LEDGER,
  POLL_INTERVAL_MS,
  EVENTS_LIMIT,
  RPC_RETRY_MAX_ATTEMPTS,
  RPC_RETRY_BASE_DELAY_MS,
  POLL_BACKOFF_INITIAL_MS,
  POLL_BACKOFF_MAX_MS,
  POLL_BACKOFF_MULTIPLIER,
} from "./config";
import { redactAddress, formatAmount } from "./redact";
import {
  buildFailureEvidence,
  eventFailureId,
  recordLedgerFailureEvidence,
  type EventFailureEvidence,
} from "./eventFailures";
import {
  log,
  logIndexerStarted,
  logIndexerStopped,
  logTickSkipped,
  logPollCompleted,
  logPollFailed,
  logPollBackoff,
  logLedgerProcessed,
  logEventHandlerError,
  logRpcRetry,
} from "./logger";

export const rpc = new SorobanRpc.Server(STELLAR_RPC_URL, {
  allowHttp: true,
});

const FACTORY = CIRCLE_FACTORY_ADDRESS;
const REPUTATION = REPUTATION_ADDRESS;
export const USDC = USDC_ADDRESS;

// ─── Soroban RPC retry ───────────────────────────────────────────────────────
// RPC_RETRY_MAX_ATTEMPTS and RPC_RETRY_BASE_DELAY_MS are validated and
// exported by ./config (positive integer, upper-bounded) so a typo'd value
// fails loudly at boot rather than silently altering retry behaviour.

/** Error codes / substrings that are safe to retry. Exported for unit tests. */
export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;

  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  );
}

function describeRpcError(err: unknown): string {
  if (err instanceof Error) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/**
 * Compute a jittered delay for exponential backoff.
 * Full jitter: random value in [0, delayMs] to spread load across instances.
 * Exported for unit tests.
 */
export function computeJitteredDelay(delayMs: number): number {
  return Math.floor(Math.random() * delayMs);
}

/**
 * Run an RPC call with capped exponential backoff + jitter on transient failures.
 * Non-transient errors (malformed request, auth, etc.) fail immediately.
 * The delay between retries uses full jitter: a random value in [0, baseDelay * 2^(attempt-1)]
 * to prevent thundering-herd effects when multiple indexers recover simultaneously.
 * Exported for unit tests.
 */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  {
    maxAttempts = RPC_RETRY_MAX_ATTEMPTS,
    baseDelayMs = RPC_RETRY_BASE_DELAY_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    maxAttempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);
  let tried = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    tried = attempt;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = isTransientRpcError(err);
      if (!transient || attempt === attempts) {
        break;
      }
      const baseDelay = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = computeJitteredDelay(baseDelay);
      logRpcRetry({
        label,
        attempt,
        maxAttempts: attempts,
        delayMs,
        error: describeRpcError(err),
      });
      await sleep(delayMs);
    }
  }

  throw new Error(
    `[indexer] Soroban RPC ${label} failed after ${tried} attempt(s): ` +
      describeRpcError(lastErr),
  );
}

// The SDK's getEvents returns EventResponse; extract the string contractId safely.
type SdkEvent = SorobanRpc.Api.EventResponse;

/**
 * A resolved (event, handler) pair ready for per-ledger processing.
 * The handler must be called inside an existing Postgres transaction.
 */
export interface EventHandler {
  event: SdkEvent;
  handler: (client: PoolClient) => Promise<void>;
}

function getContractIdStr(event: SdkEvent): string | null {
  const c = event.contractId;
  if (!c) return null;
  if (typeof c === "string") return c;
  if (typeof (c as { toString?: () => string }).toString === "function") {
    return (c as { toString: () => string }).toString();
  }
  return null;
}

function safeScValToNative(value: unknown): unknown {
  if (value == null) return null;

  try {
    return scValToNative(value as xdr.ScVal);
  } catch {
    return null;
  }
}

function getTopicValue(event: SdkEvent, idx: number): unknown {
  if (!Array.isArray(event.topic) || idx < 0 || idx >= event.topic.length) {
    return null;
  }

  return safeScValToNative(event.topic[idx]);
}

function getTopicStr(event: SdkEvent, idx: number): string {
  const value = getTopicValue(event, idx);
  if (value == null) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function getValueNative(event: SdkEvent): unknown {
  return safeScValToNative(event.value);
}

function normalizeForKey(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => normalizeForKey(item)).join(",")}]`;
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function createEventKey(event: SdkEvent): string {
  const contractId = getContractIdStr(event) ?? "";
  const topicParts = (event.topic ?? []).map((topic) => normalizeForKey(safeScValToNative(topic)));
  return [
    event.ledger ?? 0,
    event.txHash ?? "",
    contractId,
    topicParts.join("|"),
    normalizeForKey(getValueNative(event)),
  ].join(":");
}

/**
 * Extract the event index from an SDK event's `id` field.
 *
 * The Soroban RPC event id format is: "ledger-txIndex-eventIndex" (0-padded).
 * Example: "0000012345678-0000000002-0000000001" represents:
 *   ledger 12345678, tx index 2, event index 1
 *
 * Returns null if the id is missing or malformed.
 */
export function parseEventIndex(event: SdkEvent): number | null {
  const id = event.id;
  if (typeof id !== "string") return null;
  
  const parts = id.split("-");
  if (parts.length !== 3) return null;
  
  const eventIndex = parseInt(parts[2], 10);
  return Number.isNaN(eventIndex) ? null : eventIndex;
}

// ─── Ledger ordering utilities ────────────────────────────────────────────────

/**
 * Groups events by their ledger number, returning a Map sorted by ledger ASC.
 * Events within each ledger retain their original insertion order; callers
 * should sort by event.id before calling to get canonical on-chain ordering.
 */
export function groupEventsByLedger(events: SdkEvent[]): Map<number, SdkEvent[]> {
  const map = new Map<number, SdkEvent[]>();
  for (const event of events) {
    const ledger = event.ledger ?? 0;
    const bucket = map.get(ledger);
    if (bucket) {
      bucket.push(event);
    } else {
      map.set(ledger, [event]);
    }
  }
  return new Map([...map.entries()].sort(([a], [b]) => a - b));
}

/**
 * Returns ledger numbers in [fromLedger, toLedger] absent from seenLedgers.
 * Useful for identifying ranges where no contract events were emitted and for
 * detecting cases where an RPC call silently dropped an expected ledger.
 */
export function detectLedgerGaps(
  seenLedgers: number[],
  fromLedger: number,
  toLedger: number,
): number[] {
  const seen = new Set(seenLedgers);
  const gaps: number[] = [];
  for (let l = fromLedger; l <= toLedger; l++) {
    if (!seen.has(l)) gaps.push(l);
  }
  return gaps;
}

// ─── Dedup-aware event ingestor (caller owns the transaction) ─────────────────

/**
 * Ingest one event inside the caller's open transaction.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING to atomically check for duplicates.
 * If the insert affects 0 rows the event was already recorded (idempotent replay).
 * The unique constraint on (event_key) and the database-level constraint on
 * (ledger, tx_hash, event_index) make duplicate delivery a silent no-op.
 *
 * Callers should wrap this in a SAVEPOINT so a throwing handler rolls back
 * only that event's writes and not the entire ledger batch.
 */
export async function ingestEventInTx(
  client: PoolClient,
  event: SdkEvent,
  handleEvent: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  const eventKey = createEventKey(event);
  const eventIndex = parseEventIndex(event);

  const contractId = getContractIdStr(event) ?? "";
  const topic0 = event.topic?.[0] ? getTopicStr(event, 0) : "";
  const topic1 = event.topic?.[1] ? getTopicStr(event, 1) : "";
  const eventType = topic0 && topic1 ? `${topic0}:${topic1}` : topic0;

  const result = await client.query(
    `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type, event_index)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [eventKey, contractId, event.ledger, event.txHash, eventType, eventIndex],
  );

  // If 0 rows were inserted the event was already ingested — skip the handler
  if (result.rowCount === 0) return false;

  await handleEvent(client);
  return true;
}

// ─── Per-ledger atomic processor ─────────────────────────────────────────────

/**
 * Process all events for one ledger inside a single Postgres transaction.
 *
 * Each event is wrapped in a savepoint: a throwing handler rolls back only its
 * own writes and does not abort the rest of the ledger.  The skipped event is
 * recorded in event_failures (see ./eventFailures) so it stays discoverable
 * by ledger and identity.  Exception: a *transient* database error aborts the
 * whole ledger so it is retried instead of skipped.  After all events are
 * attempted the indexer_state cursor is advanced to `ledger` and a
 * ledger_checkpoints record is written — both inside the same transaction, so
 * a crash before COMMIT leaves the DB at the previous ledger boundary with no
 * partial state.
 *
 * items must be pre-sorted in canonical ledger order (ledger ASC, event id ASC)
 * by the caller.
 */
export async function processLedger(
  ledger: number,
  items: EventHandler[],
): Promise<{ processed: number; failed: number }> {
  const ledgerStartedAt = Date.now();
  return withTransaction(async (client) => {
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    // Evidence for events skipped in this ledger, and the ids of events that
    // ingested successfully (which resolves any earlier failure of theirs).
    const failures: EventFailureEvidence[] = [];
    const succeededEventIds: string[] = [];

    for (const { event, handler } of items) {
      const contractId = getContractIdStr(event);
      const topic0 = event.topic?.[0] ? getTopicStr(event, 0) : "";
      const topic1 = event.topic?.[1] ? getTopicStr(event, 1) : "";
      const eventType = topic0 && topic1 ? `${topic0}/${topic1}` : topic0 || "unknown";

      await client.query("SAVEPOINT sp_event");
      try {
        const ingested = await ingestEventInTx(client, event, handler);
        await client.query("RELEASE SAVEPOINT sp_event");
        if (ingested) {
          processed++;
          totalEventsProcessed++;
          succeededEventIds.push(eventFailureId(event, contractId, eventType));
        } else {
          skipped++;
          totalEventsSkipped++;
        }
      } catch (err) {
        const evidence = buildFailureEvidence({ event, contractId, eventType, error: err });

        // A database-level error (deadlock, serialization failure, lost
        // connection, timeout) says nothing about this event.  Skipping it
        // would lose data, so abort the whole ledger instead: the transaction
        // rolls back, the cursor stays at the previous ledger, and the poll
        // loop's backoff retries the ledger from scratch.
        if (evidence.errorClass === "transient") {
          totalEventsRetried++;
          logEventHandlerError({
            ledger,
            eventType,
            contractId: contractId ?? "unknown",
            txHash: event.txHash,
            eventId: typeof event.id === "string" ? event.id : undefined,
            errorClass: evidence.errorClass,
            error: evidence.errorMessage,
          });
          throw err;
        }

        await client.query("ROLLBACK TO SAVEPOINT sp_event");
        failed++;
        totalEventsFailed++;
        failures.push(evidence);
        logEventHandlerError({
          ledger,
          eventType,
          contractId: contractId ?? "unknown",
          txHash: event.txHash,
          eventId: typeof event.id === "string" ? event.id : undefined,
          errorClass: evidence.errorClass,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Durable, payload-free failure evidence, committed atomically with the
    // ledger.  Isolated in its own savepoint so a failed evidence write can
    // never block ingestion.
    const evidenceRecorded = await recordLedgerFailureEvidence(
      client,
      failures,
      succeededEventIds,
    );
    if (!evidenceRecorded) {
      log("warn", "event_failure_evidence_failed", { ledger, eventsFailed: failed },
        `Could not record event failure evidence for ledger ${ledger} — ` +
          `is the event_failures migration applied?`);
    }

    // Advance the durable ledger cursor atomically with the event writes.
    // If this transaction rolls back (e.g. DB OOM), the cursor stays at the
    // previous ledger so the next poll retries this ledger from scratch.
    await client.query(
      "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
      [ledger],
    );

    await client.query(
      `INSERT INTO ledger_checkpoints (ledger, events_count, failed_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (ledger) DO UPDATE
         SET events_count  = EXCLUDED.events_count,
             failed_count  = EXCLUDED.failed_count,
             processed_at  = NOW()`,
      [ledger, processed, failed],
    );

    const latencyMs = Date.now() - ledgerStartedAt;
    logLedgerProcessed({ ledger, processed, failed, skipped, latencyMs });
    return { processed, failed };
  });
}

// ─── Event data parsers (pure, no I/O — exported for unit tests) ─────────────

/**
 * Parse the data payload of a `circle/initialized` event.
 *
 * Contract data tuple (contracts/circle/src/lib.rs — `initialize` entry-point):
 *   (circle_address: Address, member_count: u32, round_amount: i128)
 *
 * This event is emitted by every newly deployed circle immediately after
 * `initialize` completes, inside the same transaction as the factory's
 * `circle_created` event.  The indexer uses it to backfill `member_count`,
 * `total_rounds`, and `round_amount` on the `circles` row that was created
 * by the `factory/circle_created` handler (which has those columns set to 0
 * as placeholders because they are not part of the factory event payload).
 *
 * # Invariants
 *
 * - `circleAddress` is a non-empty C-prefix contract address.
 * - `memberCount` is in `[2, 256]` (enforced by `initialize`).
 * - `roundAmount > 0` (enforced by `initialize`).
 * - `memberCount` equals `totalRounds` — each member receives exactly one
 *   round payout over the circle's lifetime.
 *
 * @throws `Error` with a descriptive message when the payload is malformed or
 *   any field has an unexpected type/value.
 */
export function parseInitializedEvent(value: unknown): {
  circleAddress: string;
  memberCount: number;
  roundAmount: bigint;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      `circle/initialized: expected data tuple [circle_address, member_count, round_amount] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, memberCount, roundAmount] = value as [
    string,
    number,
    bigint | number,
  ];

  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `circle/initialized: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (
    typeof memberCount !== "number" ||
    !Number.isInteger(memberCount) ||
    memberCount < 2 ||
    memberCount > 256
  ) {
    throw new Error(
      `circle/initialized: member_count must be an integer in [2, 256], got ${JSON.stringify(memberCount)}`,
    );
  }

  let roundAmountBig: bigint;
  if (typeof roundAmount === "bigint") {
    roundAmountBig = roundAmount;
  } else if (typeof roundAmount === "number" && Number.isInteger(roundAmount) && roundAmount > 0) {
    roundAmountBig = BigInt(roundAmount);
  } else {
    throw new Error(
      `circle/initialized: round_amount must be a positive bigint or integer, got ${JSON.stringify(roundAmount)}`,
    );
  }
  if (roundAmountBig <= 0n) {
    throw new Error(
      `circle/initialized: round_amount must be > 0, got ${roundAmountBig}`,
    );
  }

  return { circleAddress, memberCount, roundAmount: roundAmountBig };
}

/**
 * Parse the data payload of a `circle/joined` event.
 *
 * Contract data tuple (contracts/circle/src/lib.rs — `join` entry-point):
 *   (circle_address: Address, member: Address, join_order: u32, collateral: i128)
 *
 * Invariants:
 *   - `join_order` is in `[1, member_count]` (1-based join-queue position).
 *   - When `join_order == member_count` the circle transitions to Active and
 *     a `circle/active` event follows in the same transaction.
 *   - `collateral` equals `round_amount × COLLATERAL_MULTIPLIER` (always ≥ 0).
 *
 * @throws `Error` with a descriptive message when the payload is malformed or
 *   any field has an unexpected type/value.
 */
export function parseJoinedEvent(value: unknown): {
  circleAddress: string;
  member: string;
  joinOrder: number;
  collateral: bigint;
} {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error(
      `circle/joined: expected data tuple [circle_address, member, join_order, collateral] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, member, joinOrder, collateral] = value as [
    string,
    string,
    number,
    bigint | number,
  ];

  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `circle/joined: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (typeof member !== "string" || member.length === 0) {
    throw new Error(
      `circle/joined: member must be a non-empty string, got ${JSON.stringify(member)}`,
    );
  }
  if (typeof joinOrder !== "number" || !Number.isInteger(joinOrder) || joinOrder < 1) {
    throw new Error(
      `circle/joined: join_order must be a positive integer (≥ 1), got ${JSON.stringify(joinOrder)}`,
    );
  }
  // collateral is i128 → bigint after scValToNative; accept plain numbers too
  // (narrower integer types on older SDK versions).
  let collateralBig: bigint;
  if (typeof collateral === "bigint") {
    if (collateral < 0n) {
      throw new Error(
        `circle/joined: collateral must be a non-negative bigint or integer, got ${JSON.stringify(collateral.toString())}`,
      );
    }
    collateralBig = collateral;
  } else if (typeof collateral === "number" && Number.isInteger(collateral) && collateral >= 0) {
    collateralBig = BigInt(collateral);
  } else {
    throw new Error(
      `circle/joined: collateral must be a non-negative bigint or integer, got ${JSON.stringify(collateral)}`,
    );
  }

  return { circleAddress, member, joinOrder, collateral: collateralBig };
}

/**
 * Parse the data payload of a `factory/circle_created` event.
 *
 * Contract data tuple (contracts/circle_factory/src/lib.rs):
 *   (circle_address: Address, creator: Address, circle_index: u32)
 */
export function parseCircleCreatedEvent(value: unknown): {
  circleAddress: string;
  creator: string;
  circleIndex: number;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(
      `factory/circle_created: expected data tuple [address, creator, circle_index] ` +
        `but received ${JSON.stringify(value)}`,
    );
  }
  const [circleAddress, creator, circleIndex] = value as [string, string, number];
  if (typeof circleAddress !== "string" || circleAddress.length === 0) {
    throw new Error(
      `factory/circle_created: circle_address must be a non-empty string, got ${JSON.stringify(circleAddress)}`,
    );
  }
  if (typeof creator !== "string" || creator.length === 0) {
    throw new Error(
      `factory/circle_created: creator must be a non-empty string, got ${JSON.stringify(creator)}`,
    );
  }
  if (typeof circleIndex !== "number" || !Number.isInteger(circleIndex) || circleIndex < 0) {
    throw new Error(
      `factory/circle_created: circle_index must be a non-negative integer, got ${JSON.stringify(circleIndex)}`,
    );
  }
  return { circleAddress, creator, circleIndex };
}

// ─── Cursor helpers ───────────────────────────────────────────────────────────

async function getLastLedger(): Promise<number> {
  const rows = await query<{ last_ledger: string }>(
    "SELECT last_ledger FROM indexer_state WHERE id = 1",
  );
  return rows.length > 0 ? Number(rows[0].last_ledger) : 0;
}

async function setLastLedger(ledger: number) {
  await query(
    "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
    [ledger],
  );
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleFactoryCircleCreated(client: PoolClient, event: SdkEvent) {
  const { circleAddress, creator, circleIndex } = parseCircleCreatedEvent(
    getValueNative(event),
  );

  await client.query(
    `INSERT INTO circles
       (address, creator, round_amount, member_count, total_rounds, status,
        current_round, created_ledger)
     VALUES ($1, $2, 0, 0, 0, 'Pending', 0, $3)
     ON CONFLICT (address) DO NOTHING`,
    [circleAddress, creator, event.ledger],
  );
  log("info", "event_ingested", {
    ledger: event.ledger,
    eventType: "factory/circle_created",
    contractId: circleAddress,
    txHash: event.txHash,
  }, `New circle created by ${redactAddress(creator)} (factory index: ${circleIndex})`);
}

async function handleCircleJoined(client: PoolClient, circleAddr: string, event: SdkEvent) {
  // Event data: (circle_address, member, join_order, collateral_amount)
  // Parsed via the typed parseJoinedEvent function — any shape mismatch throws
  // immediately instead of silently writing wrong data.
  const { member, joinOrder, collateral } = parseJoinedEvent(getValueNative(event));

  await client.query(
    `UPDATE circle_members
        SET joined_at   = NOW(),
            join_order  = $3,
            collateral  = $4
      WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, member, joinOrder, collateral.toString()],
  );
  console.log(
    `[indexer] Member joined: ${redactAddress(member)} → ${redactAddress(circleAddr)} ` +
      `(order=${joinOrder}, collateral=${collateral})`,
  );
}


async function handleCircleActive(client: PoolClient, circleAddr: string) {
  await client.query(
    "UPDATE circles SET status = 'Active', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  log("info", "event_ingested", {
    eventType: "circle/active",
    contractId: circleAddr,
  }, `Circle active: ${redactAddress(circleAddr)}`);
}

async function handleCircleContributed(client: PoolClient, circleAddr: string, event: SdkEvent) {
  // Event data: (circle_address, member, round_index, amount)
  const value = getValueNative(event) as unknown[];
  const memberAddr = String(value[1]);
  const roundIndex = Number(value[2]);
  const amount = value[3] !== undefined ? String(value[3]) : "0";

  await client.query(
    `INSERT INTO contributions (circle_address, member_address, round_index, amount, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (circle_address, member_address, round_index) DO NOTHING`,
    [circleAddr, memberAddr, roundIndex, amount, event.txHash, event.ledger],
  );
  log("info", "event_ingested", {
    ledger: event.ledger,
    eventType: "circle/contributed",
    contractId: circleAddr,
    txHash: event.txHash,
  }, `Contribution: ${redactAddress(memberAddr)} round ${roundIndex} → ${redactAddress(circleAddr)}`);
}

async function handleCirclePayout(client: PoolClient, circleAddr: string, event: SdkEvent) {
  // Event data: (circle_address, recipient, amount, round_index)
  const value = getValueNative(event) as unknown[];
  const recipient = String(value[1]);
  const pot = value[2] as bigint;
  const roundIndex = Number(value[3]);

  await client.query(
    `INSERT INTO payouts (circle_address, recipient, round_index, amount, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (circle_address, round_index) DO NOTHING`,
    [circleAddr, recipient, roundIndex, pot.toString(), event.txHash, event.ledger],
  );

  await client.query(
    `UPDATE circles SET current_round = $1, updated_at = NOW() WHERE address = $2`,
    [roundIndex + 1, circleAddr],
  );
  log("info", "event_ingested", {
    ledger: event.ledger,
    eventType: "circle/payout",
    contractId: circleAddr,
    txHash: event.txHash,
  }, `Payout: ${redactAddress(recipient)} ${formatAmount(pot)} round ${roundIndex} from ${redactAddress(circleAddr)}`);
}

async function handleCircleDefault(client: PoolClient, circleAddr: string, event: SdkEvent) {
  // Event data: (circle_address, member, penalty, round_index, new_collateral)
  const value = getValueNative(event) as unknown[];
  const memberAddr = String(value[1]);
  const penalty = value[2] as bigint;
  const roundIndex = Number(value[3]);

  await client.query(
    `INSERT INTO defaults (circle_address, member_address, round_index, penalty, tx_hash, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [circleAddr, memberAddr, roundIndex, penalty.toString(), event.txHash, event.ledger],
  );

  await client.query(
    `UPDATE circle_members SET defaults = defaults + 1
     WHERE circle_address = $1 AND member_address = $2`,
    [circleAddr, memberAddr],
  );
  log("info", "event_ingested", {
    ledger: event.ledger,
    eventType: "circle/default",
    contractId: circleAddr,
    txHash: event.txHash,
  }, `Default: ${redactAddress(memberAddr)} ${formatAmount(penalty)} round ${roundIndex} in ${redactAddress(circleAddr)}`);
}

async function handleCircleCompleted(client: PoolClient, circleAddr: string) {  await client.query(
    "UPDATE circles SET status = 'Completed', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  log("info", "event_ingested", {
    eventType: "circle/completed",
    contractId: circleAddr,
  }, `Circle completed: ${redactAddress(circleAddr)}`);
}

async function handleCircleCancelled(client: PoolClient, circleAddr: string, event: SdkEvent) {
  // Event data: (circle_address, caller, ledger)
  //   value[0] = circle_address (same as circleAddr — included for replay completeness)
  //   value[1] = caller  — the member who triggered the cancellation
  //   value[2] = ledger  — on-chain ledger sequence at the time of cancellation
  const value = getValueNative(event) as unknown[];
  const caller = value[1] !== undefined ? String(value[1]) : null;
  const onChainLedger = value[2] !== undefined ? String(value[2]) : null;

  // 1. Update the circle status (existing behaviour — unchanged)
  await client.query(
    "UPDATE circles SET status = 'Cancelled', updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );

  // 2. Write a structured audit row so the full cancellation context is
  //    durably persisted and queryable, not just the status change.
  //    ON CONFLICT DO NOTHING makes this idempotent for re-index replays.
  await client.query(
    `INSERT INTO circle_audit_events
       (circle_address, event_type, triggered_by, ledger, tx_hash)
     VALUES ($1, 'cancelled', $2, $3, $4)
     ON CONFLICT (circle_address, event_type) DO NOTHING`,
    [circleAddr, caller, onChainLedger, event.txHash ?? null],
  );

  console.log(
    `[indexer] Circle cancelled: ${redactAddress(circleAddr)}` +
    (caller ? ` by ${redactAddress(caller)}` : ""),
  );
}

async function handleCircleClosed(client: PoolClient, circleAddr: string, event: SdkEvent) {
  // Event data: (circle_address, closer, total_released, total_expected_collateral, reason)
  //   value[0] = circle_address         (same as circleAddr — replay completeness)
  //   value[1] = closer                 — member who called close()
  //   value[2] = total_released         — USDC stroops returned across all members
  //   value[3] = total_expected_collateral — what would have been released with zero penalties
  //   value[4] = reason                 — Symbol "completed" | "cancelled"
  const value = getValueNative(event) as unknown[];
  const closer = value[1] !== undefined ? String(value[1]) : null;
  const totalReleased = value[2] !== undefined ? String(value[2]) : "0";
  const totalExpectedCollateral = value[3] !== undefined ? String(value[3]) : null;
  const reason = value[4] !== undefined ? String(value[4]) : "unknown";

  // 1. Update circle status / financials (existing behaviour — extended)
  await client.query(
    `UPDATE circles
       SET status = 'Closed', updated_at = NOW(),
           total_released = $2, close_reason = $3
     WHERE address = $1`,
    [circleAddr, totalReleased, reason],
  );

  // 2. Write a structured audit row capturing the full close context.
  //    ON CONFLICT DO NOTHING makes this idempotent for re-index replays.
  await client.query(
    `INSERT INTO circle_audit_events
       (circle_address, event_type, triggered_by, ledger, tx_hash,
        total_released, total_expected_collateral, close_reason)
     VALUES ($1, 'closed', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (circle_address, event_type) DO NOTHING`,
    [
      circleAddr,
      closer,
      event.ledger ?? null,
      event.txHash ?? null,
      totalReleased,
      totalExpectedCollateral,
      reason,
    ],
  );

  console.log(
    `[indexer] Circle closed: ${redactAddress(circleAddr)} reason=${reason} ` +
    `released=${totalReleased}` +
    (closer ? ` by ${redactAddress(closer)}` : ""),
  );
}

async function handleCirclePaused(client: PoolClient, circleAddr: string) {
  // Event data: (circle_address, admin, ledger) — record paused flag
  await client.query(
    "UPDATE circles SET paused = TRUE, updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  log("info", "event_ingested", {
    eventType: "circle/paused",
    contractId: circleAddr,
  }, `Circle paused: ${redactAddress(circleAddr)}`);
}

async function handleCircleResumed(client: PoolClient, circleAddr: string) {
  // Event data: (circle_address, admin, ledger) — clear paused flag
  await client.query(
    "UPDATE circles SET paused = FALSE, updated_at = NOW() WHERE address = $1",
    [circleAddr],
  );
  log("info", "event_ingested", {
    eventType: "circle/resumed",
    contractId: circleAddr,
  }, `Circle resumed: ${redactAddress(circleAddr)}`);
}

/**
 * Handle `circle/initialized`.
 *
 * Contract event data: (circle_address, member_count: u32, round_amount: i128)
 *
 * The factory/circle_created event inserts the circle row with placeholder
 * values (round_amount=0, member_count=0).  This event fires immediately after
 * in the same transaction and carries the real values, so we patch them in.
 *
 * If no factory event preceded this (e.g. a direct initialize call without the
 * factory), we upsert the row to ensure it exists.
 */
async function handleCircleInitialized(
  client: PoolClient,
  circleAddr: string,
  event: SdkEvent,
) {
  // Event data: (circle_address, member_count, round_amount)
  //   value[0] = circle_address  (same as circleAddr — replay identity)
  //   value[1] = member_count    — u32 number of configured members (= total rounds)
  //   value[2] = round_amount    — i128 USDC stroops per member per round
  const value = getValueNative(event) as unknown[];
  const memberCount = value[1] !== undefined ? Number(value[1]) : 0;
  const roundAmount = value[2] !== undefined ? String(value[2]) : "0";

  await client.query(
    `INSERT INTO circles
       (address, creator, round_amount, member_count, total_rounds, status,
        current_round, created_ledger)
     VALUES ($1, '', $2, $3, $3, 'Pending', 0, $4)
     ON CONFLICT (address) DO UPDATE
       SET round_amount  = EXCLUDED.round_amount,
           member_count  = EXCLUDED.member_count,
           total_rounds  = EXCLUDED.total_rounds,
           updated_at    = NOW()`,
    [circleAddr, roundAmount, memberCount, event.ledger],
  );
  console.log(
    `[indexer] Circle initialized: ${redactAddress(circleAddr)} ` +
    `members=${memberCount} round_amount=${roundAmount}`,
  );
}

/**
 * Handle `circle/round_started`.
 *
 * Contract event data:
 *   (circle_address, round_index: u32, recipient: Address, deadline_ledger: u64)
 *
 * Emitted by payout() and settle_round() immediately after the current round
 * is settled, when there is still at least one round remaining.  We update
 * circles.current_round so the indexer's view stays synchronised with the
 * contract's RoundState without waiting for the next payout event.
 *
 * This closes the gap where the DB showed the *previous* round index between
 * a payout completing and the next contribution arriving.
 */
async function handleCircleRoundStarted(
  client: PoolClient,
  circleAddr: string,
  event: SdkEvent,
) {
  // Event data: (circle_address, round_index, recipient, deadline_ledger)
  //   value[0] = circle_address  (identity)
  //   value[1] = round_index     — u32, the NEW round that just opened
  //   value[2] = recipient       — Address scheduled to receive the pot this round
  //   value[3] = deadline_ledger — u64, last ledger to contribute before deadline
  const value = getValueNative(event) as unknown[];
  const roundIndex = value[1] !== undefined ? Number(value[1]) : null;

  if (roundIndex === null) {
    throw new Error(
      `circle/round_started: missing round_index in event data for ${circleAddr}`,
    );
  }

  await client.query(
    `UPDATE circles SET current_round = $1, updated_at = NOW() WHERE address = $2`,
    [roundIndex, circleAddr],
  );
  console.log(
    `[indexer] Round started: ${redactAddress(circleAddr)} round=${roundIndex}`,
  );
}

/**
 * Handle `circle/exceptional_settlement`.
 *
 * Contract event data:
 *   (circle_address, recipient: Address, pot: i128, round_index: u32,
 *    defaulted_count: u32)
 *
 * Emitted by settle_round() BEFORE the standard payout event on the same
 * round.  We record it alongside normal payouts so the /rounds endpoint can
 * flag which rounds were settled via the escape hatch.  The subsequent
 * circle/payout event still fires and is handled by handleCirclePayout as
 * normal — both events together give a complete picture of the settlement.
 *
 * The defaults for each non-contributing member are emitted as individual
 * circle/default events by the contract, so we do not duplicate that work here.
 */
async function handleCircleExceptionalSettlement(
  client: PoolClient,
  circleAddr: string,
  event: SdkEvent,
) {
  // Event data: (circle_address, recipient, pot, round_index, defaulted_count)
  //   value[0] = circle_address
  //   value[1] = recipient       — Address that received the partial pot
  //   value[2] = pot             — i128 USDC stroops actually paid out
  //   value[3] = round_index     — u32 round being settled
  //   value[4] = defaulted_count — u32 members who did NOT contribute
  const value = getValueNative(event) as unknown[];
  const recipient = value[1] !== undefined ? String(value[1]) : null;
  const pot = value[2] !== undefined ? String(value[2]) : "0";
  const roundIndex = value[3] !== undefined ? Number(value[3]) : null;
  const defaultedCount = value[4] !== undefined ? Number(value[4]) : 0;

  if (roundIndex === null) {
    throw new Error(
      `circle/exceptional_settlement: missing round_index in event data for ${circleAddr}`,
    );
  }

  // Record the exceptional settlement fact. ON CONFLICT preserves idempotency
  // for re-index replays: if handleCirclePayout already wrote this round we
  // update the exceptional flags in-place without duplicating the row.
  await client.query(
    `INSERT INTO payouts
       (circle_address, recipient, round_index, amount, tx_hash, ledger,
        is_exceptional, defaulted_count)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
     ON CONFLICT (circle_address, round_index) DO UPDATE
       SET is_exceptional  = TRUE,
           defaulted_count = EXCLUDED.defaulted_count`,
    [
      circleAddr,
      recipient,
      roundIndex,
      pot,
      event.txHash,
      event.ledger,
      defaultedCount,
    ],
  );

  console.log(
    `[indexer] Exceptional settlement: ${redactAddress(circleAddr)} ` +
    `round=${roundIndex} pot=${pot} defaulted=${defaultedCount}`,
  );
}

async function handleReputationIncrement(client: PoolClient, event: SdkEvent) {
  const score = getValueNative(event) as number;
  const memberAddr = getTopicStr(event, 1);

  if (!memberAddr) {
    throw new Error("reputation/increment: missing or malformed member topic");
  }

  await client.query(
    `INSERT INTO reputation (member_address, score, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (member_address) DO UPDATE SET score = $2, updated_at = NOW()`,
    [memberAddr, score],
  );
  log("info", "event_ingested", {
    ledger: event.ledger,
    eventType: "reputation/increment",
    contractId: memberAddr,
    txHash: event.txHash,
  }, `Reputation: ${redactAddress(memberAddr)} → score ${score}`);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

let totalEventsProcessed = 0;
let totalEventsFailed = 0;
let totalEventsSkipped = 0;
// Handler errors classified as transient: the ledger was rolled back and will
// be retried, so the event was neither skipped nor counted as failed.
let totalEventsRetried = 0;
let pollCyclesCompleted = 0;
let pollCyclesFailed = 0;
let lastPollDurationMs = 0;
let lastPollLedgerRange = "";

interface EventLogContext {
  contractId: string | null;
  topic: string;
  ledger: number;
  txHash?: string;
}

/**
 * Runs a single event's handler in isolation, updating cumulative metrics.
 * Exported for use in one-off testing and health utilities; the main ingest
 * pipeline uses processLedger which manages isolation via savepoints.
 */
export async function runEventHandler(
  handler: () => Promise<void>,
  ctx: EventLogContext,
): Promise<boolean> {
  try {
    await handler();
    totalEventsProcessed++;
    return true;
  } catch (err) {
    totalEventsFailed++;
    logEventHandlerError({
      ledger: ctx.ledger,
      eventType: ctx.topic,
      contractId: ctx.contractId ?? "unknown",
      txHash: ctx.txHash,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ─── Main poll cycle ──────────────────────────────────────────────────────────

/**
 * Fetch all relevant events for [fromLedger, toLedger], build canonical
 * (event, handler) pairs sorted by ledger then event id, and process each
 * ledger's batch atomically via processLedger.
 *
 * New circles discovered within the range are included in the circle-event
 * query without a DB round-trip, so joined/active/etc. events in the same
 * ledger as circle_created are not missed.
 *
 * The cursor in indexer_state is advanced per ledger inside processLedger.
 * After all event-carrying ledgers are done, setLastLedger advances the
 * cursor to toLedger to cover any trailing empty ledgers.
 */
async function processEvents(fromLedger: number, toLedger: number) {
  const startedAt = Date.now();

  // ── 1. Fetch factory + reputation events ────────────────────────────────
  const factoryResponse = await withRpcRetry("getEvents(factory+reputation)", () =>
    rpc.getEvents({
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [FACTORY, REPUTATION],
        },
      ],
      limit: EVENTS_LIMIT,
    }),
  );

  // ── 2. Pre-extract new circle addresses from factory events ──────────────
  // Doing this before any DB writes lets us include newly-created circles in
  // the circle-event query even before their circle_created event is committed.
  const newCircleAddrs: string[] = [];
  for (const event of factoryResponse.events) {
    if (!event.topic || event.topic.length < 2) continue;
    if (getTopicStr(event, 0) === "factory" && getTopicStr(event, 1) === "circle_created") {
      try {
        const { circleAddress } = parseCircleCreatedEvent(getValueNative(event));
        newCircleAddrs.push(circleAddress);
      } catch {
        // parse errors surface again at ingest time with full context
      }
    }
  }

  // ── 3. Merge known + newly-discovered circle addresses ───────────────────
  const existingCircles = await query<{ address: string }>("SELECT address FROM circles");
  const allCircleAddrs = [
    ...new Set([...existingCircles.map((c) => c.address), ...newCircleAddrs]),
  ];

  // ── 4. Fetch circle contract events ──────────────────────────────────────
  const circleEvents: SdkEvent[] = [];
  if (allCircleAddrs.length > 0) {
    const circleResponse = await withRpcRetry("getEvents(circles)", () =>
      rpc.getEvents({
        startLedger: fromLedger,
        filters: [{ type: "contract", contractIds: allCircleAddrs }],
        limit: EVENTS_LIMIT,
      }),
    );
    circleEvents.push(...circleResponse.events);
  }

  // ── 5. Build (event, handler) pairs ──────────────────────────────────────
  const items: EventHandler[] = [];

  for (const event of factoryResponse.events) {
    if (!event.topic || event.topic.length < 2) continue;
    const t0 = getTopicStr(event, 0);
    const t1 = getTopicStr(event, 1);
    if (t0 === "factory" && t1 === "circle_created") {
      items.push({ event, handler: (c) => handleFactoryCircleCreated(c, event) });
    } else if (t0 === "reputation" && t1 === "increment") {
      items.push({ event, handler: (c) => handleReputationIncrement(c, event) });
    }
  }

  for (const event of circleEvents) {
    if (!event.topic || event.topic.length < 2) continue;
    const t0 = getTopicStr(event, 0);
    const t1 = getTopicStr(event, 1);
    if (t0 !== "circle") continue;
    const contractId = getContractIdStr(event);
    if (!contractId) continue;

    let handler: ((client: PoolClient) => Promise<void>) | null = null;
    switch (t1) {
      case "initialized":            handler = (c) => handleCircleInitialized(c, contractId, event); break;
      case "joined":                 handler = (c) => handleCircleJoined(c, contractId, event); break;
      case "active":                 handler = (c) => handleCircleActive(c, contractId); break;
      case "contributed":            handler = (c) => handleCircleContributed(c, contractId, event); break;
      case "payout":                 handler = (c) => handleCirclePayout(c, contractId, event); break;
      case "default":                handler = (c) => handleCircleDefault(c, contractId, event); break;
      case "round_started":          handler = (c) => handleCircleRoundStarted(c, contractId, event); break;
      case "exceptional_settlement": handler = (c) => handleCircleExceptionalSettlement(c, contractId, event); break;
      case "completed":              handler = (c) => handleCircleCompleted(c, contractId); break;
      case "cancelled":              handler = (c) => handleCircleCancelled(c, contractId, event); break;
      case "closed":                 handler = (c) => handleCircleClosed(c, contractId, event); break;
      case "paused":                 handler = (c) => handleCirclePaused(c, contractId); break;
      case "resumed":                handler = (c) => handleCircleResumed(c, contractId); break;
      // collateral_released is per-member and emitted inside close(); the
      // aggregate total is captured by the circle/closed event handler above,
      // so individual collateral_released events need no separate DB write.
    }
    if (handler) items.push({ event, handler });
  }

  // ── 6. Sort by (ledger ASC, event id ASC) — canonical on-chain order ────
  // event.id encodes (ledger, txIndex, eventIndex), so string comparison is
  // sufficient for within-ledger ordering.
  items.sort((a, b) => {
    if (a.event.ledger !== b.event.ledger) return a.event.ledger - b.event.ledger;
    return (a.event.id ?? "").localeCompare(b.event.id ?? "");
  });

  // ── 7. Group by ledger ───────────────────────────────────────────────────
  const byLedger = new Map<number, EventHandler[]>();
  for (const item of items) {
    const l = item.event.ledger;
    const bucket = byLedger.get(l);
    if (bucket) bucket.push(item);
    else byLedger.set(l, [item]);
  }
  const sortedLedgers = [...byLedger.keys()].sort((a, b) => a - b);

  // ── 8. Process each ledger atomically, checkpointing per ledger ──────────
  let totalSeen = 0;
  let totalFailed = 0;

  for (const ledger of sortedLedgers) {
    const { processed, failed } = await processLedger(ledger, byLedger.get(ledger)!);
    totalSeen += processed;
    totalFailed += failed;
  }

  // ── 9. Advance cursor to cover any empty trailing ledgers ────────────────
  // processLedger sets the cursor to the highest event-carrying ledger.
  // Ledgers between that and toLedger had no relevant events; advance past them
  // so the next poll doesn't re-fetch a known-empty range.
  const lastEventLedger = sortedLedgers.length > 0
    ? sortedLedgers[sortedLedgers.length - 1]
    : 0;
  if (lastEventLedger < toLedger) {
    await setLastLedger(toLedger);
  }

  const durationMs = Date.now() - startedAt;
  logPollCompleted({
    fromLedger,
    toLedger,
    eventsProcessed: totalSeen,
    eventsFailed: totalFailed,
    durationMs,
  });
}

// ─── Backoff policy (Issue 29) ────────────────────────────────────────────────

/**
 * Exponential backoff state for the polling loop.
 *
 * Temporary RPC failures should not cause a hot loop or immediate process exit.
 * This policy tracks consecutive failures and computes the next wait interval
 * with capped exponential backoff + jitter.
 *
 * POLL_BACKOFF_INITIAL_MS, POLL_BACKOFF_MAX_MS, and POLL_BACKOFF_MULTIPLIER
 * are validated and exported by ./config so out-of-range values fail loudly
 * at boot rather than silently producing unexpected backoff behaviour.
 */
interface BackoffState {
  consecutiveFailures: number;
  currentIntervalMs: number;
}

const BACKOFF_INITIAL_MS = POLL_BACKOFF_INITIAL_MS;
const BACKOFF_MAX_MS = POLL_BACKOFF_MAX_MS;
const BACKOFF_MULTIPLIER = POLL_BACKOFF_MULTIPLIER;

function createBackoffState(): BackoffState {
  return {
    consecutiveFailures: 0,
    currentIntervalMs: BACKOFF_INITIAL_MS,
  };
}

function resetBackoff(state: BackoffState): void {
  state.consecutiveFailures = 0;
  state.currentIntervalMs = BACKOFF_INITIAL_MS;
}

function incrementBackoff(state: BackoffState): void {
  state.consecutiveFailures++;
  state.currentIntervalMs = Math.min(
    BACKOFF_MAX_MS,
    state.currentIntervalMs * BACKOFF_MULTIPLIER,
  );
}

/**
 * Compute the actual wait time with full jitter: returns a random value in
 * [0, currentIntervalMs] to spread load when many indexers recover simultaneously.
 */
function computeJitteredWait(state: BackoffState): number {
  return Math.floor(Math.random() * state.currentIntervalMs);
}

/**
 * Check if we should log a warning about repeated failures.
 * Warns at failure 3, 6, 12, 24, ... (doubling interval).
 */
function shouldWarnBackoff(state: BackoffState): boolean {
  const n = state.consecutiveFailures;
  return n >= 3 && (n & (n - 1)) === 0; // power of 2 check
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────

const backoffState = createBackoffState();

/**
 * One poll iteration: read the durable cursor from DB, fetch the latest
 * ledger from RPC, and process any new ledgers.
 *
 * The cursor is always read from the DB (not from an in-memory variable) so
 * that any per-ledger progress made before a crash is reflected on restart
 * without any special recovery logic.
 *
 * Issue 29: Added exponential backoff on transient RPC failures so temporary
 * outages don't cause a hot loop or process exit. The backoff state resets
 * after any successful poll.
 */
async function runPollCycle(): Promise<void> {
  const cycleStartedAt = Date.now();
  let lastLedger = await getLastLedger();
  if (lastLedger === 0) lastLedger = START_LEDGER;

  const latestLedger = await withRpcRetry("getLatestLedger", () => rpc.getLatestLedger());
  const toLedger = latestLedger.sequence;

  if (toLedger > lastLedger) {
    await processEvents(lastLedger + 1, toLedger);
  }
  
  // Success — reset backoff so the next failure starts from the initial interval
  resetBackoff(backoffState);
  
  pollCyclesCompleted++;
  lastPollDurationMs = Date.now() - cycleStartedAt;
  lastPollLedgerRange = `${lastLedger + 1}-${toLedger}`;
}

// ─── Poller lifecycle (graceful shutdown) ─────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight: Promise<void> | null = null;
let shuttingDown = false;
let indexerStarted = false;

export async function startIndexer() {
  if (indexerStarted) {
    throw new Error("[indexer] Event poller is already running");
  }

  logIndexerStarted({
    pollIntervalMs: POLL_INTERVAL_MS,
    eventsLimit: EVENTS_LIMIT,
    startLedger: START_LEDGER,
  });

  shuttingDown = false;
  indexerStarted = true;

  const tick = () => {
    if (shuttingDown) return;
    if (pollInFlight) {
      logTickSkipped();
      return;
    }

    pollInFlight = (async () => {
      try {
        await runPollCycle();
      } catch (err) {
        incrementBackoff(backoffState);
        pollCyclesFailed++;
        
        if (shouldWarnBackoff(backoffState)) {
          logPollBackoff({
            consecutiveFailures: backoffState.consecutiveFailures,
            currentIntervalMs: backoffState.currentIntervalMs,
          });
        }
        
        logPollFailed({
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures: backoffState.consecutiveFailures,
          backoffMs: backoffState.currentIntervalMs,
        });
        
        // Apply jittered backoff before the next tick
        const waitMs = computeJitteredWait(backoffState);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    })().finally(() => {
      pollInFlight = null;
    });
  };

  // Run an immediate tick so we don't wait a full interval on startup.
  tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

/**
 * Stop the event poller cleanly: clear the interval, refuse new ticks, and
 * wait for any in-flight poll cycle to finish so we don't exit mid-write.
 *
 * Accepts an optional AbortSignal so the caller (gracefulShutdown in index.ts)
 * can impose its own deadline.  When the signal fires before the in-flight
 * cycle resolves, stopIndexer rejects with an AbortError so the caller's
 * grace-period timer can force-exit rather than hanging indefinitely.
 */
export async function stopIndexer(signal?: AbortSignal): Promise<void> {
  if (!indexerStarted && !pollTimer && !pollInFlight) {
    log("info", "indexer_stopped", {}, "Event poller is not running — nothing to stop");
    return;
  }

  if (shuttingDown) {
    log("info", "indexer_stopped", {}, "Shutdown already in progress — waiting...");
    if (pollInFlight) {
      await raceWithAbort(pollInFlight.catch(() => undefined), signal);
    }
    return;
  }

  shuttingDown = true;
  log("info", "indexer_stopped", {}, "Graceful shutdown requested — stopping event poller...");

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (pollInFlight) {
    log("info", "indexer_stopped", {}, "Waiting for in-flight poll cycle to finish...");
    // Race the in-flight cycle against the abort signal so a stuck RPC call
    // does not block the process past the configured grace period.
    await raceWithAbort(pollInFlight.catch(() => undefined), signal);
  }

  indexerStarted = false;
  logIndexerStopped();
}

/**
 * Race a promise against an optional AbortSignal.
 *
 * If the signal fires before `promise` settles the returned promise rejects
 * with an AbortError (name === "AbortError"), propagating the cancellation to
 * the caller.  When no signal is provided the promise races against nothing
 * and this is a transparent pass-through.
 */
function raceWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      Object.assign(new Error("Shutdown aborted: grace period exceeded"), {
        name: "AbortError",
      }),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(
        Object.assign(new Error("Shutdown aborted: grace period exceeded"), {
          name: "AbortError",
        }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Test/ops helper: whether the poller has been started and not fully stopped. */
export function isIndexerRunning(): boolean {
  return indexerStarted && !shuttingDown;
}

export function getIndexerMetrics() {
  return {
    totalEventsProcessed,
    totalEventsFailed,
    totalEventsSkipped,
    totalEventsRetried,
    pollCyclesCompleted,
    pollCyclesFailed,
    lastPollDurationMs,
    lastPollLedgerRange,
    backoffConsecutiveFailures: backoffState.consecutiveFailures,
    backoffCurrentIntervalMs: backoffState.currentIntervalMs,
  };
}
