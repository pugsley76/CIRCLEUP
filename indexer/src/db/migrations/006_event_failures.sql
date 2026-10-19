-- Migration 006: event_failures — durable evidence for skipped events
--
-- Issue: make event-handler failures observable and safely recoverable.
--
-- processLedger isolates each event in a savepoint. When a handler throws, the
-- savepoint rollback also removes the event's ingested_events row, the ledger
-- still commits, and the cursor moves past it. Before this table the only
-- trace was a log line, so a poison event could be skipped indefinitely
-- without anyone finding it.
--
-- One row per failed event, keyed by the RPC event id (ledger / transaction /
-- event position — no payload). Repeat failures of the same event increment
-- `attempts`. The row is "open" until:
--   resolved_at      — set by processLedger, in the same transaction, when the
--                      event later ingests successfully (retry / replay);
--   acknowledged_at  — set by an operator who accepts the skip.
--
-- Privacy: no topics, no value, no event_key (event_key embeds the payload).
-- error_message is redacted and truncated by the indexer before insert.
--
-- Operational profile: additive. New table + indexes on an empty table — no
-- lock on existing tables, no data transformation. Reversible while the app
-- version that writes it is not running (DROP TABLE loses only failure
-- evidence, never projections). See docs/MIGRATIONS.md.

CREATE TABLE IF NOT EXISTS event_failures (
    event_id          TEXT PRIMARY KEY,                  -- RPC event id (payload-free)
    ledger            BIGINT NOT NULL,
    tx_hash           TEXT,
    contract_id       TEXT,
    event_type        TEXT,                              -- e.g. 'circle/joined'
    error_class       TEXT NOT NULL,                     -- 'permanent' (transient errors retry the ledger instead)
    error_name        TEXT,                              -- Error name or Postgres SQLSTATE
    error_message     TEXT,                              -- redacted, truncated
    attempts          INTEGER NOT NULL DEFAULT 1,
    first_failed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_failed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at       TIMESTAMPTZ,
    acknowledged_at   TIMESTAMPTZ,
    acknowledged_note TEXT
);

-- Lookup by ledger (GET /indexer/failures?ledger=, replay preflight ranges).
CREATE INDEX IF NOT EXISTS idx_event_failures_ledger
    ON event_failures(ledger);

-- Health check / listing only ever look at open rows.
CREATE INDEX IF NOT EXISTS idx_event_failures_open
    ON event_failures(ledger)
    WHERE resolved_at IS NULL AND acknowledged_at IS NULL;
