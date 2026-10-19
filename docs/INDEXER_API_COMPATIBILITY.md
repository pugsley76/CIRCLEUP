# CircleUp — Indexer API Compatibility Policy

The indexer REST API is consumed by the SDK (`IndexerClient`) and the app. A
response can drift — a field renamed, a value becoming `null`, a number turning
into a string — and still come back as HTTP 200. This document defines which
response changes are safe and which need a coordinated release, and how the
fixtures catch drift before it ships.

See also: [`DEPRECATION_POLICY.md`](./DEPRECATION_POLICY.md) for notice
periods, [`CONTRACT_FIXTURES.md`](./CONTRACT_FIXTURES.md) for the equivalent
contract-argument fixtures.

---

## Where the contract lives

| File | Role |
|------|------|
| `sdk/src/indexerSchema.ts` | Runtime schemas (`INDEXER_RESPONSE_SCHEMAS`) — required fields, nullability, and wire types per endpoint. Exported with `validateIndexerResponse` and `listUnknownFields`. |
| `sdk/src/__tests__/indexerResponseFixtures.ts` | One representative body per endpoint, matching what `indexer/src/api.ts` serialises. |
| `sdk/src/__tests__/indexerContract.test.ts` | Validates every fixture against its schema and pins down the compatible vs. breaking cases below. |
| `sdk/src/client.ts` (`IndexerClient`) | Checks each response's top-level envelope at runtime and throws `IndexerError` with `kind: "schema"` on a mismatch. |

Covered endpoints: `GET /circles` (list), `GET /circles/:address` (detail),
`GET /circles/:address/members`, `GET /circles/:address/rounds`,
`GET /members/:member/contributions` (history), `GET /reputation/:member`,
`GET /circles/:address/audit`, `GET /health`, `GET /indexer/state`.

## Wire types

The TypeScript interfaces in `sdk/src/types.ts` describe *meaning*; the
schemas describe the *wire*. They differ where Postgres serialisation does:

| Wire type | Used for | Accepted JSON |
|-----------|----------|---------------|
| `stroops` | Monetary amounts (NUMERIC) | Decimal integer **string** only. A JSON number is a breaking change — it loses precision above 2^53. |
| `bigint` | Ledger sequences, `round_deadline_ledgers` (BIGINT) | Non-negative integer as a decimal string *or* a JSON number. Postgres BIGINT columns arrive as strings; values computed in JS arrive as numbers. |
| `integer` | Counts, indices, order positions | JSON number (safe integer). `COUNT(*)` must be converted with `Number()` before serialising. |
| `timestamp` | TIMESTAMPTZ columns | ISO-8601 string. |
| `record` | `eventCounts`, `circlesByStatus` | Object whose keys are data, not contract. |

## Compatible changes (no coordinated release)

These may ship in the indexer alone. Clients ignore what they do not read.

- Adding a new response field, at any depth.
- Adding a new key inside a `record`-typed map.
- Making a previously `nullable` field always non-null.
- Adding a new endpoint.

When adding a field, add it to the schema and the fixture in the same PR —
the fixture test fails on undocumented fields (`listUnknownFields`), so the
schema stays a complete description of what clients may rely on. Fields
that are new should be `optional` in the schema until every supported
indexer deployment returns them.

## Breaking changes (coordinated release required)

Each of these fails `indexerContract.test.ts` on purpose:

- Removing or renaming a required field.
- Making a non-nullable field nullable, or omitting a required field.
- Changing a field's wire type — e.g. an amount from string to number, or a
  count from number to string.
- Adding a value to a closed enum (`status`, round `status`, audit
  `event_type`) — clients that switch over the enum would mis-handle it.
- Changing the top-level envelope (e.g. returning a bare array).

To ship one:

1. Follow [`DEPRECATION_POLICY.md`](./DEPRECATION_POLICY.md): where possible,
   add the new shape alongside the old one first (a compatible change), and
   remove the old one after the notice period.
2. Update the schema, fixture, and the TypeScript interface together.
3. Release the SDK and app versions that accept the new shape **before or
   together with** the indexer release; record the change under
   `### Changed` / `### Removed` in `CHANGELOG.md` with the minimum compatible
   SDK version.

## Runtime behaviour

`IndexerClient` validates only the envelope at runtime (the top-level
collections each method returns), so additive changes never break callers and
deep validation cost is not paid on every request. Applications that want
full validation — for example, a diagnostics page — can call
`validateIndexerResponse(endpoint, body)` themselves. Violations report paths
and types only, never response values, so they are safe to log.
