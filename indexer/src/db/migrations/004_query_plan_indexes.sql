-- Migration 004: indexes for frequent query patterns
--
-- Issue #533: Several GET /circles and GET /members query shapes that filter
-- or sort on circles.status, circles.updated_at, circles.round_amount,
-- circles.member_count, and multi-column contributions lookups were unindexed,
-- causing sequential scans as data volume grows.
--
-- This migration adds targeted indexes for the missing sort/filter columns.
-- See src/db/explain.ts to re-verify plans after schema changes.
--
-- Indexes added:
--   circles(status)
--       GET /circles?status=... and GET /circles/summary GROUP BY status
--   circles(updated_at DESC)
--       GET /circles?sort=updated_at
--   circles(round_amount DESC)
--       GET /circles?sort=round_amount
--   circles(member_count DESC)
--       GET /circles?sort=member_count
--   contributions(member_address, ledger DESC, round_index DESC)
--       GET /members/:member/contributions ORDER BY ledger, round_index
--   contributions(member_address, circle_address)
--       GET /members/:member/contributions?circle=... equality filter

CREATE INDEX IF NOT EXISTS idx_circles_status
    ON circles(status);

CREATE INDEX IF NOT EXISTS idx_circles_updated_at
    ON circles(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_circles_round_amount
    ON circles(round_amount DESC);

CREATE INDEX IF NOT EXISTS idx_circles_member_count
    ON circles(member_count DESC);

CREATE INDEX IF NOT EXISTS idx_contributions_member_ledger
    ON contributions(member_address, ledger DESC, round_index DESC);

CREATE INDEX IF NOT EXISTS idx_contributions_member_circle
    ON contributions(member_address, circle_address);
