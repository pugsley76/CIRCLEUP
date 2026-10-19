/**
 * Tests for the simulation resource / fee estimate (`SimulationEstimate`).
 *
 * Covered scenarios:
 *   - documented fields are copied from a simulation with real resources
 *   - the all-zero placeholder `transactionData` is not reported as a usage
 *   - missing / malformed fields are left undefined, never defaulted
 *   - restore preambles are flagged with their own fee
 *   - simulation failures carry only what the RPC reported
 *   - the estimate threads onto success, post-simulation failures, and the
 *     `simulated` / terminal log events
 *   - failures before simulation carry no estimate
 *   - the estimate never contains signed material
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SorobanDataBuilder, SorobanRpc } from "@stellar/stellar-sdk";
import { CircleUpClient, summarizeSimulation, type TxLogEvent } from "../client";
import { isTxFailure, isTxSuccess } from "../types";
import {
  CIRCLE_ADDR,
  FAST_POLL,
  MEMBER_A,
  MOCK_ACCOUNT,
  SDK_CONFIG,
  simulationError,
  simulationSuccess,
  simulationSuccessWithResources,
} from "./fixtures";

class TestClient extends CircleUpClient {
  call() {
    return this.buildAndSend(MEMBER_A, CIRCLE_ADDR, "join", []);
  }
}

function makeClient() {
  return new TestClient(SDK_CONFIG, FAST_POLL);
}

afterEach(() => vi.restoreAllMocks());

// ─── summarizeSimulation ──────────────────────────────────────────────────────

describe("summarizeSimulation", () => {
  it("copies the documented fields from a simulation with real resources", () => {
    expect(summarizeSimulation(simulationSuccessWithResources(), "100")).toEqual({
      inclusionFee: "100",
      latestLedger: 1_000,
      minResourceFee: "54321",
      cpuInstructions: "1500000",
      readBytes: 2_048,
      writeBytes: 512,
      readOnlyEntries: 1,
      readWriteEntries: 1,
    });
  });

  it("omits resource fields for the all-zero placeholder transactionData", () => {
    const estimate = summarizeSimulation(simulationSuccess());
    expect(estimate).toEqual({ latestLedger: 1_000, minResourceFee: "100" });
    expect(estimate).not.toHaveProperty("cpuInstructions");
    expect(estimate).not.toHaveProperty("readOnlyEntries");
  });

  it("leaves missing fields undefined instead of fabricating them", () => {
    const estimate = summarizeSimulation(
      simulationSuccessWithResources({
        minResourceFee: undefined,
        latestLedger: undefined,
        transactionData: undefined,
      }),
    );
    expect(estimate).toBeUndefined();
  });

  it("drops malformed values", () => {
    const estimate = summarizeSimulation(
      simulationSuccessWithResources({
        minResourceFee: "-5",
        latestLedger: "1000",
        transactionData: { build: () => { throw new Error("bad xdr"); } },
      }),
      "not-a-fee",
    );
    expect(estimate).toBeUndefined();
  });

  it("flags a restore preamble with its own resource fee", () => {
    const estimate = summarizeSimulation(
      simulationSuccessWithResources({
        restorePreamble: {
          minResourceFee: "777",
          transactionData: new SorobanDataBuilder(),
        },
      }),
    );
    expect(estimate?.restoreRequired).toBe(true);
    expect(estimate?.restoreMinResourceFee).toBe("777");
  });

  it("does not flag a restore when there is no preamble", () => {
    expect(summarizeSimulation(simulationSuccessWithResources())).not.toHaveProperty(
      "restoreRequired",
    );
  });

  it("reports only the ledger for a simulation failure", () => {
    expect(summarizeSimulation(simulationError("HostError: Error(Contract, #1)"))).toEqual({
      latestLedger: 1_000,
    });
  });

  it("ignores fee-like fields on a failure response", () => {
    const failure = { ...simulationError("boom"), minResourceFee: "999" };
    expect(summarizeSimulation(failure)).not.toHaveProperty("minResourceFee");
  });

  it("returns undefined for a non-object input", () => {
    expect(summarizeSimulation(undefined)).toBeUndefined();
    expect(summarizeSimulation("sim")).toBeUndefined();
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(summarizeSimulation(simulationSuccessWithResources()))).toBe(true);
  });
});

// ─── Threading through buildAndSend ───────────────────────────────────────────

describe("buildAndSend — simulation estimate", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
  });

  function stubSubmit(getTx: unknown) {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "TX_EST",
    } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(getTx as any);
  }

  it("attaches the estimate to a confirmed result", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccessWithResources(),
    );
    stubSubmit({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, ledger: 9 });

    const result = await makeClient().call();

    expect(isTxSuccess(result)).toBe(true);
    expect(result.estimate?.minResourceFee).toBe("54321");
    expect(result.estimate?.inclusionFee).toBe("100");
    expect(result.estimate?.cpuInstructions).toBe("1500000");
  });

  it("attaches the estimate to a failure after simulation", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccessWithResources(),
    );
    stubSubmit({ status: SorobanRpc.Api.GetTransactionStatus.FAILED });

    const result = await makeClient().call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("tx_failed");
      expect(result.estimate?.minResourceFee).toBe("54321");
    }
  });

  it("carries only reported fields on simulation_failed", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationError("HostError: Error(Contract, #2)", 4_242),
    );

    const result = await makeClient().call();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("simulation_failed");
      expect(result.estimate).toEqual({ inclusionFee: "100", latestLedger: 4_242 });
    }
  });

  it("carries no estimate when the failure precedes simulation", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockRejectedValue(
      new Error("socket hang up"),
    );

    const result = await makeClient().call();

    expect(isTxFailure(result)).toBe(true);
    expect(result).not.toHaveProperty("estimate");
  });

  it("does not change what is submitted", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccessWithResources(),
    );
    stubSubmit({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, ledger: 9 });

    await makeClient().call();

    const sent = vi.mocked(SorobanRpc.Server.prototype.sendTransaction).mock.calls[0][0] as any;
    // Assembled fee = inclusion fee + minResourceFee, exactly as before.
    expect(sent.fee).toBe(String(100 + 54_321));
  });

  it("emits the estimate on the simulated and terminal log events", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccessWithResources(),
    );
    stubSubmit({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, ledger: 9 });
    const events: TxLogEvent[] = [];

    await makeClient().setTxLogger((e) => events.push(e)).call();

    const byPhase = Object.fromEntries(events.map((e) => [e.phase, e]));
    expect(byPhase.simulated.estimate?.minResourceFee).toBe("54321");
    expect(byPhase.submitted.estimate).toBeUndefined();
    expect(byPhase.confirmed.estimate?.minResourceFee).toBe("54321");
  });

  it("never exposes signed material", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccessWithResources(),
    );
    stubSubmit({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, ledger: 9 });

    const result = await makeClient().call();

    const sent = vi.mocked(SorobanRpc.Server.prototype.sendTransaction).mock.calls[0][0] as any;
    const serialised = JSON.stringify(result.estimate);
    expect(serialised).not.toContain(sent.toXDR());
    expect(serialised).not.toContain(MEMBER_A.secret());
    expect(serialised).not.toContain(MEMBER_A.publicKey());
    for (const value of Object.values(result.estimate ?? {})) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});
