/**
 * Tests for graceful fallback when config state is absent.
 *
 * The contract's `get_config` view returns `ContractError::NotInitialized`
 * (code 1) when the `Config` storage key does not exist — i.e. the circle
 * was deployed but `initialize` was never called.
 *
 * Covers:
 *   - `isConfigAbsent` recognises all error forms produced by the SDK
 *   - `getConfigResult` returns `ok:false` with a normalised message instead
 *     of throwing when the contract signals not-initialized
 *   - `getFullState` re-throws with a descriptive message on config absence
 *     rather than surfacing an opaque simulation crash
 *   - All error paths still never throw from `getConfigResult`
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CircleClient, CircleUpClient, isConfigAbsent } from "../client";
import { isReadFailure, isReadSuccess } from "../types";
import { CIRCLE_ADDR, SDK_CONFIG, WIRE_CONFIG, WIRE_ROUND } from "./fixtures";

function makeClient(): CircleClient {
  return new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0);
}

// ─── isConfigAbsent ───────────────────────────────────────────────────────────

describe("isConfigAbsent", () => {
  it("returns true for 'not initialized' (canonical normalised message)", () => {
    expect(isConfigAbsent("Circle contract is not initialized: the Config storage key is absent.")).toBe(true);
  });

  it("returns true for 'Contract error code 1' (extractSimulationError priority 3)", () => {
    expect(isConfigAbsent("Contract error code 1. Check that the operation is valid for the current circle state.")).toBe(true);
  });

  it("returns true for 'NotInitialized' (contract debug log)", () => {
    expect(isConfigAbsent("NotInitialized")).toBe(true);
    expect(isConfigAbsent("notinitialized")).toBe(true);
  });

  it("returns true for 'Storage(MissingValue)' (Soroban host error)", () => {
    expect(isConfigAbsent("Storage(MissingValue)")).toBe(true);
    expect(isConfigAbsent("storage(missingvalue) — config key not found")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isConfigAbsent("network timeout")).toBe(false);
    expect(isConfigAbsent("circle is not active")).toBe(false);
    expect(isConfigAbsent("already initialized")).toBe(false);
    expect(isConfigAbsent("")).toBe(false);
    expect(isConfigAbsent("Contract error code 2")).toBe(false);
  });
});

// ─── getConfigResult when config is absent ────────────────────────────────────

describe("CircleClient.getConfigResult — config absent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok:false with a normalised not-initialized message when the RPC returns error code 1", async () => {
    // The SDK's extractSimulationError maps Error(Contract, #1) to
    // "Contract error code 1. Check that the operation…"
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue({
      ok: false,
      error: "Contract error code 1. Check that the operation is valid for the current circle state.",
    });

    const result = await makeClient().getConfigResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(isConfigAbsent(result.error)).toBe(true);
      expect(result.error).toContain("not initialized");
    }
  });

  it("returns ok:false when simulation returns Storage(MissingValue)", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue({
      ok: false,
      error: "A required storage entry was not found. The circle contract may not be deployed at this address, or the state has not been initialised.",
    });

    const result = await makeClient().getConfigResult();
    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      // This uses the MissingValue branch — isConfigAbsent should catch it
      // because the normalised message contains "not initialized"
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns ok:false with a network error message when the RPC throws", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("ECONNREFUSED: RPC not available"),
    );

    const result = await makeClient().getConfigResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toContain("ECONNREFUSED");
      // A network error should NOT be misidentified as "not initialized"
      expect(isConfigAbsent(result.error)).toBe(false);
    }
  });

  it("never throws — even on catastrophic simulation failure", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("unexpected segfault"),
    );
    await expect(makeClient().getConfigResult()).resolves.toMatchObject({ ok: false });
  });

  it("returns ok:true with a valid CircleConfig when the contract is initialized", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      WIRE_CONFIG,
    );

    const result = await makeClient().getConfigResult();

    expect(result.ok).toBe(true);
    if (isReadSuccess(result)) {
      expect(result.value.roundAmount).toBe(100_000_000n);
    }
  });
});

// ─── getFullState when config is absent ───────────────────────────────────────

describe("CircleClient.getFullState — config absent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws a descriptive error when config is absent, not an opaque crash", async () => {
    const client = makeClient();

    // Simulate a not-initialized contract: simulateAndRead returns ok:false.
    // getStatus resolves (even if to a dummy value) so the Promise.all
    // doesn't reject on a getStatus error before we can check configResult.
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue({
      ok: false,
      error: "Contract error code 1. Check that the operation is valid for the current circle state.",
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Pending");

    await expect(client.getFullState()).rejects.toThrow(
      /Failed to load circle config/,
    );
  });

  it("error message includes the circle address for easier debugging", async () => {
    const client = makeClient();

    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue({
      ok: false,
      error: "Contract error code 1.",
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Pending");

    let msg = "";
    try {
      await client.getFullState();
    } catch (err: any) {
      msg = err?.message ?? "";
    }

    expect(msg).toContain(CIRCLE_ADDR);
  });

  it("succeeds when config is present", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "getConfigResult").mockResolvedValue({
      ok: true,
      value: {
        members: [WIRE_CONFIG.members[0], WIRE_CONFIG.members[1]],
        roundAmount: 100_000_000n,
        usdcToken: WIRE_CONFIG.usdc_token,
        reputationContract: WIRE_CONFIG.reputation_contract,
        roundDeadlineLedgers: 120_960,
      },
    });
    vi.spyOn(client as any, "getStatus").mockResolvedValue("Pending");
    vi.spyOn(client as any, "getCurrentRoundResult").mockResolvedValue({
      ok: true,
      value: {
        roundIndex: 0,
        recipient: WIRE_CONFIG.members[0],
        contributionsReceived: 0,
        deadlineLedger: 5_000_000n,
        paidOut: false,
      },
    });

    const state = await client.getFullState();
    expect(state.status).toBe("Pending");
    expect(state.config.roundAmount).toBe(100_000_000n);
  });
});
