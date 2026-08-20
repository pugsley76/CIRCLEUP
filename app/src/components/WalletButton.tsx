"use client";
import { useState, useEffect } from "react";
import { getWalletAddress, connectWallet, isFreighterInstalled, WalletError } from "@/lib/stellar";
import { shortAddress } from "@/lib/config";

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; address: string }
  | { status: "connecting" }
  | { status: "not_installed" }
  | { status: "error"; message: string };

export function WalletButton() {
  const [state, setState] = useState<ConnectionState>({ status: "checking" });

  // On mount: silently check whether wallet is already connected
  useEffect(() => {
    let cancelled = false;
    getWalletAddress().then((address) => {
      if (cancelled) return;
      if (address) {
        setState({ status: "connected", address });
      } else if (!isFreighterInstalled()) {
        setState({ status: "not_installed" });
      } else {
        setState({ status: "idle" });
      }
    });
    return () => { cancelled = true; };
  }, []);

  async function connect() {
    setState({ status: "connecting" });
    try {
      const address = await connectWallet();
      setState({ status: "connected", address });
    } catch (err) {
      if (err instanceof WalletError) {
        if (err.reason === "not_installed") {
          setState({ status: "not_installed" });
        } else {
          // permission_denied or unknown — show message but stay actionable
          setState({ status: "error", message: err.message });
        }
      } else {
        setState({
          status: "error",
          message: (err as Error)?.message || "Failed to connect wallet.",
        });
      }
    }
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  if (state.status === "connected") {
    return (
      <div className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 text-sm">
        <span className="w-2 h-2 rounded-full bg-brand-500 inline-block" aria-hidden="true" />
        <span className="font-mono text-brand-700">{shortAddress(state.address)}</span>
      </div>
    );
  }

  // ── Freighter not installed ───────────────────────────────────────────────
  if (state.status === "not_installed") {
    return (
      <a
        href="https://freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-amber-50 border border-amber-300 text-amber-800 px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-100 transition-colors"
        title="Freighter wallet is required to use CircleUp"
      >
        <span aria-hidden="true">🔌</span>
        Install Freighter
      </a>
    );
  }

  // ── Error (permission denied, etc.) ──────────────────────────────────────
  if (state.status === "error") {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={connect}
          className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
          title={state.message}
        >
          Retry Connection
        </button>
        <span
          className="text-xs text-red-600 max-w-[180px] truncate"
          title={state.message}
          aria-live="polite"
        >
          {state.message}
        </span>
      </div>
    );
  }

  // ── Checking / connecting / idle ──────────────────────────────────────────
  const isLoading = state.status === "checking" || state.status === "connecting";
  const label = state.status === "connecting" ? "Connecting…" : "Connect Freighter";

  return (
    <button
      onClick={connect}
      disabled={isLoading}
      className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50"
      aria-busy={isLoading}
    >
      {isLoading ? (
        <span className="flex items-center gap-1.5">
          <svg
            className="animate-spin h-3.5 w-3.5 text-white"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          {label}
        </span>
      ) : (
        label
      )}
    </button>
  );
}
