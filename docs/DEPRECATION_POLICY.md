# CircleUp — Deprecation and Removal Policy

This document defines how public interfaces are deprecated and eventually removed.
It applies to every interface an external client can rely on: indexer REST routes
and wire fields, SDK exported symbols, contract events, and error codes.

The core commitment is that **no public interface is removed silently**. Every
removal follows the same notice → deprecation → removal sequence documented here,
with a minimum notice period before the interface disappears.

For the canonical list of current interfaces see:
- [docs/EVENTS.md](./EVENTS.md) — contract events
- [sdk/src/index.ts](../sdk/src/index.ts) — SDK public entry-point
- [indexer/src/api.ts](../indexer/src/api.ts) — REST routes and response shapes

---

## Table of Contents

- [Interface categories and their versioning mechanism](#interface-categories-and-their-versioning-mechanism)
- [Deprecation lifecycle](#deprecation-lifecycle)
- [Notice period by category](#notice-period-by-category)
- [How to mark something deprecated](#how-to-mark-something-deprecated)
  - [REST API routes and response fields](#rest-api-routes-and-response-fields)
  - [SDK exported symbols](#sdk-exported-symbols)
  - [Contract events](#contract-events)
  - [Error codes and panic messages](#error-codes-and-panic-messages)
- [Release note requirements](#release-note-requirements)
- [Test expectations for a deprecation lifecycle](#test-expectations-for-a-deprecation-lifecycle)
- [Backcompat guarantees that do NOT apply](#backcompat-guarantees-that-do-not-apply)
- [Escalation: emergency removal](#escalation-emergency-removal)

---

## Interface categories and their versioning mechanism

| Category | Versioning mechanism | Canonical reference |
|---|---|---|
| REST routes (`GET /circles`, etc.) | Route path. No `/v2/` prefix today; breaking changes increment the path version when introduced. | `indexer/src/api.ts` |
| REST response fields | Field presence in JSON. Adding a field is non-breaking. Removing or renaming is breaking. | `indexer/src/api.ts` + `sdk/src/types.ts` |
| SDK exported symbols | `sdk/package.json` semver. Only symbols re-exported from `sdk/src/index.ts` are stable. | `sdk/src/index.ts` |
| Contract events (topics + data tuple) | Topic pair `(family, name)`. Adding a trailing field is non-breaking. Reordering or removing is breaking. | `docs/EVENTS.md` |
| Contract error codes / panic messages | The exact string constant in the Rust source. The message is the API. | `contracts/circle/src/lib.rs`, `contracts/reputation/src/lib.rs` |

CircleUp does not yet publish a separate API version header. Until it does, the
`CHANGELOG.md` version tag and the `sdk/package.json` semver are the integrator's
signal of compatibility. When a route-level `/v2/` scheme is introduced this
document will be updated.

---

## Deprecation lifecycle

Every interface goes through four stages:

```
Active  →  Deprecated  →  Sunset  →  Removed
```

| Stage | What it means | What integrators must do |
|---|---|---|
| **Active** | Supported and stable | Nothing |
| **Deprecated** | Still functional; removal is announced | Start migration |
| **Sunset** | Disabled by default or behind a flag; final warning | Complete migration |
| **Removed** | Gone from the codebase | Switch to replacement |

The minimum calendar time between *Deprecated* and *Removed* depends on
interface category (see [Notice period by category](#notice-period-by-category)).
A *Deprecated* interface is never removed in the same release that marks it
deprecated.

---

## Notice period by category

| Category | Minimum notice before removal | Rationale |
|---|---|---|
| REST route | 2 minor releases | Route removal breaks every client that calls it |
| REST response field | 2 minor releases | Field removal breaks every parser that reads it |
| SDK exported symbol | 1 minor release (semver minor bump) | Consumers compile against the package; one release gives time to update |
| Contract event topic/data field | 2 minor releases | Indexer parsers and external subscribers must all be updated |
| Contract error / panic message | 1 minor release | Message strings may be matched by test harnesses or UIs |

"Minor release" maps to a `MINOR` semver increment in `sdk/package.json` and a
correspondingly dated entry in `CHANGELOG.md`. CircleUp's current pre-1.0 policy
treats every `0.x` bump as a minor release for notice purposes.

---

## How to mark something deprecated

### REST API routes and response fields

1. Add a response header to the deprecated route:

   ```
   Deprecation: true
   Sunset: <ISO 8601 date>
   Link: <https://github.com/CIRCLEUP-AJO/CIRCLEUP/blob/main/CHANGELOG.md>; rel="deprecation"
   ```

   In `api.ts`, set these inside the route handler before calling `res.json()`:

   ```typescript
   res.set("Deprecation", "true");
   res.set("Sunset", "2027-01-01");
   res.set("Link", `<${CHANGELOG_URL}>; rel="deprecation"`);
   ```

2. Add a comment block directly above the route definition:

   ```typescript
   /**
    * @deprecated since 0.3.0 — use GET /circles/summary instead.
    * Sunset: 2027-01-01. Will be removed in 0.5.0.
    */
   app.get("/circles/count", ...)
   ```

3. For a **response field** removal, add a warning field alongside the old field
   in the next release, then remove the original field in the release after sunset:

   ```json
   {
     "count": 12,
     "_deprecatedCount_removedIn050": "use summary.total instead"
   }
   ```

4. Update `docs/EVENTS.md` stability note for event fields (see
   [Contract events](#contract-events) below).

### SDK exported symbols

1. Add a JSDoc `@deprecated` tag with a replacement and removal target version:

   ```typescript
   /**
    * @deprecated since 0.3.0 — use `formatUsdc` instead. Removed in 0.5.0.
    */
   export function formatUsdcLegacy(...) { ... }
   ```

2. For a type alias or interface, mark it the same way:

   ```typescript
   /**
    * @deprecated since 0.3.0 — replaced by `ApiCircleDetailResponse`.
    * Removed in 0.5.0.
    */
   export type CircleDetailResponse = ApiCircleDetailResponse;
   ```

3. Keep the symbol in `sdk/src/index.ts` re-exports until the removal release.
   Move deprecated symbols to a clearly named section at the bottom of the file:

   ```typescript
   // ── Deprecated — removed in 0.5.0 ────────────────────────────────────────
   export { formatUsdcLegacy } from "./utils";
   ```

4. Add a type-level test in `sdk/examples/public-api.ts` that imports the
   deprecated symbol — this ensures it remains importable from the package root
   until the planned removal date and is removed alongside the symbol:

   ```typescript
   // TODO(remove-in-0.5.0): remove when formatUsdcLegacy is removed
   import { formatUsdcLegacy } from "@circleup/sdk";
   void formatUsdcLegacy;
   ```

### Contract events

Contract events are defined by their topic pair `(family, name)` and the
**order and types** of data tuple fields. See `docs/EVENTS.md` — stability
contract section — for the canonical definition.

When a new version of an event adds or changes fields:

1. **Adding a trailing field** — non-breaking. Update `docs/EVENTS.md` with
   the new field marked *(added in vX.Y)*. No deprecation notice required.

2. **Renaming or removing a field, or reordering the tuple** — breaking. The
   old event name is retired and a new event name is introduced:
   - The old name (`e.g. "circle/payout"`) is emitted for one release cycle
     alongside the new name (`e.g. "circle/payout_v2"`) so indexers can be
     updated before the old event disappears.
   - Document both names in `docs/EVENTS.md` with the old name marked
     *Deprecated — removed in vX.Y* and the new name as *Active*.
   - The indexer handler for the old event is removed in the same release
     that removes the old event from the contract.

3. **Adding a completely new event** — non-breaking; no deprecation notice.

### Error codes and panic messages

Contract error messages are the strings in `#[should_panic(expected = "...")]`
tests and user-facing UI error handling. They are part of the public API because
integrators may match on them.

When renaming or removing an error message:

1. Add the new message in a release where both the old and new message strings
   produce the same contract behaviour (no functional change yet).
2. Announce the rename in `CHANGELOG.md`.
3. Remove the old message string one minor release later.
4. Update the `#[should_panic(expected = "...")]` tests in
   `contracts/circle/src/mutation_guards.rs` to match the new string.
5. If the message appears in `app/src/lib/contractErrors.ts` or
   `indexer/src/fixtures/incident-fixtures.ts`, update both in the same PR.

---

## Release note requirements

Every deprecation, sunset, or removal **must** appear in `CHANGELOG.md` under
the release it takes effect. Use the following headings:

```markdown
### Deprecated
- **GET /circles/count** (route) — use GET /circles/summary instead.
  Sunset: 2027-01-01. Removal target: 0.5.0. `Link` header added.
- **`formatUsdcLegacy`** (SDK) — use `formatUsdc`. Removal target: 0.5.0.
  JSDoc `@deprecated` tag added.

### Removed
- **GET /circles/count** — deprecated in 0.3.0, now removed.
  Migration: use GET /circles/summary.
```

A release that removes an interface without a `### Removed` entry in its
CHANGELOG block does not satisfy this policy.

---

## Test expectations for a deprecation lifecycle

Each phase of the lifecycle has a corresponding test obligation:

| Phase | Test obligation |
|---|---|
| **Deprecated** | The `Deprecation` response header is present in an integration test. Deprecated SDK symbols compile from `sdk/examples/public-api.ts`. |
| **Sunset** | The old interface returns HTTP 410 Gone (routes) or a compile error (removed SDK symbol). An integration test asserts the 410. |
| **Removed** | All tests that referenced the old interface are deleted or updated. `sdk/examples/public-api.ts` no longer imports the symbol. `cargo test` has no `#[should_panic]` matching the old error string. |

When adding a `@deprecated` JSDoc tag to an SDK symbol, update the
corresponding `describe` block in the relevant test suite to include a comment:

```typescript
// TODO(remove-in-0.5.0): remove this describe block when formatUsdcLegacy is removed
describe("formatUsdcLegacy (deprecated)", () => { ... });
```

This makes it easy to find and delete stale test coverage at removal time.

---

## Backcompat guarantees that do NOT apply

The following are explicitly **not** covered by this policy and may change
between any two releases:

- **Internal module paths** — `@circleup/sdk/dist/client`, `../src/gating`, etc.
  Only the package root (`@circleup/sdk`) is stable.
- **Database schema internals** — Column names, index names, and table layouts
  in Postgres are internal to the indexer. Clients must use the REST API.
- **Deployment manifest schema** — `scripts/src/deployment-manifest.ts` exports
  types for tooling use, but the manifest file format may change between
  releases without a notice period (it is a build artifact, not a public API).
- **Incident fixture shapes** — `indexer/src/fixtures/incident-fixtures.ts` is
  a test helper. Its exported namespaces carry no stability guarantee.
- **`_health` and `_schema` endpoints** — `GET /indexer/health` and
  `GET /indexer/schema` are operational endpoints; their response shapes may
  evolve without notice.

---

## Escalation: emergency removal

A security vulnerability may require removing an interface without the standard
notice period. In that case:

1. Remove the interface immediately in a patch release.
2. Add a `### Security` entry in `CHANGELOG.md` explaining what was removed and
   why (without disclosing exploitable details before a fix is available).
3. Publish a coordinated disclosure notice as described in `SECURITY.md`.
4. Link the disclosure from the `### Removed` CHANGELOG entry after the
   disclosure embargo lifts.

An emergency removal is the only exception to the minimum notice period rule.
