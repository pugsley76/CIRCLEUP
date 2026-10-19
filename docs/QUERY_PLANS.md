# CircleUp — Indexer Query Plans and Index Justification

Every index on the indexer database should exist because a critical API query
needs it. This document lists those queries, the data volumes they run
against, the index each one should use, and how to re-check the plans.

The query list is kept in sync with `indexer/src/db/explain.ts`, which runs
`EXPLAIN (ANALYZE, BUFFERS)` on each query against the connected database.

---

## Reproducing the plans

```bash
# Against a database populated by the indexer (or a replay of a busy network)
npm run explain --workspace=indexer           # summary: cost, time, scan/sort nodes
npm run explain --workspace=indexer -- --text # also print the full text plans
```

The script:

1. Picks the circle and the member with the most contribution rows as the
   sample parameters, so per-circle and per-member queries hit real data.
2. Prints table cardinalities, including the largest per-circle and
   per-member contribution counts.
3. Prints one line per query: total planner cost, execution time, and the
   scan/sort nodes used.
4. Lists queries whose plan does not use the expected index. On small tables a
   sequential scan is often the correct choice, so this list is advisory —
   compare it against the cardinalities before acting.

Run it before and after any schema or query change and record the numbers in
the PR description. Planner choices depend on table statistics, so run
`ANALYZE` first on a freshly loaded database.

## Expected cardinalities

| Table | Growth | Fan-out that matters |
|-------|--------|----------------------|
| `circles` | One row per circle — grows forever | `status` has 5 values; Active / Completed dominate over time |
| `circle_members` | `member_count` rows per circle (small, ≤ protocol max) | Per circle: tens of rows |
| `contributions` | members × rounds per circle — the largest table | Per circle: members² ; per member: every round of every circle joined |
| `payouts` | One row per completed round | Per circle: ≤ members |
| `defaults` | One row per missed contribution | Per circle / member: small |
| `circle_audit_events` | ≤ 2 rows per circle (`UNIQUE(circle_address, event_type)`) | Per circle: ≤ 2 |

## Query inventory

| # | Endpoint / query | Filter → order | Index used | Notes |
|---|------------------|----------------|------------|-------|
| 1 | `GET /circles` | — → `created_ledger DESC` LIMIT | `idx_circles_created_ledger` | Ordered index scan, stops at LIMIT. Other sort columns use `idx_circles_updated_at` / `_round_amount` / `_member_count` (migration 004). |
| 2 | `GET /circles?status=` | `status` → `created_ledger DESC` LIMIT | `idx_circles_status_created_ledger` (**migration 006**) | Before: `idx_circles_status` + full Sort of every matching row. |
| 3 | `GET /circles/summary` | — → `GROUP BY status` | `idx_circles_status` or seq scan | Whole-table aggregate; a seq scan is acceptable. |
| 4 | `GET /circles/:address` | `address =` | `circles_address_key` (UNIQUE) | Single row. |
| 5 | `GET /circles/:address` members | `circle_address =` → `payout_order` | `idx_circle_members_circle_address` | Index order matches ORDER BY — no Sort. |
| 6 | `GET /circles/:address/members` per-member count | `circle_address =, member_address =` | `contributions_circle_address_member_address_round_index_key` | Correlated subquery per member; served by the UNIQUE constraint index. |
| 7 | `GET /circles/:address/rounds` contributions | `circle_address =` → `round_index, created_at` | `idx_contributions_circle_round` | No Sort. |
| 8 | `GET /circles/:address/rounds` defaults | `circle_address =` → `round_index` | `idx_defaults_circle_address` | No Sort. |
| 9 | `GET /circles/:address/rounds` payouts | `circle_address =` → `round_index` | `payouts_circle_address_round_index_key` | UNIQUE index order matches. |
| 10 | `GET /circles/:address/audit` | `circle_address =` → `created_at` | `circle_audit_events_circle_address_event_type_key` / `idx_circle_audit_events_circle` | ≤ 2 rows: the Sort is free. No new index. |
| 11 | `GET /reputation/:member` contributions | `member_address =` → `GROUP BY circle_address` | `idx_contributions_member` | Join to `circles` on `circles_address_key`. |
| 12 | `GET /reputation/:member` defaults | `member_address =` | `idx_defaults_member` | Small result. |
| 13 | `GET /members/:member/contributions` | `member_address =` → `ledger DESC, round_index DESC, created_at DESC` LIMIT | `idx_contributions_member_ledger` | `created_at` tiebreak may add an Incremental Sort over equal (ledger, round_index) groups — effectively free. |
| 14 | `GET /members/:member/contributions?circle=` | `member_address =, circle_address =` → same order LIMIT | `idx_contributions_member_circle_ledger` (**migration 006**) | Before: `idx_contributions_member_circle` + full Sort. |

## Gaps found and fixed

Both gaps have the same shape: an equality filter served by an index that
does not also cover the ORDER BY. The plan had to read every matching row and
Sort it before LIMIT could apply, so the cost of returning one 20-row page grew
with the size of the matching set.

| Query | Before (plan shape) | After (plan shape) | Migration |
|-------|---------------------|--------------------|-----------|
| #2 `GET /circles?status=` | `Limit → Sort → Bitmap Heap Scan (idx_circles_status)` — sorts every circle in that status | `Limit → Index Scan using idx_circles_status_created_ledger` — reads ≈ LIMIT rows | `006_status_and_history_composite_indexes.sql` |
| #14 `GET /members/:member/contributions?circle=` | `Limit → Sort → Index Scan (idx_contributions_member_circle)` | `Limit → Index Scan using idx_contributions_member_circle_ledger` | `006_status_and_history_composite_indexes.sql` |

Record the measured before/after cost and execution time from
`npm run explain` in the PR that changes these indexes.

## Reviewed, no change

- **Audit events (#10):** at most two rows per circle; an index on
  `(circle_address, created_at)` would cost writes and space for no gain.
- **Members contribution count (#6):** already served by the
  `contributions` UNIQUE constraint.
- **`idx_contributions_member_circle`:** redundant with the wider migration-006
  index. It is kept until `pg_stat_user_indexes.idx_scan` confirms it is unused
  in production; dropping it is then a separate, trivially safe migration.

## Adding an index

1. Add the query to `buildQueries` in `indexer/src/db/explain.ts` with its
   `expectIndex`.
2. Capture the plan on representative data and confirm the gap (a Sort or seq
   scan over a large, growing set).
3. Add a numbered migration with a header that states the query, the gap, and
   the operational impact (see migration 006). Migrations run in a
   transaction, so `CREATE INDEX CONCURRENTLY` cannot be used inside them;
   pre-create large indexes concurrently with the same name and let
   `IF NOT EXISTS` make the migration a no-op.
4. Re-run `npm run explain` and update this document.
