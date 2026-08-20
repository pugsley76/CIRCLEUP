# Changelog

All notable changes to CircleUp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
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

### Changed
- `indexer/src/index.ts` — imports `checkMigrationHealth` and runs a post-migration
  health check on every boot; non-clean states emit a `SCHEMA WARNING` log line
  rather than aborting so the indexer keeps serving data in ambiguous situations
- `indexer/package.json` — added `migrate:check`, `replay`, and `replay:dry-run`
  scripts; added `src/db/replay.test.ts` to the `test` script
- Homepage hero copy rewritten around what the visitor does and gets
- Homepage circles fetch is memoized per render, so the hero count, the heading
  count and the list can no longer disagree

### Fixed
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
