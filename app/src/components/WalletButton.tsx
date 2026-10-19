"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { getWalletAddress, connectWallet, isFreighterInstalled, WalletError, type WalletErrorReason } from "@/lib/stellar";
import { shortAddress, NETWORK_PASSPHRASE } from "@/lib/config";
import {
  detectWalletCapabilities,
  explainUnsupportedAction,
  checkNetworkMismatch,
  describeNetworkMismatch,
  type NetworkMismatchResult,
} from "@/lib/walletCapabilities";

// ─── Connection state ─────────────────────────────────────────────────────────
//
// "checking"    — initial silent probe: getWalletAddress() is in flight.
// "idle"        — extension installed but no account connected yet.
// "connecting"  — user clicked "Connect Freighter", prompt is open.
// "changing"    — provider fired accountChanged / networkChanged; re-probing.
// "connected"   — address known, capabilities checked, network verified.
// "limited"     — address known but wallet cannot sign transactions.
// "not_installed" — Freighter extension absent.
// "error"       — explicit connection error with a user-facing message.

type ConnectionState =
  | { status: "checking" }
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "changing" }
  | { status: "connected"; address: string; networkMismatch?: NetworkMismatchResult | null; capabilities?: { canSign: boolean; canGetNetwork: boolean } }
  | { status: "limited"; message: string; address?: string }
  | { status: "not_installed" }
  | { status: "error"; message: string; reason: WalletErrorReason }

// ─── Provider event shape ─────────────────────────────────────────────────────
//
// Freighter v2 exposes addEventListener on the injected provider for two
// events: "accountChanged" and "networkChanged". The callback receives an
// object with the new address / network details. We only need to know
// *that* a change happened — we always re-probe via getWalletAddress so we
// get the authoritative state rather than trusting the event payload.

type FreighterEventType = "accountChanged" | "networkChanged";

interface FreighterProvider {
  addEventListener?: (event: FreighterEventType, callback: (detail?: unknown) => void) => void;
  removeEventListener?: (event: FreighterEventType, callback: (detail?: unknown) => void) => void;
}

function getProvider(): FreighterProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { freighter?: unknown; freighterApi?: unknown };
  const p = w.freighter ?? w.freighterApi;
  if (!p || typeof p !== "object") return null;
  return p as FreighterProvider;
}

// ─── Network check helper ─────────────────────────────────────────────────────

async function runNetworkCheck(): Promise<NetworkMismatchResult | null> {
  let caps;
  try { caps = detectWalletCapabilities(); } catch { return null; }
  if (!caps || !caps.canGetNetwork) return null;
  try { return await checkNetworkMismatch(NETWORK_PASSPHRASE); } catch { return null; }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WalletButton() {
  const [state, setState] = useState<ConnectionState>({ status: "checking" });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Account resolution ──────────────────────────────────────────────────
  //
  // Runs on mount (silent probe) and whenever the provider fires an account-
  // or network-change event. Sets the final connected/disconnected/limited
  // state once the wallet address and capabilities are known.

  const resolveAccount = useCallback(async () => {
    let address: string | null;
    try {
      address = await getWalletAddress();
    } catch (err) {
      if (!mountedRef.current) return;
      // getWalletAddress only throws WalletError("not_installed") — but handle
      // all reasons explicitly so a permission_denied or unknown error during
      // the silent probe surfaces as an error state rather than the install link.
      if (err instanceof WalletError) {
        if (err.reason === "not_installed") {
          setState({ status: "not_installed" });
        } else {
          setState({ status: "error", message: err.message, reason: err.reason });
        }
      } else {
        // Non-WalletError (e.g. network failure talking to the extension).
        setState({
          status: "error",
          message: (err as Error)?.message || "An unexpected error occurred checking your wallet.",
          reason: "unknown",
        });
      }
      return;
    }

    if (!mountedRef.current) return;

    if (!address) {
      setState(isFreighterInstalled() ? { status: "idle" } : { status: "not_installed" });
      return;
    }

    let caps;
    try { caps = detectWalletCapabilities(); } catch { caps = null; }

    let signWarning: string | null = null;
    try { signWarning = caps ? explainUnsupportedAction("sign", caps) : null; } catch { signWarning = null; }

    if (signWarning) {
      if (mountedRef.current) setState({ status: "limited", message: signWarning, address });
      return;
    }

    const networkMismatch = await runNetworkCheck();
    if (!mountedRef.current) return;

    setState({
      status: "connected",
      address,
      networkMismatch,
      capabilities: caps
        ? { canSign: caps.canSignTransaction, canGetNetwork: caps.canGetNetwork }
        : undefined,
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount: silent probe ─────────────────────────────────────────────────
  useEffect(() => {
    void resolveAccount();
  }, [resolveAccount]);

  // ── Provider change listeners ───────────────────────────────────────────
  useEffect(() => {
    const provider = getProvider();
    if (!provider || typeof provider.addEventListener !== "function") return;

    const handleChange = () => {
      if (!mountedRef.current) return;
      setState({ status: "changing" });
      void resolveAccount();
    };

    provider.addEventListener("accountChanged", handleChange);
    provider.addEventListener("networkChanged", handleChange);

    return () => {
      if (typeof provider.removeEventListener === "function") {
        provider.removeEventListener("accountChanged", handleChange);
        provider.removeEventListener("networkChanged", handleChange);
      }
    };
  }, [resolveAccount]);

  // ── Connect handler ─────────────────────────────────────────────────────
  async function connect() {
    setState({ status: "connecting" });
    try {
      const address = await connectWallet();
      if (!mountedRef.current) return;

      let caps;
      try { caps = detectWalletCapabilities(); } catch { caps = null; }

      let signWarning: string | null = null;
      try { signWarning = caps ? explainUnsupportedAction("sign", caps) : null; } catch { signWarning = null; }


      if (signWarning) {
        setState({ status: "limited", message: signWarning, address });
        return;
      }

      const networkMismatch = await runNetworkCheck();
      if (!mountedRef.current) return;

      setState({
        status: "connected",
        address,
        networkMismatch,
        capabilities: caps
          ? { canSign: caps.canSignTransaction, canGetNetwork: caps.canGetNetwork }
          : undefined,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof WalletError) {
        setState(err.reason === "not_installed"
          ? { status: "not_installed" }
          : { status: "error", message: err.message, reason: err.reason });
      } else {
        setState({ status: "error", message: (err as Error)?.message || "Failed to connect wallet.", reason: "unknown" });
      }
    }
  }

  // ── Render: connected ───────────────────────────────────────────────────
  if (state.status === "connected") {
    const mismatchMessage =
      state.networkMismatch && state.networkMismatch.kind !== "match"
        ? describeNetworkMismatch(state.networkMismatch)
        : null;

    return (
      <>
        {/*
          Announce connection to screen readers. `key={state.address}` remounts
          the node on account switch so the live region re-fires for the new address.
        */}
        <span
          key={state.address}
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {`Wallet connected: ${state.address}`}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 text-sm">
            <span className="w-2 h-2 rounded-full bg-brand-500 inline-block" aria-hidden="true" />
            <span className="font-mono text-brand-700">{shortAddress(state.address)}</span>
          </div>
          {mismatchMessage && (
            <span
              className="text-xs text-red-600 max-w-[180px] truncate"
              title={mismatchMessage}
              aria-live="polite"
              role="alert"
            >
              ⚠ {mismatchMessage}
            </span>
          )}
        </div>
      </>
    );
  }

  // ── Render: limited capabilities ────────────────────────────────────────
  if (state.status === "limited") {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm">
          {state.address && (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" aria-hidden="true" />
              <span className="font-mono text-amber-700">{shortAddress(state.address)}</span>
            </>
          )}
        </div>
        <span className="text-xs text-amber-600 max-w-[180px] truncate" title={state.message} aria-live="polite">
          {state.message}
        </span>
      </div>
    );
  }

  // ── Not installed ───────────────────────────────────────────────────────
  if (state.status === "not_installed") {
    return (
      <a
        href="https://freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 bg-amber-50 border border-amber-300 text-amber-800 px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
        title="Freighter wallet is required to use CircleUp"
      >
        <span aria-hidden="true">🔌</span>
        Install Freighter
      </a>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────
  //
  // Each WalletErrorReason maps to distinct guidance so the user knows their
  // exact next step — not a generic "something went wrong" dead end.
  //
  //  permission_denied   — wallet is installed; user dismissed the prompt
  //  not_installed       — should have been caught above; belt-and-suspenders
  //  unsupported_capability — wallet version too old / wrong provider
  //  unknown             — network/RPC failure or unclassified extension error
  if (state.status === "error") {
    const guidanceMap: Record<WalletErrorReason, string> = {
      permission_denied:
        "You dismissed the Freighter prompt. Click Retry to try again.",
      not_installed:
        "Freighter does not appear to be installed. Install it and reload the page.",
      unsupported_capability:
        "Your version of Freighter does not support this action. Update the extension and try again.",
      unknown:
        "A connection error occurred. Check that Freighter is unlocked and try again.",
    };
    const guidance = guidanceMap[state.reason] ?? guidanceMap.unknown;
    const errorPanelId = "wallet-error-panel";

    return (
      <div className="flex items-center gap-2">
        <button
          onClick={connect}
          aria-describedby={errorPanelId}
          className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Retry Connection
        </button>
        {/*
          Full error message + guidance in a visible, non-truncated panel.
          - role="alert" announces immediately to screen readers.
          - aria-live="polite" ensures subsequent updates are announced too.
          - The technical error message is in a <p> so it can be read in full
            without relying on a tooltip (which keyboard users cannot access).
        */}
        <div
          id={errorPanelId}
          role="alert"
          aria-live="polite"
          className="flex flex-col gap-0.5 text-xs max-w-[220px]"
        >
          <span className="text-red-600 font-medium">{guidance}</span>
          {state.message && state.message !== guidance && (
            <span className="text-slate-500 break-words">{state.message}</span>
          )}
        </div>
      </div>
    );
  }

  // ── Checking / Connecting / Changing / Idle ─────────────────────────────
  const isLoading =
    state.status === "checking" ||
    state.status === "connecting" ||
    state.status === "changing";

  const label =
    state.status === "connecting" ? "Connecting…"
    : state.status === "changing" ? "Updating…"
    : "Connect Freighter";

  return (
    <button
      onClick={connect}
      disabled={isLoading}
      className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      aria-busy={isLoading}
    >
      {isLoading ? (
        <span className="flex items-center gap-1.5">
          <svg className="animate-spin h-3.5 w-3.5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
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
