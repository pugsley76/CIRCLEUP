/**
 * Tests for Issue: ensure get_current_round remains stable when the contract
 * is inactive.
 *
 * The contract returns `ContractError::CircleNotActive` (code 2) for
 * Completed and Cancelled circles.  These tests verify:
 *
 *   - `isCircleNotActive` recognises all error forms the SDK can produce
 *   - `getCurrentRoundResult` returns `ok:false` with a normalised message
 *     instead of throwing for inactive circles
 *   - `getCurrentRoundResult` distinguishes "not active" from a network error
 *   - `getFullState` keeps `currentRound: null` (not an exception) for
 *     terminal-status circles, even when the round fetch errors
 *   - `getCurrentRoundResult` never throws — not even on catastrophic failure
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CircleClient, CircleUpClient, isCircleNotActive } from "../client";
import { isReadFailure, isReadSuccess } from "../types";
import { CIRCLE_ADDR, SDK_CONFIG, WIRE_ROUND } from "./fixtures";

function makeClient(): CircleClient {
  return new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0);
}

// ─── isCircleNotActive ────────────────────────────────────────────────────────

describe("isCircleNotActive", () => {
  it("returns true for the canonical normalised message", () => {
    expect(
      isCircleNotActive(
        "No active round: the circle is not in an Active or Pending state.",
      ),
    ).toBe(true);
  });

  it("returns true for 'Contract error code 2'", () => {
    expect(
      isCircleNotActive(
        "Contract error code 2. Check that the operation is valid for the current circle state.",
      ),
    ).toBe(true);
  });

  it("returns true for 'CircleNotActive' (contract debug log)", () => {
    expect(isCircleNotActive("CircleNotActive")).toBe(true);
    expect(isCircleNotActive("circlenotactive")).toBe(true);
  });

  it("returns true for 'circle is not active' (contract panic message)", () => {
    expect(isCircleNotActive("circle is not active")).toBe(true);
    expect(isCircleNotActive("Circle is not active")).toBe(true);
  });

  it("returns true for 'circle not active' substring", () => {
    expect(isCircleNotActive("error: circle not active")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCircleNotActive("")).toBe(false);
    expect(isCircleNotActive("network timeout")).toBe(false);
    expect(isCircleNotActive("not initialized")).toBe(false);
    expect(isCircleNotActive("Contract error code 1")).toBe(false);
    expect(isCircleNotActive("Contract error code 3")).toBe(false);
    expect(isCircleNotActive("already joined")).toBe(false);
  });

  it("does not misidentify a network error as not-active", () => {
    expect(isCircleNotActive("ECONNREFUSED: RPC not available")).toBe(false);
    expect(isCircleNotActive("fetch failed")).toBe(false);
  });
});

// ─── getCurrentRoundResult — inactive circle ──────────────────────────────────

describe("CircleClient.getCurrentRoundResult — inactive circle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok:false with a normalised 'no active round' message for Completed circle", async () => {
    // Completed/Cancelled circles → CircleNotActive error code 2
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue({
      ok: false,
      error: "Contract error code 2. Check that the operation is valid for the current circle state.",
    });

    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(isCircleNotActive(result.error)).toBe(true);
      expect(result.error).toContain("No active round");
    }
  });

  it("returns ok:false for the 'CircleNotActive' contract debug log form", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("CircleNotActive"),
    );

    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(isCircleNotActive(result.error)).toBe(true);
    }
  });

  it("returns ok:false for the panic-message form 'circle is not active'", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("Simulation failed: circle is not active"),
    );

    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(isCircleNotActive(result.error)).toBe(true);
    }
  });

  it("preserves a network error message without misidentifying it as not-active", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("ECONNREFUSED: could not reach RPC"),
    );

    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(isCircleNotActive(result.error)).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("returns ok:true when the circle IS active and round state decodes correctly", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      WIRE_ROUND,
    );

    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(true);
    if (isReadSuccess(result)) {
      // WIRE_ROUND has round_index: 2 (see fixtures.ts)
      expect(result.value.roundIndex).toBe(2);
      expect(result.value.paidOut).toBe(false);
    }
  });

  it("never throws — resolves to ok:false even on catastrophic failure", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("unexpected internal error"),
    );
    await expect(makeClient().getCurrentRoundResult()).resolves.toMatchObject({
      ok: false,
    });
  });
});

// ─── getFullState stability for terminal circles ───────────────────────────────

describe("CircleClient.getFullState — stable for terminal circles", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps currentRound:null for Completed circles (no round fetch attempted)", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "getConfigResult").mockResolvedValue({
      ok: true,
      value: {
        members: [],
        roundAmount: 100_000_000n,
        usdcToken: "CUSD",
        reputationContract: "CREP",
        roundDeadlineLedgers: 120_960,
      },
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Completed");
    // getCurrentRoundResult should NOT be called for Completed status —
    // verify by asserting no spy is needed and result is still null
    const getCurrentRoundSpy = vi.spyOn(client as any, "getCurrentRoundResult");

    const state = await client.getFullState();

    expect(state.status).toBe("Completed");
    expect(state.currentRound).toBeNull();
    expect(getCurrentRoundSpy).not.toHaveBeenCalled();
  });

  it("keeps currentRound:null for Cancelled circles", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "getConfigResult").mockResolvedValue({
      ok: true,
      value: {
        members: [],
        roundAmount: 50_000_000n,
        usdcToken: "CUSD",
        reputationContract: "CREP",
        roundDeadlineLedgers: 120_960,
      },
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Cancelled");
    const getCurrentRoundSpy = vi.spyOn(client as any, "getCurrentRoundResult");

    const state = await client.getFullState();

    expect(state.status).toBe("Cancelled");
    expect(state.currentRound).toBeNull();
    expect(getCurrentRoundSpy).not.toHaveBeenCalled();
  });

  it("keeps currentRound:null when round fetch returns not-active for an Active circle (degraded)", async () => {
    // Edge case: status is Active but the round read fails with CircleNotActive
    // (e.g. a race condition just after the final payout). getFullState must
    // return a valid state with null round rather than crashing.
    const client = makeClient();

    vi.spyOn(client as any, "getConfigResult").mockResolvedValue({
      ok: true,
      value: {
        members: [],
        roundAmount: 100_000_000n,
        usdcToken: "CUSD",
        reputationContract: "CREP",
        roundDeadlineLedgers: 120_960,
      },
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Active");
    vi.spyOn(client as any, "getCurrentRoundResult").mockResolvedValue({
      ok: false,
      error:
        "No active round: the circle is not in an Active or Pending state.",
    });

    const state = await client.getFullState();

    expect(state.status).toBe("Active");
    expect(state.currentRound).toBeNull();
  });

  it("returns currentRound data when circle is Active and round fetch succeeds", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "getConfigResult").mockResolvedValue({
      ok: true,
      value: {
        members: [],
        roundAmount: 100_000_000n,
        usdcToken: "CUSD",
        reputationContract: "CREP",
        roundDeadlineLedgers: 120_960,
      },
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Active");
    vi.spyOn(client as any, "getCurrentRoundResult").mockResolvedValue({
      ok: true,
      value: {
        roundIndex: 2,
        recipient: "GABC",
        contributionsReceived: 3,
        deadlineLedger: 6_000_000n,
        paidOut: false,
      },
    });

    const state = await client.getFullState();

    expect(state.currentRound?.roundIndex).toBe(2);
    expect(state.currentRound?.contributionsReceived).toBe(3);
  });
});

// ─── Stability contract across all statuses ───────────────────────────────────

describe("getCurrentRoundResult — stability across all statuses", () => {
  afterEach(() => vi.restoreAllMocks());

  // Table-driven: for each terminal status, the contract returns error code 2.
  // getCurrentRoundResult must return ok:false with isCircleNotActive(error)===true.
  const terminalCases: Array<{ status: string; errorMsg: string }> = [
    {
      status: "Completed",
      errorMsg:
        "Contract error code 2. Check that the operation is valid for the current circle state.",
    },
    {
      status: "Cancelled",
      errorMsg: "CircleNotActive",
    },
  ];

  for (const { status, errorMsg } of terminalCases) {
    it(`returns ok:false with isCircleNotActive===true for ${status} circle`, async () => {
      vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
        new Error(errorMsg),
      );

      const result = await makeClient().getCurrentRoundResult();

      expect(result.ok).toBe(false);
      if (isReadFailure(result)) {
        expect(isCircleNotActive(result.error)).toBe(
          true,
          `Expected isCircleNotActive to be true for "${result.error}"`,
        );
      }
    });
  }
});
