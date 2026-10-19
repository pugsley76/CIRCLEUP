# CircleUp Operational Runbook

This document is the primary operational and contributor reference for the full CircleUp stack. It covers architecture, local development, deployment, environment configuration, data flow, troubleshooting, and common failure recovery procedures.

For the SDK API reference and contract invariants see [README.md](../README.md).

---

## Table of Contents

- [System Overview](#system-overview)
- [Architecture Diagram](#architecture-diagram)
- [Component Responsibilities](#component-responsibilities)
  - [Soroban Contracts](#soroban-contracts)
  - [TypeScript SDK](#typescript-sdk)
  - [Indexer](#indexer)
  - [Frontend App](#frontend-app)
- [How the Components Connect](#how-the-components-connect)
- [Local Development Setup](#local-development-setup)
  - [Prerequisites](#prerequisites)
  - [Step-by-Step](#step-by-step)
- [Environment Variables Reference](#environment-variables-reference)
  - [Indexer (`indexer/.env`)](#indexer-indexerenv)
  - [App (`app/.env.local`)](#app-appenvlocal)
- [Deployment](#deployment)
  - [Contract Deployment Order](#contract-deployment-order)
  - [Post-Deployment Configuration](#post-deployment-configuration)
  - [Updating the App and Indexer](#updating-the-app-and-indexer)
- [Database Operations](#database-operations)
  - [Running Migrations](#running-migrations)
  - [Checking Schema Health](#checking-schema-health)
  - [Re-indexing from a Given Ledger](#re-indexing-from-a-given-ledger)
- [Database Backup and Restore](#database-backup-and-restore)
  - [Backup](#backup)
  - [Restore drill — isolated target](#restore-drill--isolated-target)
  - [Post-restore verification](#post-restore-verification)
  - [Applying migrations after restore](#applying-migrations-after-restore)
  - [Restore vs. chain replay — decision criteria](#restore-vs-chain-replay--decision-criteria)
  - [Promoting the restore target to production](#promoting-the-restore-target-to-production)
  - [Rollback guidance](#rollback-guidance)
- [Health Checks and Monitoring](#health-checks-and-monitoring)
  - [Indexer Health Endpoint](#indexer-health-endpoint)
  - [Indexer Audit Endpoint](#indexer-audit-endpoint)
  - [Useful Monitoring Queries](#useful-monitoring-queries)
- [Troubleshooting](#troubleshooting)
  - [App shows "indexer unreachable" banner](#app-shows-indexer-unreachable-banner)
  - [Circle list is empty but circles exist on-chain](#circle-list-is-empty-but-circles-exist-on-chain)
  - [Circle detail page shows 404](#circle-detail-page-shows-404)
  - [Reputation page shows no data](#reputation-page-shows-no-data)
  - [My Reputation link in the nav is greyed out](#my-reputation-link-in-the-nav-is-greyed-out)
  - [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed)
  - [Indexer keeps restarting with missing env vars](#indexer-keeps-restarting-with-missing-env-vars)
  - [Indexer boot: "SCHEMA WARNING"](#indexer-boot-schema-warning)
  - [Payout fails with "reputation increment failed"](#payout-fails-with-reputation-increment-failed)
  - [mark_default fails with "round deadline not yet passed"](#mark_default-fails-with-round-deadline-not-yet-passed)
  - [App build fails with TypeScript errors](#app-build-fails-with-typescript-errors)
  - [Freighter not detected](#freighter-not-detected)
- [Contract Lifecycle Reference](#contract-lifecycle-reference)
  - [Circle Status Machine](#circle-status-machine)
  - [Round Lifecycle](#round-lifecycle)
  - [Reputation Authorization Flow](#reputation-authorization-flow)
- [Security Notes](#security-notes)
- [Incident Fixtures and Offline Reproduction](#incident-fixtures-and-offline-reproduction)
  - [Fixture Overview](#fixture-overview)
  - [Running the Incident Tests](#running-the-incident-tests)
  - [StaleIndexerData fixture](#staleindexerdata-fixture)
  - [DuplicateEvents fixture](#duplicateevents-fixture)
  - [WalletRejection fixture](#walletrejection-fixture)
  - [RpcTimeout fixture](#rpctimeout-fixture)
  - [SchemaDrift fixture](#schemadrift-fixture)
- [Mutation Testing and Guard Verification](#mutation-testing-and-guard-verification)
  - [Why Mutation Testing](#why-mutation-testing)
  - [Contract Mutation Guards (Rust)](#contract-mutation-guards-rust)
  - [App Gating Mutation Tests (TypeScript)](#app-gating-mutation-tests-typescript)
  - [CI Budget and Excluded Mutations](#ci-budget-and-excluded-mutations)
- [Development Best Practices](#development-best-practices)

---

## System Overview

CircleUp is a trustless Rotating Savings and Credit Association (ROSCA) platform built on Stellar Soroban. It consists of four distinct layers:

| Layer | Package | Language | Role |
|---|---|---|---|
| Smart contracts | `contracts/` | Rust / Soroban SDK 21 | On-chain ROSCA logic, reputation scoring |
| TypeScript SDK | `sdk/` | TypeScript | Typed wrapper around RPC and indexer calls |
| Indexer | `indexer/` | Node.js / Express / Postgres | Polls Soroban events, stores derived state, exposes REST API |
| Frontend | `app/` | Next.js 14 / Tailwind CSS | User-facing interface; reads from indexer, writes via Freighter |

The contracts are the source of truth. The indexer is a derived read-model. The app is a thin presentation layer. The SDK is shared business logic that both the app and deployment scripts use.

---

## Architecture Diagram

```
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé                      Stellar Testnet                            Γöé
Γöé                                                                 Γöé
Γöé  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ  deploys  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ   Γöé
Γöé  Γöé  circle_factory  ΓöéΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╢Γöé  circle (per instance)  Γöé   Γöé
Γöé  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ           ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ   Γöé
Γöé           Γöé                               Γöé                     Γöé
Γöé     registers caller               calls increment              Γöé
Γöé           Γöé                               Γöé                     Γöé
Γöé           Γû╝                               Γû╝                     Γöé
Γöé  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ  Γöé
Γöé  Γöé                     reputation                            Γöé  Γöé
Γöé  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ  Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
           Γû▓ Soroban events                  Γû▓ RPC simulation calls
           Γöé                                 Γöé
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö┤ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ          ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö┤ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé      indexer        Γöé          Γöé         sdk           Γöé
Γöé  Node + Postgres    Γöé          Γöé  TypeScript client    Γöé
Γöé  REST API :3001     Γöé          ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ                    Γû▓
           Γöé HTTP JSON                     Γöé imported by
           Γû╝                               Γöé
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé                    app (Next.js 14)                            Γöé
Γöé  /                 ΓåÆ circle list (fetches from indexer)        Γöé
Γöé  /create           ΓåÆ deploy circle (Freighter + SDK)          Γöé
Γöé  /circles/[addr]   ΓåÆ detail + contribute/payout actions        Γöé
Γöé  /reputation/[m]   ΓåÆ on-chain score + participation history    Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
```

---

## Component Responsibilities

### Soroban Contracts

Located in `contracts/`. Three contracts, each with a single responsibility:

**`circle_factory`** (`contracts/circle_factory/src/lib.rs`)
- Stores the circle WASM hash, the reputation contract address, and the USDC token address.
- `create_circle` deploys a new circle contract, initializes it, registers it as an authorized reputation caller, and records its address ΓÇö all atomically in one transaction.
- Maintains `Circles: Vec<Address>` and `CircleCount: u32` which always satisfy `count == circles.len()`.

**`circle`** (`contracts/circle/src/lib.rs`)
- Core ROSCA logic: join, contribute, payout, mark_default, cancel, close.
- Status transitions: `Pending ΓåÆ Active ΓåÆ Completed` or `Pending ΓåÆ Cancelled`.
- Every member must lock `round_amount ├ù COLLATERAL_MULTIPLIER` USDC (currently 1├ù) to join.
- Round deadline is `round_deadline_ledgers` ledgers after the circle goes Active (last member joins).
- 20% collateral penalty (`PENALTY_BPS = 2000`, `BPS_DENOM = 10000`) for a missed round.
- Calls `reputation.increment(circle_address, member)` after each successful payout.

**`reputation`** (`contracts/reputation/src/lib.rs`)
- Stores per-wallet completed-rounds score as a persistent ledger entry.
- `increment` is gated by an allowlist of authorized callers (circle contracts). Only the factory admin can add or revoke callers.
- Revocation is permanent: a revoked circle can never call `increment` again, even if its address appears again in the allowlist.
- Scores are monotonically increasing; there is no decrement or reset.

### TypeScript SDK

Located in `sdk/`. Published as `@circleup/sdk` within the npm workspace.

- `FactoryClient` ΓÇö wraps `create_circle` and `get_circles` factory calls.
- `CircleClient` ΓÇö wraps `join`, `contribute`, `payout`, `mark_default`, `cancel`, `close`, and all read views for a single circle.
- `ReputationClient` ΓÇö wraps `score` and other reputation views.
- `getNetworkConfig` / `isValidNetwork` ΓÇö typed network config with RPC URL and passphrase.
- Utility helpers: `usdcToStroops`, `stroopsToUsdc`, `formatUsdc`, `formatPot`, `daysToLedgers`, `shortAddress`.

The app package (`app/`) uses the SDK indirectly through `app/src/lib/stellar.ts` rather than importing `@circleup/sdk` directly. The `scripts/` package uses the SDK directly for deployment and seeding.

### Indexer

Located in `indexer/`. Runs as a long-lived Node.js process with two responsibilities:

1. **Event polling loop** (`indexer/src/indexer.ts`): polls `getEvents` from the Soroban RPC every `POLL_INTERVAL_MS` milliseconds (default 5 000ms), starting from `START_LEDGER`. Writes circle, member, contribution, payout, default, and reputation rows into Postgres. Uses an `ingested_events` dedup table keyed on `(tx_hash, event_index)` so replaying from the same ledger is idempotent.

2. **REST API** (`indexer/src/api.ts`): Express server on port `PORT` (default 3001). All endpoints are read-only queries against Postgres. The only stateful operations (migrations, replay) are run separately as CLI scripts, not through the API.

Database schema is in `indexer/src/db/schema.sql`. Migrations are versioned SQL files in `indexer/src/db/migrations/`.

### Frontend App

Located in `app/`. Next.js 14 App Router with Server Components for data fetching and Client Components for wallet interactions.

Key patterns:
- Server Components fetch from the indexer at render time with `cache: "no-store"`. The `cache()` wrapper in `app/src/app/page.tsx` collapses multiple calls within one render into a single request.
- All contract interactions go through `app/src/lib/stellar.ts` which wraps Freighter and the Soroban RPC.
- Wallet state is read on the client inside `useEffect` ΓÇö never on the server ΓÇö to avoid SSR/hydration mismatches.
- The `WalletRepLink` component in the nav reads the connected wallet address and links to `/reputation/[address]`.

---

## How the Components Connect

### Creating a circle (write path)

```
User fills /create form
  ΓåÆ CreateClient.tsx collects members, amount, deadline
  ΓåÆ invokeContract("create_circle", ...) in stellar.ts
  ΓåÆ Freighter signs the transaction
  ΓåÆ circle_factory.create_circle() on Soroban RPC:
      Γö£ΓöÇ deploys circle WASM at deterministic address
      Γö£ΓöÇ calls circle.initialize(...)
      ΓööΓöÇ calls reputation.add_authorized_caller(circle_address)
  ΓåÆ Soroban emits factory/circle_created event
  ΓåÆ indexer polls event ΓåÆ writes row to circles table
  ΓåÆ /circles page fetches from indexer REST API ΓåÆ renders CircleCard
```

### Contributing and triggering payout (write path)

```
Member clicks "Contribute Round N"
  ΓåÆ CircleDetailClient invokes circle.contribute(member) via Freighter
  ΓåÆ circle stores Contributed(member, round_index) in persistent storage
  ΓåÆ Soroban emits circle/contributed event
  ΓåÆ (once all members contributed) anyone clicks "Trigger Payout"
  ΓåÆ circle.payout() transfers pot to recipient, calls reputation.increment
  ΓåÆ Soroban emits circle/payout and reputation/score_updated events
  ΓåÆ indexer processes events ΓåÆ updates contributions, payouts, reputation tables
  ΓåÆ page refetches from indexer ΓåÆ UI reflects new state
```

### Reading circle state (read path)

```
Browser navigates to /circles/[address]
  ΓåÆ CircleDetailPage (Server Component) fetches:
      GET /circles/:address          ΓåÆ circle row + members + latest ledger
      GET /circles/:address/rounds   ΓåÆ payouts + contributions + pending defaults
  ΓåÆ If indexer returns 404 ΓåÆ Next.js notFound() ΓåÆ not-found.tsx rendered
  ΓåÆ If fetch succeeds ΓåÆ CircleDetailClient (Client Component) hydrated with data
  ΓåÆ Client-side effects read wallet address from Freighter for action gating
```

### Reputation lookup (read path)

```
User navigates to /reputation/[address]
  ΓåÆ ReputationPage (Server Component) passes address to ReputationClient
  ΓåÆ ReputationClient (Client Component) fetches:
      GET /reputation/:member ΓåÆ score + per-circle contributions + defaults
  ΓåÆ Renders score card, participation table, defaults table
```

---

## Local Development Setup

### Prerequisites

| Tool | Minimum version | Purpose |
|---|---|---|
| Node.js | 18 | Frontend, indexer, scripts |
| npm | 9 | Workspace management |
| Rust (stable toolchain) | 1.75 | Compile Soroban contracts |
| stellar-cli | latest | Deploy contracts to testnet |
| Docker | any | Postgres via docker compose |
| Freighter | browser extension | Wallet for the web UI |

Install stellar-cli:
```bash
cargo install --locked stellar-cli --features opt
```

### Step-by-Step

**1. Clone and install**

```bash
git clone https://github.com/CIRCLEUP-AJO/CIRCLEUP
cd CIRCLEUP
npm install
```

**2. Start Postgres**

```bash
docker compose up -d
# Wait for the healthcheck: docker compose ps should show "healthy"
```

**3. Configure the indexer**

```bash
cp indexer/.env.example indexer/.env
# Edit indexer/.env ΓÇö fill in CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS
# Leave DATABASE_URL as-is if you are using docker compose defaults
```

**4. Run database migrations**

```bash
npm run migrate
# Equivalent to: npm run migrate:dev --workspace=indexer
# Creates all tables defined in indexer/src/db/schema.sql
```

**5. Configure the app**

```bash
cp app/.env.example app/.env.local
# Edit app/.env.local ΓÇö paste the same contract addresses with NEXT_PUBLIC_ prefix
# NEXT_PUBLIC_INDEXER_URL defaults to http://localhost:3001 ΓÇö leave as-is for local dev
```

**6. Start the indexer**

```bash
npm run dev:indexer
# Output: "Indexer API listening on http://0.0.0.0:3001"
# The indexer will start polling from START_LEDGER (0 by default = genesis)
# On a fresh testnet deployment set START_LEDGER to your deployment ledger to skip history
```

**7. Start the frontend**

```bash
npm run dev:app
# Open http://localhost:3000
```

**8. (Optional) Seed the demo circle**

```bash
npm run seed:demo
# Creates a 4-member $100/round testnet circle
# Runs through Round 1 (all contribute ΓåÆ Alice receives $400)
# Simulates Round 2 default for Dave
```

**Running both simultaneously:**

```bash
npm run dev
# Starts indexer and app in parallel (indexer & app)
# On Windows use two separate terminals instead
```

---

## Environment Variables Reference

### Indexer (`indexer/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | ΓÇö | Postgres connection string, e.g. `postgresql://postgres:password@localhost:5432/circleup` |
| `STELLAR_RPC_URL` | Yes | ΓÇö | Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org` |
| `CIRCLE_FACTORY_ADDRESS` | Yes | ΓÇö | Deployed factory contract ID (`C...`) |
| `REPUTATION_ADDRESS` | Yes | ΓÇö | Deployed reputation contract ID (`C...`) |
| `USDC_ADDRESS` | Yes | ΓÇö | USDC token contract ID (`C...`) |
| `NETWORK_PASSPHRASE` | No | `Test SDF Network ; September 2015` | Stellar network passphrase |
| `PORT` | No | `3001` | API server port |
| `START_LEDGER` | No | `0` | Ledger to start indexing from. Set to your deployment ledger to skip testnet genesis |
| `POLL_INTERVAL_MS` | No | `5000` | How often to poll the RPC for new events (milliseconds) |
| `EVENTS_LIMIT` | No | `100` | Max events per `getEvents()` call. Soroban RPC caps at 10 000 |
| `ALLOWED_ORIGINS` | No | *(all origins)* | Comma-separated CORS allow-list, e.g. `https://app.circleup.xyz`. Leave blank for local dev. Required in production |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | No | `100` | Max requests per IP per window |

All required variables are validated at boot time. The indexer will exit with a clear error message listing every missing key if any are absent or blank.

### App (`app/.env.local`)

| Variable | Required in production | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Yes | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Yes | `Test SDF Network ; September 2015` | Network passphrase |
| `NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS` | Yes (prod) | *(empty)* | Factory contract ID |
| `NEXT_PUBLIC_REPUTATION_ADDRESS` | Yes (prod) | *(empty)* | Reputation contract ID |
| `NEXT_PUBLIC_USDC_ADDRESS` | Yes (prod) | *(empty)* | USDC token contract ID |
| `NEXT_PUBLIC_INDEXER_URL` | Yes | `http://localhost:3001` | Indexer base URL |

In development, the contract address variables may be left blank ΓÇö the app will start but contract interactions will fail gracefully. In production (`NODE_ENV=production`) they are required and the server will throw at boot time if they are missing.

---

## Deployment

### Contract Deployment Order

Contracts must be deployed in this exact order due to cross-contract dependencies:

```
1. reputation   ΓÇö no dependencies; stores admin address
2. circle_factory ΓÇö depends on reputation address and circle WASM hash
3. (circle instances are deployed by the factory; never manually)
```

Deploy using stellar-cli:

```bash
# Generate a testnet deployer identity (one-time)
stellar keys generate --global deployer --network testnet
stellar keys fund deployer --network testnet

# Deploy all three contracts in one script
npm run deploy:testnet
# Writes contract addresses to scripts/deployed.json
```

The deploy script (`scripts/src/deploy.ts`) handles:
1. Building and uploading the circle WASM to get its hash.
2. Deploying the reputation contract with the deployer as temporary admin.
3. Deploying the factory with the reputation address and circle WASM hash.
4. Transferring admin of the reputation contract to the factory address.

### Post-Deployment Configuration

After deployment, copy the addresses from `scripts/deployed.json` into both env files:

```bash
# scripts/deployed.json contains:
# { "factory": "C...", "reputation": "C...", "usdc": "C..." }

# Indexer
# Edit indexer/.env:
CIRCLE_FACTORY_ADDRESS=C...
REPUTATION_ADDRESS=C...
USDC_ADDRESS=C...

# App
# Edit app/.env.local:
NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS=C...
NEXT_PUBLIC_REPUTATION_ADDRESS=C...
NEXT_PUBLIC_USDC_ADDRESS=C...
```

Set `START_LEDGER` in `indexer/.env` to the ledger number at which the factory was deployed to avoid scanning testnet genesis (which can take hours):

```bash
START_LEDGER=12345678   # replace with the actual deployment ledger
```

### Updating the App and Indexer

The app and indexer are stateless services ΓÇö update them by restarting with the new code. No special migration is needed unless the indexer schema changed.

If the indexer schema changed (new migration file added):

```bash
npm run migrate          # applies pending migrations
npm run migrate:check    # verify schema is clean before restarting
```

---

## Database Operations

### Running Migrations

```bash
# Development (uses ts-node, does not require a build)
npm run migrate

# Production (requires a compiled build first)
npm run build --workspace=indexer
npm run migrate --workspace=indexer
```

Migrations are numbered SQL files in `indexer/src/db/migrations/`. The runner tracks which files have been applied in a `schema_migrations` table and skips already-applied ones.

### Checking Schema Health

```bash
npm run migrate:check --workspace=indexer
# Exits 0 when the schema is "clean" (all migrations applied, no drift)
# Exits non-zero for: pending, drifted, partial, or uninitialized states
```

Schema states:

| State | Meaning | Action |
|---|---|---|
| `clean` | All migrations applied, no drift | None needed |
| `pending` | New migration files not yet applied | Run `npm run migrate` |
| `drifted` | Applied migrations no longer match files on disk | Investigate ΓÇö do not re-run blindly |
| `partial` | Some migration files are missing from disk | Restore missing files before continuing |
| `uninitialized` | No `schema_migrations` table at all | Run `npm run migrate` from scratch |

The indexer logs a `SCHEMA WARNING` on boot for `drifted` or `partial` states. The service continues serving data but the warning should be investigated before the next deploy.

### Re-indexing from a Given Ledger

Use the replay CLI when you need to rebuild the indexer database from a specific ledger ΓÇö for example after a schema migration that adds new derived columns, or after discovering a bug in the event processing logic.

```bash
# Dry-run first to see what would happen
npm run replay:dry-run --workspace=indexer -- --from=12345678

# Full replay from ledger 12345678 (wipes rows from that ledger onward)
npm run replay --workspace=indexer -- --from=12345678

# Partial replay (keep rows from before the given ledger)
npm run replay --workspace=indexer -- --from=12345678 --partial
```

Replay is atomic: it wraps the wipe and cursor reset in a single transaction. If the process is interrupted, the database returns to its pre-replay state and the replay can be retried safely.

**Warning:** a full replay (without `--partial`) deletes all derived table rows from the given ledger onward and resets the indexer cursor. The indexer will then re-ingest all events from that point. During replay the API continues to serve the (now stale) data until the cursor catches up.

---

## Database Backup and Restore

Although the indexer database is a derived read-model that can be fully reconstructed by replaying Soroban events from the deployment ledger, a tested backup and restore path reduces outage time and protects checkpoint correctness.

The procedure below is deliberately structured as an **isolated drill**, not a direct production overwrite. Every step targets a separate restore database (`circleup_restore`) so the production database remains untouched until you have verified the backup is coherent and the schema is clean. Only after passing all verification steps should you decide whether to promote the restore target or fall back to a chain replay.

---

### Backup

**Frequency:** Daily backups are recommended for production. The indexer's `last_ledger` cursor is stored in the `indexer_state` table — losing it forces a full replay from `START_LEDGER`, which can take minutes to hours depending on chain history. The `ledger_checkpoints` table records per-ledger processing state; losing it means crash recovery falls back to `indexer_state` alone.

**Docker Compose (default local setup):**

```bash
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U postgres --format=custom circleup \
  > backups/circleup_$(date +%Y%m%d_%H%M%S).dump
```

Using `--format=custom` (not plain SQL) enables `pg_restore --list` for integrity pre-checks and is faster to restore for large databases. If you need a plain SQL dump for inspection, omit `--format=custom`.

**External Postgres:**

```bash
pg_dump "$DATABASE_URL" --format=custom \
  > backups/circleup_$(date +%Y%m%d_%H%M%S).dump
```

Store backups off-host (S3, GCS, etc.). Retain at least 7 daily snapshots.

---

### Restore drill — isolated target

This procedure restores to `circleup_restore`, a throwaway database, so production data cannot be overwritten by following it.

**Step 1 — Verify backup file integrity before use**

Never skip this step. A corrupt or incomplete backup file discovered mid-restore causes more downtime than not restoring at all.

```bash
# Check the archive is readable and list its contents
pg_restore --list backups/circleup_<timestamp>.dump | head -40

# Confirm the file is non-zero and was written recently
ls -lh backups/circleup_<timestamp>.dump
```

Expected: `pg_restore --list` should print table and index entries without errors. A file that is 0 bytes or that `pg_restore --list` refuses to parse is not usable.

**Step 2 — Create an isolated restore target**

```bash
# Docker Compose
docker compose exec -T postgres \
  psql -U postgres -c "CREATE DATABASE circleup_restore;"

# External Postgres
psql "$DATABASE_URL" -c "CREATE DATABASE circleup_restore;"
```

The restore target is explicitly named to avoid any chance of accidentally targeting the production database. Do not use the production database name (`circleup`) for any step in this drill.

**Step 3 — Stop the indexer**

The indexer must not be writing while you verify the restore. If you are drilling on a separate host this step may be optional, but in a single-host setup stop it first.

```bash
npm run stop:indexer   # or kill the process
```

**Step 4 — Restore into the isolated target**

```bash
# Docker Compose
docker compose exec -T postgres \
  pg_restore -U postgres -d circleup_restore --no-owner --no-acl \
  < backups/circleup_<timestamp>.dump

# External Postgres — construct a URL pointing at the restore database
RESTORE_URL="${DATABASE_URL%/*}/circleup_restore"
pg_restore "$RESTORE_URL" --no-owner --no-acl \
  < backups/circleup_<timestamp>.dump
```

`pg_restore` will print warnings for objects it skips (e.g. extensions owned by a superuser). These are normal. Errors that cause table creation or data load to fail should be investigated before proceeding.

---

### Post-restore verification

Run every check in this section against `circleup_restore`, not production. Partial passes mean the backup is not fit for promotion.

**Migration health — must be `clean` before the indexer can start safely:**

```bash
# Point the check at the restore database
DATABASE_URL="${DATABASE_URL%/*}/circleup_restore" \
  npm run migrate:check --workspace=indexer
# Expected output: Health state: clean
```

If the result is `pending`, the backup predates a migration. Apply pending migrations to the restore target before continuing (see [Applying migrations after restore](#applying-migrations-after-restore)). Do not proceed with a `drifted` or `partial` result — investigate first.

**Cursor and checkpoint integrity:**

```sql
-- Connect to circleup_restore for these queries

-- 1. Confirm the indexer cursor row exists and is non-zero
SELECT last_ledger, updated_at
FROM indexer_state
WHERE id = 1;
-- Expected: last_ledger > 0; updated_at matches the backup window

-- 2. Confirm checkpoints are present and contiguous near the cursor
SELECT ledger, events_count, failed_count, processed_at
FROM ledger_checkpoints
ORDER BY ledger DESC
LIMIT 10;
-- Expected: rows exist; most-recent ledger ≈ last_ledger from indexer_state
-- A gap between last_ledger and the most recent checkpoint ledger > ~100
-- suggests the cursor was updated without writing checkpoints (replay interrupted)

-- 3. Confirm core tables are non-empty (for a non-empty deployment)
SELECT
  (SELECT COUNT(*) FROM circles)         AS circles,
  (SELECT COUNT(*) FROM circle_members)  AS members,
  (SELECT COUNT(*) FROM contributions)   AS contributions,
  (SELECT COUNT(*) FROM payouts)         AS payouts,
  (SELECT COUNT(*) FROM ingested_events) AS ingested_events;
-- Expected: all counts > 0 for a production backup
-- Zero rows in ingested_events is a red flag — the dedup table should always
-- have at least as many rows as contributions + payouts + join events

-- 4. Confirm schema_migrations is present and non-empty
SELECT filename, applied_at
FROM schema_migrations
ORDER BY filename;
-- Expected: all migration files that exist on disk are listed here
```

**API smoke reads against the restore target:**

Start the indexer pointed at `circleup_restore` to confirm the restored data is coherent end-to-end through the API layer:

```bash
# Temporarily point the indexer at the restore database
DATABASE_URL="${DATABASE_URL%/*}/circleup_restore" \
  npm run dev:indexer

# In another terminal — wait for "Indexer API listening" then:

# Health check — confirms DB is reachable and schema is clean
curl -s http://localhost:3001/health | jq .
# Expected: { "status": "ok", "db": { "status": "ok" }, ... }

# Indexer state — confirm lastLedger matches the cursor value from the SQL check above
curl -s http://localhost:3001/indexer/state | jq .
# Expected: { "lastLedger": <matches last_ledger above>, "totalEvents": <> }

# Circle list — confirm circles are visible
curl -s "http://localhost:3001/circles?limit=5" | jq '.circles | length'
# Expected: > 0 for a non-empty deployment

# Spot-check one circle's detail and rounds
ADDR=$(curl -s "http://localhost:3001/circles?limit=1" | jq -r '.circles[0].address')
curl -s "http://localhost:3001/circles/${ADDR}" | jq '.circle.status'
curl -s "http://localhost:3001/circles/${ADDR}/rounds" | jq '.rounds | length'
```

Stop the indexer when you are done (`Ctrl+C`).

---

### Applying migrations after restore

If `migrate:check` reports `pending`, apply the missing migrations to the restore target before running the API checks above:

```bash
DATABASE_URL="${DATABASE_URL%/*}/circleup_restore" \
  npm run migrate --workspace=indexer

DATABASE_URL="${DATABASE_URL%/*}/circleup_restore" \
  npm run migrate:check --workspace=indexer
# Expected: Health state: clean
```

Do not apply migrations to production until you have verified the same migrations succeed cleanly on the restore target first. This gives you a dry-run of the migration against real data without touching production.

---

### Restore vs. chain replay — decision criteria

Use this table to decide whether to restore from backup or replay from the chain. Replay is always safe (it rebuilds from the canonical chain state); restore is faster but only if the backup is coherent.

| Situation | Recommendation |
|---|---|
| Backup is recent (< 24 h), all post-restore checks pass | **Restore** — fastest recovery |
| Backup is 1–7 days old, schema is clean, cursor lag is acceptable | **Restore**, then let the indexer catch up by replaying from `last_ledger` |
| Backup predates a migration that changes event *processing* logic (not just schema) | **Replay** — snapshot data was computed under old logic |
| Post-restore `migrate:check` reports `drifted` or `partial` | **Replay** — backup schema state is not trustworthy |
| `ingested_events` count is zero or the checkpoint/cursor gap is > 500 ledgers | **Replay** — dedup table or checkpoints may be incomplete |
| No recent backup exists | **Replay** from deployment ledger |
| Backup is suspected to contain duplicate rows from a failed replay | **Replay** |

When replaying, use the cursor value from the last healthy backup as the `--from` argument rather than replaying all the way from genesis:

```bash
# Use the last_ledger from the most recent healthy backup as the replay start
npm run replay --workspace=indexer -- --from=<last_ledger_from_backup>
```

See [Re-indexing from a Given Ledger](#re-indexing-from-a-given-ledger) for dry-run and partial replay options.

---

### Promoting the restore target to production

Only proceed here after every check in [Post-restore verification](#post-restore-verification) passes.

```bash
# 1. Confirm the indexer is stopped
# 2. Rename the databases atomically
docker compose exec -T postgres psql -U postgres <<'SQL'
  ALTER DATABASE circleup RENAME TO circleup_old;
  ALTER DATABASE circleup_restore RENAME TO circleup;
SQL

# External Postgres: same two ALTER DATABASE statements
```

`circleup_old` is kept as a fallback. Do not drop it until the indexer has been running against the promoted database for at least one polling cycle and `GET /health` returns `"status": "ok"`.

```bash
# 3. Restart the indexer (now targeting circleup)
npm run dev:indexer

# 4. Confirm health immediately after start
sleep 5 && curl -s http://localhost:3001/health | jq .status
# Expected: "ok"
```

Once you are confident, drop the old database:

```bash
docker compose exec -T postgres \
  psql -U postgres -c "DROP DATABASE circleup_old;"
```

---

### Rollback guidance

If a migration or deploy causes data corruption:

1. Stop the indexer immediately.
2. If the rename in [Promoting the restore target to production](#promoting-the-restore-target-to-production) was not yet done, production data is still intact — the restore drill ran on `circleup_restore` only.
3. If the rename was done, reverse it: `ALTER DATABASE circleup RENAME TO circleup_bad; ALTER DATABASE circleup_old RENAME TO circleup;`
4. Run `npm run migrate:check` to confirm the schema state before restarting.
5. If no safe backup exists, replay from the last known-good ledger: `npm run replay -- --from=<ledger>`.
6. Do **not** re-run a failed migration without first reverting the migration file — the runner will attempt to re-apply it and may produce duplicate or conflicting schema changes.

---

## Health Checks and Monitoring

### Indexer Health Endpoint

```
GET /health
```

Returns 200 when both Postgres and the Soroban RPC are reachable:

```json
{
  "status": "ok",
  "timestamp": "2026-08-23T10:00:00.000Z",
  "db": { "status": "ok", "latencyMs": 2 },
  "rpc": { "status": "ok", "latencyMs": 45 },
  "config": { "usdcAddress": "C..." }
}
```

Returns 503 with `"status": "degraded"` and per-component error details when either component fails. Use this endpoint for load-balancer health checks and uptime monitoring.

The `config.usdcAddress` field lets operators confirm at a glance that the indexer and the app are tracking the same USDC token without cross-referencing env files.

### Indexer Audit Endpoint

```
GET /indexer/state
```

Reports indexing progress independent of connectivity:

```json
{
  "lastLedger": 12350000,
  "updatedAt": "2026-08-23T09:59:55.000Z",
  "totalEvents": 1432,
  "eventCounts": {
    "factory/circle_created": 12,
    "circle/joined": 48,
    "circle/contributed": 360,
    "circle/payout": 36,
    "reputation/score_updated": 36
  }
}
```

Alert when `lastLedger` stops advancing ΓÇö this indicates the polling loop has stalled (RPC connection lost, process OOM, etc.).

### Useful Monitoring Queries

Run these against the indexer Postgres database for operational checks:

```sql
-- How far behind is the indexer? (compare to current testnet ledger via RPC)
SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1;

-- Circles by status
SELECT status, COUNT(*) FROM circles GROUP BY status ORDER BY status;

-- Members with most defaults (top 10)
SELECT member_address, SUM(defaults) AS total_defaults
FROM circle_members
GROUP BY member_address
ORDER BY total_defaults DESC
LIMIT 10;

-- Recent payouts
SELECT circle_address, recipient, amount, tx_hash, created_at
FROM payouts
ORDER BY created_at DESC
LIMIT 20;

-- Dedup table size (events processed)
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM ingested_events;

-- Circles with pending contributions (active circles where round not yet paid)
SELECT c.address, c.current_round, c.total_rounds,
       COUNT(cm.member_address) AS member_count,
       (SELECT COUNT(*) FROM contributions co
        WHERE co.circle_address = c.address AND co.round_index = c.current_round) AS contributions_in
FROM circles c
JOIN circle_members cm ON cm.circle_address = c.address
WHERE c.status = 'Active'
GROUP BY c.address, c.current_round, c.total_rounds;
```

---

## Troubleshooting

### App shows "indexer unreachable" banner

**Symptom:** The home page renders the "Circles list unavailable" amber banner and the circle count shows nothing.

**Diagnosis:**
1. Check the indexer process is running: `curl http://localhost:3001/health`
2. Check `NEXT_PUBLIC_INDEXER_URL` in `app/.env.local` ΓÇö must be a valid absolute URL (`http://` or `https://`).
3. Check for CORS issues if the app and indexer are on different origins in production: ensure `ALLOWED_ORIGINS` in `indexer/.env` includes the app's origin.

**Resolution:**
- Start the indexer: `npm run dev:indexer`
- Fix the `NEXT_PUBLIC_INDEXER_URL` value and restart the Next.js dev server.
- Add the app origin to `ALLOWED_ORIGINS` in `indexer/.env` and restart the indexer.

---

### Circle list is empty but circles exist on-chain

**Symptom:** No circles appear in the app but you can see them via stellar-cli or stellar.expert.

**Diagnosis:**
1. Check indexer state: `curl http://localhost:3001/indexer/state` ΓÇö is `lastLedger` advancing?
2. Check `START_LEDGER` in `indexer/.env` ΓÇö if it is set to a ledger *after* the factory deployment, those events were skipped.
3. Check `CIRCLE_FACTORY_ADDRESS` in `indexer/.env` ΓÇö a wrong or empty address means `getEvents` returns nothing silently.

**Resolution:**
- Set `START_LEDGER` to the ledger at or before the factory was deployed and restart.
- Fix `CIRCLE_FACTORY_ADDRESS` and replay from the correct ledger: `npm run replay -- --from=<deployment_ledger>`

---

### Circle detail page shows 404

**Symptom:** Navigating to `/circles/[address]` renders the "Page not found" page.

**Cause:** The circle exists on-chain but the indexer has not yet processed the `factory/circle_created` event. This is normal for circles created very recently (within the last `POLL_INTERVAL_MS` milliseconds).

**Resolution:**
- Wait a few seconds and refresh. The indexer will process the event on the next poll.
- If the 404 persists after 60 seconds, check `GET /indexer/state` to confirm the indexer is advancing. Also verify the circle address is correct ΓÇö copy it from the transaction receipt in stellar.expert.

---

### Reputation page shows no data

**Symptom:** `/reputation/[address]` shows "No reputation record found."

**Cause:** This is not an error. It means the address has no `reputation/score_updated` events in the indexer database. The member has not yet completed a full payout round in any circle.

**If reputation should exist:**
1. Check `REPUTATION_ADDRESS` in `indexer/.env` matches the deployed contract.
2. Check the `reputation` table in Postgres directly:
   ```sql
   SELECT * FROM reputation WHERE member_address = '<address>';
   ```
3. If the row is missing but you know a payout occurred, replay from the payout ledger.

---

### My Reputation link in the nav is greyed out

**Symptom:** The "My Reputation" nav item appears muted and is not clickable.

**Cause:** This is expected when no Freighter wallet is connected. The `WalletRepLink` component reads the wallet address client-side; until Freighter returns an address the link renders as a disabled span to avoid pointing to a broken URL.

**Resolution:** Connect your Freighter wallet using the "Connect Wallet" button in the top-right of the nav.

---

### Transaction fails with "USDC transfer failed"

**Symptom:** Calling `join`, `contribute`, `payout`, or `close` returns an error containing "USDC transfer failed during ...".

**Possible causes and fixes:**

| Sub-message | Cause | Fix |
|---|---|---|
| `join collateral deposit` | Member's USDC balance is less than `round_amount` | Fund the wallet with testnet USDC via Friendbot or a faucet |
| `round contribution` | Member's balance dropped below `round_amount` since joining | Same as above |
| `round payout` | Circle contract's USDC balance is insufficient (should not happen normally) | Check for missing contributions ΓÇö call `get_current_round` to verify `contributions_received` |
| `collateral release` | Token frozen, deauthorized, or missing trustline | Check the member's USDC trustline on stellar.expert |

---

### Indexer keeps restarting with missing env vars

**Symptom:** The indexer process exits immediately with `[circleup-indexer] Missing required environment variable(s)`.

**Resolution:**
1. Check that `indexer/.env` exists: `cp indexer/.env.example indexer/.env`
2. Open `indexer/.env` and fill in every variable listed in the error message.
3. Confirm no trailing spaces or quotes around values ΓÇö the validator trims but does not strip quotes.

---

### Indexer boot: "SCHEMA WARNING"

**Symptom:** The indexer log shows a `SCHEMA WARNING` line after startup.

**Meaning:** The database schema is in a `drifted` or `partial` state ΓÇö either a migration was applied but the file is missing, or the SQL content does not match what was applied.

**Resolution:**
1. Run `npm run migrate:check --workspace=indexer` to see the full diff.
2. For `pending`: run `npm run migrate` to apply the new files.
3. For `drifted`: restore the original migration files from git history and investigate whether the schema was modified out-of-band.
4. For `partial`: locate the missing migration files. Do not re-run the runner blindly ΓÇö it will try to apply files it thinks are pending and may duplicate or conflict.

The indexer continues serving data in a `drifted` or `partial` state; the warning is surfaced so it is not missed before the next deploy.

---

### Payout fails with "reputation increment failed"

**Symptom:** `circle.payout()` transaction fails with `circle: reputation increment failed`.

**Cause:** The circle contract is not registered as an authorized caller on the reputation contract. This happens if:
- The circle was deployed manually (bypassing the factory), or
- The factory's `add_authorized_caller` call failed during `create_circle` and the transaction was not fully rolled back.

**Resolution:**
- Confirm the circle was deployed through the factory (check `factory/circle_created` event for this circle address).
- If deploying a circle manually for testing, call `reputation.add_authorized_caller(factory_address, circle_address)` from the factory admin account before attempting a payout.
- Check `GET /reputation/:member` includes the circle in `contributions` ΓÇö if the indexer has no contribution records, the payout was never reached.

---

### mark_default fails with "round deadline not yet passed"

**Symptom:** Calling `mark_default` returns `"round deadline not yet passed"`.

**Cause:** The current ledger sequence is Γëñ `deadline_ledger` of the current round. The contract enforces `ledger.sequence > deadline_ledger` strictly; the deadline ledger itself is not in the default window.

**Resolution:**
- Check the current ledger: `stellar network status --network testnet` shows the latest ledger.
- Check the deadline: `GET /circles/:address` returns `circle.deadline_ledger`.
- Wait until the network ledger advances past the deadline ledger.
- On testnet, ledgers advance approximately every 5 seconds. `(deadline_ledger - current_ledger) ├ù 5` seconds is the remaining wait time.

---

### App build fails with TypeScript errors

**Symptom:** `npm run build --workspace=app` exits with TypeScript errors.

**Common causes:**

| Error pattern | Cause | Fix |
|---|---|---|
| `'useState' is not defined` in a page.tsx | A page component uses hooks without `"use client"` | Add `"use client"` or move hook logic to a Client Component |
| `Type 'X' is not assignable to 'Y'` on a page prop | `params` type mismatch for dynamic routes | Ensure `params: { address: string }` matches the route segment name |
| `Cannot find module '@/lib/...'` | Missing `@` path alias in tsconfig | Check `app/tsconfig.json` has `"paths": { "@/*": ["./src/*"] }` |
| `Property 'X' does not exist on type 'Y'` after indexer API changes | SDK types out of sync with API response shape | Update the interface in `CircleDetailClient.tsx` to match the new shape |

---

### Freighter not detected

**Symptom:** Clicking "Connect Wallet" does nothing or `isFreighterInstalled()` returns false.

**Resolution:**
1. Install the [Freighter browser extension](https://www.freighter.app/).
2. Make sure the extension is enabled and the site origin is not blocked.
3. On localhost, Freighter may require switching to testnet manually in the extension settings.
4. Try a hard refresh (`Ctrl+Shift+R`) ΓÇö some Freighter versions inject the API asynchronously.

---

## Contract Lifecycle Reference

### Circle Status Machine

```
           join (all members)
Pending ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╢ Active ΓöÇΓöÇ(all rounds paid)ΓöÇΓöÇΓû╢ Completed
   Γöé                                                                Γöé
   Γöé cancel()                                                       Γöé
   Γû╝                                                                Γöé
Cancelled ΓùÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ Γöÿ
                                                         close() allowed from
                                                         both terminal states
```

- Status transitions are one-way and permanent.
- Active and Completed circles cannot be cancelled.
- `close()` is only callable from `Completed` or `Cancelled`.

### Round Lifecycle

Within an Active circle, each round follows this sequence:

```
Round starts (deadline clock set)
    Γöé
    Γö£ΓöÇ Members call contribute() before deadline_ledger
    Γöé
    Γö£ΓöÇ Anyone may call mark_default(member) AFTER deadline_ledger
    Γöé   for any member who did not contribute
    Γöé
    ΓööΓöÇ Anyone calls payout() once all members have contributed
           Γöé
           Γö£ΓöÇ Transfers round_amount ├ù member_count USDC to recipient
           Γö£ΓöÇ Calls reputation.increment(recipient)
           ΓööΓöÇ Advances to next round (or sets status = Completed)
```

Deadline boundary: `contribute` is rejected when `ledger.sequence > deadline_ledger`. `mark_default` is rejected when `ledger.sequence <= deadline_ledger`. The deadline ledger itself is part of the contribution window (last accepted ledger for `contribute`).

### Reputation Authorization Flow

```
Deploy:
  reputation.initialize(admin = deployer_wallet)
  circle_factory.initialize(admin = deployer_wallet,
                            reputation_contract = reputation_address, ...)
  reputation ΓÇö transfer admin to factory_address
    (so factory can call add_authorized_caller)

Per circle creation:
  circle_factory.create_circle(...)
    Γö£ΓöÇ deploys circle contract
    Γö£ΓöÇ calls circle.initialize(...)
    ΓööΓöÇ calls reputation.add_authorized_caller(factory_address, circle_address)
         (factory is admin; Contract Invoker rule auto-grants auth)

Per payout:
  circle.payout()
    ΓööΓöÇ calls reputation.increment(circle_address, recipient)
         (circle address is authorized caller; Contract Invoker auto-grants auth)
```

A revoked circle can never call `increment` again, even if the factory re-deploys and re-registers its address. The revocation list is permanent and checked before the allowlist.

---

## Secrets and CI Injection

### Why secrets must never appear in logs

`scripts/src/deploy.ts` and `scripts/src/seed-demo.ts` automatically redact Stellar secret-key patterns (`S[A-Z2-7]{55}`) from all console output and error messages before they are emitted. This means a key that leaks into a command output or an exception message will be replaced with `[SECRET_REDACTED]` in the log. The redaction is a safety net, not a substitute for keeping keys out of commands in the first place.

### Secure local injection

Store secrets in the untracked `scripts/.env` file (copied from `scripts/.env.example`). The deploy script loads this file automatically via `dotenv`. Never commit `scripts/.env` ΓÇö it is listed in `.gitignore`.

```bash
cp scripts/.env.example scripts/.env
# Edit scripts/.env and fill in DEPLOYER_IDENTITY, NETWORK, etc.
# The deployer private key stays in the stellar-cli keystore, not in .env:
stellar keys generate --global deployer --network testnet
```

The deployer private key is managed entirely by `stellar-cli`. The deploy script references the deployer by *identity name* (`DEPLOYER_IDENTITY=deployer`), never by raw private key, so the key is never passed on the command line or stored in any env file.

### CI injection (GitHub Actions)

Store secrets in the repository's encrypted secret store (**Settings ΓåÆ Secrets and variables ΓåÆ Actions**). Inject them as environment variables in the workflow step, not as inline values in the YAML file:

```yaml
- name: Deploy contracts
  env:
    NETWORK: testnet
    DEPLOYER_IDENTITY: deployer
    STELLAR_SECRET_KEY: ${{ secrets.DEPLOYER_SECRET_KEY }}
  run: npm run deploy:testnet --workspace=scripts
```

Never print secrets with `echo` or `run: env` steps. GitHub Actions automatically masks values registered as secrets, but the deploy script's built-in redaction provides a second layer for any pattern that slips through.

### Failing fast on missing secrets

The deploy script validates that `NETWORK`, `NETWORK_PASSPHRASE`, and `RPC_URL` are set before any write transaction. If a required value is absent the script exits with code 1 and a clear error message listing the missing variable ΓÇö it never falls through to a deployment with an empty or default value. Run `npm run validate-env --workspace=scripts` before deploying to check the profile independently.

---

## Security Notes

- **No rug-pulls**: The organizer cannot withdraw funds. All USDC is held by the circle contract, not any wallet. Only `payout()` and `close()` release funds, and only to the scheduled recipient or back to members respectively.
- **Collateral protects the group**: Each member locks `round_amount` USDC as collateral. A missed contribution deducts 20% from their collateral (not from other members' funds). The contract cannot distribute more than it holds.
- **Deterministic payout order**: The recipient for each round is `members[round_index]`, set immutably at `initialize` time. No one can change the rotation after the circle goes Active.
- **Reentrancy protection**: `initialize` uses an `Initializing` flag. `close` sets `Closed = true` before any transfer loops. `join` writes the `Collateral` key before the token transfer. These follow the checks-effects-interactions pattern throughout.
- **Reputation is manipulation-resistant**: `increment` requires a signature from the calling circle contract (auto-granted by Soroban's Contract Invoker rule for cross-contract calls). A wallet cannot directly call `increment` for itself without producing a signature for a circle contract's private key, which is impossible.
- **CORS in production**: The indexer allows all origins by default (`ALLOWED_ORIGINS` unset). In production always set `ALLOWED_ORIGINS` to the app's exact origin. The API logs a warning on startup when this is unset.
- **Rate limiting**: The API applies a per-IP rate limit (default 100 requests/60 seconds). Adjust `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` in `indexer/.env` for production traffic.

---

## Incident Fixtures and Offline Reproduction

The fixtures in `indexer/src/fixtures/incident-fixtures.ts` encode sanitized, deterministic state snapshots for each likely incident class.  They contain no real private keys, no production transaction hashes, and no live RPC responses.  Every address is a synthetic all-zero strkey; every ledger number is chosen so relative ordering is obvious at a glance.

Use the fixtures to reproduce an incident class locally without needing a live network, a funded wallet, or a running Postgres instance.

### Fixture Overview

| Fixture namespace | Incident class | Runbook section |
|---|---|---|
| `StaleIndexerData` | Indexer cursor freezes; DB status/round lag behind chain | [Circle list is empty but circles exist on-chain](#circle-list-is-empty-but-circles-exist-on-chain) |
| `DuplicateEvents` | Same Soroban event delivered twice; dedup guard verified | [Circle list is empty but circles exist on-chain](#circle-list-is-empty-but-circles-exist-on-chain) |
| `WalletRejection` | Freighter not installed / permission denied / unknown error | [Freighter not detected](#freighter-not-detected) ┬╖ [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed) |
| `RpcTimeout` | simulate / send / poll timeout; health endpoint 503 | [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed) ┬╖ [App shows "indexer unreachable" banner](#app-shows-indexer-unreachable-banner) |
| `SchemaDrift` | Migration file renamed after apply; ghost entry in `schema_migrations` | [Indexer boot: "SCHEMA WARNING"](#indexer-boot-schema-warning) |

### Running the Incident Tests

```bash
# Run all incident reproduction tests (offline ΓÇö no DB or RPC required):
npm run test:incidents --workspace=indexer

# Run the full indexer test suite (includes incidents + integration tests):
npm test --workspace=indexer
```

The `test:incidents` script targets only `src/fixtures/incident.test.ts` so it passes in any offline environment ΓÇö CI runners without Postgres, developer laptops without a running indexer, or during an active incident when the network is degraded.

### StaleIndexerData fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` ΓÇö `StaleIndexerData` namespace

**Encodes:**
- `seedIndexerState()` ΓÇö indexer `last_ledger = 1_220_000` while chain tip is `1_280_000` (60 000 ledger lag Γëê 83 hours)
- `seedCircle()` ΓÇö circle row frozen at `status = "Active"`, `current_round = 0` while on-chain the circle is `Completed`
- `seedOnChainState()` ΓÇö the actual on-chain truth for cross-checking lag

**Reproduction steps:**
1. Insert `seedIndexerState()` into `indexer_state` and `seedCircle()` into `circles`.
2. Query `GET /circles/:address` ΓÇö response shows stale `status` and `current_round`.
3. Query `GET /indexer/state` ΓÇö `lastLedger` is behind by `lagLedgers`.
4. Compare against `seedOnChainState()` to verify the delta matches `expectedBehaviour.lagLedgers`.

**Resolution:** set `START_LEDGER` to `LEDGER.STALE` and replay: `npm run replay -- --from=1220000`

### DuplicateEvents fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` ΓÇö `DuplicateEvents` namespace

**Encodes:**
- `seedIngestedEvent()` / `seedDuplicateIngestedEvent()` ΓÇö two rows with the same `event_key` (`tx_hash:event_index`)
- `seedContribution()` / `seedPayout()` ΓÇö the corresponding derived rows

**Reproduction steps:**
1. Insert `seedIngestedEvent()` into `ingested_events` ΓÇö succeeds.
2. Attempt to insert `seedDuplicateIngestedEvent()` ΓÇö `event_key` PRIMARY KEY conflict rejects it.
3. Confirm `ingested_events` contains exactly one row for this event (`expectedBehaviour.ingestedEventsRows = 1`).
4. Confirm the `contributions` and `payouts` tables each contain exactly one row per UNIQUE constraint.

**What to check if duplicate rows appear:** the dedup `INSERT ΓÇª ON CONFLICT DO NOTHING` in `indexer.ts` was bypassed (e.g. a direct SQL insert during a failed replay).  Re-run `npm run replay -- --from=<ledger>` to reconcile.

### WalletRejection fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` ΓÇö `WalletRejection` namespace

**Encodes three sub-cases:**

| Sub-case | Trigger | Expected `invokeContract` result |
|---|---|---|
| `notInstalled` | `isFreighterInstalled()` returns `false` | `{ success: false, txHash: "", error: "Freighter wallet extension is not installed." }` |
| `permissionDenied` | User dismisses the Freighter prompt | `{ success: false, txHash: "", error: "You cancelled the transaction in Freighter. No funds were moved." }` |
| `unknownError` | Extension throws `"Extension context invalidated."` | `{ success: false, txHash: "", error: "Extension context invalidated." }` |

**Reproduction steps:**
1. In a browser test environment, mock `isFreighterInstalled` to return `false` and call `connectWallet()` ΓÇö should throw `WalletError` with `reason = "not_installed"`.
2. Mock `signTransaction` to throw one of `permissionDenied.rawErrorVariants` ΓÇö `invokeContract` must return `expectedResult`.
3. Mock `signTransaction` to throw `unknownError.rawError` ΓÇö formatted error must equal `unknownError.expectedResult.error`.

**Runbook resolution:** see [Freighter not detected](#freighter-not-detected) for install and permission steps.

### RpcTimeout fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` ΓÇö `RpcTimeout` namespace

**Encodes four sub-cases:**

| Sub-case | Phase | Expected result |
|---|---|---|
| `simulateTimeout` | `simulateTransaction` throws `"Request timeout"` | `success: false`, network error message |
| `sendTimeout` | `sendTransaction` throws `"Failed to fetch"` | `success: false`, network error message |
| `pollExhausted` | 30 polls all return `NOT_FOUND` | `success: false`, `txHash` preserved, timeout message |
| `healthCheckTimeout` | DB + RPC both exceed 5 000 ms | HTTP 503, `status: "degraded"` |

**Reproduction steps:**
1. Inject `RpcTimeout.seedMockRpcThatTimesOut(10)` as the RPC client and call `invokeContract` ΓÇö should return `success: false` within ~10 ms (not after the full 60 s poll budget).
2. For `pollExhausted`: stub `getTransaction` to always return `{ status: "NOT_FOUND" }` ΓÇö after 30 attempts `invokeContract` returns the timeout message with the `txHash` preserved.
3. For health timeout: stub `pool.query` and RPC latency checks to resolve after 6 000 ms ΓÇö `GET /health` must return 503 with `"status": "degraded"`.

**Runbook resolution:** see [App shows "indexer unreachable" banner](#app-shows-indexer-unreachable-banner) and [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed).

### SchemaDrift fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` ΓÇö `SchemaDrift` namespace

**Encodes:**
- `seedAppliedInDb()` ΓÇö `["001_add_round_deadline_ledgers.sql"]` (original name, still in `schema_migrations`)
- `seedFilesOnDisk()` ΓÇö `["001_add_round_deadline_ledgers_renamed.sql", "002_ledger_checkpoints.sql"]` (original gone, renamed version present)
- `seedAppliedRow()` ΓÇö the `schema_migrations` row with the original filename

**Reproduction steps:**
1. Insert `seedAppliedRow()` into `schema_migrations`.
2. Temporarily rename `indexer/src/db/migrations/001_add_round_deadline_ledgers.sql` to the `RENAMED_FILENAME`.
3. Run `npm run migrate:check --workspace=indexer` ΓÇö output must show `Health state: drifted`.
4. Restore the original filename; re-run the check ΓÇö output must show `Health state: pending` (renamed file now pending).

**Runbook resolution:** see [Indexer boot: "SCHEMA WARNING"](#indexer-boot-schema-warning) for drift recovery steps.

---

## Mutation Testing and Guard Verification

### Why Mutation Testing

A test that passes when a critical guard is removed is not testing that guard ΓÇö it is testing something else.  Mutation testing detects this by explicitly removing each guard and verifying that at least one test fails.

CircleUp uses an **explicit guard-removal** strategy rather than a fully automated mutation framework (e.g. `cargo-mutants`):

- Each critical guard has a named test that proves removal would be detected.
- The strategy is transparent: the guard under test and the risk if removed are documented in the test file header.
- CI budget is predictable: the tests run as part of the standard `cargo test` / `npm test` invocations without a separate mutation runner.

### Contract Mutation Guards (Rust)

**File:** `contracts/circle/src/mutation_guards.rs`

Run with:

```bash
cd contracts && cargo test -p circle mutation_guard
```

Fifteen guards are tested across the `circle` and `reputation` contracts:

| Guard | Risk if removed | Test |
|---|---|---|
| `already joined` (`has` check, not balance) | Double-collateral pull | `guard_join_double_collateral_pull` ┬╖ `guard_join_has_check_not_balance_check` |
| `not all members have contributed yet` | Payout before all deposits | `guard_payout_requires_full_contribution_counter` ┬╖ `guard_payout_one_missing_contribution_blocks` |
| `round contribution tally mismatch` | Forged counter bypasses payout | `guard_payout_tally_mismatch_forged_counter` ┬╖ `guard_payout_forged_keys_without_counter_blocked` |
| `round deadline not yet passed` (strict `>`) | Premature default; collateral stolen early | `guard_mark_default_deadline_strict_boundary` ┬╖ `guard_mark_default_one_before_deadline_blocked` |
| `member did contribute` | Contributor penalised despite fulfilling obligation | `guard_mark_default_contributor_cannot_be_penalised` ┬╖ `guard_contribution_key_persists_after_deadline_for_guard_correctness` |
| `already marked default this round` | Double penalty (36% instead of 20%) | `guard_mark_default_idempotency` ┬╖ `guard_mark_default_single_penalty_amount_is_correct` |
| `circle already closed` (Closed flag) | Double-release of collateral | `guard_close_double_release_prevention` ┬╖ `guard_close_collateral_zeroed_before_transfer_cei` |
| `overflows penalty calculation` | Silent i128 wrap; penalty becomes 0 | `guard_initialize_overflow_penalty_arithmetic` |
| `overflows pot calculation` | Silent i128 wrap; recipient receives wrong amount | `guard_initialize_overflow_pot_arithmetic` |
| `already initialized` | Member list overwrite mid-lifecycle | `guard_reinitialize_blocked` ┬╖ `guard_reinitialize_blocked_with_different_params` |
| Reputation unauthorized caller | Self-awarded reputation points | `guard_reputation_unauthorized_caller_blocked` |
| Reputation revocation permanent | Revived circle awards points | `guard_reputation_revocation_is_permanent` |
| `duplicate members` | One wallet gets two rotation slots | `guard_duplicate_members_rejected` |
| Non-member cannot close | Outsider triggers collateral settlement | `guard_close_non_member_rejected` |
| Status gate for contribute/close | Contributions/closes on wrong lifecycle phase | `guard_contribute_blocked_while_pending` ┬╖ `guard_contribute_blocked_while_completed` ┬╖ `guard_contribute_rejected_one_past_deadline` |

Each guard test follows one of two forms:

- **Form A** (`#[should_panic]`): the contract is put into the state the guard is meant to block, and the test asserts the call panics with the exact guard message. Removing the guard makes the call succeed, breaking the `#[should_panic]` assertion.
- **Form B** (positive assertion): the test verifies the call _succeeds_ at the boundary where the guard allows it, and separately verifies the guard fires one step earlier. Weakening the boundary (e.g. changing `>` to `>=`) would break one of the two assertions.

### App Gating Mutation Tests (TypeScript)

**File:** `app/src/lib/gating.mutation.test.ts`

Run with:

```bash
node --require ts-node/register --test app/src/lib/gating.mutation.test.ts
```

Eight guards are tested in `computeActionEligibility`:

| Guard | Action | Risk if removed | Mutant proof |
|---|---|---|---|
| `stale_snapshot` (age ΓëÑ maxAge) | all | Stale UI state submits on-chain write | `mutantNoStalenessCheck` allows stale snapshots |
| `wrong_status` (Pending for join) | join | `join` on Active/Completed circle | `mutantNoStatusCheckJoin` allows join on Active |
| `wrong_status` (Active for contribute) | contribute | `contribute` on Pending/Completed circle | `mutantNoStatusCheckContribute` allows on Pending |
| `deadline_passed` (latestLedger > deadlineLedger) | contribute | Late contribution submitted after deadline | `mutantNoDeadlineCheckContribute` allows late contributions |
| `already_joined` (hasLockedCollateral) | join | Double-join from browser triggers double-collateral | `mutantNoAlreadyJoinedCheck` allows when already joined |
| `already_contributed` | contribute | Double-contribute from browser | `mutantNoAlreadyContributedCheck` allows when already contributed |
| `round_not_complete` (contributions < memberCount) | payout | Premature payout triggered from UI | `mutantNoRoundCompleteCheckPayout` allows with partial contributions |
| `wrong_status` (terminal for close) | close | Close on Active/Pending circle | `mutantNoStatusCheckClose` allows on Active |

Each test follows the **production vs. mutant** pattern:
1. Assert the production function **blocks** the action for the given input.
2. Call the local mutant (guard removed) with the same input.
3. Assert the mutant **allows** it ΓÇö proving the production guard is the discriminating factor.

Guard ordering invariants are also tested: `stale_snapshot` is checked before `wrong_status` which is checked before action-specific guards, for all four actions.

### CI Budget and Excluded Mutations

**Budget:** All mutation guard tests run as part of the existing CI commands ΓÇö no separate mutation runner or additional CI step is required.

```
cargo test -p circle          # includes mutation_guards.rs ΓÇö ~5 s
npm test --workspace=indexer  # includes incident.test.ts ΓÇö ~1 s (offline)
npx tsc --noEmit              # type-checks gating.mutation.test.ts ΓÇö ~3 s
```

Total added CI time: < 10 seconds.

**Excluded mutations (with rationale):**

| Excluded guard | Rationale |
|---|---|
| `MIN/MAX_ROUND_DEADLINE_LEDGERS` bounds | Removal creates an unusable circle (zero or multi-year window) but no direct financial theft path. Covered by boundary tests B3/B4 in `prop_tests.rs`. |
| `MAX_MEMBERS` bound | Removal allows expensive initialization but no financial shortcut. Covered by boundary test B5 in `prop_tests.rs`. |
| Status forward-only (no revert) | Tested exhaustively as invariant 4 in `prop_tests.rs` across random member counts and amounts. Duplicating it here would add CI time without new coverage. |
| `round_deadline_ledgers` stored as u64 (not truncated) | A u32 truncation would silently set a wrong deadline but is already caught by boundary tests B6a/B6b in `prop_tests.rs`. |

Any future change to a guard listed in either test file requires updating the corresponding mutation test or explicitly documenting why the guard is excluded. Guards not in the mutation test catalogue are considered lower-risk or already covered by property-based tests.

---

## Development Best Practices

**Contract changes**
- Run `cargo test` in `contracts/` before committing. All 15+ unit tests must pass.
- Use `stellar contract invoke --cost -- <function>` to estimate fees before broadcasting.
- Any change to `PENALTY_BPS`, `BPS_DENOM`, `COLLATERAL_MULTIPLIER`, `MIN/MAX_ROUND_DEADLINE_LEDGERS`, or `MAX_MEMBERS` is a breaking change ΓÇö update the README protocol constants table, the SDK constants file, and the app's gating logic.
- After changing contract entry-points, regenerate the TypeScript bindings if the SDK uses them, and update the type interfaces in `app/src/app/circles/[address]/CircleDetailClient.tsx`.

**Indexer changes**
- New event types require a new handler in `indexer/src/indexer.ts` and a migration adding any new columns or tables.
- API shape changes must be reflected in the TypeScript interfaces in the app (`CircleDetailClient.tsx`, `ReputationClient.tsx`).
- Always run `npm run migrate:check` in CI before deploying the indexer.

**App changes**
- Keep `"use client"` boundaries minimal. Data fetching belongs in Server Components; interactivity belongs in Client Components.
- When adding a new page route, export a `generateMetadata` function to provide a title and description ΓÇö all routes should have meaningful metadata.
- Run `npm run lint --workspace=app` and `npx tsc --noEmit` in `app/` before opening a PR.
- The `app/src/lib/gating.ts` action-eligibility logic is the single source of truth for which wallet actions are allowed given the current circle state. Update it ΓÇö not ad-hoc UI conditions ΓÇö when adding new state transitions.

**Testing**
- Rust: `cd contracts && cargo test` runs all unit, property-based, and mutation guard tests.
- TypeScript: `npm test --workspace=indexer` runs all indexer unit, integration, and incident reproduction tests.
- App gating mutation tests: `node --require ts-node/register --test app/src/lib/gating.mutation.test.ts`
- Incident reproduction (offline): `npm run test:incidents --workspace=indexer`
- Integration tests gated on `DATABASE_URL` are skipped automatically in CI environments without Postgres ΓÇö run them locally before landing schema changes.
- When modifying a financial guard in `contracts/circle/src/lib.rs` or `app/src/lib/gating.ts`, update the corresponding mutation guard test in `mutation_guards.rs` or `gating.mutation.test.ts`. If the guard is intentionally excluded from mutation testing, add a rationale to the [CI Budget and Excluded Mutations](#ci-budget-and-excluded-mutations) table.

**Branching and commits**
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): description`, `fix(scope): description`, etc.
- One feature or fix per PR. Keep PRs focused to make review tractable.
- Update `CHANGELOG.md` under `[Unreleased]` with every user-visible change.
- CI runs on every PR: TypeScript build (`tsc --noEmit`), Rust WASM compile (`cargo build --target wasm32-unknown-unknown`), and ESLint. All checks must pass before merging.
