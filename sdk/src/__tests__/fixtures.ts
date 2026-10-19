/**
 * Shared test fixtures for the SDK suite.
 *
 * Every address here is a real strkey, derived deterministically from a fixed
 * byte pattern. That matters: the SDK validates contract addresses in
 * `validateCircleUpConfig` and encodes arguments through `new Address(...)`,
 * both of which reject the hand-written placeholders (`"CCIRCLE000…"`) that
 * only look address-shaped. Generating them keeps the fixtures honest without
 * pasting 56-character constants into ten files.
 *
 * None of these accounts or contracts exist on any network — the suite never
 * makes a real RPC call.
 */

import {
  Account,
  Contract,
  Keypair,
  SorobanDataBuilder,
  SorobanRpc,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  CircleUpConfig,
  RawCircleConfig,
  RawRoundState,
} from "../types";

/** Deterministic contract address from a single repeated byte. */
function contractAddress(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

/** Deterministic keypair from a single repeated byte. */
export function testKeypair(seed: number): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed));
}

// ─── Contracts ────────────────────────────────────────────────────────────────

export const FACTORY_ADDR = contractAddress(1);
export const REPUTATION_ADDR = contractAddress(2);
export const USDC_ADDR = contractAddress(3);
export const CIRCLE_ADDR = contractAddress(4);
export const OTHER_CIRCLE_ADDR = contractAddress(5);

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const CREATOR = testKeypair(10);
export const MEMBER_A = testKeypair(11);
export const MEMBER_B = testKeypair(12);

export const CREATOR_ADDR = CREATOR.publicKey();
export const MEMBER_A_ADDR = MEMBER_A.publicKey();
export const MEMBER_B_ADDR = MEMBER_B.publicKey();

/** An account object that `TransactionBuilder` accepts as a transaction source. */
export const MOCK_ACCOUNT = new Account(CREATOR_ADDR, "100");

// ─── Config ───────────────────────────────────────────────────────────────────

export const SDK_CONFIG: CircleUpConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    circleFactory: FACTORY_ADDR,
    reputation: REPUTATION_ADDR,
    usdc: USDC_ADDR,
  },
};

// ─── RPC responses ────────────────────────────────────────────────────────────
//
// These are shaped as *parsed* RPC responses (`_parsed: true`), which is what
// `Server.simulateTransaction` resolves to. Building them this way lets the
// tests run the real `assembleTransaction` and `Transaction.sign` code instead
// of stubbing those out, so the assemble-and-sign step is actually covered.

/** A simulation that succeeded and returned `retval`. */
export function simulationSuccess(
  retval: xdr.ScVal = xdr.ScVal.scvVoid(),
  latestLedger = 1_000,
): SorobanRpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: "sim",
    latestLedger,
    events: [],
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder(),
    result: { auth: [], retval },
    cost: { cpuInsns: "0", memBytes: "0" },
  } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;
}

/**
 * A successful simulation whose `transactionData` carries real resource
 * figures: 1.5M instructions, 2 KiB read, 512 B written, the circle's
 * instance entry read-only and one entry read-write.
 */
export function simulationSuccessWithResources(
  overrides: Record<string, unknown> = {},
): SorobanRpc.Api.SimulateTransactionSuccessResponse {
  const instanceKey = new Contract(CIRCLE_ADDR).getFootprint();
  const transactionData = new SorobanDataBuilder()
    .setResources(1_500_000, 2_048, 512)
    .setResourceFee("54321")
    .setFootprint([instanceKey], [instanceKey]);
  return {
    ...simulationSuccess(),
    minResourceFee: "54321",
    transactionData,
    ...overrides,
  } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;
}

/** A simulation the host rejected, carrying the raw diagnostic string. */
export function simulationError(
  error: string,
  latestLedger = 1_000,
): SorobanRpc.Api.SimulateTransactionErrorResponse {
  return {
    _parsed: true,
    id: "sim",
    latestLedger,
    events: [],
    error,
  } as unknown as SorobanRpc.Api.SimulateTransactionErrorResponse;
}

// ─── Wire values ──────────────────────────────────────────────────────────────
//
// The shapes `scValToNative` produces for the contract's `get_config` and
// `get_current_round` views: snake_case keys, bigint for i128/u64, number for
// u32.

export const WIRE_CONFIG: RawCircleConfig = {
  members: [MEMBER_A_ADDR, MEMBER_B_ADDR],
  round_amount: 100_000_000n,
  usdc_token: USDC_ADDR,
  reputation_contract: REPUTATION_ADDR,
  round_deadline_ledgers: 120_960,
};

export const WIRE_ROUND: RawRoundState = {
  round_index: 2,
  recipient: MEMBER_A_ADDR,
  contributions_received: 3,
  deadline_ledger: 5_000_000n,
  paid_out: false,
};

/**
 * Poll schedule for tests that drive the confirmation loop with real timers.
 *
 * The intervals are tiny so a test finishes quickly, but `timeoutMs` is
 * deliberately generous: a timer resolution of ~15 ms means a handful of polls
 * can take far longer than their nominal intervals, and a tight budget would
 * make tests that exercise the error-streak or stale-ledger branches
 * intermittently return `"timeout"` instead. Tests that want the timeout
 * branch shorten `timeoutMs` themselves.
 */
export const FAST_POLL = {
  initialIntervalMs: 1,
  maxIntervalMs: 4,
  backoffFactor: 1.5,
  timeoutMs: 5_000,
  maxConsecutiveErrors: 5,
};
