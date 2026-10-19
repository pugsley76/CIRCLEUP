-- Migration 004: circle_audit_events — structured audit log for terminal lifecycle transitions
--
-- Issue: add audit events for close and cancelled transitions.
--
-- The contract emits rich event payloads on circle/closed and circle/cancelled
-- transitions, but the indexer previously only updated the circles.status column
-- and discarded the rest of the payload. This migration introduces a dedicated
-- audit table so the fuller context (who triggered the transition, amounts
-- released, reason) is durably persisted and queryable.
--
-- Stored transitions:
--   cancelled — emitted by circle/cancelled (caller, ledger)
--   closed    — emitted by circle/closed    (closer, total_released,
--                                            total_expected_collateral, reason)
--
-- Design choices:
--   - event_type TEXT NOT NULL: one of 'cancelled' | 'closed'. Extensible for
--     future terminal events without a schema change.
--   - circle_address + event_type are NOT unique: a circle theoretically emits
--     at most one cancelled and one closed event, but a re-index or savepoint
--     rollback could replay the same event. The ingested_events dedup table
--     guards against exact duplicates; ON CONFLICT DO NOTHING here guards
--     against logical duplicates (same circle_address + event_type).
--   - Monetary amounts use NUMERIC to match the existing contributions/payouts
--     tables; NULL when not applicable (e.g. cancelled rows have no total_released).

CREATE TABLE IF NOT EXISTS circle_audit_events (
    id                       SERIAL PRIMARY KEY,
    circle_address           TEXT NOT NULL REFERENCES circles(address),
    event_type               TEXT NOT NULL,          -- 'cancelled' | 'closed'
    triggered_by             TEXT,                   -- address that triggered the event
    ledger                   BIGINT,                 -- on-chain ledger sequence
    tx_hash                  TEXT,                   -- originating transaction hash
    total_released           NUMERIC,                -- USDC stroops returned (closed only)
    total_expected_collateral NUMERIC,               -- full collateral without penalties (closed only)
    close_reason             TEXT,                   -- 'completed' | 'cancelled' (closed only)
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Prevent duplicate audit rows for the same circle transition.
    -- A circle can only be cancelled once and closed once, so the combination
    -- of circle_address + event_type is logically unique. ON CONFLICT DO NOTHING
    -- in the INSERT makes replays idempotent.
    UNIQUE (circle_address, event_type)
);

-- Support queries like "find all cancelled circles with their closer address"
-- without a full table scan.
CREATE INDEX IF NOT EXISTS idx_circle_audit_events_circle
    ON circle_audit_events(circle_address);

-- Support audit dashboard queries filtering by event type.
CREATE INDEX IF NOT EXISTS idx_circle_audit_events_type
    ON circle_audit_events(event_type);

-- Support time-range audit queries (e.g. "closures in the last 7 days").
CREATE INDEX IF NOT EXISTS idx_circle_audit_events_created_at
    ON circle_audit_events(created_at DESC);

