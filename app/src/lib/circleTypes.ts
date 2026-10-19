// ΓöÇΓöÇΓöÇ Shared typed response contracts for circle API data (Issue #513) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
//
// This module is the single authoritative source of type definitions and
// runtime validators for every indexer API response consumed by the app.
//
// DESIGN RATIONALE
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// The app package does not take a runtime dependency on @circleup/sdk so that
// the Next.js bundle stays lean and independent of the SDK's Node-only
// internals (Stellar SDK, Buffer polyfills, etc.). However, types defined in
// sdk/src/types.ts ARE the canonical source of truth for every API shape ΓÇö
// this file mirrors them under app-friendly names and adds runtime validators
// so the boundary between untrusted JSON and typed domain objects is enforced
// consistently across all fetch call sites (page.tsx, CircleDetailClient,
// ReputationClient, etc.).
//
// INVARIANT: whenever sdk/src/types.ts changes an Api* interface, the
// corresponding type alias or validator here must be kept in sync. Each alias
// carries a @see JSDoc tag pointing back to the canonical SDK type.
//
// NAMING CONVENTION
// ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// App-layer names are kept intentionally close to the SDK names so a grep for
// "ApiCircleRow" finds both files.  Where the app previously used a shorter
// alias (e.g. `Circle` instead of `ApiCircleRow`) the legacy alias is
// preserved as a re-export to avoid a big rename churn in consumers.
//
// UNITS
// ΓöÇΓöÇΓöÇΓöÇΓöÇ
// All monetary amounts are in stroops (1 USDC = 10 000 000 stroops), serialised
// as strings to survive JavaScript's Number.MAX_SAFE_INTEGER limit.  Convert
// to display units only at render time using formatUsdc / formatPot from
// lib/config.ts.

import { isCanonicalStellarAddress } from "@/lib/address";
import { isStellarPublicKey, hasValidStrKeyChecksum } from "@/lib/address";

// ΓöÇΓöÇΓöÇ Status values ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * All lifecycle states a circle can be in, as returned by the indexer.
 * The first four mirror the on-chain CircleStatus Rust enum; "Closed" is an
 * indexer-only projection (contract records this as a DataKey::Closed boolean).
 *
 * @see ApiCircleStatus in sdk/src/types.ts
 */
export type CircleApiStatus =
  | "Pending"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "Closed";

/** All recognised status values as a frozen tuple ΓÇö use for runtime membership checks. */
export const CIRCLE_API_STATUSES = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
  "Closed",
] as const;

/** Returns true when `value` is a recognised CircleApiStatus string. */
export function isCircleApiStatus(value: unknown): value is CircleApiStatus {
  return (
    typeof value === "string" &&
    (CIRCLE_API_STATUSES as readonly string[]).includes(value)
  );
}

export const CIRCLE_STATUS_OPTIONS = CIRCLE_API_STATUSES;
export type CircleStatusFilter = CircleApiStatus;
export const isValidStatusFilter = isCircleApiStatus;

/** Returns true when `url` is a valid http or https URL. */
export function isValidUrl(url: string): boolean {
  if (!url || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ProtocolGuarantee {
  emoji: string;
  title: string;
  desc: string;
}

export const PROTOCOL_GUARANTEES: readonly ProtocolGuarantee[] = [
  {
    emoji: "≡ƒöÆ",
    title: "No rug-pulls",
    desc: "The smart contract holds all funds until payout. No single member or organizer can withdraw money prematurely.",
  },
  {
    emoji: "≡ƒöä",
    title: "Deterministic rotation",
    desc: "Payout order and rotation schedule are fixed on-chain upon circle creation and cannot be tampered with.",
  },
  {
    emoji: "≡ƒ¢í∩╕Å",
    title: "Collateral-backed defaults",
    desc: "Members lock collateral upfront. If anyone defaults on a round, their collateral compensates affected members.",
  },
  {
    emoji: "Γ¡É",
    title: "On-chain reputation",
    desc: "Successful contributions build an immutable reputation score across circles on the Stellar network.",
  },
] as const;

export type BrowseState =
  | { kind: "browse"; count: number }
  | { kind: "empty" }
  | { kind: "unavailable" };

/**
 * Decides what the hero's secondary call-to-action should offer.
 */
export function getBrowseState(
  result: { ok: boolean; circles?: unknown[]; total?: number } | null,
): BrowseState {
  if (!result || !result.ok) return { kind: "unavailable" };
  const total =
    typeof result.total === "number"
      ? result.total
      : Array.isArray(result.circles)
        ? result.circles.length
        : 0;
  if (total === 0) return { kind: "empty" };
  return { kind: "browse", count: total };
}

// ΓöÇΓöÇΓöÇ Circle row (list + detail) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * A single circle row as returned by GET /circles and GET /circles/:address.
 * `round_amount` is in stroops, serialised as a string.
 *
 * @see ApiCircleRow in sdk/src/types.ts
 */
export interface CircleRow {
  address: string;
  creator: string;
  /** Per-member contribution per round, in stroops (string-serialised). */
  round_amount: string;
  member_count: number;
  status: CircleApiStatus;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
  updated_at: string;
  /**
   * Only present in the single-circle detail response (GET /circles/:address).
   * Null when the circle is not Active or the data is unavailable.
   */
  deadline_ledger?: number | null;
  /** Round deadline window, in ledgers (from the contract config). */
  round_deadline_ledgers?: number | null;
}

/**
 * Legacy alias kept so components that imported `Circle` from CircleCard.tsx
 * or circleTypes.ts can continue to compile without renaming every reference.
 *
 * @see CircleRow
 */
export type Circle = CircleRow;

// ΓöÇΓöÇΓöÇ Member row ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * A member record as returned by GET /circles/:address and
 * GET /circles/:address/members. `collateral` is in stroops (string-serialised).
 *
 * @see ApiMemberRow in sdk/src/types.ts
 */
export interface CircleMemberRow {
  member_address: string;
  payout_order: number;
  /** Locked collateral, in stroops (string-serialised). */
  collateral: string;
  defaults: number;
  joined_at: string | null;
  /** Reputation score aggregated by the reputation contract (0ΓÇô100). */
  reputation_score: number;
  /**
   * Total number of contributions this member has made across all rounds of
   * this circle. Used to derive whether they contributed to the current round.
   */
  total_contributions: number;
}

/**
 * Legacy alias: previously `CircleMember` was declared in CircleDetailClient.tsx
 * and imported from there everywhere. Re-exported here so all imports can be
 * migrated to this module without a rename churn.
 *
 * @see CircleMemberRow
 */
export type CircleMember = CircleMemberRow;

// ΓöÇΓöÇΓöÇ Contribution / Default records ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * A single contribution record within a round.
 * `amount` is in stroops (string-serialised).
 *
 * @see ApiContributionRecord in sdk/src/types.ts
 */
export interface ContributionRecord {
  member_address: string;
  /** Contribution amount, in stroops (string-serialised). */
  amount: string;
  tx_hash: string;
}

/**
 * A single default record within a round.
 * `penalty` is in stroops (string-serialised).
 *
 * @see ApiDefaultRecord in sdk/src/types.ts
 */
export interface DefaultRecord {
  member_address: string;
  /** Penalty deducted from collateral, in stroops (string-serialised). */
  penalty: string;
}

/** A pending default ΓÇö a DefaultRecord not yet associated with a payout round. */
export type PendingDefault = DefaultRecord;

// ΓöÇΓöÇΓöÇ Round row ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Lifecycle phase of a single round, as reconciled by the indexer.
 *
 * @see RoundPhase in sdk/src/types.ts
 */
export type RoundPhase = "completed" | "current" | "cancelled" | "open";

/** Frozen set of valid RoundPhase values ΓÇö used in runtime checks. */
export const ROUND_PHASES = ["completed", "current", "cancelled", "open"] as const;

/**
 * A round row as returned by GET /circles/:address/rounds.
 * `amount` is in stroops (string-serialised).
 *
 * @see ApiRoundRow in sdk/src/types.ts
 */
export interface CircleRound {
  roundIndex: number;
  /**
   * "completed" ΓÇö payout row exists for this round.
   * "current"   ΓÇö the active in-progress round (no payout yet).
   * "cancelled" ΓÇö the current round of a Cancelled circle.
   * "open"      ΓÇö unpaid round with activity that is not the current round
   *               (reorg / partial-ingest edge case; was previously invisible).
   */
  status: RoundPhase;
  /** null when the round has not been paid out yet. */
  recipient: string | null;
  /** Payout amount in stroops; null when the round has not been paid out yet. */
  amount: string | null;
  /** null when the round has not been paid out yet. */
  txHash: string | null;
  contributions: ContributionRecord[];
  defaults: DefaultRecord[];
}

// ΓöÇΓöÇΓöÇ API response envelopes ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Response body for GET /circles.
 *
 * @see ApiCirclesListResponse in sdk/src/types.ts
 */
export interface CirclesListResponse {
  circles: CircleRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Response body for GET /circles/:address.
 *
 * @see ApiCircleDetailResponse in sdk/src/types.ts
 */
export interface CircleDetailResponse {
  circle: CircleRow;
  members: CircleMemberRow[];
  latestLedger: number | null;
}

/**
 * Response body for GET /circles/:address/rounds.
 *
 * @see ApiRoundsResponse in sdk/src/types.ts
 */
export interface RoundsResponse {
  rounds: CircleRound[];
  openRounds: CircleRound[];
  pendingDefaults: DefaultRecord[];
  currentRound: CircleRound | null;
}

/**
 * Composite data object for the circle detail page, merging the data from
 * GET /circles/:address and GET /circles/:address/rounds.
 *
 * @see ApiCircleDetailWithRoundsResponse in sdk/src/types.ts
 */
export interface CircleDetailData {
  circle: CircleState;
  members: CircleMemberRow[];
  /**
   * Completed rounds only (status === "completed"), sorted by roundIndex.
   */
  rounds: CircleRound[];
  /**
   * Unpaid rounds that have contributions and/or defaults recorded but are
   * not the circle's current round (issue #170).
   */
  openRounds: CircleRound[];
  pendingDefaults: DefaultRecord[];
  /** Latest ledger the indexer has processed (used for countdown math). */
  latestLedger?: number | null;
  /**
   * ISO-8601 timestamp of the last ledger the indexer durably processed.
   * Present when the indexer embeds a `checkpointTime` field in its response.
   * Null when the field is absent — callers must treat freshness as unknown
   * and must not map that to a healthy signal.
   */
  checkpointTime?: string | null;
  /**
   * The in-progress round from the /rounds endpoint. Contains the actual
   * contributions list for the current round, used to determine whether the
   * connected wallet has already contributed this round.
   * Null when the circle is not Active or the indexer hasn't processed it yet.
   */
  currentRound?: CircleRound | null;
}

/**
 * Subset of CircleRow fields needed by the detail view's circle header.
 * Keeps the type surface minimal for components that only need status / round
 * counts and not the full row.
 */
export interface CircleState {
  status: string;
  current_round: number;
  total_rounds: number;
  round_amount: string;
  member_count: number;
  /** Computed deadline ledger for the current active round (null if unknown). */
  deadline_ledger?: number | null;
}

/**
 * Reputation response from GET /reputation/:member.
 *
 * @see ApiReputationResponse in sdk/src/types.ts
 */
export interface ReputationEvent {
  type: string;
  delta: number;
}

export interface ReputationResponse {
  member: string;
  /** true when a reputation row exists; false means no activity recorded yet. */
  found: boolean;
  score: number | null;
  detail?: string;
  contributions: Array<{
    circle_address: string;
    contributions: number;
    total_rounds: number;
  }>;
  defaults: Array<{
    circle_address: string;
    count: number;
  }>;
  events?: ReputationEvent[];
  updatedAt: string | null;
  events?: Array<{
    type: string;
    delta: number;
    timestamp?: string;
  }>;
}

// ΓöÇΓöÇΓöÇ Runtime validators ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
//
// Each parser takes `unknown` (raw JSON) and returns the typed model or null.
// They NEVER throw ΓÇö a null return means the caller should drop the row or
// treat the response as malformed.
//
// CONTRACT: parsers are pure functions with no side effects. They do not log,
// throw, or mutate their input. Every field check is explicit so TypeScript
// narrows cleanly after the guard.

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// ΓöÇΓöÇΓöÇ Contribution / Default parsers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Parse and validate a single ContributionRecord from an unknown API value.
 * Returns null if any required field is missing or malformed.
 */
export function parseContributionRecord(raw: unknown): ContributionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.member_address)) return null;
  if (!isString(r.amount)) return null;
  if (!isString(r.tx_hash)) return null;
  return {
    member_address: r.member_address,
    amount: r.amount,
    tx_hash: r.tx_hash,
  };
}

/**
 * Parse and validate a single DefaultRecord from an unknown API value.
 * Returns null if any required field is missing or malformed.
 */
export function parseDefaultRecord(raw: unknown): DefaultRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.member_address)) return null;
  if (!isString(r.penalty)) return null;
  return {
    member_address: r.member_address,
    penalty: r.penalty,
  };
}

/**
 * Parse and validate a PendingDefault from an unknown API value.
 * Returns null when the row is missing required fields.
 */
export function parsePendingDefault(raw: unknown): PendingDefault | null {
  return parseDefaultRecord(raw);
}

// ΓöÇΓöÇΓöÇ Round parser ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Parse and validate a single CircleRound row from an unknown API value.
 * Returns null if any required field is missing or malformed.
 */
export function parseCircleRound(raw: unknown): CircleRound | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonNegativeInt(r.roundIndex)) return null;
  if (typeof r.status !== "string" || !(ROUND_PHASES as readonly string[]).includes(r.status))
    return null;
  const contributions = Array.isArray(r.contributions)
    ? r.contributions
        .map(parseContributionRecord)
        .filter((c): c is ContributionRecord => c !== null)
    : [];
  const defaults = Array.isArray(r.defaults)
    ? r.defaults.map(parseDefaultRecord).filter((d): d is DefaultRecord => d !== null)
    : [];
  return {
    roundIndex: r.roundIndex,
    status: r.status as RoundPhase,
    recipient: isString(r.recipient) ? r.recipient : null,
    amount: isString(r.amount) ? r.amount : null,
    txHash: isString(r.txHash) ? r.txHash : null,
    contributions,
    defaults,
  };
}

// ΓöÇΓöÇΓöÇ CircleState (circle header fields) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Parse and validate the CircleState shape from an unknown indexer response.
 * Returns null if the object is missing any required numeric or string field.
 */
export function parseCircleState(raw: unknown): CircleState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.status)) return null;
  if (!isNonNegativeInt(r.current_round)) return null;
  if (!isNonNegativeInt(r.total_rounds)) return null;
  if (!isString(r.round_amount)) return null;
  if (!isNonNegativeInt(r.member_count)) return null;
  return {
    status: r.status,
    current_round: r.current_round,
    total_rounds: r.total_rounds,
    round_amount: r.round_amount,
    member_count: r.member_count,
    deadline_ledger: typeof r.deadline_ledger === "number" ? r.deadline_ledger : null,
  };
}

// ΓöÇΓöÇΓöÇ CircleRow parser ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Validate and narrow an unknown JSON value to a {@link CircleRow}, or return
 * `null` for a malformed row (never throws).
 *
 * Used by the home page list and any other call site that consumes raw
 * GET /circles responses.
 */
export function parseCircleRow(raw: unknown): CircleRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.address !== "string" || !isCanonicalStellarAddress(r.address)) return null;
  if (typeof r.creator !== "string" || !isCanonicalStellarAddress(r.creator)) return null;
  if (typeof r.round_amount !== "string" || !/^\d+$/.test(r.round_amount.trim())) return null;
  if (!isNonNegativeInt(r.member_count)) return null;
  if (!isNonEmptyString(r.status)) return null;
  if (!isNonNegativeInt(r.current_round)) return null;
  if (!isNonNegativeInt(r.total_rounds)) return null;
  if (!isNonNegativeInt(r.created_ledger)) return null;
  if (!isString(r.updated_at)) return null;

  return {
    address: r.address,
    creator: r.creator,
    round_amount: r.round_amount,
    member_count: r.member_count,
    // Status is validated as a non-empty string; consumers that need the exact
    // CircleApiStatus union should call isCircleApiStatus() separately. The
    // UI renders unknown statuses via getStatusMeta's fallback path.
    status: r.status as CircleApiStatus,
    current_round: r.current_round,
    total_rounds: r.total_rounds,
    created_ledger: r.created_ledger,
    updated_at: r.updated_at,
    deadline_ledger: typeof r.deadline_ledger === "number" ? r.deadline_ledger : null,
    round_deadline_ledgers:
      typeof r.round_deadline_ledgers === "number" ? r.round_deadline_ledgers : null,
  };
}

// ΓöÇΓöÇΓöÇ Member row parser ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function toCount(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isNonNegativeInt(n) ? n : 0;
}

/**
 * Validate the `members` field of an indexer `/circles/:address` response.
 *
 * The rotation view treats a member's array index as its payout position, so
 * a partially usable list is worse than none: silently dropping one bad row
 * would shift every later member into the wrong slot and mark the wrong person
 * as "next payout". The list is therefore all-or-nothing:
 *
 *   ΓÇó Returns [] when the field is missing, not an array, or any row fails
 *     the structural check (no G-address, no non-negative integer payout_order,
 *     or duplicate address / position).
 *   ΓÇó Display-only fields (defaults, reputation_score, total_contributions,
 *     collateral, joined_at) are coerced to safe defaults so one missing score
 *     never hides the whole rotation.
 *   ΓÇó Rows are sorted by payout_order regardless of the indexer's return order.
 */
export function parseMemberRows(raw: unknown): CircleMemberRow[] {
  if (!Array.isArray(raw)) return [];

  const members: CircleMemberRow[] = [];
  const addresses = new Set<string>();
  const positions = new Set<number>();

  for (const row of raw) {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;

    const address =
      typeof r.member_address === "string" ? r.member_address.trim() : "";
    // Shape check (isStellarPublicKey): only G-prefixed wallet addresses are
    // valid circle members. Contract addresses (C-prefix) and any other value
    // are rejected here.
    //
    // Checksum check (hasValidStrKeyChecksum): the indexer is a trusted source,
    // but a shape-valid address with a bad checksum is either:
    //   (a) a data integrity problem in the indexer (bug, migration error), or
    //   (b) a manually injected value that bypassed normal write paths.
    // In both cases the address must not reach `new Address(member_address)` in
    // ScVal encoding, `invokeContract`, or comparison with a real wallet address.
    // Failing the whole list (all-or-nothing) is correct here for the same
    // reason `isStellarPublicKey` already rejects any single bad row: dropping
    // one member would shift every later member into the wrong payout slot.
    if (
      !isStellarPublicKey(address) ||
      !hasValidStrKeyChecksum(address) ||
      addresses.has(address)
    ) return [];
    if (!isNonNegativeInt(r.payout_order) || positions.has(r.payout_order)) return [];
    addresses.add(address);
    positions.add(r.payout_order);

    members.push({
      member_address: address,
      payout_order: r.payout_order,
      collateral:
        typeof r.collateral === "string" || typeof r.collateral === "number"
          ? String(r.collateral)
          : "0",
      defaults: toCount(r.defaults),
      joined_at: typeof r.joined_at === "string" ? r.joined_at : null,
      reputation_score: toCount(r.reputation_score),
      total_contributions: toCount(r.total_contributions),
    });
  }

  return members.sort((a, b) => a.payout_order - b.payout_order);
}

// ΓöÇΓöÇΓöÇ Rounds response parser ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Parse an unknown GET /circles/:address/rounds response body into a typed
 * {@link RoundsResponse}. Missing or unparseable fields fall back to empty
 * arrays / null rather than failing the whole response, so partial indexer
 * data does not prevent the page from rendering.
 */
export function parseRoundsResponse(raw: unknown): RoundsResponse {
  const r: Record<string, unknown> =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  return {
    rounds: Array.isArray(r.rounds)
      ? r.rounds
          .map(parseCircleRound)
          .filter((x): x is CircleRound => x !== null)
      : [],
    openRounds: Array.isArray(r.openRounds)
      ? r.openRounds
          .map(parseCircleRound)
          .filter((x): x is CircleRound => x !== null)
      : [],
    pendingDefaults: Array.isArray(r.pendingDefaults)
      ? r.pendingDefaults
          .map(parsePendingDefault)
          .filter((x): x is DefaultRecord => x !== null)
      : [],
    currentRound:
      r.currentRound != null && typeof r.currentRound === "object"
        ? parseCircleRound(r.currentRound)
        : null,
  };
}

// ΓöÇΓöÇΓöÇ Reputation response parser ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Parse an unknown GET /reputation/:member response body into a typed
 * {@link ReputationResponse}. Returns null when the response is structurally
 * invalid (missing required fields).
 */
export function parseReputationResponse(raw: unknown): ReputationResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (!isNonEmptyString(r.member)) return null;
  if (typeof r.found !== "boolean") return null;
  if (typeof r.score !== "number" && r.score !== null) return null;

  const detail = isString(r.detail) ? r.detail : undefined;

  const contributions = Array.isArray(r.contributions)
    ? r.contributions
        .filter(
          (c): c is { circle_address: string; contributions: number; total_rounds: number } => {
            if (typeof c !== "object" || c === null) return false;
            const row = c as Record<string, unknown>;
            return (
              isNonEmptyString(row.circle_address) &&
              typeof row.contributions === "number" &&
              typeof row.total_rounds === "number"
            );
          },
        )
        .map((c) => ({
          circle_address: c.circle_address,
          contributions: c.contributions,
          total_rounds: c.total_rounds,
        }))
    : [];

  const defaults = Array.isArray(r.defaults)
    ? r.defaults
        .filter((d): d is { circle_address: string; count: number } => {
          if (typeof d !== "object" || d === null) return false;
          const row = d as Record<string, unknown>;
          return isNonEmptyString(row.circle_address) && typeof row.count === "number";
        })
        .map((d) => ({ circle_address: d.circle_address, count: d.count }))
    : [];

  const events = Array.isArray(r.events)
    ? r.events
        .filter((e): e is { type: string; delta: number; timestamp?: string } => {
          if (typeof e !== "object" || e === null) return false;
          const row = e as Record<string, unknown>;
          return typeof row.type === "string" && typeof row.delta === "number";
        })
        .map((e) => ({
          type: e.type,
          delta: e.delta,
          ...(typeof e.timestamp === "string" ? { timestamp: e.timestamp } : {}),
        }))
    : undefined;

  return {
    member: r.member,
    found: r.found,
    score: r.score,
    detail,
    contributions,
    defaults,
    ...(events ? { events } : {}),
    updatedAt: isString(r.updatedAt) ? r.updatedAt : null,
    ...(events ? { events } : {}),
  };
}
