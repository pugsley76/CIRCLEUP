/**
 * Tests for isRetryable — verifies that each TxErrorCode is classified
 * correctly so callers never blindly retry a confirmed failure or skip
 * retrying a transient network error.
 */

import { describe, it, expect } from "vitest";
import {
  isRetryable,
  isTxFailure,
  type TxFailure,
  type TxErrorCode,
} from "../types";

function failure(code: TxErrorCode, txHash = ""): TxFailure {
  return { success: false, txHash, errorMessage: `error: ${code}`, errorCode: code };
}

// ── Retryable codes ───────────────────────────────────────────────────────────

describe("isRetryable: retryable codes", () => {
  it("network_error is retryable — transient connectivity failure", () => {
    expect(isRetryable(failure("network_error"))).toBe(true);
  });

  it("try_again_later is retryable — RPC congestion, tx was never queued", () => {
    expect(isRetryable(failure("try_again_later"))).toBe(true);
  });

  it("tx_rejected is retryable — fee/sequence issue, rebuild and resubmit", () => {
    expect(isRetryable(failure("tx_rejected"))).toBe(true);
  });
});

// ── Non-retryable: user-actionable ────────────────────────────────────────────

describe("isRetryable: user-actionable codes (not retryable)", () => {
  it("invalid_argument is not retryable — fix the inputs first", () => {
    expect(isRetryable(failure("invalid_argument"))).toBe(false);
  });

  it("account_not_found is not retryable — fund the account first", () => {
    expect(isRetryable(failure("account_not_found"))).toBe(false);
  });

  it("simulation_failed is not retryable — contract validation rejected the call", () => {
    // This covers: 'already joined', 'not a circle member', 'round deadline passed', etc.
    expect(isRetryable(failure("simulation_failed"))).toBe(false);
  });
});

// ── Non-retryable: confirmed on-chain failure ─────────────────────────────────

describe("isRetryable: confirmed on-chain failure (not retryable)", () => {
  it("tx_failed is not retryable — tx was included in a ledger and failed", () => {
    // Retrying would submit a duplicate that also fails and wastes fees.
    expect(isRetryable(failure("tx_failed", "DEADBEEF"))).toBe(false);
  });
});

// ── Non-retryable: in-flight ambiguity ───────────────────────────────────────

describe("isRetryable: in-flight ambiguity (not automatically retryable)", () => {
  it("timeout is not automatically retryable — tx may still confirm", () => {
    // Caller must check the hash on Stellar Expert before resubmitting.
    expect(isRetryable(failure("timeout", "TXHASH123"))).toBe(false);
  });

  it("stale_rpc is not automatically retryable — tx may still confirm on another RPC", () => {
    expect(isRetryable(failure("stale_rpc", "TXHASH456"))).toBe(false);
  });
});

// ── Unknown ───────────────────────────────────────────────────────────────────

describe("isRetryable: unsettled or expired writes", () => {
  it("outcome_unknown is NOT retryable — the write may already be applied", () => {
    expect(isRetryable(failure("outcome_unknown", "a".repeat(64)))).toBe(false);
  });

  it("tx_expired is retryable — the envelope can no longer be included", () => {
    expect(isRetryable(failure("tx_expired", "b".repeat(64)))).toBe(true);
  });
});

describe("isRetryable: unknown code", () => {
  it("unknown is not retryable — conservative default", () => {
    expect(isRetryable(failure("unknown"))).toBe(false);
  });
});

// ── Exhaustive coverage ───────────────────────────────────────────────────────

describe("isRetryable: exhaustive coverage of all TxErrorCode values", () => {
  const retryable: TxErrorCode[] = [
    "network_error",
    "try_again_later",
    "tx_rejected",
    "tx_expired",
  ];
  const notRetryable: TxErrorCode[] = [
    "invalid_argument",
    "account_not_found",
    "simulation_failed",
    "tx_failed",
    "timeout",
    "stale_rpc",
    "stale_state",
    "outcome_unknown",
    "unknown",
  ];

  for (const code of retryable) {
    it(`${code} → true`, () => {
      expect(isRetryable(failure(code))).toBe(true);
    });
  }

  for (const code of notRetryable) {
    it(`${code} → false`, () => {
      expect(isRetryable(failure(code))).toBe(false);
    });
  }

  it("all TxErrorCode values are covered (no silent gaps)", () => {
    const allCodes: TxErrorCode[] = [...retryable, ...notRetryable];
    // Every code must appear in exactly one list.
    const seen = new Set(allCodes);
    const defined: TxErrorCode[] = [
      "invalid_argument",
      "account_not_found",
      "simulation_failed",
      "network_error",
      "try_again_later",
      "tx_rejected",
      "tx_failed",
      "tx_expired",
      "stale_rpc",
      "stale_state",
      "timeout",
      "outcome_unknown",
      "unknown",
    ];
    for (const code of defined) {
      expect(seen.has(code)).toBe(true);
    }
    expect(allCodes.length).toBe(defined.length);
  });
});

// ── Integration with isTxFailure ─────────────────────────────────────────────

describe("isRetryable used with isTxFailure guard", () => {
  it("pattern: check isTxFailure then isRetryable", () => {
    const result = failure("network_error");
    // Simulate the recommended usage pattern
    if (isTxFailure(result)) {
      expect(isRetryable(result)).toBe(true);
    } else {
      throw new Error("should have been a failure");
    }
  });

  it("simulation_failed with contract panic message is not retryable", () => {
    const result: TxFailure = {
      success: false,
      txHash: "",
      errorMessage: "Simulation failed for CADDR.contribute: already contributed this round",
      errorCode: "simulation_failed",
    };
    expect(isRetryable(result)).toBe(false);
  });

  it("tx_failed with on-chain hash is not retryable", () => {
    const result: TxFailure = {
      success: false,
      txHash: "CONFIRMEDFAILEDHASH",
      errorMessage: "Transaction was included in a ledger but failed",
      errorCode: "tx_failed",
    };
    expect(isRetryable(result)).toBe(false);
  });
});
