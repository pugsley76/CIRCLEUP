# 🔄 CircleUp

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar%20Soroban-7B2FBE?logo=stellar&logoColor=white)](https://stellar.org)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%2014-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![Rust](https://img.shields.io/badge/Contracts-Rust%20%2B%20Soroban-orange?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CODE_OF_CONDUCT.md)
> **The savings club a billion people already use — made trustless.**

CircleUp brings Rotating Savings & Credit Associations (ROSCAs) — known as **Ajo** in Nigeria, **Esusu** across West Africa, **Tanda** in Latin America, and **Chama** in Kenya — onto **Stellar Soroban**. The notebook-and-trust model is replaced by a tamper-proof smart contract: every member contributes each round, and the pot auto-pays the scheduled recipient. The organizer can never run off with the money.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Data Flow](#data-flow)
- [Quick Start](#quick-start)
- [SDK](#sdk)
- [Environment Variables](#environment-variables)
- [Contracts Reference](#contracts-reference)
- [Contract Invariants](#contract-invariants)
- [Gas and Storage Estimation](#gas-and-storage-estimation)
- [API Reference](#api-reference)
- [Demo Flow](#demo-flow)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)

---

## How It Works

```
1. Organizer creates a circle → sets members, $amount/round, rotation order, schedule
2. All members lock collateral (1× round amount) to join
3. Each round: every member contributes → contract holds the pot
4. Contract auto-pays the scheduled recipient (no intermediary)
5. Miss a round → 20% collateral penalty + default flag on your record
6. Complete a full circle → your on-chain reputation score increments
```

**Example:** 4 members, $100/round, monthly schedule

| Round | Pot    | Recipient |
|-------|--------|-----------|
| 1     | $400   | Alice     |
| 2     | $400   | Bob       |
| 3     | $400   | Carol     |
| 4     | $400   | Dave      |

Each member contributes $400 total, receives $400 once. Zero interest. Zero trust required.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Stellar Testnet                          │
│                                                              │
│  ┌──────────────────┐   deploys   ┌────────────────────┐    │
│  │  circle_factory  │────────────▶│  circle (instance) │    │
│  └──────────────────┘             └────────────────────┘    │
│           │                               │                  │
│     registers                       calls increment          │
│           │                               │                  │
│           ▼                               ▼                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   reputation                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         ▲ events                              ▲ RPC calls
         │                                     │
┌────────┴──────────┐               ┌──────────┴──────────┐
│      indexer      │               │       sdk            │
│  Node + Postgres  │               │   TypeScript client  │
│  REST API :3001   │               └─────────────────────┘
└────────┬──────────┘                         ▲
         │ HTTP                               │ imports
         ▼                                   │
┌──────────────────────────────────────────────────────────┐
│                     app (Next.js 14)                      │
│   /          → circle list (reads indexer)                │
│   /create    → deploy circle (calls contract via sdk)     │
│   /circles/[addr] → detail, contribute, payout actions    │
│   /reputation/[member] → score + history                  │
└──────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
circleup/
│
├── contracts/                  # Soroban smart contracts (Rust)
│   ├── Cargo.toml              # Workspace root
│   ├── circle_factory/         # Deploys + registers circle instances
│   │   └── src/lib.rs
│   ├── circle/                 # Core ROSCA logic
│   │   └── src/
│   │       ├── lib.rs          # Contract: join, contribute, payout, mark_default, close
│   │       └── tests.rs        # 15 unit tests
│   └── reputation/             # On-chain score per wallet
│       └── src/lib.rs
│
├── sdk/                        # TypeScript SDK (@circleup/sdk)
│   └── src/
│       ├── index.ts            # Public exports
│       ├── client.ts           # FactoryClient, CircleClient, ReputationClient
│       ├── types.ts            # Shared TypeScript types
│       ├── utils.ts            # stroopsToUsdc, daysToLedgers, etc.
│       └── constants.ts        # Network passphrases, RPC URLs, USDC decimals
│
├── indexer/                    # Event indexer + REST API (@circleup/indexer)
│   └── src/
│       ├── index.ts            # Entry point: boots API + indexer
│       ├── api.ts              # Express REST API
│       ├── indexer.ts          # Soroban event polling loop
│       └── db/
│           ├── pool.ts         # Postgres connection pool
│           ├── migrate.ts      # Schema migration runner
│           └── schema.sql      # Full DB schema
│
├── app/                        # Next.js 14 frontend (@circleup/app)
│   └── src/
│       ├── app/                # App Router pages
│       │   ├── page.tsx        # / — circle list
│       │   ├── create/         # /create — new circle form
│       │   ├── circles/[address]/ # circle detail + actions
│       │   └── reputation/[member]/ # member reputation page
│       ├── components/         # Reusable React components
│       │   ├── CircleCard.tsx
│       │   ├── WalletButton.tsx
│       │   └── ReputationBadge.tsx
│       └── lib/
│           ├── config.ts       # Env var accessors + USDC helpers
│           └── stellar.ts      # Soroban RPC + Freighter integration
│
├── scripts/                    # Deployment + demo scripts (@circleup/scripts)
│   └── src/
│       ├── deploy.ts           # Build + deploy all contracts to testnet
│       └── seed-demo.ts        # Seed a 4-member $100/round demo circle
│
├── docker-compose.yml          # Local Postgres for the indexer
├── package.json                # npm workspaces root
├── CHANGELOG.md
└── README.md
```

---

## Data Flow

### Creating a circle
```
User (browser)
  → /create page (Next.js)
  → invokeContract("create_circle", ...) via stellar.ts
  → Freighter signs the tx
  → circle_factory.create_circle() deploys a new circle contract
  → Event: factory/circle_created
  → indexer picks up event → writes to circles table
  → /circles page fetches from indexer REST API
```

### Contributing & payout
```
Member clicks "Contribute"
  → contribute() call → contract holds tokens
  → Once all members contribute → anyone calls payout()
  → Contract transfers pot to recipient
  → Calls reputation.increment(recipient)
  → Events: circle/contributed, circle/payout, reputation/increment
  → indexer updates contributions, payouts, reputation tables
```

### Default
```
Round deadline passes, member hasn't contributed
  → Anyone calls mark_default(member)
  → 20% collateral penalty applied on-chain
  → Event: circle/default
  → indexer records in defaults table, increments member default count
```

---

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 18 | Frontend + indexer + scripts |
| Rust | stable | Compile Soroban contracts |
| stellar-cli | latest | Deploy contracts to testnet |
| Docker | any | Local Postgres via docker compose |
| Freighter | browser ext | Wallet for the web app |

Install stellar-cli:
```bash
cargo install --locked stellar-cli --features opt
```

### 1. Clone and install dependencies

```bash
git clone https://github.com/your-org/circleup
cd circleup
npm install
```

### 2. Build and deploy contracts

```bash
# Generate a testnet deployer identity
stellar keys generate --global deployer --network testnet
stellar keys fund deployer --network testnet

# Deploy all three contracts (reputation → circle_factory → circle WASM hash)
npm run deploy:testnet
# Writes contract addresses to scripts/deployed.json
```

### 3. Configure environment variables

```bash
# Indexer
cp indexer/.env.example indexer/.env
# Paste the addresses from scripts/deployed.json into indexer/.env

# App
cp app/.env.example app/.env.local
# Paste the same addresses with NEXT_PUBLIC_ prefix
```

### 4. Start Postgres

```bash
docker compose up -d
npm run migrate
```

### 5. Start the indexer

```bash
npm run dev:indexer
# Listening on http://localhost:3001
```

### 6. Start the frontend

```bash
npm run dev:app
# Open http://localhost:3000
```

### 7. Seed the demo circle

```bash
npm run seed:demo
# Creates a 4-member $100/round testnet circle
# Runs Round 1 (all contribute → Alice receives $400)
# Shows Round 2 default for Dave
```

---

## SDK

`@circleup/sdk` is the TypeScript client for interacting with CircleUp contracts and the indexer REST API. It is consumed by the `app` and `scripts` packages and can also be used in any Node.js or browser environment.

### Installation

```bash
npm install @circleup/sdk
```

> The SDK is published from the `sdk/` workspace. If you are working inside this monorepo it is already available via npm workspaces — no separate install needed.

### Network configuration

Use `getNetworkConfig` to get a fully typed config object for a given network instead of hard-coding URLs and passphrases:

```ts
import { getNetworkConfig, isValidNetwork } from "@circleup/sdk";

// Validate an environment variable before use
const raw = process.env.NETWORK ?? "testnet";
if (!isValidNetwork(raw)) {
  throw new Error(`Invalid NETWORK value: "${raw}". Must be "testnet" or "mainnet".`);
}

const net = getNetworkConfig(raw);
// net.rpcUrl         — Soroban RPC endpoint
// net.passphrase     — network passphrase for transaction signing
// net.friendbotUrl   — Friendbot URL (null on mainnet)
```

### Creating a `CircleUpConfig`

All SDK clients take a `CircleUpConfig`. The constructor validates every field at construction time and throws a descriptive error for any missing or malformed value.

```ts
import { getNetworkConfig } from "@circleup/sdk";
import type { CircleUpConfig } from "@circleup/sdk";

const net = getNetworkConfig("testnet");

const config: CircleUpConfig = {
  rpcUrl: net.rpcUrl,
  networkPassphrase: net.passphrase,
  contracts: {
    circleFactory: "CCIRCLE_FACTORY_ADDRESS",
    reputation:    "CREPUTATION_ADDRESS",
    usdc:          "CUSDC_ADDRESS",
  },
};
```

### `FactoryClient` — deploy and list circles

```ts
import { FactoryClient } from "@circleup/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { usdcToStroops } from "@circleup/sdk";

const factory = new FactoryClient(config);

// List all deployed circles
const addresses = await factory.getCircles();
console.log(`${addresses.length} circles on-chain`);

// Deploy a new circle
const creator = Keypair.fromSecret("S...");
const { result } = await factory.createCircle({
  creator,
  members: [
    "GALICE...",
    "GBOB...",
    "GCAROL...",
    "GDAVE...",
  ],
  roundAmountStroops: usdcToStroops("100"), // 100 USDC
  roundDeadlineLedgers: 17_280,             // ~1 day
});

if (!result.success) {
  console.error("Circle creation failed:", result.error);
} else {
  console.log("Deployed at ledger", result.ledger, "tx:", result.txHash);
}
```

### `CircleClient` — join, contribute, payout

```ts
import { CircleClient } from "@circleup/sdk";

const circle = new CircleClient(config, "CCIRCLE_ADDRESS");

// Read current state
const { status, currentRound, config: circleConfig } = await circle.getFullState();
console.log("Status:", status);
console.log("Round:", currentRound.roundIndex, "→ recipient:", currentRound.recipient);

// Member joins (locks collateral)
const memberKeypair = Keypair.fromSecret("S...");
const joinResult = await circle.join(memberKeypair);

// Member contributes for the current round
const contributeResult = await circle.contribute(memberKeypair);

// Trigger payout once all members have contributed
const payoutResult = await circle.payout(memberKeypair);

// Mark a defaulted member after the deadline
const defaultResult = await circle.markDefault(memberKeypair, "GDAVE...");
```

### `ReputationClient` — read on-chain scores

```ts
import { ReputationClient } from "@circleup/sdk";

const rep = new ReputationClient(config);
const score = await rep.getScore("GALICE...");
console.log("Alice's reputation score:", score);
```

### `IndexerClient` — paged history and filters

List methods return **one page** and keep the server's `pagination` metadata.
The `iterate*` helpers walk pages for you and stop after `maxPages` (default 10),
so nothing fetches an unbounded result set by default.

```ts
import { IndexerClient, INDEXER_MAX_PAGE_SIZE } from "@circleup/sdk";

const indexer = new IndexerClient({ ...config, indexerUrl: "http://localhost:3001" });

// One page: rows + { page, limit, total, totalPages }
const { circles, pagination } = await indexer.getCircles({ status: "Active", page: 2, limit: 50 });

// Every page, bounded
for await (const page of indexer.iterateCircles({ limit: INDEXER_MAX_PAGE_SIZE }, { maxPages: 5 })) {
  render(page.circles);
}
```

Invalid options (an unknown key, `limit` outside 1–100, an unsupported `status`
or `sort`, a `circle` filter that is not an address) reject with a `RangeError`
before any request is sent. A response whose page envelope is missing or does
not match the request throws `IndexerError`.

### Recovering from a failed write

Every write resolves to a `TxResult`. Only resubmit when `isRetryable(result)`
says so. `outcome_unknown`, `timeout`, and `stale_rpc` mean the write may
already be applied, so look the original hash up first. The SDK never rebuilds
a write on its own.

```ts
import { isTxFailure, isRetryable } from "@circleup/sdk";

const result = await circle.contribute(keypair);
if (isTxFailure(result) && !isRetryable(result)) {
  const hash = result.diagnostics?.txHash ?? result.txHash;
  const lookup = hash ? await circle.lookupTransaction(hash) : null;
  // lookup.value.status: "success" | "failed" | "not_found"
}
```

### Utility helpers

```ts
import {
  usdcToStroops,   // "10.50"  → 105_000_000n
  stroopsToUsdc,   // 105_000_000n → "10.5"
  formatUsdc,      // 105_000_000n → "10.50"  (always 2 dp, for display)
  formatPot,       // (roundAmount, memberCount) → "42.00"
  daysToLedgers,   // 7  → 120_960
  ledgersToDays,   // 120_960 → 7
  shortAddress,    // "GCEZ…GZBL"
} from "@circleup/sdk";

// Safe conversions — both functions are robust to bad input
usdcToStroops("1.5");          // → 15_000_000n
stroopsToUsdc(15_000_000n);    // → "1.5"
stroopsToUsdc("not-a-number"); // → "0"  (never throws in render paths)

formatUsdc(15_000_000n);       // → "1.50"
formatPot("10000000", 4);      // → "4.00"
```

### Error handling conventions

- `usdcToStroops` throws `TypeError` for invalid or out-of-range input — validate before calling if the value comes from untrusted input.
- `stroopsToUsdc`, `formatUsdc`, and `formatPot` return `"0"` / `"0.00"` on bad input so they are safe to call in render paths without a try/catch.
- All SDK clients throw synchronously from the constructor when `CircleUpConfig` is invalid, so misconfiguration surfaces early rather than as an obscure RPC error at call time.
- `getNetworkConfig` throws `Error` for unrecognised network names; use `isValidNetwork` to guard before calling it.
- Contract reads throw (or return `ok: false` from the `*Result` variants) when the RPC returns a value of the wrong type, is missing a field, or is out of range. The message names the method or field (e.g. `mapRawConfig.round_amount`), so a contract that has drifted fails at the boundary instead of producing a value that only looks valid.
- Import everything from `@circleup/sdk`. Deep paths such as `@circleup/sdk/dist/client` are blocked by the package `exports` map and are not part of the stable API.

---

## Environment Variables

### `indexer/.env`

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | `postgresql://postgres:password@localhost:5432/circleup` |
| `STELLAR_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | `Test SDF Network ; September 2015` |
| `CIRCLE_FACTORY_ADDRESS` | Deployed factory contract ID | `C...` |
| `REPUTATION_ADDRESS` | Deployed reputation contract ID | `C...` |
| `USDC_ADDRESS` | USDC token contract ID | `C...` |
| `PORT` | API server port | `3001` |
| `START_LEDGER` | Ledger to start indexing from | `0` |

### `app/.env.local`

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Soroban RPC endpoint |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Network passphrase |
| `NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS` | Factory contract ID |
| `NEXT_PUBLIC_REPUTATION_ADDRESS` | Reputation contract ID |
| `NEXT_PUBLIC_USDC_ADDRESS` | USDC contract ID |
| `NEXT_PUBLIC_INDEXER_URL` | Indexer base URL (default: `http://localhost:3001`) |

---

## Contracts Reference

### `circle_factory`

| Function | Auth | Parameters | Returns | Description |
|----------|------|-----------|---------|-------------|
| `initialize` | admin | `admin, circle_wasm_hash, reputation_contract, usdc_token` | — | One-time setup; rejects re-initialization |
| `create_circle` | creator | `creator, members[], round_amount, round_deadline_ledgers` | `Address` | Deploy + initialize a new circle in one tx; emits `factory/circle_created` |
| `get_circles` | — | — | `Vec<Address>` | List all deployed circle addresses in creation order |
| `get_circle_count` | — | — | `u32` | Total number of deployed circles |
| `get_admin` | — | — | `Address` | Factory admin; panics if not initialized |
| `get_usdc_token` | — | — | `Address` | USDC token configured at initialize; panics if not initialized |

### `circle`

| Function | Auth | Parameters | Returns | Description |
|----------|------|-----------|---------|-------------|
| `initialize` | factory | `members[], round_amount, usdc_token, reputation_contract, round_deadline_ledgers` | — | One-time setup; locked by reentrancy guard |
| `join` | member | `member` | — | Lock collateral (1× round_amount); emits `circle/joined` with `(member, order)` |
| `contribute` | member | `member` | — | Deposit round contribution; rejected after deadline |
| `payout` | anyone | — | — | Transfer pot to current round's recipient once all members have contributed |
| `mark_default` | anyone | `member` | — | Flag + penalize a member who missed the round deadline (20% collateral penalty) |
| `cancel` | member | `caller` | — | Cancel a `Pending` circle before it goes `Active` |
| `close` | member | `closer` | — | Release remaining collateral to all members; only callable when `Completed` or `Cancelled` |
| `get_protocol_params` | — | — | `ProtocolParams` | All tunable constants in one struct; works before `initialize` |
| `get_config` | — | — | `Result<CircleConfig, ContractError>` | Full circle configuration; returns `NotInitialized` error before init |
| `get_status` | — | — | `CircleStatus` | `Pending / Active / Completed / Cancelled`; panics before init |
| `get_current_round` | — | — | `Result<RoundState, ContractError>` | Active round state; returns `CircleNotActive` when `Completed` or `Cancelled` |
| `get_collateral` | — | `member` | `i128` | Member's locked collateral balance (0 if not joined) |
| `get_defaults` | — | `member` | `u32` | Member's missed-contribution count (0 if none) |
| `has_contributed` | — | `member, round_index` | `bool` | Whether a member contributed in a given round |

### `reputation`

| Function | Auth | Parameters | Returns | Description |
|----------|------|-----------|---------|-------------|
| `initialize` | deployer | `admin` | — | One-time setup; rejects re-initialization |
| `increment` | member | `member` | — | Add 1 completed-round to the member's score; emits `reputation/increment` |
| `score` | anyone | `member` | `u32` | Read a wallet's completed-rounds score (0 if none) |

### Protocol constants

All financial parameters that govern on-chain behaviour are defined as named public constants in `contracts/circle/src/lib.rs` and surfaced through the `get_protocol_params` view so clients stay in sync without hard-coding values.

| Constant | Value | Meaning |
|----------|-------|---------|
| `PENALTY_BPS` | 2 000 | Collateral penalty per missed round (basis points; 2 000 bp = 20 %) |
| `BPS_DENOM` | 10 000 | Denominator for all basis-point calculations |
| `COLLATERAL_MULTIPLIER` | 1 | Collateral = `round_amount × COLLATERAL_MULTIPLIER` |
| `MIN_ROUND_DEADLINE_LEDGERS` | 100 | Minimum deadline (~8 min at 5 s/ledger) |
| `MAX_ROUND_DEADLINE_LEDGERS` | 1 036 800 | Maximum deadline (~60 days at 5 s/ledger) |
| `MAX_MEMBERS` | 256 | Maximum members per circle |

Read the live values at any time:

```ts
const params = await circle.simulateAndReadOrThrow("get_protocol_params", []);
console.log(`Penalty: ${params.penalty_bps / params.bps_denom * 100}%`);
// → "Penalty: 20%"
```

---

## Contract Invariants

The following invariants are enforced by the contract at all times. They are expressed as preconditions, postconditions, and state constraints so integrators can reason about the system without reading the full contract source.

### `circle` lifecycle invariants

**Status transitions are one-way and irreversible:**

```
Pending ──(all joined)──▶ Active ──(all rounds done)──▶ Completed
Pending ──(cancel)──────▶ Cancelled
```

- `Active`, `Completed`, and `Cancelled` are terminal states that cannot revert.
- Once `Active`, the circle cannot be cancelled.

**Collateral invariant:**

- `collateral(member) = round_amount × COLLATERAL_MULTIPLIER` after a successful `join`, before any `mark_default` calls.
- `collateral(member)` decreases by `collateral × PENALTY_BPS / BPS_DENOM` per `mark_default` call and never goes negative.
- `collateral(member) = 0` for all members after a successful `close`.
- The `Collateral` storage key existing (even with value 0) means the member has joined and cannot join again.

**Round invariants:**

- `round.round_index` is monotonically increasing; never decrements.
- `round.recipient = config.members[round.round_index]` — the recipient is always the member at the current round's index in the configured member list.
- `round.contributions_received` equals the count of `Contributed(member, round_index)` persistent keys that exist for the current round.
- `payout` may only execute when `contributions_received == config.members.len()` **and** the on-chain persistent records confirm the same count (double-checked tally).
- After `payout`, `rounds_completed` increments by 1. When `rounds_completed == config.members.len()` the status transitions to `Completed`.

**Deadline invariant:**

- `contribute` is accepted only while `ledger.sequence <= round.deadline_ledger`.
- `mark_default` is accepted only while `ledger.sequence > round.deadline_ledger`.
- The boundary is strict on both sides — the deadline ledger itself rejects contributions and also rejects defaults (only `> deadline_ledger` triggers the default window).

**Reentrancy / initialization guard:**

- `initialize` sets an `Initializing` flag as its very first storage write and removes it as its last, so any reentrant call during initialization is rejected with `"initialize already in progress"`.
- `join` writes the `Collateral` key before performing the token transfer (checks-effects-interactions pattern), preventing a reentrant `join` call during the token transfer from double-depositing collateral.

### `circle` event invariants

Every state-changing entry-point emits at least one event. The table below is the authoritative event catalogue; indexers and front-ends should treat any deviation as a contract regression.

| Event | Topics | Data | When emitted |
|-------|--------|------|-------------|
| `circle/initialized` | `("circle", "initialized")` | `u32` (member count) | End of `initialize` |
| `circle/joined` | `("circle", "joined")` | `(Address, u32)` — member + 1-based join order | End of every successful `join` |
| `circle/active` | `("circle", "active")` | `()` | When the last member joins and circle transitions to `Active` |
| `circle/contributed` | `("circle", "contributed")` | `(Address, u32)` — member + round index | End of every successful `contribute` |
| `circle/payout` | `("circle", "payout")` | `(Address, i128, u32)` — recipient + pot + round index | End of every successful `payout` |
| `circle/round_started` | `("circle", "round_started")` | `(u32, Address, u64)` — round index + recipient + deadline ledger | After each non-final `payout` (rounds 0 … N−2) |
| `circle/completed` | `("circle", "completed")` | `()` | After the final `payout` |
| `circle/default` | `("circle", "default")` | `(Address, i128, u32, i128)` — member + penalty + round index + new collateral | End of every successful `mark_default` |
| `circle/cancelled` | `("circle", "cancelled")` | `(Address, u32)` — caller + ledger sequence | End of `cancel` |
| `circle/collateral_released` | `("circle", "collateral_released")` | `(Address, i128)` — member + amount | Once per member with non-zero collateral during `close` |
| `circle/closed` | `("circle", "closed")` | `(Address, i128, u32, Symbol)` — closer + total released + ledger + reason ("completed"\|"cancelled") | End of `close` |

### `circle_factory` event invariants

| Event | Topics | Data | When emitted |
|-------|--------|------|-------------|
| `factory/circle_created` | `("factory", "circle_created")` | `(Address, Address, u32)` — circle address + creator + circle index | End of `create_circle` |

### `reputation` event invariants

| Event | Topics | Data | When emitted |
|-------|--------|------|-------------|
| `reputation/increment` | `("reputation", "increment")` | `u32` — new score | End of `increment` |

### Error codes (`circle` contract)

Read-only views return typed errors instead of panicking so callers can handle them gracefully.

| Code | Name | Meaning |
|------|------|---------|
| 1 | `NotInitialized` | `get_config` was called before `initialize` |
| 2 | `CircleNotActive` | `get_current_round` was called when status is `Completed` or `Cancelled` |

Mutating entry-points (`initialize`, `join`, `contribute`, …) panic with a descriptive message that propagates back to the caller via the simulation result. Example messages:

| Panic message | Entry-point | Cause |
|--------------|-------------|-------|
| `"already initialized"` | `initialize` | Called more than once |
| `"circle not accepting members"` | `join` | Status is not `Pending` |
| `"already joined"` | `join` | `Collateral` key already exists for this member |
| `"not a circle member"` | `join`, `contribute`, `cancel` | Address not in configured member list |
| `"circle is not active"` | `contribute`, `payout`, `mark_default` | Status is not `Active` |
| `"already contributed this round"` | `contribute` | Duplicate contribution in same round |
| `"round deadline passed; cannot contribute before payout"` | `contribute` | `ledger.sequence > deadline_ledger` |
| `"not all members have contributed yet"` | `payout` | `contributions_received < member_count` |
| `"round deadline not yet passed"` | `mark_default` | `ledger.sequence <= deadline_ledger` |
| `"already marked default this round"` | `mark_default` | Member already flagged for current round |
| `"member did contribute"` | `mark_default` | `Contributed(member, round)` key exists |
| `"can only cancel a pending circle"` | `cancel` | Status is not `Pending` |
| `"circle still active"` | `close` | Status is not `Completed` or `Cancelled` |
| `"USDC transfer failed during {context}"` | `join`, `contribute`, `payout`, `close` | Token transfer rejected (balance, trustline, or auth) |

---

## Gas and Storage Estimation

Soroban charges separately for **compute** (CPU instructions) and **storage** (bytes written/extended). Understanding both is important before broadcasting transactions with real funds.

### Fee anatomy

A Soroban transaction fee has two parts:

| Part | How it's determined |
|------|---------------------|
| Base inclusion fee | Passed in `TransactionBuilder` (`BASE_FEE` = 100 stroops) |
| Resource fee | Returned by `simulate_transaction` as `min_resource_fee`; covers CPU, read/write bytes, and ledger entry rentals |

Always use the resource fee from the simulation response rather than hard-coding a value:

```ts
import {
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const sim = await rpc.simulateTransaction(tx);
if (SorobanRpc.Api.isSimulationError(sim)) {
  throw new Error(sim.error);
}
// min_resource_fee is in stroops; it must be paid on top of BASE_FEE
console.log("Resource fee:", sim.minResourceFee, "stroops");

const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
```

`assembleTransaction` automatically merges the footprint, auth entries, and resource fee into the transaction so the prepared transaction is ready to sign.

### Dry-run with stellar-cli

For a quick cost estimate without writing code, use `stellar-cli contract invoke --cost`:

```bash
# Estimate the cost of a join call (--cost suppresses the actual broadcast)
stellar contract invoke \
  --id <CIRCLE_CONTRACT_ID> \
  --source-account <YOUR_KEY_NAME> \
  --network testnet \
  --cost \
  -- join \
  --member <MEMBER_ADDRESS>
```

The output includes `instructions`, `read_bytes`, `write_bytes`, and the computed `min_resource_fee`. The `--cost` flag is safe — it simulates only and never submits.

### Storage budget per entry-point

Soroban charges a rent fee for every ledger entry created or extended. The table below shows the new storage entries created by each `circle` contract call so you can budget accordingly.

| Entry-point | New entries | Type | Notes |
|-------------|-------------|------|-------|
| `initialize` | 4 | Instance | `Config`, `Status`, `RoundsCompleted`, `CurrentRound` |
| `join` | 1 per member | Persistent | `Collateral(member)`; last join also writes `Status` + `CurrentRound` (instance) |
| `contribute` | 1 | Persistent | `Contributed(member, round_index)` |
| `payout` | 0 | — | Updates `CurrentRound` + `RoundsCompleted` (instance) only |
| `mark_default` | 2 | Persistent | `Defaulted(member, round)`, `Defaults(member)` |
| `close` | 0 | — | Writes `Collateral(member)` = 0 for each member; no new entries |

Persistent entries have a TTL (time-to-live) that must be extended periodically or the entry is archived. The SDK's `simulateTransaction` call will include the minimum TTL extension in the footprint automatically.

### Typical fee ranges (Stellar testnet, July 2025)

These are approximate ranges observed in practice. Actual fees depend on ledger load.

| Operation | Approximate resource fee |
|-----------|--------------------------|
| `initialize` | 60 000 – 90 000 stroops |
| `join` | 30 000 – 50 000 stroops |
| `contribute` | 25 000 – 40 000 stroops |
| `payout` (4 members) | 80 000 – 130 000 stroops |
| `mark_default` | 25 000 – 45 000 stroops |
| `close` (4 members) | 60 000 – 100 000 stroops |

At 10 000 000 stroops per XLM these fees are fractions of a cent at current prices. Always rely on `simulate_transaction` for exact values before broadcasting.

---

## API Reference

Base URL: `http://localhost:3001`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health check |
| `GET` | `/circles` | List all circles (sorted by creation) |
| `GET` | `/circles/:address` | Circle detail + members |
| `GET` | `/circles/:address/members` | Members with reputation and contribution counts |
| `GET` | `/circles/:address/rounds` | Round history: payouts, contributions, defaults |
| `GET` | `/reputation/:member` | Wallet reputation score + participation history |

---

## Demo Flow

```
Step 1: Create circle
  → 4 members (Alice, Bob, Carol, Dave), $100/round, monthly

Step 2: Round 1 — all contribute
  Alice   contributes $100  ✅
  Bob     contributes $100  ✅
  Carol   contributes $100  ✅
  Dave    contributes $100  ✅
  → Contract pays $400 to Alice
  → Alice's reputation: 0 → 1 🏆

Step 3: Round 2 — Dave misses
  Alice   contributes $100  ✅
  Bob     contributes $100  ✅
  Carol   contributes $100  ✅
  Dave    MISSED             ❌
  → mark_default(Dave) called after deadline
  → Dave's collateral: $100 → $80 (20% penalty)
  → Dave's default count: 0 → 1 ⚠️

Step 4: Explorer
  → https://stellar.expert/explorer/testnet/contract/<circle_address>
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contracts | Rust, Soroban SDK 21, WASM |
| Blockchain | Stellar Testnet (Soroban RPC) |
| Wallet | Freighter browser extension |
| SDK | TypeScript, @stellar/stellar-sdk 12 |
| Indexer | Node.js, Express, PostgreSQL, ts-node-dev |
| Frontend | Next.js 14 (App Router), Tailwind CSS, React 18 |
| Inf.ra | Docker Compose (Postgres), npm workspaces |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes, run tests
4. For contract changes: `cargo test` in `contracts/`
5. For TS changes: `npx tsc --noEmit` in the relevant package
6. To estimate fees for a new contract entry-point: `stellar contract invoke --cost` (see [Gas and Storage Estimation](#gas-and-storage-estimation))
7. Submit a pull request

---

## License

MIT © CircleUp Contributors
r3tkl
<!-- Verified for issue #624: feat(indexer): add explicit health, outage, and diagnostic states to indexer API -->
