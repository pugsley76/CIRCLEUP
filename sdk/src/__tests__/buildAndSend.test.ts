/**
 * Tests for improved error propagation in CircleUpClient.buildAndSend.
 *
 * buildAndSend is protected, so we access it via a thin subclass that
 * exposes it publicly.  No real RPC calls are made — every network method
 * is stubbed via vi.spyOn on the prototype.
 *
 * Covered scenarios:
 *   - malformed invocations rejected before any network I/O
 *   - account not found (404 vs generic network error)
 *   - simulation network error
 *   - simulation contract error (human-readable extraction)
 *   - tx submission network error
 *   - tx rejected (status === "ERROR")
 *   - RPC congestion (status === "TRY_AGAIN_LATER") vs resubmission (DUPLICATE)
 *   - tx confirmed as FAILED
 *   - polling timeout
 *   - consecutive polling errors exceeding threshold → surface RPC error
 *   - an RPC whose ledger stops advancing → stale_rpc rather than a full timeout
 *   - successful tx carries correct hash, ledger, and decoded return value
 *
 * extractSimulationError parsing (private helper) is tested via the
 * simulation_failed path, which goes through it internally.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { CircleUpClient, type PollConfig } from "../client";
import { isTxSuccess, isTxFailure } from "../types";
import {
  CIRCLE_ADDR,
  FAST_POLL,
  MEMBER_A,
  MOCK_ACCOUNT,
  SDK_CONFIG,
  simulationError,
  simulationSuccess,
} from "./fixtures";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONTRACT_ID = CIRCLE_ADDR;
const METHOD = "join";

// ─── Thin subclass exposing the protected method ──────────────────────────────

class TestClient extends CircleUpClient {
  callBuildAndSend(method: string = METHOD) {
    return this.buildAndSend(MEMBER_A, CONTRACT_ID, method, []);
  }
}

function makeClient(poll: PollConfig = FAST_POLL) {
  return new TestClient(SDK_CONFIG, poll);
}

/** Budget short enough that the polling loop runs out of time promptly. */
const IMPATIENT_POLL: PollConfig = { ...FAST_POLL, timeoutMs: 50 };

// ─── Helpers to build mock RPC return values ──────────────────────────────────

function mockSendOk(hash = "TXHASH123") {
  return { status: "PENDING", hash } as any;
}

function mockSendError(hash = "TXHASH123") {
  return {
    status: "ERROR",
    hash,
    errorResult: { toXDR: () => "mockedXDR" } as any,
  } as any;
}

function mockGetTxSuccess(ledger = 42, returnValue?: xdr.ScVal) {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    ledger,
    returnValue,
  } as any;
}

function mockGetTxFailed() {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.FAILED,
  } as any;
}

function mockGetTxNotFound(latestLedger?: number) {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger,
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => vi.restoreAllMocks());

describe("buildAndSend — account loading", () => {
  it("returns errorCode 'account_not_found' when account has a 404-style error", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("404 not found"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("account_not_found");
      expect(result.errorMessage).toContain("not found on the network");
      expect(result.errorMessage).toContain(METHOD);
      expect(result.txHash).toBe("");
    }
  });

  it("returns errorCode 'account_not_found' when message says 'does not exist'", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("Account does not exist"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("account_not_found");
    }
  });

  it("returns errorCode 'network_error' for non-404 account fetch failure", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      // withRpcRetry passes the error through formatRpcError, which rewrites
      // the raw "ECONNREFUSED" into a human-readable "connection refused" message.
      // Assert on the error code (stable) rather than the raw token.
      expect(result.errorMessage).toMatch(/connection refused|network|ECONNREFUSED/i);
    }
  });
});

describe("buildAndSend — simulation", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(
      MOCK_ACCOUNT,
    );
  });

  it("returns errorCode 'network_error' when simulateTransaction throws", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockRejectedValue(
      new Error("timeout"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toContain("timeout");
      expect(result.errorMessage).toContain(METHOD);
    }
  });

  it("returns errorCode 'simulation_failed' when simulation returns an error", async () => {
    const rawError =
      'HostError: Value(UnexpectedType)\n  contract log (debug): "already joined"\nError(Contract, #1)';
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError(rawError),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("simulation_failed");
      // extractSimulationError should surface the human-readable panic message
      expect(result.errorMessage).toContain("already joined");
      expect(result.errorMessage).toContain(METHOD);
    }
  });

  it("falls back to contract error code when no debug log is present", async () => {
    const rawError = "HostError: Value(UnexpectedType)\nError(Contract, #3)";
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError(rawError),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("simulation_failed");
      expect(result.errorMessage).toContain("Contract error code 3");
    }
  });
});

describe("buildAndSend — submission", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
  });

  it("returns errorCode 'network_error' when sendTransaction never reached the RPC", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:8000"),
    );
    vi.spyOn(Math, "random").mockReturnValue(0); // no backoff between resends

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toMatch(/connection refused/i);
      expect(result.txHash).toBe("");
    }
  });

  it("returns 'outcome_unknown' (not 'network_error') when a send may have been delivered", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockRejectedValue(
      new Error("connection reset"),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("connection reset"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("outcome_unknown");
      expect(result.errorMessage).toContain("connection reset");
      expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.diagnostics?.submission).toBe("unknown");
    }
  });

  it("returns errorCode 'tx_rejected' when sendTransaction returns ERROR status", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
      mockSendError("HASH_REJECTED"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("tx_rejected");
      expect(result.txHash).toBe("HASH_REJECTED");
      expect(result.errorMessage).toContain(METHOD);
    }
  });
});

describe("buildAndSend — confirmation polling", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
      mockSendOk("TX_POLLING"),
    );
  });

  it("returns TxSuccess with correct hash and ledger on SUCCESS status", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxSuccess(77),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.txHash).toBe("TX_POLLING");
      expect(result.ledger).toBe(77);
    }
  });

  it("returns errorCode 'tx_failed' when getTransaction returns FAILED", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxFailed(),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("tx_failed");
      expect(result.txHash).toBe("TX_POLLING");
      expect(result.errorMessage).toContain("TX_POLLING");
      expect(result.errorMessage).toContain(METHOD);
    }
  });

  it("returns errorCode 'outcome_unknown' after 5 consecutive polling failures", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("RPC unreachable"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      // The RPC accepted the transaction, so it may still confirm — this must
      // not be reported with a code that invites a blind resubmission.
      expect(result.errorCode).toBe("outcome_unknown");
      expect(result.diagnostics?.submission).toBe("accepted");
      expect(result.errorMessage).toContain("RPC unreachable");
      // tx hash is still present (transaction was submitted)
      expect(result.txHash).toBe("TX_POLLING");
    }
  });
});

describe("buildAndSend — error messages include contract/method context", () => {
  it("includes contractId.method in simulation_failed message", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Error(Contract, #2)"),
    );

    const result = await makeClient().callBuildAndSend("contribute");

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain(CONTRACT_ID);
      expect(result.errorMessage).toContain("contribute");
    }
  });

  it("includes contractId.method in account_not_found message", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("404"),
    );

    const result = await makeClient().callBuildAndSend("payout");

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain("payout");
    }
  });
});

// ─── Argument validation (no network I/O) ─────────────────────────────────────

describe("buildAndSend — malformed invocations", () => {
  /** Every network method throws, proving validation happened before any I/O. */
  function failOnAnyRpcCall() {
    const boom = () => {
      throw new Error("the RPC should not have been contacted");
    };
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockImplementation(boom);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockImplementation(boom);
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockImplementation(boom);
  }

  class ArgTestClient extends CircleUpClient {
    call(contractId: string, method: string, args: any) {
      return this.buildAndSend(MEMBER_A, contractId, method, args);
    }
  }

  const client = () => new ArgTestClient(SDK_CONFIG, FAST_POLL);

  it("rejects a contract address that is not a C-address", async () => {
    failOnAnyRpcCall();
    const result = await client().call(MEMBER_A.publicKey(), "join", []);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("not a Soroban contract address");
      expect(result.txHash).toBe("");
    }
  });

  it("rejects a method name that is not a Soroban symbol", async () => {
    failOnAnyRpcCall();
    const result = await client().call(CONTRACT_ID, "join-circle", []);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("not a valid Soroban symbol");
    }
  });

  it("rejects a method name longer than 32 characters", async () => {
    failOnAnyRpcCall();
    const result = await client().call(CONTRACT_ID, "a".repeat(33), []);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) expect(result.errorCode).toBe("invalid_argument");
  });

  it("rejects arguments that were never encoded to ScVal, naming the index", async () => {
    failOnAnyRpcCall();
    const result = await client().call(CONTRACT_ID, "join", [
      xdr.ScVal.scvU32(1),
      MEMBER_A.publicKey(),
    ]);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("args[1]");
      expect(result.errorMessage).toContain("scAddress");
    }
  });

  it("rejects an args value that is not an array", async () => {
    failOnAnyRpcCall();
    const result = await client().call(CONTRACT_ID, "join", undefined);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("must be an array");
    }
  });
});

// ─── Submission statuses beyond ERROR ─────────────────────────────────────────

describe("buildAndSend — congestion and duplicate submission", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
  });

  it("returns 'try_again_later' without polling when the RPC is congested", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "TRY_AGAIN_LATER",
      hash: "HASH_BUSY",
    } as any);
    const pollSpy = vi.spyOn(SorobanRpc.Server.prototype, "getTransaction");

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("try_again_later");
      // The hash is still handed back so the caller can look it up first.
      expect(result.txHash).toBe("HASH_BUSY");
    }
    // Polling a transaction the network never queued would burn the whole
    // timeout budget and then report a misleading "timeout".
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it("polls to confirmation when the RPC reports DUPLICATE", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "DUPLICATE",
      hash: "HASH_DUP",
    } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxSuccess(12),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.txHash).toBe("HASH_DUP");
      expect(result.ledger).toBe(12);
    }
  });
});

// ─── Stale RPC detection ──────────────────────────────────────────────────────

describe("buildAndSend — stale RPC state", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "HASH_STALE",
      latestLedger: 500,
    } as any);
  });

  it("returns 'stale_rpc' when the reported ledger stops advancing", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxNotFound(500),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("stale_rpc");
      expect(result.errorMessage).toContain("500");
      expect(result.txHash).toBe("HASH_STALE");
    }
  });

  it("keeps polling while the ledger advances, then reports success", async () => {
    let ledger = 500;
    let polls = 0;
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockImplementation(
      async () => {
        polls++;
        ledger++;
        return polls < 5 ? mockGetTxNotFound(ledger) : mockGetTxSuccess(ledger);
      },
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    expect(polls).toBe(5);
  });

  it("falls back to the timeout path when the RPC reports no ledger at all", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxNotFound(undefined),
    );

    const result = await makeClient(IMPATIENT_POLL).callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    // Without a ledger height there is no evidence the endpoint is stuck, so
    // claiming staleness would be a guess.
    if (isTxFailure(result)) expect(result.errorCode).toBe("timeout");
  });
});

// ─── Contract return values ───────────────────────────────────────────────────

describe("buildAndSend — return value decoding", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
      mockSendOk("HASH_RETVAL"),
    );
  });

  it("decodes the contract return value onto the success result", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxSuccess(3, xdr.ScVal.scvU32(7)),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) expect(result.returnValue).toBe(7);
  });

  it("leaves returnValue undefined for a method that returns nothing", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxSuccess(3),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) expect(result.returnValue).toBeUndefined();
  });

  it("still reports success when the return value cannot be decoded", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxSuccess(3, { switch: () => ({ name: "nonsense" }) } as any),
    );

    const result = await makeClient().callBuildAndSend();

    // The transaction is on-chain; an unreadable return value must not turn a
    // confirmed payout into a reported failure.
    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) expect(result.returnValue).toBeUndefined();
  });
});
