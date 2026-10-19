"use client";
/**
 * Thin browser-side Stellar / Soroban helpers.
 * Uses @stellar/freighter-api v2 (isConnected → boolean, getPublicKey → string,
 * signTransaction → string XDR, requestAccess → string).
 *
 * Transaction lifecycle — separated into three distinct phases so callers can
 * preview a simulation result before committing to a signature + submission:
 *
 *  1. simulateContractTx  — builds the unsigned transaction, runs simulation,
 *                           assembles fee/resource footprint, returns the
 *                           prepared XDR ready for signing.  No wallet prompt.
 *
 *  2. submitContractTx    — signs the prepared XDR with Freighter, broadcasts
 *                           it, and polls for confirmation.  Returns the tx hash
 *                           and success/failure status.
 *
 *  3. invokeContract      — convenience wrapper that calls (1) then (2) in one
 *                           go, preserving the existing call-sites unchanged.
 */
import {
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Contract,
  Address,
  scValToNative,
  xdr,
  type Account,
} from "@stellar/stellar-sdk";
import {
  isConnected,
  getPublicKey,
  signTransaction,
  requestAccess,
} from "@stellar/freighter-api";
import { STELLAR_RPC_URL, NETWORK_PASSPHRASE, REPUTATION_ADDRESS } from "./config";
import { startTx, emit, categorizeError } from "./telemetry";
import {
  assertStellarPublicKey,
  assertSorobanContractId,
  assertCanonicalStellarAddress,
} from "./address";
import {
  parseContractError,
  userMessageForError,
  type ContractAppError,
} from "./contractErrors";
import {
  detectWalletCapabilities,
  explainUnsupportedAction,
  type WalletCapabilities,
} from "./walletCapabilities";

// ─── Freighter detection & error types ───────────────────────────────────────

/** Typed reasons a wallet connection can fail. */
export type WalletErrorReason =
  | "not_installed"
  | "permission_denied"
  | "unknown"
  | "unsupported_capability";

export class WalletError extends Error {
  constructor(
    public readonly reason: WalletErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * Returns true when the Freighter extension is present in the browser.
 * Works by inspecting the injected global that Freighter sets; falls back to
 * a best-effort isConnected() call so it works in all Freighter v2 builds.
 */
export function isFreighterInstalled(): boolean {
  if (typeof window === "undefined") return false;
  // Freighter v2 injects window.freighter; earlier builds inject window.freighterApi
  return (
    typeof (window as any).freighter !== "undefined" ||
    typeof (window as any).freighterApi !== "undefined"
  );
}

/**
 * Returns the connected wallet public key, or null if not connected.
 *
 * Throws a {@link WalletError} with an appropriate reason so callers can show
 * actionable messages rather than silently failing:
 *  - `not_installed`  → extension is not present
 *  - `permission_denied` → user dismissed the access prompt
 */
export async function getWalletAddress(): Promise<string | null> {
  if (!isFreighterInstalled()) {
    throw new WalletError(
      "not_installed",
      "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
    );
  }
  try {
    const connected = await isConnected();
    if (!connected) return null;
    const pk = await getPublicKey();
    return pk || null;
  } catch {
    return null;
  }
}

/**
 * Prompts the user to connect their Freighter wallet.
 *
 * Throws a {@link WalletError} so callers receive a typed, user-friendly reason
 * instead of a raw exception or a silent null.
 */
export async function connectWallet(): Promise<string> {
  if (!isFreighterInstalled()) {
    throw new WalletError(
      "not_installed",
      "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
    );
  }

  try {
    // requestAccess returns the public key string directly in v2
    const pk = await requestAccess();
    if (!pk) {
      throw new WalletError(
        "permission_denied",
        "Wallet access was denied. Please approve the connection in Freighter and try again.",
      );
    }
    return pk;
  } catch (err: any) {
    // Re-throw our own errors as-is
    if (err instanceof WalletError) throw err;

    // Freighter surfaces user rejection as a message containing "denied" or similar
    const msg: string = err?.message?.toLowerCase() ?? "";
    if (
      msg.includes("denied") ||
      msg.includes("rejected") ||
      msg.includes("cancelled") ||
      msg.includes("canceled")
    ) {
      throw new WalletError(
        "permission_denied",
        "Wallet access was denied. Please approve the connection in Freighter and try again.",
      );
    }

    throw new WalletError("unknown", err?.message || "Failed to connect wallet.");
  }
}

// ─── RPC client ───────────────────────────────────────────────────────────────

let _rpc: SorobanRpc.Server | null = null;
function getRpc() {
  if (!_rpc) {
    _rpc = new SorobanRpc.Server(STELLAR_RPC_URL, { allowHttp: true });
  }
  return _rpc;
}

// ─── Transient RPC retry ──────────────────────────────────────────────────────

/**
 * Maximum retry attempts for a single RPC call before the error is surfaced
 * to the caller as a typed failure.
 *
 * 3 attempts with a 400 ms base delay (doubling each time, full jitter) gives
 * a worst-case budget of ~2.8 s per call — short enough to stay inside a
 * reasonable UX window while surviving most transient blips.
 */
const RPC_RETRY_MAX_ATTEMPTS = 3;
/** Base delay in milliseconds before the first retry. Doubles each attempt. */
const RPC_RETRY_BASE_DELAY_MS = 400;

/**
 * Return true when `err` is a transient network or rate-limit condition that
 * is safe to retry.  Non-transient errors (auth, bad request, etc.) fail
 * immediately so the user gets feedback right away rather than waiting for
 * retries to exhaust.
 */
export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;

  const code =
    typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const status =
    typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Node.js / fetch error codes
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  // HTTP status codes that indicate transient server-side issues
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  // String-matched patterns for environments where the error code is absent
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  );
}

// ─── Cancellation helpers ─────────────────────────────────────────────────────

/**
 * A distinct result kind returned by SDK operations when the caller has
 * aborted the operation via an {@link AbortSignal} *before* any transaction
 * was broadcast to the network.
 *
 * Callers must never treat this as an on-chain failure — the transaction was
 * either never submitted or the outcome is unknown (signal fired during
 * polling).  The distinction allows UI layers to show "stopped waiting" copy
 * rather than "transaction failed" copy.
 */
export interface LocalCancelResult {
  /** Discriminant — always `"local_cancel"`. */
  readonly kind: "local_cancel";
  /**
   * `true`  → signal fired before `sendTransaction` was called; on-chain
   *            state is guaranteed unchanged.
   * `false` → signal fired after `sendTransaction` returned a hash; the tx
   *            may still confirm. Callers should surface a "check explorer"
   *            advisory rather than claiming the tx was cancelled.
   */
  readonly submittedBeforeAbort: boolean;
}

/**
 * Sleep for `ms` milliseconds, aborting early if `signal` fires.
 *
 * Resolves normally when the timeout expires.
 * Rejects with the signal's abort reason when the signal fires before the
 * timeout so the polling loop or retry delay can be interrupted immediately
 * without waiting for the full interval.
 *
 * Cleans up its event listener on every terminal path so no listeners leak.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Already aborted before we even started — reject synchronously so the
    // caller doesn't schedule a timer it will never need to clear.
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const id = setTimeout(resolve, ms);

    if (!signal) return; // no abort signal — plain sleep, nothing more to do

    const onAbort = () => {
      clearTimeout(id);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Once the timer fires we must remove our listener to avoid a stale
    // reference keeping the signal alive longer than needed.
    // We wrap `resolve` so the listener is cleaned up before the promise
    // settles.
    clearTimeout(id); // cancel the one scheduled above and reschedule with cleanup
    const cleanId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    // Replace the abort handler with one that also clears `cleanId`.
    signal.removeEventListener("abort", onAbort);
    const onAbortClean = () => {
      clearTimeout(cleanId);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbortClean, { once: true });
  });
}

/**
 * Run a single Soroban RPC call with capped exponential backoff + full jitter
 * on transient failures.
 *
 * - Transient errors (network blips, rate-limits, gateway errors) are retried
 *   up to `maxAttempts` times with a jittered exponential delay.
 * - Non-transient errors (auth, bad request, simulation errors) propagate
 *   immediately — burning retry budget on them would only delay user feedback.
 * - When `signal` is provided, an abort before or during a retry delay
 *   propagates the abort reason immediately so callers can clean up.
 *
 * Full jitter: the delay for attempt N is a random value in
 * [0, baseDelayMs × 2^(N-1)] so concurrent clients spread their retries
 * rather than thundering-herding the RPC.
 *
 * @param label       Short human-readable name for the call, used in logs.
 * @param fn          The RPC call to execute.
 * @param maxAttempts Total attempts allowed (first try + retries).
 * @param baseDelayMs Base delay in ms for the first retry.
 * @param sleep       Injectable sleep for testing (defaults to sleepWithAbort).
 * @param signal      Optional AbortSignal; when fired the retry loop exits
 *                    immediately by re-throwing the signal's reason.
 */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts: number = RPC_RETRY_MAX_ATTEMPTS,
  baseDelayMs: number = RPC_RETRY_BASE_DELAY_MS,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepWithAbort,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Check for abort at the top of every iteration so we never start a new
    // RPC call after the caller has already given up.
    signal?.throwIfAborted();

    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = isTransientRpcError(err);
      if (!transient || attempt === attempts) {
        break;
      }
      // Full jitter: random value in [0, baseDelayMs * 2^(attempt-1)]
      const ceiling = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = Math.floor(Math.random() * ceiling);
      console.warn(
        `[stellar] Transient RPC failure during ${label} ` +
          `(attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms`,
      );
      // sleepWithAbort will throw the abort reason if the signal fires
      // during the backoff window, propagating cleanly out of the loop.
      await sleep(delayMs, signal);
    }
  }

  throw lastErr;
}

// ─── Contract error helpers ───────────────────────────────────────────────────

/** How many polling iterations to allow before giving up. */
const TX_POLL_ATTEMPTS = 30;
/** Delay between polling attempts in ms. */
const TX_POLL_INTERVAL_MS = 2000;
/** Total wait budget shown to users: attempts × interval. */
const TX_TIMEOUT_SECONDS = Math.round(
  (TX_POLL_ATTEMPTS * TX_POLL_INTERVAL_MS) / 1000,
);

/**
 * Converts a raw Soroban/network error into a human-readable message.
 * @deprecated Prefer {@link userMessageForError} with a typed {@link ContractAppError}.
 */
export function formatContractError(raw: string | undefined): string {
  if (!raw) return "Transaction failed for an unknown reason.";

  const lower = raw.toLowerCase();

  if (lower === "transaction failed") {
    return (
      "The transaction was rejected on-chain. This may be due to a contract rule violation, " +
      "insufficient balance, or an expired transaction. " +
      "Check Stellar Expert for the full error detail."
    );
  }

  if (lower === "timeout") {
    return (
      `The transaction was submitted but confirmation timed out after ${TX_TIMEOUT_SECONDS}s. ` +
      "The network may be congested. Please check Stellar Expert for your transaction status " +
      "before retrying to avoid duplicate submissions."
    );
  }

  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound")
  ) {
    return (
      "A network error occurred while communicating with the Stellar RPC. " +
      "Check your internet connection and try again. " +
      "If the problem persists, the RPC endpoint may be temporarily unavailable."
    );
  }

  if (lower.includes("insufficient") && lower.includes("fee")) {
    return "The transaction fee was too low. Please try again — the fee will be recalculated automatically.";
  }

  if (lower.includes("user rejected") || lower.includes("denied")) {
    return "You cancelled the transaction in Freighter. No funds were moved.";
  }

  // Return the raw error, capitalised, for developer visibility
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Extracts the stable XDR result-code name (e.g. `"txFailed"`, `"txBadSeq"`,
 * `"txInsufficientFee"`) from a `xdr.TransactionResult` so
 * {@link parseContractError} can map it to a specific user-facing message
 * instead of a generic "unexpected error" (Issue #479).
 *
 * Returns `undefined` when the result is absent or cannot be inspected so
 * callers can fall back to a marker string.
 */
function extractTxResultCode(
  errorResult: xdr.TransactionResult | null | undefined,
): string | undefined {
  if (!errorResult) return undefined;
  try {
    const name = (errorResult as any)?.result?.()?.switch?.()?.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the typed error for a transaction that reached the network and was
 * rejected, preferring the extracted XDR result code.  Unrecognised result
 * codes still receive the clear on-chain rejection copy rather than the
 * generic UNKNOWN fallback (Issue #479).
 */
function onChainFailureError(code: string | undefined): ContractAppError {
  const parsed = parseContractError(code ?? "transaction failed");
  return parsed.code === "UNKNOWN"
    ? parseContractError("transaction failed")
    : parsed;
}

// ─── Typed result types ────────────────────────────────────────────────────────

/**
 * Result returned by {@link simulateContractTx} on success.
 *
 * The `preparedXdr` is the unsigned, fee-and-footprint-assembled transaction
 * XDR.  Pass it directly to {@link submitContractTx} to sign and broadcast,
 * or inspect `simResult` to preview resource usage / return value before
 * deciding whether to proceed.
 */
export interface SimulateResult {
  success: true;
  /** Assembled, unsigned transaction XDR ready for wallet signing. */
  preparedXdr: string;
  /** Raw simulation result — inspect for return values or resource estimates. */
  simResult: SorobanRpc.Api.SimulateTransactionSuccessResponse;
}

/**
 * Result returned by {@link simulateContractTx} on failure.
 */
export interface SimulateError {
  success: false;
  error: string;
  typedError?: ContractAppError;
}

export type SimulateContractTxResult = SimulateResult | SimulateError;

/**
 * Result of a contract invocation or submission.
 * The `typedError` field carries a {@link ContractAppError} on every failure
 * path so callers can branch on stable codes rather than message strings.
 */
export interface InvokeResult {
  txHash: string;
  success: boolean;
  /** User-facing formatted message (prefer `typedError.message` when set). */
  error?: string;
  /** Typed, categorised error for deterministic branching. Only set on failure. */
  typedError?: ContractAppError;
}

// ─── Phase 1: Simulation ──────────────────────────────────────────────────────

/**
 * Phase 1 of the transaction lifecycle: build and simulate a Soroban contract
 * invocation, then assemble the fee and resource footprint from the simulation
 * result.
 *
 * No wallet interaction occurs — the returned `preparedXdr` is an unsigned
 * transaction.  Call {@link submitContractTx} with it (and the telemetry
 * context from this call) to sign and broadcast, or discard it if you only
 * need a dry-run / fee estimate.
 *
 * Address validation:
 *  - `contractId` must be a valid Soroban contract ID (C-prefix, 56 chars).
 *  - `walletAddress` must be a valid Stellar public key (G-prefix, 56 chars).
 *
 * @param contractId    The Soroban contract to invoke.
 * @param method        The contract method name.
 * @param args          Encoded ScVal arguments.
 * @param walletAddress The signing account — used to fetch the sequence number.
 * @param txCtx         Telemetry context handle from {@link startTx}.
 * @param signal        Optional {@link AbortSignal}. When fired before the
 *                      simulation completes the function rejects immediately
 *                      with the signal's reason, cleans up any in-flight
 *                      work, and does **not** emit a `failed` telemetry event
 *                      — stopping local observation is not a transaction
 *                      failure.  Callers without a signal are unaffected.
 */
export async function simulateContractTx(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  walletAddress: string,
  txCtx: ReturnType<typeof startTx>,
  signal?: AbortSignal,
): Promise<SimulateContractTxResult> {
  // ── Abort gate ───────────────────────────────────────────────────────────
  // Checked eagerly so a signal that was already fired before the call never
  // starts any network I/O.
  signal?.throwIfAborted();

  // ── Address validation ───────────────────────────────────────────────────
  assertSorobanContractId(contractId, "contractId");
  assertStellarPublicKey(walletAddress, "walletAddress");

  const rpc = getRpc();

  // ── Account fetch ────────────────────────────────────────────────────────
  // Wrapped with withRpcRetry so a single transient network blip doesn't
  // fail the whole simulation — 3 attempts with jittered exponential backoff.
  // The signal is forwarded so an abort during a retry delay exits promptly.
  let account: Awaited<ReturnType<typeof rpc.getAccount>>;
  try {
    account = await withRpcRetry(
      "getAccount",
      () => rpc.getAccount(walletAddress),
      RPC_RETRY_MAX_ATTEMPTS,
      RPC_RETRY_BASE_DELAY_MS,
      sleepWithAbort,
      signal,
    );
  } catch (err: any) {
    // Re-throw abort reasons directly — they are not transaction failures.
    if (signal?.aborted) throw err;
    const msg: string = err?.message ?? "";
    const isNetwork =
      msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch");
    emit(txCtx, "failed", categorizeError(isNetwork ? "network" : msg));
    const typedError = parseContractError(isNetwork ? "network error" : msg);
    return {
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  // ── Abort gate (post-build) ──────────────────────────────────────────────
  // Check again after the synchronous TransactionBuilder work so a signal
  // that fired while the account fetch was in flight exits before we start
  // the simulation RPC call.
  signal?.throwIfAborted();

  // ── Simulation ───────────────────────────────────────────────────────────
  // RPC client failures during simulation surface as thrown exceptions —
  // normalise them into the same typed failure result so callers always
  // receive structured error feedback instead of an unhandled rejection
  // (Issue #479).  withRpcRetry absorbs transient blips (network, rate-limit)
  // before escalating to the typed failure path.
  // The signal is forwarded so an abort during a retry delay exits promptly.
  let simResult: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    simResult = await withRpcRetry(
      "simulateTransaction",
      () => rpc.simulateTransaction(tx),
      RPC_RETRY_MAX_ATTEMPTS,
      RPC_RETRY_BASE_DELAY_MS,
      sleepWithAbort,
      signal,
    );
  } catch (err: unknown) {
    // Re-throw abort reasons directly — they are not simulation failures.
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    emit(txCtx, "failed", categorizeError(msg));
    const typedError = parseContractError(msg);
    return {
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    // Never forward the raw simResult.error string (may contain contract
    // panic messages that echo argument values).
    emit(txCtx, "simulate_failed", categorizeError(simResult.error));
    const typedError = parseContractError(simResult.error);
    return {
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  // ── Telemetry: simulated ─────────────────────────────────────────────────
  emit(txCtx, "simulated");

  // ── Assembly ─────────────────────────────────────────────────────────────
  // Malformed simulation payloads or resource-limit rejections throw here;
  // convert them to a typed failure so the user sees a clear message rather
  // than a raw exception (Issue #479).
  let preparedXdr: string;
  try {
    preparedXdr = SorobanRpc.assembleTransaction(tx, simResult).build().toXDR();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(txCtx, "failed", categorizeError(msg));
    const typedError = parseContractError(msg);
    return {
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  return {
    success: true,
    preparedXdr,
    simResult: simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse,
  };
}

// ─── Phase 2: Submission ──────────────────────────────────────────────────────

/**
 * Pre-check wallet capabilities before attempting a transaction.
 * Returns a typed error if the wallet cannot perform the required action,
 * or null if the wallet is ready.
 */
export function checkWalletCapabilities(): ContractAppError | null {
  const caps = detectWalletCapabilities();
  const unsupported = explainUnsupportedAction("sign", caps);
  if (unsupported) {
    return parseContractError(unsupported);
  }
  return null;
}

/**
 * Phase 2 of the transaction lifecycle: sign a prepared transaction XDR with
 * Freighter, broadcast it to the Soroban RPC, and poll for confirmation.
 *
 * Expects the `preparedXdr` produced by {@link simulateContractTx} and the
 * same `txCtx` telemetry handle so the full lifecycle (started → simulated →
 * submitted → confirmed) is recorded as a single logical operation.
 *
 * Pre-checks:
 *  - Verifies the wallet provider can sign transactions before prompting.
 *  - Handles wallet rejection with typed error responses.
 *
 * Cancellation semantics:
 *  - If `signal` fires **before** `sendTransaction` is called, the function
 *    throws the signal's reason immediately.  The transaction has never
 *    reached the network — on-chain state is guaranteed unchanged.
 *  - If `signal` fires **after** `sendTransaction` returns a hash (i.e.
 *    during the confirmation polling loop), the function throws with a
 *    {@link LocalCancelResult} attached as the error's `cause`.  The
 *    transaction *may* still confirm — callers should show a "check
 *    explorer" advisory rather than claiming it was cancelled.
 *  - Callers that do not pass a `signal` are unaffected — existing behavior
 *    is fully preserved.
 *
 * @param preparedXdr Unsigned, assembled transaction XDR from {@link simulateContractTx}.
 * @param txCtx       Telemetry context handle from the originating {@link startTx} call.
 * @param signal      Optional {@link AbortSignal} for local cancellation.
 */
export async function submitContractTx(
  preparedXdr: string,
  txCtx: ReturnType<typeof startTx>,
  signal?: AbortSignal,
): Promise<InvokeResult> {
  const rpc = getRpc();

  // ── Abort gate: pre-flight ────────────────────────────────────────────────
  // Checked before touching the wallet so a stale/already-aborted signal
  // never opens a Freighter prompt.
  signal?.throwIfAborted();

  // ── Pre-flight: verify wallet can sign ─────────────────────────────────────
  const capError = checkWalletCapabilities();
  if (capError) {
    emit(txCtx, "failed", categorizeError(capError.message));
    return {
      txHash: "",
      success: false,
      error: userMessageForError(capError),
      typedError: capError,
    };
  }

  // ── Wallet signing ───────────────────────────────────────────────────────
  // Note: Freighter's signTransaction does not accept an AbortSignal, so we
  // cannot interrupt the wallet prompt itself.  We check the signal again
  // immediately after signing returns — if it fired while the user was
  // approving in the extension we still exit before broadcasting.
  let signedXdr: string;
  try {
    signedXdr = await signTransaction(preparedXdr, {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    const lower = msg.toLowerCase();
    if (
      lower.includes("denied") ||
      lower.includes("rejected") ||
      lower.includes("cancelled") ||
      lower.includes("canceled")
    ) {
      emit(txCtx, "wallet_rejected", "wallet_denied");
      const typedError = parseContractError(msg || "User rejected");
      return {
        txHash: "",
        success: false,
        error: userMessageForError(typedError),
        typedError,
      };
    }
    const typedError = parseContractError(msg || "User rejected");
    emit(txCtx, "failed", categorizeError(msg || "User rejected"));
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  if (!signedXdr) {
    const typedError = parseContractError("Freighter did not return a signed transaction.");
    emit(txCtx, "failed", "unknown");
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  // ── Abort gate: post-signing, pre-broadcast ───────────────────────────────
  // The transaction has been signed but NOT yet broadcast.  Aborting here is
  // still "clean" — no on-chain state has changed.
  signal?.throwIfAborted();

  // ── Submission ───────────────────────────────────────────────────────────
  // withRpcRetry covers transient network blips at the submission layer.
  // Note: we only retry on transient errors (connection reset, rate-limit).
  // An "ERROR" status from the RPC means the transaction itself was rejected
  // by the network and must NOT be retried — doing so would submit it again.
  // The signal is forwarded so an abort during a retry backoff exits promptly.
  let sendResult: Awaited<ReturnType<typeof rpc.sendTransaction>>;
  try {
    sendResult = await withRpcRetry(
      "sendTransaction",
      () =>
        rpc.sendTransaction(
          TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as any,
        ),
      RPC_RETRY_MAX_ATTEMPTS,
      RPC_RETRY_BASE_DELAY_MS,
      sleepWithAbort,
      signal,
    );
  } catch (err: any) {
    // Re-throw abort reasons directly.  At this point the tx may or may not
    // have reached the network depending on which retry attempt was in flight,
    // so we attach a LocalCancelResult as the cause so callers can decide how
    // to message this to the user.
    if (signal?.aborted) {
      const cancelInfo: LocalCancelResult = { kind: "local_cancel", submittedBeforeAbort: false };
      const abortErr = new Error("Transaction submission cancelled by caller.", {
        cause: cancelInfo,
      });
      throw abortErr;
    }
    const typedError = parseContractError(err?.message ?? "network error");
    emit(txCtx, "failed", categorizeError(err?.message ?? "network error"));
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  if (sendResult.status === "ERROR") {
    // The hash is available at this point; included in the return value for
    // the user but never forwarded to telemetry.  Prefer the extracted XDR
    // result code (e.g. "txFailed") so the user gets specific feedback for
    // the on-chain rejection (Issue #479); fall back to the serialised
    // result, then to the canonical "transaction failed" marker.
    const code = extractTxResultCode(sendResult.errorResult);
    const rawErr = code ?? JSON.stringify(sendResult.errorResult);
    const typedError = onChainFailureError(rawErr);
    emit(txCtx, "submission_failed", "on_chain_failed");
    return {
      txHash: sendResult.hash,
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  // ── Telemetry: submitted ─────────────────────────────────────────────────
  emit(txCtx, "submitted");

  const hash = sendResult.hash;

  // ── Polling loop ─────────────────────────────────────────────────────────
  //
  // Cancellation semantics inside the loop:
  //   • The interval sleep is replaced with sleepWithAbort so the full 2-second
  //     wait is skipped immediately when the signal fires.
  //   • After the sleep we re-check the signal *before* issuing the next RPC
  //     call.  This ensures we never start a new getTransaction request after
  //     the caller has given up.
  //   • If the signal fires we throw with a LocalCancelResult cause that
  //     carries submittedBeforeAbort=true — the tx has already been broadcast
  //     and may still confirm on-chain.
  let attempts = TX_POLL_ATTEMPTS;
  while (attempts-- > 0) {
    try {
      await sleepWithAbort(TX_POLL_INTERVAL_MS, signal);
    } catch {
      // Signal fired during the sleep — stop polling.  The tx was broadcast
      // (submittedBeforeAbort = true) so warn the caller not to claim cancel.
      const cancelInfo: LocalCancelResult = { kind: "local_cancel", submittedBeforeAbort: true };
      const abortErr = new Error(
        "Transaction confirmation polling cancelled by caller. " +
          "The transaction may still confirm on-chain — check the explorer before retrying.",
        { cause: cancelInfo },
      );
      throw abortErr;
    }

    // Abort gate: checked after sleep so we never start a new RPC call after
    // the caller has already stopped waiting.
    if (signal?.aborted) {
      const cancelInfo: LocalCancelResult = { kind: "local_cancel", submittedBeforeAbort: true };
      throw new Error(
        "Transaction confirmation polling cancelled by caller. " +
          "The transaction may still confirm on-chain — check the explorer before retrying.",
        { cause: cancelInfo },
      );
    }

    let status: Awaited<ReturnType<typeof rpc.getTransaction>>;
    try {
      status = await rpc.getTransaction(hash);
    } catch {
      // Transient polling error — keep trying
      continue;
    }

    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      emit(txCtx, "confirmed");
      return { txHash: hash, success: true };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      // Extract the XDR result code when available so the user sees exactly
      // why the transaction failed on-chain (contract rule violation, low
      // fee, sequence mismatch) instead of a generic error (Issue #479).
      const code = extractTxResultCode(
        (status as { errorResult?: xdr.TransactionResult }).errorResult,
      );
      const typedError = onChainFailureError(code);
      emit(txCtx, "failed", "on_chain_failed");
      return {
        txHash: hash,
        success: false,
        error: userMessageForError(typedError),
        typedError,
      };
    }
  }

  const timedOutError = parseContractError("timeout");
  emit(txCtx, "timed_out", "timeout");
  return {
    txHash: hash,
    success: false,
    error: userMessageForError(timedOutError),
    typedError: timedOutError,
  };
}

// ─── Convenience wrapper (simulate + submit) ──────────────────────────────────

/**
 * Simulate and submit a signed Soroban contract invocation in one call.
 *
 * This is the single entry point used by all write paths in the app (create
 * circle, join, contribute, payout, close).  It calls {@link simulateContractTx}
 * then {@link submitContractTx} under the same telemetry context, so the full
 * lifecycle is recorded as one logical operation.
 *
 * Address validation:
 *  - `contractId` must be a valid Soroban contract ID (C-prefix, 56 chars).
 *  - `walletAddress` must be a valid Stellar public key (G-prefix, 56 chars).
 *
 * Cancellation:
 *  Pass an {@link AbortSignal} to allow the caller to stop waiting without
 *  claiming the transaction was cancelled on-chain.  When the signal fires
 *  before broadcast, `invokeContract` throws with a {@link LocalCancelResult}
 *  cause.  When it fires during polling, the same throw occurs but
 *  `submittedBeforeAbort` is `true` — the transaction may still confirm.
 *  Callers without a signal are unaffected.
 */
export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  walletAddress: string,
  signal?: AbortSignal,
): Promise<InvokeResult> {
  const txCtx = startTx(method);

  // Every failure path — including unexpected synchronous exceptions such as
  // address assertions or SDK client throws — is converted to a typed
  // InvokeResult so callers always receive structured error feedback instead
  // of an unhandled rejection (Issue #479).  Unrecognised failures keep the
  // original message so validation hints stay visible to the user.
  //
  // LocalCancelResult (abort before/during polling) is re-thrown so the
  // caller can distinguish "user stopped waiting" from "transaction failed".
  // It is never recorded as a telemetry failure event.
  try {
    const simOutcome = await simulateContractTx(
      contractId,
      method,
      args,
      walletAddress,
      txCtx,
      signal,
    );
    if (!simOutcome.success) {
      return {
        txHash: "",
        success: false,
        error: simOutcome.error,
        typedError: simOutcome.typedError,
      };
    }

    return await submitContractTx(simOutcome.preparedXdr, txCtx, signal);
  } catch (err: unknown) {
    // Re-throw LocalCancelResult causes so UI layers can distinguish
    // "stopped waiting" from a genuine transaction failure.
    if (
      err instanceof Error &&
      err.cause != null &&
      typeof err.cause === "object" &&
      (err.cause as LocalCancelResult).kind === "local_cancel"
    ) {
      throw err;
    }
    // Also re-throw raw abort reasons (signal.throwIfAborted() throws the
    // reason directly, which may not be an Error wrapping a LocalCancelResult).
    if (signal?.aborted) throw err;

    const raw = err instanceof Error ? err.message : String(err);
    const typedError = parseContractError(raw);
    emit(txCtx, "failed", categorizeError(raw));
    return {
      txHash: "",
      success: false,
      error:
        typedError.kind === "unknown" && raw
          ? raw
          : userMessageForError(typedError),
      typedError,
    };
  }
}

// ─── Read-only simulation ─────────────────────────────────────────────────────

/**
 * Simulate a read-only contract call and return the native-decoded return value.
 *
 * Uses a static fake account so no real sequence-number fetch is required.
 * The transaction is never submitted.
 *
 * Address validation:
 *  - `contractId` must be a valid Soroban contract ID (C-prefix, 56 chars).
 */
export async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  assertSorobanContractId(contractId, "contractId");

  const rpc = getRpc();
  const contract = new Contract(contractId);
  const fakeAccount = {
    id: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    sequence: "0",
    incrementSequenceNumber() {},
  } as unknown as Account;

  const tx = new TransactionBuilder(fakeAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await withRpcRetry("simulateTransaction(read)", () =>
    rpc.simulateTransaction(tx),
  );
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(simResult.error);
  }
  if (!("result" in simResult) || !simResult.result) {
    throw new Error("No result from simulation");
  }
  return scValToNative(simResult.result.retval) as T;
}

// ─── Contract-specific helpers ────────────────────────────────────────────────

/**
 * Fetch the on-chain reputation score for a member address.
 *
 * Address validation:
 *  - `member` must be a canonical Stellar address (G-key or C-contract).
 */
export async function getReputationScore(member: string): Promise<number> {
  assertCanonicalStellarAddress(member, "member");
  return readContract<number>(REPUTATION_ADDRESS, "score", [
    new Address(member).toScVal(),
  ]);
}

/**
 * Fetch the current status string of a circle contract.
 *
 * Address validation:
 *  - `circleAddress` must be a valid Soroban contract ID (C-prefix, 56 chars).
 */
export async function getCircleStatus(circleAddress: string): Promise<string> {
  assertSorobanContractId(circleAddress, "circleAddress");
  return readContract<string>(circleAddress, "get_status", []);
}

/**
 * Fetch the current round index of a circle contract.
 *
 * Address validation:
 *  - `circleAddress` must be a valid Soroban contract ID (C-prefix, 56 chars).
 */
export async function getCurrentRound(circleAddress: string): Promise<unknown> {
  assertSorobanContractId(circleAddress, "circleAddress");
  return readContract<unknown>(circleAddress, "get_current_round", []);
}

/**
 * Fetch the initialisation config of a circle contract.
 *
 * Address validation:
 *  - `circleAddress` must be a valid Soroban contract ID (C-prefix, 56 chars).
 */
export async function getCircleConfig(circleAddress: string): Promise<unknown> {
  assertSorobanContractId(circleAddress, "circleAddress");
  return readContract<unknown>(circleAddress, "get_config", []);
}
