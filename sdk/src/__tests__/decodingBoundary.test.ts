/**
 * Malformed-value fixtures for the RPC decoding boundary.
 *
 * Every public read narrows `scValToNative` output through a decoder in
 * types.ts. These fixtures feed each decoder wrong variants, absent fields,
 * and out-of-range values, and check that the failure names the method or
 * field — while the values a current contract actually returns keep their
 * public shape.
 *
 * Public reads and the decoder each one uses:
 *
 * | Method                          | Contract view       | Wire type        | Decoder                   |
 * |---------------------------------|---------------------|------------------|---------------------------|
 * | FactoryClient.getCircles        | get_circles         | Vec<Address>     | decodeAddressList         |
 * | FactoryClient.getCircleCount    | get_circle_count    | u32              | decodeU32                 |
 * | FactoryClient.createCircle      | create_circle (ret) | Address          | isValidContractAddress    |
 * | CircleClient.getConfig          | get_config          | CircleConfig     | mapRawConfig              |
 * | CircleClient.getStatus          | get_status          | CircleStatus     | assertValidCircleStatus   |
 * | CircleClient.getCurrentRound    | get_current_round   | RoundState       | mapRawRoundState          |
 * | CircleClient.getCollateral      | get_collateral      | i128 (>= 0)      | decodeI128                |
 * | CircleClient.getDefaults        | get_defaults        | u32              | decodeU32                 |
 * | CircleClient.hasContributed     | has_contributed     | bool             | decodeBoolean             |
 * | ReputationClient.getScore       | score               | u32              | decodeU32                 |
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CircleClient, CircleUpClient, FactoryClient } from "../client";
import {
  assertValidCircleStatus,
  decodeAddressList,
  decodeI128,
  decodeRecord,
  decodeU32InRange,
  decodeU64,
  mapRawConfig,
  mapRawRoundState,
} from "../types";
import {
  CIRCLE_ADDR,
  CREATOR,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
  REPUTATION_ADDR,
  SDK_CONFIG,
  USDC_ADDR,
  WIRE_CONFIG,
  WIRE_ROUND,
  testKeypair,
} from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/** Make every contract read on a client return `value`. */
function readsReturn(value: unknown) {
  vi.spyOn(CircleUpClient.prototype as any, "simulateAndReadOrThrow").mockResolvedValue(value);
}

// ─── Valid values keep their public shape ─────────────────────────────────────

describe("current contract values decode unchanged", () => {
  it("CircleConfig round-trips through real XDR", () => {
    const native = scValToNative(
      nativeToScVal(
        {
          members: [new Address(MEMBER_A_ADDR), new Address(MEMBER_B_ADDR)],
          round_amount: 100_000_000n,
          usdc_token: new Address(USDC_ADDR),
          reputation_contract: new Address(REPUTATION_ADDR),
          round_deadline_ledgers: 120_960,
        },
        { type: { round_amount: ["symbol", "i128"], round_deadline_ledgers: ["symbol", "u32"] } },
      ),
    );
    expect(mapRawConfig(native)).toEqual({
      members: [MEMBER_A_ADDR, MEMBER_B_ADDR],
      roundAmount: 100_000_000n,
      usdcToken: USDC_ADDR,
      reputationContract: REPUTATION_ADDR,
      roundDeadlineLedgers: 120_960,
    });
  });

  it("RoundState keeps its shape", () => {
    expect(mapRawRoundState(WIRE_ROUND)).toEqual({
      roundIndex: 2,
      recipient: MEMBER_A_ADDR,
      contributionsReceived: 3,
      deadlineLedger: 5_000_000n,
      paidOut: false,
    });
  });

  it.each(["Pending", "Active", "Completed", "Cancelled"])(
    "the #[contracttype] enum encoding of %s decodes to the bare variant name",
    (variant) => {
      // A unit enum variant is an ScVec holding its name as a symbol.
      const native = scValToNative(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]));
      expect(native).toEqual([variant]);
      expect(assertValidCircleStatus(native)).toBe(variant);
    },
  );

  it("getStatus accepts the enum wire form end to end", async () => {
    readsReturn(["Active"]);
    await expect(new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0).getStatus()).resolves.toBe("Active");
  });

  it("boundary values the contract allows are accepted", () => {
    expect(mapRawConfig({ ...WIRE_CONFIG, round_deadline_ledgers: 100 }).roundDeadlineLedgers).toBe(100);
    expect(mapRawConfig({ ...WIRE_CONFIG, round_deadline_ledgers: 1_036_800 }).roundDeadlineLedgers).toBe(1_036_800);
    expect(mapRawConfig({ ...WIRE_CONFIG, round_amount: 1n }).roundAmount).toBe(1n);
    expect(mapRawRoundState({ ...WIRE_ROUND, deadline_ledger: U64_MAX }).deadlineLedger).toBe(U64_MAX);
  });
});

// ─── Wrong variants ───────────────────────────────────────────────────────────

describe("wrong variants", () => {
  it.each([
    [["Bogus"], /Bogus/],
    [["Active", 1], /Active/],
    [[], /Expected one of/],
    ["active", /active/],
    [{ Active: null }, /Active/],
    [0, /Expected one of/],
  ])("assertValidCircleStatus rejects %j", (value, message) => {
    expect(() => assertValidCircleStatus(value)).toThrow(message);
  });

  it("getStatusResult names the unexpected status", async () => {
    readsReturn(["Running"]);
    const r = await new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0).getStatusResult();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Running");
  });

  it.each([
    ["an array (a Vec, not a struct)", [WIRE_CONFIG]],
    ["a Map", new Map(Object.entries(WIRE_CONFIG))],
    ["a string", "config"],
  ])("mapRawConfig rejects %s", (_label, value) => {
    expect(() => mapRawConfig(value)).toThrow(/mapRawConfig: expected a CircleConfig object/);
  });

  it("mapRawRoundState rejects an enum-shaped value", () => {
    expect(() => mapRawRoundState(["RoundState"])).toThrow(/expected a RoundState object/);
  });

  it("getCollateral rejects a non-integer wire value", async () => {
    readsReturn("100");
    await expect(
      new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0).getCollateral(MEMBER_A_ADDR),
    ).rejects.toThrow(/getCollateral/);
  });

  it("createCircle does not report an account address as the new circle", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "buildAndSend").mockResolvedValue({
      success: true,
      txHash: "H",
      ledger: 1,
      returnValue: MEMBER_A_ADDR, // a G-address, not a circle contract
    });
    const { result, circleAddress } = await new FactoryClient(SDK_CONFIG).createCircle({
      creator: CREATOR,
      members: [MEMBER_A_ADDR, MEMBER_B_ADDR],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: 120_960,
    });
    expect(result.success).toBe(true);
    expect(circleAddress).toBeUndefined();
  });
});

// ─── Absent fields ────────────────────────────────────────────────────────────

describe("absent fields", () => {
  it("lists every missing CircleConfig field at once", () => {
    const { usdc_token: _u, round_amount: _r, ...partial } = WIRE_CONFIG;
    expect(() => mapRawConfig(partial)).toThrow(
      /missing required fields "round_amount", "usdc_token"/,
    );
  });

  it("names the fields that were present, so a rename is visible", () => {
    const { paid_out: _p, ...rest } = WIRE_ROUND;
    expect(() => mapRawRoundState({ ...rest, is_paid_out: false })).toThrow(/"is_paid_out"/);
  });

  it("treats an explicit undefined as missing", () => {
    expect(() => mapRawRoundState({ ...WIRE_ROUND, recipient: undefined })).toThrow(
      /missing required field "recipient"/,
    );
  });

  it("decodeRecord accepts extra fields", () => {
    expect(decodeRecord({ a: 1, extra: 2 }, "t", ["a"])).toEqual({ a: 1, extra: 2 });
  });

  it("getCurrentRoundResult surfaces the missing field", async () => {
    const { deadline_ledger: _d, ...rest } = WIRE_ROUND;
    readsReturn(rest);
    const r = await new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0).getCurrentRoundResult();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"deadline_ledger"');
  });
});

// ─── Out-of-range values ──────────────────────────────────────────────────────

describe("out-of-range values", () => {
  it.each([
    ["round_amount of 0", { round_amount: 0n }, /round_amount: expected a value >= 1/],
    ["a negative round_amount", { round_amount: -5n }, /round_amount/],
    ["a round_amount past i128", { round_amount: I128_MAX + 1n }, /out of range for i128/],
    ["a deadline below the contract minimum", { round_deadline_ledgers: 99 }, /\[100, 1036800\]/],
    ["a deadline above the contract maximum", { round_deadline_ledgers: 1_036_801 }, /\[100, 1036800\]/],
    ["duplicate members", { members: [MEMBER_A_ADDR, MEMBER_A_ADDR] }, /index 0 and index 1/],
    [
      "more than 256 members",
      { members: Array.from({ length: 257 }, (_, i) => testKeypair(i % 255).publicKey()) },
      /at most 256/,
    ],
  ])("mapRawConfig rejects %s", (_label, patch, message) => {
    expect(() => mapRawConfig({ ...WIRE_CONFIG, ...patch })).toThrow(message);
  });

  it.each([
    ["a negative deadline_ledger", { deadline_ledger: -1n }, /deadline_ledger.*u64/],
    ["a deadline_ledger past u64", { deadline_ledger: U64_MAX + 1n }, /deadline_ledger.*u64/],
    ["contributions_received past 256", { contributions_received: 257 }, /contributions_received/],
    ["a negative round_index", { round_index: -1 }, /round_index/],
  ])("mapRawRoundState rejects %s", (_label, patch, message) => {
    expect(() => mapRawRoundState({ ...WIRE_ROUND, ...patch })).toThrow(message);
  });

  it("getCollateral rejects a negative balance", async () => {
    readsReturn(-1n);
    await expect(
      new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0).getCollateral(MEMBER_A_ADDR),
    ).rejects.toThrow(/getCollateral: expected a value >= 0/);
  });

  it("getCollateral accepts zero and a large i128", async () => {
    const client = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0);
    readsReturn(0n);
    await expect(client.getCollateral(MEMBER_A_ADDR)).resolves.toBe(0n);
    vi.restoreAllMocks();
    readsReturn(I128_MAX);
    await expect(client.getCollateral(MEMBER_A_ADDR)).resolves.toBe(I128_MAX);
  });
});

// ─── Narrow decoders ──────────────────────────────────────────────────────────

describe("narrow decoders", () => {
  it("decodeI128 enforces width and an optional minimum", () => {
    expect(decodeI128(-(1n << 127n), "t")).toBe(-(1n << 127n));
    expect(() => decodeI128(-(1n << 127n) - 1n, "t")).toThrow(/i128/);
    expect(() => decodeI128(4n, "t", { min: 5n })).toThrow(/>= 5/);
    expect(decodeI128(7, "t")).toBe(7n);
  });

  it("decodeU64 enforces [0, 2^64 - 1]", () => {
    expect(decodeU64(0n, "t")).toBe(0n);
    expect(() => decodeU64(-1n, "t")).toThrow(/u64/);
    expect(() => decodeU64(U64_MAX + 1n, "t")).toThrow(/u64/);
  });

  it("decodeU32InRange checks the type before the range", () => {
    expect(() => decodeU32InRange(5n, "t", 0, 10)).toThrow(/expected a u32/);
    expect(() => decodeU32InRange(11, "t", 0, 10)).toThrow(/\[0, 10\]/);
    expect(decodeU32InRange(10, "t", 0, 10)).toBe(10);
  });

  it("decodeAddressList keeps duplicates unless asked to reject them", () => {
    expect(decodeAddressList([MEMBER_A_ADDR, MEMBER_A_ADDR], "t")).toHaveLength(2);
    expect(() =>
      decodeAddressList([MEMBER_A_ADDR, MEMBER_A_ADDR], "t", { unique: true }),
    ).toThrow(/appears at both/);
  });
});
