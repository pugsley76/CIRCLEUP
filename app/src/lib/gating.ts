/**
 * Canonical action-gating model for the CircleUp app.
 *
 * Before any contract write (join, contribute, payout, default, close) is
 * submitted, the action must pass a deterministic gate check against a fresh
 * state snapshot.  This prevents stale UI state from causing invalid on-chain
 * writes.
 *
 * This module is pure: no RPC calls, no I/O.  It takes a {@link AppStateSnapshot}
 * (built from the indexer data already loaded in the component) and returns a
 * {@link GateResult} the caller acts on synchronously.
 *
 * Mirror of sdk/src/gating.ts — kept in sync manually because the app does
 * not take a direct dependency on the @circleup/sdk package.
 *
 * Status checks use the canonical lifecycle model from lifecycle.ts.
 */

import {
  isActiveStatus,
  isPendingStatus,
  isTerminalStatus,
  type CircleLifecycleStatus,
} from "./lifecycle";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default maximum age (ms) for a state snapshot before action-gating blocks
 * any write.  30 s is conservative enough to absorb a slow render cycle while
 * tight enough to catch a missed payout or default event.
 */
export const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The contract writes that require state-based gating.
 *
 * `default` marks a member who missed the current round's contribution
 * deadline. Unlike `contribute` (which fails *open* on unknown ledger data so
 * an honest member is never blocked), `default` fails *closed*: it requires
 * positive proof the deadline has passed before allowing a punitive write.
 */
export type CircleAction = "join" | "contribute" | "payout" | "default" | "close";

/**
 * The network state as seen by the app at snapshot time.
 *
 * | Value | Meaning |
 * |-------|---------|
 * | `"match"`    | Provider passphrase matches the app's configured passphrase — writes are safe. |
 * | `"mismatch"` | Provider is on a different network — all writes must be blocked. |
 * | `"unknown"`  | Network could not be confirmed (provider error or unsupported). |
 * | `null`       | Network check has not run yet (provider not yet connected). |
 *
 * A `"mismatch"` value blocks every write action regardless of all other gate
 * conditions.  `"unknown"` and `null` are treated as benefit-of-the-doubt so
 * users on wallets that cannot report the network are not permanently locked out.
 * The primary transaction-rejection mechanism is the on-chain network passphrase
 * check; this gate is an early-warning layer that prevents a frustrating
 * "transaction failed" message after a user has already signed.
 */
export type NetworkCheckState = "match" | "mismatch" | "unknown" | null;

/**
 * Snapshot of the circle state as seen by the app at a specific point in time.
 * Built from the indexer response already present in component state — no extra
 * RPC call is needed.
 */
export interface AppStateSnapshot {
  /** Circle lifecycle status at fetch time. */
  readonly status: string;
  /** Current round index (0-based). */
  readonly currentRound: number;
  /** Deadline ledger for the current active round (null = unknown). */
  readonly deadlineLedger: number | null;
  /** Latest ledger the indexer has processed (null = unknown). */
  readonly latestLedger: number | null;
  /** Member addresses configured in this circle. */
  readonly memberAddresses: string[];
  /** Whether the acting wallet has already locked collateral (joined). */
  readonly hasLockedCollateral: boolean;
  /** Whether the acting wallet has already contributed to the current round. */
  readonly hasContributedCurrentRound: boolean;
  /** Number of contributions received in the current round (from indexer). */
  readonly contributionsReceived: number;
  /**
   * Result of the most recent network-mismatch check.
   *
   * `"mismatch"` blocks all write actions — the wallet is on a different
   * Stellar network from the one the app was configured for.  `null` means
   * the check has not run yet (e.g. the wallet has just connected); this is
   * treated as non-blocking.  See {@link NetworkCheckState} for the full set
   * of values and their semantics.
   */
  readonly networkCheck: NetworkCheckState;
  /** Wall-clock ms when this snapshot was constructed. */
  readonly fetchedAtMs: number;
}

/** Gate allowed — action may proceed. */
export interface GateAllowed {
  readonly allowed: true;
}

/** Gate blocked — action must not proceed. */
export interface GateBlocked {
  readonly allowed: false;
  /** Machine-readable block reason for programmatic branching. */
  readonly reason: GateBlockReason;
  /** Human-readable message suitable for display in a UI error toast. */
  readonly message: string;
}

export type GateResult = GateAllowed | GateBlocked;

export type GateBlockReason =
  | "stale_snapshot"
  | "wrong_status"
  | "not_a_member"
  | "already_joined"
  | "already_contributed"
  | "deadline_passed"
  | "deadline_not_passed"
  | "round_not_complete"
  | "no_active_round"
  | "network_mismatch";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function allowed(): GateAllowed {
  return { allowed: true };
}

function blocked(reason: GateBlockReason, message: string): GateBlocked {
  return { allowed: false, reason, message };
}

/**
 * Returns true when `snapshot` is younger than `maxAgeMs` milliseconds.
 * The boundary is exclusive: age === maxAgeMs is already stale.
 */
export function isSnapshotFresh(
  fetchedAtMs: number,
  maxAgeMs: number = DEFAULT_MAX_SNAPSHOT_AGE_MS,
  nowMs: number = Date.now(),
): boolean {
  if (maxAgeMs === Infinity) return true;
  return nowMs - fetchedAtMs < maxAgeMs;
}

/**
 * Returns a {@link GateBlocked} result when the snapshot's `networkCheck`
 * field records a confirmed mismatch, or `null` if the network is fine (or
 * unknown — benefit of the doubt).
 *
 * This is checked as the **second** gate after staleness, before any
 * action-specific logic, so a wallet-on-wrong-network never reaches the
 * contract regardless of what action the user is trying to perform.
 */
function checkNetworkGate(snap: AppStateSnapshot): GateBlocked | null {
  if (snap.networkCheck === "mismatch") {
    return blocked(
      "network_mismatch",
      "Your wallet is connected to a different Stellar network than this app. " +
        "Switch your wallet to the correct network to enable transactions.",
    );
  }
  return null;
}

// ─── Per-action gate logic ────────────────────────────────────────────────────

function gateJoin(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle data is ${nowMs - snap.fetchedAtMs}ms old. Refresh the page before joining.`,
    );
  }
  const netGate = checkNetworkGate(snap);
  if (netGate) return netGate;
  if (!isPendingStatus(snap.status)) {
    return blocked(
      "wrong_status",
      `Join is only available while the circle is Pending. Current status: ${snap.status}.`,
    );
  }
  if (snap.hasLockedCollateral) {
    return blocked(
      "already_joined",
      "You have already locked collateral for this circle.",
    );
  }
  return allowed();
}

function gateContribute(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle data is ${nowMs - snap.fetchedAtMs}ms old. Refresh the page before contributing.`,
    );
  }
  const netGate = checkNetworkGate(snap);
  if (netGate) return netGate;
  if (!isActiveStatus(snap.status)) {
    return blocked(
      "wrong_status",
      `Contribute is only available on an Active circle. Current status: ${snap.status}.`,
    );
  }
  // Deadline check when ledger data is available
  if (snap.deadlineLedger !== null && snap.latestLedger !== null) {
    if (snap.latestLedger > snap.deadlineLedger) {
      return blocked(
        "deadline_passed",
        `Round ${snap.currentRound} deadline has passed (deadline ledger ${snap.deadlineLedger}, ` +
          `latest ledger ${snap.latestLedger}). You cannot contribute after the deadline.`,
      );
    }
  }
  if (snap.hasContributedCurrentRound) {
    return blocked(
      "already_contributed",
      `You have already contributed to round ${snap.currentRound}.`,
    );
  }
  return allowed();
}

function gatePayout(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle data is ${nowMs - snap.fetchedAtMs}ms old. Refresh the page before triggering payout.`,
    );
  }
  const netGate = checkNetworkGate(snap);
  if (netGate) return netGate;
  if (!isActiveStatus(snap.status)) {
    return blocked(
      "wrong_status",
      `Payout is only available on an Active circle. Current status: ${snap.status}.`,
    );
  }
  if (snap.contributionsReceived < snap.memberAddresses.length) {
    return blocked(
      "round_not_complete",
      `Payout requires all ${snap.memberAddresses.length} members to contribute; ` +
        `${snap.contributionsReceived} received so far in round ${snap.currentRound}.`,
    );
  }
  return allowed();
}

function gateDefault(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle data is ${nowMs - snap.fetchedAtMs}ms old. Refresh the page before marking a default.`,
    );
  }
  const netGate = checkNetworkGate(snap);
  if (netGate) return netGate;
  if (!isActiveStatus(snap.status)) {
    return blocked(
      "wrong_status",
      `Default can only be marked on an Active circle. Current status: ${snap.status}.`,
    );
  }
  // Fail closed: a punitive action requires positive proof the deadline
  // passed. Unlike gateContribute (which allows when ledger data is missing),
  // any unknown ledger height blocks the default.
  if (snap.deadlineLedger === null || snap.latestLedger === null) {
    return blocked(
      "deadline_not_passed",
      `Cannot verify that round ${snap.currentRound} deadline has passed: ledger data is ` +
        "unavailable. Refusing to mark a default without confirmed ledger height.",
    );
  }
  if (snap.latestLedger <= snap.deadlineLedger) {
    return blocked(
      "deadline_not_passed",
      `Round ${snap.currentRound} deadline is ledger ${snap.deadlineLedger}; latest indexed ` +
        `ledger is ${snap.latestLedger}. The contribution window is still open.`,
    );
  }
  if (snap.hasContributedCurrentRound) {
    return blocked(
      "already_contributed",
      `This member already contributed to round ${snap.currentRound}; they cannot be marked in default.`,
    );
  }
  return allowed();
}

function gateClose(snap: AppStateSnapshot, nowMs: number, maxAge: number): GateResult {
  if (!isSnapshotFresh(snap.fetchedAtMs, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle data is ${nowMs - snap.fetchedAtMs}ms old. Refresh the page before closing.`,
    );
  }
  const netGate = checkNetworkGate(snap);
  if (netGate) return netGate;
  if (!isTerminalStatus(snap.status) && snap.status !== "Closed") {
    return blocked(
      "wrong_status",
      `Close is only available on a Completed or Cancelled circle. Current status: ${snap.status}.`,
    );
  }
  return allowed();
}

// ─── Primary export ───────────────────────────────────────────────────────────

/**
 * Evaluate whether a contract action is safe to submit given the current
 * app-side state snapshot.
 *
 * This is the single authoritative gating function for the app layer.  Every
 * path that can produce a write transaction must call this and honour a
 * {@link GateBlocked} result by aborting the transaction and showing the
 * human-readable `message` to the user.
 *
 * The function is synchronous and pure — no RPC calls, safe to call in render
 * paths and in tests without any network setup.
 *
 * @param action   The contract action being requested.
 * @param snapshot The most-recently-built app state snapshot.
 * @param opts     Optional overrides for `maxSnapshotAgeMs` and `nowMs`.
 *
 * @example
 * const gate = computeActionEligibility("contribute", snapshot);
 * if (!gate.allowed) { setError(gate.message); return; }
 * await doContribute();
 */
export function computeActionEligibility(
  action: CircleAction,
  snapshot: AppStateSnapshot,
  opts: { maxSnapshotAgeMs?: number; nowMs?: number } = {},
): GateResult {
  const nowMs  = opts.nowMs  ?? Date.now();
  const maxAge = opts.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  const networkGate = checkNetworkGate(snapshot);
  if (networkGate) return networkGate;

  const netGate = checkNetworkGate(snapshot);
  if (netGate) return netGate;

  switch (action) {
    case "join":       return gateJoin(snapshot, nowMs, maxAge);
    case "contribute": return gateContribute(snapshot, nowMs, maxAge);
    case "payout":     return gatePayout(snapshot, nowMs, maxAge);
    case "default":    return gateDefault(snapshot, nowMs, maxAge);
    case "close":      return gateClose(snapshot, nowMs, maxAge);
    default: {
      const _exhaustive: never = action;
      throw new Error(`computeActionEligibility: unknown action "${String(_exhaustive)}"`);
    }
  }
}

/** Type-guard — narrows {@link GateResult} to {@link GateAllowed}. */
export function isGateAllowed(result: GateResult): result is GateAllowed {
  return result.allowed === true;
}

/** Type-guard — narrows {@link GateResult} to {@link GateBlocked}. */
export function isGateBlocked(result: GateResult): result is GateBlocked {
  return result.allowed === false;
}

/**
 * Build an {@link AppStateSnapshot} from the data already present in the
 * `CircleDetailClient` component state.  Call this immediately before
 * computing gate eligibility so the `fetchedAtMs` reflects when the gate
 * check is actually run, not some earlier render time.
 *
 * @param circleStatus        `data.circle.status`
 * @param currentRound        `data.circle.current_round`
 * @param deadlineLedger      `data.circle.deadline_ledger ?? null`
 * @param latestLedger        `data.latestLedger ?? null`
 * @param memberAddresses     `data.members.map(m => m.member_address)`
 * @param hasLockedCollateral Whether the wallet has collateral > 0
 * @param hasContributed      Whether the wallet has already contributed this round
 * @param contributionsReceived Number of contributions received in current round
 * @param networkCheck        Result of the most recent network-mismatch check
 * @param nowMs               Override for `Date.now()` (useful in tests)
 */
export function buildAppSnapshot(
  circleStatus: string,
  currentRound: number,
  deadlineLedger: number | null | undefined,
  latestLedger: number | null | undefined,
  memberAddresses: string[],
  hasLockedCollateral: boolean,
  hasContributed: boolean,
  contributionsReceived: number,
  networkCheck: NetworkCheckState = null,
  nowMs: number = Date.now(),
): AppStateSnapshot {
  return {
    status: circleStatus,
    currentRound,
    deadlineLedger: deadlineLedger ?? null,
    latestLedger: latestLedger ?? null,
    memberAddresses,
    hasLockedCollateral,
    hasContributedCurrentRound: hasContributed,
    contributionsReceived,
    networkCheck,
    fetchedAtMs: nowMs,
  };
}
