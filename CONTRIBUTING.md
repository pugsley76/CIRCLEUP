# Contributing to CircleUp

Thank you for helping build trustless savings circles for the world. Every contribution matters — bug fixes, docs, contract improvements, or UI polish.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Commit Style](#commit-style)
- [Pull Request Process](#pull-request-process)
- [Code Style](#code-style)
- [Governance References](#governance-references)
- [Definition of Done](#definition-of-done)
  - [How to use this section](#how-to-use-this-section)
  - [Scope A — Contract change (funds, guards, deadlines, protocol constants)](#scope-a--contract-change-funds-guards-deadlines-protocol-constants)
  - [Scope B — SDK or gating change (types, eligibility, error handling)](#scope-b--sdk-or-gating-change-types-eligibility-error-handling)
  - [Scope C — Indexer change (schema, events, API, migrations)](#scope-c--indexer-change-schema-events-api-migrations)
  - [Scope D — App or UI change (pages, components, wallet flow)](#scope-d--app-or-ui-change-pages-components-wallet-flow)
  - [Scope E — Identity or reputation change](#scope-e--identity-or-reputation-change)
  - [Scope F — Security or authorization change](#scope-f--security-or-authorization-change)
  - [Scope G — Deployment or infrastructure change](#scope-g--deployment-or-infrastructure-change)
  - [Evidence quick-reference](#evidence-quick-reference)
- [Reporting Bugs](#reporting-bugs)

---

## Getting Started

1. Fork the repo on GitHub
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/CIRCLEUP`
3. Create a feature branch: `git checkout -b feat/your-feature`
4. Make your changes, following the [Definition of Done](#definition-of-done) for your scope
5. Open a pull request against `main`

---

## Development Setup

```bash
# Install Node dependencies
npm install

# Build the SDK
npm run build:sdk

# Start the app (requires indexer + Postgres running)
npm run dev:app

# Start the indexer
npm run dev:indexer

# Run Rust contract tests (requires Rust + stellar-cli)
cd contracts && cargo test

# Run indexer tests (offline — no Postgres required for unit tests)
npm test --workspace=indexer

# Run incident reproduction tests only (fully offline)
npm run test:incidents --workspace=indexer

# Type-check the app
npx tsc --noEmit --project app/tsconfig.json
```

See the [RUNBOOK](./docs/RUNBOOK.md) for full environment variable setup.

---

## How to Contribute

**Bug fixes** — Open an issue first describing the bug, then submit a PR with a fix and a test if possible.

**New features** — Open an issue to discuss the feature before building it. For contract changes especially, discuss the design first.

**Documentation** — PRs that improve docs, examples, or comments are always welcome without prior discussion.

**Tests** — Additional unit tests for the Rust contracts or TypeScript SDK are always appreciated.

---

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

feat(circle): add grace period before mark_default
fix(indexer): handle null contractId in event response
docs(readme): update quick start steps
chore(ci): upgrade to Node 24
test(contracts): add edge case for zero collateral
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `ci`, `build`

---

## Pull Request Process

1. Make sure CI passes (TypeScript build + Rust compile + ESLint)
2. Keep PRs focused — one feature or fix per PR
3. Update `CHANGELOG.md` under `[Unreleased]` with what you changed, following the issue reference format in the [Traceability Policy](./docs/TRACEABILITY_POLICY.md)
4. Fill in the PR template, including the Definition of Done checklist for your scope
5. Request a review from a maintainer
6. PRs are squash-merged into `main`

If your PR removes or renames a public interface (REST field, SDK export, contract event, error code), follow the notice and deprecation procedure in the [Deprecation Policy](./docs/DEPRECATION_POLICY.md) before merging.

---

## Code Style

**Rust** — `cargo fmt` before committing. Follow existing patterns in the contracts.

**TypeScript** — ESLint + Prettier. Run `npm run lint` before committing.

**React** — Server components for data fetching, client components only where interactivity is needed. Keep `"use client"` boundaries minimal.

---

## Governance References

These documents define standards that apply across the whole codebase. Read the
one(s) relevant to your change before opening a PR.

| Document | When to read it |
|---|---|
| [docs/DEPRECATION_POLICY.md](./docs/DEPRECATION_POLICY.md) | Before removing or renaming any REST field, SDK export, contract event topic/field, or error message |
| [docs/DATA_DICTIONARY.md](./docs/DATA_DICTIONARY.md) | When adding or changing indexer schema columns, migrations, or API response fields; or to understand units, nullability, and rebuildability for any table |
| [docs/DEPLOYMENT_LIFECYCLE.md](./docs/DEPLOYMENT_LIFECYCLE.md) | Before redeploying contracts to any network; defines how to archive superseded manifests and update profiles |
| [docs/TRACEABILITY_POLICY.md](./docs/TRACEABILITY_POLICY.md) | Defines when issue numbers belong in test names, migration comments, CHANGELOG entries, and PR descriptions |

---

## Definition of Done

This section is the single source of validation requirements for changes that touch funds, identity, deadlines, or reputation.  It is organized by **change scope** — each PR belongs to one or more scopes, and must satisfy all gates for every scope it touches.

If a gate does not apply to your change, write a one-line note explaining why (e.g. "no new contract entry-points added"). Do not leave gates blank.

Reviewers: your job is to verify that evidence exists for each gate, not to re-run commands yourself.

---

### How to use this section

1. Read through the scope descriptions below and identify every scope your PR touches.
2. For each scope, work through its gate list and collect the evidence (command output, test names, migration filenames, etc.).
3. Paste the evidence into the PR description under the corresponding scope heading.
4. If you skip a gate, explain why in the PR description. Unexplained skips block merge.
5. For CHANGELOG entries and test names, follow the [Traceability Policy](./docs/TRACEABILITY_POLICY.md) — issue references belong in the CHANGELOG bullet and in test names that cover non-obvious invariants or specific bug fixes.

A change can touch multiple scopes. A contract change that also requires an indexer migration must satisfy both Scope A and Scope C.

---

### Scope A — Contract change (funds, guards, deadlines, protocol constants)

Applies to any modification of `contracts/circle/src/lib.rs`, `contracts/circle_factory/src/lib.rs`, `contracts/reputation/src/lib.rs`, or any of the shared `Cargo.toml` dependency versions.

#### Success path gates

**A1 — All existing contract tests pass**

```bash
cd contracts && cargo test
```

Evidence required: test output showing 0 failures. If you added new tests, list their names.

**A2 — Mutation guards cover any new financial path**

For every guard you add, modify, or remove, there must be a corresponding test in `contracts/circle/src/mutation_guards.rs` that proves removal of the guard is detected. See the [mutation guard catalogue](./docs/RUNBOOK.md#contract-mutation-guards-rust) for examples.

Evidence required: name of the new/updated mutation guard test, or an explicit statement that no new guard was added.

**A3 — Property invariants hold**

If you changed a numeric boundary (`PENALTY_BPS`, `BPS_DENOM`, `COLLATERAL_MULTIPLIER`, `MIN/MAX_ROUND_DEADLINE_LEDGERS`, `MAX_MEMBERS`), verify that all property-based tests in `contracts/circle/src/prop_tests.rs` still pass and update any invariant that changed semantics.

```bash
cd contracts && cargo test prop_tests
```

Evidence required: prop_tests output, or confirmation that no protocol constants changed.

**A4 — WASM compiles without warnings**

```bash
cd contracts && cargo build --target wasm32-unknown-unknown --release 2>&1 | grep -i warn
```

Evidence required: zero new warnings, or a justification for any warning present.

**A5 — SDK types and app interfaces are updated**

Any new or renamed entry-point, event field, or return type must be reflected in:
- `app/src/lib/stellar.ts` (call helpers and result types)
- `app/src/lib/gating.ts` (if the change affects eligibility logic)
- `app/src/lib/config.ts` (if the change affects constants like USDC denomination)

Evidence required: list of files updated, or confirmation that no public interface changed.

**A6 — Indexer handles any new event type**

If you added a new contract event, there must be a handler in `indexer/src/indexer.ts`, a migration for any new columns, and a fixture in `indexer/src/fixtures/incident-fixtures.ts` for the new event class.

Evidence required: new event type name, handler function name, and migration filename; or confirmation that no new events were added.

**A7 — Runbook updated**

If the change alters observable behavior (new error message, new status, new deadline rule), update the corresponding troubleshooting section in `docs/RUNBOOK.md`.

Evidence required: runbook section updated, or confirmation that no user-visible behavior changed.

#### Failure path gates

**A8 — The failure case is tested**

For every new guard, the test suite must include at least one test that puts the contract into the blocked state and asserts the correct panic message. Use `#[should_panic(expected = "...")]`.

Evidence required: test name and the expected panic message.

**A9 — Rollback plan documented**

For changes that modify on-chain storage layout (new `DataKey` variants, changed value types), document the rollback plan: which ledgers would be affected, whether a re-deploy is required, and whether any indexer replay is needed.

Evidence required: rollback notes in the PR description, or confirmation that storage layout is unchanged.

---

### Scope B — SDK or gating change (types, eligibility, error handling)

Applies to modifications of `app/src/lib/gating.ts`, `app/src/lib/stellar.ts`, `app/src/lib/config.ts`, or any SDK package under `sdk/`.

If your change removes or renames an exported symbol, a type, or an error message string, follow the [Deprecation Policy](./docs/DEPRECATION_POLICY.md) notice procedure before removing the old symbol.

#### Success path gates

**B1 — Gating mutation tests pass**

```bash
node --require ts-node/register --test app/src/lib/gating.mutation.test.ts
```

Evidence required: test output, or an explanation of why the changed guard is not covered.

**B2 — New guard has a mutation proof**

If you added or tightened an eligibility guard in `gating.ts`, add a corresponding block in `gating.mutation.test.ts` that:
1. Asserts the production function blocks the edge case.
2. Demonstrates via a local mutant that removing the guard would allow it.

Evidence required: name of the new describe block in `gating.mutation.test.ts`.

**B3 — TypeScript types are coherent**

```bash
npx tsc --noEmit --project app/tsconfig.json
```

Evidence required: zero type errors.

**B4 — Telemetry instrumentation is correct**

If you added a new stage to `invokeContract` or changed the transaction flow, update `app/src/lib/telemetry.ts` accordingly and verify that:
- The new stage emits using `emit(ctx, "<stage>")` or `emit(ctx, "<stage>", category)`.
- No address, hash, XDR, ScVal, or user-entered value is passed to `emit`.
- The telemetry tests still pass: `node --require ts-node/register --test app/src/lib/telemetry.test.ts`

Evidence required: stage name(s) added and test output, or confirmation that the transaction flow was not changed.

#### Failure path gates

**B5 — Error paths return the correct user-facing message**

For every new error condition, confirm that `formatContractError` (in `stellar.ts`) returns a human-readable string — not a raw RPC or Freighter error. Add a test in `telemetry.test.ts` or a dedicated error formatting test if the mapping is new.

Evidence required: test name covering the new error path.

**B6 — Stale snapshot gate is preserved**

Any change that adds a new action to `computeActionEligibility` must check `isSnapshotFresh` first, before any other guard. Verify the ordering invariant test in `gating.mutation.test.ts` covers the new action.

Evidence required: confirmation that stale_snapshot is the first gate for the new action.

---

### Scope C — Indexer change (schema, events, API, migrations)

Applies to modifications of anything under `indexer/src/`.

For column units, nullability, uniqueness rules, source events, and API field names see the [Data Dictionary](./docs/DATA_DICTIONARY.md). If your change removes or renames a response field, follow the [Deprecation Policy](./docs/DEPRECATION_POLICY.md).

#### Success path gates

**C1 — All indexer tests pass**

```bash
npm test --workspace=indexer
```

Evidence required: test output showing 0 failures. Integration tests that require Postgres may be skipped in CI if `DATABASE_URL` is absent — note this explicitly if it applies.

**C2 — Incident reproduction tests pass (offline)**

```bash
npm run test:incidents --workspace=indexer
```

Evidence required: test output. These tests must pass in any environment, including offline CI runners.

**C3 — Schema health is clean after migrations**

```bash
npm run migrate --workspace=indexer
npm run migrate:check --workspace=indexer
```

Evidence required: `migrate:check` output shows `Health state: clean`.

**C4 — New migration file follows naming convention**

Migration files must be named `NNN_short_description.sql` where NNN is a zero-padded three-digit sequence number (e.g. `003_add_reputation_events.sql`). The file must be idempotent on repeated application (use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.).

Evidence required: migration filename listed in the PR.

**C5 — API shape changes are reflected in app types**

Any change to a response field name, type, or added/removed field in `api.ts` must be reflected in the corresponding TypeScript interfaces in `app/src/app/circles/[address]/CircleDetailClient.tsx` or `app/src/app/reputation/[member]/ReputationClient.tsx`.

Evidence required: list of app interface files updated, or confirmation that the API shape is unchanged.

#### Failure path gates

**C6 — Drift scenario is tested**

If you add a new migration file, add or update the `SchemaDrift` fixture in `indexer/src/fixtures/incident-fixtures.ts` to reflect the new filename so the drift reproduction test remains accurate.

Evidence required: updated fixture constant name, or confirmation that the existing fixture is still accurate.

**C7 — Rollback procedure documented**

For destructive migrations (DROP TABLE, DROP COLUMN, data backfills), document the rollback SQL in the PR description and note whether a full re-index is required. See [Re-indexing from a Given Ledger](./docs/RUNBOOK.md#re-indexing-from-a-given-ledger) in the runbook.

Evidence required: rollback SQL snippet in the PR description, or confirmation that the migration is additive-only (no rollback needed).

---

### Scope D — App or UI change (pages, components, wallet flow)

Applies to modifications of anything under `app/src/app/` or `app/src/components/`.

#### Success path gates

**D1 — TypeScript build passes**

```bash
npx tsc --noEmit --project app/tsconfig.json
npm run lint --workspace=app
```

Evidence required: zero errors and zero new lint warnings.

**D2 — "use client" boundaries are correct**

Pages and components that use React hooks, browser APIs, or Freighter must have `"use client"` at the top. Data fetching must remain in Server Components unless interaction is required.

Evidence required: list any new `"use client"` directives added and the reason, or confirmation that no new client components were added.

**D3 — Gating logic lives in `gating.ts`, not in ad-hoc UI conditions**

Any eligibility check that affects whether a wallet action is available must go through `computeActionEligibility`. It must not be implemented as an inline `if` in a component.

Evidence required: confirmation that no new eligibility logic was added to components directly, or a description of how the new condition was added to `gating.ts`.

**D4 — New routes have metadata**

Every new `page.tsx` must export a `generateMetadata` function with a descriptive `title` and `description`.

Evidence required: metadata export shown in the PR diff, or confirmation that no new routes were added.

#### Failure path gates

**D5 — UI failure states are handled**

For any new wallet-triggered action:
- The loading state must be visible while the transaction is in flight.
- The error state must display a human-readable message from `invokeContract`.
- The success state must clear loading and show confirmation.

Verify that each state is reachable by reading through the component logic. A manual smoke test on testnet is recommended.

Evidence required: description of how each state (loading / error / success) is handled in the component.

**D6 — Freighter not-installed case is handled**

Any new button that triggers `invokeContract` must check `isFreighterInstalled()` before calling it and show the appropriate install prompt if Freighter is absent. See the `WalletRejection.notInstalled` fixture and [Freighter not detected](./docs/RUNBOOK.md#freighter-not-detected) in the runbook.

Evidence required: confirmation that the not-installed path is guarded.

---

### Scope E — Identity or reputation change

Applies to modifications of `contracts/reputation/src/lib.rs`, reputation-related indexer handlers, or any app page under `app/src/app/reputation/`.

#### Success path gates

**E1 — Reputation authorization invariants hold**

The five invariants documented at the top of `contracts/reputation/src/lib.rs` must all have passing tests:
- Admin-only management (add/remove authorized callers)
- Uniqueness (idempotent add)
- Permanent revocation
- Revocation outranks allowlist
- Monotonic scores

```bash
cd contracts && cargo test -p reputation
```

Evidence required: test output, or confirmation that the invariants are unchanged.

**E2 — Revocation permanence is tested**

Any change that touches `remove_authorized_caller` or the revocation check in `increment` must include or update the `guard_reputation_revocation_is_permanent` test in `contracts/circle/src/mutation_guards.rs`.

Evidence required: test name and output.

**E3 — Reputation score is non-decreasing**

`increment` must only ever increase the score. If you are adding a new code path that modifies the score, verify that the monotonicity invariant (`prop_tests.rs` invariant 7) still passes.

Evidence required: prop_tests output, or confirmation that score modification logic is unchanged.

#### Failure path gates

**E4 — Unauthorized increment is blocked**

The `guard_reputation_unauthorized_caller_blocked` test must pass unchanged. If you added a new caller type, add a corresponding test that verifies the new caller is correctly gated.

Evidence required: test name.

---

### Scope F — Security or authorization change

Applies to any change that modifies authentication, authorization, access control, or known-sensitive data handling in any layer.

#### Success path gates

**F1 — Threat model is documented**

Describe in the PR description: what the change protects, who the adversary is, and what they could do without this protection.

Evidence required: threat model paragraph in the PR description.

**F2 — Both the allow and deny paths are tested**

For any new authorization check, there must be:
- A test that verifies a legitimate caller succeeds.
- A test that verifies an unauthorized caller is rejected with the expected error.

Evidence required: both test names.

**F3 — Telemetry does not leak sensitive data**

If your change touches `invokeContract`, `stellar.ts`, or any place where wallet addresses, transaction hashes, or user-entered values are available, verify that:
- None of those values are passed to `emit()` or any telemetry function.
- `scrubPayload` would catch them if they were accidentally included.

Run the privacy tests:

```bash
node --require ts-node/register --test app/src/lib/telemetry.test.ts 2>&1 | grep -E "pass|fail"
```

Evidence required: all privacy tests pass; list of any new sensitive fields added to event payloads (there should be none).

**F4 — No secrets in fixtures or tests**

Verify that any new test fixtures, snapshots, or sample data follow the synthetic-data rules in `indexer/src/fixtures/incident-fixtures.ts`:
- All addresses are synthetic strkeys (all-zero byte pattern).
- All transaction hashes start with `0` or `f` (synthetic pattern).
- No real private keys (`S`-addresses), mnemonics, or production contract IDs appear.

Run the cross-fixture invariant test:

```bash
npm run test:incidents --workspace=indexer 2>&1 | grep "no fixture"
```

Evidence required: cross-fixture invariant tests pass.

#### Failure path gates

**F5 — Rollback does not reintroduce a vulnerability**

If your PR fixes a security issue, describe in the PR description what the state of the system is if this commit is reverted (e.g. via a hotfix revert). If reversion would reintroduce the vulnerability, note this explicitly and propose a safe revert strategy.

Evidence required: revert-safety note in the PR description.

---

### Scope G — Deployment or infrastructure change

Applies to modifications of `docker-compose.yml`, `Dockerfile` (if added), CI workflow files under `.github/`, environment variable schemas (`app/.env.example`, `indexer/.env.example`), or the runbook (`docs/RUNBOOK.md`).

If your change involves redeploying contracts to any network, follow the [Deployment Lifecycle](./docs/DEPLOYMENT_LIFECYCLE.md) to archive the superseded manifest and update profiles before the new addresses go live.

#### Success path gates

**G1 — Environment variable changes are documented**

Any new or renamed env var must appear in both the `.env.example` file for the affected package and the [Environment Variables Reference](./docs/RUNBOOK.md#environment-variables-reference) table in the runbook.

Evidence required: `.env.example` diff and runbook section updated.

**G2 — Migration health check passes after deployment**

For any change to the database or indexer container:

```bash
npm run migrate:check --workspace=indexer
```

Evidence required: `Health state: clean` output.

**G3 — Runbook deployment steps are accurate**

If deployment order, post-deployment configuration steps, or rollback procedures change, update [Deployment](./docs/RUNBOOK.md#deployment) and [Contract Deployment Order](./docs/RUNBOOK.md#contract-deployment-order) in the runbook.

Evidence required: runbook sections updated, or confirmation that deployment steps are unchanged.

#### Failure path gates

**G4 — Rollback procedure is documented**

For any infrastructure change that is not trivially reversible (container image upgrade, database volume change, contract re-deploy), document:
- How to roll back to the previous state.
- Whether any data migration or replay is required during rollback.
- The maximum acceptable downtime.

Evidence required: rollback procedure in the PR description.

**G5 — Schema drift scenario is accounted for**

If deployment involves applying a migration, verify the `SchemaDrift` incident fixture and test remain accurate. If the new migration is the latest in sequence, update `SchemaDrift.seedFilesOnDisk()` in `indexer/src/fixtures/incident-fixtures.ts`.

Evidence required: fixture updated or confirmed accurate.

---

### Evidence quick-reference

This table maps each command to the gates it satisfies. Run the commands locally before opening a PR.

| Command | Gates satisfied |
|---|---|
| `cd contracts && cargo test` | A1, A3, A8, E1, E2, E3 |
| `cd contracts && cargo test -p circle mutation_guard` | A2, A8, E2, E4 |
| `cd contracts && cargo build --target wasm32-unknown-unknown --release` | A4 |
| `npx tsc --noEmit --project app/tsconfig.json` | B3, D1 |
| `npm run lint --workspace=app` | D1 |
| `node --require ts-node/register --test app/src/lib/gating.mutation.test.ts` | B1, B2, B6 |
| `node --require ts-node/register --test app/src/lib/telemetry.test.ts` | B4, F3 |
| `npm test --workspace=indexer` | C1, C2 |
| `npm run test:incidents --workspace=indexer` | C2, F4 |
| `npm run migrate --workspace=indexer` | C3 |
| `npm run migrate:check --workspace=indexer` | C3, G2, G5 |

---

## Reporting Bugs

Use the [Bug Report issue template](.github/ISSUE_TEMPLATE/bug_report.md). For security vulnerabilities, see [SECURITY.md](./SECURITY.md) — do not open a public issue.
