/**
 * Issue #460: Cross-workspace USDC / stroops parity tests.
 *
 * The app deliberately does not depend on @circleup/sdk, so the money-math
 * helpers are duplicated in app/src/lib/config.ts with a comment saying they
 * must stay behaviourally identical to sdk/src/utils.ts.
 *
 * This file is the automated enforcement of that contract. It imports both
 * copies and asserts that every representative input produces the same output
 * from both implementations.
 *
 * If a future change makes the two diverge — even by one stroop — this test
 * will catch it in CI before it reaches a user.
 */

import { describe, it, expect } from "vitest";

// App copy (app/src/lib/config.ts)
import {
  usdcToStroops as appUsdcToStroops,
  stroopsToUsdc as appStroopsToUsdc,
  formatUsdc as appFormatUsdc,
  formatPot as appFormatPot,
  daysToLedgers as appDaysToLedgers,
  ledgersToDays as appLedgersToDays,
} from "../lib/config";

// SDK copy — imported via a relative path to the sibling workspace source.
// The app intentionally does not list @circleup/sdk as a package dependency
// (see app/src/lib/config.ts comment), so we reach the SDK directly from the
// monorepo tree. This is the right approach for a parity test whose only job
// is comparing the two copies; the relative path is stable in the monorepo
// layout and does not represent a runtime dependency.
import {
  usdcToStroops as sdkUsdcToStroops,
  stroopsToUsdc as sdkStroopsToUsdc,
  formatUsdc as sdkFormatUsdc,
  formatPot as sdkFormatPot,
  daysToLedgers as sdkDaysToLedgers,
  ledgersToDays as sdkLedgersToDays,
} from "../../../sdk/src/utils";

// ─── Shared test vectors ──────────────────────────────────────────────────────

/** Stroop values that cover the full range of realistic monetary inputs. */
const STROOP_VECTORS: Array<bigint | string | number> = [
  0n,
  1n,
  100_000n,         // 0.01 USDC
  1_000_000n,       // 0.10 USDC
  10_000_000n,      // 1.00 USDC
  15_000_000n,      // 1.50 USDC
  100_000_000n,     // 10.00 USDC
  123_456_789n,
  1_000_000_000n,   // 100.00 USDC
  10_000_000_000n,  // 1,000.00 USDC
  "10000000",       // string input — common from DB / API
  "15000000",
  10_000_000,       // number input
];

/** USDC decimal strings that cover edge cases in usdcToStroops. */
const USDC_STRING_VECTORS = [
  "0",
  "0.0",
  "0.0000000",
  "1",
  "1.5",
  "1.50",
  "1.5000000",
  "0.01",
  "0.0000001",
  "10",
  "100.25",
  "999.9999999",
  "1e-7",
  "5e-1",
  "1.5e3",
];

/** Number inputs accepted by usdcToStroops (valid, non-negative, ≤7 decimals). */
const USDC_NUMBER_VECTORS: number[] = [
  0,
  1,
  10,
  0.5,
  0.01,
  0.0000001,
  100.25,
];

// ─── usdcToStroops parity ─────────────────────────────────────────────────────

describe("#460 usdcToStroops — app vs SDK parity", () => {
  it("produces identical results for valid string inputs", () => {
    for (const input of USDC_STRING_VECTORS) {
      const appResult = appUsdcToStroops(input);
      const sdkResult = sdkUsdcToStroops(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("produces identical results for valid number inputs", () => {
    for (const input of USDC_NUMBER_VECTORS) {
      const appResult = appUsdcToStroops(input);
      const sdkResult = sdkUsdcToStroops(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both throw TypeError for negative amounts", () => {
    const badInputs: Array<number | string> = [-1, -0.5, "-1", "-0.0000001"];
    for (const input of badInputs) {
      expect(() => appUsdcToStroops(input)).toThrow(TypeError);
      expect(() => sdkUsdcToStroops(input)).toThrow(TypeError);
    }
  });

  it("both throw TypeError for >7 significant decimal places", () => {
    const badInputs = ["1.12345678", "0.00000001", "1.5e-7"];
    for (const input of badInputs) {
      expect(() => appUsdcToStroops(input)).toThrow(TypeError);
      expect(() => sdkUsdcToStroops(input)).toThrow(TypeError);
    }
  });

  it("both throw TypeError for NaN / Infinity", () => {
    expect(() => appUsdcToStroops(NaN)).toThrow(TypeError);
    expect(() => sdkUsdcToStroops(NaN)).toThrow(TypeError);
    expect(() => appUsdcToStroops(Infinity)).toThrow(TypeError);
    expect(() => sdkUsdcToStroops(Infinity)).toThrow(TypeError);
  });

  it("both throw TypeError for empty / whitespace strings", () => {
    expect(() => appUsdcToStroops("")).toThrow(TypeError);
    expect(() => sdkUsdcToStroops("")).toThrow(TypeError);
    expect(() => appUsdcToStroops("   ")).toThrow(TypeError);
    expect(() => sdkUsdcToStroops("   ")).toThrow(TypeError);
  });

  it("both throw TypeError for malformed exponent notation", () => {
    const bad = ["1e", "1e2e3", "e5"];
    for (const input of bad) {
      expect(() => appUsdcToStroops(input)).toThrow(TypeError);
      expect(() => sdkUsdcToStroops(input)).toThrow(TypeError);
    }
  });
});

// ─── stroopsToUsdc parity ─────────────────────────────────────────────────────

describe("#460 stroopsToUsdc — app vs SDK parity", () => {
  it("produces identical results for representative stroop values", () => {
    for (const input of STROOP_VECTORS) {
      const appResult = appStroopsToUsdc(input);
      const sdkResult = sdkStroopsToUsdc(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both return '0' for negative stroops", () => {
    const neg: Array<bigint | string | number> = [-1n, "-100", -1];
    for (const input of neg) {
      expect(appStroopsToUsdc(input)).toBe("0");
      expect(sdkStroopsToUsdc(input)).toBe("0");
    }
  });

  it("both return '0' for invalid / non-numeric inputs", () => {
    const bad: Array<bigint | string | number> = ["not-a-number", ""];
    for (const input of bad) {
      expect(appStroopsToUsdc(input)).toBe("0");
      expect(sdkStroopsToUsdc(input)).toBe("0");
    }
  });

  it("usdcToStroops ∘ stroopsToUsdc round-trips are identical", () => {
    const values = [0n, 1n, 100_000n, 15_000_000n, 100_000_000n, 123_456_789n];
    for (const v of values) {
      const appRoundTrip = appUsdcToStroops(appStroopsToUsdc(v));
      const sdkRoundTrip = sdkUsdcToStroops(sdkStroopsToUsdc(v));
      expect(appRoundTrip).toBe(v);
      expect(sdkRoundTrip).toBe(v);
      // Cross-check: both round trips agree with each other
      expect(appRoundTrip).toBe(sdkRoundTrip);
    }
  });
});

// ─── formatUsdc parity ────────────────────────────────────────────────────────

describe("#460 formatUsdc — app vs SDK parity", () => {
  it("produces identical 2-dp display strings", () => {
    for (const input of STROOP_VECTORS) {
      const appResult = appFormatUsdc(input);
      const sdkResult = sdkFormatUsdc(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both truncate (not round) at 2 dp", () => {
    // 12_349_999 stroops = 1.2349999 USDC — truncate to "1.23", never "1.24"
    expect(appFormatUsdc(12_349_999n)).toBe("1.23");
    expect(sdkFormatUsdc(12_349_999n)).toBe("1.23");
  });

  it("both return '0.00' for zero", () => {
    expect(appFormatUsdc(0n)).toBe("0.00");
    expect(sdkFormatUsdc(0n)).toBe("0.00");
  });

  it("both return '0.00' for negative values", () => {
    expect(appFormatUsdc(-1n)).toBe("0.00");
    expect(sdkFormatUsdc(-1n)).toBe("0.00");
  });

  it("both return '0.00' for invalid input", () => {
    expect(appFormatUsdc("bad")).toBe("0.00");
    expect(sdkFormatUsdc("bad")).toBe("0.00");
  });
});

// ─── formatPot parity ─────────────────────────────────────────────────────────

describe("#460 formatPot — app vs SDK parity", () => {
  const cases: Array<[bigint | string | number, number]> = [
    [10_000_000n, 1],
    [10_000_000n, 4],
    [10_000_000n, 10],
    ["10000000", 5],
    [5_000_000n, 2],
    [0n, 0],
    [10_000_000n, 0],
  ];

  it("produces identical results for all test cases", () => {
    for (const [amount, count] of cases) {
      const appResult = appFormatPot(amount, count);
      const sdkResult = sdkFormatPot(amount, count);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both return '0.00' for negative member count", () => {
    expect(appFormatPot("10000000", -1)).toBe("0.00");
    expect(sdkFormatPot("10000000", -1)).toBe("0.00");
  });

  it("both return '0.00' for fractional member count", () => {
    expect(appFormatPot("10000000", 1.5)).toBe("0.00");
    expect(sdkFormatPot("10000000", 1.5)).toBe("0.00");
  });

  it("both return '0.00' for invalid amount", () => {
    expect(appFormatPot("bad", 4)).toBe("0.00");
    expect(sdkFormatPot("bad", 4)).toBe("0.00");
  });
});

// ─── Ledger helpers parity ────────────────────────────────────────────────────

describe("#460 daysToLedgers / ledgersToDays — app vs SDK parity", () => {
  const dayValues = [0, 1, 7, 30, 365];
  const ledgerValues = [0, 17_280, 120_960, 1_036_800];

  it("daysToLedgers produces identical results", () => {
    for (const days of dayValues) {
      expect(appDaysToLedgers(days)).toBe(sdkDaysToLedgers(days));
    }
  });

  it("ledgersToDays produces identical results", () => {
    for (const ledgers of ledgerValues) {
      expect(appLedgersToDays(ledgers)).toBe(sdkLedgersToDays(ledgers));
    }
  });

  it("both throw RangeError for negative days", () => {
    expect(() => appDaysToLedgers(-1)).toThrow(RangeError);
    expect(() => sdkDaysToLedgers(-1)).toThrow(RangeError);
  });

  it("both throw RangeError for negative ledgers", () => {
    expect(() => appLedgersToDays(-1)).toThrow(RangeError);
    expect(() => sdkLedgersToDays(-1)).toThrow(RangeError);
  });
});

// ─── Conversion boundary cases ────────────────────────────────────────────────

describe("#460 conversion edge cases", () => {
  it("one stroop is the minimum representable USDC amount in both copies", () => {
    expect(appUsdcToStroops("0.0000001")).toBe(1n);
    expect(sdkUsdcToStroops("0.0000001")).toBe(1n);
    expect(appStroopsToUsdc(1n)).toBe("0.0000001");
    expect(sdkStroopsToUsdc(1n)).toBe("0.0000001");
  });

  it("formatUsdc of one stroop is '0.00' (less than 1 cent) in both copies", () => {
    // 1 stroop = 0.0000001 USDC — rounds down to 0.00 at 2 dp
    expect(appFormatUsdc(1n)).toBe("0.00");
    expect(sdkFormatUsdc(1n)).toBe("0.00");
  });

  it("large round amounts are handled identically by both copies", () => {
    // 1,000 USDC × 20 members = $20,000 pot
    const roundAmount = appUsdcToStroops("1000");
    const memberCount = 20;
    expect(appFormatPot(roundAmount, memberCount)).toBe("20000.00");
    expect(sdkFormatPot(roundAmount, memberCount)).toBe("20000.00");
  });

  it("trailing zeros are stripped identically in both stroopsToUsdc copies", () => {
    // 1.5000000 → "1.5", 10.0000000 → "10"
    expect(appStroopsToUsdc(15_000_000n)).toBe("1.5");
    expect(sdkStroopsToUsdc(15_000_000n)).toBe("1.5");
    expect(appStroopsToUsdc(100_000_000n)).toBe("10");
    expect(sdkStroopsToUsdc(100_000_000n)).toBe("10");
  });
});

// ─── STROOP and USDC_DECIMALS constant parity ────────────────────────────────
//
// Now that app/src/lib/config.ts exports USDC_DECIMALS and derives STROOP from
// it (added in the #619 conversion-consistency fix), this section asserts that
// the constant values match the SDK's canonical definitions.  A drift here
// means the two copies have silently diverged and every conversion in the app
// is wrong.

describe("#460 STROOP and USDC_DECIMALS constant parity", () => {
  it("app USDC_DECIMALS equals SDK USDC_DECIMALS (both must be 7)", async () => {
    const { USDC_DECIMALS: appDecimals } = await import("../lib/config");
    const { USDC_DECIMALS: sdkDecimals } = await import("../../../sdk/src/utils");
    // Structural equality — if either changes this test fails immediately.
    expect(appDecimals).toBe(sdkDecimals);
    // Absolute value — documents the agreed constant so reviewers see it explicitly.
    expect(appDecimals).toBe(7);
    expect(sdkDecimals).toBe(7);
  });

  it("app STROOP equals SDK STROOP (both must be 10_000_000n)", async () => {
    const { STROOP: appStroop } = await import("../lib/config");
    const { STROOP: sdkStroop } = await import("../../../sdk/src/utils");
    expect(appStroop).toBe(sdkStroop);
    expect(appStroop).toBe(10_000_000n);
  });

  it("app STROOP equals BigInt(10 ** app USDC_DECIMALS) — derivation is consistent", async () => {
    const { STROOP: appStroop, USDC_DECIMALS: appDecimals } = await import("../lib/config");
    expect(appStroop).toBe(BigInt(10 ** appDecimals));
  });

  it("usdcToStroops('1') returns STROOP in both copies", async () => {
    const { STROOP: appStroop } = await import("../lib/config");
    const { STROOP: sdkStroop } = await import("../../../sdk/src/utils");
    expect(appUsdcToStroops("1")).toBe(appStroop);
    expect(sdkUsdcToStroops("1")).toBe(sdkStroop);
    expect(appUsdcToStroops("1")).toBe(sdkUsdcToStroops("1"));
  });
});

// ─── Zero-spelling parity ────────────────────────────────────────────────────
//
// Browser <input type="number"> commonly produces "0.0", "0.00", or "" when
// the user clears a field.  Both copies must handle these identically so the
// create form and SDK produce the same result for the same raw input.

describe("#460 usdcToStroops — zero-spelling parity", () => {
  const zeroSpellings: string[] = ["0.0", "0.00", "0.00000", "0.0000000", "00"];

  it("both copies return 0n for all zero spellings", () => {
    for (const spelling of zeroSpellings) {
      const appResult = appUsdcToStroops(spelling);
      const sdkResult = sdkUsdcToStroops(spelling);
      expect(appResult).toBe(0n);
      expect(sdkResult).toBe(0n);
      expect(appResult).toBe(sdkResult);
    }
  });
});

// ─── formatUsdc sub-cent boundary parity ─────────────────────────────────────
//
// Values below $0.01 (100_000 stroops) truncate to "0.00" at 2 dp.  The exact
// boundary: 100_000 stroops = 0.0100000 USDC → "0.01"; 99_999 stroops =
// 0.0099999 USDC → "0.00".  This is distinct from the truncation test already
// in this file (which tests the 1.23/1.24 boundary at the cent level).

describe("#460 formatUsdc — sub-cent truncation parity", () => {
  it("both copies return '0.00' for values strictly below $0.01 (< 100_000 stroops)", () => {
    // These are all below the $0.01 display threshold: truncation to 2 dp
    // yields "0.00".  Neither copy should round up or display sub-cent digits.
    const subCent: Array<bigint | number | string> = [
      1n, 999n, 9_999n, 99_999n,
    ];
    for (const v of subCent) {
      expect(appFormatUsdc(v)).toBe("0.00");
      expect(sdkFormatUsdc(v)).toBe("0.00");
      expect(appFormatUsdc(v)).toBe(sdkFormatUsdc(v));
    }
  });

  it("both copies return '0.01' for exactly 100_000 stroops ($0.01 — minimum visible cent)", () => {
    expect(appFormatUsdc(100_000n)).toBe("0.01");
    expect(sdkFormatUsdc(100_000n)).toBe("0.01");
  });

  it("both copies never overstate — 9_999_999 stroops shows '0.99' not '1.00'", () => {
    expect(appFormatUsdc(9_999_999n)).toBe("0.99");
    expect(sdkFormatUsdc(9_999_999n)).toBe("0.99");
    expect(appFormatUsdc(9_999_999n)).toBe(sdkFormatUsdc(9_999_999n));
  });
});

// ─── stroopsToUsdc return-type parity ────────────────────────────────────────
//
// Both copies must return a string — never a number — so callers cannot
// accidentally coerce a large stroop value through a JS float.

describe("#460 stroopsToUsdc — return type is always string", () => {
  const sampleStroops: Array<bigint | number | string> = [
    0n, 1n, 10_000_000n, 10n ** 19n, "15000000", 100_000_000,
  ];

  it("app copy always returns typeof 'string'", () => {
    for (const v of sampleStroops) {
      expect(typeof appStroopsToUsdc(v)).toBe("string");
    }
  });

  it("sdk copy always returns typeof 'string'", () => {
    for (const v of sampleStroops) {
      expect(typeof sdkStroopsToUsdc(v)).toBe("string");
    }
  });
});
