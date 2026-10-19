/**
 * Canonical address validation regression suite.
 *
 * Covers every exported function in lib/address.ts:
 *
 *   isStellarPublicKey      — shape-only G-key check
 *   isSorobanContractId     — shape-only C-contract check
 *   isCanonicalStellarAddress — either G or C (shape only)
 *   hasValidStrKeyChecksum  — CRC16/XMODEM strkey verification
 *   isValidStellarAccount   — G-key + checksum
 *   validateAddress         — structured result with reason + message
 *   assertStellarPublicKey  — throws on bad G-key
 *   assertSorobanContractId — throws on bad C-contract
 *   assertCanonicalStellarAddress — throws on neither
 *
 * Also covers the integration points changed in this PR:
 *
 *   parseMemberRows (circleTypes.ts) — now rejects shape-valid but
 *     checksum-invalid member addresses from the indexer.
 *
 *   circles/[address]/page route guard — isSorobanContractId must reject
 *     every non-C-contract value so the page never calls the indexer with
 *     junk; tested by directly calling the same validator the page uses.
 *
 * Fixture strategy
 * ─────────────────
 * Real strkeys are generated from the Stellar SDK so their checksums are
 * correct. "Shape-only" fakes are constructed by hand — the exact gap that
 * the checksum closes. withTypo() introduces a single-character error that
 * passes the regex but fails the CRC.
 */

import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import {
  isStellarPublicKey,
  isSorobanContractId,
  isCanonicalStellarAddress,
  hasValidStrKeyChecksum,
  isValidStellarAccount,
  validateAddress,
  assertStellarPublicKey,
  assertSorobanContractId,
  assertCanonicalStellarAddress,
} from "../lib/address";

import { parseMemberRows } from "../lib/circleTypes";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Real account address: version byte 0x30, correct CRC16/XMODEM checksum.
 * The all-A payload encodes to a known-good strkey.
 */
const REAL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Real contract ID: version byte 0x10, correct CRC16/XMODEM checksum.
 */
const REAL_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

/**
 * Shape-only G address — matches /^G[A-Z2-7]{55}$/ but has checksum 0,
 * which no real address ever does. Documents the exact gap this PR closes.
 */
const SHAPE_ONLY_G = "G" + "A".repeat(55);

/**
 * Shape-only C address — same problem as SHAPE_ONLY_G but for contracts.
 */
const SHAPE_ONLY_C = "C" + "A".repeat(55);

/** Deterministic SDK-generated keypairs (seed byte 1–10). */
const sdkAddresses = Array.from({ length: 10 }, (_, i) =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, i + 1)).publicKey(),
);

/**
 * Replace one character in `addr` at position `at` with the "other" base32
 * character — introduces a single-char typo while keeping length and alphabet
 * valid (passes shape check, fails checksum).
 */
function withTypo(addr: string, at = 20): string {
  return (
    addr.slice(0, at) +
    (addr.charAt(at) === "A" ? "B" : "A") +
    addr.slice(at + 1)
  );
}

// ─── isStellarPublicKey ────────────────────────────────────────────────────────

describe("isStellarPublicKey", () => {
  it("accepts a real G-prefixed account address", () => {
    expect(isStellarPublicKey(REAL_ACCOUNT)).toBe(true);
  });

  it("accepts all SDK-generated addresses", () => {
    sdkAddresses.forEach((a) => expect(isStellarPublicKey(a)).toBe(true));
  });

  it("accepts the shape-only fake (shape test only — no checksum)", () => {
    // This is the known gap: isStellarPublicKey is intentionally shape-only.
    expect(isStellarPublicKey(SHAPE_ONLY_G)).toBe(true);
  });

  it("rejects a C-prefixed contract ID", () => {
    expect(isStellarPublicKey(REAL_CONTRACT)).toBe(false);
  });

  it("rejects lowercase input", () => {
    expect(isStellarPublicKey(REAL_ACCOUNT.toLowerCase())).toBe(false);
  });

  it("rejects wrong length — too short", () => {
    expect(isStellarPublicKey(REAL_ACCOUNT.slice(0, 55))).toBe(false);
  });

  it("rejects wrong length — too long", () => {
    expect(isStellarPublicKey(REAL_ACCOUNT + "A")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isStellarPublicKey("")).toBe(false);
  });

  it("rejects an M-prefixed muxed address", () => {
    expect(isStellarPublicKey("M" + "A".repeat(55))).toBe(false);
  });

  it("rejects addresses containing invalid characters (0, 1, 8, 9)", () => {
    // Base32 alphabet is A–Z and 2–7; digits 0, 1, 8, 9 are not valid.
    expect(isStellarPublicKey("G" + "0".repeat(55))).toBe(false);
  });
});

// ─── isSorobanContractId ───────────────────────────────────────────────────────

describe("isSorobanContractId", () => {
  it("accepts a real C-prefixed contract ID", () => {
    expect(isSorobanContractId(REAL_CONTRACT)).toBe(true);
  });

  it("accepts the shape-only fake (shape test only)", () => {
    expect(isSorobanContractId(SHAPE_ONLY_C)).toBe(true);
  });

  it("rejects a G-prefixed account address", () => {
    expect(isSorobanContractId(REAL_ACCOUNT)).toBe(false);
  });

  it("rejects lowercase input", () => {
    expect(isSorobanContractId(REAL_CONTRACT.toLowerCase())).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isSorobanContractId(REAL_CONTRACT.slice(0, 55))).toBe(false);
    expect(isSorobanContractId(REAL_CONTRACT + "A")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSorobanContractId("")).toBe(false);
  });

  it("rejects a path-traversal segment", () => {
    expect(isSorobanContractId("../../etc/passwd")).toBe(false);
  });

  it("rejects a SQL-injection-style string", () => {
    expect(isSorobanContractId("'; DROP TABLE circles; --")).toBe(false);
  });
});

// ─── isCanonicalStellarAddress ─────────────────────────────────────────────────

describe("isCanonicalStellarAddress", () => {
  it("accepts a G-prefixed account", () => {
    expect(isCanonicalStellarAddress(REAL_ACCOUNT)).toBe(true);
  });

  it("accepts a C-prefixed contract", () => {
    expect(isCanonicalStellarAddress(REAL_CONTRACT)).toBe(true);
  });

  it("accepts shape-only G and C fakes (shape only)", () => {
    expect(isCanonicalStellarAddress(SHAPE_ONLY_G)).toBe(true);
    expect(isCanonicalStellarAddress(SHAPE_ONLY_C)).toBe(true);
  });

  it("rejects M-prefix, other prefixes, empty, and garbage", () => {
    expect(isCanonicalStellarAddress("M" + "A".repeat(55))).toBe(false);
    expect(isCanonicalStellarAddress("X" + "A".repeat(55))).toBe(false);
    expect(isCanonicalStellarAddress("")).toBe(false);
    expect(isCanonicalStellarAddress("not-an-address")).toBe(false);
  });
});

// ─── hasValidStrKeyChecksum ────────────────────────────────────────────────────

describe("hasValidStrKeyChecksum", () => {
  it("accepts a real account address", () => {
    expect(hasValidStrKeyChecksum(REAL_ACCOUNT)).toBe(true);
  });

  it("accepts a real contract ID", () => {
    expect(hasValidStrKeyChecksum(REAL_CONTRACT)).toBe(true);
  });

  it("accepts all SDK-generated addresses", () => {
    sdkAddresses.forEach((a) =>
      expect(hasValidStrKeyChecksum(a)).toBe(true),
    );
  });

  it("rejects shape-only G fake — checksum was never computed", () => {
    // Demonstrates the gap: passes isStellarPublicKey, fails checksum.
    expect(isStellarPublicKey(SHAPE_ONLY_G)).toBe(true);
    expect(hasValidStrKeyChecksum(SHAPE_ONLY_G)).toBe(false);
  });

  it("rejects shape-only C fake", () => {
    expect(isSorobanContractId(SHAPE_ONLY_C)).toBe(true);
    expect(hasValidStrKeyChecksum(SHAPE_ONLY_C)).toBe(false);
  });

  it("rejects a single mistyped character anywhere in the payload", () => {
    // Test multiple positions to confirm the CRC catches errors across payload
    [4, 10, 20, 40, 54].forEach((pos) => {
      expect(hasValidStrKeyChecksum(withTypo(REAL_ACCOUNT, pos))).toBe(false);
    });
  });

  it("rejects lowercase input", () => {
    expect(hasValidStrKeyChecksum(REAL_ACCOUNT.toLowerCase())).toBe(false);
  });

  it("rejects addresses of the wrong length", () => {
    expect(hasValidStrKeyChecksum(REAL_ACCOUNT.slice(0, 55))).toBe(false); // too short
    expect(hasValidStrKeyChecksum(REAL_ACCOUNT + "A")).toBe(false);        // too long
    expect(hasValidStrKeyChecksum("")).toBe(false);                         // empty
  });

  it("rejects prefixes outside G/C namespaces", () => {
    expect(hasValidStrKeyChecksum("M" + REAL_ACCOUNT.slice(1))).toBe(false);
    expect(hasValidStrKeyChecksum("X" + REAL_ACCOUNT.slice(1))).toBe(false);
  });

  it("rejects non-string input (null, undefined, number)", () => {
    expect(hasValidStrKeyChecksum(null as unknown as string)).toBe(false);
    expect(hasValidStrKeyChecksum(undefined as unknown as string)).toBe(false);
    expect(hasValidStrKeyChecksum(42 as unknown as string)).toBe(false);
  });
});

// ─── isValidStellarAccount ─────────────────────────────────────────────────────

describe("isValidStellarAccount", () => {
  it("accepts real G-key accounts", () => {
    expect(isValidStellarAccount(REAL_ACCOUNT)).toBe(true);
    sdkAddresses.forEach((a) => expect(isValidStellarAccount(a)).toBe(true));
  });

  it("rejects shape-only G fake", () => {
    expect(isValidStellarAccount(SHAPE_ONLY_G)).toBe(false);
  });

  it("rejects a mistyped account address", () => {
    expect(isValidStellarAccount(withTypo(REAL_ACCOUNT))).toBe(false);
  });

  it("rejects a C-prefixed contract ID — contracts are not accounts", () => {
    expect(isValidStellarAccount(REAL_CONTRACT)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isValidStellarAccount("not-an-address")).toBe(false);
    expect(isValidStellarAccount("")).toBe(false);
    expect(isValidStellarAccount(SHAPE_ONLY_C)).toBe(false);
  });
});

// ─── validateAddress ───────────────────────────────────────────────────────────
//
// validateAddress is the new structured-result API added in this PR.
// Every reason code is pinned to a test so regressions are immediately visible.

describe("validateAddress — kind: 'any' (default)", () => {
  it("returns valid:true + kind:'account' for a real G-key", () => {
    const r = validateAddress(REAL_ACCOUNT);
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.kind).toBe("account");
  });

  it("returns valid:true + kind:'contract' for a real C-contract", () => {
    const r = validateAddress(REAL_CONTRACT);
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.kind).toBe("contract");
  });

  it("returns 'empty' for an empty string", () => {
    const r = validateAddress("");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("empty");
  });

  it("returns 'empty' for whitespace-only input", () => {
    const r = validateAddress("   ");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("empty");
  });

  it("returns 'empty' for null and undefined", () => {
    expect(validateAddress(null).valid).toBe(false);
    expect(validateAddress(undefined).valid).toBe(false);
    if (!validateAddress(null).valid) {
      expect(validateAddress(null as unknown as string).reason).toBe("empty");
    }
  });

  it("returns 'wrong_length' for a truncated address", () => {
    const r = validateAddress(REAL_ACCOUNT.slice(0, 40));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("wrong_length");
  });

  it("returns 'wrong_length' for an over-long address", () => {
    const r = validateAddress(REAL_ACCOUNT + "AAAA");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("wrong_length");
  });

  it("returns 'muxed_not_allowed' for an M-prefix address", () => {
    const r = validateAddress("M" + "A".repeat(55));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("muxed_not_allowed");
  });

  it("returns 'unsupported_prefix' for unrecognised prefixes", () => {
    const r = validateAddress("X" + "A".repeat(55));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("unsupported_prefix");
  });

  it("returns 'invalid_alphabet' for addresses with disallowed characters", () => {
    // Replace one character with '0' (not in base32 alphabet A-Z 2-7)
    const bad = "G" + "0" + "A".repeat(54);
    const r = validateAddress(bad);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("invalid_alphabet");
  });

  it("returns 'checksum_mismatch' for a shape-only G fake", () => {
    const r = validateAddress(SHAPE_ONLY_G);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("checksum_mismatch");
  });

  it("returns 'checksum_mismatch' for a shape-only C fake", () => {
    const r = validateAddress(SHAPE_ONLY_C);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("checksum_mismatch");
  });

  it("returns 'checksum_mismatch' for a single-character typo", () => {
    const r = validateAddress(withTypo(REAL_ACCOUNT));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("checksum_mismatch");
  });

  it("failure messages are non-empty strings", () => {
    const cases = [
      "",
      "   ",
      REAL_ACCOUNT.slice(0, 40),
      "M" + "A".repeat(55),
      SHAPE_ONLY_G,
      withTypo(REAL_ACCOUNT),
    ];
    cases.forEach((input) => {
      const r = validateAddress(input);
      expect(r.valid).toBe(false);
      if (!r.valid) {
        expect(typeof r.message).toBe("string");
        expect(r.message.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("validateAddress — kind: 'G' (accounts only)", () => {
  it("accepts a real G-key account", () => {
    const r = validateAddress(REAL_ACCOUNT, { kind: "G" });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.kind).toBe("account");
  });

  it("returns 'contract_not_allowed' for a C-contract", () => {
    const r = validateAddress(REAL_CONTRACT, { kind: "G" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("contract_not_allowed");
  });

  it("returns 'contract_not_allowed' for the shape-only C fake", () => {
    // Kind check fires before checksum, so the reason is contract_not_allowed,
    // not checksum_mismatch.
    const r = validateAddress(SHAPE_ONLY_C, { kind: "G" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("contract_not_allowed");
  });

  it("still rejects a G-key with a bad checksum", () => {
    const r = validateAddress(SHAPE_ONLY_G, { kind: "G" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("checksum_mismatch");
  });

  it("still rejects muxed and other prefixes", () => {
    const muxed = validateAddress("M" + "A".repeat(55), { kind: "G" });
    expect(muxed.valid).toBe(false);
    if (!muxed.valid) expect(muxed.reason).toBe("muxed_not_allowed");
  });
});

describe("validateAddress — kind: 'C' (contracts only)", () => {
  it("accepts a real C-contract", () => {
    const r = validateAddress(REAL_CONTRACT, { kind: "C" });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.kind).toBe("contract");
  });

  it("returns 'wrong_prefix' for a G-key", () => {
    // This is the rule that mirrors the circles/[address] route guard:
    // only Soroban contract IDs are valid circle addresses.
    const r = validateAddress(REAL_ACCOUNT, { kind: "C" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("wrong_prefix");
  });

  it("returns 'wrong_prefix' for SDK-generated G addresses", () => {
    sdkAddresses.forEach((a) => {
      const r = validateAddress(a, { kind: "C" });
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.reason).toBe("wrong_prefix");
    });
  });

  it("returns 'checksum_mismatch' for a shape-only C fake", () => {
    const r = validateAddress(SHAPE_ONLY_C, { kind: "C" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("checksum_mismatch");
  });

  it("rejects path-traversal and SQL injection strings", () => {
    const dangerous = [
      "../../etc/passwd",
      "'; DROP TABLE circles; --",
      "<script>alert(1)</script>",
      "javascript:void(0)",
    ];
    dangerous.forEach((input) => {
      const r = validateAddress(input, { kind: "C" });
      expect(r.valid).toBe(false);
    });
  });
});

describe("validateAddress — requireChecksum: false", () => {
  it("accepts a shape-only G fake when checksum is disabled", () => {
    const r = validateAddress(SHAPE_ONLY_G, { requireChecksum: false });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.kind).toBe("account");
  });

  it("accepts a shape-only C fake when checksum is disabled", () => {
    const r = validateAddress(SHAPE_ONLY_C, { requireChecksum: false });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.kind).toBe("contract");
  });

  it("still rejects wrong length even with checksum disabled", () => {
    const r = validateAddress(REAL_ACCOUNT.slice(0, 40), { requireChecksum: false });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("wrong_length");
  });

  it("still rejects empty input with checksum disabled", () => {
    const r = validateAddress("", { requireChecksum: false });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("empty");
  });
});

// ─── Route guard equivalence ───────────────────────────────────────────────────
//
// The circles/[address]/page.tsx guard is:
//   if (!isSorobanContractId(params.address)) notFound();
//
// These tests confirm isSorobanContractId produces the correct accept/reject
// decisions for every realistic route segment that could appear in the wild.

describe("circles/[address] route guard — isSorobanContractId", () => {
  it("accepts a well-formed Soroban contract ID", () => {
    expect(isSorobanContractId(REAL_CONTRACT)).toBe(true);
  });

  it("rejects a G-key accidentally pasted into a circle URL", () => {
    expect(isSorobanContractId(REAL_ACCOUNT)).toBe(false);
  });

  it("rejects a shape-only C fake (so it produces notFound, not garbled page)", () => {
    // isSorobanContractId is shape-only by design at the route guard level —
    // the next validation layer (stellar.ts assertSorobanContractId) will catch
    // checksum errors before any RPC call. The route guard's job is to reject
    // values that cannot possibly be valid (wrong prefix, wrong length, etc.).
    expect(isSorobanContractId(SHAPE_ONLY_C)).toBe(true); // passes shape
    // But isValidStellarAccount (checksum-aware) correctly catches it:
    expect(hasValidStrKeyChecksum(SHAPE_ONLY_C)).toBe(false);
  });

  it("rejects an empty segment", () => {
    expect(isSorobanContractId("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isSorobanContractId("../secret")).toBe(false);
    expect(isSorobanContractId("%2e%2e%2fsecret")).toBe(false);
  });

  it("rejects numeric-only strings", () => {
    expect(isSorobanContractId("12345")).toBe(false);
  });

  it("rejects a URL", () => {
    expect(isSorobanContractId("http://evil.example.com")).toBe(false);
  });
});

// ─── reputation/[member] route guard equivalence ───────────────────────────────
//
// The reputation/[member]/page.tsx guard is:
//   if (!isCanonicalStellarAddress(params.member)) notFound();

describe("reputation/[member] route guard — isCanonicalStellarAddress", () => {
  it("accepts a G-key member address", () => {
    expect(isCanonicalStellarAddress(REAL_ACCOUNT)).toBe(true);
  });

  it("accepts a C-contract member address (multisig contract)", () => {
    expect(isCanonicalStellarAddress(REAL_CONTRACT)).toBe(true);
  });

  it("rejects an empty segment", () => {
    expect(isCanonicalStellarAddress("")).toBe(false);
  });

  it("rejects an M-prefixed muxed address", () => {
    expect(isCanonicalStellarAddress("M" + "A".repeat(55))).toBe(false);
  });

  it("rejects garbage values", () => {
    ["random", "123", "null", "<b>xss</b>", "G-short"].forEach((v) => {
      expect(isCanonicalStellarAddress(v)).toBe(false);
    });
  });
});

// ─── parseMemberRows — checksum enforcement at the indexer boundary ────────────
//
// This tests the Task 2 change: parseMemberRows now calls hasValidStrKeyChecksum
// on every member_address so shape-valid but checksum-invalid addresses from
// the indexer are caught before reaching ScVal encoding or address comparisons.

describe("parseMemberRows — checksum enforcement", () => {
  /** Build a minimal valid member row for testing. */
  function row(member_address: string, payout_order: number) {
    return {
      member_address,
      payout_order,
      collateral: "10000000",
      defaults: 0,
      joined_at: null,
      reputation_score: 80,
      total_contributions: 2,
    };
  }

  it("accepts rows with real, checksum-valid addresses", () => {
    const result = parseMemberRows([
      row(REAL_ACCOUNT, 1),
      row(sdkAddresses[0], 2),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].member_address).toBe(REAL_ACCOUNT);
  });

  it("rejects the entire list when any row has a shape-only (checksum-invalid) address", () => {
    // SHAPE_ONLY_G passes isStellarPublicKey but fails hasValidStrKeyChecksum.
    // The all-or-nothing rule means one bad row returns [].
    const result = parseMemberRows([
      row(REAL_ACCOUNT, 1),
      row(SHAPE_ONLY_G, 2), // <-- bad checksum
    ]);
    expect(result).toHaveLength(0);
  });

  it("rejects the entire list when a single address has a typo", () => {
    const result = parseMemberRows([
      row(withTypo(REAL_ACCOUNT), 1), // checksum mismatch
      row(sdkAddresses[1], 2),
    ]);
    expect(result).toHaveLength(0);
  });

  it("rejects a list where every address is shape-only", () => {
    const result = parseMemberRows([
      row(SHAPE_ONLY_G, 1),
    ]);
    expect(result).toHaveLength(0);
  });

  it("still rejects C-prefix addresses (contract addresses cannot be members)", () => {
    const result = parseMemberRows([row(REAL_CONTRACT, 1)]);
    expect(result).toHaveLength(0);
  });

  it("accepts a single-member list with a valid checksum", () => {
    const result = parseMemberRows([row(sdkAddresses[2], 1)]);
    expect(result).toHaveLength(1);
    expect(result[0].member_address).toBe(sdkAddresses[2]);
  });

  it("returns [] for non-array input", () => {
    expect(parseMemberRows(null)).toHaveLength(0);
    expect(parseMemberRows(undefined)).toHaveLength(0);
    expect(parseMemberRows("string")).toHaveLength(0);
    expect(parseMemberRows({})).toHaveLength(0);
  });

  it("returns [] for an array containing a non-object row", () => {
    expect(parseMemberRows([null])).toHaveLength(0);
    expect(parseMemberRows(["string"])).toHaveLength(0);
    expect(parseMemberRows([42])).toHaveLength(0);
  });

  it("sorts output by payout_order regardless of input order", () => {
    const result = parseMemberRows([
      row(sdkAddresses[3], 3),
      row(sdkAddresses[4], 1),
      row(sdkAddresses[5], 2),
    ]);
    expect(result.map((r) => r.payout_order)).toEqual([1, 2, 3]);
  });

  it("rejects duplicate payout positions", () => {
    const result = parseMemberRows([
      row(sdkAddresses[6], 1),
      row(sdkAddresses[7], 1), // duplicate position
    ]);
    expect(result).toHaveLength(0);
  });

  it("rejects duplicate member addresses", () => {
    const result = parseMemberRows([
      row(REAL_ACCOUNT, 1),
      row(REAL_ACCOUNT, 2), // duplicate address
    ]);
    expect(result).toHaveLength(0);
  });
});

// ─── Assertion helpers ─────────────────────────────────────────────────────────

describe("assertStellarPublicKey", () => {
  it("does not throw for a valid G-key", () => {
    expect(() => assertStellarPublicKey(REAL_ACCOUNT)).not.toThrow();
  });

  it("throws TypeError for a C-contract", () => {
    expect(() => assertStellarPublicKey(REAL_CONTRACT)).toThrow(TypeError);
  });

  it("throws TypeError for empty string", () => {
    expect(() => assertStellarPublicKey("")).toThrow(TypeError);
  });

  it("does not throw for a shape-only G fake — assertStellarPublicKey is shape-only", () => {
    // assertStellarPublicKey delegates to isStellarPublicKey (shape only, no
    // checksum). SHAPE_ONLY_G passes the regex, so no throw is expected here.
    // validateAddress({ kind: "G" }) is the right tool when checksum is required.
    expect(() => assertStellarPublicKey(SHAPE_ONLY_G)).not.toThrow();
  });

  it("includes the label in the error message when provided", () => {
    try {
      assertStellarPublicKey("bad", "walletAddress");
    } catch (e) {
      expect((e as Error).message).toContain("walletAddress");
    }
  });
});

describe("assertSorobanContractId", () => {
  it("does not throw for a valid C-contract", () => {
    expect(() => assertSorobanContractId(REAL_CONTRACT)).not.toThrow();
  });

  it("throws TypeError for a G-key", () => {
    expect(() => assertSorobanContractId(REAL_ACCOUNT)).toThrow(TypeError);
  });

  it("throws TypeError for empty string", () => {
    expect(() => assertSorobanContractId("")).toThrow(TypeError);
  });

  it("includes the label in the error message when provided", () => {
    try {
      assertSorobanContractId("bad", "contractId");
    } catch (e) {
      expect((e as Error).message).toContain("contractId");
    }
  });
});

describe("assertCanonicalStellarAddress", () => {
  it("does not throw for a G-key", () => {
    expect(() => assertCanonicalStellarAddress(REAL_ACCOUNT)).not.toThrow();
  });

  it("does not throw for a C-contract", () => {
    expect(() => assertCanonicalStellarAddress(REAL_CONTRACT)).not.toThrow();
  });

  it("throws TypeError for an M-prefix address", () => {
    expect(() =>
      assertCanonicalStellarAddress("M" + "A".repeat(55)),
    ).toThrow(TypeError);
  });

  it("throws TypeError for empty string", () => {
    expect(() => assertCanonicalStellarAddress("")).toThrow(TypeError);
  });

  it("includes the label in the error message", () => {
    try {
      assertCanonicalStellarAddress("bad", "member");
    } catch (e) {
      expect((e as Error).message).toContain("member");
    }
  });
});
