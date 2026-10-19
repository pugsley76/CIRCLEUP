/**
 * Tests for retry behavior on transient Soroban RPC failures in the app layer.
 *
 * Covers:
 *   - isTransientRpcError classification (network codes, HTTP status, strings)
 *   - withRpcRetry: retries on transient errors, fails fast on non-transient
 *   - withRpcRetry: full jitter — delays are within expected bounds
 *   - withRpcRetry: respects maxAttempts ceiling
 *   - withRpcRetry: resets cleanly across independent calls (no leaked state)
 */

import { describe, it, expect } from "vitest";
import { isTransientRpcError, withRpcRetry } from "../lib/stellar";

// ─── isTransientRpcError ──────────────────────────────────────────────────────

describe("isTransientRpcError", () => {
  it("returns false for null/undefined", () => {
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });

  it("returns true for ECONNRESET error code", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED error code", () => {
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT error code", () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for ENOTFOUND error code", () => {
    const err = Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for HTTP 429 (rate limited)", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for HTTP 502 (bad gateway)", () => {
    const err = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for HTTP 503 (service unavailable)", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for HTTP 504 (gateway timeout)", () => {
    const err = Object.assign(new Error("Gateway Timeout"), { status: 504 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it("returns true for message containing 'timeout'", () => {
    expect(isTransientRpcError(new Error("request timeout"))).toBe(true);
  });

  it("returns true for message containing 'rate limit'", () => {
    expect(isTransientRpcError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("returns true for message containing 'socket hang up'", () => {
    expect(isTransientRpcError(new Error("socket hang up"))).toBe(true);
  });

  it("returns true for message containing 'network'", () => {
    expect(isTransientRpcError(new Error("network error"))).toBe(true);
  });

  it("returns true for 'failed to fetch'", () => {
    expect(isTransientRpcError(new Error("failed to fetch"))).toBe(true);
  });

  it("returns true for 'service unavailable' in message", () => {
    expect(isTransientRpcError(new Error("service unavailable"))).toBe(true);
  });

  it("returns false for non-transient simulation error", () => {
    expect(isTransientRpcError(new Error("HostError: Value(UnexpectedType)"))).toBe(false);
  });

  it("returns false for non-transient auth error", () => {
    expect(isTransientRpcError(new Error("Auth(NotAuthorized)"))).toBe(false);
  });

  it("returns false for malformed request error", () => {
    expect(isTransientRpcError(new Error("malformed request body"))).toBe(false);
  });

  it("returns false for HTTP 400 (bad request)", () => {
    const err = Object.assign(new Error("Bad Request"), { status: 400 });
    expect(isTransientRpcError(err)).toBe(false);
  });

  it("returns false for HTTP 401 (unauthorized)", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(isTransientRpcError(err)).toBe(false);
  });

  it("returns false for HTTP 404 (not found)", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    expect(isTransientRpcError(err)).toBe(false);
  });
});

// ─── withRpcRetry ─────────────────────────────────────────────────────────────

describe("withRpcRetry", () => {
  const noSleep = async (_ms: number) => {};

  it("returns the result on immediate success without any sleep", async () => {
    const sleeps: number[] = [];
    const result = await withRpcRetry(
      "test",
      async () => "ok",
      3,
      100,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(result).toBe("ok");
    expect(sleeps).toHaveLength(0);
  });

  it("retries a transient error and succeeds on the second attempt", async () => {
    let calls = 0;
    const result = await withRpcRetry(
      "test",
      async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        return "success";
      },
      3,
      50,
      noSleep,
    );
    expect(result).toBe("success");
    expect(calls).toBe(2);
  });

  it("retries up to maxAttempts then throws the last error", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
        },
        3,
        50,
        noSleep,
      ),
    ).rejects.toThrow("ETIMEDOUT");
    expect(calls).toBe(3);
  });

  it("does NOT retry a non-transient error — fails on the first attempt", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw new Error("HostError: Value(UnexpectedType)");
        },
        3,
        50,
        noSleep,
      ),
    ).rejects.toThrow("HostError");
    expect(calls).toBe(1);
  });

  it("applies a delay between retries (jitter ceiling is respected)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await withRpcRetry(
      "test",
      async () => {
        calls++;
        if (calls <= 2) throw Object.assign(new Error("timeout"), {});
        return "done";
      },
      4,
      200,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    // Two retries → two sleep calls
    expect(sleeps).toHaveLength(2);
    // Attempt 1 delay: [0, 200]; attempt 2 delay: [0, 400]
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThanOrEqual(200);
    expect(sleeps[1]).toBeGreaterThanOrEqual(0);
    expect(sleeps[1]).toBeLessThanOrEqual(400);
  });

  it("resets attempt count across independent calls (no leaked state)", async () => {
    let calls1 = 0;
    const r1 = await withRpcRetry(
      "call1",
      async () => {
        calls1++;
        if (calls1 < 3) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        return "r1";
      },
      5,
      10,
      noSleep,
    );
    expect(r1).toBe("r1");

    // Second call must start fresh from attempt 1
    let calls2 = 0;
    const r2 = await withRpcRetry(
      "call2",
      async () => {
        calls2++;
        if (calls2 < 2) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        return "r2";
      },
      5,
      10,
      noSleep,
    );
    expect(r2).toBe("r2");
    expect(calls2).toBe(2);
  });

  it("maxAttempts of 1 means no retries — fails immediately on transient error", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        },
        1,
        50,
        noSleep,
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
  });
});
