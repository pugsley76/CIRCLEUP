# CircleUp — Public API Invariants & Contract Behaviors

This document is the authoritative reference for **observable invariants** that
the CircleUp system guarantees across all layers: Soroban contracts, the
TypeScript SDK, the indexer, and the REST API.  "Invariant" means a property
that is true before and after every operation — if an invariant is ever false
in production it is a bug.

See [`docs/EVENTS.md`](./EVENTS.md) for event shapes,
[`docs/RUNBOOK.md`](./RUNBOOK.md) for operational procedures.

---

## Table of contents

1. [Lifecycle state machine](#1-lifecycle-state-machine)
2. [Financial invariants](#2-financial-invariants)
3. [Membership and rotation invariants](#3-membership-and-rotation-invariants)
4. [Collateral invariants](#4-collateral-invariants)
5. [Round and payout invariants](#5-round-and-payout-invariants)
6. [Reputation invariants](#6-reputation-invariants)
7. [Factory invariants](#7-factory-invariants)
8. [Indexer invariants](#8-indexer-invariants)
9. [SDK type-safety invariants](#9-sdk-type-safety-invariants)
10. [Error-handling invariants](#10-error-handling-invariants)

---

## 1. Lifecycle state machine

A circle transitions through states strictly in one direction.  No state
transition is reversible.

```
Pending ──(all members joined)──▶ Active ──(all rounds done)──▶ Completed
   │                                                                  │
   └──(cancel called)──▶ Cancelled                                   │
                              │                                       │
                              └──(close called)──▶ Closed ◀──────────┘
```

**Invariants**

| # | Invariant | Enforced by |
|---|-----------|-------------|
| L1 | `Active` can only be reached from `Pending` | `join` guard: `status != Pending → panic` |
| L2 | `Completed` can only be reached from `Active` | `payout` guard writes `Completed` only after last round |
| L3 | `Cancelled` can only be reached from `Pending` | `cancel` guard: `status != Pending → panic` |
| L4 | `Closed` can only be reached from `Completed` or `Cancelled` | `close` guard checks status before running |
| L5 | A `Closed` circle can never transition again | `Closed` storage key is a re-invocation guard; `close` panics if set |
| L6 | `get_status` is always a valid `CircleStatus` variant | `assertValidCircleStatus` in SDK throws on unrecognised values |

---

## 2. Financial invariants

These govern USDC token flows into and out of the circle contract.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| F1 | `circle.balance = Σ(member.collateral) + Σ(unspent contributions)` at all times | `safe_transfer` rolls back on failure; CEI pattern throughout |
| F2 | No tokens are created or destroyed across a full lifecycle | `prop_balance_conservation_full_lifecycle` property test |
| F3 | A failed token transfer rolls back all state mutations in the same invocation | `safe_transfer` panics on any non-`Ok(Ok(()))` outcome |
| F4 | A payout never transfers more than `round_amount × member_count` | Pot computed once with `checked_mul`; overflow checked at `initialize` |
| F5 | `total_released ≤ total_expected_collateral` (penalties reduce released amount) | `close` sums actual stored collateral, not original |
| F6 | Collateral is zeroed *before* the transfer (CEI) | `Collateral` key set to 0 before `safe_transfer` in `close` |

---

## 3. Membership and rotation invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| M1 | The payout rotation order is fixed at `initialize` and never changes | `members` stored in `CircleConfig`; payout reads `members[round_index]` |
| M2 | Join order does not affect the payout rotation | `join` sets `Collateral(member)` key; rotation reads `Config.members` |
| M3 | `joined.join_order` reflects 1-based join-queue position, not member index | Counted as number of non-zero `Collateral` keys at join time |
| M4 | Each member address appears exactly once in `members` | `assert_unique_members` in both circle and factory contracts |
| M5 | `member_count` is in `[2, MAX_MEMBERS]` (currently `[2, 256]`) | `initialize` and `validate_create_inputs` enforce this range |
| M6 | A non-member address is always rejected by `join`, `contribute`, `mark_default` | `config.members.contains(&member)` guard in each entry-point |

---

## 4. Collateral invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| C1 | `collateral = round_amount × COLLATERAL_MULTIPLIER` at join time | Computed in `join` with `checked_mul` |
| C2 | A member cannot join twice (no double-collateral pull) | `has` check on `Collateral` key *before* transfer (CEI) |
| C3 | Collateral is never negative | `prop_collateral_never_negative` property test; penalty clamped |
| C4 | `penalty = round_amount × PENALTY_BPS / BPS_DENOM` (20% of round_amount) | Computed once in `mark_default` and `settle_round` |
| C5 | A member is marked default at most once per round | `Defaulted(member, round)` key checked before penalty |
| C6 | A contributing member cannot be penalised | `has(&Contributed(member, round))` guard in `mark_default` |
| C7 | Collateral storage key existence (not value > 0) is the join guard | Prevents re-join after collateral is zeroed by penalties |

---

## 5. Round and payout invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| R1 | `round_index` strictly increases; no double-payout | `paid_out` flag checked before pot transfer; rounds advance atomically |
| R2 | Payout requires **all** members to have contributed | `contributions_received == member_count` counter check |
| R3 | Payout also checks persisted `Contributed` keys (tally-mismatch guard) | `Contributed` key count checked against `member_count` |
| R4 | `RoundsCompleted` increments by exactly 1 per successful payout | `bump_rounds_completed` panics if `RoundsCompleted` key is absent |
| R5 | `mark_default` can only be called after the round deadline (`sequence > deadline_ledger`) | Strict `>` comparison (not `>=`) |
| R6 | `settle_round` requires `mark_default` for all non-contributors before running | Internal guard; settle panics if any member hasn't contributed and isn't defaulted |
| R7 | `round_amount × member_count` never overflows `i128` | `checked_mul` in `initialize` |

---

## 6. Reputation invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| P1 | Only factory-registered circles can call `reputation.increment` | `authorized_callers` allowlist in reputation contract |
| P2 | A reputation award failure rolls back the entire payout | `award_reputation` panics on any error; rolls back pot transfer |
| P3 | Score is monotonically non-decreasing | `increment` only adds; no decrement path in the contract |
| P4 | Exactly one reputation point is awarded per completed round | `award_reputation` called once per `payout` / `settle_round` |
| P5 | Revoking a circle's reputation rights is permanent for that round | `remove_authorized_caller` removes from allowlist; revoked circles earn no further points |

---

## 7. Factory invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| FA1 | `CircleCount` always equals `get_circles().len()` | Both written atomically in `create_circle` step 7 |
| FA2 | A failed `create_circle` never increments the counter or mutates the registry | Counter written only after deploy + init + register all succeed |
| FA3 | Circle addresses are deterministic given `(creator, count, ledger_sequence)` | `derive_circle_salt` mixes all three |
| FA4 | The factory is the reputation admin — no other address can register circles | `reputation.initialize(&factory_id)` wires this at deployment |
| FA5 | The `circle_created` event is emitted **after** registry writes commit | Emitted as last statement in `create_circle` |
| FA6 | `circle_created` data: `(circle_address, creator, circle_index)` — `circle_index` is the zero-based count *before* this create | Stable; see [`docs/EVENTS.md`](./EVENTS.md) for the canonical shape |

---

## 8. Indexer invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | Events are processed exactly once per (event_key) | `INSERT … ON CONFLICT DO NOTHING` on `ingested_events` |
| I2 | A bad event handler rolls back only its own writes | SAVEPOINT per event in `processLedger` |
| I3 | The ledger cursor advances only after all events in a ledger commit | Cursor update inside the same transaction as event writes |
| I4 | On restart the cursor is read from DB, not memory | `getLastLedger()` always queries `indexer_state` |
| I5 | `circle_members.join_order` reflects the on-chain join-queue position | Set from `parseJoinedEvent(event).joinOrder` in `handleCircleJoined` |
| I6 | `circle_members.collateral` reflects the amount locked at join time | Set from `parseJoinedEvent(event).collateral` in `handleCircleJoined` |
| I7 | `parseJoinedEvent` throws with a descriptive error on malformed payloads | Explicit type/range checks before DB write |

---

## 9. SDK type-safety invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| S1 | `validateCircleUpConfig` throws synchronously on misconfiguration | Called in `CircleUpClient` constructor |
| S2 | `decodeU32` / `decodeBigInt` / `decodeBoolean` / `decodeAddress` throw `TypeError` when the contract returns an unexpected wire type | Explicit type checks with call-site labels in error messages |
| S3 | `mapRawConfig` / `mapRawRoundState` throw on any missing or wrong-type field | Field-by-field decode through the `decode*` helpers |
| S4 | `assertValidCircleStatus` throws on any unrecognised status string | `valid.includes(value)` check |
| S5 | `validateContractArgs` returns a human-readable string (never throws) | Return-not-throw design for mutation call-sites |
| S6 | `sanitizeTxMetadata` strips secrets and payloads before they appear in logs | `SECRET_KEY_RE` + value-length + stellar-seed pattern checks |
| S7 | `TxResult` is a discriminated union — callers must check `success` before accessing `txHash` / `ledger` | TypeScript narrowing; `success: true` branch has non-optional `txHash` |
| S8 | `ReadResult<T>` is a discriminated union — callers must check `ok` before accessing `value` | TypeScript narrowing; `isReadSuccess` / `isReadFailure` type guards |

---

## 10. Error-handling invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| E1 | All mutating entry-points (`join`, `contribute`, `payout`, …) use `panic!` — the whole invocation rolls back | Soroban host: any panic reverts the transaction |
| E2 | All read-only views (`get_config`, `get_status`, …) use `contracterror` — callers receive a typed code | `ContractError` enum + `Result<T, ContractError>` return type |
| E3 | A panic message is always descriptive and includes the operation name | Every `panic!` / `unwrap_or_else` uses a context string |
| E4 | The reentrancy guard (`DataKey::Initializing`) is always cleared on success | Removed as last step before `circle/initialized` event in `initialize` |
| E5 | `RoundsCompleted` missing is a storage inconsistency, not a recoverable default | `unwrap_or_else(|| panic!("RoundsCompleted missing"))` |
| E6 | Indexer event parse errors surface at ingest time with the full context (contract, ledger, tx) | `ingestEventInTx` logs contract + ledger + txHash before re-throwing |

---

## Maintenance

When any of these invariants changes:

1. Update this document.
2. Update or add a test that would fail if the invariant were removed.
3. Update [`docs/EVENTS.md`](./EVENTS.md) if the change affects an event shape.
4. Add a `CHANGELOG.md` entry under the relevant version header.

The invariant table numbers (L1, F3, …) are stable references.  Cite them in
commit messages (`fixes F3 violation in settle_round`) and issue trackers so
reviewers can cross-check against this document.
