/**
 * Representative indexer response bodies, one per public endpoint (issue #661).
 *
 * Each fixture mirrors what `indexer/src/api.ts` actually serialises,
 * including the Postgres wire quirks that the TypeScript interfaces alone do
 * not capture:
 *   • NUMERIC columns (amounts, collateral) arrive as decimal strings.
 *   • BIGINT columns (ledger sequences, round_deadline_ledgers) arrive as
 *     decimal strings, while values computed in JS (deadline_ledger,
 *     latestLedger) arrive as numbers.
 *   • TIMESTAMPTZ columns arrive as ISO-8601 strings.
 *   • COUNT(*) aggregates are converted to numbers by the API before
 *     serialising.
 *
 * When the indexer response shape changes, update the fixture here and the
 * matching schema in `sdk/src/indexerSchema.ts` in the same change, following
 * docs/INDEXER_API_COMPATIBILITY.md.
 */

const CIRCLE = "CCIRCLEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CREATOR = "GCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMBER_A = "GMEMBERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMBER_B = "GMEMBERBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TX_A = "a".repeat(64);
const TX_B = "b".repeat(64);
const TX_C = "c".repeat(64);

/** A circle row as listed by GET /circles. */
const CIRCLE_LIST_ROW = {
  address: CIRCLE,
  creator: CREATOR,
  round_amount: "100000000",
  member_count: 2,
  status: "Active",
  current_round: 1,
  total_rounds: 2,
  created_ledger: "1200000",
  updated_at: "2026-01-01T00:00:00.000Z",
};

/** GET /circles */
export const CIRCLES_LIST_FIXTURE = {
  circles: [CIRCLE_LIST_ROW],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

/** GET /circles/:address */
export const CIRCLE_DETAIL_FIXTURE = {
  circle: {
    id: 7,
    ...CIRCLE_LIST_ROW,
    round_deadline_ledgers: "120960",
    deadline_ledger: 1_441_920,
  },
  members: [
    {
      id: 11,
      circle_address: CIRCLE,
      member_address: MEMBER_A,
      payout_order: 0,
      join_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: "2026-01-01T00:00:00.000Z",
      reputation_score: 3,
    },
    {
      id: 12,
      circle_address: CIRCLE,
      member_address: MEMBER_B,
      payout_order: 1,
      join_order: null,
      collateral: "0",
      defaults: 0,
      joined_at: null,
      reputation_score: null,
    },
  ],
  latestLedger: 1_300_000,
};

/** GET /circles/:address/members */
export const MEMBERS_FIXTURE = {
  members: [
    {
      member_address: MEMBER_A,
      payout_order: 0,
      join_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: "2026-01-01T00:00:00.000Z",
      reputation_score: 3,
      total_contributions: 2,
    },
  ],
  totals: {
    memberCount: 1,
    totalCollateral: "100000000",
    totalContributions: 2,
  },
  roundDeadlineLedgers: "120960",
};

/** GET /circles/:address/rounds */
export const ROUNDS_FIXTURE = {
  rounds: [
    {
      roundIndex: 0,
      status: "completed",
      recipient: MEMBER_A,
      amount: "200000000",
      txHash: TX_A,
      ledger: "1250000",
      deadlineLedger: 1_320_960,
      contributions: [
        {
          id: 1,
          circle_address: CIRCLE,
          member_address: MEMBER_A,
          round_index: 0,
          amount: "100000000",
          tx_hash: TX_B,
          ledger: "1240000",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      defaults: [],
    },
  ],
  currentRound: {
    roundIndex: 1,
    status: "current",
    recipient: null,
    amount: null,
    txHash: null,
    ledger: null,
    deadlineLedger: 1_441_920,
    contributions: [],
    defaults: [],
  },
  openRounds: [],
  pendingDefaults: [
    {
      id: 3,
      circle_address: CIRCLE,
      member_address: MEMBER_B,
      round_index: 1,
      penalty: "10000000",
      tx_hash: TX_C,
      ledger: "1290000",
      created_at: "2026-01-03T00:00:00.000Z",
    },
  ],
};

/** GET /members/:member/contributions (history) */
export const MEMBER_CONTRIBUTIONS_FIXTURE = {
  member: MEMBER_A,
  circle: null,
  contributions: [
    {
      circle_address: CIRCLE,
      member_address: MEMBER_A,
      round_index: 0,
      amount: "100000000",
      tx_hash: TX_B,
      ledger: "1240000",
      created_at: "2026-01-02T00:00:00.000Z",
    },
  ],
  totalAmount: "100000000",
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
};

/** GET /reputation/:member */
export const REPUTATION_FIXTURE = {
  member: MEMBER_A,
  found: true,
  score: 3,
  contributions: [{ circle_address: CIRCLE, contributions: 2, total_rounds: 2 }],
  defaults: [{ circle_address: CIRCLE, count: 0 }],
  updatedAt: "2026-01-02T00:00:00.000Z",
};

/** GET /reputation/:member for a member the indexer has never seen. */
export const REPUTATION_UNKNOWN_MEMBER_FIXTURE = {
  member: MEMBER_B,
  found: false,
  detail: `Member '${MEMBER_B}' has no reputation record in the indexer.`,
  score: 0,
  contributions: [],
  defaults: [],
  updatedAt: null,
};

/** GET /circles/:address/audit */
export const AUDIT_EVENTS_FIXTURE = {
  circle_address: CIRCLE,
  events: [
    {
      id: 1,
      circle_address: CIRCLE,
      event_type: "closed",
      triggered_by: CREATOR,
      ledger: "1500000",
      tx_hash: TX_A,
      total_released: "190000000",
      total_expected_collateral: "200000000",
      close_reason: "completed",
      created_at: "2026-02-01T00:00:00.000Z",
    },
  ],
};

/** GET /health (component breakdown abbreviated — it is not part of the SDK contract). */
export const HEALTH_FIXTURE = {
  status: "ok",
  serviceStatus: "healthy",
  timestamp: "2026-01-01T00:00:00.000Z",
  db: { status: "ok" },
  rpc: { status: "ok" },
};

/** GET /indexer/state */
export const INDEXER_STATE_FIXTURE = {
  lastLedger: 1_300_000,
  updatedAt: "2026-01-01T00:00:00.000Z",
  totalEvents: 5,
  eventCounts: { circle_created: 1, contribution: 3, payout: 1 },
  entityCounts: {
    circles: 1,
    members: 2,
    contributions: 3,
    payouts: 1,
    defaults: 1,
    circlesByStatus: { Active: 1 },
  },
};
