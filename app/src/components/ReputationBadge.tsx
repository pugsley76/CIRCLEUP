"use client";

export interface ReputationBadgeProps {
  score: number | null | undefined;
  size?: "sm" | "md" | "lg";
}

export interface ReputationLevel {
  label: string;
  color: string;
  /** Short shape/pattern marker shown alongside colour for non-colour distinction. */
  marker: string;
  emoji: string;
  /** Minimum score required to reach this level (inclusive). Must be >= 0. */
  minScore: number;
  /** Maximum score for this level (exclusive), or Infinity for the top tier. */
  maxScore: number;
  description: string;
}

// ─── Threshold constants ──────────────────────────────────────────────────────
//
// Centralised so tests and callers can import these rather than hard-coding
// magic numbers.  The thresholds are deterministic: a score maps to exactly
// one tier; no floating-point or locale-sensitive comparison is involved.
//
//   New      [0, 1)
//   Starter  [1, 3)
//   Reliable [3, 6)
//   Trusted  [6, 10)
//   Legend   [10, ∞)

export const TIER_THRESHOLD_NEW      = 0;
export const TIER_THRESHOLD_STARTER  = 1;
export const TIER_THRESHOLD_RELIABLE = 3;
export const TIER_THRESHOLD_TRUSTED  = 6;
export const TIER_THRESHOLD_LEGEND   = 10;

/** Ordered tier definitions — used both for badge rendering and the legend. */
export const REPUTATION_LEVELS: ReputationLevel[] = [
  {
    label: "New",
    color: "bg-slate-100 text-slate-600",
    marker: "○",           // hollow circle — no rounds yet
    emoji: "🌱",
    minScore: TIER_THRESHOLD_NEW,
    maxScore: TIER_THRESHOLD_STARTER,
    description: "No completed rounds yet.",
  },
  {
    label: "Starter",
    color: "bg-yellow-100 text-yellow-700",
    marker: "◔",           // quarter-filled — just getting started
    emoji: "⭐",
    minScore: TIER_THRESHOLD_STARTER,
    maxScore: TIER_THRESHOLD_RELIABLE,
    description: "1–2 completed rounds.",
  },
  {
    label: "Reliable",
    color: "bg-blue-100 text-blue-700",
    marker: "◑",           // half-filled — building a track record
    emoji: "💎",
    minScore: TIER_THRESHOLD_RELIABLE,
    maxScore: TIER_THRESHOLD_TRUSTED,
    description: "3–5 completed rounds.",
  },
  {
    label: "Trusted",
    color: "bg-brand-100 text-brand-700",
    marker: "◕",           // mostly-filled — proven track record
    emoji: "🏆",
    minScore: TIER_THRESHOLD_TRUSTED,
    maxScore: TIER_THRESHOLD_LEGEND,
    description: "6–9 completed rounds.",
  },
  {
    label: "Legend",
    color: "bg-purple-100 text-purple-700",
    marker: "●",           // fully-filled circle — top tier
    emoji: "👑",
    minScore: TIER_THRESHOLD_LEGEND,
    maxScore: Infinity,
    description: "10 or more completed rounds.",
  },
];

// ─── Unknown / negative sentinel tier ────────────────────────────────────────
//
// Used when score is null, undefined, NaN, or negative.  This tier is NOT
// included in REPUTATION_LEVELS (so it never appears in the legend as a real
// tier), but it shares the ReputationLevel shape so the badge component can
// use it without special-casing every field.

const UNKNOWN_LEVEL: ReputationLevel = {
  label: "Unknown",
  color: "bg-slate-50 text-slate-400",
  marker: "?",
  emoji: "❓",
  minScore: -Infinity,
  maxScore: 0,
  description: "Score data is not available.",
};

// ─── getLevel ─────────────────────────────────────────────────────────────────
//
// Pure, deterministic.  Given any numeric score, returns exactly one tier.
//
// Rules:
//   • Null / undefined / NaN / negative  → UNKNOWN_LEVEL  (never a positive tier)
//   • 0                                  → New            (minScore=0 is inclusive)
//   • Large integer (e.g. 999)           → Legend         (maxScore=Infinity)
//
// Walk in reverse so the first match is always the highest qualifying tier.

export function getLevel(score: number | null | undefined): ReputationLevel {
  // Reject data-absent / invalid cases before any tier comparison
  if (score == null || !Number.isFinite(score) || score < 0) {
    return UNKNOWN_LEVEL;
  }
  for (let i = REPUTATION_LEVELS.length - 1; i >= 0; i--) {
    if (score >= REPUTATION_LEVELS[i].minScore) {
      return REPUTATION_LEVELS[i];
    }
  }
  // score is a finite non-negative number that didn't match any tier — this
  // can only happen if REPUTATION_LEVELS is misconfigured (first tier's
  // minScore > 0).  Fall back to the first tier rather than crashing.
  return REPUTATION_LEVELS[0];
}

// ─── ReputationBadge ──────────────────────────────────────────────────────────
//
// Communicates tier meaning through three independent channels so it is
// readable without colour perception:
//
//   1. Colour background / text (visual)
//   2. Shape marker (○ ◔ ◑ ◕ ● ?) — a distinct glyph per tier (non-colour)
//   3. Text label (visible) + numeric score (visible)
//   4. aria-label on the wrapper (screen reader)
//
// All purely decorative parts (emoji, marker glyph, label, score) are
// aria-hidden — the aria-label carries the complete accessible name so
// screen readers announce "Reputation level: Trusted, score 7" rather than
// fragmenting across four child spans.

export function ReputationBadge({ score, size = "md" }: ReputationBadgeProps) {
  const level = getLevel(score);
  const sizeClass =
    size === "sm"
      ? "text-xs px-2 py-0.5"
      : size === "lg"
      ? "text-base px-4 py-2"
      : "text-sm px-3 py-1";

  // Determine what to display as the numeric score.  Unknown/null scores show
  // "—" visually; the aria-label already says "score unknown" so the dash is
  // supplementary, not the primary information carrier.
  const scoreDisplay =
    score == null || !Number.isFinite(score as number) || (score as number) < 0
      ? "—"
      : score;

  const isUnknown = level === UNKNOWN_LEVEL;
  const ariaLabel = isUnknown
    ? "Reputation level: Unknown — score data not available"
    : `Reputation level: ${level.label}, score ${score}`;

  return (
    <span
      role="img"
      className={`inline-flex items-center gap-1 rounded-full font-medium ${level.color} ${sizeClass}`}
      aria-label={ariaLabel}
      title={`${level.label} — ${level.description}`}
    >
      {/* Shape marker: non-colour distinction between tiers */}
      <span aria-hidden="true" className="font-mono leading-none">
        {level.marker}
      </span>
      <span aria-hidden="true">{level.label}</span>
      <span aria-hidden="true" className="font-bold">
        {scoreDisplay}
      </span>
    </span>
  );
}

/**
 * ReputationLegend — renders a full tier table explaining each badge level.
 *
 * Intended for the reputation profile page to help users understand the scoring
 * system.  Each row shows the badge (colour + shape marker + label) alongside
 * the score range and a plain-text description, so meaning is clear without
 * relying on colour alone.
 *
 * Accessibility notes:
 *   - The wrapping <section> is labelled via aria-labelledby pointing at the
 *     visible heading — avoids duplicating the heading text in a separate
 *     aria-label attribute.
 *   - Column headers use scope="col" and are always visible to assistive
 *     technology (not sr-only) so screen-reader users understand the table
 *     structure before navigating rows.
 *   - Each data row uses a <th scope="row"> for the tier name so assistive
 *     technology announces "New — Score range 0, No completed rounds yet."
 *     rather than reading three unrelated cells.
 *   - The decorative colour badge inside each row is aria-hidden; the row
 *     header already carries the tier name for AT.
 *
 * Uses a <table> for semantic correctness: the relationship between tier name,
 * score range, and description is tabular data, not a definition list.
 */
export function ReputationLegend() {
  return (
    <section
      aria-labelledby="rep-legend-heading"
      className="bg-white rounded-xl border border-slate-200 p-5"
    >
      <h2 className="font-semibold text-slate-800 mb-3" id="rep-legend-heading">
        Badge levels
      </h2>
      <table
        className="w-full text-sm text-left border-collapse"
        aria-describedby="rep-legend-desc"
      >
        <caption id="rep-legend-desc" className="sr-only">
          Reputation badge levels, their score ranges, and what each level means.
        </caption>
        <thead>
          <tr className="text-slate-500 border-b border-slate-200">
            <th scope="col" className="py-2 pr-3 font-medium">
              Level
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Score range
            </th>
            <th scope="col" className="py-2 font-medium">
              Meaning
            </th>
          </tr>
        </thead>
        <tbody>
          {REPUTATION_LEVELS.map((level) => (
            <tr key={level.label} className="border-b border-slate-100 last:border-0">
              <th scope="row" className="py-2 pr-3 font-normal text-slate-700">
                <span className="sr-only">{level.label}</span>
                <span
                  aria-hidden="true"
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${level.color}`}
                >
                  <span className="font-mono leading-none">{level.marker}</span>
                  {level.label}
                </span>
              </th>
              <td
                className="py-2 pr-3 text-slate-600"
                aria-label={`Score range: ${
                  level.maxScore === Infinity
                    ? `${level.minScore}+`
                    : level.maxScore - level.minScore === 1
                    ? `${level.minScore}`
                    : `${level.minScore}–${level.maxScore - 1}`
                }`}
              >
                {level.maxScore === Infinity
                  ? `${level.minScore}+`
                  : level.maxScore - level.minScore === 1
                  ? `${level.minScore}`
                  : `${level.minScore}–${level.maxScore - 1}`}
              </td>
              <td className="py-2 text-slate-600">{level.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
