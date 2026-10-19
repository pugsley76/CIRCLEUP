/**
 * Canonical Stellar / Soroban address validators.
 *
 * Stellar has two address namespaces used throughout this project:
 *
 *  • Stellar public key  ("G…")  — 56-character base32 encoded ed25519 key.
 *    Used for: wallet addresses, member addresses, fee-account addresses.
 *    Pattern: starts with "G", followed by 55 uppercase base32 chars [A-Z2-7].
 *
 *  • Soroban contract ID ("C…")  — 56-character base32 encoded 32-byte hash.
 *    Used for: circle addresses, factory address, reputation address, USDC address.
 *    Pattern: starts with "C", followed by 55 uppercase base32 chars [A-Z2-7].
 *
 * A "canonical address" is either of the above — useful when the caller accepts
 * both wallets and contracts (e.g. member lists that may include contract-based
 * multisigs, or generic input validation in route handlers).
 *
 * All functions are pure / synchronous and impose zero runtime dependencies —
 * a RegExp test plus, for checksum verification, a small self-contained
 * base32 + CRC16 routine — so they are safe to call in server components,
 * Edge middleware, and the Soroban RPC layer alike.
 */

// ─── Regex constants ──────────────────────────────────────────────────────────

/**
 * Matches a Stellar ed25519 public key.
 * Format: "G" followed by exactly 55 base32 characters (uppercase A–Z, digits 2–7).
 * Total length: 56 characters.
 */
const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;

/**
 * Matches a Soroban contract ID.
 * Format: "C" followed by exactly 55 base32 characters (uppercase A–Z, digits 2–7).
 * Total length: 56 characters.
 */
const SOROBAN_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

// ─── Validators ───────────────────────────────────────────────────────────────

/**
 * Returns `true` when `address` is a valid Stellar ed25519 public key.
 *
 * A valid public key starts with "G" and is 56 characters of base32
 * (uppercase letters A–Z and digits 2–7).  This matches what Freighter,
 * Stellar Laboratory, and the Stellar SDK produce for wallet addresses.
 *
 * @example
 * isStellarPublicKey("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // true
 * isStellarPublicKey("CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // false (C prefix)
 * isStellarPublicKey("GAAZI4") // false (too short)
 */
export function isStellarPublicKey(address: string): boolean {
  return STELLAR_PUBLIC_KEY_RE.test(address);
}

/**
 * Returns `true` when `address` is a valid Soroban contract ID.
 *
 * A valid contract ID starts with "C" and is 56 characters of base32
 * (uppercase letters A–Z and digits 2–7).  This matches what `stellar contract
 * deploy` and the Soroban SDK produce when deriving a contract address.
 *
 * @example
 * isSorobanContractId("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM") // true
 * isSorobanContractId("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // false (G prefix)
 */
export function isSorobanContractId(address: string): boolean {
  return SOROBAN_CONTRACT_ID_RE.test(address);
}

/**
 * Returns `true` when `address` is either a valid Stellar public key or a
 * valid Soroban contract ID.
 *
 * Use this for inputs that may legitimately be either type — for example,
 * route parameters in the API (`:address`, `:member`) and wallet fields that
 * could contain multisig contracts.
 *
 * @example
 * isCanonicalStellarAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN") // true (G-key)
 * isCanonicalStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM") // true (C-contract)
 * isCanonicalStellarAddress("not-an-address") // false
 */
export function isCanonicalStellarAddress(address: string): boolean {
  return isStellarPublicKey(address) || isSorobanContractId(address);
}

// ─── Strkey checksum verification ─────────────────────────────────────────────
//
// A regex alone is not enough for anything a human typed or pasted: a single
// mistyped character, a truncated copy-paste, or an address generated for a
// different network still matches `^G[A-Z2-7]{55}$`.  Stellar therefore
// appends a CRC16/XMODEM checksum to every strkey — encoded as
// `version byte ‖ payload ‖ checksum` and base32-packed into 56 characters.
//
// Verifying it here, in pure TypeScript with no dependency on the Stellar SDK,
// catches those mistakes at the input boundary instead of letting them surface
// later as an opaque "Unsupported address type" throw while the transaction is
// being constructed (after the user has already unlocked their wallet).

/** RFC 4648 base32 alphabet used by strkeys (uppercase only, no padding). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Version byte of an ed25519 public key ("G…"): `6 << 3`. */
const STRKEY_VERSION_ACCOUNT = 6 << 3;

/** Version byte of a Soroban contract ID ("C…"): `2 << 3`. */
const STRKEY_VERSION_CONTRACT = 2 << 3;

/** Total length of a strkey address, in base32 characters. */
const STRKEY_LENGTH = 56;

/** Total length of the decoded strkey, in bytes (1 + 32 + 2). */
const STRKEY_BYTE_LENGTH = 35;

/**
 * Decode a base32 string (RFC 4648, no padding) into its bytes.
 *
 * Returns `null` when the string contains a character outside the alphabet,
 * or when its trailing bits are non-zero (a non-canonical encoding).
 */
function decodeBase32(input: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((input.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < input.length; i++) {
    const value = BASE32_ALPHABET.indexOf(input.charAt(i));
    if (value === -1) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (buffer >>> (bits - 8)) & 0xff;
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }

  // Leftover bits must be zero in a canonical encoding.
  if (bits > 0 && buffer !== 0) return null;
  return index === out.length ? out : null;
}

/**
 * CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflection, no final xor) —
 * the checksum function Stellar uses for every strkey.
 */
function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Returns `true` when `address` carries a strkey checksum that actually
 * matches its payload *and* a version byte that matches its prefix.
 *
 * Accepts "G…" accounts and "C…" contract IDs.  The shape (prefix, length,
 * alphabet) is verified as part of decoding, but call this through
 * {@link isValidStellarAccount} when you specifically need an account.
 *
 * @example
 * hasValidStrKeyChecksum("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF") // true
 * hasValidStrKeyChecksum("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF") // false — not that payload's checksum
 * hasValidStrKeyChecksum("GAAZI4") // false — wrong length
 */
export function hasValidStrKeyChecksum(address: string): boolean {
  if (typeof address !== "string" || address.length !== STRKEY_LENGTH) return false;

  const version =
    address.charAt(0) === "G"
      ? STRKEY_VERSION_ACCOUNT
      : address.charAt(0) === "C"
        ? STRKEY_VERSION_CONTRACT
        : -1;
  if (version === -1) return false;

  const decoded = decodeBase32(address);
  if (decoded === null || decoded.length !== STRKEY_BYTE_LENGTH) return false;
  if (decoded[0] !== version) return false;

  // The checksum is appended little-endian: low byte first.
  const stored = decoded[33] | (decoded[34] << 8);
  return crc16Xmodem(decoded.subarray(0, 33)) === stored;
}

/**
 * Returns `true` when `address` is a Stellar account ("G…") that is *also*
 * checksum-valid — i.e. a real address rather than a 56-character string that
 * merely looks like one.
 *
 * Use this for anything a human supplied: member addresses on the create flow,
 * recipients in a split editor, a wallet address read back from an extension.
 * Prefer {@link isStellarPublicKey} only for values already produced by a
 * trusted encoder inside this process.
 *
 * @example
 * isValidStellarAccount("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF") // true
 * isValidStellarAccount("G" + "A".repeat(55)) // false — shape only, checksum 0
 * isValidStellarAccount("C…") // false — contract IDs are not accounts
 */
export function isValidStellarAccount(address: string): boolean {
  return isStellarPublicKey(address) && hasValidStrKeyChecksum(address);
}

// ─── Structured validation result ────────────────────────────────────────────
//
// Boolean validators are the right tool inside trusted code paths (parsers,
// internal API guards). For user-facing surfaces — route handlers, form
// submissions, error banners — callers need a reason they can display directly
// or branch on deterministically.  `validateAddress` fills that role: it runs
// every applicable check in order and returns the first failure with a stable
// `reason` code and a ready-to-display `message`.
//
// Ordering within `validateAddress`:
//   1. empty/non-string     — catches null, undefined, whitespace from URL params
//   2. length               — catches truncated copy-pastes before the alphabet check
//   3. prefix               — names the namespace (G/C/M/other) unambiguously
//   4. alphabet/shape       — catches non-base32 characters
//   5. checksum             — catches one-character typos that pass shape checks
//
// Accepting `"G" | "C" | "any"` as the `kind` option keeps the call-site
// intent explicit: a circle route always expects "C"; a reputation route
// accepts "any"; the create form always expects "G".

/** Reason code for a failed address validation. */
export type AddressValidationReason =
  | "empty"
  | "wrong_length"
  | "wrong_prefix"
  | "unsupported_prefix"
  | "invalid_alphabet"
  | "checksum_mismatch"
  | "contract_not_allowed"
  | "muxed_not_allowed";

/** Result returned by {@link validateAddress}. */
export type AddressValidationResult =
  | { valid: true; kind: "account" | "contract" }
  | { valid: false; reason: AddressValidationReason; message: string };

/**
 * Options accepted by {@link validateAddress}.
 *
 * `kind`:
 *  - `"G"` — only Stellar public keys (G-prefix) are accepted.
 *  - `"C"` — only Soroban contract IDs (C-prefix) are accepted.
 *  - `"any"` — either G-prefix or C-prefix is accepted (default).
 *
 * `requireChecksum`:
 *  - When `true` (default), the strkey CRC16/XMODEM checksum is verified so
 *    shape-valid but typo'd addresses are caught at the input boundary.
 *  - Set to `false` only for values produced by a trusted encoder (SDK output,
 *    internal code) where the checksum is guaranteed correct and you want a
 *    faster pure-shape check.
 */
export interface ValidateAddressOptions {
  kind?: "G" | "C" | "any";
  requireChecksum?: boolean;
}

/**
 * Validate a Stellar / Soroban address and return a structured result.
 *
 * Unlike the boolean helpers, this function returns a stable `reason` code and
 * a ready-to-display `message` on failure, making it the right choice for:
 *   - Route handler guards (replace inline regex, produce notFound or error page)
 *   - Error banners in client components
 *   - Any surface where the caller needs to branch on *why* validation failed
 *
 * The `kind` option restricts which prefix is accepted:
 *   - `"G"` — wallet / member addresses only
 *   - `"C"` — Soroban contract IDs only
 *   - `"any"` — either (default)
 *
 * The `requireChecksum` option (default `true`) runs the CRC16/XMODEM strkey
 * checksum so single-character typos are caught before the address reaches any
 * RPC call or indexer lookup.
 *
 * @example
 * // Route guard — only accept a Soroban contract ID
 * const result = validateAddress(params.address, { kind: "C" });
 * if (!result.valid) notFound();
 *
 * // Form validation — only accept a wallet address, with checksum
 * const result = validateAddress(userInput, { kind: "G" });
 * if (!result.valid) return result.message; // display to user
 */
export function validateAddress(
  address: unknown,
  options: ValidateAddressOptions = {},
): AddressValidationResult {
  const { kind = "any", requireChecksum = true } = options;

  // ── 1. Empty / non-string ─────────────────────────────────────────────────
  if (typeof address !== "string" || address.trim() === "") {
    return {
      valid: false,
      reason: "empty",
      message: "Address is required.",
    };
  }

  const trimmed = address.trim();

  // ── 2. Length ─────────────────────────────────────────────────────────────
  if (trimmed.length !== STRKEY_LENGTH) {
    return {
      valid: false,
      reason: "wrong_length",
      message:
        `Invalid address length (${trimmed.length} characters). ` +
        `Stellar addresses are always exactly 56 characters.`,
    };
  }

  // ── 3. Prefix / namespace ─────────────────────────────────────────────────
  const prefix = trimmed.charAt(0);

  // Explicitly unsupported prefix: muxed addresses (M-prefix)
  if (prefix === "M") {
    return {
      valid: false,
      reason: "muxed_not_allowed",
      message:
        "Muxed addresses (M…) are not supported. Use a plain G-prefixed wallet address instead.",
    };
  }

  // Caller wants only G-addresses but got a C-contract
  if (kind === "G" && prefix === "C") {
    return {
      valid: false,
      reason: "contract_not_allowed",
      message:
        "Contract addresses (C…) are not allowed here. Provide a G-prefixed wallet address.",
    };
  }

  // Caller wants only C-addresses but got a G-key
  if (kind === "C" && prefix === "G") {
    return {
      valid: false,
      reason: "wrong_prefix",
      message:
        "Expected a Soroban contract ID (C-prefixed). Provide the circle's contract address.",
    };
  }

  // Any other prefix that is neither G nor C
  if (prefix !== "G" && prefix !== "C") {
    return {
      valid: false,
      reason: "unsupported_prefix",
      message:
        `Unrecognised address prefix "${prefix}". Stellar wallet addresses start with "G" ` +
        `and contract addresses start with "C".`,
    };
  }

  // ── 4. Alphabet / shape ───────────────────────────────────────────────────
  // After the prefix check we know the first char is G or C, so the regex
  // only needs to validate the remaining 55 characters.
  const bodyOk = /^[A-Z2-7]{55}$/.test(trimmed.slice(1));
  if (!bodyOk) {
    const lower = trimmed.toLowerCase();
    if (lower === trimmed && isStellarPublicKey(trimmed.toUpperCase())) {
      return {
        valid: false,
        reason: "invalid_alphabet",
        message:
          "Address must be typed in uppercase — Stellar addresses are case-sensitive.",
      };
    }
    return {
      valid: false,
      reason: "invalid_alphabet",
      message:
        "Address contains invalid characters. Stellar addresses only use uppercase A–Z and digits 2–7.",
    };
  }

  // ── 5. Checksum ───────────────────────────────────────────────────────────
  if (requireChecksum && !hasValidStrKeyChecksum(trimmed)) {
    return {
      valid: false,
      reason: "checksum_mismatch",
      message:
        "Address checksum failed — this looks like a typo or a truncated copy-paste. " +
        "Double-check the address character by character.",
    };
  }

  return {
    valid: true,
    kind: prefix === "G" ? "account" : "contract",
  };
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

/**
 * Throws a `TypeError` with a descriptive message when `address` is not a
 * valid Stellar public key.
 *
 * Intended for use in internal API boundaries where an invalid address is a
 * programming error (e.g. calling `invokeContract` with a bad `walletAddress`).
 * For user-facing input validation, prefer the boolean form
 * {@link isStellarPublicKey} so the caller controls the error surface.
 */
export function assertStellarPublicKey(address: string, label = "address"): void {
  if (!isStellarPublicKey(address)) {
    throw new TypeError(
      `[address] Invalid Stellar public key for ${label}: "${address}". ` +
        `Expected a G-prefixed 56-character base32 string.`,
    );
  }
}

/**
 * Throws a `TypeError` with a descriptive message when `address` is not a
 * valid Soroban contract ID.
 *
 * Intended for use in internal API boundaries (e.g. calling `readContract`
 * with a bad `contractId`).  For user-facing validation prefer
 * {@link isSorobanContractId}.
 */
export function assertSorobanContractId(address: string, label = "address"): void {
  if (!isSorobanContractId(address)) {
    throw new TypeError(
      `[address] Invalid Soroban contract ID for ${label}: "${address}". ` +
        `Expected a C-prefixed 56-character base32 string.`,
    );
  }
}

/**
 * Throws a `TypeError` with a descriptive message when `address` is neither a
 * valid Stellar public key nor a valid Soroban contract ID.
 *
 * Use at API / route-handler boundaries that accept both address types.
 */
export function assertCanonicalStellarAddress(address: string, label = "address"): void {
  if (!isCanonicalStellarAddress(address)) {
    throw new TypeError(
      `[address] Invalid Stellar address for ${label}: "${address}". ` +
        `Expected a G-prefixed public key or C-prefixed contract ID (56 base32 chars each).`,
    );
  }
}
