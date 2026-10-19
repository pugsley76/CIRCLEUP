// ─── Indexer response wire contracts ──────────────────────────────────────────
//
// Runtime descriptions of the JSON bodies returned by the public indexer
// endpoints, used to detect silent wire drift — renamed fields, changed
// nullability, or a numeric field switching between a JSON number and a
// string — that still arrives as HTTP 200.
//
// The compatibility fixtures in __tests__/indexerResponseFixtures.ts are
// validated against these schemas, and IndexerClient performs a shallow
// envelope check on every response. See docs/INDEXER_API_COMPATIBILITY.md for
// the policy that distinguishes safe additions from breaking changes.
//
// Compatibility rules encoded here:
//   • Unknown fields are ignored by `validateIndexerResponse` — adding a field
//     is a compatible change. `listUnknownFields` reports them so the fixtures
//     and schemas can be kept in sync deliberately.
//   • A required field that disappears, becomes null without `nullable`, or
//     changes wire type is a violation — that is a breaking change.

/**
 * Wire representation of a single JSON value.
 *
 * | Type        | Accepted JSON                                              |
 * |-------------|------------------------------------------------------------|
 * | `string`    | any string                                                 |
 * | `integer`   | a JSON number that is a safe integer                       |
 * | `boolean`   | `true` / `false`                                           |
 * | `stroops`   | a decimal integer **string** (e.g. `"100000000"`) — monetary amounts must never be JSON numbers, which lose precision above 2^53 |
 * | `bigint`    | a non-negative integer as a JSON number *or* decimal string — Postgres BIGINT columns (ledger sequences) serialise as strings, while values computed in JS serialise as numbers |
 * | `timestamp` | an ISO-8601 string that `Date.parse` accepts               |
 * | `object`    | a JSON object validated against `fields`                   |
 * | `array`     | a JSON array whose elements match `items`                  |
 * | `record`    | a JSON object with arbitrary keys whose values match `values` |
 */
export type IndexerWireType =
  | "string"
  | "integer"
  | "boolean"
  | "stroops"
  | "bigint"
  | "timestamp"
  | "object"
  | "array"
  | "record";

/** Contract for one field (or array element / record value). */
export interface IndexerFieldSpec {
  type: IndexerWireType;
  /** `null` is an accepted value. */
  nullable?: boolean;
  /** The key may be absent (or `undefined`, which JSON omits). */
  optional?: boolean;
  /** For `string`: the closed set of accepted values. */
  enum?: readonly string[];
  /** For `object`: the nested field contracts. */
  fields?: IndexerObjectSchema;
  /** For `array`: the contract every element must satisfy. */
  items?: IndexerFieldSpec;
  /** For `record`: the contract every value must satisfy. */
  values?: IndexerFieldSpec;
}

/** Field contracts for a JSON object, keyed by field name. */
export type IndexerObjectSchema = Record<string, IndexerFieldSpec>;

/** One mismatch between a response body and its schema. */
export interface IndexerSchemaViolation {
  /** JSONPath-style location, e.g. `$.circles[0].round_amount`. */
  path: string;
  /** What the schema requires at `path`. */
  expected: string;
  /** What was found (a type name, never the raw value). */
  actual: string;
}

// ── Spec builders ──────────────────────────────────────────────────────────────

const str = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "string", ...extra });
const int = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "integer", ...extra });
const bool = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "boolean", ...extra });
const stroops = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "stroops", ...extra });
const big = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "bigint", ...extra });
const ts = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "timestamp", ...extra });
const obj = (fields: IndexerObjectSchema, extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({
  type: "object",
  fields,
  ...extra,
});
const arr = (items: IndexerFieldSpec, extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({
  type: "array",
  items,
  ...extra,
});
const rec = (values: IndexerFieldSpec): IndexerFieldSpec => ({ type: "record", values });

// ── Shared row schemas ─────────────────────────────────────────────────────────

const CIRCLE_STATUSES = ["Pending", "Active", "Completed", "Cancelled", "Closed"] as const;
const ROUND_PHASES = ["completed", "current", "cancelled", "open"] as const;

const PAGINATION = obj({
  page: int(),
  limit: int(),
  total: int(),
  totalPages: int(),
  hasMore: bool({ optional: true }),
});

/** ApiCircleRow — GET /circles rows and the `circle` of GET /circles/:address. */
const CIRCLE_ROW: IndexerObjectSchema = {
  address: str(),
  creator: str(),
  round_amount: stroops(),
  member_count: int(),
  status: str({ enum: CIRCLE_STATUSES }),
  current_round: int(),
  total_rounds: int(),
  created_ledger: big(),
  updated_at: ts(),
  // Detail-only fields (the detail endpoint selects every column).
  id: int({ optional: true }),
  deadline_ledger: big({ optional: true, nullable: true }),
  round_deadline_ledgers: big({ optional: true, nullable: true }),
};

/** ApiMemberRow — GET /circles/:address and GET /circles/:address/members. */
const MEMBER_ROW: IndexerObjectSchema = {
  member_address: str(),
  payout_order: int(),
  join_order: int({ nullable: true }),
  collateral: stroops(),
  defaults: int(),
  joined_at: ts({ nullable: true }),
  // LEFT JOIN on reputation: null for members with no reputation row yet.
  reputation_score: int({ nullable: true }),
  // Present on the members endpoint, which aggregates contributions.
  total_contributions: int({ optional: true }),
  // `SELECT cm.*` on the detail endpoint also exposes the row identity.
  id: int({ optional: true }),
  circle_address: str({ optional: true }),
};

/** A contribution row nested in a round (`SELECT * FROM contributions`). */
const ROUND_CONTRIBUTION = obj({
  member_address: str(),
  amount: stroops(),
  tx_hash: str(),
  id: int({ optional: true }),
  circle_address: str({ optional: true }),
  round_index: int({ optional: true }),
  ledger: big({ optional: true }),
  created_at: ts({ optional: true }),
});

/** A default row (`SELECT * FROM defaults`). */
const DEFAULT_ROW = obj({
  member_address: str(),
  penalty: stroops(),
  id: int({ optional: true }),
  circle_address: str({ optional: true }),
  round_index: int({ optional: true }),
  tx_hash: str({ optional: true }),
  ledger: big({ optional: true }),
  created_at: ts({ optional: true }),
});

/** ApiRoundRow — one grouped round from GET /circles/:address/rounds. */
const ROUND_ROW = obj({
  roundIndex: int(),
  status: str({ enum: ROUND_PHASES }),
  recipient: str({ nullable: true }),
  amount: stroops({ nullable: true }),
  txHash: str({ nullable: true }),
  ledger: big({ optional: true, nullable: true }),
  deadlineLedger: big({ optional: true, nullable: true }),
  contributions: arr(ROUND_CONTRIBUTION),
  defaults: arr(DEFAULT_ROW),
});

// ── Endpoint schemas ───────────────────────────────────────────────────────────

/**
 * Response contracts for every public indexer endpoint the SDK or app reads.
 *
 * Keys are stable identifiers; the comment on each names its route.
 */
export const INDEXER_RESPONSE_SCHEMAS = {
  /** GET /circles */
  circlesList: {
    circles: arr(obj(CIRCLE_ROW)),
    pagination: PAGINATION,
  },
  /** GET /circles/:address */
  circleDetail: {
    circle: obj(CIRCLE_ROW),
    members: arr(obj(MEMBER_ROW)),
    latestLedger: big({ nullable: true }),
  },
  /** GET /circles/:address/members */
  members: {
    members: arr(obj(MEMBER_ROW)),
    totals: obj(
      {
        memberCount: int(),
        totalCollateral: stroops(),
        totalContributions: int(),
      },
      { optional: true },
    ),
    roundDeadlineLedgers: big({ optional: true, nullable: true }),
  },
  /** GET /circles/:address/rounds */
  rounds: {
    rounds: arr(ROUND_ROW),
    openRounds: arr(ROUND_ROW),
    pendingDefaults: arr(DEFAULT_ROW),
    currentRound: { ...ROUND_ROW, nullable: true },
  },
  /** GET /members/:member/contributions */
  memberContributions: {
    member: str(),
    circle: str({ nullable: true }),
    contributions: arr(
      obj({
        circle_address: str(),
        member_address: str(),
        round_index: int(),
        amount: stroops(),
        tx_hash: str(),
        ledger: big(),
        created_at: ts(),
      }),
    ),
    totalAmount: stroops({ optional: true }),
    pagination: PAGINATION,
  },
  /** GET /reputation/:member */
  reputation: {
    member: str(),
    found: bool(),
    score: int({ nullable: true }),
    detail: str({ optional: true }),
    contributions: arr(
      obj({ circle_address: str(), contributions: int(), total_rounds: int() }),
    ),
    defaults: arr(obj({ circle_address: str(), count: int() })),
    events: arr(obj({ type: str(), delta: int() }), { optional: true }),
    updatedAt: ts({ nullable: true }),
  },
  /** GET /circles/:address/audit */
  auditEvents: {
    circle_address: str(),
    events: arr(
      obj({
        id: int(),
        circle_address: str(),
        event_type: str({ enum: ["cancelled", "closed"] }),
        triggered_by: str({ nullable: true }),
        ledger: big({ nullable: true }),
        tx_hash: str({ nullable: true }),
        total_released: stroops({ nullable: true }),
        total_expected_collateral: stroops({ nullable: true }),
        close_reason: str({ nullable: true }),
        created_at: ts(),
      }),
    ),
  },
  /**
   * GET /health — only the fields the SDK's ApiHealthResponse relies on are
   * required; the component breakdown is operator-facing and may evolve.
   */
  health: {
    status: str({ enum: ["ok", "degraded"] }),
    timestamp: ts(),
    serviceStatus: str({ optional: true, enum: ["healthy", "degraded", "unavailable"] }),
  },
  /** GET /indexer/state */
  indexerState: {
    lastLedger: big(),
    updatedAt: ts(),
    totalEvents: int(),
    eventCounts: rec(int()),
    entityCounts: obj({
      circles: int(),
      members: int(),
      contributions: int(),
      payouts: int(),
      defaults: int(),
      circlesByStatus: rec(int()),
    }),
  },
} satisfies Record<string, IndexerObjectSchema>;

/** Identifier of a schema in {@link INDEXER_RESPONSE_SCHEMAS}. */
export type IndexerEndpointName = keyof typeof INDEXER_RESPONSE_SCHEMAS;

// ── Validation ─────────────────────────────────────────────────────────────────

const STROOPS_RE = /^-?\d+$/;
const UINT_STRING_RE = /^\d+$/;

/** Describe a value's JSON type without echoing the value itself. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkField(
  spec: IndexerFieldSpec,
  value: unknown,
  path: string,
  out: IndexerSchemaViolation[],
): void {
  if (value === undefined) {
    if (!spec.optional) out.push({ path, expected: spec.type, actual: "missing" });
    return;
  }
  if (value === null) {
    if (!spec.nullable) out.push({ path, expected: spec.type, actual: "null" });
    return;
  }

  const mismatch = (expected: string, actual = describe(value)): void => {
    out.push({ path, expected, actual });
  };

  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return mismatch("string");
      if (spec.enum && !spec.enum.includes(value)) {
        return mismatch(`one of ${spec.enum.join(" | ")}`, "unlisted string");
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return mismatch("integer");
      return;
    case "boolean":
      if (typeof value !== "boolean") return mismatch("boolean");
      return;
    case "stroops":
      if (typeof value !== "string") return mismatch("decimal integer string");
      if (!STROOPS_RE.test(value)) return mismatch("decimal integer string", "non-numeric string");
      return;
    case "bigint":
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) return mismatch("non-negative integer");
        return;
      }
      if (typeof value === "string") {
        if (!UINT_STRING_RE.test(value)) return mismatch("non-negative integer", "non-numeric string");
        return;
      }
      return mismatch("non-negative integer");
    case "timestamp":
      if (typeof value !== "string") return mismatch("ISO-8601 timestamp");
      if (Number.isNaN(Date.parse(value))) return mismatch("ISO-8601 timestamp", "unparseable string");
      return;
    case "object":
      if (!isPlainObject(value)) return mismatch("object");
      checkObject(spec.fields ?? {}, value, path, out);
      return;
    case "array":
      if (!Array.isArray(value)) return mismatch("array");
      if (spec.items) {
        value.forEach((item, i) => checkField(spec.items!, item, `${path}[${i}]`, out));
      }
      return;
    case "record":
      if (!isPlainObject(value)) return mismatch("object");
      if (spec.values) {
        for (const [key, item] of Object.entries(value)) {
          checkField(spec.values, item, `${path}.${key}`, out);
        }
      }
      return;
  }
}

function checkObject(
  schema: IndexerObjectSchema,
  value: Record<string, unknown>,
  path: string,
  out: IndexerSchemaViolation[],
): void {
  for (const [key, spec] of Object.entries(schema)) {
    checkField(spec, value[key], `${path}.${key}`, out);
  }
}

/**
 * Validate a decoded JSON body against an endpoint schema.
 *
 * Returns every violation found (empty when the body is compatible). Fields
 * the schema does not mention are ignored, so additive server changes pass.
 * Violation entries describe types only and never include response values,
 * so they are safe to log.
 *
 * @example
 * const problems = validateIndexerResponse("circlesList", await res.json());
 * if (problems.length > 0) console.warn("indexer drift", problems);
 */
export function validateIndexerResponse(
  endpoint: IndexerEndpointName,
  body: unknown,
): IndexerSchemaViolation[] {
  const out: IndexerSchemaViolation[] = [];
  if (!isPlainObject(body)) {
    out.push({ path: "$", expected: "object", actual: describe(body) });
    return out;
  }
  checkObject(INDEXER_RESPONSE_SCHEMAS[endpoint], body, "$", out);
  return out;
}

/**
 * List fields present in `body` that the endpoint schema does not describe.
 *
 * Unknown fields are compatible by policy; this helper exists so fixture
 * tests can require every new field to be documented in the schema before
 * clients start depending on it. Record-typed values are not descended into
 * since their keys are data, not contract.
 */
export function listUnknownFields(endpoint: IndexerEndpointName, body: unknown): string[] {
  const out: string[] = [];
  const walk = (schema: IndexerObjectSchema, value: unknown, path: string) => {
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const spec = schema[key];
      const childPath = `${path}.${key}`;
      if (!spec) {
        out.push(childPath);
        continue;
      }
      walkSpec(spec, child, childPath);
    }
  };
  const walkSpec = (spec: IndexerFieldSpec, value: unknown, path: string) => {
    if (spec.type === "object" && spec.fields) walk(spec.fields, value, path);
    if (spec.type === "array" && spec.items && Array.isArray(value)) {
      value.forEach((item, i) => walkSpec(spec.items!, item, `${path}[${i}]`));
    }
  };
  walk(INDEXER_RESPONSE_SCHEMAS[endpoint], body, "$");
  return out;
}
