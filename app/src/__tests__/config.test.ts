/**
 * Tests for app/src/lib/config.ts
 *
 * Covers the environment validation helpers, indexer URL utilities, and the
 * config-absent detection helper added for graceful fallback when a circle
 * contract's Config storage key is missing.
 */

import { describe, it, expect } from "vitest";
import {
  getMissingEnvVars,
  getMalformedContractAddresses,
  getNetworkConflicts,
  resolveIndexerBaseUrl,
  indexerEndpoint,
  usdcToStroops,
  stroopsToUsdc,
  isConfigAbsent,
} from "../lib/config";

const VALID_FACTORY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_REPUTATION = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VALID_USDC = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA4";

const VALID_ENV = {
  NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  NEXT_PUBLIC_INDEXER_URL: "http://localhost:3001",
  NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS: VALID_FACTORY,
  NEXT_PUBLIC_REPUTATION_ADDRESS: VALID_REPUTATION,
  NEXT_PUBLIC_USDC_ADDRESS: VALID_USDC,
};

// ─── isConfigAbsent ───────────────────────────────────────────────────────────

describe("isConfigAbsent", () => {
  it("returns true for the SDK's canonical not-initialized message", () => {
    expect(
      isConfigAbsent(
        "Circle contract is not initialized: the Config storage key is absent.",
      ),
    ).toBe(true);
  });

  it("returns true for 'Contract error code 1'", () => {
    expect(isConfigAbsent("Contract error code 1. Check that the operation is valid.")).toBe(true);
  });

  it("returns true for 'NotInitialized' in any case", () => {
    expect(isConfigAbsent("NotInitialized")).toBe(true);
    expect(isConfigAbsent("notinitialized")).toBe(true);
    expect(isConfigAbsent("Error: NOTINITIALIZED")).toBe(true);
  });

  it("returns true for 'Storage(MissingValue)'", () => {
    expect(isConfigAbsent("Storage(MissingValue)")).toBe(true);
    expect(isConfigAbsent("storage(missingvalue)")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isConfigAbsent("")).toBe(false);
    expect(isConfigAbsent("network timeout")).toBe(false);
    expect(isConfigAbsent("already initialized")).toBe(false);
    expect(isConfigAbsent("Contract error code 2")).toBe(false);
    expect(isConfigAbsent("Circle is not active")).toBe(false);
  });
});

// ─── getMissingEnvVars ────────────────────────────────────────────────────────

describe("getMissingEnvVars", () => {
  it("returns empty array for a fully valid env", () => {
    expect(getMissingEnvVars(VALID_ENV, true)).toEqual([]);
  });

  it("flags always-required vars when absent", () => {
    const missing = getMissingEnvVars({}, false);
    expect(missing).toContain("NEXT_PUBLIC_STELLAR_RPC_URL");
    expect(missing).toContain("NEXT_PUBLIC_NETWORK_PASSPHRASE");
    expect(missing).toContain("NEXT_PUBLIC_INDEXER_URL");
  });

  it("flags contract addresses in production but not in dev", () => {
    const baseEnv = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_INDEXER_URL: "http://localhost:3001",
    };
    expect(getMissingEnvVars(baseEnv, false)).toEqual([]);
    const inProd = getMissingEnvVars(baseEnv, true);
    expect(inProd).toContain("NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS");
    expect(inProd).toContain("NEXT_PUBLIC_REPUTATION_ADDRESS");
    expect(inProd).toContain("NEXT_PUBLIC_USDC_ADDRESS");
  });
});

// ─── getMalformedContractAddresses ───────────────────────────────────────────

describe("getMalformedContractAddresses", () => {
  it("returns empty for valid addresses", () => {
    expect(getMalformedContractAddresses(VALID_ENV)).toEqual([]);
  });

  it("flags addresses that do not start with C", () => {
    const env = { ...VALID_ENV, NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS: "GABC" };
    expect(getMalformedContractAddresses(env).length).toBeGreaterThan(0);
  });

  it("does not flag a missing address (that is getMissingEnvVars' job)", () => {
    const env = { ...VALID_ENV, NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS: "" };
    expect(getMalformedContractAddresses(env)).toEqual([]);
  });
});

// ─── getNetworkConflicts ──────────────────────────────────────────────────────

describe("getNetworkConflicts", () => {
  it("returns empty when testnet RPC + testnet passphrase", () => {
    const env = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    };
    expect(getNetworkConflicts(env)).toEqual([]);
  });

  it("returns empty when mainnet RPC + mainnet passphrase", () => {
    const env = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    };
    expect(getNetworkConflicts(env)).toEqual([]);
  });

  it("flags mainnet passphrase + testnet RPC URL", () => {
    const env = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    };
    expect(getNetworkConflicts(env).length).toBeGreaterThan(0);
    expect(getNetworkConflicts(env)[0]).toMatch(/mainnet passphrase.*testnet/i);
  });

  it("flags testnet passphrase + mainnet RPC URL (soroban.stellar.org)", () => {
    const env = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    };
    const conflicts = getNetworkConflicts(env);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toMatch(/testnet passphrase.*mainnet/i);
  });

  it("flags testnet passphrase + horizon.stellar.org mainnet RPC", () => {
    const env = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://horizon.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    };
    const conflicts = getNetworkConflicts(env);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("flags an entirely unrecognised passphrase", () => {
    const env = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "My Custom Network ; 2024",
    };
    const conflicts = getNetworkConflicts(env);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toMatch(/not a recognised/i);
  });

  it("returns empty when either value is missing", () => {
    expect(getNetworkConflicts({ NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org" })).toEqual([]);
    expect(getNetworkConflicts({ NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" })).toEqual([]);
    expect(getNetworkConflicts({})).toEqual([]);
  });
});

// ─── resolveIndexerBaseUrl ────────────────────────────────────────────────────

describe("resolveIndexerBaseUrl", () => {
  it("normalises a valid http URL", () => {
    expect(resolveIndexerBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });

  it("returns null for a bare hostname (no scheme)", () => {
    expect(resolveIndexerBaseUrl("localhost:3001")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(resolveIndexerBaseUrl("")).toBeNull();
  });

  it("returns null for a URL with credentials", () => {
    expect(resolveIndexerBaseUrl("http://user:pass@localhost:3001")).toBeNull();
  });
});

// ─── indexerEndpoint ──────────────────────────────────────────────────────────

describe("indexerEndpoint", () => {
  it("builds a path from segments", () => {
    expect(indexerEndpoint(["circles", "CADDR"], "http://localhost:3001")).toBe(
      "http://localhost:3001/circles/CADDR",
    );
  });

  it("returns null when base is null", () => {
    expect(indexerEndpoint(["circles"], null)).toBeNull();
  });

  it("URL-encodes special characters in segments", () => {
    const url = indexerEndpoint(["circles", "CA/B"], "http://localhost:3001");
    expect(url).not.toContain("/CA/B");
    expect(url).toContain("CA%2FB");
  });
});

// ─── usdcToStroops / stroopsToUsdc ───────────────────────────────────────────

describe("usdcToStroops", () => {
  it("converts 1 USDC to 10_000_000 stroops", () => {
    expect(usdcToStroops("1")).toBe(10_000_000n);
  });

  it("converts a fractional USDC amount", () => {
    expect(usdcToStroops("0.5")).toBe(5_000_000n);
  });

  it("throws for a negative amount", () => {
    expect(() => usdcToStroops("-1")).toThrow();
  });
});

describe("stroopsToUsdc", () => {
  it("converts 10_000_000 stroops to '1'", () => {
    expect(stroopsToUsdc(10_000_000n)).toBe("1");
  });

  it("strips trailing zeros", () => {
    expect(stroopsToUsdc(15_000_000n)).toBe("1.5");
  });

  it("returns '0' for invalid input", () => {
    expect(stroopsToUsdc("not-a-number")).toBe("0");
  });
});
