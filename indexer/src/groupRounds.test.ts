import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupByRoundIndex,
  groupCircleRounds,
  buildPayoutIndex,
  resolveStatus,
} from "./groupRounds";

// ─── groupByRoundIndex ────────────────────────────────────────────────────────

test("groupByRoundIndex buckets rows in a single pass", () => {
  const rows = [
    { round_index: 0, id: "a" },
    { round_index: 1, id: "b" },
    { round_index: 0, id: "c" },
  ];
  const map = groupByRoundIndex(rows);
  assert.equal(map.get(0)?.length, 2);
  assert.equal(map.get(1)?.length, 1);
  assert.equal(map.has(2), false);
});

test("groupByRoundIndex returns empty map for empty input", () => {
  const map = groupByRoundIndex([]);
  assert.equal(map.size, 0);
});

test("groupByRoundIndex preserves input order within each bucket", () => {
  const rows = [
    { round_index: 0, id: "first" },
    { round_index: 0, id: "second" },
    { round_index: 0, id: "third" },
  ];
  const bucket = groupByRoundIndex(rows).get(0)!;
  assert.deepEqual(
    bucket.map((r) => r.id),
    ["first", "second", "third"],
  );
});

// ─── buildPayoutIndex ────────────────────────────────────────────────────────

test("buildPayoutIndex deduplicates and keeps the first payout per round", () => {
  const payouts = [
    { round_index: 0, recipient: "A", amount: "100", tx_hash: "tx0a", ledger: "10" },
    { round_index: 0, recipient: "B", amount: "100", tx_hash: "tx0b", ledger: "11" }, // duplicate
    { round_index: 1, recipient: "C", amount: "100", tx_hash: "tx1",  ledger: "20" },
  ];
  const idx = buildPayoutIndex(payouts);
  assert.equal(idx.size, 2);
  assert.equal(idx.get(0)!.tx_hash, "tx0a");
  assert.equal(idx.get(1)!.tx_hash, "tx1");
});

test("buildPayoutIndex returns empty map for empty input", () => {
  assert.equal(buildPayoutIndex([]).size, 0);
});

// ─── resolveStatus ───────────────────────────────────────────────────────────

test("resolveStatus: payout wins over current_round match", () => {
  assert.equal(
    resolveStatus(0, true, { current_round: 0, status: "Active" }),
    "completed",
  );
});

test("resolveStatus: active current_round with no payout → current", () => {
  assert.equal(
    resolveStatus(1, false, { current_round: 1, status: "Active" }),
    "current",
  );
});

test("resolveStatus: cancelled current_round with no payout → cancelled", () => {
  assert.equal(
    resolveStatus(2, false, { current_round: 2, status: "Cancelled" }),
    "cancelled",
  );
});

test("resolveStatus: non-current round with no payout → open", () => {
  assert.equal(
    resolveStatus(0, false, { current_round: 1, status: "Active" }),
    "open",
  );
});

test("resolveStatus: Pending circle non-current round → open", () => {
  assert.equal(
    resolveStatus(0, false, { current_round: 0, status: "Pending" }),
    "open",
  );
});

test("resolveStatus: Completed circle non-current round with no payout → open", () => {
  assert.equal(
    resolveStatus(3, false, { current_round: 3, status: "Completed" }),
    "open",
  );
});

// ─── groupCircleRounds — core cases ──────────────────────────────────────────

test("groupCircleRounds returns all-empty result for empty inputs on Pending circle", () => {
  const result = groupCircleRounds(
    { current_round: 0, status: "Pending" },
    [],
    [],
    [],
  );
  assert.equal(result.rounds.length, 0);
  assert.equal(result.currentRound, null);
  assert.equal(result.openRounds.length, 0);
  assert.equal(result.pendingDefaults.length, 0);
});

test("groupCircleRounds includes currentRound with no rows for Active circle", () => {
  const result = groupCircleRounds(
    { current_round: 0, status: "Active" },
    [],
    [],
    [],
  );
  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.roundIndex, 0);
  assert.equal(result.currentRound!.status, "current");
  assert.equal(result.currentRound!.contributions.length, 0);
  assert.equal(result.currentRound!.defaults.length, 0);
  assert.equal(result.rounds.length, 0);
  assert.equal(result.openRounds.length, 0);
});

test("groupCircleRounds nests contributions and defaults under completed payouts", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [
      {
        round_index: 0,
        recipient: "GREC",
        amount: "100",
        tx_hash: "tx0",
        ledger: "10",
      },
    ],
    [
      { round_index: 0, member_address: "M1" },
      { round_index: 0, member_address: "M2" },
      { round_index: 1, member_address: "M1" },
    ],
    [{ round_index: 0, member_address: "M3", penalty: "20" }],
  );

  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].status, "completed");
  assert.equal(result.rounds[0].recipient, "GREC");
  assert.equal(result.rounds[0].contributions.length, 2);
  assert.equal(result.rounds[0].defaults.length, 1);

  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.status, "current");
  assert.equal(result.currentRound!.roundIndex, 1);
  assert.equal(result.currentRound!.contributions.length, 1);
  assert.equal(result.currentRound!.recipient, null);

  assert.equal(result.openRounds.length, 0);
  assert.equal(result.pendingDefaults.length, 0);
});

test("groupCircleRounds surfaces unpaid non-current activity as openRounds", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [],
    [{ round_index: 0, member_address: "M1" }],
    [{ round_index: 0, member_address: "M2", penalty: "5" }],
  );

  assert.equal(result.rounds.length, 0);
  assert.equal(result.openRounds.length, 1);
  assert.equal(result.openRounds[0].roundIndex, 0);
  assert.equal(result.openRounds[0].status, "open");
  assert.equal(result.openRounds[0].contributions.length, 1);
  assert.equal(result.openRounds[0].defaults.length, 1);

  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.roundIndex, 1);
  assert.equal(result.pendingDefaults.length, 1);
});

test("groupCircleRounds marks cancelled current round without mixing into completed", () => {
  const result = groupCircleRounds(
    { current_round: 2, status: "Cancelled" },
    [
      {
        round_index: 0,
        recipient: "GREC",
        amount: "50",
        tx_hash: "tx0",
        ledger: "1",
      },
    ],
    [{ round_index: 2, member_address: "M1" }],
    [],
  );

  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].status, "completed");
  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.status, "cancelled");
  assert.equal(result.currentRound!.contributions.length, 1);
});

// ─── groupCircleRounds — deduplication ───────────────────────────────────────

test("groupCircleRounds deduplicates payout rows, keeps first", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [
      { round_index: 0, recipient: "ORIG", amount: "100", tx_hash: "txA", ledger: "10" },
      { round_index: 0, recipient: "DUP",  amount: "100", tx_hash: "txB", ledger: "11" },
    ],
    [],
    [],
  );
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].recipient, "ORIG");
  assert.equal(result.rounds[0].txHash, "txA");
});

test("groupCircleRounds includes each round_index exactly once with duplicate contributions", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [{ round_index: 0, recipient: "R", amount: "10", tx_hash: "tx", ledger: "5" }],
    [
      { round_index: 0, member_address: "M1" },
      { round_index: 0, member_address: "M1" }, // duplicate member row
    ],
    [],
  );
  // Round 0 should appear exactly once
  assert.equal(result.rounds.length, 1);
  // Both contribution rows are preserved (caller deduplicates by member if needed)
  assert.equal(result.rounds[0].contributions.length, 2);
});

// ─── groupCircleRounds — out-of-order ingestion ───────────────────────────────

test("groupCircleRounds handles out-of-order payout rows (rounds sorted ascending)", () => {
  const result = groupCircleRounds(
    { current_round: 3, status: "Active" },
    [
      { round_index: 2, recipient: "C", amount: "30", tx_hash: "tx2", ledger: "30" },
      { round_index: 0, recipient: "A", amount: "10", tx_hash: "tx0", ledger: "10" },
      { round_index: 1, recipient: "B", amount: "20", tx_hash: "tx1", ledger: "20" },
    ],
    [],
    [],
  );
  assert.equal(result.rounds.length, 3);
  assert.deepEqual(
    result.rounds.map((r) => r.roundIndex),
    [0, 1, 2],
  );
});

test("groupCircleRounds handles out-of-order contributions across multiple rounds", () => {
  const result = groupCircleRounds(
    { current_round: 2, status: "Active" },
    [
      { round_index: 0, recipient: "A", amount: "10", tx_hash: "tx0", ledger: "10" },
      { round_index: 1, recipient: "B", amount: "10", tx_hash: "tx1", ledger: "20" },
    ],
    [
      { round_index: 1, member_address: "M2" },
      { round_index: 0, member_address: "M1" },
      { round_index: 1, member_address: "M1" },
      { round_index: 0, member_address: "M2" },
    ],
    [],
  );
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0].roundIndex, 0);
  assert.equal(result.rounds[0].contributions.length, 2);
  assert.equal(result.rounds[1].roundIndex, 1);
  assert.equal(result.rounds[1].contributions.length, 2);
});

// ─── groupCircleRounds — partial / gap data ───────────────────────────────────

test("groupCircleRounds includes gap rounds (rounds with only defaults, no contributions)", () => {
  const result = groupCircleRounds(
    { current_round: 2, status: "Active" },
    [
      { round_index: 0, recipient: "A", amount: "10", tx_hash: "tx0", ledger: "5" },
    ],
    [],
    [
      { round_index: 0, member_address: "M2", penalty: "2" },
      { round_index: 1, member_address: "M1", penalty: "2" }, // round 1 has only a default
    ],
  );
  // round 0 completed
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].defaults.length, 1);
  // round 1 is open (has a default, no payout)
  assert.equal(result.openRounds.length, 1);
  assert.equal(result.openRounds[0].roundIndex, 1);
  assert.equal(result.openRounds[0].defaults.length, 1);
  // round 2 is current
  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.roundIndex, 2);
  // pending defaults = round 1 default
  assert.equal(result.pendingDefaults.length, 1);
  assert.equal(result.pendingDefaults[0].round_index, 1);
});

test("groupCircleRounds pendingDefaults excludes defaults that belong to completed rounds", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [{ round_index: 0, recipient: "A", amount: "10", tx_hash: "tx0", ledger: "5" }],
    [],
    [
      { round_index: 0, member_address: "M2", penalty: "2" }, // paid out
      { round_index: 1, member_address: "M1", penalty: "2" }, // pending
    ],
  );
  assert.equal(result.pendingDefaults.length, 1);
  assert.equal(result.pendingDefaults[0].round_index, 1);
});

test("groupCircleRounds handles Completed circle with no current round slot", () => {
  // A Completed circle — current_round does not get a slot injected.
  const result = groupCircleRounds(
    { current_round: 3, status: "Completed" },
    [
      { round_index: 0, recipient: "A", amount: "10", tx_hash: "tx0", ledger: "10" },
      { round_index: 1, recipient: "B", amount: "10", tx_hash: "tx1", ledger: "20" },
      { round_index: 2, recipient: "C", amount: "10", tx_hash: "tx2", ledger: "30" },
    ],
    [],
    [],
  );
  assert.equal(result.rounds.length, 3);
  assert.equal(result.currentRound, null);
  assert.equal(result.openRounds.length, 0);
});

test("groupCircleRounds handles Pending circle with partial contributions (noisy ingest)", () => {
  // Contributions recorded before circle went Active — should appear as openRounds.
  const result = groupCircleRounds(
    { current_round: 0, status: "Pending" },
    [],
    [{ round_index: 0, member_address: "M1" }],
    [],
  );
  assert.equal(result.rounds.length, 0);
  assert.equal(result.currentRound, null);
  assert.equal(result.openRounds.length, 1);
  assert.equal(result.openRounds[0].roundIndex, 0);
  assert.equal(result.openRounds[0].status, "open");
});

// ─── groupCircleRounds — openRounds sort order ────────────────────────────────

test("groupCircleRounds openRounds are sorted ascending by roundIndex", () => {
  const result = groupCircleRounds(
    { current_round: 5, status: "Active" },
    [],
    [
      { round_index: 3, member_address: "M1" },
      { round_index: 1, member_address: "M1" },
      { round_index: 2, member_address: "M1" },
    ],
    [],
  );
  assert.deepEqual(
    result.openRounds.map((r) => r.roundIndex),
    [1, 2, 3],
  );
});

// ─── groupCircleRounds — large input stability ───────────────────────────────

test("groupCircleRounds handles 50 completed rounds with mixed contributions and defaults", () => {
  const ROUNDS = 50;
  const payouts = Array.from({ length: ROUNDS }, (_, i) => ({
    round_index: i,
    recipient: `MEMBER_${i % 5}`,
    amount: "1000000",
    tx_hash: `tx${i}`,
    ledger: `${100 + i * 10}`,
  }));
  const contributions = Array.from({ length: ROUNDS * 3 }, (_, i) => ({
    round_index: Math.floor(i / 3),
    member_address: `M${i % 3}`,
  }));
  const defaults = Array.from({ length: ROUNDS }, (_, i) => ({
    round_index: i,
    member_address: `M3`,
    penalty: "200000",
  }));

  const result = groupCircleRounds(
    { current_round: ROUNDS, status: "Active" },
    payouts,
    contributions,
    defaults,
  );

  assert.equal(result.rounds.length, ROUNDS);
  assert.equal(result.currentRound!.roundIndex, ROUNDS);
  assert.equal(result.openRounds.length, 0);
  assert.equal(result.pendingDefaults.length, 0);

  // Verify sort order
  for (let i = 0; i < ROUNDS - 1; i++) {
    assert.ok(result.rounds[i].roundIndex < result.rounds[i + 1].roundIndex);
  }
});

// ─── groupCircleRounds — round status metadata (issue #529) ──────────────────
//
// The `status` field on every GroupedRound is what clients branch on to
// determine lifecycle phase without inferring it from the presence/absence of
// payout fields. These tests lock the invariants so a refactor cannot
// accidentally drop the field or produce an invalid value.

test("every completed round has status 'completed'", () => {
  const result = groupCircleRounds(
    { current_round: 2, status: "Active" },
    [
      { round_index: 0, recipient: "A", amount: "100", tx_hash: "tx0", ledger: "10" },
      { round_index: 1, recipient: "B", amount: "100", tx_hash: "tx1", ledger: "20" },
    ],
    [],
    [],
  );
  assert.equal(result.rounds.length, 2);
  for (const round of result.rounds) {
    assert.equal(round.status, "completed", `rounds[${round.roundIndex}].status must be "completed"`);
  }
});

test("current round for an Active circle has status 'current'", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [{ round_index: 0, recipient: "A", amount: "100", tx_hash: "tx0", ledger: "10" }],
    [{ round_index: 1, member_address: "M1" }],
    [],
  );
  assert.ok(result.currentRound, "currentRound must be present");
  assert.equal(result.currentRound!.status, "current");
  assert.equal(result.currentRound!.roundIndex, 1);
});

test("current round for a Cancelled circle has status 'cancelled'", () => {
  const result = groupCircleRounds(
    { current_round: 0, status: "Cancelled" },
    [],
    [],
    [],
  );
  assert.ok(result.currentRound, "currentRound must be present for Cancelled circle");
  assert.equal(result.currentRound!.status, "cancelled");
});

test("unpaid non-current rounds have status 'open'", () => {
  const result = groupCircleRounds(
    { current_round: 3, status: "Active" },
    [],
    [
      { round_index: 0, member_address: "M1" },
      { round_index: 1, member_address: "M1" },
      { round_index: 2, member_address: "M1" },
    ],
    [],
  );
  assert.equal(result.openRounds.length, 3);
  for (const round of result.openRounds) {
    assert.equal(round.status, "open", `openRounds[${round.roundIndex}].status must be "open"`);
  }
});

test("status field is present and a valid RoundStatus value on every round object", () => {
  const VALID_STATUSES = new Set(["completed", "current", "cancelled", "open"]);

  const result = groupCircleRounds(
    { current_round: 2, status: "Active" },
    [
      { round_index: 0, recipient: "A", amount: "10", tx_hash: "tx0", ledger: "5" },
    ],
    [
      { round_index: 1, member_address: "M1" },
      { round_index: 2, member_address: "M2" },
    ],
    [{ round_index: 1, member_address: "M2", penalty: "5" }],
  );

  const allRounds = [
    ...result.rounds,
    ...result.openRounds,
    ...(result.currentRound ? [result.currentRound] : []),
  ];

  assert.ok(allRounds.length > 0, "at least one round must be present");
  for (const round of allRounds) {
    assert.ok(
      "status" in round,
      `round ${round.roundIndex} is missing the status field`,
    );
    assert.ok(
      VALID_STATUSES.has(round.status),
      `round ${round.roundIndex} has invalid status "${round.status}"`,
    );
  }
});

test("payout winning over current_round cursor: paid-out current round has status 'completed' not 'current'", () => {
  // Edge case: the payout row arrives for the same round_index as current_round.
  // Payout presence must always win — the round is "completed", not "current".
  const result = groupCircleRounds(
    { current_round: 0, status: "Active" },
    [{ round_index: 0, recipient: "R", amount: "100", tx_hash: "txPaid", ledger: "50" }],
    [],
    [],
  );
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].status, "completed");
  // currentRound should be null since the only candidate was promoted to completed
  assert.equal(result.currentRound, null);
});
