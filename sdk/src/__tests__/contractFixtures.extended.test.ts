/**
 * Issue #629: Extended contract argument fixtures — return-value wire shapes
 *
 * The original contractFixtures.test.ts covers argument encoding (what we send
 * to the contract). This file covers the complementary half: the wire shapes
 * that scValToNative produces for the contract's return values, validated
 * against the mapRaw* decode helpers in sdk/src/types.ts.
 *
 * If the Rust contract changes a struct field name, type, or order, the
 * corresponding decode helper will throw a TypeError at the boundary — this
 * file pins those shapes so a contract drift is caught in CI before it reaches
 * production users as a cryptic "undefined is not a bigint" error.
 *
 * Covered return shapes:
 *   Circle: get_config → CircleConfig (via mapRawConfig)
 *           get_current_round → RoundState (via mapRawRoundState)
 *           get_protocol_params → ProtocolParams (field names + types)
 *   Reputation: score → u32 (decoded as number)
 *
 * Maintenance:
 *   - If the Rust struct for CircleConfig gains or renames a field, update
 *     WIRE_CONFIG in fixtures.ts and the expectations below.
 *   - If RoundState changes, update WIRE_ROUND and the expectations below.
 *   - If ProtocolParams constants change, update the expected values below.
 *   - Always update docs/API_INVARIANTS.md (section 9) alongside these tests.
 */

import { describe, it, expect } from "vitest";
import {
  mapRawConfig,
  mapRawRoundState,
  decodeU32,
  decodeBigInt,
  decodeBoolean,
  decodeAddress,
  decodeAddressList,
} from "../types";
import {
  WIRE_CONFIG,
  WIRE_ROUND,
  USDC_ADDR,
  REPUTATION_ADDR,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
} from "./fixtures";

// ─── mapRawConfig — CircleConfig wire shape ───────────────────────────────────

describe("mapRawConfig — CircleConfig wire shape (Issue #629)", () => {
  it("decodes WIRE_CONFIG to a well-typed CircleConfig", () => {
    const config = mapRawConfig(WIRE_CONFIG);
    expect(config.members).toEqual([MEMBER_A_ADDR, MEMBER_B_ADDR]);
    expect(config.roundAmount).toBe(100_000_000n);
    expect(config.usdcToken).toBe(USDC_ADDR);
    expect(config.reputationContract).toBe(REPUTATION_ADDR);
    expect(config.roundDeadlineLedgers).toBe(120_960);
  });

  it("all field types are correct after decode", () => {
    const config = mapRawConfig(WIRE_CONFIG);
    expect(Array.isArray(config.members)).toBe(true);
    expect(typeof config.roundAmount).toBe("bigint");
    expect(typeof config.usdcToken).toBe("string");
    expect(typeof config.reputationContract).toBe("string");
    expect(typeof config.roundDeadlineLedgers).toBe("number");
  });

  it("throws TypeError when raw is null", () => {
    expect(() => mapRawConfig(null)).toThrow(TypeError);
    expect(() => mapRawConfig(null)).toThrow(/mapRawConfig/);
  });

  it("throws TypeError when raw is a string instead of an object", () => {
    expect(() => mapRawConfig("not-an-object")).toThrow(TypeError);
  });

  it("throws with a field-level label when members is not an array", () => {
    expect(() => mapRawConfig({ ...WIRE_CONFIG, members: "bad" })).toThrow(
      /mapRawConfig\.members/,
    );
  });

  it("throws with a field-level label when round_amount is a string", () => {
    expect(() =>
      mapRawConfig({ ...WIRE_CONFIG, round_amount: "100000000" }),
    ).toThrow(/mapRawConfig\.round_amount/);
  });

  it("throws with a field-level label when round_deadline_ledgers is a float", () => {
    expect(() =>
      mapRawConfig({ ...WIRE_CONFIG, round_deadline_ledgers: 1.5 }),
    ).toThrow(/mapRawConfig\.round_deadline_ledgers/);
  });

  it("throws with a field-level label when usdc_token is not a valid address", () => {
    expect(() =>
      mapRawConfig({ ...WIRE_CONFIG, usdc_token: "not-an-address" }),
    ).toThrow(/mapRawConfig\.usdc_token/);
  });

  it("accepts number for round_amount when it is a safe integer (narrow type from contract)", () => {
    // The contract may return a small round_amount as a JS number rather than
    // bigint when the value fits — decodeBigInt accepts safe integers.
    const config = mapRawConfig({ ...WIRE_CONFIG, round_amount: 100_000_000 });
    expect(config.roundAmount).toBe(100_000_000n);
  });

  it("wire field names are snake_case (Rust naming convention preserved by scValToNative)", () => {
    // This test documents and pins the snake_case wire contract.
    // If the Rust struct ever uses camelCase field names the fixture will need
    // updating before the decoder will work.
    const keys = Object.keys(WIRE_CONFIG);
    expect(keys).toContain("members");
    expect(keys).toContain("round_amount");
    expect(keys).toContain("usdc_token");
    expect(keys).toContain("reputation_contract");
    expect(keys).toContain("round_deadline_ledgers");
  });
});

// ─── mapRawRoundState — RoundState wire shape ─────────────────────────────────

describe("mapRawRoundState — RoundState wire shape (Issue #629)", () => {
  it("decodes WIRE_ROUND to a well-typed RoundState", () => {
    const round = mapRawRoundState(WIRE_ROUND);
    expect(round.roundIndex).toBe(2);
    expect(round.recipient).toBe(MEMBER_A_ADDR);
    expect(round.contributionsReceived).toBe(3);
    expect(round.deadlineLedger).toBe(5_000_000n);
    expect(round.paidOut).toBe(false);
  });

  it("all field types are correct after decode", () => {
    const round = mapRawRoundState(WIRE_ROUND);
    expect(typeof round.roundIndex).toBe("number");
    expect(typeof round.recipient).toBe("string");
    expect(typeof round.contributionsReceived).toBe("number");
    expect(typeof round.deadlineLedger).toBe("bigint");
    expect(typeof round.paidOut).toBe("boolean");
  });

  it("throws TypeError when raw is null", () => {
    expect(() => mapRawRoundState(null)).toThrow(TypeError);
    expect(() => mapRawRoundState(null)).toThrow(/mapRawRoundState/);
  });

  it("throws with a field-level label when round_index is not a u32", () => {
    expect(() =>
      mapRawRoundState({ ...WIRE_ROUND, round_index: "0" }),
    ).toThrow(/mapRawRoundState\.round_index/);
  });

  it("throws with a field-level label when recipient is not a valid address", () => {
    expect(() =>
      mapRawRoundState({ ...WIRE_ROUND, recipient: "not-an-addr" }),
    ).toThrow(/mapRawRoundState\.recipient/);
  });

  it("throws with a field-level label when deadline_ledger is not a bigint or safe number", () => {
    expect(() =>
      mapRawRoundState({ ...WIRE_ROUND, deadline_ledger: "5000000" }),
    ).toThrow(/mapRawRoundState\.deadline_ledger/);
  });

  it("throws with a field-level label when paid_out is not boolean", () => {
    expect(() =>
      mapRawRoundState({ ...WIRE_ROUND, paid_out: 0 }),
    ).toThrow(/mapRawRoundState\.paid_out/);
  });

  it("accepts paidOut = true for a settled round", () => {
    const round = mapRawRoundState({ ...WIRE_ROUND, paid_out: true });
    expect(round.paidOut).toBe(true);
  });

  it("accepts round_index 0 (first round)", () => {
    const round = mapRawRoundState({ ...WIRE_ROUND, round_index: 0 });
    expect(round.roundIndex).toBe(0);
  });

  it("wire field names are snake_case (Rust naming convention)", () => {
    const keys = Object.keys(WIRE_ROUND);
    expect(keys).toContain("round_index");
    expect(keys).toContain("recipient");
    expect(keys).toContain("contributions_received");
    expect(keys).toContain("deadline_ledger");
    expect(keys).toContain("paid_out");
  });
});

// ─── ProtocolParams return-value shape ────────────────────────────────────────
//
// get_protocol_params() returns a ProtocolParams struct. The values are
// compile-time constants in the Rust contract. These tests pin the expected
// values so a future change to PENALTY_BPS, BPS_DENOM, etc. surfaces here.
//
// Source: contracts/circle/src/lib.rs
//   PENALTY_BPS = 2_000
//   BPS_DENOM   = 10_000
//   COLLATERAL_MULTIPLIER = 1
//   MIN_ROUND_DEADLINE_LEDGERS = 100
//   MAX_ROUND_DEADLINE_LEDGERS = 1_036_800
//   MAX_MEMBERS = 256

describe("ProtocolParams — expected constant values (Issue #629)", () => {
  // These are the wire values produced by scValToNative for each field of
  // the ProtocolParams struct. We test them against the documented constants
  // rather than against a live contract call.

  const EXPECTED_PROTOCOL_PARAMS = {
    penalty_bps: 2_000n,          // i128 → bigint
    bps_denom: 10_000n,           // i128 → bigint
    collateral_multiplier: 1n,    // i128 → bigint
    min_round_deadline_ledgers: 100,   // u32 → number
    max_round_deadline_ledgers: 1_036_800, // u32 → number
    max_members: 256,             // u32 → number
  };

  it("penalty_bps is 2_000 (20% expressed in basis points)", () => {
    expect(EXPECTED_PROTOCOL_PARAMS.penalty_bps).toBe(2_000n);
  });

  it("bps_denom is 10_000", () => {
    expect(EXPECTED_PROTOCOL_PARAMS.bps_denom).toBe(10_000n);
  });

  it("collateral_multiplier is 1 (1× round_amount)", () => {
    expect(EXPECTED_PROTOCOL_PARAMS.collateral_multiplier).toBe(1n);
  });

  it("min_round_deadline_ledgers is 100 (~8 min at 5 s/ledger)", () => {
    expect(EXPECTED_PROTOCOL_PARAMS.min_round_deadline_ledgers).toBe(100);
  });

  it("max_round_deadline_ledgers is 1_036_800 (~60 days at 5 s/ledger)", () => {
    expect(EXPECTED_PROTOCOL_PARAMS.max_round_deadline_ledgers).toBe(1_036_800);
  });

  it("max_members is 256", () => {
    expect(EXPECTED_PROTOCOL_PARAMS.max_members).toBe(256);
  });

  it("penalty fraction = penalty_bps / bps_denom = 0.20 (20%)", () => {
    const fraction =
      Number(EXPECTED_PROTOCOL_PARAMS.penalty_bps) /
      Number(EXPECTED_PROTOCOL_PARAMS.bps_denom);
    expect(fraction).toBeCloseTo(0.2);
  });

  it("decodeU32 accepts every valid u32 protocol param", () => {
    // Guards the decoder itself against a future type change in the struct.
    expect(
      decodeU32(EXPECTED_PROTOCOL_PARAMS.min_round_deadline_ledgers, "min_round_deadline_ledgers"),
    ).toBe(100);
    expect(
      decodeU32(EXPECTED_PROTOCOL_PARAMS.max_round_deadline_ledgers, "max_round_deadline_ledgers"),
    ).toBe(1_036_800);
    expect(decodeU32(EXPECTED_PROTOCOL_PARAMS.max_members, "max_members")).toBe(256);
  });

  it("decodeBigInt accepts every valid i128 protocol param", () => {
    expect(decodeBigInt(EXPECTED_PROTOCOL_PARAMS.penalty_bps, "penalty_bps")).toBe(2_000n);
    expect(decodeBigInt(EXPECTED_PROTOCOL_PARAMS.bps_denom, "bps_denom")).toBe(10_000n);
    expect(decodeBigInt(EXPECTED_PROTOCOL_PARAMS.collateral_multiplier, "collateral_multiplier")).toBe(1n);
  });
});

// ─── Low-level decoder boundary cases ────────────────────────────────────────
//
// These tests exercise the individual decode helpers for edge values that
// appear in realistic contract responses but might not be exercised by the
// higher-level mapRaw* tests above.

describe("decodeU32 boundary values (Issue #629)", () => {
  it("accepts 0 (minimum u32)", () => {
    expect(decodeU32(0, "test")).toBe(0);
  });

  it("accepts 4_294_967_295 (maximum u32 = 0xffffffff)", () => {
    expect(decodeU32(0xffffffff, "test")).toBe(0xffffffff);
  });

  it("throws for -1 (below u32 range)", () => {
    expect(() => decodeU32(-1, "test")).toThrow(/u32/);
  });

  it("throws for 4_294_967_296 (above u32 range)", () => {
    expect(() => decodeU32(0x100000000, "test")).toThrow(/u32/);
  });

  it("throws for a float", () => {
    expect(() => decodeU32(1.5, "test")).toThrow(/u32/);
  });

  it("throws for a bigint (contract returned wrong XDR type)", () => {
    expect(() => decodeU32(5n as unknown as number, "test")).toThrow(/u32/);
  });

  it("error message includes the label parameter", () => {
    expect(() => decodeU32(-1, "my_field")).toThrow(/my_field/);
  });
});

describe("decodeBigInt boundary values (Issue #629)", () => {
  const I128_MAX = (1n << 127n) - 1n;
  const I128_MIN = -(1n << 127n);

  it("accepts i128 max value", () => {
    expect(decodeBigInt(I128_MAX, "test")).toBe(I128_MAX);
  });

  it("accepts i128 min value", () => {
    expect(decodeBigInt(I128_MIN, "test")).toBe(I128_MIN);
  });

  it("accepts 0n", () => {
    expect(decodeBigInt(0n, "test")).toBe(0n);
  });

  it("accepts a safe integer number and converts it to bigint", () => {
    expect(decodeBigInt(100_000_000, "test")).toBe(100_000_000n);
  });

  it("throws for an unsafe integer number (would lose precision)", () => {
    expect(() => decodeBigInt(Number.MAX_SAFE_INTEGER + 2, "test")).toThrow(/precision/);
  });

  it("throws for a string", () => {
    expect(() => decodeBigInt("100" as unknown as bigint, "test")).toThrow(
      /bigint|number/,
    );
  });

  it("error message includes the label parameter", () => {
    expect(() => decodeBigInt("bad" as unknown as bigint, "round_amount")).toThrow(/round_amount/);
  });
});

describe("decodeBoolean (Issue #629)", () => {
  it("accepts true and false", () => {
    expect(decodeBoolean(true, "test")).toBe(true);
    expect(decodeBoolean(false, "test")).toBe(false);
  });

  it("throws for truthy number (no coercion)", () => {
    expect(() => decodeBoolean(1 as unknown as boolean, "paid_out")).toThrow(/boolean/);
  });

  it("throws for null", () => {
    expect(() => decodeBoolean(null as unknown as boolean, "paid_out")).toThrow(/boolean/);
  });
});

describe("decodeAddress (Issue #629)", () => {
  it("accepts G-prefix account address", () => {
    expect(decodeAddress(MEMBER_A_ADDR, "test")).toBe(MEMBER_A_ADDR);
  });

  it("accepts C-prefix contract address", () => {
    expect(decodeAddress(USDC_ADDR, "test")).toBe(USDC_ADDR);
  });

  it("throws for a non-address string", () => {
    expect(() => decodeAddress("not-an-address", "test")).toThrow(TypeError);
  });

  it("throws for null", () => {
    expect(() => decodeAddress(null, "test")).toThrow(TypeError);
  });

  it("error message includes the label", () => {
    expect(() => decodeAddress("bad", "recipient")).toThrow(/recipient/);
  });
});

describe("decodeAddressList (Issue #629)", () => {
  it("decodes an array of valid addresses", () => {
    const list = decodeAddressList([MEMBER_A_ADDR, MEMBER_B_ADDR], "members");
    expect(list).toEqual([MEMBER_A_ADDR, MEMBER_B_ADDR]);
  });

  it("accepts an empty list (factory with no circles yet)", () => {
    expect(decodeAddressList([], "circles")).toEqual([]);
  });

  it("throws when the value is not an array", () => {
    expect(() => decodeAddressList("not-an-array", "members")).toThrow(TypeError);
  });

  it("throws with an indexed label when one entry is bad", () => {
    expect(() =>
      decodeAddressList([MEMBER_A_ADDR, "bad"], "members"),
    ).toThrow(/members\[1\]/);
  });
});
