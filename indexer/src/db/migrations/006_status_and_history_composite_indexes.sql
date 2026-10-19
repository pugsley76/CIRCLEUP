-- Migration 006: composite indexes for filtered + sorted list queries
--
-- Issue #668: verify database indexes against representative query plans.
--
-- src/db/explain.ts was used to review every API query shape (inventory and
-- baseline plans in docs/QUERY_PLANS.md). Two shapes filter on one column and
-- sort on another, so the single-column indexes from schema.sql / migration
-- 004 can only satisfy the filter: Postgres must fetch every matching row and
-- run a Sort before applying LIMIT. Both are paginated endpoints whose
-- matching set grows without bound, so the sort cost grows with data volume
-- while the page size stays 20.
--
-- Indexes added:
--   circles(status, created_ledger DESC)
--       GET /circles?status=... with the default sort (created_ledger DESC).
--       idx_circles_status only serves the filter; status has 5 values, so
--       each status can match a large share of the table, all of which was
--       sorted to return one page. With the composite index the plan is an
--       ordered Index Scan that stops after LIMIT rows.
--   contributions(member_address, circle_address, ledger DESC, round_index DESC, created_at DESC)
--       GET /members/:member/contributions?circle=... ordered by
--       ledger DESC, round_index DESC, created_at DESC. The existing
--       idx_contributions_member_circle (member_address, circle_address)
--       serves the filter but not the ORDER BY, forcing a Sort per page.
--
-- Reviewed and intentionally NOT indexed (see docs/QUERY_PLANS.md):
--   circle_audit_events(circle_address, created_at) — at most two rows per
--       circle (UNIQUE(circle_address, event_type)), so sorting is free.
--   per-member contribution COUNT on GET /circles/:address/members — already
--       served by UNIQUE(circle_address, member_address, round_index).
--
-- Operational safety:
--   - Additive only; no table rewrite, no column change, no data change.
--   - Idempotent: IF NOT EXISTS makes a re-run a no-op.
--   - migrate.ts applies each file inside a transaction, so CONCURRENTLY is
--     not available here and CREATE INDEX briefly blocks writes (indexer
--     ingestion) on the indexed table while it builds; reads are unaffected.
--     For large production tables, pre-create the indexes out of band with
--     the identical names using CREATE INDEX CONCURRENTLY; this migration
--     then becomes a no-op.
--   - idx_contributions_member_circle is left in place: it is now redundant
--     with the wider index, but dropping it is deferred until
--     pg_stat_user_indexes confirms it is unused in production.

CREATE INDEX IF NOT EXISTS idx_circles_status_created_ledger
    ON circles(status, created_ledger DESC);

CREATE INDEX IF NOT EXISTS idx_contributions_member_circle_ledger
    ON contributions(member_address, circle_address, ledger DESC, round_index DESC, created_at DESC);
