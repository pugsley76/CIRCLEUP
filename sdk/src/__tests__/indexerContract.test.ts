/**
 * Issue #661: indexer response compatibility checks.
 *
 * HTTP 200 does not mean the body still matches what the SDK and app parse.
 * These tests validate representative fixtures for every public endpoint
 * against the runtime schemas in `indexerSchema.ts`, and pin down which kinds
 * of drift are tolerated (additive fields) versus rejected (renames,
 * nullability changes, numeric wire-type changes).
 *
 * Policy: docs/INDEXER_API_COMPATIBILITY.md
 */

import { describe, it, expect } from "vitest";
import {
  INDEXER_RESPONSE_SCHEMAS,
  listUnknownFields,
  validateIndexerResponse,
  type IndexerEndpointName,
} from "../indexerSchema";
import {
  AUDIT_EVENTS_FIXTURE,
  CIRCLE_DETAIL_FIXTURE,
  CIRCLES_LIST_FIXTURE,
  HEALTH_FIXTURE,
  INDEXER_STATE_FIXTURE,
  MEMBER_CONTRIBUTIONS_FIXTURE,
  MEMBERS_FIXTURE,
  REPUTATION_FIXTURE,
  REPUTATION_UNKNOWN_MEMBER_FIXTURE,
  ROUNDS_FIXTURE,
} from "./indexerResponseFixtures";

const FIXTURES: Array<[IndexerEndpointName, string, unknown]> = [
  ["circlesList", "GET /circles", CIRCLES_LIST_FIXTURE],
  ["circleDetail", "GET /circles/:address", CIRCLE_DETAIL_FIXTURE],
  ["members", "GET /circles/:address/members", MEMBERS_FIXTURE],
  ["rounds", "GET /circles/:address/rounds", ROUNDS_FIXTURE],
  ["memberContributions", "GET /members/:member/contributions", MEMBER_CONTRIBUTIONS_FIXTURE],
  ["reputation", "GET /reputation/:member", REPUTATION_FIXTURE],
  ["reputation", "GET /reputation/:member (unknown member)", REPUTATION_UNKNOWN_MEMBER_FIXTURE],
  ["auditEvents", "GET /circles/:address/audit", AUDIT_EVENTS_FIXTURE],
  ["health", "GET /health", HEALTH_FIXTURE],
  ["indexerState", "GET /indexer/state", INDEXER_STATE_FIXTURE],
];

/** Deep clone so mutation tests never leak into other cases. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─── Fixtures match their schemas ─────────────────────────────────────────────

describe("indexer fixtures validate against their schemas", () => {
  it("covers every schema with at least one fixture", () => {
    const covered = new Set(FIXTURES.map(([name]) => name));
    for (const name of Object.keys(INDEXER_RESPONSE_SCHEMAS)) {
      expect(covered.has(name as IndexerEndpointName), `no fixture for ${name}`).toBe(true);
    }
  });

  it.each(FIXTURES)("%s — %s has no violations", (endpoint, _label, fixture) => {
    expect(validateIndexerResponse(endpoint, fixture)).toEqual([]);
  });

  it.each(FIXTURES.filter(([name]) => name !== "health"))(
    "%s — %s documents every field it carries",
    (endpoint, _label, fixture) => {
      // A new field must be added to the schema (and so to the policy review)
      // before a fixture — and therefore a client — relies on it. /health is
      // excluded: its component breakdown is operator-facing, not SDK contract.
      expect(listUnknownFields(endpoint, fixture)).toEqual([]);
    },
  );

  it("survives a JSON round-trip unchanged (fixtures are pure wire data)", () => {
    for (const [endpoint, , fixture] of FIXTURES) {
      expect(validateIndexerResponse(endpoint, clone(fixture))).toEqual([]);
    }
  });
});

// ─── Compatible (additive) changes ────────────────────────────────────────────

describe("additive changes are compatible", () => {
  it("accepts a new top-level field", () => {
    const body = { ...clone(CIRCLES_LIST_FIXTURE), generatedAt: "2026-01-01T00:00:00Z" };
    expect(validateIndexerResponse("circlesList", body)).toEqual([]);
    expect(listUnknownFields("circlesList", body)).toEqual(["$.generatedAt"]);
  });

  it("accepts a new field on a nested row", () => {
    const body = clone(CIRCLE_DETAIL_FIXTURE);
    (body.members[0] as Record<string, unknown>).nickname = "alice";
    expect(validateIndexerResponse("circleDetail", body)).toEqual([]);
    expect(listUnknownFields("circleDetail", body)).toEqual(["$.members[0].nickname"]);
  });

  it("accepts a new key inside a record-typed map", () => {
    const body = clone(INDEXER_STATE_FIXTURE);
    (body.eventCounts as Record<string, number>).circle_closed = 2;
    expect(validateIndexerResponse("indexerState", body)).toEqual([]);
    expect(listUnknownFields("indexerState", body)).toEqual([]);
  });

  it("accepts omission of an optional field", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, unknown>;
    delete body.totalAmount;
    expect(validateIndexerResponse("memberContributions", body)).toEqual([]);
  });

  it("accepts a BIGINT ledger as either a decimal string or a JSON number", () => {
    const asNumber = clone(CIRCLES_LIST_FIXTURE);
    (asNumber.circles[0] as Record<string, unknown>).created_ledger = 1_200_000;
    expect(validateIndexerResponse("circlesList", asNumber)).toEqual([]);
    expect(validateIndexerResponse("circlesList", CIRCLES_LIST_FIXTURE)).toEqual([]);
  });
});

// ─── Breaking changes are caught ──────────────────────────────────────────────

describe("incompatible wire drift is reported", () => {
  it("flags a renamed required field", () => {
    const body = clone(CIRCLES_LIST_FIXTURE);
    const row = body.circles[0] as Record<string, unknown>;
    row.roundAmount = row.round_amount;
    delete row.round_amount;
    expect(validateIndexerResponse("circlesList", body)).toContainEqual({
      path: "$.circles[0].round_amount",
      expected: "stroops",
      actual: "missing",
    });
  });

  it("flags a monetary amount serialised as a JSON number", () => {
    const body = clone(ROUNDS_FIXTURE);
    (body.rounds[0] as Record<string, unknown>).amount = 200000000;
    expect(validateIndexerResponse("rounds", body)).toContainEqual({
      path: "$.rounds[0].amount",
      expected: "decimal integer string",
      actual: "integer",
    });
  });

  it("flags a count serialised as a string (unconverted COUNT(*))", () => {
    const body = clone(REPUTATION_FIXTURE);
    (body.contributions[0] as Record<string, unknown>).contributions = "2";
    expect(validateIndexerResponse("reputation", body)).toContainEqual({
      path: "$.contributions[0].contributions",
      expected: "integer",
      actual: "string",
    });
  });

  it("flags null in a non-nullable field", () => {
    const body = clone(MEMBERS_FIXTURE);
    (body.members[0] as Record<string, unknown>).collateral = null;
    expect(validateIndexerResponse("members", body)).toContainEqual({
      path: "$.members[0].collateral",
      expected: "stroops",
      actual: "null",
    });
  });

  it("flags an unknown enum value", () => {
    const body = clone(CIRCLES_LIST_FIXTURE);
    (body.circles[0] as Record<string, unknown>).status = "Archived";
    const [violation] = validateIndexerResponse("circlesList", body);
    expect(violation.path).toBe("$.circles[0].status");
    expect(violation.actual).toBe("unlisted string");
  });

  it("flags a removed envelope array", () => {
    const body = clone(ROUNDS_FIXTURE) as Record<string, unknown>;
    delete body.openRounds;
    expect(validateIndexerResponse("rounds", body)).toContainEqual({
      path: "$.openRounds",
      expected: "array",
      actual: "missing",
    });
  });

  it("flags a non-object body", () => {
    expect(validateIndexerResponse("health", [])).toEqual([
      { path: "$", expected: "object", actual: "array" },
    ]);
  });

  it("never echoes response values in violations", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE);
    (body.contributions[0] as Record<string, unknown>).amount = "secret-looking-value";
    const violations = validateIndexerResponse("memberContributions", body);
    expect(JSON.stringify(violations)).not.toContain("secret-looking-value");
  });
});
