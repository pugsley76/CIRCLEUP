/**
 * Integration tests for the contract-interaction pipeline.
 *
 * Unlike the other suites, nothing inside the SDK is mocked here: these tests
 * drive the public client API against a scripted RPC and let the real code run
 * end to end — argument encoding, transaction building, simulation,
 * assembly, signing, confirmation polling, and typed-read mapping.
 *
 * The scripted chain answers `simulateTransaction` by decoding the invocation
 * out of the transaction it is handed, so a call that encodes the wrong
 * method name or argument list fails the test rather than quietly passing.
 *
 * Flows covered, from deploy through payout and default:
 *   - create_circle → join → contribute → payout, with the resulting circle
 *     address taken from the transaction's own return value
 *   - typed reads (get_config / get_status / get_current_round / collateral /
 *     defaults / reputation score)
 *   - failure conditions: contract panic, on-chain failure, stale RPC,
 *     malformed arguments, and a contract whose return shape has drifted
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Address,
  SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { CircleClient, FactoryClient, ReputationClient, isCircleNotActive } from "../client";
import { isTxFailure, isTxSuccess } from "../types";
import {
  CIRCLE_ADDR,
  CREATOR,
  FAST_POLL,
  MEMBER_A,
  MEMBER_A_ADDR,
  MEMBER_B,
  MEMBER_B_ADDR,
  MOCK_ACCOUNT,
  REPUTATION_ADDR,
  SDK_CONFIG,
  USDC_ADDR,
  simulationError,
  simulationSuccess,
} from "./fixtures";

// ─── Scripted chain ───────────────────────────────────────────────────────────

/**
 * Answers one contract method. Return an `ScVal` for a successful call, or an
 * `Error` for a contract panic — the chain wraps the message in the diagnostic
 * envelope a real Soroban host produces.
 */
type Handler = (args: xdr.ScVal[]) => xdr.ScVal | Error;

interface Invocation {
  contract: string;
  method: string;
  args: unknown[];
}

interface ChainOptions {
  /** Confirm submitted transactions as FAILED instead of SUCCESS. */
  failOnChain?: boolean;
  /**
   * Model an RPC that has stopped ingesting ledgers: every confirmation poll
   * answers NOT_FOUND and reports this same ledger height forever.
   */
  staleAtLedger?: number;
}

/**
 * Stub every `SorobanRpc.Server` method the SDK uses, backed by `script`.
 *
 * @returns The list of invocations the SDK actually sent, decoded back to
 *   native values so tests can assert on what was encoded.
 */
function installChain(
  script: Record<string, Handler>,
  options: ChainOptions = {},
): Invocation[] {
  const { failOnChain = false, staleAtLedger } = options;
  const ledger = staleAtLedger ?? 1_000;
  const invocations: Invocation[] = [];
  const pending = new Map<string, xdr.ScVal>();
  let hashCounter = 0;

  /** Decode the single invokeHostFunction operation carried by `tx`. */
  function readInvocation(tx: any): {
    contract: string;
    method: string;
    args: xdr.ScVal[];
  } {
    const invoke = tx.operations[0].func.invokeContract();
    return {
      contract: Address.fromScAddress(invoke.contractAddress()).toString(),
      method: invoke.functionName().toString(),
      args: invoke.args(),
    };
  }

  vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);

  vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockImplementation(
    async (tx: any) => {
      const { contract, method, args } = readInvocation(tx);
      invocations.push({ contract, method, args: args.map(scValToNative) });

      const handler = script[method];
      if (!handler) {
        throw new Error(`the chain script has no handler for "${method}"`);
      }

      const outcome = handler(args);
      if (outcome instanceof Error) {
        return simulationError(
          `HostError: Error(Contract, #1)\n  contract log (debug): "${outcome.message}"`,
          ledger,
        );
      }
      return simulationSuccess(outcome, ledger);
    },
  );

  vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockImplementation(
    async (tx: any) => {
      const { method, args } = readInvocation(tx);
      const outcome = script[method]!(args);
      const hash = `HASH_${method}_${hashCounter++}`;
      if (!(outcome instanceof Error)) pending.set(hash, outcome);
      return { status: "PENDING", hash, latestLedger: ledger } as any;
    },
  );

  vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockImplementation(
    async (hash: string) => {
      if (staleAtLedger !== undefined) {
        return {
          status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
          latestLedger: staleAtLedger,
        } as any;
      }
      if (failOnChain) {
        return {
          status: SorobanRpc.Api.GetTransactionStatus.FAILED,
          latestLedger: ledger,
        } as any;
      }
      return {
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        ledger,
        returnValue: pending.get(hash),
        latestLedger: ledger,
      } as any;
    },
  );

  return invocations;
}

// ─── Contract return values ───────────────────────────────────────────────────

const scCircleAddress = () => new Address(CIRCLE_ADDR).toScVal();
const scVoid = () => xdr.ScVal.scvVoid();

function scConfig(members: string[] = [MEMBER_A_ADDR, MEMBER_B_ADDR]): xdr.ScVal {
  return nativeToScVal(
    {
      members: members.map((m) => new Address(m)),
      round_amount: 100_000_000n,
      usdc_token: new Address(USDC_ADDR),
      reputation_contract: new Address(REPUTATION_ADDR),
      round_deadline_ledgers: 120_960,
    },
    {
      type: {
        round_amount: ["symbol", "i128"],
        round_deadline_ledgers: ["symbol", "u32"],
      },
    },
  );
}

function scRound(roundIndex = 0, paidOut = false): xdr.ScVal {
  return nativeToScVal(
    {
      round_index: roundIndex,
      recipient: new Address(MEMBER_A_ADDR),
      contributions_received: 2,
      deadline_ledger: 5_000_000n,
      paid_out: paidOut,
    },
    {
      type: {
        round_index: ["symbol", "u32"],
        contributions_received: ["symbol", "u32"],
        deadline_ledger: ["symbol", "u64"],
      },
    },
  );
}

/** The script a healthy circle answers with. */
function healthyCircle(): Record<string, Handler> {
  return {
    create_circle: () => scCircleAddress(),
    join: () => scVoid(),
    contribute: () => scVoid(),
    payout: () => scVoid(),
    mark_default: () => scVoid(),
    get_config: () => scConfig(),
    get_status: () => nativeToScVal("Active", { type: "symbol" }),
    get_current_round: () => scRound(),
    get_collateral: () => nativeToScVal(50_000_000n, { type: "i128" }),
    get_defaults: () => nativeToScVal(1, { type: "u32" }),
    has_contributed: () => nativeToScVal(true),
    score: () => nativeToScVal(78, { type: "u32" }),
  };
}

const factory = () => new FactoryClient(SDK_CONFIG, FAST_POLL);
const circle = () => new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0, FAST_POLL);

afterEach(() => vi.restoreAllMocks());

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("pipeline — deploy through payout", () => {
  it("creates a circle and resolves its address from the transaction return value", async () => {
    const sent = installChain(healthyCircle());

    const { result, circleAddress } = await factory().createCircle({
      creator: CREATOR,
      members: [MEMBER_A_ADDR, MEMBER_B_ADDR],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: 120_960,
    });

    expect(isTxSuccess(result)).toBe(true);
    expect(circleAddress).toBe(CIRCLE_ADDR);

    // The address comes from this transaction, not from a registry lookup that
    // could name another caller's circle.
    expect(sent.map((i) => i.method)).toEqual(["create_circle"]);
    expect(sent[0].args).toEqual([
      CREATOR.publicKey(),
      [MEMBER_A_ADDR, MEMBER_B_ADDR],
      100_000_000n,
      120_960,
    ]);
  });

  it("runs join → contribute → payout against the circle contract", async () => {
    const sent = installChain(healthyCircle());
    const client = circle();

    expect(isTxSuccess(await client.join(MEMBER_A))).toBe(true);
    expect(isTxSuccess(await client.contribute(MEMBER_A))).toBe(true);
    expect(isTxSuccess(await client.payout(CREATOR))).toBe(true);

    expect(sent.map((i) => i.method)).toEqual(["join", "contribute", "payout"]);
    expect(sent.every((i) => i.contract === CIRCLE_ADDR)).toBe(true);
    expect(sent[0].args).toEqual([MEMBER_A_ADDR]);
    expect(sent[2].args).toEqual([]);
  });

  it("records a default against the named member", async () => {
    const sent = installChain(healthyCircle());

    const result = await circle().markDefault(CREATOR, MEMBER_B_ADDR);

    expect(isTxSuccess(result)).toBe(true);
    expect(sent[0]).toMatchObject({ method: "mark_default", args: [MEMBER_B_ADDR] });
  });

  it("maps every typed read from its wire shape", async () => {
    installChain(healthyCircle());
    const client = circle();

    const state = await client.getFullState();
    expect(state.config.members).toEqual([MEMBER_A_ADDR, MEMBER_B_ADDR]);
    expect(state.config.roundAmount).toBe(100_000_000n);
    expect(state.config.roundDeadlineLedgers).toBe(120_960);
    expect(state.status).toBe("Active");
    expect(state.currentRound.roundIndex).toBe(0);
    expect(state.currentRound.deadlineLedger).toBe(5_000_000n);
    expect(state.currentRound.paidOut).toBe(false);

    expect(await client.getCollateral(MEMBER_A_ADDR)).toBe(50_000_000n);
    expect(await client.getDefaults(MEMBER_A_ADDR)).toBe(1);
    expect(await client.hasContributed(MEMBER_A_ADDR, 0)).toBe(true);
    expect(await new ReputationClient(SDK_CONFIG).getScore(MEMBER_A_ADDR)).toBe(78);
  });

  it("reads without asking the RPC to resolve a source account", async () => {
    installChain(healthyCircle());

    await circle().getStatus();

    // A read is never signed or submitted, so looking up an account would be a
    // wasted round-trip that always 404s for a throwaway key.
    expect(SorobanRpc.Server.prototype.getAccount).not.toHaveBeenCalled();
  });
});

// ─── Failure conditions ───────────────────────────────────────────────────────

describe("pipeline — contract rejects the call", () => {
  it("surfaces the panic message and never submits the transaction", async () => {
    const script = healthyCircle();
    script.contribute = () => new Error("already contributed this round");
    installChain(script);

    const result = await circle().contribute(MEMBER_A);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("simulation_failed");
      expect(result.errorMessage).toContain("already contributed this round");
      expect(result.txHash).toBe("");
    }
    expect(SorobanRpc.Server.prototype.sendTransaction).not.toHaveBeenCalled();
  });

  it("gives a read the same message text as the equivalent write", async () => {
    const script = healthyCircle();
    script.get_current_round = () => new Error("circle is not active");
    installChain(script);
    const client = circle();

    const thrown = await client.getCurrentRound().catch((err: Error) => err.message);
    const returned = await client.getCurrentRoundResult();

    // Both the throwing helper (getCurrentRound) and the non-throwing helper
    // (getCurrentRoundResult) normalise CircleNotActive errors to the same
    // canonical "No active round" message, so the user experience is
    // consistent regardless of which one the caller picked.
    expect(isCircleNotActive(thrown as string)).toBe(true);
    expect(returned.ok).toBe(false);
    if (!returned.ok) {
      expect(isCircleNotActive(returned.error)).toBe(true);
      // Both paths produce the same normalised message.
      expect(thrown).toBe(returned.error);
    }
  });
});

describe("pipeline — transaction fails on-chain", () => {
  it("classifies a FAILED confirmation as tx_failed, not a timeout", async () => {
    installChain(healthyCircle(), { failOnChain: true });

    const result = await circle().payout(CREATOR);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("tx_failed");
      expect(result.txHash).toContain("HASH_payout");
    }
  });
});

describe("pipeline — RPC stops advancing", () => {
  it("classifies a frozen ledger as stale_rpc rather than polling to timeout", async () => {
    installChain(healthyCircle(), { staleAtLedger: 4_242 });

    const result = await circle().join(MEMBER_B);

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("stale_rpc");
      expect(result.errorMessage).toContain("4242");
      // The hash is preserved so the caller can check it elsewhere before
      // resubmitting and paying twice.
      expect(result.txHash).toContain("HASH_join");
    }
  });
});

describe("pipeline — malformed arguments", () => {
  it("rejects a bad member address on mark_default before any network call", async () => {
    installChain(healthyCircle());

    const result = await circle().markDefault(CREATOR, "not-an-address");

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("invalid_argument");
      expect(result.errorMessage).toContain("mark_default");
    }
    expect(SorobanRpc.Server.prototype.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects an empty member list on create_circle as a typed failure", async () => {
    installChain(healthyCircle());

    const { result, circleAddress } = await factory().createCircle({
      creator: CREATOR,
      members: [],
      roundAmountStroops: 100_000_000n,
      roundDeadlineLedgers: 120_960,
    });

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) expect(result.errorCode).toBe("invalid_argument");
    expect(circleAddress).toBeUndefined();
    expect(SorobanRpc.Server.prototype.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects a round amount that would lose precision", async () => {
    installChain(healthyCircle());

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
});

describe("pipeline — contract return shape drifts", () => {
  it("names the offending field instead of leaking undefined into domain code", async () => {
    const script = healthyCircle();
    // A contract that started returning the round index as an i128.
    script.get_current_round = () =>
      nativeToScVal(
        {
          round_index: 3n,
          recipient: new Address(MEMBER_A_ADDR),
          contributions_received: 2,
          deadline_ledger: 5_000_000n,
          paid_out: false,
        },
        {
          type: {
            round_index: ["symbol", "i128"],
            contributions_received: ["symbol", "u32"],
            deadline_ledger: ["symbol", "u64"],
          },
        },
      );
    installChain(script);

    const result = await circle().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("mapRawRoundState.round_index");
      expect(result.error).toContain("expected a u32");
    }
  });

  it("rejects a reputation score that is not a u32", async () => {
    const script = healthyCircle();
    script.score = () => nativeToScVal("excellent", { type: "string" });
    installChain(script);

    await expect(
      new ReputationClient(SDK_CONFIG).getScore(MEMBER_A_ADDR),
    ).rejects.toThrow(/getScore: expected a u32/);
  });
});
