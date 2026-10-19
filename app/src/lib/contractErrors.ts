/**
 * Typed contract error model for CircleUp (Issue #337)
 *
 * Soroban contract panics and simulation errors are returned as opaque strings
 * or numeric codes that are hard to branch on in application code.  This module
 * provides:
 *
 *   1. A discriminated union {@link ContractAppError} covering every category
 *      of failure the app can encounter — validation, authorization, deadline,
 *      wallet, network, and unknown.
 *
 *   2. A stable set of {@link ContractErrorCode} string constants so callers
 *      branch on codes rather than fragile message substrings.
 *
 *   3. A {@link parseContractError} parser that maps raw Soroban error
 *      strings/codes into a typed {@link ContractAppError}, preserving
 *      diagnostic context for unknown failures.
 *
 *   4. A {@link userMessageForError} helper that maps every error code to a
 *      user-facing string — the single source of truth for app error copy.
 *
 * Usage:
 *
 *   ```ts
 *   import { parseContractError, userMessageForError } from "@/lib/contractErrors";
 *
 *   const err = parseContractError(rawErrorFromInvokeContract);
 *   if (err.code === "ALREADY_JOINED") {
 *     showToast("You are already in this circle.");
 *     return;
 *   }
 *   showToast(userMessageForError(err));
 *   ```
 *
 * Stability contract:
 *   - Code string values are stable — do not rename or remove existing codes.
 *   - Add new codes by appending; never reuse a removed code.
 *   - Numeric discriminants in `INIT_ERROR_CODES` and `PAUSE_ERROR_CODES`
 *     mirror the Rust contracterror discriminants and must stay in sync.
 */

// ─── Stable error codes ───────────────────────────────────────────────────────

/**
 * All stable error codes the app can branch on.
 *
 * Categories:
 *   INIT_*    — initialize() validation failures  (InitError in Rust)
 *   PAUSE_*   — pause() / resume() failures       (PauseError in Rust)
 *   AUTH_*    — authorization / membership failures
 *   STATE_*   — lifecycle / status violations
 *   DEADLINE_ — deadline-related violations
 *   TOKEN_*   — token contract / balance failures
 *   WALLET_*  — Freighter / signing failures
 *   NETWORK_* — RPC / connectivity failures
 *   UNKNOWN   — unrecognised error (diagnostic context preserved)
 */
export type ContractErrorCode =
  // ── InitError (mirrors Rust discriminants 1-13) ──────────────────────────
  | "INIT_ALREADY_INITIALIZED"     // 1
  | "INIT_TOO_FEW_MEMBERS"         // 2
  | "INIT_TOO_MANY_MEMBERS"        // 3
  | "INIT_DUPLICATE_MEMBERS"       // 4
  | "INIT_INVALID_ROUND_AMOUNT"    // 5
  | "INIT_POT_OVERFLOW"            // 6
  | "INIT_PENALTY_OVERFLOW"        // 7
  | "INIT_DEADLINE_BELOW_MINIMUM"  // 8
  | "INIT_DEADLINE_ABOVE_MAXIMUM"  // 9
  | "INIT_INVALID_TOKEN_ADDRESS"   // 10
  | "INIT_INVALID_REPUTATION_ADDRESS" // 11
  | "INIT_INCONSISTENT_ROTATION"   // 12
  | "INIT_UNUSABLE_TOKEN_CONTRACT" // 13
  // ── PauseError (mirrors Rust discriminants 1-4) ──────────────────────────
  | "PAUSE_UNAUTHORIZED"           // 1
  | "PAUSE_ALREADY_PAUSED"         // 2
  | "PAUSE_NOT_PAUSED"             // 3
  | "PAUSE_NOT_INITIALIZED"        // 4
  // ── Authorization / membership ───────────────────────────────────────────
  | "AUTH_NOT_A_MEMBER"
  | "AUTH_UNAUTHORIZED"
  // ── Lifecycle / status ───────────────────────────────────────────────────
  | "STATE_ALREADY_JOINED"
  | "STATE_ALREADY_CONTRIBUTED"
  | "STATE_WRONG_STATUS"
  | "STATE_CIRCLE_PAUSED"
  | "STATE_ALREADY_CLOSED"
  | "STATE_ROUND_NOT_COMPLETE"
  // ── Deadline ─────────────────────────────────────────────────────────────
  | "DEADLINE_PASSED"
  | "DEADLINE_NOT_PASSED"
  // ── Token / balance ───────────────────────────────────────────────────────
  | "TOKEN_TRANSFER_FAILED"
  | "TOKEN_INSUFFICIENT_BALANCE"
  | "TOKEN_UNUSABLE"
  // ── Wallet ───────────────────────────────────────────────────────────────
  | "WALLET_REJECTED"
  | "WALLET_NOT_INSTALLED"
  | "WALLET_PERMISSION_DENIED"
  // ── Network / RPC ─────────────────────────────────────────────────────────
  | "NETWORK_ERROR"
  | "NETWORK_TIMEOUT"
  | "NETWORK_RPC_UNAVAILABLE"
  // ── Transaction execution (appended for Issue #479) ──────────────────────
  // XDR `TransactionResult` failures observed after submission — i.e. the
  // transaction reached the network and was rejected on-chain.  These give
  // failed contract transactions specific user-facing feedback instead of
  // falling through to the generic UNKNOWN message.
  | "TX_FAILED_ON_CHAIN"
  | "TX_BAD_SEQ"
  | "TX_INSUFFICIENT_FEE"
  // ── Fallback ──────────────────────────────────────────────────────────────
  | "UNKNOWN";

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * A typed, categorised contract error.
 *
 * Every variant carries a `code` field for deterministic branching, a
 * `message` field with a human-readable description, and an optional `raw`
 * field with the original error string for diagnostics.
 */
export type ContractAppError =
  | ValidationError
  | AuthorizationError
  | DeadlineError
  | StateError
  | TokenError
  | WalletError
  | NetworkError
  | ExecutionError
  | UnknownError;

export interface ValidationError {
  readonly kind: "validation";
  readonly code: Extract<ContractErrorCode,
    | "INIT_ALREADY_INITIALIZED"
    | "INIT_TOO_FEW_MEMBERS"
    | "INIT_TOO_MANY_MEMBERS"
    | "INIT_DUPLICATE_MEMBERS"
    | "INIT_INVALID_ROUND_AMOUNT"
    | "INIT_POT_OVERFLOW"
    | "INIT_PENALTY_OVERFLOW"
    | "INIT_DEADLINE_BELOW_MINIMUM"
    | "INIT_DEADLINE_ABOVE_MAXIMUM"
    | "INIT_INVALID_TOKEN_ADDRESS"
    | "INIT_INVALID_REPUTATION_ADDRESS"
    | "INIT_INCONSISTENT_ROTATION"
    | "INIT_UNUSABLE_TOKEN_CONTRACT"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface AuthorizationError {
  readonly kind: "authorization";
  readonly code: Extract<ContractErrorCode,
    | "AUTH_NOT_A_MEMBER"
    | "AUTH_UNAUTHORIZED"
    | "PAUSE_UNAUTHORIZED"
    | "PAUSE_NOT_INITIALIZED"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface DeadlineError {
  readonly kind: "deadline";
  readonly code: Extract<ContractErrorCode,
    | "DEADLINE_PASSED"
    | "DEADLINE_NOT_PASSED"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface StateError {
  readonly kind: "state";
  readonly code: Extract<ContractErrorCode,
    | "STATE_ALREADY_JOINED"
    | "STATE_ALREADY_CONTRIBUTED"
    | "STATE_WRONG_STATUS"
    | "STATE_CIRCLE_PAUSED"
    | "STATE_ALREADY_CLOSED"
    | "STATE_ROUND_NOT_COMPLETE"
    | "PAUSE_ALREADY_PAUSED"
    | "PAUSE_NOT_PAUSED"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface TokenError {
  readonly kind: "token";
  readonly code: Extract<ContractErrorCode,
    | "TOKEN_TRANSFER_FAILED"
    | "TOKEN_INSUFFICIENT_BALANCE"
    | "TOKEN_UNUSABLE"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface WalletError {
  readonly kind: "wallet";
  readonly code: Extract<ContractErrorCode,
    | "WALLET_REJECTED"
    | "WALLET_NOT_INSTALLED"
    | "WALLET_PERMISSION_DENIED"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface NetworkError {
  readonly kind: "network";
  readonly code: Extract<ContractErrorCode,
    | "NETWORK_ERROR"
    | "NETWORK_TIMEOUT"
    | "NETWORK_RPC_UNAVAILABLE"
  >;
  readonly message: string;
  readonly raw?: string;
}

/**
 * A transaction that reached the network and was rejected on-chain (or at
 * submission time) — as opposed to a wallet, network, or validation failure.
 * Added for Issue #479 so failed contract transactions surface specific
 * feedback (contract rule violation, sequence mismatch, low fee) instead of
 * the generic UNKNOWN fallback.
 */
export interface ExecutionError {
  readonly kind: "execution";
  readonly code: Extract<ContractErrorCode,
    | "TX_FAILED_ON_CHAIN"
    | "TX_BAD_SEQ"
    | "TX_INSUFFICIENT_FEE"
  >;
  readonly message: string;
  readonly raw?: string;
}

export interface UnknownError {
  readonly kind: "unknown";
  readonly code: "UNKNOWN";
  readonly message: string;
  /** Original error string preserved for diagnostics without exposure to users. */
  readonly raw?: string;
}

// ─── Stable user-facing messages ─────────────────────────────────────────────

/**
 * Canonical user-facing messages keyed by {@link ContractErrorCode}.
 *
 * This is the single source of truth for app error copy.  Update copy here
 * rather than scattering message strings throughout components.
 */
const USER_MESSAGES: Record<ContractErrorCode, string> = {
  // Validation
  INIT_ALREADY_INITIALIZED:
    "This circle has already been initialized and cannot be set up again.",
  INIT_TOO_FEW_MEMBERS:
    "A circle requires at least 2 members.",
  INIT_TOO_MANY_MEMBERS:
    "Too many members — the maximum is 256.",
  INIT_DUPLICATE_MEMBERS:
    "The member list contains duplicate addresses. Each member must appear once.",
  INIT_INVALID_ROUND_AMOUNT:
    "The round contribution amount must be greater than zero.",
  INIT_POT_OVERFLOW:
    "The round amount is too large for this number of members.",
  INIT_PENALTY_OVERFLOW:
    "The round amount is too large to calculate the penalty correctly.",
  INIT_DEADLINE_BELOW_MINIMUM:
    "The round deadline is too short. Please choose a longer window.",
  INIT_DEADLINE_ABOVE_MAXIMUM:
    "The round deadline is too long. Please choose a shorter window.",
  INIT_INVALID_TOKEN_ADDRESS:
    "The token address is invalid — it cannot be the circle contract itself.",
  INIT_INVALID_REPUTATION_ADDRESS:
    "The reputation contract address is invalid.",
  INIT_INCONSISTENT_ROTATION:
    "The member rotation is inconsistent. Please refresh and try again.",
  INIT_UNUSABLE_TOKEN_CONTRACT:
    "The configured token address is not a valid token contract. Contact the circle organiser.",

  // Pause
  PAUSE_UNAUTHORIZED:
    "Only the circle admin can pause or resume this circle.",
  PAUSE_ALREADY_PAUSED:
    "This circle is already paused.",
  PAUSE_NOT_PAUSED:
    "This circle is not currently paused.",
  PAUSE_NOT_INITIALIZED:
    "This circle has not been initialized yet.",

  // Authorization
  AUTH_NOT_A_MEMBER:
    "Your wallet is not a member of this circle.",
  AUTH_UNAUTHORIZED:
    "You are not authorized to perform this action.",

  // State
  STATE_ALREADY_JOINED:
    "You have already joined this circle.",
  STATE_ALREADY_CONTRIBUTED:
    "You have already contributed to this round.",
  STATE_WRONG_STATUS:
    "This action is not available in the circle's current state.",
  STATE_CIRCLE_PAUSED:
    "This circle is currently paused. All fund-moving operations are suspended until an admin resumes it.",
  STATE_ALREADY_CLOSED:
    "This circle has already been closed and settled.",
  STATE_ROUND_NOT_COMPLETE:
    "Not all members have contributed yet. Payout requires everyone to contribute.",

  // Deadline
  DEADLINE_PASSED:
    "The round deadline has passed. You can no longer contribute to this round.",
  DEADLINE_NOT_PASSED:
    "The round deadline has not passed yet. Default can only be called after the deadline.",

  // Token
  TOKEN_TRANSFER_FAILED:
    "The USDC transfer failed. Check your balance and that your wallet is authorized for USDC.",
  TOKEN_INSUFFICIENT_BALANCE:
    "Insufficient USDC balance. Please top up your wallet and try again.",
  TOKEN_UNUSABLE:
    "The circle's token contract is not responding. Contact the circle organiser.",

  // Wallet
  WALLET_REJECTED:
    "You cancelled the transaction in Freighter. No funds were moved.",
  WALLET_NOT_INSTALLED:
    "Freighter wallet is not installed. Visit https://freighter.app to install it.",
  WALLET_PERMISSION_DENIED:
    "Wallet access was denied. Please approve the connection in Freighter and try again.",

  // Network
  NETWORK_ERROR:
    "A network error occurred. Check your internet connection and try again.",
  NETWORK_TIMEOUT:
    "The transaction timed out waiting for confirmation. If you don't see the transaction on Stellar Expert, please try again.",
  NETWORK_RPC_UNAVAILABLE:
    "The Stellar RPC is temporarily unavailable. Please try again in a moment. If the problem persists, contact support.",

  // Transaction execution (Issue #479)
  TX_FAILED_ON_CHAIN:
    "The transaction was rejected on-chain. This may be due to a contract rule violation, " +
    "insufficient balance, or an expired transaction. " +
    "Check Stellar Expert for the full error detail.",
  TX_BAD_SEQ:
    "Your wallet's sequence number is out of sync with the network. " +
    "Refresh the page and try again.",
  TX_INSUFFICIENT_FEE:
    "The network fee was too low. Please try again — the fee will be recalculated automatically.",

  // Unknown
  UNKNOWN:
    "An unexpected error occurred. Please try again or contact support if the problem persists.",
};

/**
 * Returns the canonical user-facing message for a {@link ContractAppError}.
 * Always safe to display directly in a UI toast or error banner.
 */
export function userMessageForError(err: ContractAppError): string {
  return USER_MESSAGES[err.code] ?? USER_MESSAGES.UNKNOWN;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Maps raw Soroban/network error strings and numeric codes into a typed
 * {@link ContractAppError}.
 *
 * Strategy:
 *   1. Numeric contract error codes (e.g. from `contracterror` enum) are
 *      matched against known discriminant tables.
 *   2. Known panic message substrings are matched next.
 *   3. Wallet-specific messages are identified before generic network checks.
 *   4. Network-related messages are caught before falling through to UNKNOWN.
 *   5. Unknown errors preserve the raw string for diagnostics but never
 *      expose internal contract details to users via `userMessageForError`.
 *
 * @param raw   The raw error string from `invokeContract` or a simulation error.
 * @param opts  Optional override for the numeric contract error code when the
 *              caller has already parsed the XDR error result.
 */
export function parseContractError(
  raw: string | undefined | null,
  opts: { contractErrorCode?: number; errorType?: "init" | "pause" } = {},
): ContractAppError {
  const str = (raw ?? "").trim();
  const lower = str.toLowerCase();

  // ── 1. Numeric contract error codes ──────────────────────────────────────
  if (opts.contractErrorCode !== undefined) {
    const code = opts.contractErrorCode;
    if (opts.errorType === "init" || !opts.errorType) {
      const initCode = INIT_ERROR_CODE_MAP[code];
      if (initCode) {
        return { kind: "validation", code: initCode, message: USER_MESSAGES[initCode], raw: str };
      }
    }
    if (opts.errorType === "pause" || !opts.errorType) {
      const pauseCode = PAUSE_ERROR_CODE_MAP[code];
      if (pauseCode) {
        // Map pause codes to appropriate kinds
        if (pauseCode === "PAUSE_UNAUTHORIZED" || pauseCode === "PAUSE_NOT_INITIALIZED") {
          return { kind: "authorization", code: pauseCode as AuthorizationError["code"], message: USER_MESSAGES[pauseCode], raw: str };
        }
        return { kind: "state", code: pauseCode as StateError["code"], message: USER_MESSAGES[pauseCode], raw: str };
      }
    }
  }

  // ── 2. Wallet errors (before network — more specific) ─────────────────────
  if (
    lower.includes("user rejected") ||
    lower.includes("denied") ||
    lower.includes("rejected") ||
    lower.includes("cancelled") ||
    lower.includes("canceled") ||
    lower.includes("freighter did not return")
  ) {
    return { kind: "wallet", code: "WALLET_REJECTED", message: USER_MESSAGES.WALLET_REJECTED, raw: str };
  }

  if (lower.includes("not installed") || lower.includes("freighter") && lower.includes("install")) {
    return { kind: "wallet", code: "WALLET_NOT_INSTALLED", message: USER_MESSAGES.WALLET_NOT_INSTALLED, raw: str };
  }

  if (lower.includes("permission denied") || lower.includes("approve the connection")) {
    return { kind: "wallet", code: "WALLET_PERMISSION_DENIED", message: USER_MESSAGES.WALLET_PERMISSION_DENIED, raw: str };
  }

  // ── 2.5. Transaction execution / envelope failures (Issue #479) ─────────────
  //
  // These match the canonical "transaction failed" marker used by the
  // submission polling loop as well as the XDR result-code names extracted
  // from `xdr.TransactionResult` (e.g. "txFailed", "txBadSeq",
  // "txInsufficientFee").  They are checked before the generic network
  // patterns so an on-chain rejection never degrades to the UNKNOWN
  // fallback ("An unexpected error occurred").
  if (
    lower === "transaction failed" ||
    lower === "tx_failed" ||
    lower.includes("txfailed")
  ) {
    return { kind: "execution", code: "TX_FAILED_ON_CHAIN", message: USER_MESSAGES.TX_FAILED_ON_CHAIN, raw: str };
  }

  if (lower.includes("txbadseq")) {
    return { kind: "execution", code: "TX_BAD_SEQ", message: USER_MESSAGES.TX_BAD_SEQ, raw: str };
  }

  if (
    lower.includes("txinsufficientfee") ||
    (lower.includes("insufficient") && lower.includes("fee"))
  ) {
    return { kind: "execution", code: "TX_INSUFFICIENT_FEE", message: USER_MESSAGES.TX_INSUFFICIENT_FEE, raw: str };
  }

  // ── 3. Network / RPC errors ───────────────────────────────────────────────
  if (
    lower === "timeout" ||
    lower.includes("timed out") ||
    lower.includes("confirmation timed out")
  ) {
    return { kind: "network", code: "NETWORK_TIMEOUT", message: USER_MESSAGES.NETWORK_TIMEOUT, raw: str };
  }

  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable")
  ) {
    return { kind: "network", code: "NETWORK_ERROR", message: USER_MESSAGES.NETWORK_ERROR, raw: str };
  }

  if (lower.includes("rpc") && (lower.includes("unavailable") || lower.includes("failed"))) {
    return { kind: "network", code: "NETWORK_RPC_UNAVAILABLE", message: USER_MESSAGES.NETWORK_RPC_UNAVAILABLE, raw: str };
  }

  // ── 4. Contract panic message substrings ─────────────────────────────────
  if (lower.includes("circle is paused")) {
    return { kind: "state", code: "STATE_CIRCLE_PAUSED", message: USER_MESSAGES.STATE_CIRCLE_PAUSED, raw: str };
  }
  if (lower.includes("already initialized")) {
    return { kind: "validation", code: "INIT_ALREADY_INITIALIZED", message: USER_MESSAGES.INIT_ALREADY_INITIALIZED, raw: str };
  }
  if (lower.includes("already joined")) {
    return { kind: "state", code: "STATE_ALREADY_JOINED", message: USER_MESSAGES.STATE_ALREADY_JOINED, raw: str };
  }
  if (lower.includes("already contributed")) {
    return { kind: "state", code: "STATE_ALREADY_CONTRIBUTED", message: USER_MESSAGES.STATE_ALREADY_CONTRIBUTED, raw: str };
  }
  if (lower.includes("not a circle member") || lower.includes("not a member")) {
    return { kind: "authorization", code: "AUTH_NOT_A_MEMBER", message: USER_MESSAGES.AUTH_NOT_A_MEMBER, raw: str };
  }
  if (lower.includes("need at least 2 members")) {
    return { kind: "validation", code: "INIT_TOO_FEW_MEMBERS", message: USER_MESSAGES.INIT_TOO_FEW_MEMBERS, raw: str };
  }
  if (lower.includes("too many members")) {
    return { kind: "validation", code: "INIT_TOO_MANY_MEMBERS", message: USER_MESSAGES.INIT_TOO_MANY_MEMBERS, raw: str };
  }
  if (lower.includes("duplicate members")) {
    return { kind: "validation", code: "INIT_DUPLICATE_MEMBERS", message: USER_MESSAGES.INIT_DUPLICATE_MEMBERS, raw: str };
  }
  if (lower.includes("round_amount must be positive")) {
    return { kind: "validation", code: "INIT_INVALID_ROUND_AMOUNT", message: USER_MESSAGES.INIT_INVALID_ROUND_AMOUNT, raw: str };
  }
  if (lower.includes("overflows pot calculation")) {
    return { kind: "validation", code: "INIT_POT_OVERFLOW", message: USER_MESSAGES.INIT_POT_OVERFLOW, raw: str };
  }
  if (lower.includes("overflows penalty calculation")) {
    return { kind: "validation", code: "INIT_PENALTY_OVERFLOW", message: USER_MESSAGES.INIT_PENALTY_OVERFLOW, raw: str };
  }
  if (lower.includes("round_deadline_ledgers below minimum")) {
    return { kind: "validation", code: "INIT_DEADLINE_BELOW_MINIMUM", message: USER_MESSAGES.INIT_DEADLINE_BELOW_MINIMUM, raw: str };
  }
  if (lower.includes("round_deadline_ledgers above maximum")) {
    return { kind: "validation", code: "INIT_DEADLINE_ABOVE_MAXIMUM", message: USER_MESSAGES.INIT_DEADLINE_ABOVE_MAXIMUM, raw: str };
  }
  if (lower.includes("usdc_token must not be the circle contract")) {
    return { kind: "validation", code: "INIT_INVALID_TOKEN_ADDRESS", message: USER_MESSAGES.INIT_INVALID_TOKEN_ADDRESS, raw: str };
  }
  if (lower.includes("does not implement the standard token interface")) {
    return { kind: "token", code: "TOKEN_UNUSABLE", message: USER_MESSAGES.TOKEN_UNUSABLE, raw: str };
  }
  if (lower.includes("usdc transfer failed") || lower.includes("token transfer failed")) {
    if (lower.includes("insufficient")) {
      return { kind: "token", code: "TOKEN_INSUFFICIENT_BALANCE", message: USER_MESSAGES.TOKEN_INSUFFICIENT_BALANCE, raw: str };
    }
    return { kind: "token", code: "TOKEN_TRANSFER_FAILED", message: USER_MESSAGES.TOKEN_TRANSFER_FAILED, raw: str };
  }
  if (
    lower.includes("deadline has passed") ||
    lower.includes("past the round deadline") ||
    lower.includes("deadline passed")
  ) {
    return { kind: "deadline", code: "DEADLINE_PASSED", message: USER_MESSAGES.DEADLINE_PASSED, raw: str };
  }
  if (lower.includes("deadline has not passed") || lower.includes("deadline not passed")) {
    return { kind: "deadline", code: "DEADLINE_NOT_PASSED", message: USER_MESSAGES.DEADLINE_NOT_PASSED, raw: str };
  }
  if (lower.includes("not all members have contributed")) {
    // Contract panic from `payout` when the on-chain contribution counter is
    // behind the app's snapshot (e.g. indexer lag) — tell the user precisely
    // why the payout was rejected instead of the UNKNOWN fallback (#479).
    return { kind: "state", code: "STATE_ROUND_NOT_COMPLETE", message: USER_MESSAGES.STATE_ROUND_NOT_COMPLETE, raw: str };
  }
  if (lower.includes("already paid out")) {
    // Contract panic from `contribute`/`payout` after the round settled —
    // the circle state has moved on since the user's screen was rendered.
    return { kind: "state", code: "STATE_WRONG_STATUS", message: USER_MESSAGES.STATE_WRONG_STATUS, raw: str };
  }
  if (lower.includes("circle is not active") || lower.includes("wrong status") || lower.includes("circle still active")) {
    return { kind: "state", code: "STATE_WRONG_STATUS", message: USER_MESSAGES.STATE_WRONG_STATUS, raw: str };
  }
  if (lower.includes("already been closed") || lower.includes("already closed")) {
    return { kind: "state", code: "STATE_ALREADY_CLOSED", message: USER_MESSAGES.STATE_ALREADY_CLOSED, raw: str };
  }

  // ── 5. Unknown — preserve raw for diagnostics ─────────────────────────────
  return {
    kind: "unknown",
    code: "UNKNOWN",
    message: USER_MESSAGES.UNKNOWN,
    raw: str || undefined,
  };
}

// ─── Numeric code lookup tables ───────────────────────────────────────────────

/**
 * Maps Rust `InitError` discriminant numbers to stable {@link ContractErrorCode}s.
 * Keep in sync with `InitError` in `contracts/circle/src/lib.rs`.
 */
const INIT_ERROR_CODE_MAP: Record<number, ValidationError["code"]> = {
  1:  "INIT_ALREADY_INITIALIZED",
  2:  "INIT_TOO_FEW_MEMBERS",
  3:  "INIT_TOO_MANY_MEMBERS",
  4:  "INIT_DUPLICATE_MEMBERS",
  5:  "INIT_INVALID_ROUND_AMOUNT",
  6:  "INIT_POT_OVERFLOW",
  7:  "INIT_PENALTY_OVERFLOW",
  8:  "INIT_DEADLINE_BELOW_MINIMUM",
  9:  "INIT_DEADLINE_ABOVE_MAXIMUM",
  10: "INIT_INVALID_TOKEN_ADDRESS",
  11: "INIT_INVALID_REPUTATION_ADDRESS",
  12: "INIT_INCONSISTENT_ROTATION",
  13: "INIT_UNUSABLE_TOKEN_CONTRACT",
};

/**
 * Maps Rust `PauseError` discriminant numbers to stable {@link ContractErrorCode}s.
 * Keep in sync with `PauseError` in `contracts/circle/src/lib.rs`.
 */
const PAUSE_ERROR_CODE_MAP: Record<number, Extract<ContractErrorCode,
  "PAUSE_UNAUTHORIZED" | "PAUSE_ALREADY_PAUSED" | "PAUSE_NOT_PAUSED" | "PAUSE_NOT_INITIALIZED"
>> = {
  1: "PAUSE_UNAUTHORIZED",
  2: "PAUSE_ALREADY_PAUSED",
  3: "PAUSE_NOT_PAUSED",
  4: "PAUSE_NOT_INITIALIZED",
};

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isValidationError(e: ContractAppError): e is ValidationError {
  return e.kind === "validation";
}
export function isAuthorizationError(e: ContractAppError): e is AuthorizationError {
  return e.kind === "authorization";
}
export function isDeadlineError(e: ContractAppError): e is DeadlineError {
  return e.kind === "deadline";
}
export function isStateError(e: ContractAppError): e is StateError {
  return e.kind === "state";
}
export function isTokenError(e: ContractAppError): e is TokenError {
  return e.kind === "token";
}
export function isWalletError(e: ContractAppError): e is WalletError {
  return e.kind === "wallet";
}
export function isNetworkError(e: ContractAppError): e is NetworkError {
  return e.kind === "network";
}
export function isExecutionError(e: ContractAppError): e is ExecutionError {
  return e.kind === "execution";
}
export function isUnknownError(e: ContractAppError): e is UnknownError {
  return e.kind === "unknown";
}
