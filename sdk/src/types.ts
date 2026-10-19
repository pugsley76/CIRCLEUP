// ─── SDK Types ────────────────────────────────────────────────────────────────
//
// Public API invariants for every type and helper in this module are documented
// in docs/API_INVARIANTS.md (section 9 — SDK type-safety invariants).
// The invariant identifiers (S1, S2, …) used in JSDoc below refer to that table.

export type NetworkPassphrase =
  | "Test SDF Network ; September 2015"
  | "Public Global Stellar Network ; September 2015";

export interface CircleUpConfig {
  /** Stellar RPC endpoint */
  rpcUrl: string;
  networkPassphrase: NetworkPassphrase;
  /** Deployed contract addresses */
  contracts: {
    circleFactory: string;
    reputation: string;
    usdc: string;
  };
  /**
   * Base URL of the CircleUp indexer REST API (e.g. "http://localhost:3001").
   * Required only when using {@link IndexerClient}. If omitted, IndexerClient
   * construction will throw so the misconfiguration is caught early.
   */
  indexerUrl?: string;
}

// ─── Config validation ────────────────────────────────────────────────────────

/** Regex for a Stellar/Soroban contract address: starts with C, 56 chars total. */
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

/** Regex for a Stellar account address (public key): starts with G, 56 chars total. */
const ACCOUNT_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** Returns true when `addr` looks like a valid Soroban contract address. */
export function isValidContractAddress(addr: string): boolean {
  return CONTRACT_ADDRESS_RE.test(addr);
}

/**
 * Returns true when `addr` is either a Stellar account (G…) or a Soroban
 * contract (C…) address — the two forms accepted anywhere the contracts take
 * an `Address` parameter.
 *
 * This is a shape check only; the strkey checksum is verified by the Stellar
 * SDK when the address is actually encoded (see `scAddress` in client.ts).
 */
export function isValidStellarAddress(addr: unknown): addr is string {
  return (
    typeof addr === "string" &&
    (ACCOUNT_ADDRESS_RE.test(addr) || CONTRACT_ADDRESS_RE.test(addr))
  );
}

/**
 * Validate a `CircleUpConfig` object and throw a descriptive `Error` listing
 * every problem found.  Called automatically by `CircleUpClient` in its
 * constructor so misconfiguration surfaces immediately instead of producing
 * a cryptic RPC error on the first call.
 *
 * @throws `Error` with a human-readable summary of all validation failures.
 */
export function validateCircleUpConfig(config: unknown): asserts config is CircleUpConfig {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    throw new Error("CircleUpConfig must be a non-null object.");
  }

  const cfg = config as Record<string, unknown>;

  // rpcUrl
  if (!cfg.rpcUrl || typeof cfg.rpcUrl !== "string") {
    errors.push('config.rpcUrl is required and must be a string (e.g. "https://soroban-testnet.stellar.org").');
  } else if (!/^https?:\/\/.+/.test(cfg.rpcUrl)) {
    errors.push(`config.rpcUrl "${cfg.rpcUrl}" does not look like a valid URL.`);
  }

  // networkPassphrase
  const validPassphrases: NetworkPassphrase[] = [
    "Test SDF Network ; September 2015",
    "Public Global Stellar Network ; September 2015",
  ];
  if (!cfg.networkPassphrase || typeof cfg.networkPassphrase !== "string") {
    errors.push("config.networkPassphrase is required. Use TESTNET_PASSPHRASE or MAINNET_PASSPHRASE from @circleup/sdk.");
  } else if (!validPassphrases.includes(cfg.networkPassphrase as NetworkPassphrase)) {
    errors.push(
      `config.networkPassphrase "${cfg.networkPassphrase}" is not recognised. ` +
        `Expected one of: ${validPassphrases.map((p) => `"${p}"`).join(", ")}.`,
    );
  }

  // contracts block
  if (!cfg.contracts || typeof cfg.contracts !== "object") {
    errors.push("config.contracts is required and must be an object with circleFactory, reputation, and usdc addresses.");
  } else {
    const contracts = cfg.contracts as Record<string, unknown>;
    for (const key of ["circleFactory", "reputation", "usdc"] as const) {
      const addr = contracts[key];
      if (!addr || typeof addr !== "string") {
        errors.push(`config.contracts.${key} is required.`);
      } else if (!isValidContractAddress(addr)) {
        errors.push(
          `config.contracts.${key} "${addr}" does not look like a valid Soroban contract address ` +
            `(expected a 56-character string starting with "C").`,
        );
      }
    }
  }

  // indexerUrl — optional, but when present must look like an HTTP(S) URL
  if (cfg.indexerUrl !== undefined && cfg.indexerUrl !== null) {
    if (typeof cfg.indexerUrl !== "string") {
      errors.push(
        `config.indexerUrl must be a string URL (e.g. "http://localhost:3001"), got ${typeof cfg.indexerUrl}.`,
      );
    } else if (cfg.indexerUrl.trim() !== "" && !/^https?:\/\/.+/.test(cfg.indexerUrl.trim())) {
      errors.push(
        `config.indexerUrl "${cfg.indexerUrl}" does not look like a valid HTTP(S) URL.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid CircleUpConfig:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}

// ─── Contract argument validation ─────────────────────────────────────────────

/**
 * Validate a set of contract call parameters before any encoding is attempted.
 *
 * Called by high-level mutation methods (e.g. `createCircle`, `markDefault`)
 * to catch bad inputs — wrong types, out-of-range numbers, malformed addresses
 * — at the earliest possible point.  Returning a string rather than throwing
 * lets callers convert the problem into the appropriate error shape (`TxFailure`
 * for mutations, a thrown `TypeError` for pure encoders).
 *
 * @param params Named parameters to validate, checked in order.
 * @returns `null` when every parameter is valid; otherwise a human-readable
 *   description of the first problem found.
 */
export function validateContractArgs(
  params: Array<{ name: string; value: unknown; type: "address" | "u32" | "i128" | "bool" | "addressVec" }>,
): string | null {
  for (const { name, value, type } of params) {
    switch (type) {
      case "address": {
        if (!isValidStellarAddress(value)) {
          return (
            `"${name}" must be a Stellar account (G…) or contract (C…) address, ` +
            `got ${describeArgValue(value)}.`
          );
        }
        break;
      }
      case "u32": {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 0xffffffff
        ) {
          return (
            `"${name}" must be a u32 integer (0–4294967295), ` +
            `got ${describeArgValue(value)}.`
          );
        }
        break;
      }
      case "i128": {
        const I128_MAX = (1n << 127n) - 1n;
        const I128_MIN = -(1n << 127n);
        if (typeof value === "number") {
          if (!Number.isInteger(value)) {
            return `"${name}" must be a whole number for i128 encoding, got ${value} (use a bigint).`;
          }
          if (!Number.isSafeInteger(value)) {
            return (
              `"${name}" (${value}) exceeds Number.MAX_SAFE_INTEGER and would lose ` +
              `precision when converted to i128. Pass a bigint instead.`
            );
          }
        } else if (typeof value === "bigint") {
          if (value < I128_MIN || value > I128_MAX) {
            return `"${name}" (${value}) is out of range for i128 (${I128_MIN}–${I128_MAX}).`;
          }
        } else {
          return `"${name}" must be a bigint or integer number for i128 encoding, got ${describeArgValue(value)}.`;
        }
        break;
      }
      case "bool": {
        if (typeof value !== "boolean") {
          return `"${name}" must be a boolean, got ${describeArgValue(value)}.`;
        }
        break;
      }
      case "addressVec": {
        if (!Array.isArray(value)) {
          return `"${name}" must be an array of Stellar addresses, got ${describeArgValue(value)}.`;
        }
        if (value.length === 0) {
          return `"${name}" must not be empty — at least one address is required.`;
        }
        for (let i = 0; i < value.length; i++) {
          if (!isValidStellarAddress(value[i])) {
            return (
              `"${name}[${i}]" is not a valid Stellar address, got ${describeArgValue(value[i])}.`
            );
          }
        }
        break;
      }
    }
  }
  return null;
}

/** Render an argument value concisely for an error message. */
function describeArgValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint ${value}`;
  if (typeof value === "string") return `string "${value.slice(0, 40)}${value.length > 40 ? "…" : ""}"`;
  if (typeof value === "object") return `object (${Object.prototype.toString.call(value)})`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

// ── Raw wire types returned by scValToNative from Soroban simulation ──────────
//
// When `simulateAndRead` decodes a Soroban return value via `scValToNative` the
// result is a plain JS object whose keys mirror the Rust snake_case field names
// and whose numeric values are either `number` or `bigint` depending on the
// Soroban XDR type.  These types make the `simulateAndRead` call-site explicit
// and safe — no more `as any` or property-access guesswork.
//
// They are intentionally *not* exported as part of the public SDK surface (they
// are implementation details of the mapping layer), but exporting them here
// lets the test suite assert the mapping logic without re-importing from client.

/**
 * Raw scValToNative shape for `CircleConfig` (Rust: `CircleConfig` struct).
 *
 * Field mapping:
 *   members                → string[]  (Stellar address strings)
 *   round_amount           → bigint    (i128 in XDR)
 *   usdc_token             → string
 *   reputation_contract    → string
 *   round_deadline_ledgers → number    (u32 in XDR)
 */
export interface RawCircleConfig {
  members: string[];
  round_amount: bigint;
  usdc_token: string;
  reputation_contract: string;
  round_deadline_ledgers: number;
}

/**
 * Raw scValToNative shape for `RoundState` (Rust: `RoundState` struct).
 *
 * Field mapping:
 *   round_index            → number   (u32)
 *   recipient              → string   (Stellar address)
 *   contributions_received → number   (u32)
 *   deadline_ledger        → bigint   (u64)
 *   paid_out               → boolean
 */
export interface RawRoundState {
  round_index: number;
  recipient: string;
  contributions_received: number;
  deadline_ledger: bigint;
  paid_out: boolean;
}

// ── Circle state types (mirrors contract structs) ─────────────────────────────

export type CircleStatus = "Pending" | "Active" | "Completed" | "Cancelled";

/**
 * Decoded configuration of a deployed circle contract.
 *
 * Returned by `CircleClient.getConfig()`.  All values are read from on-chain
 * storage via `get_config` simulation and decoded through `mapRawConfig`.
 *
 * # Invariants
 *
 * - `members.length` is in `[2, 256]` (enforced by `initialize`).
 * - Every address in `members` is a distinct Stellar account or contract address.
 * - The order of `members` determines the payout rotation: round `i` pays
 *   `members[i]`.  This order is fixed at `initialize` time and **never**
 *   changes regardless of join order.
 * - `roundAmount > 0n` (enforced by `initialize`).
 * - `roundAmount × members.length` fits in `i128` (overflow-checked at
 *   initialize time by the contract).
 * - `roundDeadlineLedgers` is in `[100, 1_036_800]`.
 * - `usdcToken` and `reputationContract` are distinct addresses and neither
 *   equals the circle's own contract address.
 */
export interface CircleConfig {
  members: string[];
  roundAmount: bigint;       // in stroops (1 USDC = 10_000_000n)
  usdcToken: string;
  reputationContract: string;
  roundDeadlineLedgers: number;
}

/**
 * Decoded state of the current (or most recent) round.
 *
 * Returned by `CircleClient.getCurrentRound()`.
 *
 * # Invariants
 *
 * - Only readable when `status === "Active"` — throws `ContractError.CircleNotActive`
 *   otherwise (surfaced as a `ReadFailure` by `getCurrentRoundResult`).
 * - `roundIndex` is in `[0, member_count - 1]` and strictly increases across
 *   rounds; it never decrements.
 * - `recipient` equals `config.members[roundIndex]` — the rotation is position-
 *   based, not join-order-based.
 * - `contributionsReceived` is in `[0, member_count]`; it reaches `member_count`
 *   exactly once per round (the trigger for payout).
 * - `deadlineLedger` is set at the ledger the circle goes Active (round 0) and
 *   at each `payout` call for subsequent rounds.
 * - `paidOut` starts `false`; set to `true` atomically with the pot transfer
 *   and never reverts (single-use CEI guard).
 */
export interface RoundState {
  roundIndex: number;
  recipient: string;
  contributionsReceived: number;
  deadlineLedger: bigint;
  paidOut: boolean;
}

/**
 * Aggregate snapshot of a circle's on-chain state.
 *
 * # Invariants
 *
 * - `status` is always one of the four `CircleStatus` variants; the SDK
 *   throws if the contract returns an unrecognised value.
 * - `currentRound` is only valid when `status === "Active"`.  For all other
 *   statuses it is absent or carries a zero-valued sentinel; use
 *   `CircleClient.getCurrentRoundResult()` to handle this gracefully.
 */
export interface CircleState {
  address: string;
  config: CircleConfig;
  status: CircleStatus;
  currentRound: RoundState;
}

/**
 * Per-member view combining on-chain collateral, defaults, reputation, and
 * contribution state for the current round.
 *
 * # Invariants
 *
 * - `collateral ≥ 0n` — the contract clamps penalty deductions to 0.
 * - `defaults` is the total number of rounds this member has missed across
 *   the circle's lifetime.  It never decreases.
 * - `reputationScore` is the member's global reputation score across all
 *   circles — not circle-scoped.  It is monotonically non-decreasing.
 * - `hasContributedThisRound` reflects on-chain `has_contributed(member, current_round_index)`;
 *   it resets to `false` at the start of each new round.
 */
export interface MemberState {
  address: string;
  collateral: bigint;
  defaults: number;
  reputationScore: number;
  hasContributedThisRound: boolean;
}

// ─── Read result ─────────────────────────────────────────────────────────────
//
// A discriminated union returned by the *non-throwing* read helpers
// (getConfigResult, getStatusResult, getCurrentRoundResult).
//
// These complement the throwing variants (getConfig, getStatus, getCurrentRound)
// for call-sites that want to handle errors gracefully — e.g. showing a UI
// skeleton while the circle is still Pending — without wrapping every call in
// try/catch.
//
//   const r = await client.getConfigResult();
//   if (r.ok) {
//     render(r.value);          // CircleConfig, fully typed
//   } else {
//     showError(r.error);       // human-readable string
//   }
//
// The throwing helpers delegate to the same underlying simulation; callers that
// only need one style do not pay for the other.

/** A read that returned a decoded value. */
export interface ReadSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** A read that failed (network error, simulation error, decode error, …). */
export interface ReadFailure {
  readonly ok: false;
  /** Human-readable description of what went wrong. */
  readonly error: string;
}

/** Discriminated union of possible typed-read outcomes. */
export type ReadResult<T> = ReadSuccess<T> | ReadFailure;

/**
 * Type-guard — narrows `ReadResult<T>` to `ReadSuccess<T>`.
 *
 * @example
 * const r = await client.getConfigResult();
 * if (isReadSuccess(r)) console.log(r.value.roundAmount);
 */
export function isReadSuccess<T>(r: ReadResult<T>): r is ReadSuccess<T> {
  return r.ok === true;
}

/**
 * Type-guard — narrows `ReadResult<T>` to `ReadFailure`.
 *
 * @example
 * const r = await client.getStatusResult();
 * if (isReadFailure(r)) showBanner(r.error);
 */
export function isReadFailure<T>(r: ReadResult<T>): r is ReadFailure {
  return r.ok === false;
}

// ─── Raw → domain mapping helpers ────────────────────────────────────────────
//
// Extracted from the CircleClient method bodies so they can be unit-tested in
// isolation without spinning up a mock RPC server.  The helpers are exported
// so external packages (e.g. app/, indexer/) can reuse the same coercion logic
// rather than duplicating it.

/**
 * Render an unexpected wire value for an error message without dumping an
 * unbounded blob into a log line or a UI toast.
 */
function describeValue(value: unknown): string {
  if (typeof value === "bigint") return `bigint ${value}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    const json = JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? `${v}` : v,
    );
    return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Decode a `u32` field produced by `scValToNative`.
 *
 * `scValToNative` yields a plain `number` for XDR `u32`.  Anything else means
 * the contract's return shape has drifted from what the SDK expects, so we
 * fail loudly at the boundary instead of letting `NaN` or `undefined` flow
 * into domain code.
 *
 * # Invariant S2
 *
 * Throws `TypeError` when the value is not an in-range u32.  The error message
 * includes `label` (the call-site context) so the source of the bad wire value
 * is always identifiable without a stack trace.
 *
 * @param label Call-site context included in the error message,
 *              e.g. `"getDefaults"` or `"mapRawRoundState.round_index"`.
 * @throws `TypeError` when the value is not an in-range u32.
 */
export function decodeU32(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new TypeError(
      `${label}: expected a u32 (number) but the contract returned ${describeValue(value)} ` +
        `(type: ${typeof value}). This usually means the contract's return type has changed ` +
        `or the wrong field was decoded.`,
    );
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError(
      `${label}: expected a u32 (0–4294967295) but the contract returned ${describeValue(value)}.`,
    );
  }
  return value;
}

/**
 * Decode an `i128` or `u64` field produced by `scValToNative`.
 *
 * `scValToNative` yields a `bigint` for both widths.  A plain `number` is
 * accepted too — a narrower integer type on the contract side is not a
 * correctness problem — but only when it is a safe integer, because beyond
 * 2^53 the conversion would silently round a monetary amount.
 *
 * # Invariant S2
 *
 * Throws `TypeError` when the value cannot be represented losslessly.  This
 * prevents silent monetary rounding when a financial field (e.g. `round_amount`,
 * `collateral`) arrives as an unsafe number.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value cannot be represented losslessly.
 */
export function decodeBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `${label}: expected an integer amount but the contract returned ${describeValue(value)}, ` +
          `which cannot be converted to bigint without losing precision.`,
      );
    }
    return BigInt(value);
  }
  throw new TypeError(
    `${label}: expected a bigint or number for an i128/u64 field but the contract returned ` +
      `${describeValue(value)} (type: ${typeof value}). ` +
      `This usually means the contract's return type has changed or the wrong field was decoded.`,
  );
}

/** Inclusive bounds of the XDR integer widths the contracts return. */
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Decode an `i128` field produced by `scValToNative`, rejecting values the XDR
 * type cannot hold and, optionally, values below a domain minimum.
 *
 * Built on {@link decodeBigInt}, so a safe-integer `number` is still accepted.
 * `min` expresses a contract invariant — e.g. collateral is clamped to `0n`,
 * and a round amount is always positive — so a value that breaks it fails here
 * with the field name instead of rendering as a negative balance.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not an integer, or is out of range.
 */
export function decodeI128(
  value: unknown,
  label: string,
  options: { min?: bigint } = {},
): bigint {
  const n = decodeBigInt(value, label);
  if (n < I128_MIN || n > I128_MAX) {
    throw new TypeError(`${label}: ${n} is out of range for i128.`);
  }
  if (options.min !== undefined && n < options.min) {
    throw new TypeError(
      `${label}: expected a value >= ${options.min} but the contract returned ${n}.`,
    );
  }
  return n;
}

/**
 * Decode a `u64` field (e.g. a ledger sequence) produced by `scValToNative`.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not an integer in `[0, 2^64 - 1]`.
 */
export function decodeU64(value: unknown, label: string): bigint {
  const n = decodeBigInt(value, label);
  if (n < 0n || n > U64_MAX) {
    throw new TypeError(`${label}: ${n} is out of range for u64 (0–${U64_MAX}).`);
  }
  return n;
}

/**
 * Decode a `u32` that the contract additionally constrains to `[min, max]`.
 *
 * The range is the contract's own validation (e.g. `round_deadline_ledgers`
 * is checked against `MIN_/MAX_ROUND_DEADLINE_LEDGERS` at initialize), so a
 * value outside it means the SDK is reading the wrong field or a contract
 * built with different bounds — either way not something to pass on silently.
 *
 * @throws `TypeError` when the value is not a u32 or falls outside the range.
 */
export function decodeU32InRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const n = decodeU32(value, label);
  if (n < min || n > max) {
    throw new TypeError(
      `${label}: expected a value in [${min}, ${max}] but the contract returned ${n}.`,
    );
  }
  return n;
}

/**
 * Decode a contract struct produced by `scValToNative` into a plain record,
 * checking that every required field is present.
 *
 * `scValToNative` turns an `ScMap` into a plain object, so anything else — an
 * array (a `Vec` or an enum variant), a primitive, or `null` — means the view
 * returned a different type entirely. Every missing field is listed at once so
 * a renamed field is reported together with whatever replaced it.
 *
 * @param label Call-site context, e.g. `"mapRawConfig"`.
 * @param required Field names that must be present and not `undefined`.
 * @param structName Contract type named in the error, e.g. `"CircleConfig"`.
 * @throws `TypeError` when `value` is not a struct or a required field is absent.
 */
export function decodeRecord<K extends string>(
  value: unknown,
  label: string,
  required: readonly K[],
  structName = "contract struct",
): Record<K, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Map
  ) {
    throw new TypeError(
      `${label}: expected a ${structName} object but the contract returned ${describeValue(value)}.`,
    );
  }
  const record = value as Record<string, unknown>;
  const missing = required.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new TypeError(
      `${label}: missing required field${missing.length === 1 ? "" : "s"} ` +
        `${missing.map((k) => `"${k}"`).join(", ")}. Fields present: ` +
        `${Object.keys(record).map((k) => `"${k}"`).join(", ") || "(none)"}.`,
    );
  }
  return record as Record<K, unknown>;
}

/**
 * Decode a `bool` field produced by `scValToNative`.
 *
 * Deliberately strict: a truthy string or number here would mean the contract
 * returned something other than a `bool`, and coercing it would hide the bug.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not a boolean.
 */
export function decodeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(
      `${label}: expected a boolean but the contract returned ${describeValue(value)} ` +
        `(type: ${typeof value}).`,
    );
  }
  return value;
}

/**
 * Decode an `Address` field produced by `scValToNative`.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not a Stellar account or contract address.
 */
export function decodeAddress(value: unknown, label: string): string {
  if (!isValidStellarAddress(value)) {
    const typeTag = value === null ? "null"
      : value === undefined ? "undefined"
      : typeof value;
    throw new TypeError(
      `${label}: expected a Stellar address (G… or C…) but the contract returned ` +
        `${describeValue(value)} (type: ${typeTag}).`,
    );
  }
  return value;
}

/**
 * Decode a `Vec<Address>` field produced by `scValToNative`.
 *
 * Empty lists are valid — a freshly deployed factory has no circles yet.
 *
 * @param label Call-site context included in the error message.
 * @param options.unique Reject a list that names the same address twice, for
 *   fields the contract guarantees are distinct (e.g. a circle's members).
 * @param options.maxLength Reject a list longer than the contract allows.
 * @throws `TypeError` when the value is not an array of Stellar addresses, or
 *   breaks one of the requested constraints.
 */
export function decodeAddressList(
  value: unknown,
  label: string,
  options: { unique?: boolean; maxLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${label}: expected an array of Stellar addresses but the contract returned ${describeValue(value)}.`,
    );
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new TypeError(
      `${label}: expected at most ${options.maxLength} addresses but the contract returned ${value.length}.`,
    );
  }
  const addresses = value.map((entry, i) => decodeAddress(entry, `${label}[${i}]`));
  if (options.unique) {
    const seen = new Map<string, number>();
    addresses.forEach((addr, i) => {
      const first = seen.get(addr);
      if (first !== undefined) {
        throw new TypeError(
          `${label}: address ${addr} appears at both index ${first} and index ${i}; ` +
            `the contract guarantees these entries are distinct.`,
        );
      }
      seen.set(addr, i);
    });
  }
  return addresses;
}

/** Bounds the circle contract enforces at `initialize` (see contracts/circle). */
const MIN_ROUND_DEADLINE_LEDGERS = 100;
const MAX_ROUND_DEADLINE_LEDGERS = 1_036_800;
const MAX_CIRCLE_MEMBERS = 256;

const CONFIG_FIELDS = [
  "members",
  "round_amount",
  "usdc_token",
  "reputation_contract",
  "round_deadline_ledgers",
] as const;

const ROUND_FIELDS = [
  "round_index",
  "recipient",
  "contributions_received",
  "deadline_ledger",
  "paid_out",
] as const;

/**
 * Map a raw `scValToNative` wire object to the typed `CircleConfig` domain
 * shape, validating every field as it is decoded.
 *
 * Beyond the per-field types, this enforces the invariants `initialize`
 * guarantees — distinct members (at most 256), a positive round amount, and a
 * deadline inside the contract's bounds — so a value that breaks them is
 * reported here rather than producing a config that looks valid but is not.
 *
 * @throws `TypeError` if `raw` is not an object, a field is missing, or any
 *   field has the wrong type or an out-of-range value — surfaces decode bugs
 *   at the boundary rather than letting `undefined` leak into domain code.
 */
export function mapRawConfig(raw: unknown): CircleConfig {
  const wire = decodeRecord(raw, "mapRawConfig", CONFIG_FIELDS, "CircleConfig");
  return {
    members: decodeAddressList(wire.members, "mapRawConfig.members", {
      unique: true,
      maxLength: MAX_CIRCLE_MEMBERS,
    }),
    roundAmount: decodeI128(wire.round_amount, "mapRawConfig.round_amount", { min: 1n }),
    usdcToken: decodeAddress(wire.usdc_token, "mapRawConfig.usdc_token"),
    reputationContract: decodeAddress(
      wire.reputation_contract,
      "mapRawConfig.reputation_contract",
    ),
    roundDeadlineLedgers: decodeU32InRange(
      wire.round_deadline_ledgers,
      "mapRawConfig.round_deadline_ledgers",
      MIN_ROUND_DEADLINE_LEDGERS,
      MAX_ROUND_DEADLINE_LEDGERS,
    ),
  };
}

/**
 * Map a raw `scValToNative` wire object to the typed `RoundState` domain shape,
 * validating every field as it is decoded.
 *
 * @throws `TypeError` if `raw` is not an object, a field is missing, or any
 *   field has the wrong type or an out-of-range value.
 */
export function mapRawRoundState(raw: unknown): RoundState {
  const wire = decodeRecord(raw, "mapRawRoundState", ROUND_FIELDS, "RoundState");
  return {
    roundIndex: decodeU32(wire.round_index, "mapRawRoundState.round_index"),
    recipient: decodeAddress(wire.recipient, "mapRawRoundState.recipient"),
    contributionsReceived: decodeU32InRange(
      wire.contributions_received,
      "mapRawRoundState.contributions_received",
      0,
      MAX_CIRCLE_MEMBERS,
    ),
    deadlineLedger: decodeU64(
      wire.deadline_ledger,
      "mapRawRoundState.deadline_ledger",
    ),
    paidOut: decodeBoolean(wire.paid_out, "mapRawRoundState.paid_out"),
  };
}

const CIRCLE_STATUSES: readonly CircleStatus[] = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
];

/**
 * Validate a value returned by the contract's `get_status` view and narrow it
 * to a {@link CircleStatus}.
 *
 * `CircleStatus` is a `#[contracttype]` enum, and Soroban encodes a unit enum
 * variant as a one-element vector holding its name, which `scValToNative`
 * decodes to `["Active"]`. That wire form and a bare `"Active"` symbol are
 * both accepted. Anything else — an unknown variant, a variant carrying data
 * (`["Active", 1]`), wrong case, or a non-string — throws, so callers are never
 * handed a status that only looks valid.
 *
 * @throws `Error` naming the offending value and listing the valid variants.
 */
export function assertValidCircleStatus(value: unknown): CircleStatus {
  const name =
    Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
      ? value[0]
      : value;
  if (typeof name !== "string" || !CIRCLE_STATUSES.includes(name as CircleStatus)) {
    throw new Error(
      `assertValidCircleStatus: unexpected value ${describeValue(value)}. ` +
        `Expected one of: ${CIRCLE_STATUSES.map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  return name as CircleStatus;
}

// ─── simulateAndRead result ───────────────────────────────────────────────────
//
// A discriminated union returned by the internal `simulateAndRead` helper.
// Using a union here means:
//   1. Callers can never accidentally treat a simulation failure as a valid
//      decoded value — the `ok` flag must be checked before touching `value`.
//   2. The `value` field is typed as `unknown` rather than `any`, forcing
//      every call-site to narrow or explicitly cast, which surfaces
//      mapping errors at compile time rather than silently at runtime.
//   3. Error details (the raw simulation error string) are always available
//      for logging / user-facing messages without a separate try/catch.
//
// Public methods (getConfig, getCurrentRound, …) unwrap this internally and
// either throw a descriptive Error or return the narrowed domain type —
// consumers never see SimulateResult directly.

/** A simulation that returned a decoded return value. */
export interface SimulateSuccess {
  readonly ok: true;
  /** Decoded contract return value. Type is `unknown` — callers must narrow. */
  readonly value: unknown;
}

/** A simulation that produced an error from the Soroban host. */
export interface SimulateFailure {
  readonly ok: false;
  /** Raw error string from the Soroban simulation response. */
  readonly error: string;
}

/** Discriminated union of possible `simulateAndRead` outcomes. */
export type SimulateResult = SimulateSuccess | SimulateFailure;

/**
 * Type-guard — narrows `SimulateResult` to `SimulateSuccess`.
 *
 * @example
 * const result = await simulateAndRead(...);
 * if (isSimulateSuccess(result)) {
 *   const val = result.value as MyExpectedType;
 * }
 */
export function isSimulateSuccess(r: SimulateResult): r is SimulateSuccess {
  return r.ok === true;
}

/**
 * Type-guard — narrows `SimulateResult` to `SimulateFailure`.
 *
 * @example
 * const result = await simulateAndRead(...);
 * if (isSimulateFailure(result)) {
 *   throw new Error(result.error);
 * }
 */
export function isSimulateFailure(r: SimulateResult): r is SimulateFailure {
  return r.ok === false;
}

// ─── Transaction correlation metadata ─────────────────────────────────────────
//
// Caller-supplied observability data that ties a UI action (a button click, an
// HTTP request id, a background-job step) to the on-chain transaction it
// produced.  The SDK echoes it back on every {@link TxResult} and includes it
// in structured tx log events, so a confirmed hash — or a failure — can always
// be traced back to the intent that created it.
//
// ── Correlation is NOT deduplication ──
//
// This metadata is for *tracing*, never for *idempotency*.  It has no effect on
// whether a transaction is submitted, retried, or accepted:
//
//   • Deduplication is the network's job.  A transaction is uniquely identified
//     by its source account + sequence number; resubmitting the same signed
//     transaction yields the RPC status `DUPLICATE`, and the SDK simply keeps
//     polling the existing hash (see `buildAndSend`).  Attaching the same
//     correlation metadata to two calls does **not** make them the same
//     transaction, and attaching different metadata to a retry does **not**
//     make it a new one.
//
//   • Correlation is the caller's label.  Reusing an `operation` id across a
//     retry is exactly how you follow one logical action through several
//     submission attempts; the SDK preserves it verbatim on each attempt's
//     result so the attempts can be grouped in a log aggregator.
//
// If you need an idempotency key, derive it from the transaction itself (source
// + sequence), not from this field.

/**
 * A single JSON-serialisable scalar permitted as a correlation metadata value.
 *
 * Values are restricted to scalars so metadata is always safe to serialise into
 * a log line or a JSON result without depth/cycle concerns, and so a caller
 * cannot accidentally stuff a signed transaction object or a Keypair into it.
 */
export type TxMetadataValue = string | number | boolean | null;

/**
 * Caller-supplied correlation metadata for a write operation.
 *
 * A flat bag of scalar identifiers — e.g.
 * `{ operation: "join-circle", uiRequestId: "req_8a1f", attempt: 1 }`.
 *
 * Passed via the `metadata` option on any mutation (`join`, `contribute`,
 * `payout`, `markDefault`, `close`, `createCircle`) and returned unchanged on
 * the resulting {@link TxResult} — see the section comment above for how this
 * differs from deduplication.
 *
 * The SDK runs every value through {@link sanitizeTxMetadata} before it is
 * attached to a result or emitted in a log, so secrets and signed payloads are
 * stripped even if a caller passes them by mistake.
 */
export interface TxMetadata {
  readonly [key: string]: TxMetadataValue;
}

/** Maximum number of keys retained by {@link sanitizeTxMetadata}. */
const MAX_METADATA_KEYS = 32;

/**
 * Maximum length of a string metadata value.  Anything longer is dropped as a
 * likely signed-XDR / base64 payload rather than a correlation id.
 */
const MAX_METADATA_STRING_LENGTH = 512;

/**
 * A Stellar *secret* seed strkey: 56 chars starting with `S`.  A value matching
 * this is a private key and must never be echoed back or logged, regardless of
 * the key it was stored under.
 */
const STELLAR_SECRET_SEED_RE = /^S[A-Z2-7]{55}$/;

/**
 * Key names that indicate a secret or a signed payload.  Matched
 * case-insensitively as a substring so `signedXdr`, `sourceSecret`,
 * `api_key`, etc. are all caught.
 */
const SECRET_KEY_RE =
  /secret|seed|private|mnemonic|passphrase|password|signed|signature|xdr|api[_-]?key/i;

/**
 * Sanitise caller-supplied correlation metadata into a safe, log-ready shape.
 *
 * Guarantees (this is a security boundary — see {@link TxMetadata}):
 *   1. **No secrets by key name** — any key matching {@link SECRET_KEY_RE}
 *      (`secret`, `seed`, `private`, `signed`, `xdr`, `apiKey`, …) is dropped.
 *   2. **No secrets by value** — any string matching a Stellar secret seed
 *      (`S…`, 56 chars) is dropped even under an innocuous key.
 *   3. **No payloads** — strings longer than
 *      {@link MAX_METADATA_STRING_LENGTH} (likely signed XDR) are dropped.
 *   4. **Scalars only** — objects, arrays, functions, `bigint`, `symbol`, and
 *      `undefined` values are dropped, so a signed transaction object cannot be
 *      smuggled through.
 *   5. **Bounded** — at most {@link MAX_METADATA_KEYS} keys are retained.
 *
 * The input is never mutated.  Returns a frozen object, or `undefined` when the
 * input is not a plain object or nothing survives sanitisation (so an empty
 * `{}` is never attached to a result).
 */
export function sanitizeTxMetadata(input: unknown): TxMetadata | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const out: Record<string, TxMetadataValue> = {};
  let kept = 0;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (kept >= MAX_METADATA_KEYS) break;
    if (SECRET_KEY_RE.test(key)) continue;

    if (typeof value === "string") {
      if (value.length > MAX_METADATA_STRING_LENGTH) continue;
      if (STELLAR_SECRET_SEED_RE.test(value)) continue;
      out[key] = value;
      kept++;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue; // drop NaN / ±Infinity
      out[key] = value;
      kept++;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
      kept++;
    }
    // Everything else (object, array, function, bigint, symbol, undefined) is
    // intentionally dropped — see guarantee 4.
  }

  if (kept === 0) return undefined;
  return Object.freeze(out);
}

// ── Simulation estimates ──────────────────────────────────────────────────────
//
// A Soroban write is simulated before it is assembled and signed; the
// simulation response carries the resource fee and resource usage the network
// will charge for.  The SDK copies the stable, public parts of that response
// into a {@link SimulationEstimate} so integrators can diagnose cost and
// failure without re-simulating.
//
// ── Rules ──
//
//   • Never fabricated.  Every field is optional and is set only when the RPC
//     response actually carried a well-formed value for it.  A missing or
//     malformed field is left `undefined` — never defaulted to `0`.
//   • Never signed material.  The estimate is derived from the *unsigned*
//     simulation response only.  It holds plain numbers and decimal strings —
//     no XDR, no transaction envelope, no auth entries, no signatures, no
//     return value and no keys.
//   • Diagnostic only.  Reading or ignoring the estimate has no effect on
//     submission: the SDK always assembles the transaction from the full
//     simulation response exactly as before.

/**
 * A log-safe summary of the resource and fee estimates returned by a Soroban
 * simulation.
 *
 * | Field | Unit | Source (RPC `simulateTransaction`) |
 * |-------|------|-------------------------------------|
 * | `minResourceFee` | stroops (decimal string) | `minResourceFee` — the minimum resource fee the network will accept; added on top of the inclusion fee when the transaction is assembled. |
 * | `inclusionFee` | stroops (decimal string) | The inclusion (base) fee the SDK set on the transaction before simulating; not an RPC field. |
 * | `cpuInstructions` | CPU instructions (decimal string) | `transactionData.resources.instructions` |
 * | `readBytes` | bytes | `transactionData.resources.readBytes` (`diskReadBytes` on newer protocols) |
 * | `writeBytes` | bytes | `transactionData.resources.writeBytes` |
 * | `readOnlyEntries` | ledger entries | length of the footprint's read-only set |
 * | `readWriteEntries` | ledger entries | length of the footprint's read-write set |
 * | `restoreRequired` | — | `true` when the RPC returned a `restorePreamble` (archived state must be restored first) |
 * | `restoreMinResourceFee` | stroops (decimal string) | `restorePreamble.minResourceFee` |
 * | `latestLedger` | ledger sequence | `latestLedger` — the ledger the simulation ran against |
 *
 * Amounts that are 64-bit on the wire (`minResourceFee`, `inclusionFee`,
 * `cpuInstructions`, `restoreMinResourceFee`) are kept as decimal strings so
 * they never lose precision; convert with `BigInt(...)` when doing arithmetic.
 *
 * A simulation *failure* usually carries only `inclusionFee` and
 * `latestLedger`: the RPC does not report resource usage or a resource fee for
 * a call the host rejected, and the SDK does not invent one.
 *
 * Resource fields are also omitted when the RPC returned no
 * `transactionData` (the Stellar SDK substitutes an all-zero placeholder in
 * that case, which the SDK recognises and does not report as a real
 * estimate).
 */
export interface SimulationEstimate {
  /** Minimum resource fee in stroops, as reported by the simulation. */
  readonly minResourceFee?: string;
  /** Inclusion fee in stroops the SDK set on the transaction before simulating. */
  readonly inclusionFee?: string;
  /** Estimated CPU instructions the invocation consumes. */
  readonly cpuInstructions?: string;
  /** Estimated bytes read from the ledger. */
  readonly readBytes?: number;
  /** Estimated bytes written to the ledger. */
  readonly writeBytes?: number;
  /** Number of ledger entries in the read-only footprint. */
  readonly readOnlyEntries?: number;
  /** Number of ledger entries in the read-write footprint. */
  readonly readWriteEntries?: number;
  /** `true` when archived state must be restored before this call can succeed. */
  readonly restoreRequired?: boolean;
  /** Minimum resource fee in stroops for the required restore, when one is needed. */
  readonly restoreMinResourceFee?: string;
  /** Ledger sequence the simulation ran against. */
  readonly latestLedger?: number;
}

// ── Tx result ─────────────────────────────────────────────────────────────────
//
// A discriminated union so callers can pattern-match on `success` and get
// correct types in each branch — no need to check for optional fields or cast.
//
//   const result = await client.join(keypair, { metadata: { operation: "join" } });
//   if (result.success) {
//     console.log(result.txHash, result.ledger, result.metadata);  // ledger is number here
//   } else {
//     console.error(result.errorMessage);          // errorMessage is string here
//   }

/** A transaction that was confirmed on-chain successfully. */
export interface TxSuccess {
  readonly success: true;
  /** The transaction hash on the Stellar network. */
  readonly txHash: string;
  /** The ledger number in which the transaction was included. */
  readonly ledger: number;
  /**
   * The contract's return value, decoded with `scValToNative`.
   *
   * `undefined` when the invoked method returns `()` or when the RPC response
   * carried no return value.  Typed as `unknown` so call-sites must narrow it
   * through one of the `decode*` helpers — see
   * {@link decodeAddress}, {@link decodeU32}, {@link decodeBigInt}.
   */
  readonly returnValue?: unknown;
  /**
   * Correlation metadata supplied by the caller on the originating write, echoed
   * back verbatim (after {@link sanitizeTxMetadata}).  `undefined` when the
   * caller supplied none or nothing survived sanitisation.  Use it to tie this
   * confirmed `txHash` back to the UI action that produced it.
   */
  readonly metadata?: TxMetadata;
  /**
   * Resource and fee estimates from the simulation that preceded submission.
   * `undefined` when the simulation response carried none of the documented
   * fields.  See {@link SimulationEstimate} for units.
   */
  readonly estimate?: SimulationEstimate;
}

/**
 * Machine-readable error category for a {@link TxFailure}.
 *
 * | Code | When it fires | Safe to retry? |
 * |------|---------------|----------------|
 * | `"invalid_argument"` | The call was rejected by SDK-side validation before any network I/O. | No — fix the inputs. |
 * | `"account_not_found"` | The source account does not exist on the network. | No — fund the account first. |
 * | `"simulation_failed"` | The Soroban simulation rejected the invocation (contract panic / validation). | No — the state or inputs are wrong. |
 * | `"network_error"` | A network-level fetch failure before or during submission. | Yes. |
 * | `"try_again_later"` | The RPC accepted the request but is currently congested (`status === "TRY_AGAIN_LATER"`). | Yes — resubmit. |
 * | `"tx_rejected"` | The transaction was submitted but immediately rejected (`status === "ERROR"`). | Yes, after rebuilding. |
 * | `"tx_failed"` | The transaction was included in a ledger but its status is FAILED. | No — it ran and failed on-chain. |
 * | `"stale_rpc"` | The RPC stopped advancing its ledger while the transaction was pending. | Yes — against a healthy RPC. |
 * | `"stale_state"` | An opt-in write preflight found the on-chain state had moved past the caller's expected state, so the submission would predictably fail. | No — refresh state and rebuild. |
 * | `"timeout"` | Confirmation polling exceeded the timeout window. | Check the hash before retrying. |
 * | `"outcome_unknown"` | The write may or may not have been applied: the submission got no answer, or connectivity was lost while confirming. `diagnostics` says what is known. | No — look up `txHash` first. |
 * | `"tx_expired"` | The RPC closed a ledger past the transaction's time bound without including it, so it was never applied. | Yes, after rebuilding. |
 * | `"unknown"` | An unclassified error (should not normally occur). | Unknown. |
 *
 * Use this field to branch on the error type without parsing `errorMessage`
 * strings — e.g. show a wallet-funding prompt on `"account_not_found"` or a
 * "check your inputs" banner on `"simulation_failed"`.
 *
 * The codes that mean "this transaction may still be in flight"
 * (`"timeout"`, `"stale_rpc"`, `"outcome_unknown"`) carry the transaction
 * hash, so callers can look the transaction up (see
 * `CircleUpClient.lookupTransaction`) before resubmitting rather than risk
 * applying the write twice. `"network_error"` is only returned when the
 * request provably never reached the RPC.
 */
export type TxErrorCode =
  | "invalid_argument"
  | "account_not_found"
  | "simulation_failed"
  | "network_error"
  | "try_again_later"
  | "tx_rejected"
  | "tx_failed"
  | "tx_expired"
  | "stale_rpc"
  | "stale_state"
  | "timeout"
  | "outcome_unknown"
  | "unknown";

/**
 * What the SDK knows about a write whose outcome it could not settle, attached
 * to a `TxFailure` with `errorCode: "outcome_unknown"`.
 *
 * The SDK never rebuilds a write in this state, because a rebuilt transaction
 * uses the next sequence number and would apply the write a second time if
 * the original was accepted. Look `txHash` up instead; only a not-found result
 * observed after `validUntil` proves the original was never applied.
 */
export interface SubmissionDiagnostics {
  /** Hash of the signed envelope — computed locally, so present even if the RPC never answered. */
  readonly txHash: string;
  /**
   * `"accepted"` — the RPC queued the transaction (PENDING / DUPLICATE) but its
   * confirmation was not observed. `"unknown"` — no submission response was
   * received (or only a rejection of a resend), so delivery is unconfirmed.
   */
  readonly submission: "accepted" | "unknown";
  /** `sendTransaction` attempts made with this one envelope. */
  readonly sendAttempts: number;
  /**
   * Result of the follow-up lookups by hash: `"not_found"` if at least one
   * lookup answered NOT_FOUND, `"failed"` if every lookup errored, and
   * `"not_attempted"` if the budget ran out before any lookup.
   */
  readonly lookup: "not_found" | "failed" | "not_attempted";
  /** Latest ledger the RPC reported during the lookups, when known. */
  readonly latestLedger?: number;
  /** Unix time (seconds) after which the transaction can no longer be included. */
  readonly validUntil?: number;
  /** The last network error observed, already formatted for display. */
  readonly lastError?: string;
}

/** The result of `CircleUpClient.lookupTransaction`. */
export type TxLookup =
  | {
      readonly status: "success";
      readonly txHash: string;
      readonly ledger: number;
      /** Decoded contract return value, `undefined` when absent or undecodable. */
      readonly returnValue?: unknown;
      readonly latestLedger?: number;
      readonly latestLedgerCloseTime?: number;
    }
  | {
      readonly status: "failed";
      readonly txHash: string;
      readonly ledger: number;
      readonly latestLedger?: number;
      readonly latestLedgerCloseTime?: number;
    }
  | {
      /** Not (yet) included. Definitive only once `latestLedgerCloseTime` is past the transaction's time bound. */
      readonly status: "not_found";
      readonly txHash: string;
      readonly latestLedger?: number;
      readonly latestLedgerCloseTime?: number;
    };

/**
 * One field of on-chain state that has diverged from the value a caller
 * expected, as detected by the opt-in write preflight (issue #347).
 *
 * `expected` is what the caller's UI/decision was based on; `actual` is the
 * freshly-read chain value.  A non-empty list of these is what makes a stale
 * submission *predictable* — e.g. `{ field: "roundIndex", expected: 2,
 * actual: 3 }` means the round advanced after the caller loaded the page.
 */
export interface StateMismatch {
  /** Which comparable state field diverged. */
  readonly field:
    | "status"
    | "roundIndex"
    | "contributionsReceived"
    | "hasContributed"
    | "paidOut";
  /** The value the caller expected (from their snapshot). */
  readonly expected: string | number | boolean;
  /** The value freshly read from the chain at preflight time. */
  readonly actual: string | number | boolean;
}

/** A transaction that failed to submit, was rejected, or timed out. */
export interface TxFailure {
  readonly success: false;
  /**
   * The transaction hash, if the transaction reached the network before
   * failing. Empty string when the failure occurred before submission (e.g.
   * simulation error or user rejection).
   */
  readonly txHash: string;
  /** Human-readable description of what went wrong. */
  readonly errorMessage: string;
  /**
   * Machine-readable error category.  Use this to branch on error type in
   * UI logic without parsing the `errorMessage` string.
   *
   * @see {@link TxErrorCode} for the full list of codes and their meanings.
   */
  readonly errorCode: TxErrorCode;
  /**
   * Correlation metadata supplied by the caller on the originating write, echoed
   * back verbatim (after {@link sanitizeTxMetadata}).  Present on failures too,
   * so a failed attempt — including one that will be retried — can be tied back
   * to the same UI action as its eventual success.  `undefined` when the caller
   * supplied none or nothing survived sanitisation.
   */
  readonly metadata?: TxMetadata;
  /**
   * Resource and fee estimates from the simulation, when the write got that
   * far.  Absent for failures that happen before simulation (invalid
   * arguments, missing account, simulation network errors).  On
   * `"simulation_failed"` it usually carries only `inclusionFee` and
   * `latestLedger`.  See
   * {@link SimulationEstimate} for units.
   */
  readonly estimate?: SimulationEstimate;
  /** Present when errorCode is "stale_state". Lists the mismatched fields. */
  readonly mismatches?: readonly StateMismatch[];
  /** Present when errorCode is "outcome_unknown". See {@link SubmissionDiagnostics}. */
  readonly diagnostics?: SubmissionDiagnostics;
}

/** Discriminated union of all possible transaction outcomes. */
export type TxResult = TxSuccess | TxFailure;

/**
 * Type-guard — narrows `TxResult` to `TxSuccess`.
 *
 * @example
 * const res = await circleClient.join(keypair);
 * if (isTxSuccess(res)) {
 *   console.log(`Confirmed in ledger ${res.ledger}`);
 * }
 */
export function isTxSuccess(result: TxResult): result is TxSuccess {
  return result.success === true;
}

/**
 * Type-guard — narrows `TxResult` to `TxFailure`.
 *
 * @example
 * const res = await circleClient.contribute(keypair);
 * if (isTxFailure(res)) {
 *   alert(res.errorMessage);
 * }
 */
export function isTxFailure(result: TxResult): result is TxFailure {
  return result.success === false;
}

/**
 * Returns true when a failed transaction is safe to retry without risk of
 * duplication or wasted funds.
 *
 * Conservative classification:
 * - Retryable: the SDK knows the write was not applied — the request never
 *   reached the RPC, the RPC refused it, or it expired unincluded.
 * - NOT retryable: validation failures, confirmed on-chain failures, and every
 *   outcome where the write may already have been applied.
 *
 * For `"timeout"`, `"stale_rpc"`, and `"outcome_unknown"` the transaction may
 * still be in flight; look the hash up (`lookupTransaction`) before resubmitting.
 *
 * @example
 * const result = await client.contribute(keypair);
 * if (isTxFailure(result) && isRetryable(result)) {
 *   // safe to resubmit
 * }
 */
export function isRetryable(result: TxFailure): boolean {
  switch (result.errorCode) {
    case "network_error":
    case "try_again_later":
    case "tx_rejected":
    case "tx_expired":
      return true;
    // timeout / stale_rpc / outcome_unknown: tx may be in flight — check the
    // hash first. NOT automatically retryable to prevent blind duplication.
    case "timeout":
    case "stale_rpc":
    case "outcome_unknown":
    case "invalid_argument":
    case "account_not_found":
    case "simulation_failed":
    case "tx_failed":
    case "unknown":
    default:
      return false;
  }
}


// ─── Indexer REST API models ───────────────────────────────────────────────────
//
// These types describe the JSON shapes returned by the CircleUp indexer API.
// They use snake_case field names and string-serialised amounts (stroops) to
// match the database rows directly, unlike the contract types above which use
// camelCase and bigint.
//
// Consumers should convert stroops strings to bigint / display strings via the
// helpers in sdk/src/utils.ts (formatUsdc, stroopsToUsdc, usdcToStroops).

/**
 * All lifecycle states a circle can be in, as returned by the indexer.
 *
 * The first four mirror the on-chain `CircleStatus` Rust enum.  `"Closed"` is
 * an indexer-only projection: the contract records closure as a boolean flag
 * (`DataKey::Closed`) and the indexer surfaces it as a status string so
 * callers can filter or count fully-settled circles via the REST API.
 */
export type ApiCircleStatus =
  | "Pending"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "Closed";

/**
 * A single circle row as returned by GET /circles and GET /circles/:address.
 * `round_amount` is in stroops, serialised as a string.
 */
export interface ApiCircleRow {
  address: string;
  creator: string;
  /** Per-member contribution per round, in stroops (string-serialised). */
  round_amount: string;
  member_count: number;
  status: ApiCircleStatus;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
  updated_at: string;
  /**
   * Only present in the single-circle detail response
   * (GET /circles/:address). Computed server-side from created_ledger and
   * round_deadline_ledgers; null when the circle is not Active or when the
   * data is unavailable.
   */
  deadline_ledger?: number | null;
  /** Round deadline window, in ledgers (sourced from the contract config). */
  round_deadline_ledgers?: number | null;
}

/**
 * A member record as returned by GET /circles/:address and
 * GET /circles/:address/members.
 * `collateral` is in stroops (string-serialised).
 *
 * # Invariants
 *
 * - `payout_order` is the 0-based position in the configured rotation order.
 *   Round `i` pays the member with `payout_order === i`.  This is fixed at
 *   circle creation time and never changes.
 * - `join_order` is the 1-based position in the actual join sequence (who
 *   joined first, second, etc.).  `null` for circles indexed before migration
 *   004 (the field is nullable by design for backward compatibility).
 * - `collateral` is the USDC amount locked at join time in stroops.  `"0"` for
 *   members who have not yet joined (pre-join placeholder rows).
 * - `defaults` is the total number of rounds this member has missed.
 */
export interface ApiMemberRow {
  member_address: string;
  payout_order: number;
  /**
   * 1-based position in the join queue (1 = first to join, N = last / triggers Active).
   * `null` for rows created before migration 004 or members who have not joined.
   */
  join_order: number | null;
  /** Locked collateral, in stroops (string-serialised). */
  collateral: string;
  defaults: number;
  joined_at: string | null;
  /** Reputation score aggregated by the reputation contract (0–100). */
  reputation_score: number;
  /**
   * Total number of contributions this member has made across all rounds of
   * this circle. Used to derive whether they have contributed to the current
   * active round.
   */
  total_contributions: number;
}

/**
 * A single contribution record within a round.
 * `amount` is in stroops (string-serialised).
 */
export interface ApiContributionRecord {
  member_address: string;
  /** Contribution amount, in stroops (string-serialised). */
  amount: string;
  tx_hash: string;
}

/**
 * A single default record within a round.
 * `penalty` is in stroops (string-serialised).
 */
export interface ApiDefaultRecord {
  member_address: string;
  /** Penalty deducted from collateral, in stroops (string-serialised). */
  penalty: string;
}

/**
 * Lifecycle phase of a single round as reconciled by the indexer.
 *
 * | Value       | Meaning |
 * |-------------|---------|
 * | `"completed"` | A payout row exists for this round — it has been paid out. |
 * | `"current"`   | The active in-progress round (Active circle, no payout yet). |
 * | `"cancelled"` | The current round of a Cancelled circle (no payout will occur). |
 * | `"open"`      | An unpaid round that has recorded contributions and/or defaults but is not the current round (reorg / partial-ingest edge case). |
 *
 * Payout presence always wins: a round whose `round_index` has a payout row
 * is always `"completed"`, regardless of the circle's `current_round` cursor.
 *
 * @see RoundPhase in sdk/src/types.ts (read-model section)
 * @see groupCircleRounds in indexer/src/groupRounds.ts (status resolution)
 */
export type ApiRoundPhase = "completed" | "current" | "cancelled" | "open";

/**
 * A round row as returned by GET /circles/:address/rounds.
 *
 * Every round the indexer has observed is included exactly once, with a
 * `status` field that identifies its lifecycle phase. Previously the `status`
 * was computed inside the indexer but omitted from the wire format, requiring
 * clients to infer it from context (presence of a payout, circle status, etc.).
 * It is now part of the public API contract (issue #529).
 *
 * Monetary amounts are in stroops, serialised as strings.
 */
export interface ApiRoundRow {
  roundIndex: number;
  /**
   * Lifecycle phase of this round.
   *
   * Clients should branch on this field rather than inferring phase from the
   * presence/absence of `recipient`, `amount`, or `txHash`:
   *   - `"completed"` — payout fields are populated.
   *   - `"current"` / `"cancelled"` — payout fields are `null`; this is the
   *     live round. Returned as `currentRound` in the response envelope.
   *   - `"open"` — payout fields are `null`; unpaid round with activity.
   *     Returned in `openRounds`.
   */
  status: ApiRoundPhase;
  /** Payout recipient (G…); `null` until the round is paid out. */
  recipient: string | null;
  /** Pot paid out, in stroops (string-serialised); `null` until the round is paid out. */
  amount: string | null;
  /** Payout transaction hash; `null` until the round is paid out. */
  txHash: string | null;
  /** Ledger sequence of the payout; `null` until the round is paid out. */
  ledger?: number | null;
  contributions: ApiContributionRecord[];
  defaults: ApiDefaultRecord[];
}

// ─── Indexer API response envelopes ───────────────────────────────────────────

/**
 * Pagination envelope returned by the indexer's paged list endpoints
 * (`GET /circles`, `GET /members/:member/contributions`).
 *
 * `page` and `limit` echo the values the server applied (its defaults when the
 * request omitted them); `IndexerClient` checks the echo against what it asked
 * for, so a page is never silently returned in place of another.
 */
export interface IndexerPagination {
  /** 1-based page number the server returned. */
  page: number;
  /** Page size the server applied. */
  limit: number;
  /** Total rows matching the filters, across all pages. */
  total: number;
  /** Number of pages at this `limit`; `0` when `total` is `0`. */
  totalPages: number;
  /** `page < totalPages`. Sent by `/members/:member/contributions` only. */
  hasMore?: boolean;
}

/** Columns `GET /circles` can sort by. */
export type CircleSortField =
  | "created_ledger"
  | "updated_at"
  | "round_amount"
  | "member_count"
  | "status";

/**
 * Query parameters accepted by `GET /circles`.
 *
 * All fields are optional; the indexer's defaults apply when omitted:
 *   - `status`  — no filter (all statuses returned)
 *   - `sort`    — `"created_ledger"`
 *   - `order`   — `"desc"`
 *   - `page`    — `1`
 *   - `limit`   — `20` (`INDEXER_DEFAULT_PAGE_SIZE`)
 *
 * `IndexerClient` validates these before sending the request: an unknown key,
 * a value outside the indexer's accepted set, or a `limit` outside
 * `1..INDEXER_MAX_PAGE_SIZE` rejects locally with a `RangeError` rather than
 * being dropped or turned into an HTTP 400.
 */
export interface GetCirclesParams {
  /**
   * Restrict results to circles in this lifecycle state.
   * `"Closed"` is an indexer-only projection (not a contract enum variant).
   */
  status?: ApiCircleStatus;
  /** Column to sort results by. */
  sort?: CircleSortField;
  /** Sort direction. */
  order?: "asc" | "desc";
  /** 1-based page number. */
  page?: number;
  /** Results per page (1–100). */
  limit?: number;
}

/**
 * Query parameters accepted by `GET /members/:member/contributions`.
 * Validated locally like {@link GetCirclesParams}.
 */
export interface GetMemberContributionsParams {
  /** Restrict results to one circle (a G… or C… address). */
  circle?: string;
  /** 1-based page number. Defaults to `1`. */
  page?: number;
  /** Results per page (1–100). Defaults to `20`. */
  limit?: number;
}

/**
 * Bound on an aggregating helper such as `IndexerClient.iterateCircles`.
 * Every aggregating helper stops after `maxPages` pages, so none fetches an
 * unbounded result set by default.
 */
export interface PaginateOptions {
  /** Maximum number of pages to fetch (1–1000). Defaults to `10`. */
  maxPages?: number;
}

/** Response body for GET /circles */
export interface ApiCirclesListResponse {
  circles: ApiCircleRow[];
  /**
   * Pagination metadata returned by the indexer.
   * Present on all responses; callers should use `total` and `totalPages` for
   * building pagination controls.
   */
  pagination: IndexerPagination;
}

/** Response body for GET /circles/:address */
export interface ApiCircleDetailResponse {
  circle: ApiCircleRow;
  members: ApiMemberRow[];
  /** Latest ledger processed by the indexer; used for deadline countdown math. */
  latestLedger: number | null;
}

/** Response body for GET /circles/:address/members */
export interface ApiMembersResponse {
  members: ApiMemberRow[];
}

/** Response body for GET /circles/:address/rounds */
export interface ApiRoundsResponse {
  /**
   * Completed rounds (status `"completed"`), sorted ascending by `roundIndex`.
   * Every entry has `status: "completed"` and populated payout fields.
   */
  rounds: ApiRoundRow[];
  /**
   * Unpaid non-current rounds that have contributions and/or defaults recorded
   * (reorg / partial-ingest edge case, issue #170). Every entry has
   * `status: "open"`.
   */
  openRounds: ApiRoundRow[];
  /** Defaults that belong to a round not yet paid out. */
  pendingDefaults: ApiDefaultRecord[];
  /**
   * The in-progress round (status `"current"` or `"cancelled"`), returned
   * alongside the history so clients can show live contribution status without
   * a second request. `null` when the circle is not Active or Cancelled, or
   * when the indexer has not yet processed the current round.
   *
   * The `status` field on this object is always `"current"` or `"cancelled"`.
   */
  currentRound: ApiRoundRow | null;
}

/**
 * Composite response body for the circle detail page, merging
 * `GET /circles/:address` and `GET /circles/:address/rounds` into a single
 * typed contract. Used by the app's server component and client refresh path.
 */
export interface ApiCircleDetailWithRoundsResponse {
  /** Core circle state and member roster from GET /circles/:address. */
  circle: ApiCircleRow;
  /** Member roster from GET /circles/:address. */
  members: ApiMemberRow[];
  /** Latest ledger the indexer has processed; used for deadline countdown. */
  latestLedger: number | null;
  /**
   * Completed rounds (status `"completed"`) from GET /circles/:address/rounds,
   * sorted ascending by `roundIndex`. All entries have `status: "completed"`.
   */
  rounds: ApiRoundRow[];
  /**
   * Unpaid rounds with activity that are not the current round (issue #170).
   * All entries have `status: "open"`.
   */
  openRounds: ApiRoundRow[];
  /** Pending defaults not yet associated with a payout round. */
  pendingDefaults: ApiDefaultRecord[];
  /**
   * The in-progress round containing live contribution data; `null` when the
   * circle is not Active or Cancelled, or when the indexer has not yet
   * processed this round. The `status` field is always `"current"` or
   * `"cancelled"`.
   */
  currentRound: ApiRoundRow | null;
}

/** Response body for GET /reputation/:member */
export interface ApiReputationResponse {
  member: string;
  /**
   * `true` when a reputation row exists for this member in the database.
   * `false` means the member has no recorded activity; `score` may be `0` or `null`.
   * Lets clients distinguish an explicit zero from a member not yet seen.
   */
  found: boolean;
  score: number | null;
  /** Optional diagnostic or explanatory detail message. */
  detail?: string;
  contributions: Array<{
    circle_address: string;
    /** Number of rounds the member has contributed in this circle. */
    contributions: number;
    total_rounds: number;
  }>;
  defaults: Array<{
    circle_address: string;
    /** Number of rounds the member has defaulted in this circle. */
    count: number;
  }>;
  events?: Array<{
    type: string;
    delta: number;
  }>;
  updatedAt: string | null;
}

/**
 * A single row from GET /members/:member/contributions.
 * Amounts are in stroops (string-serialised).
 */
export interface ApiMemberContributionRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

/** Response body for GET /members/:member/contributions */
export interface ApiMemberContributionsResponse {
  member: string;
  /** Circle filter applied, or null when returning history across all circles. */
  circle: string | null;
  contributions: ApiMemberContributionRow[];
  /**
   * Sum of `amount` over every matching row (all pages, not just this one),
   * in stroops (string-serialised).
   */
  totalAmount?: string;
  pagination: IndexerPagination;
}

/** Response body for GET /health */
export interface ApiHealthResponse {
  status: "ok";
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Indexer read models (issue #342)
// ═══════════════════════════════════════════════════════════════════════════
//
// Shared, typed views of the indexer REST responses. RPC values and indexer
// responses diverge in field names, numeric representation, and optionality;
// these models give consumers one shape per resource that makes explicit the
// two things raw JSON does not encode:
//
//   • Units — every monetary field is in **stroops**, the canonical integer
//     unit (1 USDC = 10,000,000 stroops = STROOPS_PER_USDC). Amounts are typed
//     `string` because a pot can exceed Number.MAX_SAFE_INTEGER. Convert to
//     display units only at render time. No field below is a display-unit number.
//   • Missing data — every value the indexer can omit or leave unresolved is
//     explicitly `T | null`, never an implicit `undefined` or a silent `0`.
//
// Numeric representation rules applied throughout:
//   • Monetary amounts (stroops) and on-chain u64 ledger sequences → `string`.
//   • Counts, round indices and order positions (bounded, small) → `number`.
//   • Timestamps → ISO-8601 `string`.

/** Lifecycle phase of a single round, as reconciled by the indexer. */
export type RoundPhase = ApiRoundPhase;

/**
 * Compact per-circle model for list views (`GET /circles`).
 */
export interface CircleSummary {
  /** Circle contract address (C…). */
  address: string;
  /** Address that created the circle. */
  creator: string;
  /** Per-round contribution amount, in **stroops** (string). */
  roundAmount: string;
  /** Number of member slots configured in the circle. */
  memberCount: number;
  /** Circle lifecycle status. */
  status: CircleStatus;
  /** 0-based index of the round currently in progress. */
  currentRound: number;
  /** Total number of rounds the circle runs (one payout per member). */
  totalRounds: number;
  /** Ledger sequence at which the circle was created (u64 → string). */
  createdLedger: string;
  /** ISO-8601 timestamp of the most recent indexer update to this circle. */
  updatedAt: string;
}

/**
 * Per-member status within a circle (`GET /circles/:address/members`, and the
 * `members` array of the circle-detail response).
 */
export interface MemberStatus {
  /** Member account address (G…). */
  memberAddress: string;
  /** Member's position in the payout rotation, as recorded by the indexer. */
  payoutOrder: number;
  /** Collateral locked by this member, in **stroops** (string). */
  collateral: string;
  /** Number of rounds in which this member has defaulted. */
  defaults: number;
  /** On-chain reputation score; `null` when the member has no reputation record yet. */
  reputationScore: number | null;
  /**
   * Total contributions this member has made across the circle (string).
   * `null` when the source view omits it — the circle-detail endpoint does not
   * include per-member contribution totals.
   */
  totalContributions: string | null;
}

/**
 * Full per-circle model for detail views (`GET /circles/:address`).
 * Extends {@link CircleSummary} with the roster, deadline data, and the
 * indexer's latest processed ledger for staleness checks.
 */
export interface CircleDetail extends CircleSummary {
  /**
   * Number of ledgers a round stays open for contributions (the deadline
   * window), u64 → string. `null` for circles indexed before this field was
   * tracked.
   */
  roundDeadlineLedgers: string | null;
  /**
   * Absolute ledger sequence by which the current round must be funded.
   * `null` when there is no active round or the indexer cannot resolve it.
   */
  deadlineLedger: number | null;
  /** Full member roster with per-member status. */
  members: MemberStatus[];
  /**
   * Latest ledger height the indexer has processed, enabling staleness checks.
   * `null` when the indexer has not recorded any ledger yet.
   */
  latestLedger: number | null;
}

/** A single contribution row nested inside a {@link RoundStatus}. */
export interface RoundContribution {
  /** Contributing member (G…). */
  memberAddress: string;
  /** Contribution amount, in **stroops** (string). */
  amount: string;
  /** Contribution transaction hash. */
  txHash: string;
  /** Ledger sequence of the contribution (u64 → string). */
  ledger: string;
}

/** A single default row nested inside a {@link RoundStatus}. */
export interface RoundDefault {
  /** Defaulting member (G…). */
  memberAddress: string;
  /** Penalty applied for the default, in **stroops** (string). */
  penalty: string;
  /** Default-record transaction hash. */
  txHash: string;
  /** Ledger sequence of the default record (u64 → string). */
  ledger: string;
}

/**
 * Reconciled status of a single round (`GET /circles/:address/rounds`).
 * The payout fields are all populated together once the round completes and
 * are `null` beforehand.
 */
export interface RoundStatus {
  /** 0-based round index. */
  roundIndex: number;
  /** Lifecycle phase of this round. */
  status: RoundPhase;
  /** Payout recipient (G…); `null` until the round is paid out. */
  recipient: string | null;
  /** Payout amount, in **stroops** (string); `null` until the round is paid out. */
  amount: string | null;
  /** Payout transaction hash; `null` until the round is paid out. */
  txHash: string | null;
  /** Ledger sequence of the payout (u64 → string); `null` until paid out. */
  ledger: string | null;
  /** Contributions recorded for this round. */
  contributions: RoundContribution[];
  /** Defaults recorded for this round. */
  defaults: RoundDefault[];
}

/** A single settled payout inside a {@link PayoutHistory}. */
export interface PayoutRecord {
  /** 0-based index of the round this payout settled. */
  roundIndex: number;
  /** Payout recipient (G…). */
  recipient: string;
  /** Payout amount, in **stroops** (string). */
  amount: string;
  /** Payout transaction hash. */
  txHash: string;
  /** Ledger sequence of the payout (u64 → string). */
  ledger: string;
  /** ISO-8601 timestamp of the payout. */
  settledAt: string;
}

/** Chronological payout history for a circle, one entry per completed round. */
export interface PayoutHistory {
  /** Circle these payouts belong to (C…). */
  circleAddress: string;
  /** Payout records, oldest-first by round index. */
  payouts: PayoutRecord[];
}

// ─── Audit events (Issue: add audit events for close and cancelled transitions) ──

/**
 * Event type for a circle's terminal lifecycle audit row.
 *
 * - `"cancelled"` — emitted when a circle is cancelled while Pending
 *   (`circle/cancelled` event).
 * - `"closed"` — emitted when collateral is settled and released
 *   (`circle/closed` event, triggered after Completed or Cancelled).
 */
export type AuditEventType = "cancelled" | "closed";

/**
 * A single structured audit record for a terminal lifecycle transition.
 *
 * Stored in the `circle_audit_events` table by the indexer's
 * `handleCircleCancelled` and `handleCircleClosed` handlers.  The fields
 * carry the full event payload so the close/cancel context (who triggered it,
 * amounts involved, penalties forfeited) is durable and queryable without
 * replaying the event log.
 *
 * Monetary amounts are string-serialised stroops to preserve precision.
 */
export interface AuditEvent {
  /** Auto-increment PK from the database. */
  id: number;
  /** Circle contract address (C…). */
  circle_address: string;
  /** Type of the terminal transition that produced this record. */
  event_type: AuditEventType;
  /**
   * Address that triggered the transition.
   * - For `"cancelled"`: the member who called `cancel()`.
   * - For `"closed"`: the member who called `close()`.
   * `null` if the event payload did not include a caller field.
   */
  triggered_by: string | null;
  /**
   * On-chain ledger sequence at the time of the transition.
   * Serialised as a string because ledger sequences are u64 on-chain and can
   * exceed `Number.MAX_SAFE_INTEGER` at very high ledger counts.
   * `null` when the indexer could not extract the ledger from the event.
   */
  ledger: string | null;
  /**
   * Transaction hash that produced the event.
   * `null` when not available from the RPC event response.
   */
  tx_hash: string | null;
  /**
   * Total USDC stroops returned to members at close time (string).
   * `null` for `"cancelled"` rows (no amounts are released at cancellation —
   * they are released when `close()` is subsequently called).
   */
  total_released: string | null;
  /**
   * What total_released would have been with zero penalties (string).
   * Used to compute forfeited collateral: `total_expected - total_released`.
   * `null` for `"cancelled"` rows and when the event payload omitted the field.
   */
  total_expected_collateral: string | null;
  /**
   * Close reason symbol — `"completed"` or `"cancelled"` — copied from the
   * contract event.  Tells the indexer and UI whether the collateral was
   * released after a successful completion or an abandoned circle.
   * `null` for `"cancelled"` event rows (no reason is recorded at cancel time;
   * only the subsequent `close` carries the reason).
   */
  close_reason: string | null;
  /** ISO-8601 timestamp of when this audit record was written to the database. */
  created_at: string;
}

/** Response body for `GET /circles/:address/audit`. */
export interface ApiAuditEventsResponse {
  /** Circle contract address the audit records belong to (C…). */
  circle_address: string;
  /**
   * Audit records for terminal lifecycle transitions, ordered by `created_at`
   * ascending (oldest first).  An empty array means no terminal transitions
   * have been indexed yet for this circle.
   */
  events: AuditEvent[];
}
