import { describe, it, expect, vi } from "vitest";

// Mock next/link to render a simple anchor
vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-label": ariaLabel }: any) => (
    <a href={href} className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

// Mock config module to use stable values
vi.mock("@/lib/config", () => ({
  indexerEndpoint: (segments: string[]) => `http://localhost:3001/${segments.join("/")}`,
  INDEXER_TIMEOUT_MS: 5000,
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc: (stroops: bigint) => {
    const STROOP = 10_000_000n;
    const whole = stroops / STROOP;
    const frac = (stroops % STROOP).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
  formatPot: (stroops: bigint, count: number) => {
    const STROOP = 10_000_000n;
    const total = stroops * BigInt(count);
    const whole = total / STROOP;
    const frac = (total % STROOP).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
}));

import {
  parseCircleRow,
  isValidStatusFilter,
  CIRCLE_STATUS_OPTIONS,
  getBrowseState,
  type CircleRow,
} from "@/lib/circleTypes";

// Valid fixture addresses
const VALID_CONTRACT_1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_CONTRACT_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN";
const VALID_CREATOR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("Homepage data parsing & hardening — parseCircleRow", () => {
  it("parses a fully valid circle row successfully", () => {
    const raw = {
      address: VALID_CONTRACT_1,
      creator: VALID_CREATOR,
      round_amount: "100000000",
      member_count: 4,
      status: "Active",
      current_round: 2,
      total_rounds: 8,
      created_ledger: 1000,
      updated_at: "2026-09-29T22:00:00Z",
    };

    const parsed = parseCircleRow(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.address).toBe(VALID_CONTRACT_1);
    expect(parsed?.status).toBe("Active");
    expect(parsed?.member_count).toBe(4);
  });

  it("returns null for malformed circle rows (missing address or invalid Stellar format)", () => {
    expect(
      parseCircleRow({
        address: "not-an-address",
        creator: VALID_CREATOR,
        round_amount: "100000000",
        member_count: 4,
        status: "Active",
        current_round: 1,
        total_rounds: 4,
        created_ledger: 100,
        updated_at: "2026-09-29T22:00:00Z",
      }),
    ).toBeNull();
  });

  it("returns null for non-numeric round_amount", () => {
    expect(
      parseCircleRow({
        address: VALID_CONTRACT_1,
        creator: VALID_CREATOR,
        round_amount: "abc-stroops",
        member_count: 4,
        status: "Active",
        current_round: 1,
        total_rounds: 4,
        created_ledger: 100,
        updated_at: "2026-09-29T22:00:00Z",
      }),
    ).toBeNull();
  });

  it("returns null for negative member_count or current_round", () => {
    expect(
      parseCircleRow({
        address: VALID_CONTRACT_1,
        creator: VALID_CREATOR,
        round_amount: "10000000",
        member_count: -1,
        status: "Active",
        current_round: 1,
        total_rounds: 4,
        created_ledger: 100,
        updated_at: "2026-09-29T22:00:00Z",
      }),
    ).toBeNull();

    expect(
      parseCircleRow({
        address: VALID_CONTRACT_1,
        creator: VALID_CREATOR,
        round_amount: "10000000",
        member_count: 4,
        status: "Active",
        current_round: -5,
        total_rounds: 4,
        created_ledger: 100,
        updated_at: "2026-09-29T22:00:00Z",
      }),
    ).toBeNull();
  });

  it("safely filters out bad rows from a raw indexer response array", () => {
    const rawCircles = [
      {
        address: VALID_CONTRACT_1,
        creator: VALID_CREATOR,
        round_amount: "100000000",
        member_count: 4,
        status: "Active",
        current_round: 2,
        total_rounds: 8,
        created_ledger: 1000,
        updated_at: "2026-09-29T22:00:00Z",
      },
      // Bad record 1: invalid address
      { address: "BAD_ADDRESS", status: "Active" },
      // Bad record 2: non-numeric amount
      {
        address: VALID_CONTRACT_2,
        creator: VALID_CREATOR,
        round_amount: "invalid",
        member_count: 2,
        status: "Pending",
        current_round: 0,
        total_rounds: 4,
        created_ledger: 1000,
        updated_at: "2026-09-29T22:00:00Z",
      },
      // Valid record 2
      {
        address: VALID_CONTRACT_2,
        creator: VALID_CREATOR,
        round_amount: "50000000",
        member_count: 5,
        status: "Pending",
        current_round: 0,
        total_rounds: 5,
        created_ledger: 1050,
        updated_at: "2026-09-29T22:00:00Z",
      },
    ];

    const validRows: CircleRow[] = [];
    const seen = new Set<string>();

    for (const raw of rawCircles) {
      const circle = parseCircleRow(raw);
      if (!circle || seen.has(circle.address)) continue;
      seen.add(circle.address);
      validRows.push(circle);
    }

    expect(validRows).toHaveLength(2);
    expect(validRows[0].address).toBe(VALID_CONTRACT_1);
    expect(validRows[1].address).toBe(VALID_CONTRACT_2);
  });
});

describe("Status filter validation & options", () => {
  it("CIRCLE_STATUS_OPTIONS contains all expected status values", () => {
    expect(CIRCLE_STATUS_OPTIONS).toEqual([
      "Pending",
      "Active",
      "Completed",
      "Cancelled",
      "Closed",
    ]);
  });

  it("isValidStatusFilter accepts valid statuses and rejects crafted query parameters", () => {
    expect(isValidStatusFilter("Pending")).toBe(true);
    expect(isValidStatusFilter("Active")).toBe(true);
    expect(isValidStatusFilter("Closed")).toBe(true);

    expect(isValidStatusFilter("")).toBe(false);
    expect(isValidStatusFilter("ACTIVE")).toBe(false); // Case sensitive check for API status
    expect(isValidStatusFilter("<script>alert(1)</script>")).toBe(false);
    expect(isValidStatusFilter(123)).toBe(false);
    expect(isValidStatusFilter(null)).toBe(false);
  });
});

describe("Hero CTA state decision — getBrowseState", () => {
  it("returns 'unavailable' state when fetch result is null or failed", () => {
    expect(getBrowseState(null)).toEqual({ kind: "unavailable" });
    expect(getBrowseState({ ok: false, error: "network" })).toEqual({ kind: "unavailable" });
    expect(getBrowseState({ ok: false, error: "server" })).toEqual({ kind: "unavailable" });
  });

  it("returns 'empty' state when indexer returns zero total circles", () => {
    expect(getBrowseState({ ok: true, circles: [], total: 0 })).toEqual({ kind: "empty" });
  });

  it("returns 'browse' state with count when indexer has circles", () => {
    const dummyCircle: CircleRow = {
      address: VALID_CONTRACT_1,
      creator: VALID_CREATOR,
      round_amount: "10000000",
      member_count: 3,
      status: "Active",
      current_round: 1,
      total_rounds: 3,
      created_ledger: 100,
      updated_at: "2026-09-29T22:00:00Z",
    };

    expect(getBrowseState({ ok: true, circles: [dummyCircle], total: 1 })).toEqual({
      kind: "browse",
      count: 1,
    });
  });
});
