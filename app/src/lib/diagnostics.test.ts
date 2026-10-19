/**
 * Tests for app/src/lib/diagnostics.ts
 *
 * Test groups
 * -----------
 * 1. Secret detection predicates
 *    - looksLikeStellarAddress: G-keys, C-keys, non-addresses
 *    - looksLikeSecretKey: S-keys (private counterpart of G-key)
 *    - looksLikeSensitiveBlob: 64-hex tx hashes, long strings
 *    - looksLikeSeedPhrase: 12/24-word BIP-39 patterns
 *    - isSecretShaped: union of all predicates
 *
 * 2. redactSecrets — value-level redaction
 *    - S-key → "[redacted:secret-key]"
 *    - G-address → "[redacted:address]"
 *    - C-address → "[redacted:address]"
 *    - 64-hex tx hash → "[redacted:hash]"
 *    - XDR / long blob → "[redacted:blob]"
 *    - Seed phrase (12 / 24 words) → "[redacted:seed]"
 *    - Safe short strings → pass through unchanged
 *    - Arbitrary provider error messages → pass through (or redact if blob)
 *
 * 3. redactObject — recursive object redaction
 *    - Nested sensitive values are redacted
 *    - Safe values survive
 *    - Input is not mutated
 *
 * 4. collectEnv — allowlist filtering
 *    - Only ALLOWED_PUBLIC_ENV_KEYS are included
 *    - Secret-bearing env var names are excluded even when on allowlist
 *    - Values are redacted
 *    - Missing keys are absent (not set to "")
 *
 * 5. buildDiagnosticsBundle — full bundle shape
 *    - schemaVersion is 1
 *    - generatedAt is a valid ISO-8601 string
 *    - app section present with expected keys
 *    - browser section present with expected keys
 *    - error section absent when no typedError passed
 *    - error section present and correct when typedError passed
 *    - txHash in bundle is always "[redacted:hash]" regardless of input
 *    - error.message is redacted when it accidentally contains a G-address
 *    - Seeds, private keys, XDR blobs are absent from every top-level field
 *
 * 6. Acceptance criteria — secrets absent from serialised output
 *    - The JSON string produced by buildAndSerialise must not contain:
 *        any S-strkey, any raw 12/24-word seed phrase, any raw tx-hash hex,
 *        any XDR blob, any raw unfiltered environment value marked as secret
 *    - env values from SECRET_ENV_NAME_PATTERNS names never appear
 *
 * Design constraints
 * ------------------
 * - No live RPC, no Freighter, no DOM — pure function tests.
 * - The _nowIso and _win injection hooks on DiagnosticsBundleInput allow
 *   deterministic / headless testing.
 * - All synthetic fixtures are structurally valid but not real credentials.
 */

import { describe, test, beforeEach } from "vitest";
import assert from "node:assert/strict";

import {
  looksLikeStellarAddress,
  looksLikeSecretKey,
  looksLikeSensitiveBlob,
  looksLikeSeedPhrase,
  isSecretShaped,
  redactSecrets,
  redactObject,
  collectEnv,
  buildDiagnosticsBundle,
  buildAndSerialise,
  serialiseDiagnosticsBundle,
  type DiagnosticsBundle,
} from "./diagnostics";
import type { ContractAppError } from "./contractErrors";

// ─── Synthetic fixtures ───────────────────────────────────────────────────────
//
// All values below are structurally valid but are NOT real credentials.
// G_ADDR and C_ADDR pass the regex for Stellar strkeys but are all-A pads that
// would fail a real checksum — they exist only to exercise the shape heuristics.

/** Synthetic G-address (ed25519 public key, 56 chars, valid base32 alphabet). */
const G_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Synthetic C-address (contract ID, 56 chars). */
const C_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

/**
 * Synthetic S-key (private key strkey, 56 chars).
 * NOT a real key — padded with A characters.  Real S-keys have a different
 * checksum; this exercises the /^S[A-Z2-7]{55}$/ shape heuristic only.
 */
const S_KEY = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2FO";

/** Synthetic tx hash (64 lowercase hex chars). */
const TX_HASH = "a".repeat(64);

/** Synthetic tx hash (64 uppercase hex chars — mixed-case variant). */
const TX_HASH_UPPER = "A".repeat(64);

/** XDR-length blob (> 100 chars). */
const XDR_BLOB = "AAAA".repeat(40); // 160 chars

/** 12-word BIP-39 mnemonic (synthetic — all valid 3-5 char words). */
const SEED_12 = "word word word word word word word word word word word word";

/** 24-word BIP-39 mnemonic (synthetic). */
const SEED_24 = Array(24).fill("word").join(" ");

/** A short safe string that must never be redacted. */
const SAFE_SHORT = "contribute";

/** A longer safe string under the 100-char threshold. */
const SAFE_MEDIUM = "The round deadline has passed. You can no longer contribute.";

/** Synthetic ISO timestamp for deterministic bundle output. */
const FIXED_ISO = "2026-10-16T10:00:00.000Z";

/** Minimal fake window with Freighter present. */
const WIN_WITH_FREIGHTER = {
  freighter: {},
  navigator: { userAgent: "TestAgent/1.0", language: "en-US", onLine: true },
};

/** Minimal fake window without Freighter. */
const WIN_WITHOUT_FREIGHTER = {
  navigator: { userAgent: "TestAgent/1.0", language: "en-US", onLine: false },
};

// ─── Typed error fixtures ─────────────────────────────────────────────────────

const WALLET_ERROR: ContractAppError = {
  kind: "wallet",
  code: "WALLET_REJECTED",
  message: "You cancelled the transaction in Freighter. No funds were moved.",
};

const NETWORK_ERROR: ContractAppError = {
  kind: "network",
  code: "NETWORK_TIMEOUT",
  message: "The transaction timed out waiting for confirmation.",
};

const UNKNOWN_ERROR: ContractAppError = {
  kind: "unknown",
  code: "UNKNOWN",
  message: "An unexpected error occurred.",
  raw: "some raw contract panic string",
};

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a bundle with a fixed timestamp and headless window so tests are
 * deterministic and don't touch the real browser environment.
 */
function headlessBundle(
  input: Parameters<typeof buildDiagnosticsBundle>[0] = {},
): DiagnosticsBundle {
  return buildDiagnosticsBundle({
    _nowIso: FIXED_ISO,
    _win: WIN_WITHOUT_FREIGHTER,
    ...input,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Secret detection predicates
// ═════════════════════════════════════════════════════════════════════════════

describe("looksLikeStellarAddress", () => {
  test("G-address (56-char ed25519 key) is detected", () => {
    assert.equal(looksLikeStellarAddress(G_ADDR), true);
  });

  test("C-address (56-char contract ID) is detected", () => {
    assert.equal(looksLikeStellarAddress(C_ADDR), true);
  });

  test("55-char G-string is not flagged (too short)", () => {
    assert.equal(looksLikeStellarAddress("G" + "A".repeat(54)), false);
  });

  test("57-char G-string is not flagged (too long)", () => {
    assert.equal(looksLikeStellarAddress("G" + "A".repeat(56)), false);
  });

  test("S-key is not flagged by this predicate (different prefix)", () => {
    // S-keys are caught by looksLikeSecretKey — not this predicate
    assert.equal(looksLikeStellarAddress(S_KEY), false);
  });

  test("lowercase hex string is not flagged", () => {
    assert.equal(looksLikeStellarAddress(TX_HASH), false);
  });

  test("non-string values return false", () => {
    assert.equal(looksLikeStellarAddress(null), false);
    assert.equal(looksLikeStellarAddress(42), false);
    assert.equal(looksLikeStellarAddress(undefined), false);
    assert.equal(looksLikeStellarAddress({}), false);
  });

  test("safe short string is not flagged", () => {
    assert.equal(looksLikeStellarAddress(SAFE_SHORT), false);
  });
});

describe("looksLikeSecretKey", () => {
  test("S-key (56-char, S-prefix, base32) is detected", () => {
    assert.equal(looksLikeSecretKey(S_KEY), true);
  });

  test("G-address is not flagged (different prefix)", () => {
    assert.equal(looksLikeSecretKey(G_ADDR), false);
  });

  test("C-address is not flagged", () => {
    assert.equal(looksLikeSecretKey(C_ADDR), false);
  });

  test("55-char S-string is not flagged (too short)", () => {
    assert.equal(looksLikeSecretKey("S" + "A".repeat(54)), false);
  });

  test("non-string returns false", () => {
    assert.equal(looksLikeSecretKey(null), false);
    assert.equal(looksLikeSecretKey(42), false);
  });
});

describe("looksLikeSensitiveBlob", () => {
  test("64-char lowercase hex string (tx hash) is flagged", () => {
    assert.equal(looksLikeSensitiveBlob(TX_HASH), true);
  });

  test("64-char uppercase hex string is flagged", () => {
    assert.equal(looksLikeSensitiveBlob(TX_HASH_UPPER), true);
  });

  test("string longer than 100 chars (XDR/blob) is flagged", () => {
    assert.equal(looksLikeSensitiveBlob(XDR_BLOB), true);
  });

  test("63-char hex string is not flagged", () => {
    assert.equal(looksLikeSensitiveBlob("a".repeat(63)), false);
  });

  test("string of exactly 100 chars is not flagged (boundary is > 100)", () => {
    assert.equal(looksLikeSensitiveBlob("A".repeat(100)), false);
  });

  test("string of 101 chars IS flagged", () => {
    assert.equal(looksLikeSensitiveBlob("A".repeat(101)), true);
  });

  test("safe short strings are not flagged", () => {
    assert.equal(looksLikeSensitiveBlob(SAFE_SHORT), false);
    assert.equal(looksLikeSensitiveBlob("network error"), false);
  });

  test("non-string returns false", () => {
    assert.equal(looksLikeSensitiveBlob(null), false);
    assert.equal(looksLikeSensitiveBlob(42), false);
  });
});

describe("looksLikeSeedPhrase", () => {
  test("12-word phrase is detected", () => {
    assert.equal(looksLikeSeedPhrase(SEED_12), true);
  });

  test("24-word phrase is detected", () => {
    assert.equal(looksLikeSeedPhrase(SEED_24), true);
  });

  test("15-word phrase is detected (BIP-39 valid count)", () => {
    assert.equal(looksLikeSeedPhrase(Array(15).fill("word").join(" ")), true);
  });

  test("18-word phrase is detected", () => {
    assert.equal(looksLikeSeedPhrase(Array(18).fill("word").join(" ")), true);
  });

  test("21-word phrase is detected", () => {
    assert.equal(looksLikeSeedPhrase(Array(21).fill("word").join(" ")), true);
  });

  test("11-word phrase is NOT flagged (not a BIP-39 count)", () => {
    assert.equal(looksLikeSeedPhrase(Array(11).fill("word").join(" ")), false);
  });

  test("13-word phrase is NOT flagged", () => {
    assert.equal(looksLikeSeedPhrase(Array(13).fill("word").join(" ")), false);
  });

  test("12 words where one is too long (> 8 chars) is NOT flagged", () => {
    const words = Array(11).fill("word").concat(["toolongword"]);
    assert.equal(looksLikeSeedPhrase(words.join(" ")), false);
  });

  test("12 words where one is too short (< 3 chars) is NOT flagged", () => {
    const words = Array(11).fill("word").concat(["ab"]);
    assert.equal(looksLikeSeedPhrase(words.join(" ")), false);
  });

  test("12 words containing digits is NOT flagged (not alphabetic)", () => {
    const words = Array(11).fill("word").concat(["word1"]);
    assert.equal(looksLikeSeedPhrase(words.join(" ")), false);
  });

  test("normal sentence of 12 words with punctuation is NOT flagged", () => {
    assert.equal(looksLikeSeedPhrase("The quick brown fox jumps over the lazy dog today more words!"), false);
  });

  test("non-string returns false", () => {
    assert.equal(looksLikeSeedPhrase(null), false);
    assert.equal(looksLikeSeedPhrase(42), false);
  });
});

describe("isSecretShaped — union predicate", () => {
  test("G-address is secret-shaped", () => {
    assert.equal(isSecretShaped(G_ADDR), true);
  });

  test("C-address is secret-shaped", () => {
    assert.equal(isSecretShaped(C_ADDR), true);
  });

  test("S-key is secret-shaped", () => {
    assert.equal(isSecretShaped(S_KEY), true);
  });

  test("64-hex tx hash is secret-shaped", () => {
    assert.equal(isSecretShaped(TX_HASH), true);
  });

  test("XDR blob is secret-shaped", () => {
    assert.equal(isSecretShaped(XDR_BLOB), true);
  });

  test("12-word seed phrase is secret-shaped", () => {
    assert.equal(isSecretShaped(SEED_12), true);
  });

  test("safe short string is NOT secret-shaped", () => {
    assert.equal(isSecretShaped(SAFE_SHORT), false);
  });

  test("safe medium-length error message is NOT secret-shaped", () => {
    assert.equal(isSecretShaped(SAFE_MEDIUM), false);
  });

  test("non-string values are NOT secret-shaped", () => {
    assert.equal(isSecretShaped(null), false);
    assert.equal(isSecretShaped(42), false);
    assert.equal(isSecretShaped(true), false);
    assert.equal(isSecretShaped({}), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. redactSecrets — value-level redaction
// ═════════════════════════════════════════════════════════════════════════════

describe("redactSecrets", () => {
  test("S-key → '[redacted:secret-key]'", () => {
    assert.equal(redactSecrets(S_KEY), "[redacted:secret-key]");
  });

  test("G-address → '[redacted:address]'", () => {
    assert.equal(redactSecrets(G_ADDR), "[redacted:address]");
  });

  test("C-address → '[redacted:address]'", () => {
    assert.equal(redactSecrets(C_ADDR), "[redacted:address]");
  });

  test("64-hex tx hash → '[redacted:hash]'", () => {
    assert.equal(redactSecrets(TX_HASH), "[redacted:hash]");
    assert.equal(redactSecrets(TX_HASH_UPPER), "[redacted:hash]");
  });

  test("XDR blob (> 100 chars, not hex) → '[redacted:blob]'", () => {
    // XDR_BLOB is 160 chars of 'A' repeated — not valid 64-hex, so blob label
    assert.equal(redactSecrets(XDR_BLOB), "[redacted:blob]");
  });

  test("12-word seed phrase → '[redacted:seed]'", () => {
    assert.equal(redactSecrets(SEED_12), "[redacted:seed]");
  });

  test("24-word seed phrase → '[redacted:seed]'", () => {
    assert.equal(redactSecrets(SEED_24), "[redacted:seed]");
  });

  test("safe short string passes through unchanged", () => {
    assert.equal(redactSecrets(SAFE_SHORT), SAFE_SHORT);
  });

  test("safe medium-length string passes through unchanged", () => {
    assert.equal(redactSecrets(SAFE_MEDIUM), SAFE_MEDIUM);
  });

  test("a typical user-facing error message passes through", () => {
    const msg = "A network error occurred. Check your internet connection.";
    assert.equal(redactSecrets(msg), msg);
  });

  test("'network' keyword in error message does NOT trigger redaction", () => {
    // Keyword-based redaction is only for env var NAMES, not for values
    const msg = "network error";
    assert.equal(redactSecrets(msg), msg);
  });

  test("empty string passes through unchanged", () => {
    assert.equal(redactSecrets(""), "");
  });

  test("S-key is redacted before the address check fires (priority)", () => {
    // S-keys get the more specific label, not '[redacted:address]'
    const result = redactSecrets(S_KEY);
    assert.equal(result, "[redacted:secret-key]");
    assert.notEqual(result, "[redacted:address]");
  });

  test("hash gets '[redacted:hash]' not '[redacted:blob]' (64-hex specificity)", () => {
    const result = redactSecrets(TX_HASH);
    assert.equal(result, "[redacted:hash]");
    assert.notEqual(result, "[redacted:blob]");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. redactObject — recursive object redaction
// ═════════════════════════════════════════════════════════════════════════════

describe("redactObject", () => {
  test("top-level G-address value is redacted", () => {
    const result = redactObject({ walletAddress: G_ADDR, method: SAFE_SHORT });
    assert.equal(result.walletAddress, "[redacted:address]");
    assert.equal(result.method, SAFE_SHORT);
  });

  test("top-level S-key value is redacted", () => {
    const result = redactObject({ privateKey: S_KEY });
    assert.equal(result.privateKey, "[redacted:secret-key]");
  });

  test("top-level tx hash is redacted", () => {
    const result = redactObject({ txHash: TX_HASH, stage: "submitted" });
    assert.equal(result.txHash, "[redacted:hash]");
    assert.equal(result.stage, "submitted");
  });

  test("XDR blob is redacted", () => {
    const result = redactObject({ xdr: XDR_BLOB, ok: "true" });
    assert.equal(result.xdr, "[redacted:blob]");
    assert.equal(result.ok, "true");
  });

  test("seed phrase is redacted", () => {
    const result = redactObject({ mnemonic: SEED_12 });
    assert.equal(result.mnemonic, "[redacted:seed]");
  });

  test("safe fields are preserved", () => {
    const input = {
      kind: "network",
      code: "NETWORK_TIMEOUT",
      message: "Connection timed out.",
    };
    const result = redactObject(input);
    assert.deepEqual(result, input);
  });

  test("nested sensitive values are redacted recursively", () => {
    const result = redactObject({
      outer: { inner: G_ADDR, safe: "hello" },
    });
    const outer = result.outer as Record<string, unknown>;
    assert.equal(outer.inner, "[redacted:address]");
    assert.equal(outer.safe, "hello");
  });

  test("deeply nested object is handled", () => {
    const result = redactObject({
      a: { b: { c: S_KEY } },
    });
    const c = ((result.a as Record<string, unknown>).b as Record<string, unknown>).c;
    assert.equal(c, "[redacted:secret-key]");
  });

  test("non-string, non-object values (numbers, booleans) are preserved", () => {
    const result = redactObject({ count: 5, enabled: true, nothing: null });
    assert.equal(result.count, 5);
    assert.equal(result.enabled, true);
    assert.equal(result.nothing, null);
  });

  test("input object is not mutated", () => {
    const input = { addr: G_ADDR, msg: SAFE_SHORT };
    const before = { ...input };
    redactObject(input);
    assert.deepEqual(input, before);
  });

  test("multiple sensitive fields in one object are all redacted", () => {
    const result = redactObject({
      g: G_ADDR,
      s: S_KEY,
      hash: TX_HASH,
      xdr: XDR_BLOB,
      safe: SAFE_SHORT,
    });
    assert.equal(result.g, "[redacted:address]");
    assert.equal(result.s, "[redacted:secret-key]");
    assert.equal(result.hash, "[redacted:hash]");
    assert.equal(result.xdr, "[redacted:blob]");
    assert.equal(result.safe, SAFE_SHORT);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. collectEnv — allowlist filtering
// ═════════════════════════════════════════════════════════════════════════════

describe("collectEnv", () => {
  test("only NEXT_PUBLIC_STELLAR_RPC_URL is included from a full env", () => {
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_SECRET_KEY: "should-be-excluded-by-name",  // not on allowlist
      SECRET_SEED: "should-be-excluded",
      NODE_ENV: "test",
    };
    const result = collectEnv(env);
    assert.ok("NEXT_PUBLIC_STELLAR_RPC_URL" in result);
    assert.ok(!("NEXT_PUBLIC_SECRET_KEY" in result));
    assert.ok(!("SECRET_SEED" in result));
    assert.ok(!("NODE_ENV" in result));
  });

  test("all four allowed keys are included when present", () => {
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_INDEXER_URL: "http://localhost:3001",
      NEXT_PUBLIC_ACTIVE_NETWORK: "testnet",
    };
    const result = collectEnv(env);
    assert.equal(Object.keys(result).length, 4);
    assert.ok("NEXT_PUBLIC_STELLAR_RPC_URL" in result);
    assert.ok("NEXT_PUBLIC_NETWORK_PASSPHRASE" in result);
    assert.ok("NEXT_PUBLIC_INDEXER_URL" in result);
    assert.ok("NEXT_PUBLIC_ACTIVE_NETWORK" in result);
  });

  test("missing/empty keys are absent from the result (not set to empty string)", () => {
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      NEXT_PUBLIC_NETWORK_PASSPHRASE: "", // empty — should be excluded
      // NEXT_PUBLIC_INDEXER_URL absent
    };
    const result = collectEnv(env);
    assert.ok("NEXT_PUBLIC_STELLAR_RPC_URL" in result);
    assert.ok(!("NEXT_PUBLIC_NETWORK_PASSPHRASE" in result));
    assert.ok(!("NEXT_PUBLIC_INDEXER_URL" in result));
  });

  test("address-shaped values in allowed env vars are redacted", () => {
    // Edge case: someone accidentally sets an env var to a contract address
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_INDEXER_URL: G_ADDR, // structurally wrong value but shape matters
    };
    const result = collectEnv(env);
    assert.equal(result["NEXT_PUBLIC_INDEXER_URL"], "[redacted:address]");
  });

  test("XDR-length value in an allowed env var is redacted", () => {
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_STELLAR_RPC_URL: XDR_BLOB,
    };
    const result = collectEnv(env);
    assert.equal(result["NEXT_PUBLIC_STELLAR_RPC_URL"], "[redacted:blob]");
  });

  test("env vars with secret-bearing names are excluded even with valid-looking values", () => {
    // These names are NOT on the allowlist, but we're testing that the
    // name-pattern check acts as a second backstop
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_PRIVATE_KEY: "some-value",
      NEXT_PUBLIC_MNEMONIC: "some-value",
      MY_SECRET: "some-value",
    };
    const result = collectEnv(env);
    assert.ok(!("NEXT_PUBLIC_PRIVATE_KEY" in result));
    assert.ok(!("NEXT_PUBLIC_MNEMONIC" in result));
    assert.ok(!("MY_SECRET" in result));
  });

  test("empty env returns empty object", () => {
    const result = collectEnv({});
    assert.deepEqual(result, {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. buildDiagnosticsBundle — full bundle shape
// ═════════════════════════════════════════════════════════════════════════════

describe("buildDiagnosticsBundle — bundle shape", () => {
  test("schemaVersion is 1", () => {
    const bundle = headlessBundle();
    assert.equal(bundle.schemaVersion, 1);
  });

  test("generatedAt matches injected ISO string", () => {
    const bundle = headlessBundle();
    assert.equal(bundle.generatedAt, FIXED_ISO);
  });

  test("generatedAt is a valid ISO-8601 string when not injected", () => {
    const bundle = buildDiagnosticsBundle({ _win: WIN_WITHOUT_FREIGHTER });
    const parsed = new Date(bundle.generatedAt);
    assert.ok(!isNaN(parsed.getTime()), "generatedAt must parse as a valid date");
  });

  test("app section has all required keys", () => {
    const bundle = headlessBundle();
    assert.ok("version" in bundle.app);
    assert.ok("activeNetwork" in bundle.app);
    assert.ok("rpcUrl" in bundle.app);
    assert.ok("indexerUrl" in bundle.app);
    assert.ok("walletInstalled" in bundle.app);
    assert.ok("env" in bundle.app);
  });

  test("walletInstalled is true when window.freighter is present", () => {
    const bundle = buildDiagnosticsBundle({
      _nowIso: FIXED_ISO,
      _win: WIN_WITH_FREIGHTER,
    });
    assert.equal(bundle.app.walletInstalled, true);
  });

  test("walletInstalled is false when window.freighter is absent", () => {
    const bundle = headlessBundle();
    assert.equal(bundle.app.walletInstalled, false);
  });

  test("browser section has all required keys", () => {
    const bundle = headlessBundle();
    assert.ok("userAgent" in bundle.browser);
    assert.ok("language"  in bundle.browser);
    assert.ok("online"    in bundle.browser);
  });

  test("browser.userAgent matches injected navigator.userAgent", () => {
    const bundle = headlessBundle();
    assert.equal(bundle.browser.userAgent, "TestAgent/1.0");
  });

  test("browser.online reflects injected navigator.onLine", () => {
    const bundle = headlessBundle(); // WIN_WITHOUT_FREIGHTER has onLine: false
    assert.equal(bundle.browser.online, false);
  });

  test("error section is absent when no typedError is passed", () => {
    const bundle = headlessBundle();
    assert.ok(!("error" in bundle), "error section must be absent when no error given");
  });

  test("error section is absent when typedError is null", () => {
    const bundle = headlessBundle({ typedError: null });
    assert.ok(!("error" in bundle));
  });

  test("error section is present and has correct shape for a wallet error", () => {
    const bundle = headlessBundle({ typedError: WALLET_ERROR });
    assert.ok("error" in bundle);
    assert.equal(bundle.error!.kind, "wallet");
    assert.equal(bundle.error!.code, "WALLET_REJECTED");
    assert.ok(typeof bundle.error!.message === "string");
    assert.ok(bundle.error!.message.length > 0);
  });

  test("error section carries stage and category when provided", () => {
    const bundle = headlessBundle({
      typedError: NETWORK_ERROR,
      stage: "simulate_failed",
      errorCategory: "simulation_error",
    });
    assert.equal(bundle.error!.stage, "simulate_failed");
    assert.equal(bundle.error!.category, "simulation_error");
  });

  test("stage and category are absent when not provided", () => {
    const bundle = headlessBundle({ typedError: WALLET_ERROR });
    assert.ok(!("stage"    in bundle.error!));
    assert.ok(!("category" in bundle.error!));
  });

  test("txHash in bundle is always '[redacted:hash]' regardless of input value", () => {
    const bundle = headlessBundle({
      typedError: NETWORK_ERROR,
      txHash: TX_HASH, // raw hash provided
    });
    assert.equal(bundle.error!.txHash, "[redacted:hash]");
  });

  test("txHash is absent from error section when not provided", () => {
    const bundle = headlessBundle({ typedError: WALLET_ERROR });
    assert.ok(!("txHash" in bundle.error!));
  });

  test("txHash is absent from error section when provided as null/empty", () => {
    const bundleNull  = headlessBundle({ typedError: WALLET_ERROR, txHash: null });
    const bundleEmpty = headlessBundle({ typedError: WALLET_ERROR, txHash: "" });
    assert.ok(!("txHash" in bundleNull.error!));
    assert.ok(!("txHash" in bundleEmpty.error!));
  });

  test("error.message is safe even when ContractAppError.message accidentally contains an address", () => {
    // Simulate a (hypothetical) case where a user-facing message was
    // accidentally constructed with an address embedded — redactSecrets
    // must strip it before it enters the bundle.
    const dodgyError: ContractAppError = {
      kind: "unknown",
      code: "UNKNOWN",
      message: `Error for wallet ${G_ADDR} — please retry.`,
    };
    const bundle = headlessBundle({ typedError: dodgyError });
    assert.ok(
      !bundle.error!.message.includes(G_ADDR),
      "G-address in error.message must be redacted",
    );
  });

  test("app.env does not include unlisted env vars", () => {
    // Even if process.env is polluted with a secret in test, collectEnv
    // must not include it because it is not on the allowlist
    const bundle = headlessBundle();
    for (const key of Object.keys(bundle.app.env)) {
      assert.ok(
        [
          "NEXT_PUBLIC_STELLAR_RPC_URL",
          "NEXT_PUBLIC_NETWORK_PASSPHRASE",
          "NEXT_PUBLIC_INDEXER_URL",
          "NEXT_PUBLIC_ACTIVE_NETWORK",
        ].includes(key),
        `Unexpected env key in bundle: ${key}`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Acceptance criteria — secrets absent from serialised output
// ═════════════════════════════════════════════════════════════════════════════

describe("Acceptance criteria: secrets absent from serialised bundle", () => {
  /**
   * Build a bundle with the most sensitive possible inputs and assert the
   * serialised JSON contains none of them.
   */
  function buildWorstCaseBundle(): string {
    return buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: {
        freighter: { secretKey: S_KEY },   // provider carrying a secret-shaped property
        navigator: {
          userAgent: `FreighterTest ${G_ADDR}`, // address in userAgent
          language: "en",
          onLine: true,
        },
      },
      typedError: {
        kind: "unknown",
        code: "UNKNOWN",
        message: `Panic: address ${G_ADDR} not authorised`,
        raw: `raw XDR: ${XDR_BLOB}`,
      },
      stage: "simulate_failed",
      errorCategory: "simulation_error",
      txHash: TX_HASH,
    });
  }

  test("raw G-address is absent from serialised JSON", () => {
    const json = buildWorstCaseBundle();
    assert.ok(!json.includes(G_ADDR), `G-address must not appear in bundle JSON`);
  });

  test("raw C-address is absent from serialised JSON", () => {
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
      typedError: { kind: "unknown", code: "UNKNOWN", message: `contract ${C_ADDR}` },
    });
    assert.ok(!json.includes(C_ADDR), `C-address must not appear in bundle JSON`);
  });

  test("raw S-key is absent from serialised JSON", () => {
    const json = buildWorstCaseBundle();
    assert.ok(!json.includes(S_KEY), `S-key must not appear in bundle JSON`);
  });

  test("raw tx hash is absent from serialised JSON", () => {
    const json = buildWorstCaseBundle();
    assert.ok(!json.includes(TX_HASH), `raw tx hash must not appear in bundle JSON`);
  });

  test("raw XDR blob is absent from serialised JSON", () => {
    const json = buildWorstCaseBundle();
    assert.ok(!json.includes(XDR_BLOB), `XDR blob must not appear in bundle JSON`);
  });

  test("12-word seed phrase is absent from serialised JSON", () => {
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
      typedError: {
        kind: "unknown",
        code: "UNKNOWN",
        message: SEED_12, // seed phrase as the whole message (worst-case)
      },
    });
    assert.ok(!json.includes(SEED_12), `seed phrase must not appear in bundle JSON`);
  });

  test("24-word seed phrase is absent from serialised JSON", () => {
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
      typedError: {
        kind: "unknown",
        code: "UNKNOWN",
        message: SEED_24,
      },
    });
    assert.ok(!json.includes(SEED_24), `24-word seed phrase must not appear in bundle JSON`);
  });

  test("serialised JSON is valid and parseable", () => {
    const json = buildWorstCaseBundle();
    assert.doesNotThrow(() => JSON.parse(json), "bundle JSON must be valid");
  });

  test("serialised JSON contains the schemaVersion sentinel", () => {
    const json = buildWorstCaseBundle();
    const parsed = JSON.parse(json) as DiagnosticsBundle;
    assert.equal(parsed.schemaVersion, 1);
  });

  test("safe error message survives serialisation unchanged", () => {
    const safeMsg = "The round deadline has passed.";
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
      typedError: { kind: "deadline", code: "DEADLINE_PASSED", message: safeMsg },
    });
    const parsed = JSON.parse(json) as DiagnosticsBundle;
    assert.equal(parsed.error?.message, safeMsg);
  });

  test("arbitrary provider error message that is short and safe passes through", () => {
    // Some provider errors are short safe strings: "Extension context invalidated."
    const providerMsg = "Extension context invalidated.";
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
      typedError: { kind: "unknown", code: "UNKNOWN", message: providerMsg },
    });
    const parsed = JSON.parse(json) as DiagnosticsBundle;
    assert.equal(parsed.error?.message, providerMsg);
  });

  test("arbitrary provider message that contains a G-address is redacted", () => {
    const rawMsg = `Provider error: no permission for ${G_ADDR}`;
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
      typedError: { kind: "unknown", code: "UNKNOWN", message: rawMsg },
    });
    assert.ok(!json.includes(G_ADDR));
  });

  test("bundle produced without typedError still passes acceptance: no secrets", () => {
    const json = buildAndSerialise({
      _nowIso: FIXED_ISO,
      _win: WIN_WITHOUT_FREIGHTER,
    });
    assert.ok(!json.includes(G_ADDR));
    assert.ok(!json.includes(S_KEY));
    assert.ok(!json.includes(TX_HASH));
    assert.ok(!json.includes(SEED_12));
  });

  test("serialiseDiagnosticsBundle produces indented JSON (readable for pasting)", () => {
    const bundle = headlessBundle({ typedError: WALLET_ERROR });
    const json = serialiseDiagnosticsBundle(bundle);
    // Indented JSON has newlines
    assert.ok(json.includes("\n"), "output must be indented (contain newlines)");
    // And 2-space indent
    assert.ok(json.includes("  "), "output must use 2-space indentation");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("Edge cases", () => {
  test("buildDiagnosticsBundle with no arguments does not throw", () => {
    assert.doesNotThrow(() => buildDiagnosticsBundle());
  });

  test("buildAndSerialise with no arguments produces valid JSON", () => {
    let json: string;
    assert.doesNotThrow(() => { json = buildAndSerialise(); });
    assert.doesNotThrow(() => JSON.parse(json!));
  });

  test("unknown error kind with raw field — raw is not included in bundle", () => {
    const bundle = headlessBundle({ typedError: UNKNOWN_ERROR });
    // The `raw` field on UnknownError must never appear in the bundle —
    // only the user-facing `message` is included.
    const json = serialiseDiagnosticsBundle(bundle);
    const parsed = JSON.parse(json);
    assert.ok(!("raw" in (parsed.error ?? {})), "raw field must not be in bundle");
  });

  test("error.code is a stable string (safe to include in bundle)", () => {
    const bundle = headlessBundle({ typedError: WALLET_ERROR });
    assert.equal(typeof bundle.error!.code, "string");
    assert.ok(bundle.error!.code.length > 0);
    // Must not look like an address or hash
    assert.ok(!isSecretShaped(bundle.error!.code));
  });

  test("app.version is a string (not undefined, not an address)", () => {
    const bundle = headlessBundle();
    assert.equal(typeof bundle.app.version, "string");
    assert.ok(!isSecretShaped(bundle.app.version));
  });
});
