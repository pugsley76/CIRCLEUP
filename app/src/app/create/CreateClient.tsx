"use client";
import { useState, useId, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CIRCLE_FACTORY_ADDRESS,
  usdcToStroops,
  shortAddress,
  daysToLedgers,
  getExplorerLink,
  ACTIVE_NETWORK,
  formatUsdc,
  formatPot,
} from "@/lib/config";
import { isStellarPublicKey, isValidStellarAccount } from "@/lib/address";
import { getWalletAddress, invokeContract, WalletError } from "@/lib/stellar";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Member count bounds for a new circle.
 *
 * MIN_MEMBERS matches the contracts exactly: circle_factory rejects fewer than
 * 2 members ("need at least 2 members") before deploying anything.
 * MAX_MEMBERS is a product limit, deliberately tighter than the contracts'
 * MAX_MEMBERS of 256: every member must contribute each round and the rotation
 * runs one round per member, so a 256-member circle would last 256 rounds.
 *
 * Enforced in three places that must agree: the row controls (no adding past
 * MAX_MEMBERS rows, no removing below MIN_MEMBERS rows), the live member-count
 * status beside the list, and validateCreateForm, the gate before any wallet
 * prompt. The last two both count members with getMemberCountStatus.
 */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 20;

/** Maximum USDC decimal places supported by the contract (stroops precision). */
export const MAX_USDC_DECIMALS = 7;

/** Maximum allowed circle name length. */
export const MAX_NAME_LENGTH = 64;

/** Minimum round amount in USDC (one stroop). */
export const MIN_AMOUNT_USDC = "0.0000001";

/** Maximum round amount in USDC (sanity cap to prevent accidental huge values). */
const MAX_ROUND_USDC = 1_000_000;

/** Maximum round duration in days (~10 years). */
export const MAX_ROUND_DAYS = 3650;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-field validation errors. */
export interface CreateFormErrors {
  name?: string;
  amount?: string;
  days?: string;
  /** Per-index member errors (indices that are undefined have no error). */
  members?: (string | undefined)[];
  /** List-level member error (count, duplicates). */
  membersGeneral?: string;
}

/** The normalised values returned when validation passes. */
export interface ValidatedCreateForm {
  name: string;
  validMembers: string[];
  amountStroops: bigint;
  roundDays: number;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Return trimmed non-empty member strings in order. */
export function getFilledMembers(members: string[]): string[] {
  return members.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** Where a member count sits relative to [MIN_MEMBERS, MAX_MEMBERS]. */
export type MemberCountStatus = "too_few" | "ok" | "too_many";

export function getMemberCountStatus(count: number): MemberCountStatus {
  if (count < MIN_MEMBERS) return "too_few";
  if (count > MAX_MEMBERS) return "too_many";
  return "ok";
}

/** The member figures the create form displays, derived from the raw rows. */
export interface MemberRowSummary {
  /** Distinct filled addresses: the members that would actually be submitted. */
  count: number;
  /** Rows that are empty or whitespace-only. They are ignored, never counted. */
  blankRows: number;
  /** Filled rows that repeat an earlier address (submit is blocked until fixed). */
  duplicateRows: number;
  status: MemberCountStatus;
}

/**
 * Summarise member rows for the live counter and the summary card.
 *
 * Blank rows are the default state of the form (it opens with four empty
 * rows), so they must never inflate the member count, the pot, or the
 * collateral figures. Duplicates are not counted twice either: the contract
 * rejects them, so counting them would preview a pot that can never exist.
 */
export function summarizeMemberRows(values: string[]): MemberRowSummary {
  const filled = getFilledMembers(values);
  const distinct = new Set(filled.map((m) => m.toLowerCase())).size;
  return {
    count: distinct,
    blankRows: values.length - filled.length,
    duplicateRows: filled.length - distinct,
    status: getMemberCountStatus(distinct),
  };
}

/**
 * Find duplicate addresses using case-insensitive comparison.
 * Returns the first duplicate found, or null if all are unique.
 */
export function findDuplicateAddress(addresses: string[]): string | null {
  const seen = new Set<string>();
  for (const addr of addresses) {
    const lower = addr.toLowerCase();
    if (seen.has(lower)) return addr;
    seen.add(lower);
  }
  return null;
}

/**
 * Count the significant decimal places in a decimal string.
 * "100"      → 0
 * "1.5"      → 1
 * "1.5000"   → 1  (trailing zeros are not significant)
 * "0.0000001"→ 7
 */
export function countDecimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  if (dot === -1) return 0;
  const frac = value.slice(dot + 1).replace(/0+$/, "");
  return frac.length;
}

/**
 * Validate a single member row on the create flow.
 *
 * Returns `undefined` when the row is blank (unused rows are allowed and are
 * filtered out before submission) or when the entry is a checksum-valid
 * Stellar account address.  Otherwise returns a row-specific message that
 * always starts with `Member N:` (1-based), so the form can render it
 * directly beneath the offending input.
 *
 * Every failure mode gets its own message instead of one generic error:
 *   1. blank row             → skipped
 *   2. lowercase input       → base32 is case-sensitive, say so explicitly
 *   3. C… / M… prefix        → name the namespace that was actually entered
 *   4. shape (prefix/length/alphabet) → generic shape message
 *   5. strkey checksum       → right shape, wrong checksum — the classic typo
 *
 * Check 5 is the one that matters: without it a mistyped address passes the
 * form and only fails later, inside transaction construction, as an opaque
 * SDK error — after the wallet prompt has already appeared.
 *
 * Pure (no I/O), exported for tests and reusable anywhere else the app
 * collects member addresses.
 */
export function validateMemberEntry(raw: string, index: number): string | undefined {
  const row = `Member ${index + 1}`;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const generic = `${row}: must be a G-prefixed 56-character Stellar address.`;
  const upper = trimmed.toUpperCase();

  // A lowercased address fails the shape test for a different reason than a
  // typo does — without this hint the user "fixes" it into another wrong value.
  if (trimmed !== upper && isStellarPublicKey(upper)) {
    return (
      `${row}: must be a G-prefixed 56-character Stellar address typed in ` +
      `uppercase (Stellar addresses are case-sensitive).`
    );
  }

  if (upper.charAt(0) === "C") {
    return (
      `${row}: must be a G-prefixed wallet address — contract (C…)` +
      ` addresses cannot be circle members.`
    );
  }
  if (upper.charAt(0) === "M") {
    return (
      `${row}: must be a G-prefixed 56-character Stellar address — muxed ` +
      `(M…) addresses are not supported.`
    );
  }

  if (!isStellarPublicKey(trimmed)) return generic;

  if (!isValidStellarAccount(trimmed)) {
    return `${row}: checksum failed — check for a typo or a truncated copy-paste.`;
  }

  return undefined;
}

/**
 * Validate and normalise all create-circle form fields.
 *
 * Returns either:
 *   `{ ok: true,  values: ValidatedCreateForm }`  — safe to submit
 *   `{ ok: false, errors: CreateFormErrors }`      — show errors, do not submit
 *
 * Pure: no I/O, no side effects. Safe to call in tests without a browser.
 */
export function validateCreateForm(
  name: string,
  members: string[],
  roundUSDC: string,
  roundDays: string,
): { ok: true; values: ValidatedCreateForm } | { ok: false; errors: CreateFormErrors } {
  const errors: CreateFormErrors = {};

  // ── Name ──────────────────────────────────────────────────────────────────
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    errors.name = "Circle name is required.";
  } else if (trimmedName.length > MAX_NAME_LENGTH) {
    errors.name = `Circle name must be ${MAX_NAME_LENGTH} characters or fewer (currently ${trimmedName.length}).`;
  }

  // ── Amount ────────────────────────────────────────────────────────────────
  const amountStr = roundUSDC.trim();
  let amountStroops: bigint | undefined;

  if (amountStr === "" || amountStr === ".") {
    errors.amount = "Contribution amount is required.";
  } else {
    const amountNum = Number(amountStr);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      errors.amount = "Enter a valid positive amount.";
    } else if (amountNum === 0) {
      errors.amount = "Contribution amount must be greater than zero.";
    } else if (amountNum > MAX_ROUND_USDC) {
      errors.amount =
        `Round amount of $${amountNum.toLocaleString()} exceeds the maximum of ` +
        `$${MAX_ROUND_USDC.toLocaleString()} USDC.`;
    } else if (countDecimalPlaces(amountStr) > MAX_USDC_DECIMALS) {
      errors.amount =
        `USDC supports at most ${MAX_USDC_DECIMALS} decimal places. ` +
        `"${amountStr}" has ${countDecimalPlaces(amountStr)}.`;
    } else {
      // usdcToStroops is safe here — we've already checked the decimal count
      try {
        amountStroops = usdcToStroops(amountStr);
        if (amountStroops <= 0n) {
          errors.amount = "Contribution amount must be greater than zero.";
          amountStroops = undefined;
        }
      } catch (err) {
        errors.amount = err instanceof Error ? err.message : "Invalid amount.";
      }
    }
  }

  // ── Round duration ────────────────────────────────────────────────────────
  const daysStr = roundDays.trim();
  let daysNum: number | undefined;

  if (daysStr === "") {
    errors.days = "Round duration is required.";
  } else {
    // Reject any fractional input — ledger math only makes sense for whole days
    if (daysStr.includes(".")) {
      errors.days = "Round duration must be a whole number of days.";
    } else {
      const parsed = parseInt(daysStr, 10);
      if (isNaN(parsed) || parsed < 1) {
        errors.days = "Round duration must be at least 1 day.";
      } else if (parsed > MAX_ROUND_DAYS) {
        errors.days = `Round duration cannot exceed ${MAX_ROUND_DAYS} days (≈10 years).`;
      } else {
        daysNum = parsed;
      }
    }
  }

  // ── Members — per-field ───────────────────────────────────────────────────
  // Every filled row is validated on its own, so one bad entry names itself
  // (`Member 3: …`) instead of the whole list failing later at encoding time.
  const memberErrors: (string | undefined)[] = members.map((raw, i) =>
    validateMemberEntry(raw, i),
  );

  const hasPerMemberErrors = memberErrors.some((e) => e !== undefined);
  if (hasPerMemberErrors) {
    errors.members = memberErrors;
  }

  // ── Members — list-level ──────────────────────────────────────────────────
  //
  // `validMembers` is the set that will actually reach the contract: filled,
  // trimmed, and address-validated (no blank rows, no bad checksums, no
  // contract-prefix entries).  It must exclude every row that already failed
  // validateMemberEntry so that:
  //
  //   a) membersGeneral count messages reflect only submittable addresses.
  //      A form like [A, "bad"] has 1 submittable member, not 2.
  //
  //   b) the `values.validMembers` returned on ok:true never contains an
  //      address that failed per-field validation — closing the gap where
  //      the contract call could receive an invalid payload.
  //
  // Both `getFilledMembers` (blank filter) and the per-field error check run
  // on the same `members` array in the same iteration, so the two lists stay
  // in sync without a second pass.
  const validMembers = members
    .map((raw, i) => ({ trimmed: raw.trim(), error: memberErrors[i] }))
    .filter(({ trimmed, error }) => trimmed.length > 0 && error === undefined)
    .map(({ trimmed }) => trimmed);

  const countStatus = getMemberCountStatus(validMembers.length);

  if (countStatus === "too_few") {
    errors.membersGeneral =
      `At least ${MIN_MEMBERS} members are required. ` +
      (validMembers.length === 0
        ? "Add member addresses below."
        : `You have ${validMembers.length}.`);
  } else if (countStatus === "too_many") {
    errors.membersGeneral =
      `A circle cannot have more than ${MAX_MEMBERS} members. ` +
      `You have ${validMembers.length}; remove ${validMembers.length - MAX_MEMBERS}.`;
  } else {
    const dup = findDuplicateAddress(validMembers);
    if (dup) {
      errors.membersGeneral =
        `Duplicate address: ${shortAddress(dup)}. Each member must appear exactly once.`;
    }
  }

  // ── Return ────────────────────────────────────────────────────────────────
  const hasErrors =
    errors.name !== undefined ||
    errors.amount !== undefined ||
    errors.days !== undefined ||
    hasPerMemberErrors ||
    errors.membersGeneral !== undefined;

  if (hasErrors || amountStroops === undefined || daysNum === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    values: {
      name: trimmedName,
      validMembers,
      amountStroops,
      roundDays: daysNum,
    },
  };
}

// ─── FieldError ───────────────────────────────────────────────────────────────
//
// Defined outside the component so React never treats it as a new component
// type on re-render, which would cause unnecessary unmount/remount cycles and
// break the live-region semantics of role="alert".

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600 flex items-center gap-1">
      <span aria-hidden="true">⚠</span> {message}
    </p>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreateClient() {
  const router = useRouter();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>(["", "", "", ""]);
  const [roundUSDC, setRoundUSDC] = useState("100");
  const [roundDays, setRoundDays] = useState("30");

  // ── Submission state ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<CreateFormErrors>({});
  const [txHash, setTxHash] = useState("");
  const [copied, setCopied] = useState(false);

  // Whether validation has been attempted — controls when inline errors appear.
  // Before first submit, per-field errors are hidden so the form isn't
  // immediately hostile. After first submit they stay visible on every change.
  const [validated, setValidated] = useState(false);

  // Guards against concurrent submissions (rapid double-click, etc.)
  const submittingRef = useRef(false);

  // ── Stable IDs ─────────────────────────────────────────────────────────────
  const formId        = useId();
  const nameId        = useId();
  const amountId      = useId();
  const amountHintId  = useId();
  const daysId        = useId();
  const membersHintId = useId();
  const submitErrId   = useId();
  const successId     = useId();

  // ── Focus management ────────────────────────────────────────────────────────
  const submitErrorRef = useRef<HTMLDivElement>(null);
  const successRef     = useRef<HTMLDivElement>(null);
  // One ref per member row for focusing the first invalid field
  const memberRefs     = useRef<(HTMLInputElement | null)[]>([]);
  const nameRef        = useRef<HTMLInputElement>(null);
  const amountRef      = useRef<HTMLInputElement>(null);
  const daysRef        = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (submitError && submitErrorRef.current) submitErrorRef.current.focus();
  }, [submitError]);

  useEffect(() => {
    if (txHash && successRef.current) successRef.current.focus();
  }, [txHash]);

  // ── Derived values ──────────────────────────────────────────────────────────
  // Distinct filled addresses only: blank rows and repeated addresses never
  // reach the contract, so they must not inflate the counter, pot, or summary.
  const memberSummary = summarizeMemberRows(members);
  const filledCount = memberSummary.count;

  // Stroops for the currently-typed amount. `usdcToStroops` throws on invalid
  // input; during typing we just want a displayable (possibly zero) figure, so
  // fall back to 0n. All pot/collateral figures derive from this integer, never
  // from floating point, so the create page shows the same 2-dp formatUsdc /
  // formatPot values as the rest of the app (issue #493).
  const roundStroops = (() => {
    try {
      return usdcToStroops(roundUSDC || "0");
    } catch {
      return 0n;
    }
  })();

  const potDisplay = formatPot(roundStroops, filledCount);
  const memberAmountDisplay = formatUsdc(roundStroops);

  // Live-validate after first submit attempt so errors update as user types
  useEffect(() => {
    if (!validated) return;
    const result = validateCreateForm(name, members, roundUSDC, roundDays);
    setFieldErrors(result.ok ? {} : result.errors);
  }, [validated, name, members, roundUSDC, roundDays]);

  // ── Member helpers ──────────────────────────────────────────────────────────

  function updateMember(i: number, val: string) {
    setMembers((prev) => prev.map((m, idx) => (idx === i ? val : m)));
  }

  function addMember() {
    setMembers((prev) => (prev.length >= MAX_MEMBERS ? prev : [...prev, ""]));
  }

  function removeMember(i: number) {
    if (members.length <= MIN_MEMBERS) return;
    setMembers((prev) => prev.filter((_, idx) => idx !== i));
    // Shrink the refs array to stay in sync
    memberRefs.current = memberRefs.current.filter((_, idx) => idx !== i);
  }

  // ── Copy helper ─────────────────────────────────────────────────────────────
  async function copyTxHash() {
    const hash = txHash;
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — silently skip
    }
  }

  // ── Focus first error ────────────────────────────────────────────────────────
  function focusFirstError(errors: CreateFormErrors) {
    if (errors.name) { nameRef.current?.focus(); return; }
    if (errors.amount) { amountRef.current?.focus(); return; }
    if (errors.days) { daysRef.current?.focus(); return; }
    if (errors.members) {
      const firstIdx = errors.members.findIndex((e) => e !== undefined);
      if (firstIdx !== -1) { memberRefs.current[firstIdx]?.focus(); return; }
    }
    // membersGeneral — focus the first empty member slot if it exists
    const firstEmpty = members.findIndex((m) => m.trim() === "");
    if (firstEmpty !== -1) { memberRefs.current[firstEmpty]?.focus(); }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Prevent concurrent submissions (rapid double-click guard). Armed before
    // the first await so a second click during the wallet prompt is dropped,
    // and disarmed in `finally` (every path, success or failure, passes
    // through it).
    if (submittingRef.current) return;
    submittingRef.current = true;

    try {
      setSubmitError("");
      setTxHash("");
      setCopied(false);
      setValidated(true);

      // ── Step 1: field validation ──────────────────────────────────────────
      const validation = validateCreateForm(name, members, roundUSDC, roundDays);
      if (!validation.ok) {
        setFieldErrors(validation.errors);
        focusFirstError(validation.errors);
        return; // never reach wallet
      }
      setFieldErrors({});

      const { name: circleName, validMembers, amountStroops, roundDays: days } = validation.values;

      // ── Step 2: wallet check ──────────────────────────────────────────────
      let walletAddress: string | null;
      try {
        walletAddress = await getWalletAddress();
      } catch (err) {
        if (err instanceof WalletError && err.reason === "not_installed") {
          setSubmitError(
            "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
          );
        } else {
          setSubmitError(err instanceof Error ? err.message : "Failed to access wallet.");
        }
        return;
      }

      if (!walletAddress) {
        setSubmitError("Connect your Freighter wallet using the button in the top-right corner.");
        return;
      }

      // Self-address check — creator must not be in the member list
      const creatorLower = walletAddress.toLowerCase();
      if (validMembers.some((m) => m.toLowerCase() === creatorLower)) {
        setSubmitError(
          "Your wallet address cannot be included in the member list. " +
            "The circle creator is automatically a member.",
        );
        return;
      }

      // ── Step 3: factory address guard ─────────────────────────────────────
      if (!CIRCLE_FACTORY_ADDRESS) {
        setSubmitError("Factory contract not configured. Deploy contracts first.");
        return;
      }

      // ── Step 4: submit ────────────────────────────────────────────────────
      setLoading(true);
      const membersVec = xdr.ScVal.scvVec(
        validMembers.map((m) => new Address(m).toScVal()),
      );

      const result = await invokeContract(
        CIRCLE_FACTORY_ADDRESS,
        "create_circle",
        [
          new Address(walletAddress).toScVal(),
          nativeToScVal(circleName, { type: "string" }),
          membersVec,
          nativeToScVal(amountStroops, { type: "i128" }),
          nativeToScVal(daysToLedgers(days), { type: "u32" }),
        ],
        walletAddress,
      );

      if (!result.success) {
        setSubmitError(result.typedError?.message || result.error || "Transaction failed.");
        return;
      }

      setTxHash(result.txHash ?? "");
      setTimeout(() => router.push("/"), 5000);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  const explorerTxUrl = txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", txHash)
    : null;

  const submitBlocked = loading || !!txHash;

  const submitDescribedBy = [
    submitError ? submitErrId : null,
    txHash      ? successId   : null,
  ].filter(Boolean).join(" ") || undefined;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto px-2 sm:px-0">
      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-2">
        Create a Circle
      </h1>
      <p className="text-slate-500 text-sm mb-8">
        Set up the members, contribution amount, and schedule. The rotation order
        is the same as the member list — members contribute in the order listed,
        top to bottom.
      </p>

      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-6"
        aria-describedby={submitDescribedBy}
        noValidate
      >

        {/* ── Circle name ──────────────────────────────────────────────────── */}
        <div>
          <label
            htmlFor={nameId}
            className="block text-sm font-medium text-slate-700 mb-1"
          >
            Circle name <span aria-hidden="true" className="text-red-500">*</span>
          </label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH + 1} // +1 so user can see they've gone over
            placeholder="e.g. Family savings circle"
            className={`w-full border rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
              fieldErrors.name ? "border-red-400 focus:ring-red-400" : "border-slate-300"
            }`}
            aria-required="true"
            aria-invalid={fieldErrors.name ? "true" : undefined}
            aria-describedby={fieldErrors.name ? `${nameId}-err` : undefined}
            autoComplete="off"
          />
          <FieldError id={`${nameId}-err`} message={fieldErrors.name} />
          <p className="mt-1 text-xs text-slate-400">
            {name.trim().length}/{MAX_NAME_LENGTH} characters
          </p>
        </div>

        {/* ── Contribution amount + round duration ────────────────────────────
            Grouped on desktop (form-row → 2 columns ≥ sm), stacked on mobile. */}
        <div className="form-row">
          <div>
            <label
              htmlFor={amountId}
              className="block text-sm font-medium text-slate-700 mb-1"
            >
              Contribution per member / round (USDC){" "}
              <span aria-hidden="true" className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-lg" aria-hidden="true">$</span>
              <input
                id={amountId}
                ref={amountRef}
                type="number"
                min={MIN_AMOUNT_USDC}
                step="0.0000001"
                value={roundUSDC}
                onChange={(e) => setRoundUSDC(e.target.value)}
                className={`flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                  fieldErrors.amount ? "border-red-400 focus:ring-red-400" : "border-slate-300"
                }`}
                aria-required="true"
                aria-invalid={fieldErrors.amount ? "true" : undefined}
                aria-describedby={[
                  amountHintId,
                  fieldErrors.amount ? `${amountId}-err` : null,
                ].filter(Boolean).join(" ")}
                aria-label="Contribution amount in USDC"
              />
              <span className="text-slate-500 text-sm shrink-0">USDC</span>
            </div>
            <p id={amountHintId} className="text-xs text-slate-400 mt-1">
              Pot per round = ${memberAmountDisplay} ×{" "}
              {filledCount > 0 ? filledCount : "…"} member
              {filledCount !== 1 ? "s" : ""} = ${potDisplay}
            </p>
            <FieldError id={`${amountId}-err`} message={fieldErrors.amount} />
          </div>

          <div>
            <label
              htmlFor={daysId}
              className="block text-sm font-medium text-slate-700 mb-1"
            >
              Round duration (days){" "}
              <span aria-hidden="true" className="text-red-500">*</span>
            </label>
            <input
              id={daysId}
              ref={daysRef}
              type="number"
              min="1"
              max={MAX_ROUND_DAYS}
              step="1"
              value={roundDays}
              onChange={(e) => setRoundDays(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                fieldErrors.days ? "border-red-400 focus:ring-red-400" : "border-slate-300"
              }`}
              aria-required="true"
              aria-invalid={fieldErrors.days ? "true" : undefined}
              aria-describedby={fieldErrors.days ? `${daysId}-err` : undefined}
              aria-label="Round duration in days"
            />
            <FieldError id={`${daysId}-err`} message={fieldErrors.days} />
          </div>
        </div>

        {/* ── Members ───────────────────────────────────────────────────────── */}
        <fieldset>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
            <legend className="text-sm font-medium text-slate-700">
              Members (Stellar addresses){" "}
              <span aria-hidden="true" className="text-red-500">*</span>{" "}
              <span className="font-normal text-slate-500">— payout order top → bottom</span>
            </legend>
            {/* Counts filled, distinct addresses, not rows: a blank row is not a member. */}
            <span
              className={`text-xs font-medium ${
                memberSummary.status === "ok" ? "text-slate-500" : "text-amber-600"
              }`}
            >
              {filledCount} / {MAX_MEMBERS} members
            </span>
          </div>

          <ol
            className="space-y-2"
            aria-label="Member list — payout rotation order"
            aria-describedby={membersHintId}
          >
            {members.map((m, i) => {
              const fieldErr = fieldErrors.members?.[i];
              const inputId  = `member-${i}`;
              const errId    = `member-${i}-err`;
              const atMin    = members.length <= MIN_MEMBERS;
              return (
                <li key={i} className="flex flex-col gap-0.5">
                  {/* On narrow viewports the row stacks so a 56-character Stellar
                      address stays fully legible instead of being clipped inside
                      a shrunken input. Address entry needs the user's full
                      attention, so the input stays wide and readable.        */}
                  <div className="flex gap-2 sm:flex-row flex-col items-start sm:items-center">
                    <span
                      className="text-xs text-slate-400 w-5 shrink-0 text-right select-none self-start sm:self-center"
                      aria-hidden="true"
                    >
                      {i + 1}.
                    </span>
                    <input
                      id={inputId}
                      ref={(el) => { memberRefs.current[i] = el; }}
                      type="text"
                      placeholder={`G… (member ${i + 1})`}
                      value={m}
                      onChange={(e) => updateMember(i, e.target.value)}
                      className={`w-full sm:flex-1 min-w-0 border rounded-lg px-3 py-2.5 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                        fieldErr ? "border-red-400 focus:ring-red-400" : "border-slate-300"
                      }`}
                      aria-label={`Member ${i + 1} of ${members.length} — Stellar address (payout position ${i + 1})`}
                      aria-invalid={fieldErr ? "true" : undefined}
                      aria-describedby={fieldErr ? errId : undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => !atMin && removeMember(i)}
                      aria-label={
                        atMin
                          ? `Cannot remove member ${i + 1} — circle needs at least ${MIN_MEMBERS} members`
                          : `Remove member ${i + 1}`
                      }
                      aria-disabled={atMin ? "true" : undefined}
                      className={`p-2 -m-1 text-lg leading-none shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors ${
                        atMin
                          ? "text-slate-200 cursor-not-allowed"
                          : "text-slate-400 hover:text-red-500"
                      }`}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>

                  {fieldErr && (
                    <p
                      id={errId}
                      role="alert"
                      className="mt-0.5 ml-7 text-xs text-red-600 flex items-center gap-1"
                    >
                      <span aria-hidden="true">⚠</span> {fieldErr}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>

          {/* List-level member error (count, duplicates) */}
          {fieldErrors.membersGeneral && (
            <p
              role="alert"
              className="mt-2 text-xs text-red-600 flex items-center gap-1"
            >
              <span aria-hidden="true">⚠</span> {fieldErrors.membersGeneral}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={addMember}
              disabled={members.length >= MAX_MEMBERS}
              className="text-sm text-brand-600 hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline touch-target"
              aria-disabled={members.length >= MAX_MEMBERS}
            >
              + Add member
            </button>
            {members.length >= MAX_MEMBERS && (
              <span className="text-xs text-amber-600" role="status" aria-live="polite">
                Maximum of {MAX_MEMBERS} members reached.
              </span>
            )}
          </div>

          {/* Live count status, so the bounds are visible before the first submit. */}
          <p
            id={membersHintId}
            className={`text-xs mt-1 ${
              memberSummary.status === "ok" ? "text-slate-400" : "text-amber-700"
            }`}
            aria-live="polite"
            aria-atomic="true"
          >
            {memberSummary.status === "too_few"
              ? `Add ${MIN_MEMBERS - filledCount} more address${
                  MIN_MEMBERS - filledCount === 1 ? "" : "es"
                }. A circle needs ${MIN_MEMBERS} to ${MAX_MEMBERS} members.`
              : memberSummary.status === "too_many"
              ? `Remove ${filledCount - MAX_MEMBERS} address${
                  filledCount - MAX_MEMBERS === 1 ? "" : "es"
                }. A circle can have at most ${MAX_MEMBERS} members.`
              : `A circle needs ${MIN_MEMBERS} to ${MAX_MEMBERS} members. Empty rows are ignored.`}
          </p>
        </fieldset>

        {/* ── Summary card ──────────────────────────────────────────────────── */}
        <div
          className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-slate-700"
          aria-label="Circle summary"
        >
          <p className="font-semibold text-brand-800 mb-1">Circle summary</p>
          <ul className="space-y-0.5 text-slate-600" aria-live="polite" aria-atomic="true">
            {name.trim() && <li>📛 {name.trim()}</li>}
            <li>
              <span>
                👥 {filledCount} member{filledCount !== 1 ? "s" : ""}
                {memberSummary.status === "too_few" && ` (at least ${MIN_MEMBERS} needed)`}
              </span>
              {memberSummary.duplicateRows > 0 && (
                <span className="text-amber-700">
                  {` · ${memberSummary.duplicateRows} duplicate${memberSummary.duplicateRows !== 1 ? "s" : ""} not counted`}
                </span>
              )}
            </li>
            <li>💰 ${memberAmountDisplay} USDC / member / round</li>
            <li>🎯 Pot per round: ${potDisplay}</li>
            <li>📅 Round duration: {roundDays} days</li>
            <li>
              🔒 Collateral required: ${memberAmountDisplay} per member (1× round amount)
            </li>
          </ul>
        </div>

        {/* ── Submit-level error ────────────────────────────────────────────── */}
        {submitError && (
          <div
            id={submitErrId}
            ref={submitErrorRef}
            role="alert"
            tabIndex={-1}
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {submitError}
          </div>
        )}

        {/* ── Success ───────────────────────────────────────────────────────── */}
        {txHash && (
          <div
            id={successId}
            ref={successRef}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={-1}
            className="bg-brand-50 border border-brand-200 rounded-lg p-4 text-sm text-brand-700 space-y-3 focus:outline-none"
          >
            <p className="font-semibold text-brand-800 flex items-center gap-1.5">
              <span aria-hidden="true">✅</span> Circle created successfully!
            </p>
            <div>
              <p
                className="text-xs text-brand-600 mb-1 font-medium"
                id={`${successId}-hash-label`}
              >
                Transaction hash
              </p>
              <div className="flex items-center gap-2 bg-white border border-brand-200 rounded-lg px-3 py-2">
                <span
                  className="font-mono text-xs text-slate-700 flex-1 break-all select-all min-w-0"
                  aria-labelledby={`${successId}-hash-label`}
                >
                  {txHash}
                </span>
                <button
                  type="button"
                  onClick={copyTxHash}
                  className="text-brand-600 hover:text-brand-800 text-xs font-medium shrink-0 min-h-[44px] px-2"
                  aria-label={copied ? "Transaction hash copied" : "Copy transaction hash"}
                  aria-pressed={copied}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
            {explorerTxUrl && (
              <a
                href={explorerTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline hover:text-brand-900"
              >
                View on Stellar Expert ↗
              </a>
            )}
            <p className="text-xs text-slate-500" aria-live="polite" aria-atomic="true">
              Redirecting to circles list in a few seconds…
            </p>
          </div>
        )}

        {/* Pending state announcement */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {loading
            ? "Creating circle, please wait and approve the transaction in Freighter."
            : ""}
        </p>

        <button
          type="submit"
          disabled={submitBlocked}
          aria-busy={loading}
          aria-describedby={submitDescribedBy}
          className="w-full bg-brand-600 text-white py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg min-h-[48px]"
        >
          {loading ? "Creating circle…" : "Create Circle"}
        </button>
      </form>
    </div>
  );
}