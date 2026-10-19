/**
 * Canonical circle lifecycle and status model (Issue 458)
 *
 * CircleUp's core business logic depends on a clear and consistent lifecycle
 * for each ROSCA. This module defines the single source of truth for:
 *
 *   1. Valid circle statuses and their semantics
 *   2. Allowed transitions between statuses
 *   3. Which actions are permitted at each status
 *   4. Status derivation helpers for the frontend
 *
 * Statuses (mirrors the Rust contract enum):
 *   - Pending:   Circle created, waiting for members to join
 *   - Active:    All members joined, rounds in progress
 *   - Completed: All rounds paid out successfully
 *   - Cancelled: Circle dissolved before activation (member-initiated)
 *
 * Additional indexer-only status:
 *   - Closed:    Terminal state where collateral has been released
 *                (tracked as a boolean flag in the contract, projected as a
 *                status string by the indexer for query convenience)
 *
 * Lifecycle (all transitions, including sub-round events):
 *   Pending    → Active       (when all members join, via circle/active)
 *   Pending    → Cancelled    (when a member cancels, via circle/cancelled)
 *   Active     → Active       (round_started: new round opened; no status change)
 *   Active     → Completed    (all rounds paid out, via circle/completed)
 *   Completed  → Closed       (close() releases collateral, via circle/closed)
 *   Cancelled  → Closed       (close() releases collateral, via circle/closed)
 *
 * Sub-round lifecycle events (no status change, tracked by the indexer):
 *   circle/round_started          — new contribution window opened
 *   circle/exceptional_settlement — round settled via settle_round() after deadline
 */

// ─── Status definitions ──────────────────────────────────────────────────────

/** All valid circle statuses as defined by the contract + indexer. */
export type CircleLifecycleStatus =
  | "Pending"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "Closed";

export const CIRCLE_STATUS_OPTIONS = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
  "Closed",
] as const;

/** Contract-native statuses (without the indexer's Closed projection). */
export type ContractCircleStatus = "Pending" | "Active" | "Completed" | "Cancelled";

/** Terminal statuses — no further state transitions are possible. */
export type TerminalStatus = "Completed" | "Cancelled" | "Closed";

/** Active statuses — the circle is operational and accepting contributions. */
export type ActiveStatus = "Active";

/** Pre-active statuses — the circle is not yet operational. */
export type PreActiveStatus = "Pending";

// ─── Sub-round event types ────────────────────────────────────────────────────
//
// These events do not change the circle's lifecycle status; they represent
// activity *within* a status. They are tracked by the indexer but do not
// appear in VALID_TRANSITIONS.

/**
 * Events that happen within a lifecycle status without triggering a status
 * change. The indexer records them; the UI uses them to update round displays.
 *
 * - `"round_started"`          — a new contribution window has opened
 * - `"exceptional_settlement"` — a round was settled via settle_round() after
 *                                the deadline, with some members defaulting
 * - `"collateral_released"`    — a member's collateral was returned by close()
 *                                (individual per-member event, aggregated by
 *                                the circle/closed event total)
 */
export type CircleSubRoundEvent =
  | "round_started"
  | "exceptional_settlement"
  | "collateral_released";

/**
 * Returns true when an event name is a sub-round event — i.e. it happens
 * within a lifecycle status and does not trigger a status change.
 *
 * Use this to distinguish status-changing transitions from within-status
 * activity events when processing the indexer's event stream:
 *
 * ```ts
 * if (isSubRoundEvent(eventName)) {
 *   updateRoundDisplay(eventData);
 * } else {
 *   updateCircleStatus(newStatus);
 * }
 * ```
 */
export function isSubRoundEvent(event: string): event is CircleSubRoundEvent {
  return (
    event === "round_started" ||
    event === "exceptional_settlement" ||
    event === "collateral_released"
  );
}

// ─── Transition rules ────────────────────────────────────────────────────────

/**
 * Defines which transitions are valid from each status.
 * Source: contracts/circle/src/lib.rs state machine.
 */
const VALID_TRANSITIONS: Record<CircleLifecycleStatus, readonly CircleLifecycleStatus[]> = {
  Pending:   ["Active", "Cancelled"],
  Active:    ["Completed"],
  Completed: ["Closed"],
  Cancelled: ["Closed"],
  Closed:    [],  // terminal — no further transitions
};

/**
 * Returns true when a transition from `from` to `to` is valid.
 *
 * @example
 * isValidTransition("Pending", "Active")      → true
 * isValidTransition("Active", "Pending")       → false
 * isValidTransition("Completed", "Closed")     → true
 */
export function isValidTransition(
  from: CircleLifecycleStatus,
  to: CircleLifecycleStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Returns the list of valid target statuses from the given status.
 */
export function validTransitionsFrom(
  status: CircleLifecycleStatus,
): readonly CircleLifecycleStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

// ─── Status classification ───────────────────────────────────────────────────

/**
 * Returns true when the circle is in a terminal state (Completed, Cancelled, or Closed).
 */
export function isTerminalStatus(status: string): boolean {
  return status === "Completed" || status === "Cancelled" || status === "Closed";
}

/**
 * Returns true when the circle is operational (Active).
 */
export function isActiveStatus(status: string): boolean {
  return status === "Active";
}

/**
 * Returns true when the circle is pending activation.
 */
export function isPendingStatus(status: string): boolean {
  return status === "Pending";
}

/**
 * Returns true when the circle's collateral has been released (Closed).
 */
export function isClosedStatus(status: string): boolean {
  return status === "Closed";
}

// ─── Action eligibility ──────────────────────────────────────────────────────

/** Contract actions that modify state. */
export type CircleAction = "join" | "contribute" | "payout" | "default" | "close" | "cancel";

/**
 * Returns the statuses in which a given action is permitted.
 *
 * Source: contract guard checks (assert_status_* functions in lib.rs).
 */
export function statusesForAction(action: CircleAction): readonly CircleLifecycleStatus[] {
  switch (action) {
    case "join":       return ["Pending"];
    case "contribute": return ["Active"];
    case "payout":     return ["Active"];
    case "default":    return ["Active"];
    case "close":      return ["Completed", "Cancelled"];
    case "cancel":     return ["Pending"];
    default:           return [];
  }
}

/**
 * Returns true when the given action is permitted for the circle's current status.
 */
export function isActionAllowed(action: CircleAction, status: string): boolean {
  const allowed = statusesForAction(action);
  return allowed.includes(status as CircleLifecycleStatus);
}

/**
 * Returns true when a circle in the given status can be closed.
 *
 * Closing releases collateral and is only valid once the circle has reached a
 * terminal-but-unsettled state: either Completed (all rounds paid out) or
 * Cancelled (dissolved before activation). Circles that are still Pending or
 * Active must not be closable, and an already-Closed circle cannot be closed
 * again.
 */
export function canClose(status: string): boolean {
  return isActionAllowed("close", status);
}

// ─── Status display helpers ──────────────────────────────────────────────────

/** Human-readable label for each status. */
export const STATUS_LABELS: Record<CircleLifecycleStatus, string> = {
  Pending:   "Pending",
  Active:    "Active",
  Completed: "Completed",
  Cancelled: "Cancelled",
  Closed:    "Closed",
};

/** CSS color classes for status badges. */
export const STATUS_COLORS: Record<CircleLifecycleStatus, string> = {
  Pending:   "bg-yellow-100 text-yellow-800 border-yellow-300",
  Active:    "bg-brand-100 text-brand-700 border-brand-300",
  Completed: "bg-green-100 text-green-800 border-green-300",
  Cancelled: "bg-red-100 text-red-800 border-red-400",
  Closed:    "bg-slate-100 text-slate-500 border-slate-200",
};

/**
 * Returns a human-readable description of what each status means.
 */
export function describeStatus(status: CircleLifecycleStatus): string {
  switch (status) {
    case "Pending":
      return "Waiting for all members to lock collateral before the circle starts.";
    case "Active":
      return "All members have joined. Contribution rounds are in progress.";
    case "Completed":
      return "All rounds have been paid out successfully.";
    case "Cancelled":
      return "The circle was dissolved before becoming active.";
    case "Closed":
      return "Collateral has been released to members. This circle is fully settled.";
  }
}

/**
 * Returns a description of the next expected action for a circle in the given status.
 */
export function nextActionHint(
  status: CircleLifecycleStatus,
  options: { isMember?: boolean; allContributed?: boolean; roundComplete?: boolean } = {},
): string | null {
  switch (status) {
    case "Pending":
      return options.isMember
        ? "Waiting for other members to join."
        : "Connect your wallet and lock collateral to join.";
    case "Active":
      if (options.allContributed) {
        return "All members contributed. Payout can be triggered.";
      }
      return options.isMember
        ? "Contribute your share of the pot for this round."
        : "Waiting for members to contribute.";
    case "Completed":
      return "All rounds are complete. Collateral can be released.";
    case "Cancelled":
      return "This circle was cancelled. Collateral can be released.";
    case "Closed":
      return "This circle is fully settled. No further actions are possible.";
  }
}

export function normalizeStatus(raw: string): CircleLifecycleStatus | undefined {
  if (!raw) return undefined;
  const valid: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
  const lower = raw.trim().toLowerCase();
  return valid.find((status) => status.toLowerCase() === lower);
}

export function normalizeStatus(raw: string): CircleLifecycleStatus | undefined {
  if (!raw) return undefined;
  const valid: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
  const lower = raw.trim().toLowerCase();
  return valid.find((s) => s.toLowerCase() === lower);
}

export function assertValidStatus(raw: string): CircleLifecycleStatus {
  const norm = normalizeStatus(raw);
  if (!norm) {
    throw new Error(`Invalid circle lifecycle status: ${raw}`);
  }
  return norm;
}

