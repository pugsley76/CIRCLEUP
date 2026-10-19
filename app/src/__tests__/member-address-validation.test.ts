/**
 * Strkey checksum verification — Issue #477 "Add address validation for every
 * member entry on create flow".
 *
 * `isStellarPublicKey` is a *shape* test only: it happily accepts
 * `"G" + "A".repeat(55)` and any single-character typo of a real address.
 * Such a value passes the create form today and only fails later, inside
 * transaction construction, as an opaque SDK error — after the wallet prompt
 * has already appeared.
 *
 * These tests pin down the checksum-aware validators that the create flow now
 * applies to every member entry:
 *
 *   hasValidStrKeyChecksum — CRC16/XMODEM over the decoded strkey payload
 *   isValidStellarAccount  — shape *and* checksum, account ("G…") only
 */

import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  isStellarPublicKey,
  isValidStellarAccount,
  hasValidStrKeyChecksum,
} from "../lib/address";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** StrKey-encoded fixtures — their checksums are real, not hand-typed. */
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

/** Regex-approved but checksum-invalid: the exact gap this issue closes. */
const SHAPE_ONLY = "G" + "A".repeat(55);

/** Deterministic addresses straight from the Stellar SDK encoder. */
const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

/** Same length and alphabet as `addr`, but one payload character mistyped. */
function withTypo(addr: string): string {
  const at = 20;
  return addr.slice(0, at) + (addr.charAt(at) === "A" ? "B" : "A") + addr.slice(at + 1);
}

// ─── hasValidStrKeyChecksum ───────────────────────────────────────────────────

describe("hasValidStrKeyChecksum", () => {
  it("accepts a real account address", () => {
    expect(hasValidStrKeyChecksum(ACCOUNT)).toBe(true);
  });

  it("accepts a real contract ID", () => {
    expect(hasValidStrKeyChecksum(CONTRACT)).toBe(true);
  });

  it("accepts addresses produced by the Stellar SDK encoder", () => {
    for (let seed = 1; seed <= 5; seed++) {
      expect(hasValidStrKeyChecksum(addrFor(seed))).toBe(true);
    }
  });

  it("rejects a shape-only fake whose checksum was never computed", () => {
    // The regex is fooled — this is why a shape test alone is not validation.
    expect(isStellarPublicKey(SHAPE_ONLY)).toBe(true);
    expect(hasValidStrKeyChecksum(SHAPE_ONLY)).toBe(false);
  });

  it("rejects a single mistyped character", () => {
    expect(hasValidStrKeyChecksum(withTypo(ACCOUNT))).toBe(false);
  });

  it("rejects a lowercased address", () => {
    expect(hasValidStrKeyChecksum(ACCOUNT.toLowerCase())).toBe(false);
  });

  it("rejects addresses of the wrong length", () => {
    expect(hasValidStrKeyChecksum(ACCOUNT.slice(0, 55))).toBe(false);
    expect(hasValidStrKeyChecksum(`${ACCOUNT}A`)).toBe(false);
    expect(hasValidStrKeyChecksum("")).toBe(false);
  });

  it("rejects prefixes outside the G/C namespaces", () => {
    expect(hasValidStrKeyChecksum(`M${ACCOUNT.slice(1)}`)).toBe(false);
    expect(hasValidStrKeyChecksum(`X${ACCOUNT.slice(1)}`)).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(hasValidStrKeyChecksum(undefined as unknown as string)).toBe(false);
    expect(hasValidStrKeyChecksum(null as unknown as string)).toBe(false);
  });
});

// ─── isValidStellarAccount ────────────────────────────────────────────────────

describe("isValidStellarAccount", () => {
  it("accepts real account addresses", () => {
    expect(isValidStellarAccount(ACCOUNT)).toBe(true);
    expect(isValidStellarAccount(addrFor(7))).toBe(true);
  });

  it("rejects shape-only strings", () => {
    expect(isValidStellarAccount(SHAPE_ONLY)).toBe(false);
  });

  it("rejects a mistyped account", () => {
    expect(isValidStellarAccount(withTypo(ACCOUNT))).toBe(false);
  });

  it("rejects contract IDs — they are not wallet accounts", () => {
    expect(isValidStellarAccount(CONTRACT)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isValidStellarAccount("not-an-address")).toBe(false);
    expect(isValidStellarAccount("")).toBe(false);
  });
});
