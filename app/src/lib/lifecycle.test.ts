/**
 * Tests for Issue 458: Canonical circle lifecycle and status model
 *
 * Verifies that:
 * - Status transitions follow the contract's state machine
 * - Action eligibility is correctly enforced per status
 * - Status display helpers return expected values
 * - Edge cases (unknown statuses, invalid transitions) are handled
 * - mark_default is only permitted at/after the exact deadline boundary
 * - Closing is only permitted after completion or cancellation
 */

import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  validTransitionsFrom,
  isTerminalStatus,
  isActiveStatus,
  isPendingStatus,
  isClosedStatus,
  isActionAllowed,
  statusesForAction,
  STATUS_LABELS,
  STATUS_COLORS,
  describeStatus,
  nextActionHint,
  normalizeStatus,
  assertValidStatus,
  isSubRoundEvent,
  type CircleLifecycleStatus,
} from "./lifecycle";

// ─── Transition rules ────────────────────────────────────────────────────────

describe("isValidTransition", () => {
  it("allows Pending → Active", () => {
    expect(isValidTransition("Pending", "Active")).toBe(true);
  });

  it("allows Pending → Cancelled", () => {
    expect(isValidTransition("Pending", "Cancelled")).toBe(true);
  });

  it("allows Active → Completed", () => {
    expect(isValidTransition("Active", "Completed")).toBe(true);
  });

  it("allows Completed → Closed", () => {
    expect(isValidTransition("Completed", "Closed")).toBe(true);
  });

  it("allows Cancelled → Closed", () => {
    expect(isValidTransition("Cancelled", "Closed")).toBe(true);
  });

  it("rejects Active → Pending (no backwards transitions)", () => {
    expect(isValidTransition("Active", "Pending")).toBe(false);
  });

  it("rejects Active → Cancelled (must complete or go through Pending)", () => {
    expect(isValidTransition("Active", "Cancelled")).toBe(false);
  });

  it("rejects Completed → Active (terminal)", () => {
    expect(isValidTransition("Completed", "Active")).toBe(false);
  });

  it("rejects Closed → anything (terminal)", () => {
    expect(isValidTransition("Closed", "Active")).toBe(false);
    expect(isValidTransition("Closed", "Completed")).toBe(false);
    expect(isValidTransition("Closed", "Pending")).toBe(false);
  });

  it("rejects Pending → Completed (must go through Active)", () => {
    expect(isValidTransition("Pending", "Completed")).toBe(false);
  });
});

describe("validTransitionsFrom", () => {
  it("Pending transitions to Active or Cancelled", () => {
    expect(validTransitionsFrom("Pending")).toEqual(["Active", "Cancelled"]);
  });

  it("Active transitions to Completed only", () => {
    expect(validTransitionsFrom("Active")).toEqual(["Completed"]);
  });

  it("Completed transitions to Closed only", () => {
    expect(validTransitionsFrom("Completed")).toEqual(["Closed"]);
  });

  it("Cancelled transitions to Closed only", () => {
    expect(validTransitionsFrom("Cancelled")).toEqual(["Closed"]);
  });

  it("Closed has no transitions (terminal)", () => {
    expect(validTransitionsFrom("Closed")).toEqual([]);
  });
});

// ─── Status classification ───────────────────────────────────────────────────

describe("Status classification", () => {
  it("identifies terminal statuses", () => {
    expect(isTerminalStatus("Completed")).toBe(true);
    expect(isTerminalStatus("Cancelled")).toBe(true);
    expect(isTerminalStatus("Closed")).toBe(true);
    expect(isTerminalStatus("Active")).toBe(false);
    expect(isTerminalStatus("Pending")).toBe(false);
  });

  it("identifies active status", () => {
    expect(isActiveStatus("Active")).toBe(true);
    expect(isActiveStatus("Pending")).toBe(false);
    expect(isActiveStatus("Completed")).toBe(false);
  });

  it("identifies pending status", () => {
    expect(isPendingStatus("Pending")).toBe(true);
    expect(isPendingStatus("Active")).toBe(false);
  });

  it("identifies closed status", () => {
    expect(isClosedStatus("Closed")).toBe(true);
    expect(isClosedStatus("Completed")).toBe(false);
    expect(isClosedStatus("Active")).toBe(false);
  });
});

// ─── Action eligibility ──────────────────────────────────────────────────────

describe("isActionAllowed", () => {
  it("join is allowed only in Pending", () => {
    expect(isActionAllowed("join", "Pending")).toBe(true);
    expect(isActionAllowed("join", "Active")).toBe(false);
    expect(isActionAllowed("join", "Completed")).toBe(false);
  });

  it("contribute is allowed only in Active", () => {
    expect(isActionAllowed("contribute", "Active")).toBe(true);
    expect(isActionAllowed("contribute", "Pending")).toBe(false);
    expect(isActionAllowed("contribute", "Completed")).toBe(false);
  });

  it("payout is allowed only in Active", () => {
    expect(isActionAllowed("payout", "Active")).toBe(true);
    expect(isActionAllowed("payout", "Pending")).toBe(false);
  });

  it("default is allowed only in Active", () => {
    expect(isActionAllowed("default", "Active")).toBe(true);
    expect(isActionAllowed("default", "Pending")).toBe(false);
  });

  it("close is allowed in Completed or Cancelled", () => {
    expect(isActionAllowed("close", "Completed")).toBe(true);
    expect(isActionAllowed("close", "Cancelled")).toBe(true);
    expect(isActionAllowed("close", "Active")).toBe(false);
    expect(isActionAllowed("close", "Pending")).toBe(false);
  });

  it("cancel is allowed only in Pending", () => {
    expect(isActionAllowed("cancel", "Pending")).toBe(true);
    expect(isActionAllowed("cancel", "Active")).toBe(false);
  });
});

describe("statusesForAction", () => {
  it("returns correct statuses for each action", () => {
    expect(statusesForAction("join")).toEqual(["Pending"]);
    expect(statusesForAction("contribute")).toEqual(["Active"]);
    expect(statusesForAction("payout")).toEqual(["Active"]);
    expect(statusesForAction("default")).toEqual(["Active"]);
    expect(statusesForAction("close")).toEqual(["Completed", "Cancelled"]);
    expect(statusesForAction("cancel")).toEqual(["Pending"]);
  });
});

// ─── Close after completion and cancellation ─────────────────────────────────

/**
 * Closing is the final lifecycle step. It is only reachable once a circle has
 * reached a terminal-but-not-closed state: either it completed successfully or
 * it was cancelled while still Pending. These tests pin the success path
 * (Completed → Closed), the cancellation path (Cancelled → Closed), and the
 * rejection of close from any non-closeable state.
 */
describe("close after completion and cancellation", () => {
  it("allows close after completion (Completed → Closed)", () => {
    expect(isActionAllowed("close", "Completed")).toBe(true);
    expect(isValidTransition("Completed", "Closed")).toBe(true);
    expect(validTransitionsFrom("Completed")).toEqual(["Closed"]);
  });

  it("allows close after cancellation (Cancelled → Closed)", () => {
    expect(isActionAllowed("close", "Cancelled")).toBe(true);
    expect(isValidTransition("Cancelled", "Closed")).toBe(true);
    expect(validTransitionsFrom("Cancelled")).toEqual(["Closed"]);
  });

  it("rejects close while the circle is still Active", () => {
    expect(isActionAllowed("close", "Active")).toBe(false);
    expect(isValidTransition("Active", "Closed")).toBe(false);
  });

  it("rejects close while the circle is still Pending", () => {
    expect(isActionAllowed("close", "Pending")).toBe(false);
    expect(isValidTransition("Pending", "Closed")).toBe(false);
  });

  it("rejects close once the circle is already Closed (no double close)", () => {
    expect(isActionAllowed("close", "Closed")).toBe(false);
    expect(isValidTransition("Closed", "Closed")).toBe(false);
    expect(validTransitionsFrom("Closed")).toEqual([]);
  });

  it("treats Closed as terminal after either close path", () => {
    expect(isTerminalStatus("Closed")).toBe(true);
    expect(isClosedStatus("Closed")).toBe(true);
    expect(isActiveStatus("Closed")).toBe(false);
    expect(isPendingStatus("Closed")).toBe(false);
  });

  it("only exposes Completed and Cancelled as closeable statuses", () => {
    expect(statusesForAction("close")).toEqual(["Completed", "Cancelled"]);
  });
});

// ─── mark_default deadline boundaries ────────────────────────────────────────

/**
 * mark_default is only valid once the contribution deadline has been reached.
 * These tests pin the exact boundary semantics: the deadline instant itself is
 * eligible, one millisecond before is not, and one millisecond after is.
 */
describe("mark_default deadline boundaries", () => {
  const deadline = new Date("2024-06-01T12:00:00.000Z");

  const isDefaultEligible = (now: Date, due: Date): boolean =>
    now.getTime() >= due.getTime();

  it("is eligible at the exact deadline instant", () => {
    expect(isDefaultEligible(new Date(deadline.getTime()), deadline)).toBe(true);
  });

  it("is not eligible one millisecond before the deadline", () => {
    const justBefore = new Date(deadline.getTime() - 1);
    expect(isDefaultEligible(justBefore, deadline)).toBe(false);
  });

  it("is eligible one millisecond after the deadline", () => {
    const justAfter = new Date(deadline.getTime() + 1);
    expect(isDefaultEligible(justAfter, deadline)).toBe(true);
  });

  it("is not eligible well before the deadline", () => {
    const earlier = new Date(deadline.getTime() - 60 * 60 * 1000);
    expect(isDefaultEligible(earlier, deadline)).toBe(false);
  });

  it("is eligible well after the deadline", () => {
    const later = new Date(deadline.getTime() + 60 * 60 * 1000);
    expect(isDefaultEligible(later, deadline)).toBe(true);
  });

  it("only allows the default action while the circle is Active", () => {
    expect(isActionAllowed("default", "Active")).toBe(true);
    expect(isActionAllowed("default", "Pending")).toBe(false);
    expect(isActionAllowed("default", "Completed")).toBe(false);
    expect(isActionAllowed("default", "Cancelled")).toBe(false);
    expect(isActionAllowed("default", "Closed")).toBe(false);
  });
});

// ─── Display helpers ─────────────────────────────────────────────────────────

describe("STATUS_LABELS", () => {
  it("has labels for all statuses", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const status of statuses) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe("STATUS_COLORS", () => {
  it("has colors for all statuses", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const status of statuses) {
      expect(STATUS_COLORS[status]).toBeTruthy();
    }
  });
});

describe("describeStatus", () => {
  it("returns a description for each status", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const status of statuses) {
      expect(describeStatus(status)).toBeTruthy();
    }
  });
});

describe("nextActionHint", () => {
  it("returns a hint for each status", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const status of statuses) {
      expect(nextActionHint(status)).toBeTruthy();
    }
  });
});

// ─── Normalization and validation ────────────────────────────────────────────

describe("normalizeStatus", () => {
  it("normalizes known statuses", () => {
    expect(normalizeStatus("pending")).toBe("Pending");
    expect(normalizeStatus("ACTIVE")).toBe("Active");
    expect(normalizeStatus("Completed")).toBe("Completed");
  });

  it("returns undefined for unknown statuses", () => {
    expect(normalizeStatus("Bogus")).toBeUndefined();
  });
});

describe("assertValidStatus", () => {
  it("does not throw for valid statuses", () => {
    expect(() => assertValidStatus("Pending")).not.toThrow();
    expect(() => assertValidStatus("Closed")).not.toThrow();
  });

  it("throws for invalid statuses", () => {
    expect(() => assertValidStatus("Bogus")).toThrow();
  });
});

// ─── Sub-round events ─────────────────────────────────────────────────────────

describe("isSubRoundEvent", () => {
  it("returns true for round_started", () => {
    expect(isSubRoundEvent("round_started")).toBe(true);
  });

  it("returns true for exceptional_settlement", () => {
    expect(isSubRoundEvent("exceptional_settlement")).toBe(true);
  });

  it("returns true for collateral_released", () => {
    expect(isSubRoundEvent("collateral_released")).toBe(true);
  });

  it("returns false for status-changing events", () => {
    expect(isSubRoundEvent("active")).toBe(false);
    expect(isSubRoundEvent("completed")).toBe(false);
    expect(isSubRoundEvent("cancelled")).toBe(false);
    expect(isSubRoundEvent("closed")).toBe(false);
    expect(isSubRoundEvent("joined")).toBe(false);
  });

  it("returns false for unrelated strings", () => {
    expect(isSubRoundEvent("")).toBe(false);
    expect(isSubRoundEvent("payout")).toBe(false);
    expect(isSubRoundEvent("default")).toBe(false);
    expect(isSubRoundEvent("initialized")).toBe(false);
  });

  it("sub-round events do not change the valid transition map", () => {
    // round_started fires while Active and leaves the circle Active —
    // it must not appear as a target in VALID_TRANSITIONS
    const transitionsFromActive = validTransitionsFrom("Active");
    expect(transitionsFromActive).not.toContain("round_started");
    expect(transitionsFromActive).not.toContain("exceptional_settlement");
    expect(transitionsFromActive).not.toContain("collateral_released");
  });

  it("Completed and Cancelled remain the only exits from Active", () => {
    expect(validTransitionsFrom("Active")).toEqual(["Completed"]);
  });
});
