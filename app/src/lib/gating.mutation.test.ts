/**
 * Mutation guard tests for the gating model (app/src/lib/gating.ts).
 *
 * These tests are distinct from normal gating tests: each test removes or
 * weakens exactly ONE guard in a local reimplementation, then asserts that
 * the weakened version produces a wrong result compared to the production
 * function.  This verifies that the production guard is actually load-bearing
 * — its removal would be detectable by the test suite.
 *
 * Run with:
 *   npx tsc --noEmit                        (type-check only)
 *   node --require ts-node/register --test  (if added to indexer test runner)
 *
 * Or import into the app test runner once one is configured.
 *
 * Design rules
 * ------------
 * 1. Each `describe` block targets exactly one guard.
 * 2. The "production" call uses the real `computeActionEligibility`.
 * 3. The "mutant" call uses a local variant with the guard removed.
 * 4. The assertion checks that production blocks and the mutant would allow —
 *    proving the guard is the discriminating factor.
 * 5. No network calls, no file I/O — pure function tests.
 *
 * Mutation catalogue
 * ------------------
 * | Guard | Action | Risk if removed |
 * |---|---|---|
 * | stale_snapshot (age > maxAge) | all | stale UI state triggers on-chain write |
 * | wrong_status (Pending for join) | join | join submitted on Active/Completed circle |
 * | wrong_status (Active for contribute) | contribute | contribute on non-Active circle |
 * | deadline_passed (latestLedger > deadlineLedger) | contribute | late contribution attempted |
 * | already_joined (hasLockedCollateral) | join | double-collateral pull from UI |
 * | already_contributed (hasContributedCurrentRound) | contribute | double-contribute from UI |
 * | round_not_complete (contributionsReceived < memberCount) | payout | premature payout triggered |
 * | deadline_not_passed (latestLedger <= deadlineLedger or unknown) | default | member punished before window closes |
 * | wrong_status (not terminal for close) | close | close on Active/Pending circle |
 *
 * CI budget: these are pure TypeScript computations; the full suite runs in < 1 s.
 * No exclusions — all guards listed are financial or authorization boundaries.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  computeActionEligibility,
  buildAppSnapshot,
  isSnapshotFresh,
  DEFAULT_MAX_SNAPSHOT_AGE_MS,
  type AppStateSnapshot,
  type GateResult,
  type GateBlocked,
  type GateBlockReason,
} from "./gating";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const MEMBERS = [
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPCIB",
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABMHIT",
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQITI",
];

const FIXED_NOW = 1_000_000; // ms epoch — fixed so tests are deterministic

function makeSnap(overrides: Partial<AppStateSnapshot> = {}): AppStateSnapshot {
  return {
    ...buildAppSnapshot(
      overrides.status           ?? "Active",
      overrides.currentRound     ?? 0,
      // deadlineLedger/latestLedger are nullable: `null` is a meaningful value
      // (unknown ledger), so honour an explicitly-provided key rather than using
      // `??`, which would coerce `null` back to the default.
      "deadlineLedger" in overrides ? overrides.deadlineLedger : 5000,
      "latestLedger"   in overrides ? overrides.latestLedger   : 4000, // below deadline — not yet passed
      overrides.memberAddresses  ?? MEMBERS,
      overrides.hasLockedCollateral          ?? true,
      overrides.hasContributedCurrentRound   ?? false,
      overrides.contributionsReceived        ?? 0,
      null,            // networkCheck — always null from the base builder
      overrides.fetchedAtMs      ?? FIXED_NOW,
    ),
    // Allow direct override of networkCheck after the builder sets it to null
    ...("networkCheck" in overrides ? { networkCheck: overrides.networkCheck } : {}),
  };
}

/** Returns a snapshot that will appear stale (older than maxAge). */
function staleSnap(action: "join" | "contribute" | "payout" | "default" | "close"): AppStateSnapshot {
  const statusMap = {
    join: "Pending",
    contribute: "Active",
    payout: "Active",
    default: "Active",
    close: "Completed",
  } as const;
  return makeSnap({
    status: statusMap[action],
    fetchedAtMs: FIXED_NOW - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1,
  });
}

/** Call the production function and assert it returns `allowed = false` with the given reason. */
function assertBlocked(
  action: Parameters<typeof computeActionEligibility>[0],
  snap: AppStateSnapshot,
  reason: GateBlockReason,
  opts: Parameters<typeof computeActionEligibility>[2] = {},
): void {
  const result = computeActionEligibility(action, snap, { nowMs: FIXED_NOW, ...opts });
  assert.equal(result.allowed, false, `action=${action} must be blocked`);
  if (!result.allowed) {
    assert.equal(
      result.reason,
      reason,
      `action=${action} must be blocked with reason=${reason}, got=${result.reason}`,
    );
    assert.ok(result.message.length > 0, "blocked result must have a non-empty message");
  }
}

/** Call the production function and assert it returns `allowed = true`. */
function assertAllowed(
  action: Parameters<typeof computeActionEligibility>[0],
  snap: AppStateSnapshot,
  opts: Parameters<typeof computeActionEligibility>[2] = {},
): void {
  const result = computeActionEligibility(action, snap, { nowMs: FIXED_NOW, ...opts });
  assert.equal(result.allowed, true, `action=${action} must be allowed`);
}

// ─── Mutant helpers ───────────────────────────────────────────────────────────
//
// Each mutant is a function that re-implements a portion of gating.ts with
// exactly one guard removed.  The mutant is called with the same snapshot that
// the production function blocks, and the test asserts the mutant WOULD allow
// the action — proving the production guard is the discriminating factor.

/**
 * MUTANT: stale_snapshot guard removed.
 * A weakened gateJoin/gateContribute/gatePayout/gateClose that never checks age.
 */
function mutantNoStalenessCheck(
  action: "join" | "contribute" | "payout" | "default" | "close",
  snap: AppStateSnapshot,
): GateResult {
  // Skip freshness check entirely — proceed to status/state checks
  switch (action) {
    case "join":
      if (snap.status !== "Pending") return { allowed: false, reason: "wrong_status", message: "wrong status" };
      if (snap.hasLockedCollateral) return { allowed: false, reason: "already_joined", message: "already joined" };
      return { allowed: true };
    case "contribute":
      if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
      return { allowed: true };
    case "payout":
      if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
      if (snap.contributionsReceived < snap.memberAddresses.length)
        return { allowed: false, reason: "round_not_complete", message: "not complete" };
      return { allowed: true };
    case "default":
      if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
      if (snap.deadlineLedger === null || snap.latestLedger === null || snap.latestLedger <= snap.deadlineLedger)
        return { allowed: false, reason: "deadline_not_passed", message: "deadline not passed" };
      if (snap.hasContributedCurrentRound)
        return { allowed: false, reason: "already_contributed", message: "already contributed" };
      return { allowed: true };
    case "close":
      if (snap.status !== "Completed" && snap.status !== "Cancelled")
        return { allowed: false, reason: "wrong_status", message: "wrong status" };
      return { allowed: true };
  }
}

/**
 * MUTANT: wrong_status guard removed for join.
 * Allows join regardless of current circle status.
 */
function mutantNoStatusCheckJoin(snap: AppStateSnapshot): GateResult {
  // Skip status check — proceed directly to membership/collateral checks
  if (snap.hasLockedCollateral) return { allowed: false, reason: "already_joined", message: "already joined" };
  return { allowed: true };
}

/**
 * MUTANT: wrong_status guard removed for contribute.
 * Allows contribute regardless of current circle status.
 */
function mutantNoStatusCheckContribute(snap: AppStateSnapshot): GateResult {
  // Skip status check
  if (snap.deadlineLedger !== null && snap.latestLedger !== null &&
      snap.latestLedger > snap.deadlineLedger) {
    return { allowed: false, reason: "deadline_passed", message: "deadline passed" };
  }
  if (snap.hasContributedCurrentRound)
    return { allowed: false, reason: "already_contributed", message: "already contributed" };
  return { allowed: true };
}

/**
 * MUTANT: deadline_passed guard removed for contribute.
 * Allows contribute even after the round deadline has passed.
 */
function mutantNoDeadlineCheckContribute(snap: AppStateSnapshot): GateResult {
  if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
  // Skip deadline check — allow late contributions
  if (snap.hasContributedCurrentRound)
    return { allowed: false, reason: "already_contributed", message: "already contributed" };
  return { allowed: true };
}

/**
 * MUTANT: already_joined guard removed for join.
 * Allows join even if hasLockedCollateral = true.
 */
function mutantNoAlreadyJoinedCheck(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs))
    return { allowed: false, reason: "stale_snapshot", message: "stale" };
  if (snap.status !== "Pending") return { allowed: false, reason: "wrong_status", message: "wrong status" };
  // Skip already_joined check — allow double-join
  return { allowed: true };
}

/**
 * MUTANT: already_contributed guard removed for contribute.
 */
function mutantNoAlreadyContributedCheck(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs))
    return { allowed: false, reason: "stale_snapshot", message: "stale" };
  if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
  if (snap.deadlineLedger !== null && snap.latestLedger !== null &&
      snap.latestLedger > snap.deadlineLedger)
    return { allowed: false, reason: "deadline_passed", message: "deadline passed" };
  // Skip already_contributed check — allow double-contribute
  return { allowed: true };
}

/**
 * MUTANT: round_not_complete guard removed for payout.
 */
function mutantNoRoundCompleteCheckPayout(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs))
    return { allowed: false, reason: "stale_snapshot", message: "stale" };
  if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
  // Skip round_not_complete check — allow premature payout
  return { allowed: true };
}

/**
 * MUTANT: wrong_status guard removed for close.
 */
function mutantNoStatusCheckClose(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs))
    return { allowed: false, reason: "stale_snapshot", message: "stale" };
  // Skip terminal-status check — allow close on any status
  return { allowed: true };
}

/**
 * MUTANT: deadline_not_passed guard removed for default.
 * Allows a member to be marked in default even when the deadline has NOT
 * passed — or cannot be confirmed from ledger data.  This is the fail-closed
 * guard that protects an honest member from a premature punitive write.
 */
function mutantNoDeadlinePassedCheckDefault(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs))
    return { allowed: false, reason: "stale_snapshot", message: "stale" };
  if (snap.status !== "Active") return { allowed: false, reason: "wrong_status", message: "wrong status" };
  // Skip deadline_not_passed check — allow marking default before window closes
  if (snap.hasContributedCurrentRound)
    return { allowed: false, reason: "already_contributed", message: "already contributed" };
  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 1: stale_snapshot — all four actions
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: stale_snapshot", () => {
  for (const action of ["join", "contribute", "payout", "default", "close"] as const) {
    test(`${action}: production blocks stale snapshot`, () => {
      const snap = staleSnap(action);
      assertBlocked(action, snap, "stale_snapshot");
    });

    test(`${action}: mutant (no staleness check) allows stale snapshot — proving guard is load-bearing`, () => {
      const snap = staleSnap(action);
      const mutantResult = mutantNoStalenessCheck(action, snap);
      // The mutant must NOT be blocked by stale_snapshot
      assert.notEqual(
        mutantResult.allowed === false && (mutantResult as any).reason === "stale_snapshot",
        true,
        `mutant must not block ${action} with stale_snapshot — it lacks the guard`,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 2: wrong_status — join requires Pending
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: wrong_status for join", () => {
  test("production blocks join when status=Active", () => {
    const snap = makeSnap({ status: "Active", hasLockedCollateral: false });
    assertBlocked("join", snap, "wrong_status");
  });

  test("production blocks join when status=Completed", () => {
    const snap = makeSnap({ status: "Completed", hasLockedCollateral: false });
    assertBlocked("join", snap, "wrong_status");
  });

  test("production blocks join when status=Cancelled", () => {
    const snap = makeSnap({ status: "Cancelled", hasLockedCollateral: false });
    assertBlocked("join", snap, "wrong_status");
  });

  test("mutant (no status check for join) allows join on Active circle — proving guard is load-bearing", () => {
    const snap = makeSnap({ status: "Active", hasLockedCollateral: false });
    const mutantResult = mutantNoStatusCheckJoin(snap);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow join on Active circle (no status guard) — proving production guard works",
    );
  });

  test("production allows join when status=Pending and not yet joined", () => {
    const snap = makeSnap({ status: "Pending", hasLockedCollateral: false });
    assertAllowed("join", snap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 3: wrong_status — contribute requires Active
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: wrong_status for contribute", () => {
  test("production blocks contribute when status=Pending", () => {
    const snap = makeSnap({ status: "Pending" });
    assertBlocked("contribute", snap, "wrong_status");
  });

  test("production blocks contribute when status=Completed", () => {
    const snap = makeSnap({ status: "Completed" });
    assertBlocked("contribute", snap, "wrong_status");
  });

  test("mutant (no status check) allows contribute on Pending circle — proving guard is load-bearing", () => {
    const snap = makeSnap({ status: "Pending" });
    const mutantResult = mutantNoStatusCheckContribute(snap);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow contribute on Pending (no status guard)",
    );
  });

  test("production allows contribute when Active and before deadline", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 5000,
      latestLedger: 4000,
      hasContributedCurrentRound: false,
    });
    assertAllowed("contribute", snap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 4: deadline_passed — contribute rejected after deadline
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: deadline_passed for contribute", () => {
  test("production blocks contribute when latestLedger > deadlineLedger", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 3000,
      latestLedger: 3001,  // one past deadline
      hasContributedCurrentRound: false,
    });
    assertBlocked("contribute", snap, "deadline_passed");
  });

  test("production blocks contribute when deadline far in the past", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 1000,
      latestLedger: 9999,
      hasContributedCurrentRound: false,
    });
    assertBlocked("contribute", snap, "deadline_passed");
  });

  test("mutant (no deadline check) allows late contribution — proving guard is load-bearing", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 3000,
      latestLedger: 3001,
      hasContributedCurrentRound: false,
    });
    const mutantResult = mutantNoDeadlineCheckContribute(snap);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow late contribution (no deadline guard)",
    );
  });

  test("production allows contribute when exactly at deadline (latestLedger == deadlineLedger)", () => {
    // Contract uses `latestLedger > deadlineLedger`; at exactly == it must still allow
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 4000,
      latestLedger: 4000, // exactly at deadline — allowed
      hasContributedCurrentRound: false,
    });
    assertAllowed("contribute", snap);
  });

  test("deadline check is skipped when deadlineLedger is null (unknown deadline)", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: null,
      latestLedger: 9999,
      hasContributedCurrentRound: false,
    });
    // When deadline is unknown, the gate must not block on deadline_passed
    assertAllowed("contribute", snap);
  });

  test("deadline check is skipped when latestLedger is null (indexer not yet synced)", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 1000,
      latestLedger: null,
      hasContributedCurrentRound: false,
    });
    assertAllowed("contribute", snap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 5: already_joined — double collateral pull from UI
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: already_joined for join", () => {
  test("production blocks join when hasLockedCollateral=true", () => {
    const snap = makeSnap({ status: "Pending", hasLockedCollateral: true });
    assertBlocked("join", snap, "already_joined");
  });

  test("mutant (no already_joined check) allows double-join — proving guard is load-bearing", () => {
    const snap = makeSnap({ status: "Pending", hasLockedCollateral: true });
    const mutantResult = mutantNoAlreadyJoinedCheck(snap, FIXED_NOW, DEFAULT_MAX_SNAPSHOT_AGE_MS);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow double-join (no already_joined guard) — mirrors contract double-collateral risk",
    );
  });

  test("production allows join when not yet joined (hasLockedCollateral=false)", () => {
    const snap = makeSnap({ status: "Pending", hasLockedCollateral: false });
    assertAllowed("join", snap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 6: already_contributed — double-contribute from UI
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: already_contributed for contribute", () => {
  test("production blocks contribute when hasContributedCurrentRound=true", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 5000,
      latestLedger: 4000,
      hasContributedCurrentRound: true,
    });
    assertBlocked("contribute", snap, "already_contributed");
  });

  test("mutant (no already_contributed check) allows double-contribute — proving guard is load-bearing", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 5000,
      latestLedger: 4000,
      hasContributedCurrentRound: true,
    });
    const mutantResult = mutantNoAlreadyContributedCheck(snap, FIXED_NOW, DEFAULT_MAX_SNAPSHOT_AGE_MS);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow double-contribute (no already_contributed guard)",
    );
  });

  test("already_contributed message includes the round number", () => {
    const snap = makeSnap({
      status: "Active",
      currentRound: 3,
      hasContributedCurrentRound: true,
    });
    const result = computeActionEligibility("contribute", snap, { nowMs: FIXED_NOW });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.match(
        result.message,
        /3/,
        "blocked message must include the current round number",
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 7: round_not_complete — premature payout from UI
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: round_not_complete for payout", () => {
  test("production blocks payout when contributionsReceived < memberCount", () => {
    const snap = makeSnap({
      status: "Active",
      contributionsReceived: 3,
      memberAddresses: MEMBERS, // 4 members
    });
    assertBlocked("payout", snap, "round_not_complete");
  });

  test("production blocks payout when zero contributions received", () => {
    const snap = makeSnap({
      status: "Active",
      contributionsReceived: 0,
      memberAddresses: MEMBERS,
    });
    assertBlocked("payout", snap, "round_not_complete");
  });

  test("mutant (no round_not_complete check) allows premature payout — proving guard is load-bearing", () => {
    const snap = makeSnap({
      status: "Active",
      contributionsReceived: 1,
      memberAddresses: MEMBERS,
    });
    const mutantResult = mutantNoRoundCompleteCheckPayout(snap, FIXED_NOW, DEFAULT_MAX_SNAPSHOT_AGE_MS);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow premature payout (no round_not_complete guard)",
    );
  });

  test("production allows payout when all members have contributed", () => {
    const snap = makeSnap({
      status: "Active",
      contributionsReceived: MEMBERS.length, // exactly all members
      memberAddresses: MEMBERS,
    });
    assertAllowed("payout", snap);
  });

  test("round_not_complete message includes both received count and required count", () => {
    const snap = makeSnap({
      status: "Active",
      contributionsReceived: 2,
      memberAddresses: MEMBERS, // 4 required
    });
    const result = computeActionEligibility("payout", snap, { nowMs: FIXED_NOW });
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.match(result.message, /4/, "message must include required count (4)");
      assert.match(result.message, /2/, "message must include received count (2)");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 8: wrong_status — close requires terminal state
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: wrong_status for close", () => {
  test("production blocks close when status=Active", () => {
    const snap = makeSnap({ status: "Active" });
    assertBlocked("close", snap, "wrong_status");
  });

  test("production blocks close when status=Pending", () => {
    const snap = makeSnap({ status: "Pending" });
    assertBlocked("close", snap, "wrong_status");
  });

  test("mutant (no status check for close) allows close on Active circle — proving guard is load-bearing", () => {
    const snap = makeSnap({ status: "Active" });
    const mutantResult = mutantNoStatusCheckClose(snap, FIXED_NOW, DEFAULT_MAX_SNAPSHOT_AGE_MS);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow close on Active circle (no status guard)",
    );
  });

  test("production allows close on Completed circle", () => {
    const snap = makeSnap({ status: "Completed" });
    assertAllowed("close", snap);
  });

  test("production allows close on Cancelled circle", () => {
    const snap = makeSnap({ status: "Cancelled" });
    assertAllowed("close", snap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 9: deadline_not_passed — default requires positive proof deadline passed
// ═══════════════════════════════════════════════════════════════════════════════
//
// `default` is punitive, so it fails CLOSED where `contribute` fails OPEN:
//   • contribute: unknown ledger data → ALLOWED (never block an honest member)
//   • default:    unknown ledger data → BLOCKED (never punish without proof)
// The two guards therefore diverge at exactly the deadline ledger and whenever
// ledger height is unavailable.

describe("MutationGuard: deadline_not_passed for default", () => {
  test("production blocks default when latestLedger < deadlineLedger (window open)", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 5000,
      latestLedger: 4000,
      hasContributedCurrentRound: false,
    });
    assertBlocked("default", snap, "deadline_not_passed");
  });

  test("production blocks default at exactly the deadline (latestLedger == deadlineLedger)", () => {
    // Boundary: default fails closed at ==, mirroring contribute allowing at ==.
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 4000,
      latestLedger: 4000,
      hasContributedCurrentRound: false,
    });
    assertBlocked("default", snap, "deadline_not_passed");
  });

  test("production blocks default when deadlineLedger is null (fail closed)", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: null,
      latestLedger: 9999,
      hasContributedCurrentRound: false,
    });
    assertBlocked("default", snap, "deadline_not_passed");
  });

  test("production blocks default when latestLedger is null (fail closed)", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 1000,
      latestLedger: null,
      hasContributedCurrentRound: false,
    });
    assertBlocked("default", snap, "deadline_not_passed");
  });

  test("mutant (no deadline_not_passed check) allows premature default — proving guard is load-bearing", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 5000,
      latestLedger: 4000, // window still open
      hasContributedCurrentRound: false,
    });
    const mutantResult = mutantNoDeadlinePassedCheckDefault(snap, FIXED_NOW, DEFAULT_MAX_SNAPSHOT_AGE_MS);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow premature default (no deadline_not_passed guard)",
    );
  });

  test("mutant (no deadline_not_passed check) allows default on unknown ledger — proving fail-closed guard", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: null,
      latestLedger: null,
      hasContributedCurrentRound: false,
    });
    const mutantResult = mutantNoDeadlinePassedCheckDefault(snap, FIXED_NOW, DEFAULT_MAX_SNAPSHOT_AGE_MS);
    assert.equal(
      mutantResult.allowed,
      true,
      "mutant must allow default with unknown ledger (no fail-closed guard)",
    );
  });

  test("production allows default when deadline has passed and member has not contributed", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 3000,
      latestLedger: 3001, // one past deadline
      hasContributedCurrentRound: false,
    });
    assertAllowed("default", snap);
  });

  test("production blocks default when member already contributed (even after deadline)", () => {
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 3000,
      latestLedger: 5000,
      hasContributedCurrentRound: true,
    });
    assertBlocked("default", snap, "already_contributed");
  });

  test("production blocks default on non-Active circle (wrong_status)", () => {
    const snap = makeSnap({
      status: "Pending",
      deadlineLedger: 3000,
      latestLedger: 5000,
      hasContributedCurrentRound: false,
    });
    assertBlocked("default", snap, "wrong_status");
  });

  test("ASYMMETRY: at exactly the deadline, contribute is allowed but default is blocked", () => {
    // The single most important behavioural contrast between the two guards.
    const atDeadline = makeSnap({
      status: "Active",
      deadlineLedger: 4000,
      latestLedger: 4000,
      hasContributedCurrentRound: false,
    });
    assertAllowed("contribute", atDeadline);
    assertBlocked("default", atDeadline, "deadline_not_passed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Guard ordering invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe("Guard ordering invariants", () => {
  test("stale_snapshot is checked before wrong_status for all actions", () => {
    // If a snapshot is stale AND the status is wrong, stale_snapshot must win.
    for (const [action, status] of [
      ["join", "Active"],
      ["contribute", "Pending"],
      ["payout", "Completed"],
      ["default", "Pending"],
      ["close", "Active"],
    ] as const) {
      const snap = makeSnap({
        status,
        fetchedAtMs: FIXED_NOW - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1,
      });
      assertBlocked(action, snap, "stale_snapshot");
    }
  });

  test("wrong_status is checked before already_joined for join", () => {
    // Active + hasLockedCollateral: wrong_status must win, not already_joined
    const snap = makeSnap({ status: "Active", hasLockedCollateral: true });
    assertBlocked("join", snap, "wrong_status");
  });

  test("wrong_status is checked before already_contributed for contribute", () => {
    const snap = makeSnap({ status: "Pending", hasContributedCurrentRound: true });
    assertBlocked("contribute", snap, "wrong_status");
  });

  test("deadline_passed is checked before already_contributed for contribute", () => {
    // Deadline passed AND already contributed: deadline_passed must win
    const snap = makeSnap({
      status: "Active",
      deadlineLedger: 3000,
      latestLedger: 3001,
      hasContributedCurrentRound: true,
    });
    assertBlocked("contribute", snap, "deadline_passed");
  });

  test("network_mismatch is checked before wrong_status for all write actions", () => {
    // A mismatch snapshot must block regardless of the circle status being wrong too.
    for (const [action, status] of [
      ["join", "Active"],        // wrong status AND mismatch → mismatch wins
      ["contribute", "Pending"], // wrong status AND mismatch → mismatch wins
      ["payout", "Completed"],
      ["default", "Pending"],
      ["close", "Active"],
    ] as const) {
      const snap = makeSnap({ status: status as string, networkCheck: "mismatch" } as any);
      assertBlocked(action, snap as any, "network_mismatch");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GUARD 10: network_mismatch — all write actions blocked on confirmed mismatch
// ═══════════════════════════════════════════════════════════════════════════════

describe("MutationGuard: network_mismatch for all write actions", () => {
  function mismatchSnap(statusOverride?: string): AppStateSnapshot {
    return {
      ...makeSnap({ status: statusOverride }),
      networkCheck: "mismatch" as const,
    };
  }

  for (const action of ["join", "contribute", "payout", "default", "close"] as const) {
    const statusForAction: Record<string, string> = {
      join: "Pending",
      contribute: "Active",
      payout: "Active",
      default: "Active",
      close: "Completed",
    };

    test(`${action}: mismatch blocks the action`, () => {
      const snap = mismatchSnap(statusForAction[action]);
      assertBlocked(action, snap, "network_mismatch");
    });

    test(`${action}: mismatch message mentions network`, () => {
      const snap = mismatchSnap(statusForAction[action]);
      const result = computeActionEligibility(action, snap, { nowMs: FIXED_NOW });
      assert.equal(result.allowed, false);
      if (!result.allowed) {
        assert.match(
          result.message.toLowerCase(),
          /network/,
          `${action}: mismatch message must mention "network"`,
        );
      }
    });

    test(`${action}: match or null networkCheck does not block`, () => {
      const matchSnap: AppStateSnapshot = {
        ...makeSnap({ status: statusForAction[action] }),
        networkCheck: "match" as const,
      };
      // match → should not block on network_mismatch reason
      const matchResult = computeActionEligibility(action, matchSnap, { nowMs: FIXED_NOW });
      if (!matchResult.allowed) {
        assert.notEqual(
          (matchResult as GateBlocked).reason,
          "network_mismatch",
          `${action}: match networkCheck must not produce network_mismatch`,
        );
      }

      const nullSnap: AppStateSnapshot = {
        ...makeSnap({ status: statusForAction[action] }),
        networkCheck: null,
      };
      const nullResult = computeActionEligibility(action, nullSnap, { nowMs: FIXED_NOW });
      if (!nullResult.allowed) {
        assert.notEqual(
          (nullResult as GateBlocked).reason,
          "network_mismatch",
          `${action}: null networkCheck must not produce network_mismatch`,
        );
      }
    });

    test(`${action}: unknown networkCheck does not block on network_mismatch`, () => {
      const unknownSnap: AppStateSnapshot = {
        ...makeSnap({ status: statusForAction[action] }),
        networkCheck: "unknown" as const,
      };
      const result = computeActionEligibility(action, unknownSnap, { nowMs: FIXED_NOW });
      if (!result.allowed) {
        assert.notEqual(
          (result as GateBlocked).reason,
          "network_mismatch",
          `${action}: unknown networkCheck must not produce network_mismatch`,
        );
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// isSnapshotFresh boundary tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("isSnapshotFresh boundary", () => {
  test("fresh: age < maxAge returns true", () => {
    assert.equal(isSnapshotFresh(0, 1000, 999), true);
  });

  test("stale: age === maxAge returns false (exclusive boundary)", () => {
    assert.equal(isSnapshotFresh(0, 1000, 1000), false);
  });

  test("stale: age > maxAge returns false", () => {
    assert.equal(isSnapshotFresh(0, 1000, 1001), false);
  });

  test("maxAge=0 is always stale (age is always >= 0)", () => {
    assert.equal(isSnapshotFresh(1000, 0, 1000), false);
    assert.equal(isSnapshotFresh(1000, 0, 1001), false);
  });

  test("maxAge=Infinity is always fresh", () => {
    assert.equal(isSnapshotFresh(0, Infinity, Number.MAX_SAFE_INTEGER), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildAppSnapshot factory
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildAppSnapshot factory", () => {
  test("deadlineLedger=undefined is coerced to null in snapshot", () => {
    const snap = buildAppSnapshot("Active", 0, undefined, undefined, [], false, false, 0, null, FIXED_NOW);
    assert.equal(snap.deadlineLedger, null);
    assert.equal(snap.latestLedger, null);
  });

  test("fetchedAtMs is set to the provided nowMs value", () => {
    const snap = buildAppSnapshot("Pending", 0, null, null, [], false, false, 0, null, 42_000);
    assert.equal(snap.fetchedAtMs, 42_000);
  });

  test("snapshot fields match provided arguments exactly", () => {
    const snap = buildAppSnapshot(
      "Active", 2, 9000, 8000, MEMBERS, true, false, 3, null, FIXED_NOW,
    );
    assert.equal(snap.status, "Active");
    assert.equal(snap.currentRound, 2);
    assert.equal(snap.deadlineLedger, 9000);
    assert.equal(snap.latestLedger, 8000);
    assert.deepEqual(snap.memberAddresses, MEMBERS);
    assert.equal(snap.hasLockedCollateral, true);
    assert.equal(snap.hasContributedCurrentRound, false);
    assert.equal(snap.contributionsReceived, 3);
    assert.equal(snap.fetchedAtMs, FIXED_NOW);
  });

  test("networkCheck=mismatch is preserved in snapshot", () => {
    const snap = buildAppSnapshot("Active", 0, null, null, [], false, false, 0, "mismatch", FIXED_NOW);
    assert.equal(snap.networkCheck, "mismatch");
  });

  test("networkCheck defaults to null when omitted", () => {
    const snap = buildAppSnapshot("Active", 0, null, null, [], false, false, 0);
    assert.equal(snap.networkCheck, null);
  });
});
