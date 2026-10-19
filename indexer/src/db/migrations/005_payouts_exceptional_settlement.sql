-- Migration 005: payouts — exceptional settlement columns
--
-- Issue: emit state transition events for every lifecycle change.
--
-- The `handleCircleExceptionalSettlement` handler (circle/exceptional_settlement
-- event) needs to record two additional facts about a payout row:
--
--   is_exceptional   — TRUE when the round was settled via settle_round() after
--                      the deadline passed without full contributions, rather
--                      than the normal payout() path with all members present.
--
--   defaulted_count  — How many members did NOT contribute in this round.
--                      Derived from the event payload (total_defaulted field).
--                      NULL for normally-settled rounds.
--
-- These columns are added with defaults so existing rows are unaffected and
-- the migration is safe to run against a live table without locking.
--
-- Idempotent: IF NOT EXISTS / DEFAULT NULL means re-running this migration
-- on an already-migrated schema is a no-op.

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS is_exceptional  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS defaulted_count INTEGER     NULL;

-- Support the /circles/:address/rounds endpoint query that filters for
-- exceptional settlements without a full table scan.
CREATE INDEX IF NOT EXISTS idx_payouts_exceptional
    ON payouts(circle_address)
    WHERE is_exceptional = TRUE;

