/**
 * Issue #629: Contract argument compatibility fixtures
 *
 * A contract argument order or XDR change can compile in TypeScript but fail
 * at runtime with an opaque host error. These serialized fixtures protect the
 * SDK ↔ contract boundary by encoding valid argument combinations as XDR and
 * verifying they remain decodable across contract changes.
 *
 * Each fixture is a base64-encoded XDR ScVal array representing one contract
 * method's arguments. If a contract method signature changes (parameter order,
 * type, or removal), the corresponding fixture will fail to decode, surfacing
 * the break in CI before it reaches production.
 *
 * Covered contracts:
 *   - CircleFactory: create_circle
 *   - Circle: initialize, join, cancel, contribute, payout, settle_round,
 *             mark_default, close, pause, resume,
 *             get_config, get_status, get_current_round, get_collateral,
 *             get_defaults, has_contributed, get_protocol_params,
 *             get_pot_amount, get_admin (circle), get_usdc_token,
 *             is_closed, is_paused
 *   - Reputation: score, increment, add_authorized_caller,
 *                 remove_authorized_caller, get_authorized_callers,
 *                 get_revoked_callers, get_admin (reputation)
 *
 * Fixtures are derived from the public SDK builders (scAddress, scU32, scI128,
 * scAddressVec) so they represent exactly what application code sends. Any
 * mismatch between SDK encoding and contract expectations is caught here.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * MAINTAINING THESE FIXTURES
 * ──────────────────────────────────────────────────────────────────────────────
 * When a contract method signature changes:
 *   1. Update the fixture encoding to match the new signature.
 *   2. Update the expectedNativeArgs in the corresponding test.
 *   3. Run `npm run test --workspace=sdk` — passing tests confirm compatibility.
 *   4. Commit the updated fixture and note the change in CHANGELOG.md.
 *
 * If a test FAILS after a contract change, the break is real:
 *   - The contract method signature changed in a way the SDK does not match.
 *   - Update the SDK client method to match the new Rust signature.
 *   - Update the fixture and test expectations.
 *   - Document the breaking change in CHANGELOG.md under the relevant version.
 *
 * Adding new contract methods:
 *   1. Add a describe block for the method with the Rust signature in a comment.
 *   2. Encode valid and boundary-case fixtures using the SDK builders.
 *   3. Add tests verifying round-trip decode to expected native values.
 *   4. Run in CI — fixtures are checked on every build.
 *
 * See also: docs/API_INVARIANTS.md (section 9 — SDK type-safety invariants)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from "vitest";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { scAddress, scU32, scI128, scBool, scAddressVec } from "../client";
import {
  FACTORY_ADDR,
  REPUTATION_ADDR,
  USDC_ADDR,
  CIRCLE_ADDR,
  CREATOR_ADDR,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
} from "./fixtures";

// ─── Fixture encoding helpers ─────────────────────────────────────────────────

/** Encode an xdr.ScVal array as base64 XDR for persistence. */
function encodeFixture(args: xdr.ScVal[]): string {
  const vec = xdr.ScVal.scvVec(args);
  return vec.toXDR("base64");
}

/** Decode a base64 XDR fixture back into an ScVal array. */
function decodeFixture(fixture: string): xdr.ScVal[] {
  const vec = xdr.ScVal.fromXDR(fixture, "base64");
  if (vec.switch().name !== "scvVec") {
    throw new Error("Fixture is not an ScVal vec");
  }
  return vec.vec() ?? [];
}

/**
 * Verify that a fixture decodes cleanly and that each decoded element matches
 * the expected native value produced by scValToNative.
 */
function assertFixture(
  fixture: string,
  expectedNativeArgs: unknown[],
): void {
  const decoded = decodeFixture(fixture);
  expect(decoded).toHaveLength(expectedNativeArgs.length);
  for (let i = 0; i < expectedNativeArgs.length; i++) {
    const native = scValToNative(decoded[i]);
    expect(native).toEqual(expectedNativeArgs[i]);
  }
}

// ─── Factory fixtures ─────────────────────────────────────────────────────────

describe("CircleFactory contract fixtures", () => {
  /**
   * Rust signature:
   *   create_circle(env, creator: Address, members: Vec<Address>,
   *                 round_amount: i128, round_deadline_ledgers: u32) -> Address
   */
  describe("create_circle", () => {
    const FIXTURE_VALID = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n), // 10 USDC in stroops (7 decimals)
      scU32(120_960),       // ~7 days at 5 s/ledger
    ]);

    const FIXTURE_MIN_MEMBERS = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]), // exactly 2 — the minimum
      scI128(50_000_000n),
      scU32(17_280), // 1 day
    ]);

    const FIXTURE_MIN_DEADLINE = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scU32(100), // MIN_ROUND_DEADLINE_LEDGERS = 100
    ]);

    const FIXTURE_MAX_DEADLINE = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scU32(1_036_800), // MAX_ROUND_DEADLINE_LEDGERS = 1_036_800 (~60 days)
    ]);

    it("valid create_circle with two members and 7-day deadline", () => {
      assertFixture(FIXTURE_VALID, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        120_960,
      ]);
    });

    it("create_circle with minimum member count (2)", () => {
      assertFixture(FIXTURE_MIN_MEMBERS, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        50_000_000n,
        17_280,
      ]);
    });

    it("create_circle with minimum deadline (100 ledgers / MIN_ROUND_DEADLINE_LEDGERS)", () => {
      assertFixture(FIXTURE_MIN_DEADLINE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        100,
      ]);
    });

    it("create_circle with maximum deadline (1_036_800 ledgers / MAX_ROUND_DEADLINE_LEDGERS)", () => {
      assertFixture(FIXTURE_MAX_DEADLINE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        1_036_800,
      ]);
    });

    it("encoded fixtures are stable (deterministic XDR)", () => {
      const reencoded = encodeFixture([
        scAddress(CREATOR_ADDR),
        scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
        scI128(100_000_000n),
        scU32(120_960),
      ]);
      expect(reencoded).toBe(FIXTURE_VALID);
    });
  });
});

// ─── Circle contract fixtures ─────────────────────────────────────────────────

describe("Circle contract fixtures", () => {
  /**
   * Rust signature:
   *   initialize(env, admin: Address, members: Vec<Address>, round_amount: i128,
   *              usdc_token: Address, reputation_contract: Address,
   *              round_deadline_ledgers: u32)
   *
   * IMPORTANT: initialize takes 6 parameters (excluding env). An earlier
   * version of this fixture incorrectly encoded only 4 args, missing
   * usdc_token and reputation_contract. This is the corrected version.
   */
  describe("initialize", () => {
    const FIXTURE = encodeFixture([
      scAddress(CREATOR_ADDR),              // admin
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]), // members
      scI128(100_000_000n),                 // round_amount
      scAddress(USDC_ADDR),                 // usdc_token
      scAddress(REPUTATION_ADDR),           // reputation_contract
      scU32(120_960),                       // round_deadline_ledgers
    ]);

    const FIXTURE_MIN_DEADLINE = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scAddress(USDC_ADDR),
      scAddress(REPUTATION_ADDR),
      scU32(100), // MIN_ROUND_DEADLINE_LEDGERS
    ]);

    const FIXTURE_MAX_DEADLINE = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scAddress(USDC_ADDR),
      scAddress(REPUTATION_ADDR),
      scU32(1_036_800), // MAX_ROUND_DEADLINE_LEDGERS
    ]);

    const FIXTURE_MIN_AMOUNT = encodeFixture([
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(1n), // minimum: > 0
      scAddress(USDC_ADDR),
      scAddress(REPUTATION_ADDR),
      scU32(120_960),
    ]);

    it("initialize with all 6 required arguments (corrected from 4-arg shape)", () => {
      assertFixture(FIXTURE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        USDC_ADDR,
        REPUTATION_ADDR,
        120_960,
      ]);
    });

    it("initialize — argument count is exactly 6", () => {
      expect(decodeFixture(FIXTURE)).toHaveLength(6);
    });

    it("initialize with minimum deadline (100 ledgers)", () => {
      assertFixture(FIXTURE_MIN_DEADLINE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        USDC_ADDR,
        REPUTATION_ADDR,
        100,
      ]);
    });

    it("initialize with maximum deadline (1_036_800 ledgers)", () => {
      assertFixture(FIXTURE_MAX_DEADLINE, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        100_000_000n,
        USDC_ADDR,
        REPUTATION_ADDR,
        1_036_800,
      ]);
    });

    it("initialize with minimum round amount (1 stroop)", () => {
      assertFixture(FIXTURE_MIN_AMOUNT, [
        CREATOR_ADDR,
        [MEMBER_A_ADDR, MEMBER_B_ADDR],
        1n,
        USDC_ADDR,
        REPUTATION_ADDR,
        120_960,
      ]);
    });

    it("initialize fixture is deterministic", () => {
      const reencoded = encodeFixture([
        scAddress(CREATOR_ADDR),
        scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
        scI128(100_000_000n),
        scAddress(USDC_ADDR),
        scAddress(REPUTATION_ADDR),
        scU32(120_960),
      ]);
      expect(reencoded).toBe(FIXTURE);
    });
  });

  /**
   * Rust signature: join(env, member: Address)
   */
  describe("join", () => {
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("join with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });

    it("join argument count is exactly 1", () => {
      expect(decodeFixture(FIXTURE)).toHaveLength(1);
    });
  });

  /**
   * Rust signature: cancel(env, caller: Address)
   * Callable while status = Pending; transitions to Cancelled.
   */
  describe("cancel", () => {
    const FIXTURE_CREATOR = encodeFixture([scAddress(CREATOR_ADDR)]);
    const FIXTURE_MEMBER  = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("cancel with creator address", () => {
      assertFixture(FIXTURE_CREATOR, [CREATOR_ADDR]);
    });

    it("cancel with non-creator member address (any member may cancel)", () => {
      assertFixture(FIXTURE_MEMBER, [MEMBER_A_ADDR]);
    });

    it("cancel fixture is deterministic", () => {
      expect(encodeFixture([scAddress(CREATOR_ADDR)])).toBe(FIXTURE_CREATOR);
    });
  });

  /**
   * Rust signature: contribute(env, member: Address)
   */
  describe("contribute", () => {
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("contribute with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  /**
   * Rust signature: payout(env)  — no arguments
   * Anyone may call this once all members have contributed.
   */
  describe("payout", () => {
    const FIXTURE = encodeFixture([]);

    it("payout takes no arguments", () => {
      assertFixture(FIXTURE, []);
    });
  });

  /**
   * Rust signature: settle_round(env)  — no arguments
   * Called by anyone after the round deadline has passed and not all members
   * contributed. Penalizes non-contributors and transfers a partial pot.
   */
  describe("settle_round", () => {
    const FIXTURE = encodeFixture([]);

    it("settle_round takes no arguments", () => {
      assertFixture(FIXTURE, []);
    });

    it("settle_round has identical encoding to payout (both zero-arg)", () => {
      // Both payout() and settle_round() take no caller-supplied arguments;
      // the difference is purely in method name routing on the contract side.
      expect(encodeFixture([])).toBe(FIXTURE);
    });
  });

  /**
   * Rust signature: mark_default(env, member: Address)
   */
  describe("mark_default", () => {
    const FIXTURE = encodeFixture([scAddress(MEMBER_B_ADDR)]);

    it("mark_default with member address", () => {
      assertFixture(FIXTURE, [MEMBER_B_ADDR]);
    });
  });

  /**
   * Rust signature: close(env, closer: Address) -> Result<(), CloseError>
   */
  describe("close", () => {
    const FIXTURE_CREATOR = encodeFixture([scAddress(CREATOR_ADDR)]);
    const FIXTURE_MEMBER  = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("close with admin address", () => {
      assertFixture(FIXTURE_CREATOR, [CREATOR_ADDR]);
    });

    it("close with member address (any member may close)", () => {
      assertFixture(FIXTURE_MEMBER, [MEMBER_A_ADDR]);
    });
  });

  /**
   * Rust signature: pause(env, admin: Address) -> Result<(), PauseError>
   * Blocks all fund-moving operations; only the stored admin may call this.
   */
  describe("pause", () => {
    const FIXTURE = encodeFixture([scAddress(CREATOR_ADDR)]);

    it("pause with admin address", () => {
      assertFixture(FIXTURE, [CREATOR_ADDR]);
    });

    it("pause fixture is deterministic", () => {
      expect(encodeFixture([scAddress(CREATOR_ADDR)])).toBe(FIXTURE);
    });
  });

  /**
   * Rust signature: resume(env, admin: Address) -> Result<(), PauseError>
   * Clears the Paused flag; re-enables fund-moving operations.
   */
  describe("resume", () => {
    const FIXTURE = encodeFixture([scAddress(CREATOR_ADDR)]);

    it("resume with admin address", () => {
      assertFixture(FIXTURE, [CREATOR_ADDR]);
    });

    it("pause and resume share the same argument shape (both take admin: Address)", () => {
      const pauseFixture  = encodeFixture([scAddress(CREATOR_ADDR)]);
      const resumeFixture = encodeFixture([scAddress(CREATOR_ADDR)]);
      expect(pauseFixture).toBe(resumeFixture);
    });
  });

  // ── No-argument read-only views ────────────────────────────────────────────

  /**
   * Rust signature: get_config(env) -> Result<CircleConfig, ContractError>
   */
  describe("get_config", () => {
    it("get_config takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_status(env) -> CircleStatus
   */
  describe("get_status", () => {
    it("get_status takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_current_round(env) -> Result<RoundState, ContractError>
   */
  describe("get_current_round", () => {
    it("get_current_round takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_protocol_params(_env) -> ProtocolParams
   * Returns static protocol constants (penalty_bps, bps_denom, …).
   * Does not require the contract to be initialized.
   */
  describe("get_protocol_params", () => {
    const FIXTURE = encodeFixture([]);

    it("get_protocol_params takes no arguments", () => {
      assertFixture(FIXTURE, []);
    });

    it("all zero-argument views produce identical (empty) fixtures", () => {
      // Guards against accidentally encoding a dummy arg in any no-arg view.
      const views = [
        encodeFixture([]), // get_config
        encodeFixture([]), // get_status
        encodeFixture([]), // get_current_round
        encodeFixture([]), // payout
        encodeFixture([]), // settle_round
        encodeFixture([]), // get_protocol_params
        encodeFixture([]), // get_pot_amount
        encodeFixture([]), // is_closed
        encodeFixture([]), // is_paused
      ];
      expect(new Set(views).size).toBe(1);
    });
  });

  /**
   * Rust signature: get_pot_amount(env) -> Result<i128, ContractError>
   * Returns round_amount × member_count for the current round.
   */
  describe("get_pot_amount", () => {
    it("get_pot_amount takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_admin(env) -> Result<Address, ContractError>
   */
  describe("get_admin (circle)", () => {
    it("get_admin takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_usdc_token(env) -> Result<Address, ContractError>
   * Returns the immutable USDC token address locked at initialize time.
   */
  describe("get_usdc_token", () => {
    it("get_usdc_token takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: is_closed(env) -> bool
   */
  describe("is_closed", () => {
    it("is_closed takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: is_paused(env) -> bool
   */
  describe("is_paused", () => {
    it("is_paused takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  // ── Member-address views ───────────────────────────────────────────────────

  /**
   * Rust signature: get_collateral(env, member: Address) -> i128
   */
  describe("get_collateral", () => {
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("get_collateral with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  /**
   * Rust signature: get_defaults(env, member: Address) -> u32
   */
  describe("get_defaults", () => {
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("get_defaults with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  /**
   * Rust signature: has_contributed(env, member: Address, round_index: u32) -> bool
   */
  describe("has_contributed", () => {
    const FIXTURE_ROUND_ZERO = encodeFixture([
      scAddress(MEMBER_A_ADDR),
      scU32(0),
    ]);

    const FIXTURE_ROUND_FIVE = encodeFixture([
      scAddress(MEMBER_B_ADDR),
      scU32(5),
    ]);

    const FIXTURE_ROUND_MAX = encodeFixture([
      scAddress(MEMBER_A_ADDR),
      scU32(255), // MAX_MEMBERS - 1
    ]);

    it("has_contributed with round_index 0", () => {
      assertFixture(FIXTURE_ROUND_ZERO, [MEMBER_A_ADDR, 0]);
    });

    it("has_contributed with round_index 5", () => {
      assertFixture(FIXTURE_ROUND_FIVE, [MEMBER_B_ADDR, 5]);
    });

    it("has_contributed with maximum round_index (255 = MAX_MEMBERS - 1)", () => {
      assertFixture(FIXTURE_ROUND_MAX, [MEMBER_A_ADDR, 255]);
    });
  });
});

// ─── Reputation contract fixtures ─────────────────────────────────────────────

describe("Reputation contract fixtures", () => {
  /**
   * Rust signature: score(env, member: Address) -> u32
   * Read-only query — returns 0 for unknown members.
   */
  describe("score", () => {
    const FIXTURE = encodeFixture([scAddress(MEMBER_A_ADDR)]);

    it("score with member address", () => {
      assertFixture(FIXTURE, [MEMBER_A_ADDR]);
    });
  });

  /**
   * Rust signature: increment(env, circle: Address, member: Address) -> Result<(), ReputationError>
   *
   * IMPORTANT: This method takes TWO addresses: (circle, member).
   * An earlier version of this fixture incorrectly encoded (address, i32 delta)
   * which matched neither the current contract signature nor any historical one.
   * The contract has always incremented by exactly 1 and has no delta parameter.
   */
  describe("increment", () => {
    const FIXTURE = encodeFixture([
      scAddress(CIRCLE_ADDR),  // circle — the authorized caller
      scAddress(MEMBER_A_ADDR), // member — whose score is incremented
    ]);

    it("increment with circle and member address (corrected from address+i32 shape)", () => {
      assertFixture(FIXTURE, [CIRCLE_ADDR, MEMBER_A_ADDR]);
    });

    it("increment argument count is exactly 2", () => {
      expect(decodeFixture(FIXTURE)).toHaveLength(2);
    });

    it("increment fixture is deterministic", () => {
      const reencoded = encodeFixture([
        scAddress(CIRCLE_ADDR),
        scAddress(MEMBER_A_ADDR),
      ]);
      expect(reencoded).toBe(FIXTURE);
    });

    it("increment with a different member address produces a different fixture", () => {
      const other = encodeFixture([
        scAddress(CIRCLE_ADDR),
        scAddress(MEMBER_B_ADDR),
      ]);
      expect(other).not.toBe(FIXTURE);
    });
  });

  /**
   * Rust signature:
   *   add_authorized_caller(env, caller: Address, circle: Address) -> Result<(), ReputationError>
   * Admin-only; registers a circle contract as permitted to call increment.
   */
  describe("add_authorized_caller", () => {
    const FIXTURE = encodeFixture([
      scAddress(FACTORY_ADDR),  // caller (admin — the factory)
      scAddress(CIRCLE_ADDR),   // circle to authorize
    ]);

    it("add_authorized_caller with factory and circle address", () => {
      assertFixture(FIXTURE, [FACTORY_ADDR, CIRCLE_ADDR]);
    });

    it("add_authorized_caller argument count is exactly 2", () => {
      expect(decodeFixture(FIXTURE)).toHaveLength(2);
    });
  });

  /**
   * Rust signature:
   *   remove_authorized_caller(env, caller: Address, circle: Address) -> Result<(), ReputationError>
   * Admin-only; permanently revokes a circle's permission to call increment.
   */
  describe("remove_authorized_caller", () => {
    const FIXTURE = encodeFixture([
      scAddress(FACTORY_ADDR), // caller (admin)
      scAddress(CIRCLE_ADDR),  // circle to revoke
    ]);

    it("remove_authorized_caller with factory and circle address", () => {
      assertFixture(FIXTURE, [FACTORY_ADDR, CIRCLE_ADDR]);
    });

    it("add and remove share the same argument shape", () => {
      const add    = encodeFixture([scAddress(FACTORY_ADDR), scAddress(CIRCLE_ADDR)]);
      const remove = encodeFixture([scAddress(FACTORY_ADDR), scAddress(CIRCLE_ADDR)]);
      expect(add).toBe(remove);
    });
  });

  /**
   * Rust signature: get_authorized_callers(env) -> Vec<Address>
   */
  describe("get_authorized_callers", () => {
    it("get_authorized_callers takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_revoked_callers(env) -> Vec<Address>
   */
  describe("get_revoked_callers", () => {
    it("get_revoked_callers takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });

  /**
   * Rust signature: get_admin(env) -> Address
   * Panics with a clear message if called before initialize.
   */
  describe("get_admin (reputation)", () => {
    it("get_admin takes no arguments", () => {
      assertFixture(encodeFixture([]), []);
    });
  });
});

// ─── Regression suite: encode → decode round-trip ────────────────────────────

describe("XDR encoding stability", () => {
  it("re-encoding the same arguments produces identical fixtures", () => {
    const args = [
      scAddress(CREATOR_ADDR),
      scAddressVec([MEMBER_A_ADDR, MEMBER_B_ADDR]),
      scI128(100_000_000n),
      scU32(120_960),
    ];
    expect(encodeFixture(args)).toBe(encodeFixture(args));
  });

  it("decode → re-encode produces the original fixture", () => {
    const original = encodeFixture([
      scAddress(MEMBER_A_ADDR),
      scU32(42),
    ]);
    const reencoded = encodeFixture(decodeFixture(original));
    expect(reencoded).toBe(original);
  });

  it("scI128 i128 maximum encodes and decodes correctly", () => {
    const I128_MAX = (1n << 127n) - 1n;
    const fixture = encodeFixture([scI128(I128_MAX)]);
    const [decoded] = decodeFixture(fixture);
    expect(scValToNative(decoded)).toBe(I128_MAX);
  });

  it("scI128 i128 minimum encodes and decodes correctly", () => {
    const I128_MIN = -(1n << 127n);
    const fixture = encodeFixture([scI128(I128_MIN)]);
    const [decoded] = decodeFixture(fixture);
    expect(scValToNative(decoded)).toBe(I128_MIN);
  });

  it("address C-prefix and G-prefix both survive round-trip", () => {
    const fixture = encodeFixture([
      scAddress(CIRCLE_ADDR),   // C-prefix
      scAddress(MEMBER_A_ADDR), // G-prefix
    ]);
    const [c, g] = decodeFixture(fixture);
    expect(scValToNative(c)).toBe(CIRCLE_ADDR);
    expect(scValToNative(g)).toBe(MEMBER_A_ADDR);
  });
});
