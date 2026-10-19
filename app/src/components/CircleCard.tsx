"use client";
import { memo } from "react";
import Link from "next/link";
import { shortAddress, formatUsdc, formatPot } from "@/lib/config";
import clsx from "clsx";
// Re-export the shared type and parser so existing imports from this file
// continue to resolve.  The canonical definitions now live in circleTypes.ts.
export type { Circle } from "@/lib/circleTypes";
export { parseCircleRow } from "@/lib/circleTypes";
import type { Circle } from "@/lib/circleTypes";
// Shared status presentation model — single source of truth for status labels,
// descriptions, and visual variants across list cards, the detail header, and
// the status filter pills.  Re-exported here so existing imports keep working.
import { getCircleStatusMeta, type CircleStatusPresentation } from "@/lib/circleStatus";

export type { CircleStatusPresentation as StatusMeta } from "@/lib/circleStatus";
export { getCircleStatusMeta as getStatusMeta } from "@/lib/circleStatus";

// ─── Input guards ─────────────────────────────────────────────────────────────
//
// The indexer returns amounts as string-serialised stroops and counts as
// numbers. Both should always be valid, but the API contract is not enforced
// at compile time, so guard before passing to formatUsdc / formatPot to
// prevent NaN / "0.00" from silently replacing real values.

function safeFormatUsdc(stroops: string): string {
  let n: bigint;
  try {
    n = BigInt(stroops.trim() || "0");
  } catch {
    return "0.00";
  }
  if (n < 0n) return "0.00";
  return formatUsdc(n);
}

function safeFormatPot(stroops: string, memberCount: number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.trim() || "0");
  } catch {
    return "0.00";
  }
  const count = Number.isFinite(memberCount) && memberCount > 0 ? memberCount : 0;
  if (n < 0n || count === 0) return "0.00";
  return formatPot(n, count);
}

// ─── CircleCard ───────────────────────────────────────────────────────────────
//
// Responsive constraints:
//   - The card uses a fixed minimum width on the status chip so status changes
//     never reflow adjacent content (the chip always occupies the same inline
//     footprint regardless of label length).
//   - Long addresses and amounts are truncated with a visible ellipsis instead
//     of overflowing their containers.  The full value is always available via
//     the title / aria-label so assistive technology and power users can access
//     it without truncation.
//   - The card link receives an explicit focus-visible ring so keyboard users
//     can tell which card has focus without relying on the browser default.
//   - The three stats tiles use a fixed grid; they never reflow to two columns
//     on narrow viewports, keeping the layout stable across status changes.
//
// Wrapped in React.memo so parent re-renders (e.g. Suspense boundary settling,
// context changes) do not re-render every card in the list when their props
// have not changed.

export const CircleCard = memo(function CircleCard({ circle }: { circle: Circle }) {
  const status = getStatusMeta(circle.status);
  const totalRounds = circle.total_rounds > 0 ? circle.total_rounds : 0;
  const currentRound = Math.max(0, circle.current_round);
  const progressPct =
    totalRounds > 0
      ? Math.round((currentRound / totalRounds) * 100)
      : 0;

  // Human-readable label used both by the aria-label on the link and the
  // screen-reader-only heading inside the card, so assistive technology
  // announces the card's purpose unambiguously.  Round progress is only
  // included when total_rounds is valid — a malformed row must not produce
  // "round 0 of 0" in the announcement.
  const cardLabel =
    `Circle ${shortAddress(circle.address)} — $${safeFormatUsdc(circle.round_amount)} per round, ` +
    `${status.label}` +
    (totalRounds > 0 ? `, round ${currentRound} of ${totalRounds}` : "");

  return (
    <Link
      href={`/circles/${circle.address}`}
      className={clsx(
        "block group",
        // Explicit keyboard focus ring: visible on focus-visible so keyboard
        // users always know which card is focused.  rounded-xl matches the
        // inner card border-radius so the ring hugs the card outline.
        "rounded-xl",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
      )}
      aria-label={cardLabel}
    >
      <div className="bg-white rounded-xl border border-slate-200 p-5 hover:border-brand-400 hover:shadow-md transition-all h-full">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          {/* Left: address + amount — truncated on narrow viewports */}
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-slate-500 truncate" title={circle.address}>
              {shortAddress(circle.address)}
            </p>
            {/*
              max-w-[16ch] keeps amounts from pushing the status chip off-screen
              on very narrow cards (e.g. a 2-column grid at 320 px).
              truncate + title ensures the full value is still discoverable.
            */}
            <p
              className="text-lg font-semibold text-slate-800 mt-0.5 truncate"
              title={`$${safeFormatUsdc(circle.round_amount)} per round`}
            >
              ${safeFormatUsdc(circle.round_amount)} / round
            </p>
          </div>

          {/*
            Status chip: fixed min-width so the chip footprint never changes
            when the status label changes between Pending / Active / Completed /
            Cancelled.  Without min-width, a status change from "Active" to
            "Cancelled" (a wider label) would widen the chip and shift the
            amount text on the left, producing a jarring layout jump.

            `title` supplies the sighted tooltip.  An explicit aria-label keeps
            the accessible name unambiguous: it includes both the status label
            and its description so screen readers announce both in one phrase.
          */}
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full",
              "whitespace-nowrap flex-shrink-0",
              // min-w-[6rem] is wide enough for "Cancelled" (the longest label)
              // so all four status chips occupy the same block width.
              "min-w-[6rem] justify-center",
              status.chipClasses,
            )}
            title={status.description}
            aria-label={`Status: ${status.label}. ${status.description}`}
          >
            <span
              className={clsx("h-1.5 w-1.5 rounded-full flex-shrink-0", status.dotClasses)}
              aria-hidden="true"
            />
            {status.label}
          </span>
        </div>

        {/* Stats — fixed 3-column grid; never reflows */}
        <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
          <div className="bg-slate-50 rounded-lg py-2">
            <p className="font-semibold text-slate-800">{circle.member_count}</p>
            <p className="text-slate-500">members</p>
          </div>
          <div className="bg-slate-50 rounded-lg py-2">
            {/*
              "2/10" reads as "two slash ten" to screen readers which is
              confusing.  A visually-hidden span spells it out as a full phrase,
              and the visible slash notation is hidden from the a11y tree.
            */}
            <p className="font-semibold text-slate-800">
              <span aria-hidden="true">
                {currentRound}/{totalRounds}
              </span>
              <span className="sr-only">
                {totalRounds > 0
                  ? `Round ${currentRound} of ${totalRounds}`
                  : "Rounds not yet set"}
              </span>
            </p>
            <p className="text-slate-500" aria-hidden="true">
              rounds
            </p>
          </div>
          <div className="bg-slate-50 rounded-lg py-2">
            {/*
              Pot amount may be large (e.g. "$10,000.00"); truncate with a
              title tooltip rather than overflowing or wrapping, which would
              break the fixed grid height.
            */}
            <p
              className="font-semibold text-slate-800 truncate px-1"
              title={`$${safeFormatPot(circle.round_amount, circle.member_count)} total pot`}
            >
              ${safeFormatPot(circle.round_amount, circle.member_count)}
            </p>
            <p className="text-slate-500">pot</p>
          </div>
        </div>

        {/* Progress bar */}
        {totalRounds > 0 && (
          <div
            className="w-full bg-slate-100 rounded-full h-1.5"
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Round progress: ${currentRound} of ${totalRounds}`}
          >
            <div
              className="bg-brand-500 h-1.5 rounded-full transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        <p className="text-xs text-slate-400 mt-2 truncate" title={`Created by ${circle.creator}`}>
          by {shortAddress(circle.creator)}
        </p>
      </div>
    </Link>
  );
});
