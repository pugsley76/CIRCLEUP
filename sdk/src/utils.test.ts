import { describe, it, expect } from "vitest";
import {
  usdcToStroops,
  stroopsToUsdc,
  formatUsdc,
  formatPot,
  daysToLedgers,
  ledgersToDays,
  shortAddress,
} from "./utils";

// ─── usdcToStroops ────────────────────────────────────────────────────────────

describe("usdcToStroops", () => {
  it("converts whole numbers", () => {
    expect(usdcToStroops(10)).toBe(100_000_000n);
    expect(usdcToStroops("10")).toBe(100_000_000n);
    expect(usdcToStroops(1)).toBe(10_000_000n);
  });

  it("converts decimals", () => {
    expect(usdcToStroops("1.5")).toBe(15_000_000n);
    expect(usdcToStroops("0.01")).toBe(100_000n);
    expect(usdcToStroops("0.0000001")).toBe(1n);
  });

  it("handles 7 decimal places exactly", () => {
    expect(usdcToStroops("1.1234567")).toBe(11_234_567n);
  });

  it("throws for non-numeric input", () => {
    expect(() => usdcToStroops("abc")).toThrow(TypeError);
    expect(() => usdcToStroops("1.2.3")).toThrow(TypeError);
    expect(() => usdcToStroops("-1")).toThrow(TypeError);
  });

  it("throws for more than 7 decimal places", () => {
    expect(() => usdcToStroops("1.12345678")).toThrow(TypeError);
    expect(() => usdcToStroops("0.00000001")).toThrow(TypeError);
  });

  it("treats insignificant trailing zeros as exact, not excess precision", () => {
    // 7 significant digits written with extra trailing zeros / padding.
    expect(usdcToStroops("1.5000000")).toBe(15_000_000n);
    expect(usdcToStroops("10.00")).toBe(100_000_000n);
    expect(usdcToStroops("0.0100000")).toBe(100_000n);
    // 8 characters after the point, but the last is a value-less zero → 7 sig.
    expect(usdcToStroops("1.12345670")).toBe(11_234_567n);
  });

  it("handles every spelling of zero", () => {
    expect(usdcToStroops(0)).toBe(0n);
    expect(usdcToStroops("0")).toBe(0n);
    expect(usdcToStroops("0.0")).toBe(0n);
    expect(usdcToStroops("0.0000000")).toBe(0n);
    expect(usdcToStroops("0e0")).toBe(0n);
  });

  it("accepts fractional numbers that JS renders in exponent notation", () => {
    // String(0.0000001) === "1e-7" — the old String(usdc) path rejected this
    // valid one-stroop amount outright.
    expect(usdcToStroops(0.0000001)).toBe(1n);
    expect(usdcToStroops(0.5)).toBe(5_000_000n);
  });

  it("rejects non-finite numbers explicitly", () => {
    expect(() => usdcToStroops(NaN)).toThrow(TypeError);
    expect(() => usdcToStroops(Infinity)).toThrow(TypeError);
    expect(() => usdcToStroops(-Infinity)).toThrow(TypeError);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(() => usdcToStroops("")).toThrow(TypeError);
    expect(() => usdcToStroops("   ")).toThrow(TypeError);
  });

  it("rejects negative numbers as well as negative strings", () => {
    expect(() => usdcToStroops(-1)).toThrow(TypeError);
    expect(() => usdcToStroops(-0.5)).toThrow(TypeError);
    expect(() => usdcToStroops(-0.0000001)).toThrow(TypeError); // String() → "-1e-7"
  });
});

// ─── usdcToStroops — exponent notation ─────────────────────────────────────────

describe("usdcToStroops (exponent notation)", () => {
  it("expands negative exponents losslessly", () => {
    expect(usdcToStroops("1e-7")).toBe(1n);
    expect(usdcToStroops("1E-7")).toBe(1n); // case-insensitive
    expect(usdcToStroops("5e-1")).toBe(5_000_000n);
    expect(usdcToStroops("1.5e-1")).toBe(1_500_000n);
  });

  it("expands positive exponents losslessly", () => {
    expect(usdcToStroops("1.5e3")).toBe(15_000_000_000n);
    expect(usdcToStroops("1e+21")).toBe(10n ** 28n);
    expect(usdcToStroops(1e21)).toBe(10n ** 28n); // number → "1e+21"
  });

  it("still enforces the 7-decimal limit after expansion", () => {
    // 1e-8 → "0.00000001" → 8 decimal places.
    expect(() => usdcToStroops("1e-8")).toThrow(TypeError);
    expect(() => usdcToStroops(1e-8)).toThrow(TypeError);
    expect(() => usdcToStroops("1.5e-7")).toThrow(TypeError); // → "0.00000015"
  });

  it("rejects malformed exponent notation with a clear error", () => {
    expect(() => usdcToStroops("1e")).toThrow(TypeError);
    expect(() => usdcToStroops("1e2e3")).toThrow(TypeError);
    expect(() => usdcToStroops("e5")).toThrow(TypeError);
    expect(() => usdcToStroops("1.2e")).toThrow(TypeError);
  });
});

// ─── usdcToStroops — large values ──────────────────────────────────────────────

describe("usdcToStroops (large values)", () => {
  it("converts large plain-decimal strings without loss", () => {
    expect(usdcToStroops("1000000000000")).toBe(10n ** 19n); // 1e12 USDC
    expect(usdcToStroops("999999999999.9999999")).toBe(9_999_999_999_999_999_999n);
  });
});

// ─── round trips ───────────────────────────────────────────────────────────────

describe("usdcToStroops ∘ stroopsToUsdc round trips", () => {
  it("recovers the original stroops for every representative value", () => {
    const values = [
      0n,
      1n,
      100_000n,
      15_000_000n,
      100_000_000n,
      123_456_789n,
      10_000_000_000n,
      10n ** 19n,
    ];
    for (const v of values) {
      expect(usdcToStroops(stroopsToUsdc(v))).toBe(v);
    }
  });
});


// ─── stroopsToUsdc ────────────────────────────────────────────────────────────

describe("stroopsToUsdc", () => {
  it("converts bigint stroops to USDC string", () => {
    expect(stroopsToUsdc(100_000_000n)).toBe("10");
    expect(stroopsToUsdc(15_000_000n)).toBe("1.5");
    expect(stroopsToUsdc(100_000n)).toBe("0.01");
    expect(stroopsToUsdc(1n)).toBe("0.0000001");
  });

  it("accepts string and number inputs", () => {
    expect(stroopsToUsdc("10000000")).toBe("1");
    expect(stroopsToUsdc(10_000_000)).toBe("1");
  });

  it("strips trailing zeros", () => {
    expect(stroopsToUsdc(10_000_000n)).toBe("1");
    expect(stroopsToUsdc(10_500_000n)).toBe("1.05");
  });

  it("returns '0' for zero", () => {
    expect(stroopsToUsdc(0n)).toBe("0");
    expect(stroopsToUsdc(0)).toBe("0");
    expect(stroopsToUsdc("0")).toBe("0");
  });

  it("returns '0' for negative values instead of throwing", () => {
    expect(stroopsToUsdc(-1n)).toBe("0");
    expect(stroopsToUsdc("-100")).toBe("0");
  });

  it("returns '0' for invalid input instead of throwing", () => {
    expect(stroopsToUsdc("not-a-number")).toBe("0");
    expect(stroopsToUsdc("")).toBe("0");
  });
});

// ─── formatUsdc ───────────────────────────────────────────────────────────────

describe("formatUsdc", () => {
  it("formats to 2 decimal places", () => {
    expect(formatUsdc(100_000_000n)).toBe("10.00");
    expect(formatUsdc(15_000_000n)).toBe("1.50");
    expect(formatUsdc(100_000n)).toBe("0.01");
  });

  it("returns '0.00' for zero", () => {
    expect(formatUsdc(0n)).toBe("0.00");
  });

  it("returns '0.00' for negative values", () => {
    expect(formatUsdc(-1n)).toBe("0.00");
  });

  it("returns '0.00' for invalid input", () => {
    expect(formatUsdc("bad")).toBe("0.00");
  });
});

// ─── formatPot ────────────────────────────────────────────────────────────────

describe("formatPot", () => {
  it("multiplies round amount by member count", () => {
    expect(formatPot("10000000", 4)).toBe("4.00");
    expect(formatPot(10_000_000n, 10)).toBe("10.00");
  });

  it("returns '0.00' for invalid member count", () => {
    expect(formatPot("10000000", -1)).toBe("0.00");
    expect(formatPot("10000000", 1.5)).toBe("0.00");
  });

  it("returns '0.00' for invalid amount", () => {
    expect(formatPot("bad", 4)).toBe("0.00");
  });
});

// ─── ledger helpers ───────────────────────────────────────────────────────────

describe("daysToLedgers / ledgersToDays", () => {
  it("round-trips approximately", () => {
    expect(daysToLedgers(1)).toBe(17_280);
    expect(ledgersToDays(17_280)).toBe(1);
  });

  it("throws for negative values", () => {
    expect(() => daysToLedgers(-1)).toThrow(RangeError);
    expect(() => ledgersToDays(-1)).toThrow(RangeError);
  });
});

// ─── shortAddress ─────────────────────────────────────────────────────────────

describe("shortAddress", () => {
  it("truncates a full Stellar address", () => {
    const addr = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGEWVPO75SVRBGZL";
    expect(shortAddress(addr)).toBe("GCEZ…BGZL");
  });

  it("returns short strings unchanged", () => {
    expect(shortAddress("ABCD")).toBe("ABCD");
  });

  it("handles empty string gracefully", () => {
    expect(shortAddress("")).toBe("");
  });
});

// ─── formatUsdc — sub-cent precision ─────────────────────────────────────────

describe("formatUsdc — sub-cent and precision boundary", () => {
  it("returns '0.00' for 1 stroop (0.0000001 USDC — below display precision)", () => {
    // 1 stroop is the smallest representable value; at 2 dp it rounds down to
    // zero.  The function must NOT emit "0.00000010" or throw.
    expect(formatUsdc(1n)).toBe("0.00");
  });

  it("returns '0.00' for values strictly below $0.01 (< 100_000 stroops); truncates at 2 dp for values between $0.01 and $0.10", () => {
    expect(formatUsdc(999_999n)).toBe("0.09");  // 0.0999999 USDC — truncates to "0.09"
    expect(formatUsdc(100_000n)).toBe("0.01");  // exactly $0.01
    expect(formatUsdc(99_999n)).toBe("0.00");   // 0.0099999 USDC — below $0.01 → "0.00"
    expect(formatUsdc(1n)).toBe("0.00");        // 0.0000001 USDC — sub-cent → "0.00"
  });

  it("truncates to 2 dp, never rounds up — the shown value never overstates the balance", () => {
    // 12_349_999 stroops = 1.2349999 USDC.  Rounding would give "1.24";
    // truncation gives "1.23".  This is intentional: display must not lie.
    expect(formatUsdc(12_349_999n)).toBe("1.23");
    // 9_999_999 stroops = 0.9999999 USDC.  Must show "0.99", never "1.00".
    expect(formatUsdc(9_999_999n)).toBe("0.99");
  });

  it("accepts string and number inputs without throwing", () => {
    expect(formatUsdc("100000000")).toBe("10.00");
    expect(formatUsdc(10_000_000)).toBe("1.00");
  });
});

// ─── usdcToStroops — zero spellings produced by browser number inputs ─────────

describe("usdcToStroops — zero spellings from browser / form inputs", () => {
  it("accepts '0.0' (single fractional zero)", () => {
    expect(usdcToStroops("0.0")).toBe(0n);
  });

  it("accepts '0.00' (two fractional zeros — common from <input type='number'>)", () => {
    expect(usdcToStroops("0.00")).toBe(0n);
  });

  it("accepts '00' (leading integer zero with no fraction)", () => {
    // toPlainDecimalString passes "00" through; the regex ^\d+(\.\d+)?$ matches.
    // BigInt("00") === 0n, so the result is correct.
    expect(usdcToStroops("00")).toBe(0n);
  });

  it("accepts '0.0000000' (seven fractional zeros — maximum-precision zero)", () => {
    expect(usdcToStroops("0.0000000")).toBe(0n);
  });
});

// ─── stroopsToUsdc — large-value correctness ──────────────────────────────────

describe("stroopsToUsdc — values above Number.MAX_SAFE_INTEGER", () => {
  it("handles 10^19 stroops (1 trillion USDC) without loss", () => {
    // Number.MAX_SAFE_INTEGER is ~9×10^15; 10^19 exceeds it by 4 orders of
    // magnitude.  The bigint path must not silently coerce through a JS number.
    const stroops = 10n ** 19n;
    const usdc = stroopsToUsdc(stroops);
    // 10^19 stroops = 10^12 USDC = "1000000000000"
    expect(usdc).toBe("1000000000000");
    // Round-trip: converting back must recover the original stroop count.
    expect(usdcToStroops(usdc)).toBe(stroops);
  });

  it("handles the maximum sdk test-vector value (999999999999.9999999 USDC)", () => {
    const stroops = 9_999_999_999_999_999_999n;
    const usdc = stroopsToUsdc(stroops);
    expect(usdc).toBe("999999999999.9999999");
    expect(usdcToStroops(usdc)).toBe(stroops);
  });

  it("returns a string (not a number) so callers cannot accidentally coerce to float", () => {
    const result = stroopsToUsdc(10n ** 19n);
    expect(typeof result).toBe("string");
  });
});

// ─── STROOP and USDC_DECIMALS constants ───────────────────────────────────────

describe("STROOP constant — value invariants", () => {
  it("USDC_DECIMALS exported from utils equals 7", async () => {
    const { USDC_DECIMALS: decimals } = await import("./utils");
    expect(decimals).toBe(7);
  });

  it("STROOP exported from utils equals 10_000_000n (10 ^ USDC_DECIMALS)", async () => {
    const { STROOP: stroop, USDC_DECIMALS: decimals } = await import("./utils");
    expect(stroop).toBe(10_000_000n);
    // Structural check: STROOP is exactly 10^USDC_DECIMALS
    expect(stroop).toBe(BigInt(10 ** decimals));
  });

  it("usdcToStroops(1) equals STROOP — 1 USDC converts to exactly STROOP stroops", async () => {
    const { STROOP: stroop } = await import("./utils");
    expect(usdcToStroops(1)).toBe(stroop);
    expect(usdcToStroops("1")).toBe(stroop);
    expect(usdcToStroops("1.0000000")).toBe(stroop);
  });

  it("stroopsToUsdc(STROOP) equals '1' — round-trip through the constant", async () => {
    const { STROOP: stroop } = await import("./utils");
    expect(stroopsToUsdc(stroop)).toBe("1");
  });
});
