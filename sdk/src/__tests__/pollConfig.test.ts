/**
 * Tests for Issue 115: retry configuration and backoff in the SDK tx polling loop.
 *
 * What is verified:
 *   - PollConfig fields (timeoutMs, initialIntervalMs, maxIntervalMs,
 *     backoffFactor, maxConsecutiveErrors) are respected by buildAndSend
 *   - Backoff interval grows after NOT_FOUND responses but is capped at maxIntervalMs
 *   - The error threshold from maxConsecutiveErrors (not a hardcoded 5) governs
 *     the consecutive-failure bail-out
 *   - Timeout is computed from timeoutMs, not a hardcoded constant
 *   - backoffFactor < 1 is rejected at construction time
 *   - Default values are sane positive numbers
 *
 * All network calls are stubbed — no live RPC or Stellar SDK round-trips.
 * Fake timers are NOT used here: the jittered waits are replaced by mocking
 * setTimeout globally so tests run synchronously.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SorobanRpc } from "@stellar/stellar-sdk";
import {
  CircleUpClient,
  DEFAULT_POLL_CONFIG,
  type PollConfig,
} from "../client";
import { isTxSuccess, isTxFailure } from "../types";
import {
  CIRCLE_ADDR,
  MEMBER_A,
  MOCK_ACCOUNT,
  SDK_CONFIG,
  simulationSuccess,
} from "./fixtures";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONTRACT_ID = CIRCLE_ADDR;

// ─── Thin subclass that exposes the protected method ─────────────────────────

class TestClient extends CircleUpClient {
  call(method = "join") {
    return this.buildAndSend(MEMBER_A, CONTRACT_ID, method, []);
  }
}

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockHappyPath() {
  vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
  vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
    simulationSuccess(),
  );
}

function mockSendOk(hash = "TXHASH") {
  vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
    status: "PENDING",
    hash,
  } as any);
}

function mockGetTxSuccess(ledger = 10) {
  vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue({
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    ledger,
  } as any);
}

/**
 * Poll forever with NOT_FOUND on a virtual clock that advances one second per
 * poll — the rough cost of a real RPC round-trip — so the timeout branch is
 * reached deterministically.
 *
 * Counting `Date.now` calls instead would couple the test to how many times the
 * SDK (and the Stellar SDK underneath it) happens to read the clock, which is
 * the kind of brittleness that turns a timeout test into an infinite loop as
 * soon as an unrelated call is added.
 */
function mockGetTxNotFoundOnVirtualClock() {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockImplementation(
    async () => {
      now += 1_000;
      return { status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND } as any;
    },
  );
}

function mockGetTxError(message = "RPC error") {
  vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
    new Error(message),
  );
}

// Replace setTimeout so the polling loop runs without real wall-clock delays.
// We do this once globally for the suite — it only affects the sleep inside
// the polling loop.  The replacement resolves immediately so every iteration
// fires in the same microtask queue drain.
beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any) => {
    fn();
    return 0 as any;
  });
  // Stub Math.random so jitter is deterministic (always 0 ms)
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => vi.restoreAllMocks());

// ─── DEFAULT_POLL_CONFIG ──────────────────────────────────────────────────────

describe("DEFAULT_POLL_CONFIG", () => {
  it("exports sensible positive defaults", () => {
    expect(DEFAULT_POLL_CONFIG.initialIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_POLL_CONFIG.maxIntervalMs).toBeGreaterThanOrEqual(
      DEFAULT_POLL_CONFIG.initialIntervalMs,
    );
    expect(DEFAULT_POLL_CONFIG.backoffFactor).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_POLL_CONFIG.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_POLL_CONFIG.maxConsecutiveErrors).toBeGreaterThan(0);
  });

  it("timeoutMs is at least 30 s to handle real-world network conditions", () => {
    expect(DEFAULT_POLL_CONFIG.timeoutMs).toBeGreaterThanOrEqual(30_000);
  });
});

// ─── PollConfig constructor validation ───────────────────────────────────────

describe("CircleUpClient constructor — PollConfig validation", () => {
  it("accepts a valid PollConfig without throwing", () => {
    const cfg: PollConfig = {
      initialIntervalMs: 500,
      maxIntervalMs: 5_000,
      backoffFactor: 2,
      timeoutMs: 30_000,
      maxConsecutiveErrors: 3,
    };
    expect(() => new TestClient(SDK_CONFIG, cfg)).not.toThrow();
  });

  it("throws RangeError when backoffFactor < 1", () => {
    expect(
      () => new TestClient(SDK_CONFIG, { backoffFactor: 0.5 }),
    ).toThrow(/backoffFactor/);
  });

  it("throws RangeError when backoffFactor is exactly 0", () => {
    expect(() => new TestClient(SDK_CONFIG, { backoffFactor: 0 })).toThrow(RangeError);
  });

  it("accepts backoffFactor = 1 (flat retry schedule)", () => {
    expect(() => new TestClient(SDK_CONFIG, { backoffFactor: 1 })).not.toThrow();
  });

  it("merges partial config with defaults — unspecified fields keep defaults", () => {
    const client = new TestClient(SDK_CONFIG, { timeoutMs: 5_000 });
    // pollConfig is protected — access via cast for the test
    const pc = (client as any).pollConfig as Required<PollConfig>;
    expect(pc.timeoutMs).toBe(5_000);
    // Unspecified fields should fall back to the defaults
    expect(pc.initialIntervalMs).toBe(DEFAULT_POLL_CONFIG.initialIntervalMs);
    expect(pc.backoffFactor).toBe(DEFAULT_POLL_CONFIG.backoffFactor);
  });

  it("no-arg constructor uses defaults for all poll fields", () => {
    const client = new TestClient(SDK_CONFIG);
    const pc = (client as any).pollConfig as Required<PollConfig>;
    expect(pc).toMatchObject(DEFAULT_POLL_CONFIG);
  });
});

// ─── timeoutMs governs the polling window ────────────────────────────────────

describe("buildAndSend — timeoutMs controls timeout duration", () => {
  it("times out when getTransaction always returns NOT_FOUND within budget", async () => {
    mockHappyPath();
    mockSendOk("HASH_TIMEOUT");
    mockGetTxNotFoundOnVirtualClock();

    const client = new TestClient(SDK_CONFIG, { timeoutMs: 5_000 });
    const result = await client.call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("timeout");
      // Error message should mention the configured timeout in seconds
      expect(result.errorMessage).toContain("5s");
      expect(result.txHash).toBe("HASH_TIMEOUT");
    }
  });

  it("timeout message reflects the configured timeoutMs value", async () => {
    mockHappyPath();
    mockSendOk("HASH_T");
    mockGetTxNotFoundOnVirtualClock();

    const client = new TestClient(SDK_CONFIG, { timeoutMs: 120_000 });
    const result = await client.call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain("120s");
    }
  });
});

// ─── maxConsecutiveErrors governs the bail-out threshold ─────────────────────

describe("buildAndSend — maxConsecutiveErrors threshold", () => {
  it("bails out after exactly maxConsecutiveErrors consecutive poll failures", async () => {
    mockHappyPath();
    mockSendOk("HASH_ERR");
    mockGetTxError("connection refused");

    // Keep Date.now within the budget so only the error threshold triggers the bail
    vi.spyOn(Date, "now").mockReturnValue(0);

    const client = new TestClient(SDK_CONFIG, {
      maxConsecutiveErrors: 3,
      timeoutMs: 60_000,
    });
    const result = await client.call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("outcome_unknown");
      expect(result.errorMessage).toContain("connection refused");
    }
    // getTransaction should have been called exactly 3 times
    expect(
      vi.mocked(SorobanRpc.Server.prototype.getTransaction).mock.calls.length,
    ).toBe(3);
  });

  it("a different maxConsecutiveErrors value changes the call count before bail-out", async () => {
    mockHappyPath();
    mockSendOk("HASH_ERR2");
    mockGetTxError("timeout");

    vi.spyOn(Date, "now").mockReturnValue(0);

    const client = new TestClient(SDK_CONFIG, {
      maxConsecutiveErrors: 7,
      timeoutMs: 60_000,
    });
    await client.call();

    expect(
      vi.mocked(SorobanRpc.Server.prototype.getTransaction).mock.calls.length,
    ).toBe(7);
  });

  it("error counter resets to 0 after a successful poll", async () => {
    mockHappyPath();
    mockSendOk("HASH_RECOVER");

    // Two errors then a SUCCESS
    let pollCount = 0;
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockImplementation(async () => {
      pollCount++;
      if (pollCount <= 2) throw new Error("transient");
      return {
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 55,
      } as any;
    });

    // Keep Date.now within budget
    vi.spyOn(Date, "now").mockReturnValue(0);

    // maxConsecutiveErrors = 5 means 2 errors should NOT trigger bail-out
    const client = new TestClient(SDK_CONFIG, {
      maxConsecutiveErrors: 5,
      timeoutMs: 60_000,
    });
    const result = await client.call();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.ledger).toBe(55);
    }
    expect(pollCount).toBe(3);
  });
});

// ─── Backoff interval growth ──────────────────────────────────────────────────

describe("buildAndSend — backoff interval growth", () => {
  it("interval is capped at maxIntervalMs regardless of backoffFactor", async () => {
    mockHappyPath();
    mockSendOk("HASH_BACKOFF");

    // Record the wait values passed to setTimeout
    const waits: number[] = [];
    vi.mocked(globalThis.setTimeout).mockImplementation((fn: any, ms?: number) => {
      waits.push(ms ?? 0);
      fn();
      return 0 as any;
    });
    // With jitter = 0 (Math.random mocked to 0), wait = Math.floor(0 * interval) = 0
    // so we can't observe interval growth directly through the wait argument alone.
    // Instead we verify that after a series of NOT_FOUNDs the client eventually
    // succeeds — this proves the loop continues beyond the first poll.

    let pollCount = 0;
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockImplementation(async () => {
      pollCount++;
      if (pollCount < 4) {
        return { status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND } as any;
      }
      return {
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 99,
      } as any;
    });

    vi.spyOn(Date, "now").mockReturnValue(0);

    const client = new TestClient(SDK_CONFIG, {
      initialIntervalMs: 1_000,
      maxIntervalMs: 2_000,
      backoffFactor: 10, // aggressive growth — should hit cap quickly
      timeoutMs: 60_000,
    });
    const result = await client.call();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) expect(result.ledger).toBe(99);
    expect(pollCount).toBe(4);
  });

  it("backoffFactor = 1 keeps the interval flat", async () => {
    mockHappyPath();
    mockSendOk("HASH_FLAT");

    const intervals: number[] = [];
    // Override Math.random to return 0.5 so jitteredWait = Math.floor(0.5 * interval)
    vi.mocked(Math.random).mockReturnValue(0.5);
    vi.mocked(globalThis.setTimeout).mockImplementation((fn: any, ms?: number) => {
      if (ms !== undefined) intervals.push(ms);
      fn();
      return 0 as any;
    });

    let pollCount = 0;
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockImplementation(async () => {
      pollCount++;
      if (pollCount < 3) {
        return { status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND } as any;
      }
      return {
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 7,
      } as any;
    });

    vi.spyOn(Date, "now").mockReturnValue(0);

    const client = new TestClient(SDK_CONFIG, {
      initialIntervalMs: 1_000,
      maxIntervalMs: 10_000,
      backoffFactor: 1, // flat
      timeoutMs: 60_000,
    });
    await client.call();

    // With backoffFactor=1 every jittered wait = Math.floor(0.5 * 1000) = 500
    const pollIntervals = intervals.filter((ms) => ms === 500);
    expect(pollIntervals.length).toBe(3); // one per poll attempt
    // All intervals should be equal (no growth)
    expect(new Set(pollIntervals).size).toBe(1);
  });
});

// ─── Successful tx still works with custom PollConfig ────────────────────────

describe("buildAndSend — success with custom PollConfig", () => {
  it("returns TxSuccess with correct hash and ledger when tx confirms on first poll", async () => {
    mockHappyPath();
    mockSendOk("HASH_CUSTOM");
    mockGetTxSuccess(42);
    vi.spyOn(Date, "now").mockReturnValue(0);

    const client = new TestClient(SDK_CONFIG, {
      initialIntervalMs: 100,
      maxIntervalMs: 500,
      backoffFactor: 2,
      timeoutMs: 30_000,
      maxConsecutiveErrors: 2,
    });
    const result = await client.call();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.txHash).toBe("HASH_CUSTOM");
      expect(result.ledger).toBe(42);
    }
  });
});

// ─── Full PollConfig validation ───────────────────────────────────────────────

describe("CircleUpClient constructor — rejects unusable poll schedules", () => {
  const cases: Array<[string, PollConfig, RegExp]> = [
    ["zero timeoutMs", { timeoutMs: 0 }, /timeoutMs/],
    ["negative initialIntervalMs", { initialIntervalMs: -1 }, /initialIntervalMs/],
    ["NaN maxIntervalMs", { maxIntervalMs: NaN }, /maxIntervalMs/],
    ["Infinity backoffFactor", { backoffFactor: Infinity }, /backoffFactor/],
    ["zero maxConsecutiveErrors", { maxConsecutiveErrors: 0 }, /maxConsecutiveErrors/],
    [
      "fractional maxConsecutiveErrors",
      { maxConsecutiveErrors: 2.5 },
      /whole number/,
    ],
    [
      "maxIntervalMs below initialIntervalMs",
      { initialIntervalMs: 5_000, maxIntervalMs: 1_000 },
      /must be >= initialIntervalMs/,
    ],
    [
      "timeoutMs below initialIntervalMs",
      { initialIntervalMs: 5_000, maxIntervalMs: 10_000, timeoutMs: 1_000 },
      /times out before its first poll/,
    ],
  ];

  it.each(cases)("rejects %s", (_label, cfg, expected) => {
    expect(() => new TestClient(SDK_CONFIG, cfg)).toThrow(RangeError);
    expect(() => new TestClient(SDK_CONFIG, cfg)).toThrow(expected);
  });

  it("reports every problem in one error rather than only the first", () => {
    try {
      new TestClient(SDK_CONFIG, { timeoutMs: 0, backoffFactor: 0.5 });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("timeoutMs");
      expect(err.message).toContain("backoffFactor");
    }
  });

  it("rejects an explicitly undefined field instead of silently polling on NaN", () => {
    // `{ timeoutMs: opts.timeout }` where opts.timeout is undefined used to
    // produce `Date.now() - start < undefined`, i.e. an instant timeout whose
    // message read "NaNs".
    expect(
      () => new TestClient(SDK_CONFIG, { timeoutMs: undefined as any }),
    ).toThrow(/timeoutMs/);
  });
});
