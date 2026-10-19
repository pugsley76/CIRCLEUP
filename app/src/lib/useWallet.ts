/**
 * Wallet state management hook for the CircleUp app.
 *
 * Provides a single source of truth for wallet connection state, capabilities,
 * and error handling. Components can use this hook instead of managing wallet
 * state independently.
 *
 * Usage:
 *   const { address, isConnected, isInstalling, capabilities, error, connect } = useWallet();
 */

"use client";
import { useState, useEffect, useCallback } from "react";
import {
  getWalletAddress,
  connectWallet,
  isFreighterInstalled,
  WalletError,
  type WalletErrorReason,
} from "./stellar";
import { detectWalletCapabilities, explainUnsupportedAction, type WalletCapabilities } from "./walletCapabilities";

export interface WalletState {
  /** Connected wallet address, or null if not connected. */
  address: string | null;
  /** Whether the wallet is currently connected. */
  isConnected: boolean;
  /** Whether a connection attempt is in progress. */
  isConnecting: boolean;
  /** Whether the Freighter extension is installed. */
  isInstalled: boolean;
  /** Wallet capabilities (only available when connected). */
  capabilities: WalletCapabilities | null;
  /** Warning message if wallet has limited capabilities. */
  capabilityWarning: string | null;
  /** Last connection error, if any. */
  error: { reason: WalletErrorReason; message: string } | null;
  /** Trigger a wallet connection. Returns the address on success. */
  connect: () => Promise<string | null>;
  /** Clear the current error state. */
  clearError: () => void;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [capabilities, setCapabilities] = useState<WalletCapabilities | null>(null);
  const [capabilityWarning, setCapabilityWarning] = useState<string | null>(null);
  const [error, setError] = useState<{ reason: WalletErrorReason; message: string } | null>(null);

  // On mount: silently check whether wallet is already connected
  useEffect(() => {
    let cancelled = false;

    async function checkConnection() {
      try {
        const walletAddress = await getWalletAddress();
        if (cancelled) return;

        if (walletAddress) {
          setAddress(walletAddress);
          setIsInstalled(true);
          const caps = detectWalletCapabilities();
          setCapabilities(caps);
          const warning = explainUnsupportedAction("sign", caps);
          setCapabilityWarning(warning);
        } else {
          setIsInstalled(isFreighterInstalled());
        }
      } catch {
        if (!cancelled) {
          setIsInstalled(isFreighterInstalled());
        }
      }
    }

    checkConnection();
    return () => { cancelled = true; };
  }, []);

  const connect = useCallback(async (): Promise<string | null> => {
    setIsConnecting(true);
    setError(null);

    try {
      // First, check if the wallet is capable of connecting at all.
      const caps = detectWalletCapabilities();
      const connectWarning = explainUnsupportedAction("connect", caps);
      if (connectWarning) {
        throw new WalletError("unsupported_capability", connectWarning);
      }

      const pk = await connectWallet();
      setAddress(pk);
      setIsInstalled(true);

      // Re-detect capabilities and set capability warning for other actions
      // once connected, as capabilities might change or become clearer after connection.
      const updatedCaps = detectWalletCapabilities();
      setCapabilities(updatedCaps);
      const signWarning = explainUnsupportedAction("sign", updatedCaps);
      setCapabilityWarning(signWarning);

      return pk;
    } catch (err) {
      if (err instanceof WalletError) {
        const walletErr = { reason: err.reason, message: err.message };
        setError(walletErr);
        if (err.reason === "not_installed") {
          setIsInstalled(false);
        }
      } else {
        setError({
          reason: "unknown",
          message: (err as Error)?.message || "Failed to connect wallet.",
        });
      }
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    address,
    isConnected: address !== null,
    isConnecting,
    isInstalled,
    capabilities,
    capabilityWarning,
    error,
    connect,
    clearError,
  };
}
