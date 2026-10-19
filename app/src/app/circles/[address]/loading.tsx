/**
 * Streaming loading skeleton for the circle detail page (Issue #489).
 *
 * Shown by Next.js while the async CircleDetailPage server component is
 * fetching data. Mirrors the exact layout the real page renders so there is
 * zero layout shift when the content streams in.
 *
 * Layout sections (top to bottom):
 *   1. Header skeleton         — circle name + address + 4 stat tiles
 *   2. Workflow banner skeleton
 *   3. Actions panel skeleton  — action button placeholder
 *   4. Round deadline skeleton
 *   5. Rotation order skeleton — member rows
 *   6. Round history skeleton  — past-round cards
 *   7. Invite link skeleton
 */

function SkeletonTile() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 text-center animate-pulse">
      <div className="h-6 w-12 bg-slate-200 rounded mx-auto mb-1" />
      <div className="h-3 w-16 bg-slate-100 rounded mx-auto" />
    </div>
  );
}

function SkeletonMemberRow({ index }: { index: number }) {
  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-white animate-pulse"
      aria-hidden="true"
    >
      <span className="text-slate-200 text-sm w-5 shrink-0 text-right select-none">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="h-3 bg-slate-200 rounded w-3/4" />
        <div className="h-3 bg-slate-100 rounded w-1/4" />
      </div>
      <div className="h-3 bg-slate-100 rounded w-20 shrink-0" />
    </div>
  );
}

function SkeletonRoundCard() {
  return (
    <div
      className="border border-slate-100 rounded-lg p-4 animate-pulse"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="h-4 bg-slate-200 rounded w-16" />
        <div className="h-3 bg-slate-100 rounded w-20" />
      </div>
      <div className="h-3 bg-slate-100 rounded w-1/2 mt-1" />
      <div className="h-2.5 bg-slate-100 rounded w-1/3 mt-2" />
    </div>
  );
}

export default function CircleDetailLoading() {
  return (
    <div role="status" aria-label="Loading circle details…" aria-busy="true">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-8 animate-pulse">
        <div className="flex items-start gap-3 mb-2">
          <span className="text-3xl" aria-hidden="true">🔄</span>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-7 bg-slate-200 rounded w-56" />
            <div className="h-4 bg-slate-100 rounded w-3/4 max-w-80" />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonTile key={i} />
          ))}
        </div>
      </div>

      {/* ── Workflow banner ────────────────────────────────────────────── */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6 animate-pulse">
        <div className="h-4 bg-slate-200 rounded w-2/3" />
      </div>

      {/* ── Actions panel ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
        <div className="h-5 bg-slate-200 rounded w-20 mb-4 animate-pulse" />
        <div className="flex gap-3 flex-wrap">
          <div className="h-10 bg-slate-200 rounded-lg w-40 animate-pulse" />
        </div>
      </div>

      {/* ── Round deadline ─────────────────────────────────────────────── */}
      <div
        className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-6 flex items-center gap-3 animate-pulse"
        aria-hidden="true"
      >
        <span className="text-xl opacity-30">⏱️</span>
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-slate-200 rounded w-24" />
          <div className="h-5 bg-slate-200 rounded w-20" />
          <div className="h-2.5 bg-slate-100 rounded w-48" />
        </div>
      </div>

      {/* ── Rotation order ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
        <div className="h-5 bg-slate-200 rounded w-40 mb-4 animate-pulse" />
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonMemberRow key={i} index={i} />
          ))}
        </div>
        <div className="h-2.5 bg-slate-100 rounded w-48 mt-3 animate-pulse" />
      </div>

      {/* ── Round history ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
        <div className="h-5 bg-slate-200 rounded w-36 mb-4 animate-pulse" />
        <div className="space-y-4">
          <SkeletonRoundCard />
          <SkeletonRoundCard />
        </div>
      </div>

      {/* ── Invite link ────────────────────────────────────────────────── */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-slate-200 rounded w-24 mb-2" />
        <div className="h-3 bg-slate-100 rounded w-64 mb-3" />
        <div className="flex gap-2">
          <div className="flex-1 h-9 bg-slate-200 rounded" />
          <div className="h-9 w-16 bg-slate-200 rounded" />
        </div>
      </div>
    </div>
  );
}
