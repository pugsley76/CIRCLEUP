// ─── Shared circle status presentation model (Issue: status consistency) ─────
//
// Single source of truth for how every circle lifecycle status is presented
// across the app: list cards (CircleCard), the detail header (CircleHeader),
// and the status filter pills (CircleStatusFilter).
//
// Sources:
//   • Contract-native statuses: Pending, Active, Completed, Cancelled
//     (mirror the Rust CircleStatus enum in lifecycle.ts).
//   • Indexer-only projection: Closed (the contract tracks closure as a
//     boolean flag; the indexer projects it as a status string for queries).
//
// Unknown API values are handled by a safe fallback: the raw value is shown
// as the label, the description says it is unrecognized, and a neutral slate
// visual variant is used. Unknown statuses must never imply an action is
// available when it is not — action availability is decided separately by
// the gating layer (lib/gating.ts) and the contract itself.

export type CircleStatus =
  | "Pending"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "Closed";

/** Every recognised status, in a fixed order. Used for runtime membership checks. */
export const ALL_CIRCLE_STATUSES: readonly CircleStatus[] = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
  "Closed",
] as const;

/** Presentation for a single status: label, description, and visual classes. */
export interface CircleStatusPresentation {
  /** Visible label, e.g. "Active". */
  readonly label: string;
  /** Plain-language description, surfaced as a tooltip / screen-reader detail. */
  readonly description: string;
  /** Status chip background + text classes. */
  readonly chipClasses: string;
  /** Coloured dot indicator classes. */
  readonly dotClasses: string;
}

// Canonical presentation per status. Labels match lifecycle.ts STATUS_LABELS
// so list, detail, and filter surfaces never disagree on wording.
const STATUS_PRESENTATION: Record<CircleStatus, CircleStatusPresentation> = {
  Pending: {
    label: "Pending",
    description: "Waiting for all members to lock collateral before the circle starts.",
    chipClasses: "bg-yellow-100 text-yellow-800",
    dotClasses: "bg-yellow-500",
  },
  Active: {
    label: "Active",
    description: "All members have joined. Contribution rounds are in progress.",
    chipClasses: "bg-brand-100 text-brand-700",
    dotClasses: "bg-brand-500",
  },
  Completed: {
    label: "Completed",
    description: "All rounds have been paid out successfully.",
    chipClasses: "bg-green-100 text-green-800",
    dotClasses: "bg-green-500",
  },
  Cancelled: {
    label: "Cancelled",
    description: "The circle was dissolved before becoming active.",
    chipClasses: "bg-red-100 text-red-800",
    dotClasses: "bg-red-400",
  },
  Closed: {
    label: "Closed",
    description: "Collateral has been released. Circle fully settled.",
    chipClasses: "bg-slate-100 text-slate-500",
    dotClasses: "bg-slate-400",
  },
};

/** Neutral presentation for an unrecognised API value. Never implies an action is available. */
const UNKNOWN_PRESENTATION: CircleStatusPresentation = {
  label: "Unknown",
  description: "Unrecognized status: not a known circle lifecycle state.",
  chipClasses: "bg-slate-100 text-slate-700",
  dotClasses: "bg-slate-400",
};

/**
 * Normalise a raw status value (from the indexer or contract) to a known
 * CircleStatus. Comparison is case-insensitive and whitespace-tolerant.
 * Returns undefined for empty or unrecognised values.
 */
export function normalizeCircleStatus(raw: unknown): CircleStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  return (ALL_CIRCLE_STATUSES as readonly string[]).find(
    (s) => s.toLowerCase() === lower,
  ) as CircleStatus | undefined;
}

/** Returns true when `value` is a recognised circle lifecycle status. */
export function isKnownCircleStatus(value: unknown): value is CircleStatus {
  return normalizeCircleStatus(value) !== undefined;
}

/**
 * Return the presentation for a raw status value.
 *
 * Unknown values fall back to UNKNOWN_PRESENTATION with the raw value
 * preserved as the label (so developers can diagnose unexpected statuses)
 * and a description that makes clear the value isn't recognised.
 */
export function getCircleStatusMeta(raw: unknown): CircleStatusPresentation {
  const status = normalizeCircleStatus(raw);
  if (!status) {
    const label =
      typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "Unknown";
    return {
      ...UNKNOWN_PRESENTATION,
      label,
      description: `Unrecognized status: "${label}"`,
    };
  }
  return STATUS_PRESENTATION[status];
}
