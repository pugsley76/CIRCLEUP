# CircleUp — Data Dictionary

This document is the authoritative reference for the indexer's Postgres schema.
For each table it records:

- **Source event** — which on-chain event populates the row
- **API fields** — how the column appears in REST responses
- **Units** — numeric denomination (stroops, ledger count, etc.)
- **Nullability** — when a column can be NULL and why
- **Uniqueness / constraints** — primary keys, unique indexes, foreign keys
- **Rebuildability** — whether the table can be fully reconstructed by replaying
  events from the deployment ledger with `npm run replay`

For event payload shapes see [docs/EVENTS.md](./EVENTS.md).  
For the raw schema DDL see [indexer/src/db/schema.sql](../indexer/src/db/schema.sql).  
For replay and backup procedures see [docs/RUNBOOK.md](./RUNBOOK.md).

---

## Table of Contents

- [Conventions](#conventions)
- [circles](#circles)
- [circle\_members](#circle_members)
- [contributions](#contributions)
- [payouts](#payouts)
- [defaults](#defaults)
- [reputation](#reputation)
- [circle\_audit\_events](#circle_audit_events)
- [ingested\_events](#ingested_events)
- [indexer\_state](#indexer_state)
- [ledger\_checkpoints](#ledger_checkpoints)
- [schema\_migrations](#schema_migrations)
- [Derived and computed fields](#derived-and-computed-fields)
- [Rebuild matrix](#rebuild-matrix)

---

## Conventions

**Units**

| Type | Unit | Notes |
|---|---|---|
| USDC amounts | stroops (1 USDC = 10 000 000 stroops) | Stored as `NUMERIC`; never converted inside the DB |
| Ledger sequence | integer ledger number | Approximately 5 s per ledger on Stellar |
| Timestamps | UTC `TIMESTAMPTZ` | Set by the indexer at write time; not derived from the chain |
| Counts / scores | plain integer | Dimensionless |

**Nullability notation**

- `NOT NULL` — column is always set; a NULL value indicates a bug.
- `NULL when ...` — column is intentionally NULL under the stated condition.
- `NULL (legacy)` — column was added by migration and is NULL for rows created
  before the migration ran. These rows will remain NULL until the circle is
  re-indexed.

**Rebuildability**

A table is **fully rebuildable** if running `npm run replay -- --from=<deployment_ledger>`
produces an identical result (row-for-row, modulo `created_at` / `updated_at`
timestamps). Tables that store information not present in on-chain events are
**not rebuildable** and must be backed up.

---

## circles

**Purpose:** One row per deployed circle contract. Created by the
`factory/circle_created` event and updated as the circle progresses through its
lifecycle.

**Rebuildable:** Yes — all fields derive from `factory/circle_created`,
`circle/initialized`, `circle/active`, `circle/completed`, `circle/cancelled`,
`circle/closed`, `circle/paused`, `circle/resumed`.

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `id` | SERIAL | NOT NULL | — | *(internal)* | Surrogate primary key; not exposed in API responses |
| `address` | TEXT | NOT NULL | `factory/circle_created` data[0] `circle_address` | `circle.address` | Soroban contract ID (C-prefix strkey). Unique. |
| `creator` | TEXT | NOT NULL | `factory/circle_created` data[1] `creator` | `circle.creator` | G-prefix wallet address of the `create_circle` caller |
| `round_amount` | NUMERIC | NOT NULL | `circle/initialized` data[2] `round_amount` | `circle.round_amount` | USDC per member per round in **stroops**. Written as `0` by the `factory/circle_created` handler and backfilled by `circle/initialized`. |
| `member_count` | INTEGER | NOT NULL | `circle/initialized` data[1] `member_count` | `circle.member_count` | Total configured members. Written as `0` initially, backfilled by `circle/initialized`. Equal to `total_rounds`. |
| `status` | TEXT | NOT NULL | Multiple — see below | `circle.status` | One of `Pending`, `Active`, `Completed`, `Cancelled`, `Closed`. Default `Pending`. Updated by status-transition events. |
| `current_round` | INTEGER | NOT NULL | `circle/payout` data[3] `round_index` | `circle.current_round` | Zero-based index of the round currently in progress. Incremented after each payout. Default `0`. |
| `total_rounds` | INTEGER | NOT NULL | `circle/initialized` data[1] `member_count` | `circle.total_rounds` | Equal to `member_count`. Written as `0` initially, backfilled by `circle/initialized`. |
| `created_ledger` | BIGINT | NOT NULL | `factory/circle_created` ledger | `circle.created_ledger` | Ledger at which the factory event was processed |
| `round_deadline_ledgers` | BIGINT | NULL (legacy) | `circle/initialized` — sourced from `round_deadline_ledgers` factory arg | `circle.round_deadline_ledgers` | Added by migration 001. NULL for circles indexed before migration 001 was applied. Number of ledgers per round (~5 s/ledger). |
| `updated_at` | TIMESTAMPTZ | NOT NULL | *(indexer write time)* | `circle.updated_at` | Set to `NOW()` on every row update. Not derived from on-chain data; not stable across replays. |

**Status transition map**

| Event | Sets `status` to |
|---|---|
| Row created (at `factory/circle_created`) | `Pending` |
| `circle/active` | `Active` |
| `circle/completed` | `Completed` |
| `circle/cancelled` | `Cancelled` |
| `circle/closed` | `Closed` |

**Uniqueness / indexes**

- `address` — UNIQUE (one row per contract)
- `idx_circles_created_ledger` on `(created_ledger DESC)` — supports `GET /circles` default ordering
- `status` — no index; filtered by WHERE clause with low cardinality

---

## circle\_members

**Purpose:** One row per (circle, member) pair. Created when the
`circle/initialized` event is processed (the factory supplies the full member
list at creation time) and updated as each member joins.

**Rebuildable:** Yes — all fields derive from `circle/initialized` (initial row
creation with `payout_order`) and `circle/joined` (collateral, join\_order,
joined\_at).

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `id` | SERIAL | NOT NULL | — | *(internal)* | Surrogate key |
| `circle_address` | TEXT | NOT NULL | `circle/initialized` | `member.circle_address` | FK → `circles.address` |
| `member_address` | TEXT | NOT NULL | `circle/initialized` data[0..N] members list | `member.member_address` | G-prefix wallet address |
| `payout_order` | INTEGER | NOT NULL | `circle/initialized` — position in the members list | `member.payout_order` | **0-based** rotation index. `payout_order = 0` receives the first payout. Immutable after row creation. |
| `join_order` | INTEGER | NULL when unjoined | `circle/joined` data[2] `order` | `member.join_order` | **1-based** join-queue position. NULL until the member calls `join`. Set to `NULL` again on replay until the `joined` event is re-processed. |
| `collateral` | NUMERIC | NOT NULL | `circle/joined` data[3] `collateral` | `member.collateral` | USDC locked by this member in **stroops**. Default `0` until the member joins. Reduced by penalties when `mark_default` events are processed. |
| `defaults` | INTEGER | NOT NULL | `circle/default` — incremented per event | `member.defaults` | Count of rounds this member defaulted. Default `0`. |
| `joined_at` | TIMESTAMPTZ | NULL when unjoined | `circle/joined` — set to indexer write time | `member.joined_at` | Wall-clock time the indexer processed the join event. Not an on-chain timestamp; not stable across replays. |

**Uniqueness / indexes**

- `(circle_address, member_address)` — UNIQUE (one slot per wallet per circle)
- `idx_circle_members_address` on `(member_address)` — supports reputation and contribution lookups by wallet
- `idx_circle_members_join_order` on `(circle_address, join_order) WHERE join_order IS NOT NULL` — supports partial-index join-queue queries
- `idx_circle_members_circle_address` on `(circle_address, payout_order)` — supports circle-detail ordered member list

---

## contributions

**Purpose:** One row per (circle, member, round) contribution. Created by
`circle/contributed` events.

**Rebuildable:** Yes — all fields derive directly from `circle/contributed`.

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `id` | SERIAL | NOT NULL | — | *(internal)* | |
| `circle_address` | TEXT | NOT NULL | `circle/contributed` data[0] | `contribution.circle_address` | FK → `circles.address` |
| `member_address` | TEXT | NOT NULL | `circle/contributed` data[1] `member` | `contribution.member_address` | |
| `round_index` | INTEGER | NOT NULL | `circle/contributed` data[2] `round_index` | `contribution.round_index` | Zero-based |
| `amount` | NUMERIC | NOT NULL | `circle/contributed` data[3] `amount` | `contribution.amount` | **Stroops**. Equal to `round_amount` for standard contributions. |
| `tx_hash` | TEXT | NOT NULL | event metadata | `contribution.tx_hash` | Transaction hash of the contributing transaction |
| `ledger` | BIGINT | NOT NULL | event metadata | `contribution.ledger` | Ledger the event appeared in |
| `created_at` | TIMESTAMPTZ | NOT NULL | *(indexer write time)* | `contribution.created_at` | Not stable across replays |

**Uniqueness / indexes**

- `(circle_address, member_address, round_index)` — UNIQUE. Enforces the
  contract invariant that a member contributes at most once per round. Replay
  is idempotent via `ON CONFLICT DO NOTHING`.
- `idx_contributions_member` on `(member_address)` — supports `/members/:member/contributions`
- `idx_contributions_circle_round` on `(circle_address, round_index, created_at)` — supports round grouping in `/circles/:address/rounds`

---

## payouts

**Purpose:** One row per (circle, round) payout. Created by `circle/payout`
events.

**Rebuildable:** Yes — all fields derive from `circle/payout`.

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `id` | SERIAL | NOT NULL | — | *(internal)* | |
| `circle_address` | TEXT | NOT NULL | `circle/payout` data[0] | `payout.circle_address` | FK → `circles.address` |
| `recipient` | TEXT | NOT NULL | `circle/payout` data[1] `recipient` | `payout.recipient` | G-prefix wallet address of the round recipient |
| `round_index` | INTEGER | NOT NULL | `circle/payout` data[3] `round_index` | `payout.round_index` | Zero-based |
| `amount` | NUMERIC | NOT NULL | `circle/payout` data[2] `amount` | `payout.amount` | Total pot in **stroops** (`round_amount × member_count`) |
| `tx_hash` | TEXT | NOT NULL | event metadata | `payout.tx_hash` | |
| `ledger` | BIGINT | NOT NULL | event metadata | `payout.ledger` | |
| `created_at` | TIMESTAMPTZ | NOT NULL | *(indexer write time)* | `payout.created_at` | |

**Uniqueness / indexes**

- `(circle_address, round_index)` — UNIQUE. Each round has exactly one payout.
- `idx_payouts_recipient` on `(recipient)` — supports recipient-centric history queries

---

## defaults

**Purpose:** One row per (circle, member, round) default event. Created by
`circle/default` events. A member may have at most one default row per round
(enforced by the contract; the indexer does not add an additional constraint
because the dedup table guards against duplicate ingestion).

**Rebuildable:** Yes — all fields derive from `circle/default`.

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `id` | SERIAL | NOT NULL | — | *(internal)* | |
| `circle_address` | TEXT | NOT NULL | `circle/default` data[0] | `default.circle_address` | FK → `circles.address` |
| `member_address` | TEXT | NOT NULL | `circle/default` data[1] `member` | `default.member_address` | |
| `round_index` | INTEGER | NOT NULL | `circle/default` data[3] `round_index` | `default.round_index` | Zero-based |
| `penalty` | NUMERIC | NOT NULL | `circle/default` data[2] `penalty` | `default.penalty` | Collateral deducted in **stroops**. Equal to `round_amount × PENALTY_BPS / BPS_DENOM` = 20% of `round_amount`. |
| `tx_hash` | TEXT | NOT NULL | event metadata | `default.tx_hash` | |
| `ledger` | BIGINT | NOT NULL | event metadata | `default.ledger` | |
| `created_at` | TIMESTAMPTZ | NOT NULL | *(indexer write time)* | `default.created_at` | |

**Uniqueness / indexes**

- No unique constraint beyond `id`. The contract prevents a second `mark_default`
  for the same (member, round) pair so duplicates can only arise from replay
  anomalies; the `ingested_events` dedup table handles those.
- `idx_defaults_member` on `(member_address)` — supports reputation page defaults list
- `idx_defaults_circle_address` on `(circle_address, round_index)` — supports round grouping

---

## reputation

**Purpose:** One row per wallet that has ever received a reputation increment.
Upserted by `reputation/increment` events (which carry the member address in
`topic[2]`).

**Rebuildable:** Yes — all fields derive from `reputation/increment`.

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `member_address` | TEXT | NOT NULL | `reputation/increment` topic[2] | `reputation.member` | Primary key; G-prefix wallet address |
| `score` | INTEGER | NOT NULL | `reputation/increment` data `score` | `reputation.score` | Cumulative completed-round count. Monotonically non-decreasing. Default `0` on INSERT; overwritten on each UPSERT. |
| `updated_at` | TIMESTAMPTZ | NOT NULL | *(indexer write time)* | `reputation.updatedAt` | Not stable across replays |

**Uniqueness / constraints**

- `member_address` — PRIMARY KEY
- Score is written by the indexer as the absolute value from the event, not
  as an increment — the contract is the incrementing authority.

**Note on `score_updated`:** The `reputation/score_updated` event carries the
same score value as `reputation/increment`. The indexer processes only
`reputation/increment`; `score_updated` is reserved for external subscribers
that want a self-contained notification. Both events are emitted in the same
transaction; only one upsert is performed.

---

## circle\_audit\_events

**Purpose:** Structured audit log for terminal lifecycle transitions
(`cancelled`, `closed`). Created by `circle/cancelled` and `circle/closed`
events. Added by migration 004.

**Rebuildable:** Yes — all fields derive from the respective circle events.

| Column | Type | Null? | Source event | API field | Notes |
|---|---|---|---|---|---|
| `id` | SERIAL | NOT NULL | — | `event.id` | |
| `circle_address` | TEXT | NOT NULL | event data[0] | `event.circle_address` | FK → `circles.address` |
| `event_type` | TEXT | NOT NULL | event topic[1] | `event.event_type` | `'cancelled'` or `'closed'` |
| `triggered_by` | TEXT | NULL | `cancelled` data[1] `caller` / `closed` data[1] `closer` | `event.triggered_by` | G-prefix wallet address of the actor |
| `ledger` | BIGINT | NULL | event metadata | `event.ledger` | |
| `tx_hash` | TEXT | NULL | event metadata | `event.tx_hash` | |
| `total_released` | NUMERIC | NULL when not `closed` | `circle/closed` data[2] `total_released` | `event.total_released` | **Stroops**. NULL for `cancelled` rows. |
| `total_expected_collateral` | NUMERIC | NULL when not `closed` | `circle/closed` data[3] `total_expected_collateral` | `event.total_expected_collateral` | **Stroops**. Original collateral before any penalties. NULL for `cancelled` rows. |
| `close_reason` | TEXT | NULL when not `closed` | `circle/closed` data[4] `reason` | `event.close_reason` | `'completed'` or `'cancelled'`. NULL for `cancelled` rows. |
| `created_at` | TIMESTAMPTZ | NOT NULL | *(indexer write time)* | `event.created_at` | |

**Uniqueness / constraints**

- `(circle_address, event_type)` — UNIQUE. A circle is cancelled at most once
  and closed at most once; INSERTs use `ON CONFLICT DO NOTHING` for idempotent
  replay.
- `idx_circle_audit_events_circle` on `(circle_address)`
- `idx_circle_audit_events_type` on `(event_type)`
- `idx_circle_audit_events_created_at` on `(created_at DESC)`

**Penalty forfeiture calculation**

```
forfeited_collateral = total_expected_collateral - total_released
```

Both fields are available in `GET /circles/:address/audit` response rows.

---

## ingested\_events

**Purpose:** Deduplication ledger. One row per processed on-chain event.
Prevents the same Soroban event from being applied twice when the poll loop
delivers it more than once (at-least-once delivery guarantee from the RPC).

**Rebuildable:** Yes, but note that existing `event_key` values (for rows
created before migration 003) cannot be reconstructed if the raw key format
changes. Rows with NULL `event_index` fall back to `event_key` dedup only.

| Column | Type | Null? | Notes |
|---|---|---|---|
| `event_key` | TEXT | NOT NULL | Primary key. Composite key built by the indexer from available event fields. Format is internal and may change. |
| `contract_id` | TEXT | NULL | Soroban contract ID that emitted the event |
| `ledger` | BIGINT | NOT NULL | Ledger sequence |
| `tx_hash` | TEXT | NULL | Transaction hash |
| `event_type` | TEXT | NULL | Routing key, e.g. `"factory/circle_created"`. Used by `GET /indexer/state` aggregates. |
| `event_index` | INTEGER | NULL (legacy) | Zero-based index of the event within its transaction. Added by migration 003. NULL for events ingested before migration 003. |
| `created_at` | TIMESTAMPTZ | NOT NULL | Indexer write time |

**Uniqueness / indexes**

- `event_key` — PRIMARY KEY (legacy dedup)
- `idx_ingested_events_identity` — UNIQUE on `(ledger, tx_hash, event_index) WHERE event_index IS NOT NULL` (canonical identity dedup, migration 003)
- `idx_ingested_events_event_type` on `(event_type)` — supports `/indexer/state` GROUP BY

**Idempotency guarantee**

All indexer INSERT statements for derived tables (`circles`, `contributions`,
etc.) are wrapped with `ON CONFLICT DO NOTHING`. A replay of a ledger range
will re-attempt all inserts; only rows that differ from the already-stored
data will produce a conflict — those are silently skipped. The combination of
`ingested_events` dedup and per-table unique constraints makes the indexer
exactly-once at the database level even though the RPC is at-least-once at
the transport level.

---

## indexer\_state

**Purpose:** Single-row cursor. Stores the highest ledger sequence the indexer
has fully processed. Written atomically at the end of each ledger's event batch.

**Rebuildable:** Yes — the correct `last_ledger` value is the ledger sequence
of the last event processed, which is implicit in the event log. After a full
replay, the indexer resets this to the last replayed ledger.

| Column | Type | Null? | API field | Notes |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL | *(internal)* | Always `1`; enforced by `DEFAULT 1` and PRIMARY KEY |
| `last_ledger` | BIGINT | NOT NULL | `GET /indexer/state` → `lastLedger` | The ledger sequence of the last successfully committed batch |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `GET /indexer/state` → `updatedAt` | Indexer write time |

**Stale detection**

Alert when `last_ledger` does not advance. The gap between `last_ledger` and
the current network ledger (available via Horizon) is the indexer lag.
Typical acceptable lag is < 2 ledgers (~10 s). See
[docs/RUNBOOK.md — Health Checks](./RUNBOOK.md#health-checks-and-monitoring).

---

## ledger\_checkpoints

**Purpose:** Per-ledger outcome record. Written atomically alongside each
ledger's event batch to support crash recovery at ledger boundaries and to
make gap/stall patterns visible without scanning `ingested_events`.
Added by migration 002.

**Rebuildable:** Yes — checkpoint rows are written during event ingestion;
replay recreates them.

| Column | Type | Null? | Notes |
|---|---|---|---|
| `ledger` | BIGINT | NOT NULL | Primary key |
| `events_count` | INTEGER | NOT NULL | Number of events successfully processed in this ledger |
| `failed_count` | INTEGER | NOT NULL | Number of events that failed processing (parse errors, unexpected types). A non-zero value warrants investigation. |
| `processed_at` | TIMESTAMPTZ | NOT NULL | Indexer write time |

**Indexes**

- `idx_ledger_checkpoints_ledger` on `(ledger DESC)` — supports "latest N checkpoints" monitoring queries

---

## schema\_migrations

**Purpose:** Migration history. Tracks which SQL files under
`indexer/src/db/migrations/` have been applied and their content hash. Used by
`checkMigrationHealth()` to determine schema state (`clean`, `pending`,
`drifted`, `partial`, `uninitialized`).

**Rebuildable:** No — this table records which migrations have been applied to
*this database instance*. It cannot be reconstructed from event replay and must
be present after a restore. A missing `schema_migrations` table produces
`uninitialized` health state; run `npm run migrate` to create it.

| Column | Type | Null? | Notes |
|---|---|---|---|
| `filename` | TEXT | NOT NULL | Primary key. Migration filename, e.g. `003_event_dedup_constraints.sql`. |
| `applied_at` | TIMESTAMPTZ | NOT NULL | When the migration was applied |
| `content_hash` | TEXT | NULL | SHA-256 of the migration file content at the time of application. Used to detect `drifted` state (file changed after apply). |

---

## Derived and computed fields

Some API response fields are computed at query time rather than stored directly.
These are not columns but are documented here because integrators see them in
responses.

| API field | Route | Derivation | Notes |
|---|---|---|---|
| `circle.deadline_ledger` | `GET /circles/:address` | `created_ledger + (current_round + 1) × round_deadline_ledgers` | Approximate; `null` when `round_deadline_ledgers` is NULL (pre-migration-001 circles) or when `status != 'Active'` |
| `round.deadlineLedger` | `GET /circles/:address/rounds` | Same formula, per `round_index` | `null` under same conditions |
| `member.total_contributions` | `GET /circles/:address/members` | `COUNT(*)` from `contributions` for (circle, member) | Counts all historical rounds, not just the current round |
| `totals.memberCount` | `GET /circles/:address/members` | `COUNT(*)` from `circle_members` for circle | |
| `totals.totalCollateral` | `GET /circles/:address/members` | `SUM(collateral)` from `circle_members` | **Stroops**; current collateral after penalties |
| `totals.totalContributions` | `GET /circles/:address/members` | `COUNT(*)` from `contributions` for circle | All rounds, all members |
| `reputation.found` | `GET /reputation/:member` | `reputation row IS NOT NULL` | `false` for wallets with no completed rounds |
| `latestLedger` | `GET /circles/:address` | `indexer_state.last_ledger` | Attached to the response so clients can estimate deadline wall-clock time without a separate `/indexer/state` call |

---

## Rebuild matrix

| Table | Rebuildable from events? | Command | Notes |
|---|---|---|---|
| `circles` | Yes | `npm run replay -- --from=<ledger>` | All lifecycle columns are event-sourced |
| `circle_members` | Yes | same | `joined_at` will differ (indexer write time) |
| `contributions` | Yes | same | `created_at` will differ |
| `payouts` | Yes | same | `created_at` will differ |
| `defaults` | Yes | same | `created_at` will differ |
| `reputation` | Yes | same | `updated_at` will differ |
| `circle_audit_events` | Yes | same | `created_at` will differ |
| `ingested_events` | Yes | same | `created_at` will differ; pre-migration-003 rows lose `event_index` |
| `indexer_state` | Yes | same | Reset to last replayed ledger by replay script |
| `ledger_checkpoints` | Yes | same | Recreated during event ingestion |
| `schema_migrations` | **No** | `npm run migrate` | Records applied migrations; must be backed up or recreated by re-running all migrations |

For backup and restore procedures see
[docs/RUNBOOK.md — Database Backup and Restore](./RUNBOOK.md#database-backup-and-restore).
