# Changelog

All notable changes to CircleUp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Changed (SDK)
- **Strict RPC decoding** (`sdk/src/types.ts`): reads now fail at the
  decoding boundary, with the method or field named, on wrong variants, absent
  fields, and out-of-range values. New narrow decoders: `decodeI128`,
  `decodeU64`, `decodeU32InRange`, `decodeRecord`. `mapRawConfig` enforces
  distinct members (≤ 256), `round_amount ≥ 1`, and the contract's deadline
  bounds. `getCollateral` rejects negative values. `assertValidCircleStatus`
  now accepts the `#[contracttype]` enum wire form (`["Active"]`) that
  `get_status` actually returns, as well as a bare symbol. `createCircle`
  only reports a contract address as `circleAddress`.
- **Write retry safety** (`sdk/src/client.ts`): a write is never rebuilt
  inside the SDK. `sendTransaction` resends only the identical signed
  envelope. When a send may have reached the RPC without a reply, the SDK looks
  the locally computed hash up instead of reporting a retryable error.
  New `TxErrorCode`s: `outcome_unknown` (not retryable, carries
  `diagnostics: SubmissionDiagnostics`) and `tx_expired` (retryable — the
  envelope passed its time bound unincluded). **Behaviour change:** losing
  connectivity while polling an accepted transaction now returns
  `outcome_unknown` instead of `network_error`. `network_error` now always
  means the request never reached the RPC. Added
  `CircleUpClient.lookupTransaction(hash)`.
- **Indexer paging** (`IndexerClient`): query options are validated locally
  (`RangeError`, before any request), unknown keys are rejected instead of
  dropped, and responses must carry a pagination envelope matching the request.
  Added the bounded iterators `iterateCircles` / `iterateMemberContributions`
  (default 10 pages), `GetMemberContributionsParams`, `IndexerPagination`
  (incl. `hasMore`), `totalAmount` on contributions, and
  `INDEXER_DEFAULT_PAGE_SIZE` / `INDEXER_MAX_PAGE_SIZE`.
- **Public API boundary**: `package.json` now declares `exports` (root only) and
  `files`. Co-located `src/*.test.ts` files are no longer emitted to `dist/`.
  The test-only helpers `isTransientRpcError` and `withRpcRetry` are no longer
  exported from the package root. New release check `npm run check:api` (clean
  build, compile `examples/` against `dist/`, verify documented imports, and
  block deep imports) runs in CI.

### Fixed (SDK)
- Restored `formatMismatchMessage`, which `CircleClient.preflight` calls but a
  merge had removed, leaving `sdk/src/client.ts` unable to compile.

### Added
- **Issue 32**: Bounded timeouts and categorised failures for SDK indexer
  requests (`sdk/src/client.ts`) — every `IndexerClient` request (connect,
  headers and body) is bounded by `DEFAULT_INDEXER_TIMEOUT_MS` (10 s,
  configurable per client and per call) and honours a caller `AbortSignal`.
  `IndexerError` gains `kind` (`network` | `timeout` | `aborted` | `http` |
  `json` | `schema`) and `retryable`; error messages never include full
  response bodies. Covered by `sdk/src/__tests__/indexerClient.test.ts`
- **Issue 34**: Indexer response compatibility checks
  (`sdk/src/indexerSchema.ts`, `docs/INDEXER_API_COMPATIBILITY.md`) — runtime
  wire schemas for list, detail, members, rounds, history, reputation, audit,
  health and state responses, with representative fixtures validated in
  `sdk/src/__tests__/indexerContract.test.ts`. Documents which response changes
  are additive and which need a coordinated release
- **Issue 35**: Opt-in `CircleUpClient.verifyDeployment()` (`sdk/src/client.ts`)
  — read-only, time-bounded check of the RPC network passphrase and the
  factory / reputation / USDC contract identities against the config, with a
  typed per-check result (`ok` | `mismatch` | `missing` | `incompatible` |
  `unreachable` | `skipped`). Construction stays offline. Covered by
  `sdk/src/__tests__/verifyDeployment.test.ts`
- **Issue 41**: Query-plan review for indexer indexes (`indexer/src/db/explain.ts`,
  `docs/QUERY_PLANS.md`, `indexer/src/db/migrations/006_status_and_history_composite_indexes.sql`)
  — `npm run explain` now reports cardinalities, per-query cost / time / scan
  nodes, and queries that miss their expected index. Adds composite indexes
  for `GET /circles?status=` and `GET /members/:member/contributions?circle=`,
  whose filter-only indexes forced a full Sort before LIMIT
- **Issue 477**: Address validation for every member entry on the create flow
  (`app/src/lib/address.ts`, `app/src/app/create/CreateClient.tsx`)
  — Added dependency-free strkey checksum verification (base32 decode +
  CRC16/XMODEM) as `hasValidStrKeyChecksum` / `isValidStellarAccount`, plus a
  per-row `validateMemberEntry` that `validateCreateForm` now applies to every
  filled member row. A string that is 56 base32 characters but fails its
  checksum — a single mistyped character or a truncated copy-paste — was
  accepted by the form and only failed later inside transaction construction,
  after the wallet prompt had already appeared. Each failure mode (lowercase,
  contract `C…`, muxed `M…`, bad shape, bad checksum) now reports its own
  `Member N:` message under the offending row. Covered by
  `app/src/__tests__/member-address-validation.test.ts` and the updated
  create-form, submission-guard, and member-list suites
- **Issue 30**: Contract argument compatibility fixtures (`sdk/src/__tests__/contractFixtures.test.ts`)
  — Base64-encoded XDR fixtures for every public contract method (factory, circle,
  reputation) that verify SDK argument encoding remains compatible with contract
  signatures across releases. Covers valid arguments and boundary cases for all
  22 contract methods. See `sdk/CONTRACT_FIXTURES.md` for maintenance guide
- **Issue 28**: Canonical event identity constraints (`indexer/src/db/migrations/003_event_dedup_constraints.sql`)
  — Added `event_index` column and unique index on `(ledger, tx_hash, event_index)`
  to enforce idempotency at the database layer rather than relying on application
  memory. Makes duplicate event delivery (from at-least-once polling) a silent
  no-op via `ON CONFLICT DO NOTHING`
- **Issue 29**: Exponential backoff for RPC polling (`indexer/src/indexer.ts`)
  — Temporary RPC failures (connection refused, timeout, rate limit) now trigger
  capped exponential backoff (1s → 2s → 4s → ... → 60s) with full jitter instead
  of hot-looping or immediate exit. Backoff resets after successful poll. Structured
  warnings at exponentially-spaced thresholds (3, 4, 8, 16, 32 failures) prevent
  log spam
- `docs/INDEXER_RELIABILITY.md` — Comprehensive design document covering atomic
  ledger checkpointing, event idempotency model, backoff policy, graceful shutdown,
  and monitoring recommendations
- `sdk/CONTRACT_FIXTURES.md` — Documentation for maintaining contract fixtures,
  debugging failed tests, and integrating with CI
- `indexer/src/backoff.test.ts` — 12 unit tests verifying backoff progression,
  jitter bounds, reset-after-success, warning thresholds, and cap enforcement
- `indexer/src/eventIdentity.test.ts` — 13 unit tests verifying `parseEventIndex`
  extraction, `createEventKey` stability, canonical identity properties, and
  duplicate detection across ledgers and transactions
- `indexer/src/indexer.ts` — `parseEventIndex()` function extracts event index
  from Soroban RPC event.id format (`ledger-txIndex-eventIndex`)
- `sdk/src/index.ts` — documented the public API surface at the package entry
  point: a grouped map (clients, errors, config & types, gating, utilities,
  constants, low-level encoders) states that the package root is the only
  supported import path and that deep paths / test modules carry no stability
  guarantee. Re-export order is annotated so each symbol has one canonical source
- `sdk/examples/public-api.ts` — side-effect-free fixture that imports every
  documented symbol from the package root (no deep or `../src` paths) and is
  type-checked by `sdk/examples/tsconfig.json`, so the public contract stays
  reachable-from-root and cannot silently regress
- `indexer/src/db/migrate.ts` — `checkMigrationHealth()` function that classifies
  the database schema state as one of five well-defined states: `clean`, `pending`,
  `drifted`, `partial`, or `uninitialized`; exported `SchemaHealthState` type and
  `MigrationHealth` interface for structured decisions at call sites
- `indexer/src/db/migrate.ts` — `--check` CLI flag: exits non-zero when schema is
  not clean so CI pipelines can gate deploys on schema health
- `indexer/src/db/replay.ts` — `prepareReplay()`: transactional re-index from a
  given ledger N; wipes derived tables, clears ingested-events dedup keys for the
  replay range, and resets the indexer cursor — all in one atomic transaction
- `indexer/src/db/replay.ts` — `replayPreflight()`: non-destructive pre-check
  that reports estimated event count, current cursor, and warnings without touching
  the database
- `indexer/src/db/replay.ts` — CLI entry point (`npm run replay -- --from=<N>`)
  with `--partial` (keep rows from earlier ledgers) and `--dry-run` flags
- `indexer/src/db/migrate.test.ts` — deterministic unit tests for all five
  `SchemaHealthState` transitions, the decision matrix, summary string content,
  `currentVersion` derivation, idempotence guard, transaction rollback safety,
  and `42P01` handling; integration tests (gated on `DATABASE_URL`) for live
  idempotence, drifted-state detection, and ghost-entry flagging
- `indexer/src/db/replay.test.ts` — unit tests for input validation, cursor math,
  `fullWipe` forcing, SQL range selection, table wipe strategies, transaction
  commit/rollback paths, and preflight warnings; integration tests for full and
  partial replay semantics and preflight non-mutation guarantee
- `indexer` boot sequence now logs a prominent `SCHEMA WARNING` for `drifted` or
  `partial` states after migrations run, surfacing drift before the poller starts
- SDK: caller correlation metadata on every write. Mutation methods (`join`,
  `contribute`, `payout`, `markDefault`, `close`, `createCircle`) accept an
  optional `{ metadata }` (a flat bag of scalar identifiers, e.g.
  `{ operation: "join-circle", uiRequestId: "req_8a1f" }`) that is echoed back on
  the resulting `TxResult` — present on failures too, so a UI action ties to a tx
  hash whether it confirmed or failed
- SDK: `sanitizeTxMetadata` security boundary strips secrets before metadata is
  ever echoed or logged — drops keys named like secrets (`secret`, `seed`,
  `signed`, `xdr`, `apiKey`, …), Stellar secret-seed values under any key,
  over-long strings (signed XDR), and all non-scalars; caps at 32 keys
- SDK: opt-in structured tx logging via `CircleUpClient.setTxLogger`. A registered
  `TxLogger` receives log-safe `TxLogEvent`s across the write lifecycle
  (`simulated` → `submitted` → `confirmed` | `failed`) carrying the contract,
  method, tx hash, ledger/error code, and sanitised correlation metadata — never
  the signing key, its secret, the signed XDR, or the raw arguments. A throwing
  logger can never change a transaction's outcome
- `sdk/src/__tests__/txMetadata.test.ts` — unit tests for `sanitizeTxMetadata`
  (secret/payload/non-scalar stripping, key cap, no-mutation/frozen output) and
  the write path (metadata echoed on success and failure results, log lifecycle
  ordering and log-safe fields, correlation preserved across retried attempts,
  end-to-end threading through `CircleClient.join`)

### Changed
- **Issue 31**: Event ingestion is now fully restart-safe — the indexer cursor and
  all event projections (circles, contributions, payouts, etc.) are written in a
  single database transaction per ledger. On crash before commit, the transaction
  rolls back and restart processes the same ledger again (idempotent via dedup
  constraints). On crash after commit, restart resumes from the next ledger. The
  cursor is always read from the database (never from memory) on startup
- **Issue 29**: Poll error handling now applies jittered backoff wait inside the
  error catch block before allowing the next tick, preventing hot loops during
  sustained RPC outages
- `indexer/src/indexer.ts` — `ingestEventInTx()` now inserts `event_index` column
  for canonical identity-based deduplication alongside the legacy `event_key` column
- `indexer/src/db/schema.sql` — `ingested_events` table now includes `event_index`
  column and unique index on `(ledger, tx_hash, event_index)` for database-enforced
  idempotency
- `indexer/src/index.ts` — imports `checkMigrationHealth` and runs a post-migration
  health check on every boot; non-clean states emit a `SCHEMA WARNING` log line
  rather than aborting so the indexer keeps serving data in ambiguous situations
- `indexer/package.json` — added `migrate:check`, `replay`, and `replay:dry-run`
  scripts; added `src/db/replay.test.ts` to the `test` script
- Homepage hero copy rewritten around what the visitor does and gets
- Homepage circles fetch is memoized per render, so the hero count, the heading
  count and the list can no longer disagree
- `sdk/src/utils.ts` — `usdcToStroops` now routes both `string` and `number`
  input through one exact string-parsing path that expands JavaScript exponent
  notation (`1e-7`, `1e+21`) losslessly and counts only *significant* decimals.
  Valid small/large numeric amounts such as `0.0000001` now convert exactly
  instead of throwing, while `> 7`-decimal precision, negatives, non-finite
  numbers, and malformed exponents are rejected with specific messages. Also
  documented USDC units/precision and that `formatUsdc` truncates (never rounds
  up) so a displayed amount can never overstate the true balance

### Fixed
- `app/src/lib/config.ts` — `usdcToStroops` silently discarded any digits beyond
  7 decimal places (`frac.padEnd(7, "0").slice(0, 7)`), so an over-precise amount
  was signed for a *different* value than the user entered. It now rejects excess
  precision (and handles exponent notation) identically to the SDK. Realigned the
  other money helpers with `sdk/src/utils.ts` too: added the missing negative /
  `NaN` guards to `stroopsToUsdc` and `formatUsdc`, and the non-integer / negative
  member-count guard to `formatPot` (a fractional count previously made
  `BigInt(memberCount)` throw)
- SDK: every read (`getConfig`, `getStatus`, `getCircles` and the rest) failed with
  `this.source.sequenceNumber is not a function`. The read path built its
  transaction from an account stub that was missing that method, and it always
  reached that stub because it looked up a throwaway account that never exists on
  chain. Reads now use a fixed placeholder source and make no account lookup at all
- SDK: a transaction the RPC declined to queue (`TRY_AGAIN_LATER`) was polled for
  the full confirmation budget and then reported as a timeout, hiding the fact that
  it simply needed resubmitting
- SDK: an RPC that stops advancing its ledger answers `NOT_FOUND` forever, which was
  indistinguishable from a slow ledger and consumed the whole timeout budget
- SDK: `scI128` accepted numbers above `Number.MAX_SAFE_INTEGER`, which round
  silently on conversion to `bigint` and would have signed a payment for the wrong
  amount
- SDK: the test suite could not run. Every fixture used placeholder addresses that
  the config validator and the address encoder both reject, and several files mocked
  the read helper with a raw value rather than its result type
- Homepage returned a 500 after a 60-second hang when the indexer refused the
  connection, so the "indexer is unreachable" banner never reached the user
- `app/src/app/create/page.tsx` — restored to a thin server-component wrapper
  delegating to `CreateClient`; a bad merge had replaced it with all the
  client-side hook logic, causing 55 TypeScript errors at build time
- `app/src/components/WalletButton.tsx` — removed dead code block referencing
  `result`, `setConnectState`, and `setErrorMsg` left behind after a state-machine
  refactor; tightened `(err as any)` cast to `(err as Error)`
- `indexer/src/db/migrate.ts` — partial-state summary now lists both the pending
  file names and the missing-on-disk file names; previously only the missing names
  were shown, leaving operators without enough information to act

---

## [0.1.0] — 2026-07-07

### Added
- `contracts/reputation` — on-chain completed-rounds score per wallet (Soroban)
- `contracts/circle` — full ROSCA lifecycle: `join`, `contribute`, `payout`, `mark_default`, `close`
- `contracts/circle_factory` — deploys and registers circle contract instances
- 15 Rust unit tests covering contribution accounting, rotation order, default penalties, reputation updates
- `sdk` — TypeScript client SDK wrapping every contract call (`FactoryClient`, `CircleClient`, `ReputationClient`)
- `sdk/src/constants.ts` — shared network passphrases, RPC URLs, USDC decimals, ledger-per-day constants
- `indexer` — Node.js event indexer polling Soroban events into Postgres
- `indexer/src/api.ts` — Express REST API (`/circles`, `/circles/:address`, `/reputation/:member`)
- `indexer/src/db/schema.sql` — full Postgres schema
- `app` — Next.js 14 frontend with Tailwind CSS and Freighter wallet integration
- 5 app routes: `/`, `/create`, `/circles/[address]`, `/reputation/[member]`, `/_not-found`
- `scripts/deploy.ts` — automated testnet deployment via stellar-cli
- `scripts/seed-demo.ts` — 4-member $100/round demo circle seed script
- Docker Compose for local Postgres
- GitHub Actions CI (TypeScript build, Rust WASM compile, ESLint)
- MIT License, Apache 2.0 License
- Code of Conduct (Contributor Covenant)
- Security policy with coordinated disclosure process
- Issue templates (bug report, feature request)
- Pull request template
- 5 README badges (CI, MIT, Stellar, Next.js, Rust)

### Fixed
- `circle/Cargo.toml` — moved `reputation` testutils to `[dev-dependencies]` only
- `indexer/package.json` — corrected `start` script to point to compiled `.js`
- `scripts/seed-demo.ts` — removed duplicate `path` import and wrong `.env` path coupling
- `sdk/src/client.ts` — removed 6 unused imports
- `soroban-sdk` pinned to `21.7.7` across all contracts to fix `ed25519-dalek v3` / `ChaCha20Rng` conflict
- `circle_factory` — `sha256()` returns `Hash<32>` in SDK 21.7.7; added `.into()` for `BytesN<32>` conversion
