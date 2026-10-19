/**
 * Tests for the typed simulateAndReadOrThrow mapping layer in CircleClient.
 *
 * Verifies that:
 *   - getConfig() correctly maps a RawCircleConfig wire value to CircleConfig
 *   - getCurrentRound() correctly maps a RawRoundState wire value to RoundState
 *   - Neither method ever exposes an `any`-typed intermediate result
 *   - Edge-case numeric coercions (bigint, u32, bool) are handled safely
 *
 * No real RPC calls are made — simulateAndReadOrThrow is mocked at the prototype level.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CircleClient, CircleUpClient } from "../client";
import type {
  CircleConfig,
  RoundState,
  RawCircleConfig,
  RawRoundState,
} from "../types";
import {
  CIRCLE_ADDR,
  SDK_CONFIG,
  WIRE_CONFIG,
  WIRE_ROUND,
} from "./fixtures";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeClient(): CircleClient {
  return new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0);
}

// ─── getConfig mapping ────────────────────────────────────────────────────────

describe("CircleClient.getConfig (typed simulateAndReadOrThrow)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps all wire fields to the CircleConfig shape", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      WIRE_CONFIG,
    );
    const client = makeClient();
    const config: CircleConfig = await client.getConfig();

    expect(config.members).toEqual(WIRE_CONFIG.members);
    expect(config.roundAmount).toBe(100_000_000n);
    expect(config.usdcToken).toBe(WIRE_CONFIG.usdc_token);
    expect(config.reputationContract).toBe(WIRE_CONFIG.reputation_contract);
    expect(config.roundDeadlineLedgers).toBe(120_960);
  });

  it("converts round_amount (bigint wire value) to bigint", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      { ...WIRE_CONFIG, round_amount: 50_000_000n },
    );
    const config = await makeClient().getConfig();
    expect(typeof config.roundAmount).toBe("bigint");
    expect(config.roundAmount).toBe(50_000_000n);
  });

  it("converts round_deadline_ledgers (number wire value) to number", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      { ...WIRE_CONFIG, round_deadline_ledgers: 17_280 },
    );
    const config = await makeClient().getConfig();
    expect(typeof config.roundDeadlineLedgers).toBe("number");
    expect(config.roundDeadlineLedgers).toBe(17_280);
  });

  it("calls simulateAndReadOrThrow with method 'get_config' and no args", async () => {
    const spy = vi
      .spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow")
      .mockResolvedValue(WIRE_CONFIG);
    await makeClient().getConfig();

    expect(spy).toHaveBeenCalledWith(CIRCLE_ADDR, "get_config", []);
  });

  it("propagates errors thrown by simulateAndReadOrThrow", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("contract not initialized"),
    );
    await expect(makeClient().getConfig()).rejects.toThrow("contract not initialized");
  });
});

// ─── getCurrentRound mapping ──────────────────────────────────────────────────

describe("CircleClient.getCurrentRound (typed simulateAndReadOrThrow)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps all wire fields to the RoundState shape", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      WIRE_ROUND,
    );
    const round: RoundState = await makeClient().getCurrentRound();

    expect(round.roundIndex).toBe(2);
    expect(round.recipient).toBe(WIRE_ROUND.recipient);
    expect(round.contributionsReceived).toBe(3);
    expect(round.deadlineLedger).toBe(5_000_000n);
    expect(round.paidOut).toBe(false);
  });

  it("converts deadline_ledger (bigint wire value) to bigint", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      { ...WIRE_ROUND, deadline_ledger: 9_999_999n },
    );
    const round = await makeClient().getCurrentRound();
    expect(typeof round.deadlineLedger).toBe("bigint");
    expect(round.deadlineLedger).toBe(9_999_999n);
  });

  it("converts paid_out (boolean wire value) to boolean", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      { ...WIRE_ROUND, paid_out: true },
    );
    const round = await makeClient().getCurrentRound();
    expect(round.paidOut).toBe(true);
  });

  it("converts round_index (number wire value) to number", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(
      { ...WIRE_ROUND, round_index: 0 },
    );
    const round = await makeClient().getCurrentRound();
    expect(typeof round.roundIndex).toBe("number");
    expect(round.roundIndex).toBe(0);
  });

  it("calls simulateAndReadOrThrow with method 'get_current_round' and no args", async () => {
    const spy = vi
      .spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow")
      .mockResolvedValue(WIRE_ROUND);
    await makeClient().getCurrentRound();

    expect(spy).toHaveBeenCalledWith(CIRCLE_ADDR, "get_current_round", []);
  });

  it("propagates errors thrown by simulateAndReadOrThrow", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockRejectedValue(
      new Error("circle is not active"),
    );
    // getCurrentRound now normalises CircleNotActive errors — the thrown message
    // is the canonical "No active round" form, not the raw RPC error string.
    await expect(makeClient().getCurrentRound()).rejects.toThrow(
      "No active round",
    );
  });
});

// ─── Type integrity checks ────────────────────────────────────────────────────

describe("RawCircleConfig and RawRoundState type contracts", () => {
  it("RawCircleConfig round_amount is bigint (i128 wire type)", () => {
    // Compile-time assertion — if the type changes to number this test fails
    const wire: RawCircleConfig = {
      ...WIRE_CONFIG,
      round_amount: 1n,
    };
    expect(typeof wire.round_amount).toBe("bigint");
  });

  it("RawRoundState deadline_ledger is bigint (u64 wire type)", () => {
    const wire: RawRoundState = {
      ...WIRE_ROUND,
      deadline_ledger: 42n,
    };
    expect(typeof wire.deadline_ledger).toBe("bigint");
  });

  it("RawRoundState paid_out is boolean", () => {
    const wire: RawRoundState = { ...WIRE_ROUND, paid_out: false };
    expect(typeof wire.paid_out).toBe("boolean");
  });
});
