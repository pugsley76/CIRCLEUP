/**
 * Circle member fallback — Issue #509 "Add stable fallback content when circle
 * member data is unavailable".
 *
 * Coverage:
 *   parseMemberRows()  — accepts well-formed rows, coerces display fields,
 *                        sorts by payout order, and returns [] (all-or-nothing)
 *                        for anything that would put a member in the wrong slot
 *   CircleDetailClient — renders a placeholder rotation inside the Rotation
 *                        Order card when members are unavailable, and the
 *                        real rotation (no placeholder) once they arrive
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn().mockResolvedValue(null),
  invokeContract: vi.fn(),
  isFreighterInstalled: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, ACTIVE_NETWORK: "testnet", getExplorerLink: () => null };
});

import { parseMemberRows } from "../lib/members";
import {
  CircleDetailClient,
  fetchCircleData,
  type CircleDetailData,
} from "../app/circles/[address]/CircleDetailClient";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

const A = addrFor(1);
const B = addrFor(2);
const C = addrFor(3);
const CIRCLE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

/** A member row exactly as the indexer's /circles/:address route returns it. */
function row(address: string, payoutOrder: number, extra: Record<string, unknown> = {}) {
  return {
    member_address: address,
    payout_order: payoutOrder,
    collateral: "10000000",
    defaults: 0,
    joined_at: "2026-09-01T00:00:00.000Z",
    reputation_score: 3,
    total_contributions: "2", // COUNT(*) arrives as a string from pg
    ...extra,
  };
}

function makeData(overrides: Partial<CircleDetailData> = {}): CircleDetailData {
  return {
    circle: {
      status: "Pending",
      current_round: 0,
      total_rounds: 3,
      round_amount: "10000000",
      member_count: 3,
    },
    members: [],
    rounds: [],
    openRounds: [],
    pendingDefaults: [],
    latestLedger: 1000,
    currentRound: null,
    ...overrides,
  };
}

// ─── parseMemberRows ──────────────────────────────────────────────────────────

describe("parseMemberRows", () => {
  it("returns [] when the field is missing or not an array", () => {
    expect(parseMemberRows(undefined)).toEqual([]);
    expect(parseMemberRows(null)).toEqual([]);
    expect(parseMemberRows({})).toEqual([]);
    expect(parseMemberRows("members")).toEqual([]);
  });

  it("returns [] for an empty list", () => {
    expect(parseMemberRows([])).toEqual([]);
  });

  it("keeps well-formed rows and coerces string counts to numbers", () => {
    const [m] = parseMemberRows([row(A, 0)]);
    expect(m).toEqual({
      member_address: A,
      payout_order: 0,
      collateral: "10000000",
      defaults: 0,
      joined_at: "2026-09-01T00:00:00.000Z",
      reputation_score: 3,
      total_contributions: 2,
    });
  });

  it("sorts rows by payout order whatever order the indexer sent", () => {
    const members = parseMemberRows([row(C, 2), row(A, 0), row(B, 1)]);
    expect(members.map((m) => m.member_address)).toEqual([A, B, C]);
  });

  it("defaults display-only fields instead of dropping the list", () => {
    const [m] = parseMemberRows([
      row(A, 0, {
        reputation_score: null, // no reputation row yet (LEFT JOIN)
        defaults: undefined,
        total_contributions: "not-a-number",
        collateral: undefined,
        joined_at: undefined,
      }),
      row(B, 1),
    ]);
    expect(m.reputation_score).toBe(0);
    expect(m.defaults).toBe(0);
    expect(m.total_contributions).toBe(0);
    expect(m.collateral).toBe("0");
    expect(m.joined_at).toBeNull();
  });

  it.each([
    ["a non-object row", [row(A, 0), null]],
    ["a missing address", [row(A, 0), row("", 1)]],
    ["a malformed address", [row(A, 0), row("GNOTANADDRESS", 1)]],
    ["a contract address", [row(A, 0), row(CIRCLE, 1)]],
    ["a missing payout_order", [row(A, 0), row(B, undefined as unknown as number)]],
    ["a negative payout_order", [row(A, 0), row(B, -1)]],
    ["a fractional payout_order", [row(A, 0), row(B, 1.5)]],
    ["a duplicate address", [row(A, 0), row(A, 1)]],
    ["a duplicate payout_order", [row(A, 0), row(B, 0)]],
  ])("returns [] (all-or-nothing) for %s", (_label, rows) => {
    // Dropping just the bad row would shift later members into the wrong
    // rotation slot, so the whole list is treated as unavailable.
    expect(parseMemberRows(rows)).toEqual([]);
  });
});

// ─── fetchCircleData with the indexer's real row shape ───────────────────────
//
// GET /circles/:address returns `SELECT cm.*, r.score AS reputation_score`:
// no total_contributions column at all, collateral as a NUMERIC string, and a
// null reputation_score for anyone without a reputation row yet. A strict
// per-row parser rejected every one of these rows, so each client refresh
// emptied the rotation of a perfectly healthy circle.

describe("fetchCircleData — member rows as the indexer actually sends them", () => {
  it("keeps every member", async () => {
    const indexerRow = (address: string, payoutOrder: number) => ({
      id: payoutOrder + 1,
      circle_address: CIRCLE,
      member_address: address,
      payout_order: payoutOrder,
      collateral: "10000000",
      defaults: 0,
      joined_at: null,
      reputation_score: null,
    });
    const circle = {
      address: CIRCLE,
      status: "Pending",
      current_round: 0,
      total_rounds: 3,
      round_amount: "10000000",
      member_count: 3,
      deadline_ledger: null,
    };
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/rounds")
              ? { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null }
              : {
                  circle,
                  members: [indexerRow(A, 0), indexerRow(B, 1), indexerRow(C, 2)],
                  latestLedger: 1000,
                },
          ),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await fetchCircleData(CIRCLE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.members.map((m) => m.member_address)).toEqual([A, B, C]);
      expect(result.data.members[0]).toMatchObject({
        reputation_score: 0,
        total_contributions: 0,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── Rotation Order fallback ──────────────────────────────────────────────────

function rotationCard() {
  const heading = screen.getByRole("heading", { name: /rotation order/i });
  return within(heading.parentElement as HTMLElement);
}

describe("CircleDetailClient — Rotation Order when member data is unavailable", () => {
  it("renders the fallback message inside the Rotation Order card", async () => {
    render(<CircleDetailClient circleAddress={CIRCLE} circleData={makeData()} />);
    await waitFor(() => expect(screen.queryByText(/checking wallet/i)).toBeNull());

    const card = rotationCard();
    expect(
      card.getByText(/member details are not available right now/i),
    ).toBeInTheDocument();
    expect(card.getByText(/this circle has 3 members/i)).toBeInTheDocument();
  });

  it("keeps the card's height stable with one placeholder row per expected member", async () => {
    render(<CircleDetailClient circleAddress={CIRCLE} circleData={makeData()} />);
    await waitFor(() => expect(screen.queryByText(/checking wallet/i)).toBeNull());

    expect(rotationCard().getAllByText("Member details unavailable")).toHaveLength(3);
  });

  it("never shows an address, payout marker, or contribution status in the fallback", async () => {
    render(
      <CircleDetailClient
        circleAddress={CIRCLE}
        circleData={makeData({
          circle: {
            status: "Active",
            current_round: 1,
            total_rounds: 3,
            round_amount: "10000000",
            member_count: 3,
          },
        })}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/checking wallet/i)).toBeNull());

    const card = rotationCard();
    expect(card.queryByText(/next payout/i)).toBeNull();
    expect(card.queryByText(/received \$/i)).toBeNull();
    expect(card.queryByText(/contributions shown for the current round/i)).toBeNull();
  });

  it("caps placeholder rows when the reported member_count is large", async () => {
    render(
      <CircleDetailClient
        circleAddress={CIRCLE}
        circleData={makeData({
          circle: {
            status: "Pending",
            current_round: 0,
            total_rounds: 200,
            round_amount: "10000000",
            member_count: 200,
          },
        })}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/checking wallet/i)).toBeNull());

    expect(rotationCard().getAllByText("Member details unavailable")).toHaveLength(20);
  });

  it("omits placeholder rows when member_count is unknown", async () => {
    render(
      <CircleDetailClient
        circleAddress={CIRCLE}
        circleData={makeData({
          circle: {
            status: "Pending",
            current_round: 0,
            total_rounds: 0,
            round_amount: "10000000",
            member_count: 0,
          },
        })}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/checking wallet/i)).toBeNull());

    const card = rotationCard();
    expect(card.getByText(/member details are not available right now/i)).toBeInTheDocument();
    expect(card.queryByText("Member details unavailable")).toBeNull();
  });

  it("renders the real rotation and no fallback once members are present", async () => {
    const members = parseMemberRows([row(A, 0), row(B, 1), row(C, 2)]);
    render(<CircleDetailClient circleAddress={CIRCLE} circleData={makeData({ members })} />);
    await waitFor(() => expect(screen.queryByText(/checking wallet/i)).toBeNull());

    const card = rotationCard();
    expect(card.queryByText(/member details are not available/i)).toBeNull();
    expect(card.getByText(A)).toBeInTheDocument();
    expect(card.getByText(C)).toBeInTheDocument();
  });
});
