/**
 * Retry safety for writes: transient failures before submission, after
 * acceptance, and during status polling.
 *
 * The rule under test: reads and simulations retry freely, but a write is
 * never rebuilt or re-signed inside the SDK. A failed send is reported as
 * retryable only when the request provably never reached the RPC; every
 * ambiguous outcome is settled by looking the original hash up, or reported as
 * `outcome_unknown` with diagnostics.
 *
 * `Math.random` is pinned to 0 so resend backoff and poll jitter cost nothing.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { CircleUpClient, mayHaveReachedServer } from "../client";
import { isRetryable, isTxFailure, isTxSuccess } from "../types";
import {
  CIRCLE_ADDR,
  FAST_POLL,
  MEMBER_A,
  MOCK_ACCOUNT,
  SDK_CONFIG,
  simulationSuccess,
} from "./fixtures";

class TestClient extends CircleUpClient {
  call() {
    return this.buildAndSend(MEMBER_A, CIRCLE_ADDR, "join", []);
  }
}

const client = (poll = FAST_POLL) => new TestClient(SDK_CONFIG, poll);

/** A unix time comfortably past any envelope built during the test. */
const AFTER_EXPIRY = () => Math.floor(Date.now() / 1000) + 3_600;

const notFound = (extra: Record<string, unknown> = {}) =>
  ({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND, ...extra }) as any;
const found = (ledger = 99) =>
  ({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, ledger }) as any;
const errorWithCode = (message: string, props: Record<string, unknown>) =>
  Object.assign(new Error(message), props);

let getAccount: unknown;
let simulate: unknown;

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  getAccount = vi
    .spyOn(SorobanRpc.Server.prototype, "getAccount")
    .mockResolvedValue(MOCK_ACCOUNT);
  simulate = vi
    .spyOn(SorobanRpc.Server.prototype, "simulateTransaction")
    .mockResolvedValue(simulationSuccess());
});

afterEach(() => vi.restoreAllMocks());

/** The write must never be rebuilt: one account load, one simulation. */
function expectNotRebuilt() {
  expect(getAccount).toHaveBeenCalledTimes(1);
  expect(simulate).toHaveBeenCalledTimes(1);
}

// ─── Classification ───────────────────────────────────────────────────────────

describe("mayHaveReachedServer", () => {
  it.each([
    errorWithCode("connect ECONNREFUSED 127.0.0.1:8000", { code: "ECONNREFUSED" }),
    new Error("getaddrinfo ENOTFOUND soroban-testnet.stellar.org"),
    errorWithCode("lookup failed", { code: "EAI_AGAIN" }),
    errorWithCode("Too Many Requests", { status: 429 }),
    errorWithCode("invalid params", { code: -32602 }),
  ])("rules out delivery for %s", (err) => {
    expect(mayHaveReachedServer(err)).toBe(false);
  });

  it.each([
    new Error("socket hang up"),
    errorWithCode("read ECONNRESET", { code: "ECONNRESET" }),
    errorWithCode("ETIMEDOUT", { code: "ETIMEDOUT" }),
    errorWithCode("Bad Gateway", { status: 502 }),
    new Error("Failed to fetch"),
    new Error("something nobody anticipated"),
    undefined,
  ])("treats %s as possibly delivered", (err) => {
    expect(mayHaveReachedServer(err)).toBe(true);
  });
});

// ─── Failure before submission ────────────────────────────────────────────────

describe("send fails before reaching the RPC", () => {
  it("resends the same envelope, then reports a retryable network_error", async () => {
    const send = vi
      .spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockRejectedValue(errorWithCode("connect ECONNREFUSED", { code: "ECONNREFUSED" }));
    const poll = vi.spyOn(SorobanRpc.Server.prototype, "getTransaction");

    const result = await client().call();

    expect(isTxFailure(result) && result.errorCode).toBe("network_error");
    if (isTxFailure(result)) {
      expect(isRetryable(result)).toBe(true);
      expect(result.txHash).toBe("");
    }
    expect(send).toHaveBeenCalledTimes(3);
    // Every attempt sent the identical signed envelope.
    const hashes = send.mock.calls.map(([tx]) => (tx as any).hash().toString("hex"));
    expect(new Set(hashes).size).toBe(1);
    expect(poll).not.toHaveBeenCalled();
    expectNotRebuilt();
  });

  it("does not resend after a JSON-RPC rejection", async () => {
    const send = vi
      .spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockRejectedValue(errorWithCode("invalid params", { code: -32602 }));

    const result = await client().call();

    expect(isTxFailure(result) && result.errorCode).toBe("network_error");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ─── Ambiguous submission ─────────────────────────────────────────────────────

describe("send outcome is ambiguous", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockRejectedValue(
      new Error("socket hang up"),
    );
  });

  it("settles a write that did land by looking up the locally computed hash", async () => {
    const poll = vi
      .spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockResolvedValue(found(123));

    const result = await client().call();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.ledger).toBe(123);
      expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(poll).toHaveBeenCalledWith(result.txHash);
    }
    expectNotRebuilt();
  });

  it("reports tx_expired (retryable) once the envelope can no longer be included", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      notFound({ latestLedger: 10, latestLedgerCloseTime: AFTER_EXPIRY() }),
    );

    const result = await client().call();

    expect(isTxFailure(result) && result.errorCode).toBe("tx_expired");
    if (isTxFailure(result)) expect(isRetryable(result)).toBe(true);
    expectNotRebuilt();
  });

  it("reports outcome_unknown with diagnostics when the lookup cannot settle it", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("socket hang up"),
    );

    const result = await client().call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("outcome_unknown");
      expect(isRetryable(result)).toBe(false);
      expect(result.diagnostics).toMatchObject({
        txHash: result.txHash,
        submission: "unknown",
        sendAttempts: 3,
        lookup: "failed",
      });
      expect(result.diagnostics?.validUntil).toEqual(expect.any(Number));
      expect(result.diagnostics?.lastError).toContain("socket hang up");
    }
    expectNotRebuilt();
  });

  it("reports outcome_unknown after the poll budget when the hash is still not found", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(notFound());

    const result = await client({ ...FAST_POLL, timeoutMs: 50 }).call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("outcome_unknown");
      expect(result.diagnostics?.lookup).toBe("not_found");
    }
  });
});

describe("a resend after an ambiguous attempt", () => {
  it("treats a rejected resend as unsettled and finds the original landed", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockRejectedValueOnce(new Error("socket hang up"))
      // The first attempt consumed the sequence number, so the resend fails.
      .mockResolvedValueOnce({ status: "ERROR", hash: "RESEND", errorResult: undefined } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(found(7));

    const result = await client().call();

    expect(isTxSuccess(result)).toBe(true);
    expectNotRebuilt();
  });

  it("returns the rejection once the original is proven never applied", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ status: "ERROR", hash: "RESEND", errorResult: undefined } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      notFound({ latestLedgerCloseTime: AFTER_EXPIRY() }),
    );

    const result = await client().call();

    expect(isTxFailure(result) && result.errorCode).toBe("tx_rejected");
  });

  it("follows DUPLICATE to confirmation", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ status: "DUPLICATE", hash: "ORIGINAL" } as any);
    const poll = vi
      .spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockResolvedValue(found(8));

    const result = await client().call();

    expect(isTxSuccess(result) && result.txHash).toBe("ORIGINAL");
    expect(poll).toHaveBeenCalledWith("ORIGINAL");
  });
});

// ─── Failure after acceptance ─────────────────────────────────────────────────

describe("send accepted, then polling fails", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "ACCEPTED",
    } as any);
  });

  it("reports outcome_unknown (never network_error) when connectivity is lost", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("socket hang up"),
    );

    const result = await client().call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("outcome_unknown");
      expect(isRetryable(result)).toBe(false);
      expect(result.txHash).toBe("ACCEPTED");
      expect(result.diagnostics).toMatchObject({
        txHash: "ACCEPTED",
        submission: "accepted",
        sendAttempts: 1,
        lookup: "failed",
      });
    }
  });

  it("recovers from transient polling errors without resubmitting", async () => {
    const send = SorobanRpc.Server.prototype.sendTransaction as any;
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(found(55));

    const result = await client().call();

    expect(isTxSuccess(result) && result.ledger).toBe(55);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports tx_expired when an accepted transaction is dropped unincluded", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      notFound({ latestLedgerCloseTime: String(AFTER_EXPIRY()) }),
    );

    const result = await client().call();

    expect(isTxFailure(result) && result.errorCode).toBe("tx_expired");
  });

  it("still reports a plain timeout while the accepted transaction is pending", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(notFound());

    const result = await client({ ...FAST_POLL, timeoutMs: 50 }).call();

    expect(isTxFailure(result) && result.errorCode).toBe("timeout");
  });
});

// ─── lookupTransaction ────────────────────────────────────────────────────────

describe("CircleUpClient.lookupTransaction", () => {
  const HASH = "ab".repeat(32);

  it("rejects a malformed hash without contacting the RPC", async () => {
    const poll = vi.spyOn(SorobanRpc.Server.prototype, "getTransaction");
    const r = await client().lookupTransaction("not-a-hash");
    expect(r.ok).toBe(false);
    expect(poll).not.toHaveBeenCalled();
  });

  it("returns success with the ledger", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(found(42));
    const r = await client().lookupTransaction(HASH);
    expect(r).toEqual({
      ok: true,
      value: { status: "success", txHash: HASH, ledger: 42, returnValue: undefined },
    });
  });

  it("returns not_found with the RPC's ledger position", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      notFound({ latestLedger: 500, latestLedgerCloseTime: 1_700_000_000 }),
    );
    const r = await client().lookupTransaction(HASH);
    expect(r.ok && r.value).toEqual({
      status: "not_found",
      txHash: HASH,
      latestLedger: 500,
      latestLedgerCloseTime: 1_700_000_000,
    });
  });

  it("retries a transient read failure", async () => {
    const poll = vi
      .spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(found(1));
    const r = await client().lookupTransaction(HASH);
    expect(r.ok).toBe(true);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("returns ok:false instead of throwing when the RPC stays unreachable", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    const r = await client().lookupTransaction(HASH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/connection refused/i);
  });
});
