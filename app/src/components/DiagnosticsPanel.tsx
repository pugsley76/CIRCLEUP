"use client";
/**
 * DiagnosticsPanel — opt-in local diagnostics bundle UI.
 *
 * # What this component does
 *
 * After a transaction failure the user sees an error banner.  This panel
 * attaches below that banner and offers a two-step flow:
 *
 *   1. The panel is collapsed by default and labelled so the user knows
 *      what it contains before expanding it.
 *   2. Expanding reveals a plain-English description of the fields that
 *      will be included, then two action buttons:
 *        - "Copy to clipboard" — writes the JSON to the clipboard.
 *        - "Download as JSON"  — triggers a browser download.
 *
 * Neither action submits the bundle to a server.  The buttons are only
 * reachable after the user explicitly expands the panel (opt-in).
 *
 * # Accessibility
 *
 * - The toggle uses <button> with aria-expanded so screen readers announce
 *   the current state.
 * - The expanded region has role="region" and aria-labelledby pointing to
 *   the panel heading so it is a named landmark.
 * - Copy and download buttons have aria-live feedback regions for the
 *   success / error state so keyboard-only users hear the outcome.
 * - All interactive controls meet the 44 × 44 px minimum touch-target size.
 * - No colour-only state communication — icon + text label on every state.
 *
 * # Props
 *
 * - typedError     ContractAppError from the failed transaction (required to
 *                  build the error section of the bundle).
 * - txHash         Transaction hash string if the tx reached the network.
 * - stage          TxStage at which the failure occurred.
 * - errorCategory  TxErrorCategory from the telemetry categoriser.
 *
 * All props are optional — the panel can be rendered without an active error
 * to let developers inspect the environment section at any time.
 */

import { useState, useId, useCallback, useRef } from "react";
import { buildAndSerialise, type DiagnosticsBundleInput } from "@/lib/diagnostics";
import type { ContractAppError } from "@/lib/contractErrors";
import type { TxStage, TxErrorCategory } from "@/lib/telemetry";

// ─── Prop types ───────────────────────────────────────────────────────────────

export interface DiagnosticsPanelProps {
  /** Typed error from the failed transaction. */
  typedError?: ContractAppError | null;
  /** On-chain tx hash when available (always redacted in the bundle). */
  txHash?: string | null;
  /** TxStage at failure time — included as error.stage in the bundle. */
  stage?: TxStage;
  /** TxErrorCategory — included as error.category in the bundle. */
  errorCategory?: TxErrorCategory;
}

// ─── Copy / download state ────────────────────────────────────────────────────

type ActionState = "idle" | "success" | "error";

// ─── Field inventory ──────────────────────────────────────────────────────────
//
// These strings must stay in sync with DiagnosticsBundle's shape (lib/diagnostics.ts).
// They are rendered verbatim in the "What's included" list so the user sees
// exactly what will be in the bundle before generating it.

const INCLUDED_FIELDS: readonly string[] = [
  "App version and active network (testnet / mainnet)",
  "Stellar RPC and indexer URLs",
  "Whether the Freighter wallet extension is detected",
  "Allowed public environment variable names and values (redacted for safety)",
  "Browser user-agent string, language, and online status",
  "Error kind, code, and user-facing message",
  "Transaction lifecycle stage and error category (when available)",
  "Whether a transaction hash was produced (hash itself is always redacted)",
  "Bundle generation timestamp",
];

const EXCLUDED_FIELDS: readonly string[] = [
  "Wallet addresses or private keys",
  "Secret keys, seed phrases, or mnemonics",
  "Signed or unsigned XDR",
  "Transaction hash values",
  "ScVal arguments (which may encode amounts or addresses)",
  "Raw provider error messages",
  "Any environment variable not on the explicit allowlist",
];

// ─── Component ────────────────────────────────────────────────────────────────

export function DiagnosticsPanel({
  typedError,
  txHash,
  stage,
  errorCategory,
}: DiagnosticsPanelProps) {
  const [isExpanded,    setIsExpanded]    = useState(false);
  const [copyState,     setCopyState]     = useState<ActionState>("idle");
  const [downloadState, setDownloadState] = useState<ActionState>("idle");

  // Stable IDs for aria-labelledby / aria-describedby
  const headingId    = useId();
  const regionId     = useId();
  const copyStatusId = useId();
  const dlStatusId   = useId();

  // Ref to the expanded region for focus management
  const regionRef = useRef<HTMLDivElement>(null);

  // ── Bundle builder ─────────────────────────────────────────────────────────

  const buildInput = useCallback((): DiagnosticsBundleInput => ({
    typedError:    typedError ?? undefined,
    txHash:        txHash     ?? undefined,
    stage,
    errorCategory,
  }), [typedError, txHash, stage, errorCategory]);

  // ── Toggle ─────────────────────────────────────────────────────────────────

  function handleToggle() {
    const next = !isExpanded;
    setIsExpanded(next);
    // Reset action states when collapsing so they don't persist across re-opens
    if (!next) {
      setCopyState("idle");
      setDownloadState("idle");
    }
  }

  // ── Copy to clipboard ──────────────────────────────────────────────────────

  async function handleCopy() {
    try {
      const json = buildAndSerialise(buildInput());
      await navigator.clipboard.writeText(json);
      setCopyState("success");
      setTimeout(() => setCopyState("idle"), 3000);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  // ── Download as JSON ───────────────────────────────────────────────────────

  function handleDownload() {
    try {
      const json = buildAndSerialise(buildInput());
      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href     = url;
      a.download = `circleup-diagnostics-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDownloadState("success");
      setTimeout(() => setDownloadState("idle"), 3000);
    } catch {
      setDownloadState("error");
      setTimeout(() => setDownloadState("idle"), 4000);
    }
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  const copyLabel =
    copyState === "success" ? "Copied!" :
    copyState === "error"   ? "Copy failed" :
    "Copy to clipboard";

  const downloadLabel =
    downloadState === "success" ? "Downloaded!" :
    downloadState === "error"   ? "Download failed" :
    "Download as JSON";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 text-sm">

      {/* ── Toggle button ───────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-controls={regionId}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-slate-600 hover:bg-slate-100 rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 min-h-[44px]"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="text-base">🔍</span>
          <span className="font-medium">Generate diagnostics bundle</span>
          <span className="text-xs text-slate-400 font-normal hidden sm:inline">
            — local only, never sent automatically
          </span>
        </span>
        {/* Chevron — rotates when expanded */}
        <svg
          aria-hidden="true"
          className={`w-4 h-4 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* ── Expanded region ──────────────────────────────────────────────── */}
      {isExpanded && (
        <div
          id={regionId}
          ref={regionRef}
          role="region"
          aria-labelledby={headingId}
          className="border-t border-slate-200 px-4 pb-4 pt-3 space-y-4"
        >
          <h3
            id={headingId}
            className="font-semibold text-slate-700"
          >
            Diagnostics bundle
          </h3>

          {/* ── What is included ──────────────────────────────────────── */}
          <div className="space-y-2">
            <p className="text-slate-600 text-xs leading-relaxed">
              The bundle is a JSON file containing context that helps diagnose
              why a transaction failed. It is generated entirely in your browser
              and is only shared when you explicitly copy or download it.
              No data is sent to any server automatically.
            </p>

            <details className="group">
              <summary className="cursor-pointer list-none flex items-center gap-1 text-xs text-brand-700 hover:text-brand-900 font-medium select-none">
                <svg
                  aria-hidden="true"
                  className="w-3 h-3 transition-transform group-open:rotate-90"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                What's included / excluded
              </summary>

              <div className="mt-2 grid sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="font-semibold text-slate-600 mb-1">
                    <span aria-hidden="true">✓ </span>Included
                  </p>
                  <ul className="space-y-0.5 text-slate-500">
                    {INCLUDED_FIELDS.map((f) => (
                      <li key={f} className="flex gap-1">
                        <span aria-hidden="true" className="text-green-500 shrink-0">•</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <p className="font-semibold text-slate-600 mb-1">
                    <span aria-hidden="true">✗ </span>Never included
                  </p>
                  <ul className="space-y-0.5 text-slate-500">
                    {EXCLUDED_FIELDS.map((f) => (
                      <li key={f} className="flex gap-1">
                        <span aria-hidden="true" className="text-red-400 shrink-0">•</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </details>
          </div>

          {/* ── Action buttons ─────────────────────────────────────────── */}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Diagnostics bundle actions">

            {/* Copy button */}
            <button
              type="button"
              onClick={handleCopy}
              aria-describedby={copyStatusId}
              className={`
                inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium
                transition-colors min-h-[44px]
                focus:outline-none focus:ring-2 focus:ring-brand-500
                ${copyState === "success"
                  ? "border-green-300 bg-green-50 text-green-700"
                  : copyState === "error"
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400"
                }
              `}
            >
              {/* Icon */}
              {copyState === "success" ? (
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : copyState === "error" ? (
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
              {copyLabel}
            </button>

            {/* Visually hidden live region for copy state */}
            <span
              id={copyStatusId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {copyState === "success" ? "Diagnostics bundle copied to clipboard." :
               copyState === "error"   ? "Failed to copy. Try the download option." :
               ""}
            </span>

            {/* Download button */}
            <button
              type="button"
              onClick={handleDownload}
              aria-describedby={dlStatusId}
              className={`
                inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium
                transition-colors min-h-[44px]
                focus:outline-none focus:ring-2 focus:ring-brand-500
                ${downloadState === "success"
                  ? "border-green-300 bg-green-50 text-green-700"
                  : downloadState === "error"
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400"
                }
              `}
            >
              {downloadState === "success" ? (
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : downloadState === "error" ? (
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              )}
              {downloadLabel}
            </button>

            {/* Visually hidden live region for download state */}
            <span
              id={dlStatusId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {downloadState === "success" ? "Diagnostics bundle downloaded." :
               downloadState === "error"   ? "Download failed. Try copying instead." :
               ""}
            </span>
          </div>

          {/* ── Privacy note ──────────────────────────────────────────── */}
          <p className="text-xs text-slate-400 leading-relaxed border-t border-slate-100 pt-3">
            This bundle is generated locally and is never submitted to a server.
            Share it only with people you trust to help diagnose the issue.
            Wallet keys, addresses, and transaction hashes are always redacted
            before the bundle is created.
          </p>
        </div>
      )}
    </div>
  );
}
