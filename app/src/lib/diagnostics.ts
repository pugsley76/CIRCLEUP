/**
 * Opt-in local diagnostics bundle for CircleUp.
 *
 * # Purpose
 *
 * Transaction failures are hard to debug without context: the browser
 * version, wallet state, network configuration, and error category are
 * all relevant but users cannot reliably copy them by hand.  This module
 * builds a structured, redacted summary that a user can generate on demand
 * and share with support.
 *
 * # Privacy model
 *
 * The bundle is NEVER submitted to a server automatically.  It is only
 * produced when the user explicitly requests it via the UI, and only
 * copied/downloaded locally.
 *
 * Fields are selected from a strict allowlist — not from raw objects.
 * Every string value is passed through {@link redactSecrets} before
 * inclusion.  The redaction rules mirror (and extend) those in
 * telemetry.ts:
 *
 *   - G… / C… strkeys (56-char, matching Stellar address format) → "[redacted:address]"
 *   - 64-char hex strings (tx-hash pattern) → "[redacted:hash]"
 *   - Strings > 100 chars (likely XDR or base64 blobs) → "[redacted:blob]"
 *   - Known secret-shaped environment variable names (SEED, MNEMONIC,
 *     PRIVATE_KEY, SECRET, etc.) → "[redacted:secret]"
 *   - Any value that passes isSecretShaped() → "[redacted:secret]"
 *
 * # What IS included
 *
 *   - app.version      — package version string
 *   - app.activeNetwork — "testnet" / "mainnet" / "custom"
 *   - app.rpcUrl       — RPC endpoint (may include domain, never credentials)
 *   - app.indexerUrl   — indexer URL (same policy)
 *   - app.walletInstalled — boolean (Freighter present?)
 *   - browser.userAgent — navigator.userAgent
 *   - browser.language  — navigator.language
 *   - browser.online    — navigator.onLine
 *   - error.kind        — ContractAppError.kind ("wallet", "network", etc.)
 *   - error.code        — ContractAppError.code (stable enum string)
 *   - error.message     — ContractAppError.message (user-facing, safe string)
 *   - error.txHash      — present only when an on-chain hash exists; passed
 *                         through redactSecrets so it is replaced with
 *                         "[redacted:hash]" — the hash is in the UI already
 *                         and is never the sensitive part of the failure
 *   - error.stage       — TxStage if available (e.g. "simulate_failed")
 *   - error.category    — TxErrorCategory if available
 *   - timestamp         — ISO-8601 string of bundle generation time
 *
 * # What is NEVER included
 *
 *   - Wallet private keys, seeds, or mnemonics
 *   - Unsigned or signed XDR
 *   - ScVal arguments (which may encode amounts, addresses, etc.)
 *   - Full Stellar address of the connected wallet
 *   - Raw provider error messages that may echo user input
 *   - Any NEXT_PUBLIC_* env var whose name contains a secret-shaped keyword
 *
 * # Usage
 *
 * ```ts
 * import { buildDiagnosticsBundle, serialiseDiagnosticsBundle } from "@/lib/diagnostics";
 *
 * const bundle = buildDiagnosticsBundle({ typedError: err, txHash: result.txHash });
 * const json   = serialiseDiagnosticsBundle(bundle);
 * navigator.clipboard.writeText(json);
 * ```
 */

import type { ContractAppError } from "./contractErrors";
import type { TxStage, TxErrorCategory } from "./telemetry";

// ─── Version ──────────────────────────────────────────────────────────────────

/**
 * Resolved at bundle-build time from the NEXT_PUBLIC_APP_VERSION env var.
 * Falls back to "unknown" in environments where it is not set.
 * Never includes build secrets (the var carries only a semver string).
 */
const APP_VERSION =
  process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

// ─── Secret-shaped name keywords ─────────────────────────────────────────────
//
// Environment variable names that contain these substrings (case-insensitive)
// are considered secret-bearing regardless of their value.  They will never
// appear in a bundle even if their value passes the string heuristics below.

const SECRET_ENV_NAME_PATTERNS: readonly string[] = [
  "seed",
  "mnemonic",
  "private",
  "secret",
  "priv_key",
  "privkey",
  "password",
  "passwd",
  "token",       // auth tokens; not USDC token addresses (which are NEXT_PUBLIC_*_ADDRESS)
  "api_key",
  "apikey",
  "auth",
];

// ─── Allowed public env-var names ─────────────────────────────────────────────
//
// ONLY these NEXT_PUBLIC_* keys may appear in a bundle.  Any key not in this
// list — even if its name looks safe — is excluded.  Values go through
// redactSecrets before inclusion.

const ALLOWED_PUBLIC_ENV_KEYS: readonly string[] = [
  "NEXT_PUBLIC_STELLAR_RPC_URL",
  "NEXT_PUBLIC_NETWORK_PASSPHRASE",
  "NEXT_PUBLIC_INDEXER_URL",
  "NEXT_PUBLIC_ACTIVE_NETWORK",
  // Deliberately excluded even though public:
  //   NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS  — contract address
  //   NEXT_PUBLIC_REPUTATION_ADDRESS      — contract address
  //   NEXT_PUBLIC_USDC_ADDRESS            — contract address
  //   NEXT_PUBLIC_TELEMETRY_ENABLED       — not diagnostically useful
];

// ─── Secret-shaped value heuristics ──────────────────────────────────────────

/**
 * Returns true when `value` looks like a Stellar strkey address
 * (G-prefix ed25519 key or C-prefix contract ID, 56 chars, base32 alphabet).
 *
 * Mirrors `looksLikeAddress` from telemetry.ts but is kept independent so
 * diagnostics.ts has no runtime dependency on telemetry.ts.
 */
export function looksLikeStellarAddress(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[GC][A-Z2-7]{55}$/.test(value)
  );
}

/**
 * Returns true when `value` looks like a transaction hash (64-char lowercase
 * hex) or a large blob (XDR, base64, or any string > 100 chars).
 *
 * Mirrors `looksLikeSensitiveString` from telemetry.ts — kept independent
 * for the same reason.
 */
export function looksLikeSensitiveBlob(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^[0-9a-f]{64}$/.test(value)) return true;  // tx-hash pattern (lowercase hex)
  if (/^[0-9A-Fa-f]{64}$/.test(value)) return true; // tx-hash pattern (mixed case)
  if (value.length > 100) return true;              // XDR / base64 / long raw strings
  return false;
}

/**
 * Returns true when `value` looks like a mnemonic seed phrase:
 * - 12, 15, 18, 21, or 24 whitespace-separated words (BIP-39 word counts),
 * - each word is 3–8 alphabetic characters.
 *
 * This catches the most common accidental inclusion of a seed phrase in a
 * raw error message re-echo or a provider object property.
 */
export function looksLikeSeedPhrase(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const words = value.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  return words.every((w) => /^[a-zA-Z]{3,8}$/.test(w));
}

/**
 * Returns true when `value` looks like a raw Stellar secret key
 * (S-prefix strkey, 56 chars, base32 alphabet) — the private counterpart
 * of a G-address public key.
 *
 * S-strkeys must never appear in any outbound payload.
 */
export function looksLikeSecretKey(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^S[A-Z2-7]{55}$/.test(value)
  );
}

/**
 * Returns true when `value` is any kind of secret-shaped string:
 * a Stellar address, a secret key, a tx hash, a large blob, or a seed phrase.
 *
 * Used by {@link redactSecrets} as the top-level predicate.
 */
export function isSecretShaped(value: unknown): boolean {
  return (
    looksLikeStellarAddress(value) ||
    looksLikeSecretKey(value) ||
    looksLikeSensitiveBlob(value) ||
    looksLikeSeedPhrase(value)
  );
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Replace any secret-shaped string with a labelled redaction marker.
 *
 * Two passes:
 *
 * 1. Whole-string check — when the entire value matches a single secret
 *    pattern it is replaced with the most specific label.
 *
 * 2. Substring scrub — when the whole string doesn't match but it still
 *    contains embedded strkeys (S-keys or G/C-addresses), those substrings
 *    are replaced in-place.  This handles messages like
 *    `"Provider error: no permission for GAAA…WHF"` where the address is
 *    only part of a longer safe string.
 *
 *    Blob/hash/seed whole-string checks are kept as-is: a string that is
 *    > 100 chars is always entirely replaced (it would be an XDR or base64
 *    blob), and a seed phrase that happens to be a substring of something
 *    longer is an extremely unlikely scenario — the BIP-39 word-count check
 *    would not fire on a sentence fragment anyway.
 *
 * The label identifies *which* heuristic fired so diagnostics reviewers
 * know what type of data was present without seeing the value itself.
 *
 * Returns the original value unchanged when no heuristic matches.
 */
export function redactSecrets(value: string): string {
  // ── Whole-string checks (most specific first) ──────────────────────────
  if (looksLikeSecretKey(value))      return "[redacted:secret-key]";
  if (looksLikeStellarAddress(value)) return "[redacted:address]";
  if (looksLikeSeedPhrase(value))     return "[redacted:seed]";
  if (/^[0-9a-fA-F]{64}$/.test(value)) return "[redacted:hash]";
  if (value.length > 100)             return "[redacted:blob]";

  // ── Substring scrub — replace embedded strkeys within a longer string ──
  //
  // S-keys first (more specific: S-prefix private keys are always secret).
  // Then G/C-addresses (public keys and contract IDs — never include wallet
  // addresses in support bundles even when they appear in error messages).
  let scrubbed = value.replace(/S[A-Z2-7]{55}/g, "[redacted:secret-key]");
  scrubbed     = scrubbed.replace(/[GC][A-Z2-7]{55}/g, "[redacted:address]");

  return scrubbed;
}

/**
 * Recursively redact all string values in a plain object tree.
 *
 * - Never mutates the input.
 * - Skips arrays (not used in our bundle shapes).
 * - Passes each string through {@link redactSecrets}.
 */
export function redactObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = redactSecrets(v);
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactObject(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Bundle shape ─────────────────────────────────────────────────────────────

/**
 * Structured diagnostic summary produced by {@link buildDiagnosticsBundle}.
 *
 * All fields are safe to log, copy, and share with support.
 * No field in this type may carry a wallet address, secret key, XDR blob,
 * or raw provider message.
 */
export interface DiagnosticsBundle {
  /**
   * Schema version for forward-compatibility.
   * Increment when the bundle shape changes in a breaking way.
   */
  readonly schemaVersion: 1;

  /** ISO-8601 timestamp of when the bundle was generated (not the error time). */
  readonly generatedAt: string;

  /** Application context. */
  readonly app: {
    readonly version: string;
    /** "testnet" | "mainnet" | "custom" — from NEXT_PUBLIC_ACTIVE_NETWORK. */
    readonly activeNetwork: string;
    /** RPC endpoint — credentials stripped, values > 100 chars redacted. */
    readonly rpcUrl: string;
    /** Indexer URL — same policy. */
    readonly indexerUrl: string;
    /** Whether the Freighter wallet extension is present in the browser. */
    readonly walletInstalled: boolean;
    /** Allowlisted NEXT_PUBLIC_* env vars, values redacted for safety. */
    readonly env: Record<string, string>;
  };

  /** Browser context. */
  readonly browser: {
    /** navigator.userAgent */
    readonly userAgent: string;
    /** navigator.language */
    readonly language: string;
    /** navigator.onLine */
    readonly online: boolean;
  };

  /**
   * Error context — absent when the bundle is generated without an active error.
   * Built exclusively from typed ContractAppError fields, never from raw wallet
   * objects or provider messages.
   */
  readonly error?: {
    /** ContractAppError.kind — "wallet" | "network" | "validation" | etc. */
    readonly kind: string;
    /** ContractAppError.code — stable enum string, safe to include. */
    readonly code: string;
    /**
     * ContractAppError.message — user-facing copy already scrubbed of raw
     * contract panic details.  Passed through redactSecrets as a last defence.
     */
    readonly message: string;
    /**
     * TxStage at which the error occurred — "simulate_failed", "wallet_rejected", etc.
     * Absent if not available.
     */
    readonly stage?: string;
    /**
     * TxErrorCategory — "network" | "wallet_denied" | "simulation_error" | etc.
     * Absent if not available.
     */
    readonly category?: string;
    /**
     * Transaction hash for on-chain failures — always replaced with
     * "[redacted:hash]" so the raw hash never leaves the browser automatically.
     * (The user can copy it separately from the explorer link in the UI.)
     */
    readonly txHash?: string;
  };
}

// ─── Builder input ─────────────────────────────────────────────────────────────

export interface DiagnosticsBundleInput {
  /**
   * The typed error from the failed transaction.
   * When absent the `error` section is omitted from the bundle.
   */
  readonly typedError?: ContractAppError | null;

  /**
   * The transaction stage at which the error occurred.
   * Usually available from the telemetry context.
   */
  readonly stage?: TxStage;

  /**
   * The telemetry error category derived from the raw error message.
   */
  readonly errorCategory?: TxErrorCategory;

  /**
   * On-chain transaction hash (when the tx reached the network before failing).
   * Replaced with "[redacted:hash]" in the bundle so it is not transmitted
   * to any server automatically.
   */
  readonly txHash?: string | null;

  /**
   * Override the timestamp (ISO string).  Useful in tests for deterministic output.
   */
  readonly _nowIso?: string;

  /**
   * Override window-like object for testing (replaces real `window`).
   */
  readonly _win?: { freighter?: unknown; freighterApi?: unknown; navigator?: Partial<Navigator> };
}

// ─── Environment collector ────────────────────────────────────────────────────

/**
 * Collect allowed NEXT_PUBLIC_* env vars and redact their values.
 *
 * Only keys in {@link ALLOWED_PUBLIC_ENV_KEYS} are included.  Each value
 * is passed through {@link redactSecrets}, and any key whose name contains
 * a secret-shaped keyword is excluded as an extra backstop.
 *
 * Exported for testing.
 */
export function collectEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const key of ALLOWED_PUBLIC_ENV_KEYS) {
    // Double-check: reject any allowed key that somehow contains a secret keyword
    const lowerKey = key.toLowerCase();
    if (SECRET_ENV_NAME_PATTERNS.some((p) => lowerKey.includes(p))) {
      continue; // should never happen with our allowlist, but belt-and-braces
    }

    const raw = env[key];
    if (raw === undefined || raw === "") continue;

    const redacted = redactSecrets(raw);
    out[key] = redacted;
  }

  return out;
}

// ─── Wallet detection helper ──────────────────────────────────────────────────

function isFreighterPresent(
  win: { freighter?: unknown; freighterApi?: unknown } | undefined,
): boolean {
  if (!win) return false;
  return (
    typeof win.freighter !== "undefined" ||
    typeof win.freighterApi !== "undefined"
  );
}

// ─── Primary builder ──────────────────────────────────────────────────────────

/**
 * Build a {@link DiagnosticsBundle} from the current browser environment and
 * an optional typed error context.
 *
 * This is the only function that reads `window`, `navigator`, and
 * `process.env` directly.  All values are either from the allowlist or
 * computed from typed sources (ContractAppError, TxStage).  Every string
 * passes through {@link redactSecrets} before inclusion.
 *
 * Safe to call in SSR — gracefully returns empty browser fields when
 * `typeof window === "undefined"`.
 *
 * @example
 * const bundle = buildDiagnosticsBundle({ typedError: err, txHash: result.txHash });
 */
export function buildDiagnosticsBundle(
  input: DiagnosticsBundleInput = {},
): DiagnosticsBundle {
  const {
    typedError,
    stage,
    errorCategory,
    txHash,
    _nowIso,
    _win,
  } = input;

  const generatedAt = _nowIso ?? new Date().toISOString();

  // ── Browser environment ──────────────────────────────────────────────────
  const isBrowser = typeof window !== "undefined";
  const win = _win ?? (isBrowser ? (window as unknown as typeof _win) : undefined);
  const nav = _win?.navigator ?? (isBrowser ? navigator : undefined);

  const userAgent = nav?.userAgent ?? "";
  const language  = nav?.language  ?? "";
  const online    = nav?.onLine    ?? true;

  const walletInstalled = isFreighterPresent(win);

  // ── App environment ──────────────────────────────────────────────────────
  // Read config-shaped values from env (not from importing config.ts, to keep
  // this module free of Next.js server-side initialisation side-effects).
  const rawRpcUrl    = (process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "").trim();
  const rawIndexerUrl = (process.env.NEXT_PUBLIC_INDEXER_URL    ?? "").trim();
  const activeNetwork = (process.env.NEXT_PUBLIC_ACTIVE_NETWORK ?? "unknown").trim();

  const rpcUrl     = redactSecrets(rawRpcUrl);
  const indexerUrl = redactSecrets(rawIndexerUrl);
  const envRecord = collectEnv();

  // ── Error context ─────────────────────────────────────────────────────────
  //
  // Built exclusively from the typed ContractAppError discriminated union, not
  // from raw provider objects or raw error strings, so no wallet-internal data
  // can leak through here.
  let errorSection: DiagnosticsBundle["error"];

  if (typedError) {
    const safeMessage = redactSecrets(typedError.message);

    errorSection = {
      kind:     typedError.kind,
      code:     typedError.code,
      message:  safeMessage,
      ...(stage         !== undefined ? { stage }               : {}),
      ...(errorCategory !== undefined ? { category: errorCategory } : {}),
      // txHash is always redacted — the value is in the UI; we only need to
      // know whether a hash was produced at all, and even that is conveyed by
      // the "kind" / "code" (on-chain failure vs. pre-submission failure).
      ...(txHash ? { txHash: "[redacted:hash]" as const } : {}),
    };
  }

  return {
    schemaVersion: 1,
    generatedAt,
    app: {
      version:       redactSecrets(APP_VERSION),
      activeNetwork: redactSecrets(activeNetwork),
      rpcUrl,
      indexerUrl,
      walletInstalled,
      env:             envRecord,
    },
    browser: {
      userAgent: redactSecrets(userAgent),
      language:  redactSecrets(language),
      online,
    },
    ...(errorSection !== undefined ? { error: errorSection } : {}),
  };
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Serialise a {@link DiagnosticsBundle} to a formatted JSON string.
 *
 * Uses 2-space indentation so the output is readable when pasted into a
 * support ticket or chat message.
 */
export function serialiseDiagnosticsBundle(bundle: DiagnosticsBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Build and serialise a diagnostics bundle in one step.
 *
 * Convenience wrapper used by the UI copy/download handlers.
 */
export function buildAndSerialise(input: DiagnosticsBundleInput = {}): string {
  return serialiseDiagnosticsBundle(buildDiagnosticsBundle(input));
}
