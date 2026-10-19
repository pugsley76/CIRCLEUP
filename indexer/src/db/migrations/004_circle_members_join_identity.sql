-- Migration 004: add join identity fields to circle_members
--
-- Issue: the circle/joined event carries two fields the indexer was previously
-- discarding: join_order (1-based position in the join queue) and collateral
-- (USDC stroops locked by the member at join time).
--
-- join_order is distinct from payout_order:
--   payout_order — 0-indexed position in the configured rotation; fixed at
--                  circle creation time; determines which round pays this member.
--   join_order   — 1-based position in the actual join sequence; records which
--                  member joined first/last regardless of rotation slot.
--
-- collateral was always present in the schema (DEFAULT 0) but was never
-- populated from the event payload.  This migration is a no-op for that
-- column; the handler change ensures it is set correctly on every new join.
--
-- NULL on rows pre-dating this migration; those members joined before the
-- indexer was updated and the join sequence can no longer be recovered.

ALTER TABLE circle_members
  ADD COLUMN IF NOT EXISTS join_order INTEGER;   -- NULL until backfilled or re-indexed

-- Optional index: useful for queries like "who joined first?" or displaying
-- join progress in the UI without sorting by joined_at.
CREATE INDEX IF NOT EXISTS idx_circle_members_join_order
  ON circle_members(circle_address, join_order)
  WHERE join_order IS NOT NULL;
