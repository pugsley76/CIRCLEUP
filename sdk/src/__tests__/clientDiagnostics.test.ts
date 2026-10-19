/**
 * Tests for issue #187: resilient, typed SDK client with better transaction
 * diagnostics.
 *
 * Covers the improvements introduced by this issue:
 *
 * 1. validateContractArgs — early, named-field rejection before any encoding
 * 2. validateCircleUpConfig — indexerUrl format validation
 * 3. extractSimulationError — host-error pattern translations
 * 4. formatRpcError — network error normalisation (ECONNREFUSED, ENOTFOUND, …)
 * 5. decodeU32 / decodeBigInt / decodeBoolean / decodeAddress — richer type
 *    info in error messages (type name included)
 * 6. FactoryClient.createCircle — validateContractArgs called before encoding
 * 7. CircleClient.markDefault — validateContractArgs called before encoding
 * 8. Boundary values: i128 min/max, u32 min/max, Number.MAX_SAFE_INTEGER edge
 *
 * No real RPC calls are made.  Network methods are either stubbed via
 * vi.spyOn or bypassed entirely (pure-function tests need no stubs at all).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SorobanRpc, xdr } from "@stellar/stellar-sdk";
import {
  FactoryClient,
  CircleClient,
  CircleUpClient,
  type PollConfig,
} from "../client";
import {
  validateCircleUpConfig,
  validateContractArgs,
  decodeU32,
  decodeBigInt,
  decodeBoolean,
  decodeAddress,
  isTxFailure,
  isTxSuccess,
} from "../types";
import {
  CIRCLE_ADDR,
  CREATOR,
  FACTORY_ADDR,
  FAST_POLL,
  MEMBER_A,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
  MOCK_ACCOUNT,
  REPUTATION_ADDR,
  SDK_CONFIG,
  USDC_ADDR,
  simulationError,
  simulationSuccess,
} from "./fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const factory = (poll: PollConfig = FAST_POLL) => new FactoryClient(SDK_CONFIG, poll);
const circle = (poll: PollConfig = FAST_POLL) =>
  new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0, poll);

afterEach(() => vi.restoreAllMocks());

// ─── 1. validateContractArgs ──────────────────────────────────────────────────

describe("validateContractArgs", () => {
  describe("address type", () => {
    it("returns null for a valid G-address", () => {
      expect(validateContractArgs([{ name: "member", value: MEMBER_A_ADDR, type: "address" }])).toBeNull();
    });

    it("returns null for a valid C-address", () => {
      expect(validateContractArgs([{ name: "contract", value: CIRCLE_ADDR, type: "address" }])).toBeNull();
    });

    it("returns an error string for an empty string", () => {
      const err = validateContractArgs([{ name: "member", value: "", type: "address" }]);
      expect(err).not.toBeNull();
      expect(err).toContain('"member"');
    });

    it("names the parameter in the returned error", () => {
      const err = validateContractArgs([{ name: "myParam", value: "bad", type: "address" }]);
      expect(err).toContain('"myParam"');
    });

    it("returns an error for a non-string value", () => {
      const err = validateContractArgs([{ name: "a", value: 123, type: "address" }]);
      expect(err).not.toBeNull();
    });
  });

  describe("u32 type", () => {
    it("returns null for 0 (minimum)", () => {
      expect(validateContractArgs([{ name: "n", value: 0, type: "u32" }])).toBeNull();
    });

    it("returns null for 4294967295 (maximum)", () => {
      expect(validateContractArgs([{ name: "n", value: 0xffffffff, type: "u32" }])).toBeNull();
    });

    it("returns an error for a negative number", () => {
      const err = validateContractArgs([{ name: "rounds", value: -1, type: "u32" }]);
      expect(err).not.toBeNull();
      expect(err).toContain('"rounds"');
    });

    it("returns an error for a float", () => {
      const err = validateContractArgs([{ name: "n", value: 1.5, type: "u32" }]);
      expect(err).not.toBeNull();
    });

    it("returns an error for a value exceeding u32 max", () => {
      const err = validateContractArgs([{ name: "n", value: 0x100000000, type: "u32" }]);
      expect(err).not.toBeNull();
    });
  });

  describe("i128 type", () => {
    it("returns null for a valid bigint", () => {
      expect(validateContractArgs([{ name: "amount", value: 100_000_000n, type: "i128" }])).toBeNull();
    });

    it("returns null for a valid safe integer number", () => {
      expect(validateContractArgs([{ name: "amount", value: 50_000_000, type: "i128" }])).toBeNull();
    });

    it("returns null for 0n", () => {
      expect(validateContractArgs([{ name: "amount", value: 0n, type: "i128" }])).toBeNull();
    });

    it("returns null for a negative bigint (valid i128 range)", () => {
      expect(validateContractArgs([{ name: "amount", value: -1n, type: "i128" }])).toBeNull();
    });

    it("returns an error for Number.MAX_SAFE_INTEGER + 2 (would lose precision)", () => {
      const err = validateContractArgs([
        { name: "amount", value: Number.MAX_SAFE_INTEGER + 2, type: "i128" },
      ]);
      expect(err).not.toBeNull();
      expect(err).toContain("precision");
    });

    it("returns an error for a float number", () => {
      const err = validateContractArgs([{ name: "amount", value: 1.5, type: "i128" }]);
      expect(err).not.toBeNull();
    });

    it("returns an error for a string value", () => {
      const err = validateContractArgs([{ name: "amount", value: "100", type: "i128" }]);
      expect(err).not.toBeNull();
    });

    it("returns an error when bigint exceeds i128 max", () => {
      const err = validateContractArgs([{ name: "amount", value: (1n << 127n), type: "i128" }]);
      expect(err).not.toBeNull();
      expect(err).toContain("out of range");
    });

    it("returns null for i128 max boundary value", () => {
      const max = (1n << 127n) - 1n;
      expect(validateContractArgs([{ name: "amount", value: max, type: "i128" }])).toBeNull();
    });

    it("returns null for i128 min boundary value", () => {
      const min = -(1n << 127n);
      expect(validateContractArgs([{ name: "amount", value: min, type: "i128" }])).toBeNull();
    });

    it("returns an error when bigint is below i128 min", () => {
      const err = validateContractArgs([{ name: "amount", value: -(1n << 127n) - 1n, type: "i128" }]);
      expect(err).not.toBeNull();
    });
  });

  describe("bool type", () => {
    it("returns null for true", () => {
      expect(validateContractArgs([{ name: "flag", value: true, type: "bool" }])).toBeNull();
    });

    it("returns null for false", () => {
      expect(validateContractArgs([{ name: "flag", value: false, type: "bool" }])).toBeNull();
    });

    it("returns an error for 1 (truthy non-boolean)", () => {
      const err = validateContractArgs([{ name: "flag", value: 1, type: "bool" }]);
      expect(err).not.toBeNull();
      expect(err).toContain('"flag"');
    });

    it("returns an error for a string", () => {
      const err = validateContractArgs([{ name: "flag", value: "true", type: "bool" }]);
      expect(err).not.toBeNull();
    });
  });

  describe("addressVec type", () => {
    it("returns null for a valid single-element array", () => {
      expect(
        validateContractArgs([{ name: "members", value: [MEMBER_A_ADDR], type: "addressVec" }]),
      ).toBeNull();
    });

    it("returns null for a valid multi-element array", () => {
      expect(
        validateContractArgs([
          { name: "members", value: [MEMBER_A_ADDR, MEMBER_B_ADDR], type: "addressVec" },
        ]),
      ).toBeNull();
    });

    it("returns an error for an empty array", () => {
      const err = validateContractArgs([{ name: "members", value: [], type: "addressVec" }]);
      expect(err).not.toBeNull();
      expect(err).toContain("empty");
    });

    it("returns an error when one entry is invalid and names its index", () => {
      const err = validateContractArgs([
        { name: "members", value: [MEMBER_A_ADDR, "bad-address"], type: "addressVec" },
      ]);
      expect(err).not.toBeNull();
      expect(err).toContain("members[1]");
    });

    it("returns an error for a non-array value", () => {
      const err = validateContractArgs([{ name: "members", value: null, type: "addressVec" }]);
      expect(err).not.toBeNull();
    });
  });

  describe("multiple params — stops at first error", () => {
    it("returns null when all params are valid", () => {
      const result = validateContractArgs([
        { name: "member", value: MEMBER_A_ADDR, type: "address" },
        { name: "amount", value: 100_000_000n, type: "i128" },
        { name: "rounds", value: 120_960, type: "u32" },
      ]);
      expect(result).toBeNull();
    });

    it("names the first failing parameter", () => {
      const err = validateContractArgs([
        { name: "member", value: MEMBER_A_ADDR, type: "address" },
        { name: "amount", value: "wrong" as any, type: "i128" },
        { name: "rounds", value: -1, type: "u32" },
      ]);
      expect(err).not.toBeNull();
      // "amount" fails before "rounds"
      expect(err).toContain('"amount"');
      expect(err).not.toContain('"rounds"');
    });
  });
});

// ─── 2. validateCircleUpConfig — indexerUrl validation ───────────────────────

describe("validateCircleUpConfig — indexerUrl", () => {
  const validBase = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015" as const,
    contracts: {
      circleFactory: FACTORY_ADDR,
      reputation: REPUTATION_ADDR,
      usdc: USDC_ADDR,
    },
  };

  it("accepts a config without indexerUrl", () => {
    expect(() => validateCircleUpConfig(validBase)).not.toThrow();
  });

  it("accepts a valid http indexerUrl", () => {
    expect(() =>
      validateCircleUpConfig({ ...validBase, indexerUrl: "http://localhost:3001" }),
    ).not.toThrow();
  });

  it("accepts a valid https indexerUrl", () => {
    expect(() =>
      validateCircleUpConfig({ ...validBase, indexerUrl: "https://indexer.circleup.xyz" }),
    ).not.toThrow();
  });

  it("accepts an empty string indexerUrl (treated as unset)", () => {
    // Empty string is allowed so the config can be built from env vars that
    // may not be set in all environments.
    expect(() =>
      validateCircleUpConfig({ ...validBase, indexerUrl: "" }),
    ).not.toThrow();
  });

  it("rejects a non-URL string indexerUrl", () => {
    expect(() =>
      validateCircleUpConfig({ ...validBase, indexerUrl: "not-a-url" }),
    ).toThrow(/indexerUrl/);
  });

  it("rejects a non-string indexerUrl", () => {
    expect(() =>
      validateCircleUpConfig({ ...validBase, indexerUrl: 3001 as any }),
    ).toThrow(/indexerUrl/);
  });

  it("error lists all problems together (indexerUrl + a bad contract address)", () => {
    let err: Error | null = null;
    try {
      validateCircleUpConfig({
        ...validBase,
        contracts: { ...validBase.contracts, usdc: "BADADDR" },
        indexerUrl: "not-a-url",
      });
    } catch (e: any) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("usdc");
    expect(err!.message).toContain("indexerUrl");
  });
});

// ─── 3. extractSimulationError — host-error translations ─────────────────────
//
// extractSimulationError is private, so it is exercised via the
// simulation_failed path in buildAndSend, which calls it internally.

describe("extractSimulationError — host-error patterns (via buildAndSend)", () => {
  // A thin subclass that exposes buildAndSend for direct testing
  class TestClient extends CircleUpClient {
    call(method = "join") {
      return this.buildAndSend(MEMBER_A, CIRCLE_ADDR, method, []);
    }
  }

  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
  });

  it("surfaces a debug log message verbatim", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError('HostError: Value(UnexpectedType)\n  contract log (debug): "deadline has passed"'),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain("deadline has passed");
      expect(result.errorCode).toBe("simulation_failed");
    }
  });

  it("surfaces a panic message verbatim", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError('HostError\n  panic called with: "round not started"'),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain("round not started");
    }
  });

  it("translates Value(UnexpectedType) to an argument-type hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Value(UnexpectedType)"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toMatch(/wrong type/i);
    }
  });

  it("translates Value(MissingValue) to a contract-not-initialised hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Value(MissingValue)"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toMatch(/does not exist|not initialised/i);
    }
  });

  it("translates Auth(NotAuthorized) to an authorisation hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Auth(NotAuthorized)"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toMatch(/authoris/i);
    }
  });

  it("translates Budget(CpuLimitExceeded) to a resource hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Budget(CpuLimitExceeded)"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toMatch(/CPU|memory/i);
    }
  });

  it("translates Storage(MissingValue) to a contract-not-deployed hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Storage(MissingValue)"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toMatch(/storage|deployed/i);
    }
  });

  it("falls back to the contract error code when no pattern matches", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: SomeUnknownVariant\nError(Contract, #7)"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain("Contract error code 7");
    }
  });

  it("trims a very long unrecognised error to 300 chars", async () => {
    const longError = "UnknownError: " + "x".repeat(500);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError(longError),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      // The extracted portion must be trimmed; the full context string wrapping
      // it adds method/contract context so just verify no enormous blob passes.
      expect(result.errorMessage.length).toBeLessThan(700);
    }
  });
});

// ─── 4. formatRpcError — network error normalisation ─────────────────────────
//
// formatRpcError is private, tested via the network_error paths in buildAndSend.

describe("formatRpcError — network error messages (via buildAndSend)", () => {
  class TestClient extends CircleUpClient {
    call() {
      return this.buildAndSend(MEMBER_A, CIRCLE_ADDR, "join", []);
    }
  }

  it("translates ECONNREFUSED to a connection-refused hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:8000"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toMatch(/connection refused/i);
    }
  });

  it("translates ENOTFOUND to a DNS failure hint", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND soroban-testnet.stellar.org"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toMatch(/DNS/i);
    }
  });

  it("translates ETIMEDOUT to a timeout hint during simulation", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockRejectedValue(
      new Error("connect ETIMEDOUT"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toMatch(/overloaded|time/i);
    }
  });

  it("translates 'failed to fetch' during sendTransaction", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockRejectedValue(
      new Error("Failed to fetch"),
    );
    // A failed fetch may still have delivered the request, so the SDK looks
    // the hash up; keep that lookup failing too.
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("Failed to fetch"),
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("outcome_unknown");
      expect(result.errorMessage).toMatch(/fetch|network/i);
      expect(result.diagnostics?.lastError).toMatch(/fetch/i);
    }
  });

  it("translates ECONNREFUSED during confirmation polling", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "HASH_CONN",
    } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:8000"),
    );
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      // Submitted and accepted, then connectivity was lost: outcome unknown.
      expect(result.errorCode).toBe("outcome_unknown");
      expect(result.errorMessage).toMatch(/connection refused/i);
    }
  });
});

// ─── 5. decode helpers — richer type info ────────────────────────────────────

describe("decodeU32 — type name in error message", () => {
  it("includes 'type: bigint' when a bigint is received", () => {
    expect(() => decodeU32(5n, "myField")).toThrow(/type: bigint/);
  });

  it("includes 'type: string' when a string is received", () => {
    expect(() => decodeU32("5", "myField")).toThrow(/type: string/);
  });

  it("includes 'type: object' when null is received", () => {
    expect(() => decodeU32(null, "myField")).toThrow(/type: object/);
  });

  it("includes the label in the error message", () => {
    expect(() => decodeU32("wrong", "roundDeadlineLedgers")).toThrow(/roundDeadlineLedgers/);
  });

  it("still accepts 0 (minimum u32)", () => {
    expect(decodeU32(0, "t")).toBe(0);
  });

  it("still accepts 4294967295 (maximum u32)", () => {
    expect(decodeU32(0xffffffff, "t")).toBe(0xffffffff);
  });

  it("rejects a float with the out-of-range message (not type message)", () => {
    // 1.5 is a number so typeof passes, but isInteger fails
    const err = (() => {
      try { decodeU32(1.5, "t"); return null; } catch (e: any) { return e.message; }
    })();
    expect(err).toContain("4294967295");
  });
});

describe("decodeBigInt — type name in error message", () => {
  it("includes 'type: string' when a string is received", () => {
    expect(() => decodeBigInt("100", "myField")).toThrow(/type: string/);
  });

  it("includes 'type: boolean' when a boolean is received", () => {
    expect(() => decodeBigInt(true, "myField")).toThrow(/type: boolean/);
  });

  it("includes the label in the error message", () => {
    expect(() => decodeBigInt("bad", "roundAmount")).toThrow(/roundAmount/);
  });

  it("still accepts a bigint", () => {
    expect(decodeBigInt(999n, "t")).toBe(999n);
  });

  it("still widens a safe integer number", () => {
    expect(decodeBigInt(42, "t")).toBe(42n);
  });

  it("precision error for unsafe number includes 'precision'", () => {
    expect(() => decodeBigInt(Number.MAX_SAFE_INTEGER + 2, "t")).toThrow(/precision/);
  });
});

describe("decodeBoolean — type name in error message", () => {
  it("includes 'type: number' when 1 is received", () => {
    expect(() => decodeBoolean(1, "paidOut")).toThrow(/type: number/);
  });

  it("includes 'type: string' when a string is received", () => {
    expect(() => decodeBoolean("true", "paidOut")).toThrow(/type: string/);
  });

  it("includes the label", () => {
    expect(() => decodeBoolean(0, "myBoolField")).toThrow(/myBoolField/);
  });
});

describe("decodeAddress — type name in error message", () => {
  it("includes 'type: number' when a number is received", () => {
    expect(() => decodeAddress(123, "recipient")).toThrow(/type: number/);
  });

  it("includes 'type: null' when null is received", () => {
    expect(() => decodeAddress(null, "recipient")).toThrow(/null/);
  });

  it("includes the label", () => {
    expect(() => decodeAddress("BADADDR", "myAddress")).toThrow(/myAddress/);
  });
});

// ─── 6. FactoryClient.createCircle — pre-encoding validation ─────────────────

describe("FactoryClient.createCircle — validateContractArgs integration", () => {
  function failOnAnyRpc() {
    const boom = () => { throw new Error("RPC must not be called"); };
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockImplementation(boom as any);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockImplementation(boom as any);
  }

  it("rejects an empty members list as invalid_argument without any RPC call", async () => {
    failOnAnyRpc();
    const { result } = await factory().createCircle({
      creator: CREATOR,
      members: [],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: 120_960,
    });
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("members");
      expect(result.txHash).toBe("");
    }
  });

  it("rejects an invalid member address as invalid_argument without any RPC call", async () => {
    failOnAnyRpc();
    const { result } = await factory().createCircle({
      creator: CREATOR,
      members: [MEMBER_A_ADDR, "bad-address"],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: 120_960,
    });
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("members");
    }
  });

  it("rejects a precision-losing round amount as invalid_argument", async () => {
    failOnAnyRpc();
    const { result } = await factory().createCircle({
      creator: CREATOR,
      members: [MEMBER_A_ADDR],
      roundAmountStroops: (Number.MAX_SAFE_INTEGER + 2) as unknown as bigint,
      roundDeadlineLedgers: 120_960,
    });
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("precision");
    }
  });

  it("rejects a negative roundDeadlineLedgers as invalid_argument", async () => {
    failOnAnyRpc();
    const { result } = await factory().createCircle({
      creator: CREATOR,
      members: [MEMBER_A_ADDR],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: -1,
    });
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
    }
  });

  it("circleAddress is undefined when validation fails", async () => {
    failOnAnyRpc();
    const { result, circleAddress } = await factory().createCircle({
      creator: CREATOR,
      members: [],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: 120_960,
    });
    expect(circleAddress).toBeUndefined();
    expect(isTxFailure(result)).toBe(true);
  });
});

// ─── 7. CircleClient.markDefault — pre-encoding validation ───────────────────

describe("CircleClient.markDefault — validateContractArgs integration", () => {
  function failOnAnyRpc() {
    const boom = () => { throw new Error("RPC must not be called"); };
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockImplementation(boom as any);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockImplementation(boom as any);
  }

  it("rejects a non-address member string without any RPC call", async () => {
    failOnAnyRpc();
    const result = await circle().markDefault(CREATOR, "not-an-address");
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("mark_default");
      expect(result.txHash).toBe("");
    }
  });

  it("rejects an empty string member without any RPC call", async () => {
    failOnAnyRpc();
    const result = await circle().markDefault(CREATOR, "");
    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
    }
  });

  it("accepts a valid member address and proceeds to network I/O", async () => {
    // Allow the account load, then stop at simulation — we only want to confirm
    // that validateContractArgs did NOT reject a good address.
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "HASH_MARK",
    } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 10,
    } as any);

    const result = await circle().markDefault(CREATOR, MEMBER_B_ADDR);
    expect(isTxSuccess(result)).toBe(true);
  });
});

// ─── 8. Boundary values ───────────────────────────────────────────────────────

describe("boundary values — scI128 and scU32 via validateContractArgs", () => {
  it("accepts i128 max ((2^127) - 1)", () => {
    const max = (1n << 127n) - 1n;
    expect(validateContractArgs([{ name: "v", value: max, type: "i128" }])).toBeNull();
  });

  it("rejects i128 max + 1 (overflow)", () => {
    const overflow = 1n << 127n;
    expect(validateContractArgs([{ name: "v", value: overflow, type: "i128" }])).not.toBeNull();
  });

  it("accepts i128 min (-(2^127))", () => {
    const min = -(1n << 127n);
    expect(validateContractArgs([{ name: "v", value: min, type: "i128" }])).toBeNull();
  });

  it("rejects i128 min - 1 (underflow)", () => {
    const underflow = -(1n << 127n) - 1n;
    expect(validateContractArgs([{ name: "v", value: underflow, type: "i128" }])).not.toBeNull();
  });

  it("accepts u32 min (0)", () => {
    expect(validateContractArgs([{ name: "v", value: 0, type: "u32" }])).toBeNull();
  });

  it("accepts u32 max (4294967295)", () => {
    expect(validateContractArgs([{ name: "v", value: 0xffffffff, type: "u32" }])).toBeNull();
  });

  it("rejects u32 max + 1 (overflow)", () => {
    expect(validateContractArgs([{ name: "v", value: 0x100000000, type: "u32" }])).not.toBeNull();
  });

  it("accepts Number.MAX_SAFE_INTEGER as i128 (exact bigint conversion)", () => {
    expect(
      validateContractArgs([{ name: "v", value: Number.MAX_SAFE_INTEGER, type: "i128" }]),
    ).toBeNull();
  });

  it("rejects Number.MAX_SAFE_INTEGER + 1 due to precision loss", () => {
    // MAX_SAFE_INTEGER + 1 is the first integer that cannot be represented
    // exactly in a float64, so BigInt(it) would silently round.
    const err = validateContractArgs([
      { name: "v", value: Number.MAX_SAFE_INTEGER + 1, type: "i128" },
    ]);
    expect(err).not.toBeNull();
    expect(err).toContain("precision");
  });
});
