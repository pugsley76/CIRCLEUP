/**
 * Tests for retry behavior on transient Soroban RPC failures in the SDK layer.
 *
 * Covers:
 *   - isTransientRpcError: classifies error codes, HTTP status codes, and
 *     message patterns correctly
 *   - withRpcRetry: retries transient errors, fails fast on non-transient ones
 *   - withRpcRetry: jitter-bounded delays, maxAttempts ceiling, no leaked state
 */

import { describe, it, expect } from "vitest";
import { isTransientRpcError, withRpcRetry } from "./client";

const noSleep = async (_ms: number) => {};

// ─── isTransientRpcError ──────────────────────────────────────────────────────

describe("isTransientRpcError", () => {
  it("returns false for null / undefined", () => {
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });

  it.each([
    ["ECONNRESET", "socket hang up"],
    ["ECONNREFUSED", "connection refused"],
    ["ETIMEDOUT", "timed out"],
    ["ENOTFOUND", "DNS lookup failed"],
    ["EAI_AGAIN", "DNS again"],
    ["EPIPE", "broken pipe"],
    ["EHOSTUNREACH", "host unreachable"],
  ])("returns true for error code %s", (code, msg) => {
    const err = Object.assign(new Error(msg), { code });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it.each([429, 502, 503, 504])(
    "returns true for HTTP status %i",
    (status) => {
      const err = Object.assign(new Error("http error"), { status });
      expect(isTransientRpcError(err)).toBe(true);
    },
  );

  it.each([
    "request timeout",
    "timed out waiting",
    "rate limit exceeded",
    "too many requests",
    "econnreset",
    "socket hang up",
    "network error",
    "failed to fetch",
    "fetch failed",
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
  ])("returns true for message containing '%s'", (msg) => {
    expect(isTransientRpcError(new Error(msg))).toBe(true);
  });

  it.each([
    "HostError: Value(UnexpectedType)",
    "Auth(NotAuthorized)",
    "malformed request body",
    "contract panic: already initialized",
  ])("returns false for non-transient error: '%s'", (msg) => {
    expect(isTransientRpcError(new Error(msg))).toBe(false);
  });

  it.each([400, 401, 403, 404])(
    "returns false for HTTP status %i (non-transient)",
    (status) => {
      const err = Object.assign(new Error("client error"), { status });
      expect(isTransientRpcError(err)).toBe(false);
    },
  );
});

// ─── withRpcRetry ─────────────────────────────────────────────────────────────

describe("withRpcRetry", () => {
  it("returns the result on immediate success with no delay", async () => {
    const delays: number[] = [];
    const result = await withRpcRetry(
      "test",
      async () => 42,
      3,
      100,
      async (ms) => { delays.push(ms); },
    );
    expect(result).toBe(42);
    expect(delays).toHaveLength(0);
  });

  it("retries once on transient error and returns on second attempt", async () => {
    let calls = 0;
    const result = await withRpcRetry(
      "test",
      async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        return "ok";
      },
      3,
      50,
      noSleep,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("exhausts all attempts then throws on persistent transient error", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
        },
        4,
        50,
        noSleep,
      ),
    ).rejects.toThrow("ETIMEDOUT");
    expect(calls).toBe(4);
  });

  it("fails immediately on non-transient error (attempt 1 only)", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw new Error("HostError: Auth(NotAuthorized)");
        },
        5,
        50,
        noSleep,
      ),
    ).rejects.toThrow("HostError");
    expect(calls).toBe(1);
  });

  it("sleep delays are within expected jitter bounds", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRpcRetry(
      "test",
      async () => {
        calls++;
        if (calls <= 2)
          throw Object.assign(new Error("timeout"), {});
        return "done";
      },
      5,
      100,
      async (ms) => { delays.push(ms); },
    );
    expect(delays).toHaveLength(2);
    // Attempt 1 delay ceiling = 100ms (2^0 * 100)
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(100);
    // Attempt 2 delay ceiling = 200ms (2^1 * 100)
    expect(delays[1]).toBeGreaterThanOrEqual(0);
    expect(delays[1]).toBeLessThanOrEqual(200);
  });

  it("no leaked state: second call starts from attempt 1", async () => {
    // First call: succeeds on attempt 3
    let c1 = 0;
    await withRpcRetry(
      "a",
      async () => {
        c1++;
        if (c1 < 3) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        return "first";
      },
      5,
      10,
      noSleep,
    );

    // Second call: should start fresh — succeeds on attempt 2
    let c2 = 0;
    const r2 = await withRpcRetry(
      "b",
      async () => {
        c2++;
        if (c2 < 2) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        return "second";
      },
      5,
      10,
      noSleep,
    );
    expect(r2).toBe("second");
    expect(c2).toBe(2);
  });

  it("maxAttempts=1 means no retries even for transient errors", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
        1,
        50,
        noSleep,
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(1);
  });

  it("recovers on the last allowed attempt", async () => {
    let calls = 0;
    const result = await withRpcRetry(
      "test",
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("timeout"), {});
        return "last-chance";
      },
      3,
      10,
      noSleep,
    );
    expect(result).toBe("last-chance");
    expect(calls).toBe(3);
  });
});
