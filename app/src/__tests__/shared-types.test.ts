/**
 * Cross-package type fixtures (issue #647).
 *
 * Verifies that the wire types imported from @circleup/sdk are structurally
 * compatible with the type aliases used throughout the app. These tests
 * catch drift at compile time: if the SDK changes a wire type, the app's
 * type aliases break here before they break in production.
 *
 * The canonical source of truth for all indexer API shapes is
 * sdk/src/types.ts, re-exported from @circleup/sdk.
 */

import { describe, test, expect } from "vitest";
import type {
  ApiMemberRow,
  ApiContributionRecord,
  ApiDefaultRecord,
  ApiRoundRow,
  ApiCircleRow,
  ApiCircleStatus,
  RoundPhase,
} from "@circleup/sdk";

import type {
  CircleMember,
  ContributionRecord,
  DefaultRecord,
  CircleRound,
  CirclePendingDefault,
  CircleState,
  CircleDetailData,
} from "@/app/circles/[address]/CircleDetailClient";
import type { Circle } from "@/components/CircleCard";

// ─── Compile-time structural compatibility ──────────────────────────────────
//
// These type-level assertions use the `extends` constraint to verify that
// each app alias is bidirectionally assignable to its SDK counterpart. If
// the SDK changes a field, these assertions fail at compile time.

// CircleMember ↔ ApiMemberRow
type _AssertCircleMemberExtendsApi = CircleMember extends ApiMemberRow ? true : never;
type _AssertApiExtendsCircleMember = ApiMemberRow extends CircleMember ? true : never;
const _c1: _AssertCircleMemberExtendsApi = true;
const _c2: _AssertApiExtendsCircleMember = true;

// ContributionRecord ↔ ApiContributionRecord
type _AssertContribExtends = ContributionRecord extends ApiContributionRecord ? true : never;
type _AssertApiContribExtends = ApiContributionRecord extends ContributionRecord ? true : never;
const _c3: _AssertContribExtends = true;
const _c4: _AssertApiContribExtends = true;

// DefaultRecord ↔ ApiDefaultRecord
type _AssertDefaultExtends = DefaultRecord extends ApiDefaultRecord ? true : never;
type _AssertApiDefaultExtends = ApiDefaultRecord extends DefaultRecord ? true : never;
const _c5: _AssertDefaultExtends = true;
const _c6: _AssertApiDefaultExtends = true;

// CircleRound ↔ ApiRoundRow
type _AssertRoundExtends = CircleRound extends ApiRoundRow ? true : never;
type _AssertApiRoundExtends = ApiRoundRow extends CircleRound ? true : never;
const _c7: _AssertRoundExtends = true;
const _c8: _AssertApiRoundExtends = true;

// CirclePendingDefault ↔ ApiDefaultRecord
type _AssertPendingDefaultExtends = CirclePendingDefault extends ApiDefaultRecord ? true : never;
type _AssertApiPendingDefaultExtends = ApiDefaultRecord extends CirclePendingDefault ? true : never;
const _c9: _AssertPendingDefaultExtends = true;
const _c10: _AssertApiPendingDefaultExtends = true;

// CircleState is a Pick of ApiCircleRow
type _AssertCircleStateIsPick = CircleState extends Pick<
  ApiCircleRow,
  "status" | "current_round" | "total_rounds" | "round_amount" | "member_count" | "deadline_ledger"
> ? true : never;
const _c11: _AssertCircleStateIsPick = true;

// Circle is a Pick of ApiCircleRow
type _AssertCircleIsPick = Circle extends Pick<
  ApiCircleRow,
  "address" | "creator" | "round_amount" | "member_count" | "status" | "current_round" | "total_rounds" | "created_ledger"
> ? true : never;
const _c12: _AssertCircleIsPick = true;

// CircleDetailData.circle is CircleState
type _AssertCircleDetailDataCircle = CircleDetailData["circle"] extends CircleState ? true : never;
const _c13: _AssertCircleDetailDataCircle = true;

// CircleDetailData.members is CircleMember[]
type _AssertCircleDetailDataMembers = CircleDetailData["members"] extends CircleMember[] ? true : never;
const _c14: _AssertCircleDetailDataMembers = true;

// CircleDetailData.rounds is CircleRound[]
type _AssertCircleDetailDataRounds = CircleDetailData["rounds"] extends CircleRound[] ? true : never;
const _c15: _AssertCircleDetailDataRounds = true;

// ─── Runtime fixtures ────────────────────────────────────────────────────────

const MEMBER_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CONTRACT_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

describe("shared wire types (issue #647)", () => {
  test("ApiMemberRow fixture satisfies CircleMember alias", () => {
    const member: ApiMemberRow = {
      member_address: MEMBER_ADDRESS,
      payout_order: 0,
      collateral: "10000000",
      defaults: 0,
      joined_at: null,
      reputation_score: 3,
      total_contributions: 0,
    };
    // The alias should accept the SDK-typed object without any cast
    const aliased: CircleMember = member;
    expect(aliased.member_address).toBe(member.member_address);
  });

  test("ApiRoundRow fixture satisfies CircleRound alias", () => {
    const round: ApiRoundRow = {
      roundIndex: 0,
      status: "current" as RoundPhase,
      recipient: null,
      amount: null,
      txHash: null,
      ledger: null,
      contributions: [],
      defaults: [],
    };
    const aliased: CircleRound = round;
    expect(aliased.roundIndex).toBe(0);
  });

  test("ApiContributionRecord fixture satisfies ContributionRecord alias", () => {
    const record: ApiContributionRecord = {
      member_address: MEMBER_ADDRESS,
      amount: "10000000",
      tx_hash: "abc123",
    };
    const aliased: ContributionRecord = record;
    expect(aliased.tx_hash).toBe("abc123");
  });

  test("ApiDefaultRecord fixture satisfies DefaultRecord and CirclePendingDefault aliases", () => {
    const record: ApiDefaultRecord = {
      member_address: MEMBER_ADDRESS,
      penalty: "1000000",
    };
    const asDefault: DefaultRecord = record;
    const asPending: CirclePendingDefault = record;
    expect(asDefault.penalty).toBe("1000000");
    expect(asPending.penalty).toBe("1000000");
  });

  test("ApiCircleRow fields used by Circle are compatible", () => {
    const row: ApiCircleRow = {
      address: CONTRACT_ADDRESS,
      creator: MEMBER_ADDRESS,
      round_amount: "10000000",
      member_count: 4,
      status: "Active" as ApiCircleStatus,
      current_round: 0,
      total_rounds: 4,
      created_ledger: 100,
      updated_at: "2024-01-01T00:00:00Z",
    };
    // Circle is a Pick — every field in Circle should be present in ApiCircleRow
    const circle: Circle = {
      address: row.address,
      creator: row.creator,
      round_amount: row.round_amount,
      member_count: row.member_count,
      status: row.status,
      current_round: row.current_round,
      total_rounds: row.total_rounds,
      created_ledger: row.created_ledger,
    };
    expect(circle.address).toBe(row.address);
  });

  test("CircleDetailData accepts SDK-typed fields", () => {
    const member: ApiMemberRow = {
      member_address: MEMBER_ADDRESS,
      payout_order: 0,
      collateral: "10000000",
      defaults: 0,
      joined_at: null,
      reputation_score: 3,
      total_contributions: 0,
    };
    const currentRound: ApiRoundRow = {
      roundIndex: 0,
      status: "current",
      recipient: null,
      amount: null,
      txHash: null,
      ledger: null,
      contributions: [],
      defaults: [],
    };
    const detail: CircleDetailData = {
      circle: {
        status: "Active",
        current_round: 0,
        total_rounds: 4,
        round_amount: "10000000",
        member_count: 1,
        deadline_ledger: 5000,
      },
      members: [member],
      rounds: [],
      openRounds: [],
      pendingDefaults: [],
      latestLedger: 4000,
      currentRound,
    };
    expect(detail.members).toHaveLength(1);
    expect(detail.currentRound?.roundIndex).toBe(0);
  });
});
