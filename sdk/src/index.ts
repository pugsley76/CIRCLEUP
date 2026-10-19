// ─── @circleup/sdk — public API surface ──────────────────────────────────────
//
// This file is the *only* supported entry point for the package. Everything a
// consumer needs is re-exported here; importing from deep paths such as
// "@circleup/sdk/dist/client" is NOT part of the stable contract and may break
// between releases.
//
// The public API, by group:
//
//   Clients        CircleUpClient (top-level facade), FactoryClient,
//                  CircleClient, ReputationClient, IndexerClient
//   Errors         GateError, IndexerError (invalid indexer query options
//                  reject locally with a RangeError before any request)
//   Recovery       isRetryable, CircleUpClient.lookupTransaction,
//                  SubmissionDiagnostics, TxLookup
//   Config & types CircleUpConfig, NetworkConfig, NetworkName, CircleStatus,
//                  CircleConfig, RoundState, CircleFullState, and the indexer
//                  response types (ApiCircleRow, ApiCircleDetailResponse, …)
//   Gating         computeActionEligibility, buildSnapshot, isGateAllowed,
//                  isGateBlocked, StateSnapshot, GateResult, GateOptions
//   Utilities      usdcToStroops, stroopsToUsdc, formatUsdc, formatPot,
//                  daysToLedgers, ledgersToDays, shortAddress, sleep
//   Constants      TESTNET_/MAINNET_ RPC URLs + passphrases, getNetworkConfig,
//                  isValidNetwork, USDC_DECIMALS, STROOPS_PER_USDC, LEDGERS_PER_*
//   Low-level      scAddress, scU32, scI128, scBool, scAddressVec — ScVal
//                  encoders for advanced callers building raw contract args.
//   Diagnostics    summarizeSimulation, SimulationEstimate — log-safe
//                  resource/fee estimates (also attached to every TxResult
//                  and TxLogEvent once a write has been simulated).
//
// Internal modules (test files, and any module not re-exported below) are
// private: they are excluded from the published build and carry no stability
// guarantee. See examples/public-api.ts for a root-only usage sample.
//
// Re-export order is deliberate — constants → types → utils → gating → client —
// so every symbol has a single canonical source (e.g. `NetworkConfig` comes
// from constants, not transitively through another module).
//
// client.ts is re-exported by name rather than with `export *`: it also holds
// helpers exported only for its unit tests (isTransientRpcError, withRpcRetry,
// mayHaveReachedServer), and a wildcard would publish them as stable API.
// scripts/check-public-api.cjs fails the release check if they reappear here.

export * from "./constants"; // network URLs/passphrases, getNetworkConfig, unit + ledger + indexer paging constants
export * from "./types";     // CircleUpConfig, CircleStatus, CircleConfig, RoundState, decoders, indexer read models, …
export * from "./utils";     // usdcToStroops, stroopsToUsdc, formatUsdc, shortAddress, …
export * from "./gating";    // StateSnapshot, GateResult, computeActionEligibility, buildSnapshot, …

export {
  // Clients
  CircleUpClient,
  FactoryClient,
  CircleClient,
  ReputationClient,
  IndexerClient,
  // Errors
  GateError,
  IndexerError,
  // Read-error classifiers
  isConfigAbsent,
  isCircleNotActive,
  // Defaults
  DEFAULT_POLL_CONFIG,
  DEFAULT_FULL_STATE_CACHE_TTL_MS,
  // Low-level ScVal encoders
  scAddress,
  scU32,
  scI128,
  scBool,
  scAddressVec,
} from "./client";

export type {
  PollConfig,
  WriteOptions,
  TxLogPhase,
  TxLogEvent,
  TxLogger,
  CircleFullState,
  PreflightOptions,
  PreflightResult,
  PreflightFresh,
  PreflightStale,
} from "./client";
