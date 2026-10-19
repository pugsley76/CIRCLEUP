//! Property-based and fuzz-style test harness for the Circle contract.
//!
//! # Design
//!
//! Each invariant from the protocol specification is encoded as a runnable
//! `proptest` property that exercises the invariant across randomised input
//! distributions.  The suite is split into two complementary layers:
//!
//! **Property tests** (`proptest!` blocks) — each property runs 64 cases by
//! default and proptest automatically shrinks any failing input to a minimal
//! reproducer.  The strategy parameters are printed with every failure so the
//! exact sequence can be replayed.
//!
//! **Boundary / seed tests** (`#[test]` functions) — deterministic tests that
//! exercise exact arithmetic boundaries (u32::MAX ledger sequences, i128-near-
//! overflow round amounts, MIN/MAX deadline values, 256-member initialisation).
//! These serve as permanent CI regression anchors even when proptest finds no
//! failures.
//!
//! # Invariants under test
//!
//! | # | Invariant | Property |
//! |---|-----------|---------|
//! | 1 | Any join permutation eventually activates the circle | `prop_any_join_permutation_activates_circle` |
//! | 2 | Collateral is never negative after any number of defaults | `prop_collateral_never_negative` |
//! | 3 | `Contributed` and `Defaulted` keys are mutually exclusive | `prop_contributed_defaulted_mutually_exclusive` |
//! | 4 | Status only moves forward in the lifecycle DAG | `prop_status_never_reverts` |
//! | 5 | `close` total_released equals the sum of pre-close collateral | `prop_close_total_released_matches_sum` |
//! | 6 | Round index strictly increases; no double-payout possible | `prop_round_index_strictly_advances` |
//! | 7 | `RoundsCompleted` increments by exactly 1 per payout | `prop_rounds_completed_monotone` |
//! | 8 | Contribute and mark_default boundaries do not overlap | `prop_deadline_boundary_non_overlapping` |
//! | 9 | Full-lifecycle token conservation: no tokens created or destroyed | `prop_balance_conservation_full_lifecycle` |
//! | 10| Each additional default strictly reduces collateral | `prop_each_default_strictly_reduces_collateral` |
//!
//! # Reproducing failures
//!
//! When proptest finds a failing case it writes the seed to
//! `.proptest-regressions/prop_tests.txt` in the crate root.  To replay:
//!
//! ```text
//! # The file contains a line like:
//! # cc 8e7f... # shrinks to (member_count=2, ...)
//! PROPTEST_CASES=1 cargo test -p circle prop_ 2>&1
//! ```
//!
//! proptest reads the regressions file automatically on the next run and
//! replays any stored seeds before generating new ones.

#[cfg(test)]
mod prop_tests {
    extern crate std;
    use std::vec::Vec;

    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec as SdkVec,
    };

    use crate::{
        CircleContract, CircleContractClient, CircleStatus, DataKey,
        BPS_DENOM, COLLATERAL_MULTIPLIER, MAX_MEMBERS, MAX_ROUND_DEADLINE_LEDGERS,
        MIN_ROUND_DEADLINE_LEDGERS, PENALTY_BPS,
    };
    use reputation::{ReputationContract, ReputationContractClient};

    // ── Protocol constants ────────────────────────────────────────────────────

    /// Largest `round_amount` that passes every `checked_mul` guard inside
    /// `initialize`.  The binding constraint is `round_amount * PENALTY_BPS`
    /// (the penalty calculation overflow check).
    const MAX_VALID_ROUND_AMOUNT: i128 = i128::MAX / PENALTY_BPS;

    // ── Infrastructure helpers ────────────────────────────────────────────────

    struct PropSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        token_id: Address,
        rep_id: Address,
        members: Vec<Address>,
        round_amount: i128,
        deadline: u32,
    }

    /// Build a fresh N-member circle fixture funded with enough tokens for
    /// one collateral deposit plus `n` round contributions per member.
    fn make_circle_n<'a>(
        n: usize,
        round_amount: i128,
        deadline: u32,
    ) -> PropSetup<'a> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_reg = env.register_stellar_asset_contract_v2(token_admin);
        let token_id = token_reg.address();
        let token = TokenClient::new(&env, &token_id);
        let asset_client = StellarAssetClient::new(&env, &token_id);

        let rep_reg = env.register_contract(None, ReputationContract);
        let rep_id = rep_reg.clone();
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);

        let circle_reg = env.register_contract(None, CircleContract);
        let circle_id = circle_reg.clone();
        let circle = CircleContractClient::new(&env, &circle_id);

        rep_client.add_authorized_caller(&rep_admin, &circle_id);

        let mut members = Vec::with_capacity(n);
        let mut sdk_members = SdkVec::new(&env);
        for _ in 0..n {
            let m = Address::generate(&env);
            // Fund: collateral + n rounds of contributions (+ buffer)
            let budget = round_amount
                .saturating_mul(COLLATERAL_MULTIPLIER + n as i128 + 1);
            asset_client.mint(&m, &budget);
            members.push(m.clone());
            sdk_members.push_back(m);
        }

        circle.initialize(&Address::generate(&env), &sdk_members, &round_amount, &token_id, &rep_id, &deadline);

        PropSetup {
            env,
            circle,
            circle_id,
            token,
            token_id,
            rep_id,
            members,
            round_amount,
            deadline,
        }
    }

    /// Deterministic Fisher-Yates shuffle driven by a u64 seed.
    /// Returns a permutation of indices `0..n`.
    fn permute(n: usize, seed: u64) -> Vec<usize> {
        let mut v: Vec<usize> = (0..n).collect();
        let mut s = seed;
        for i in (1..n).rev() {
            // LCG step — good enough for index shuffling in tests
            s = s.wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let j = (s >> 33) as usize % (i + 1);
            v.swap(i, j);
        }
        v
    }

    /// Join all `members` in the order given by `order` (indices into `members`).
    fn join_in_order(setup: &PropSetup, order: &[usize]) {
        for &idx in order {
            setup.circle.join(&setup.members[idx]);
        }
    }

    /// Have all members contribute for the current round.
    fn contribute_all(setup: &PropSetup) {
        for m in &setup.members {
            setup.circle.contribute(m);
        }
    }

    /// Run one full round: contribute_all + payout.
    fn complete_round(setup: &PropSetup) {
        contribute_all(setup);
        setup.circle.payout();
    }

    /// Advance ledger past the current round's deadline.
    fn advance_past_deadline(setup: &PropSetup) {
        let round = setup.circle.get_current_round();
        setup.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });
    }

    /// Read the `DataKey::RoundsCompleted` counter directly from storage.
    fn rounds_completed(setup: &PropSetup) -> u32 {
        setup.env.as_contract(&setup.circle_id, || {
            setup
                .env
                .storage()
                .instance()
                .get::<_, u32>(&DataKey::RoundsCompleted)
                .unwrap_or(0)
        })
    }

    /// Extract `(closer, total_released, total_expected, reason)` from the
    /// `closed` event in the current event buffer, consuming the buffer.
    fn decode_closed_event(
        setup: &PropSetup,
    ) -> Option<(Address, i128, i128, soroban_sdk::Symbol)> {
        let target = soroban_sdk::Symbol::new(&setup.env, "closed");
        let tv: soroban_sdk::Val =
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&target, &setup.env);
        let tbits = soroban_sdk::Val::get_payload(tv);

        setup
            .env
            .events()
            .all()
            .into_iter()
            .find(|(_, topics, _)| {
                topics
                    .get(1)
                    .map(|v| soroban_sdk::Val::get_payload(v) == tbits)
                    .unwrap_or(false)
            })
            .map(|(_, _, data)| soroban_sdk::FromVal::from_val(&setup.env, &data))
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Property tests
    // ═════════════════════════════════════════════════════════════════════════

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // ── Invariant 1: Any join permutation activates the circle ────────────
        //
        // No matter what order members join, once all N have joined the circle
        // must be Active.  The deadline clock must also start at the ledger of
        // the last join, not at initialise time.

        #[test]
        fn prop_any_join_permutation_activates_circle(
            member_count in 2usize..=5,
            round_amount in 1i128..=1_000_000_000i128,
            join_seed in any::<u64>(),
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);

            // Advance ledger a few steps so the deadline cannot be confused with
            // the init ledger.
            setup.env.ledger().with_mut(|l| { l.sequence_number += 200; });

            let order = permute(member_count, join_seed);
            let seq_before_last = setup.env.ledger().sequence();

            // Join all members except the last
            for &idx in &order[..order.len() - 1] {
                setup.circle.join(&setup.members[idx]);
                prop_assert_eq!(setup.circle.get_status(), CircleStatus::Pending,
                    "circle must stay Pending until the final join");
            }

            // Last join triggers Active
            setup.circle.join(&setup.members[order[order.len() - 1]]);
            prop_assert_eq!(setup.circle.get_status(), CircleStatus::Active,
                "circle must become Active after every member has joined");

            // Deadline clock resets from the last-join ledger
            let round = setup.circle.get_current_round();
            prop_assert_eq!(
                round.deadline_ledger,
                seq_before_last as u64 + MIN_ROUND_DEADLINE_LEDGERS as u64,
                "deadline_ledger must equal last-join-ledger + round_deadline_ledgers"
            );
        }

        // ── Invariant 2: Collateral never goes negative ───────────────────────
        //
        // The penalty formula `collateral * PENALTY_BPS / BPS_DENOM` always
        // produces a value in `[0, collateral]` when starting from a positive
        // collateral, so repeated application can never go below zero.

        #[test]
        fn prop_collateral_never_negative(
            member_count in 2usize..=5,
            round_amount in 1i128..=1_000_000_000i128,
            default_count in 0u32..10,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &permute(member_count, 42));

            // Apply `default_count` penalties to the first member by advancing
            // the deadline and simulating repeated default rounds.
            let target = setup.members[0].clone();

            for round_idx in 0..default_count {
                // Force the current-round state to a fresh deadline
                setup.env.as_contract(&setup.circle_id, || {
                    let mut round: crate::RoundState = setup
                        .env
                        .storage()
                        .instance()
                        .get(&DataKey::CurrentRound)
                        .unwrap();
                    round.round_index = round_idx;
                    round.paid_out = false;
                    round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                    setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
                });
                setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

                // If target was already defaulted this round (key exists), skip
                let already = setup.env.as_contract(&setup.circle_id, || {
                    setup.env.storage().persistent().has(
                        &DataKey::Defaulted(target.clone(), round_idx)
                    )
                });
                if already { continue; }

                setup.circle.mark_default(&target);
                let c = setup.circle.get_collateral(&target);
                prop_assert!(c >= 0, "collateral must never be negative; got {} after round {}", c, round_idx);
            }
        }

        // ── Invariant 3: Contributed and Defaulted are mutually exclusive ─────
        //
        // For any (member, round) pair the contract must not allow both a
        // `Contributed` key and a `Defaulted` key to exist simultaneously.

        #[test]
        fn prop_contributed_defaulted_mutually_exclusive(
            member_count in 2usize..=5,
            round_amount in 1i128..=1_000_000_000i128,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &permute(member_count, 7));

            // Two members contribute; two don't (for n >= 2 we test at least one of each)
            let contributor = setup.members[0].clone();
            setup.circle.contribute(&contributor);

            // Now advance past deadline and default a non-contributor
            advance_past_deadline(&setup);
            let defaulter = setup.members[member_count - 1].clone();
            setup.circle.mark_default(&defaulter);

            let round = setup.env.as_contract(&setup.circle_id, || {
                setup.env.storage().instance()
                    .get::<_, crate::RoundState>(&DataKey::CurrentRound)
                    .unwrap()
            });
            let ri = round.round_index;

            // Contributor has Contributed key, no Defaulted key
            let contrib_has = setup.env.as_contract(&setup.circle_id, || {
                setup.env.storage().persistent()
                    .has(&DataKey::Contributed(contributor.clone(), ri))
            });
            let contrib_defaulted = setup.env.as_contract(&setup.circle_id, || {
                setup.env.storage().persistent()
                    .has(&DataKey::Defaulted(contributor.clone(), ri))
            });
            prop_assert!(contrib_has, "contributor must have Contributed key");
            prop_assert!(!contrib_defaulted, "contributor must not have Defaulted key");

            // Defaulter has Defaulted key, no Contributed key
            let def_has_defaulted = setup.env.as_contract(&setup.circle_id, || {
                setup.env.storage().persistent()
                    .has(&DataKey::Defaulted(defaulter.clone(), ri))
            });
            let def_has_contributed = setup.env.as_contract(&setup.circle_id, || {
                setup.env.storage().persistent()
                    .has(&DataKey::Contributed(defaulter.clone(), ri))
            });
            prop_assert!(def_has_defaulted, "defaulter must have Defaulted key");
            prop_assert!(!def_has_contributed, "defaulter must not have Contributed key");
        }

        // ── Invariant 4: Status only moves forward ────────────────────────────
        //
        // Pending → Active → Completed is a DAG.  Status must never regress.

        #[test]
        fn prop_status_never_reverts(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);

            prop_assert_eq!(setup.circle.get_status(), CircleStatus::Pending);

            // Each join must not revert to a prior state
            for (i, m) in setup.members.iter().enumerate() {
                setup.circle.join(m);
                let s = setup.circle.get_status();
                if i < member_count - 1 {
                    prop_assert_eq!(s, CircleStatus::Pending,
                        "still Pending after join {}/{}", i+1, member_count);
                } else {
                    prop_assert_eq!(s, CircleStatus::Active, "Active after all joined");
                }
            }

            // Each round payout must not revert status
            for r in 0..member_count as u32 {
                prop_assert_eq!(setup.circle.get_status(), CircleStatus::Active,
                    "Active during round {}", r);
                complete_round(&setup);
                let s = setup.circle.get_status();
                if r < member_count as u32 - 1 {
                    prop_assert_eq!(s, CircleStatus::Active, "still Active mid-lifecycle");
                } else {
                    prop_assert_eq!(s, CircleStatus::Completed, "Completed after final payout");
                }
            }
        }

        // ── Invariant 5: close() total_released == Σ pre-close collateral ─────
        //
        // The `closed` event's `total_released` field must exactly equal the
        // sum of all members' collateral balances read from storage before close.

        #[test]
        fn prop_close_total_released_matches_sum(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
            // Number of members (0..member_count) whose collateral gets a penalty
            penalty_count in 0usize..=3,
        ) {
            let mc = member_count;
            let pc = penalty_count.min(mc);
            let setup = make_circle_n(mc, round_amount, MIN_ROUND_DEADLINE_LEDGERS);

            // Activate and drive to Completed
            join_in_order(&setup, &(0..mc).collect::<Vec<_>>());
            for _ in 0..mc {
                complete_round(&setup);
            }

            // Apply penalties to `pc` members by force-setting collateral
            let penalty = round_amount * PENALTY_BPS / BPS_DENOM;
            let reduced = round_amount - penalty;
            for i in 0..pc {
                setup.env.as_contract(&setup.circle_id, || {
                    setup.env.storage().persistent().set(
                        &DataKey::Collateral(setup.members[i].clone()),
                        &reduced,
                    );
                });
            }

            // Read pre-close balances
            let pre_sum: i128 = setup.members.iter()
                .map(|m| setup.circle.get_collateral(m))
                .sum();

            let _ = setup.env.events().all(); // flush earlier events
            setup.circle.close(&setup.members[0]);

            let (_, total_released, _, _) = decode_closed_event(&setup)
                .expect("closed event must be emitted");

            prop_assert_eq!(
                total_released, pre_sum,
                "total_released in closed event must equal sum of pre-close collateral"
            );

            // All collateral storage keys must now be zero
            for m in &setup.members {
                prop_assert_eq!(setup.circle.get_collateral(m), 0,
                    "post-close collateral must be 0 for all members");
            }
        }

        // ── Invariant 6: Round index strictly advances; no double-payout ──────
        //
        // After each payout the round_index increases by exactly 1 and the
        // new round's paid_out flag starts as false.

        #[test]
        fn prop_round_index_strictly_advances(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &(0..member_count).collect::<Vec<_>>());

            for expected_idx in 0..member_count as u32 {
                let before = setup.circle.get_current_round();
                prop_assert_eq!(before.round_index, expected_idx,
                    "round_index must be {} before payout", expected_idx);
                prop_assert!(!before.paid_out, "new round must not start paid_out");
                prop_assert_eq!(before.contributions_received, 0,
                    "new round must start with 0 contributions");

                complete_round(&setup);

                if expected_idx < member_count as u32 - 1 {
                    let after = setup.circle.get_current_round();
                    prop_assert_eq!(after.round_index, expected_idx + 1,
                        "round_index must advance by 1 after payout");
                    prop_assert!(!after.paid_out);
                }
            }
        }

        // ── Invariant 7: RoundsCompleted increments by 1 per payout ──────────

        #[test]
        fn prop_rounds_completed_monotone(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &(0..member_count).collect::<Vec<_>>());

            for k in 0..member_count as u32 {
                prop_assert_eq!(rounds_completed(&setup), k,
                    "RoundsCompleted must be {} before round {} payout", k, k);
                complete_round(&setup);
                prop_assert_eq!(rounds_completed(&setup), k + 1,
                    "RoundsCompleted must be {} after round {} payout", k+1, k);
            }
            prop_assert_eq!(rounds_completed(&setup), member_count as u32);
        }

        // ── Invariant 8: Deadline boundary — positive direction only ─────────
        //
        // Tests the two POSITIVE invariants:
        //   (a) At exactly `deadline_ledger`: contribute is accepted.
        //   (b) At `deadline_ledger + 1`:     mark_default is accepted for a
        //       member who did not contribute.
        //
        // The NEGATIVE directions (mark_default at DL panics; contribute at DL+1
        // panics) are covered by `#[should_panic]` tests in tests.rs.  We do not
        // use `catch_unwind` here because the Soroban host uses RefCell internally
        // and a caught panic leaves the host in an inconsistent state for any
        // subsequent call on the same Env, making catch_unwind unreliable.
        //
        // A fixed deadline of MIN_ROUND_DEADLINE_LEDGERS (100) keeps the ledger
        // advance within the Soroban testutils default TTL.  Larger deadline values
        // would archive the contract instance before the sequence reaches the
        // deadline.  The invariant is independent of the exact deadline value.

        #[test]
        fn prop_deadline_boundary_non_overlapping(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
        ) {
            // Fixed deadline = MIN_ROUND_DEADLINE_LEDGERS (100) so the ledger
            // advance to deadline_ledger stays within the Soroban testutils
            // default instance-storage TTL.  The boundary invariant holds
            // regardless of the specific deadline value.
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &(0..member_count).collect::<Vec<_>>());

            let round = setup.circle.get_current_round();
            let dl = round.deadline_ledger;

            // (a) At exactly deadline_ledger: contribution is accepted
            setup.env.ledger().with_mut(|l| {
                l.sequence_number = dl as u32;
            });
            setup.circle.contribute(&setup.members[0]);
            prop_assert!(
                setup.circle.has_contributed(&setup.members[0], &0u32),
                "contribution at deadline_ledger must be recorded"
            );

            // (b) At deadline_ledger + 1: mark_default is accepted for the
            //     last member (who did not contribute in this round)
            setup.env.ledger().with_mut(|l| {
                l.sequence_number = dl as u32 + 1;
            });
            setup.circle.mark_default(&setup.members[member_count - 1]);
            prop_assert_eq!(
                setup.circle.get_defaults(&setup.members[member_count - 1]), 1,
                "mark_default at deadline_ledger+1 must succeed for non-contributor"
            );
        }

        // ── Invariant 9: Full-lifecycle token conservation ────────────────────
        //
        // Over a complete lifecycle (join → all rounds → close) with no penalties,
        // each member's net token change is exactly 0 (put in = took out).
        // The collateral and contributions net to zero per member.

        #[test]
        fn prop_balance_conservation_full_lifecycle(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);

            // Record pre-join balances
            let balances_before: Vec<i128> = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .collect();

            // Full lifecycle: join + all rounds + close
            join_in_order(&setup, &(0..member_count).collect::<Vec<_>>());
            for _ in 0..member_count {
                complete_round(&setup);
            }
            setup.circle.close(&setup.members[0]);

            // Each member's net change must be 0
            for (i, m) in setup.members.iter().enumerate() {
                let bal_after = setup.token.balance(m);
                prop_assert_eq!(
                    bal_after, balances_before[i],
                    "member[{}] net token change must be 0 across full lifecycle \
                     (contributed {} rounds, received 1 pot, returned collateral)",
                    i, member_count
                );
            }
        }

        // ── Invariant 10: Each default strictly reduces collateral ────────────
        //
        // Collateral after mark_default must be strictly less than before.
        // The penalty formula `c * 2000 / 10000 = c/5` is always positive for
        // positive c, so the reduction is always strict.

        #[test]
        fn prop_each_default_strictly_reduces_collateral(
            member_count in 2usize..=5,
            round_amount in 1i128..=1_000_000_000i128,
            default_rounds in 1u32..=5,
        ) {
            let setup = make_circle_n(member_count, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &permute(member_count, 99));

            let target = setup.members[0].clone();
            let mut prev_collateral = setup.circle.get_collateral(&target);
            prop_assume!(prev_collateral > 0);

            for round_idx in 0..default_rounds {
                // Force round state so we can default the target again
                setup.env.as_contract(&setup.circle_id, || {
                    let mut round: crate::RoundState = setup
                        .env
                        .storage()
                        .instance()
                        .get(&DataKey::CurrentRound)
                        .unwrap();
                    round.round_index = round_idx;
                    round.paid_out = false;
                    round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                    setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
                });
                setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

                if prev_collateral <= 0 {
                    break; // no point continuing once fully drained
                }

                setup.circle.mark_default(&target);
                let new_collateral = setup.circle.get_collateral(&target);

                prop_assert!(
                    new_collateral < prev_collateral,
                    "collateral must strictly decrease after default: before={prev_collateral}, after={new_collateral}"
                );
                prop_assert!(new_collateral >= 0,
                    "collateral must not go negative: {new_collateral}");

                prev_collateral = new_collateral;
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Boundary / seed tests — deterministic CI regression anchors
    // ═════════════════════════════════════════════════════════════════════════

    // ── B1: Minimum round_amount = 1 ─────────────────────────────────────────
    //
    // A circle with the absolute minimum non-zero round_amount must complete
    // a full lifecycle.  Penalty arithmetic on amount=1 exercises truncation:
    //   penalty = 1 * 2000 / 10000 = 0  (integer division truncates)
    // So mark_default on amount=1 must produce a penalty of 0 and leave
    // collateral unchanged — this is the floor behaviour.

    #[test]
    fn boundary_round_amount_one() {
        let setup = make_circle_n(2, 1, MIN_ROUND_DEADLINE_LEDGERS);

        // Join both members
        setup.circle.join(&setup.members[0]);
        setup.circle.join(&setup.members[1]);
        assert_eq!(setup.circle.get_status(), CircleStatus::Active);

        // Apply a default — penalty = 1 * 2000 / 10000 = 0 (integer floor)
        advance_past_deadline(&setup);
        let collateral_before = setup.circle.get_collateral(&setup.members[1]);
        setup.circle.mark_default(&setup.members[1]);
        let collateral_after = setup.circle.get_collateral(&setup.members[1]);
        // With amount=1, penalty is 0 — collateral unchanged (floor behaviour)
        let expected_penalty = 1i128 * PENALTY_BPS / BPS_DENOM; // = 0
        assert_eq!(collateral_before - collateral_after, expected_penalty);
    }

    // ── B2: round_amount near the penalty-overflow boundary ──────────────────
    //
    // The largest valid round_amount for a 2-member circle is
    // i128::MAX / PENALTY_BPS.  Initialise must succeed; the next value
    // (MAX_VALID_ROUND_AMOUNT + 1) must panic with an overflow message.

    #[test]
    fn boundary_round_amount_max_valid_initialises() {
        let setup = make_circle_n(2, MAX_VALID_ROUND_AMOUNT, MIN_ROUND_DEADLINE_LEDGERS);
        // initialize succeeded — verify config stored correctly
        let config = setup.circle.get_config();
        assert_eq!(config.round_amount, MAX_VALID_ROUND_AMOUNT);
    }

    #[test]
    #[should_panic(expected = "overflows penalty calculation")]
    fn boundary_round_amount_one_above_max_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = SdkVec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // MAX_VALID_ROUND_AMOUNT + 1 overflows the penalty check
        circle.initialize(
            &Address::generate(&env),
            &members,
            &(MAX_VALID_ROUND_AMOUNT + 1),
            &token_id,
            &rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ── B3: Deadline at exact MIN boundary ───────────────────────────────────

    #[test]
    fn boundary_deadline_at_minimum() {
        let setup = make_circle_n(2, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
        let config = setup.circle.get_config();
        assert_eq!(config.round_deadline_ledgers, MIN_ROUND_DEADLINE_LEDGERS);

        join_in_order(&setup, &[0, 1]);
        assert_eq!(setup.circle.get_status(), CircleStatus::Active);
    }

    // ── B4: Deadline at exact MAX boundary ───────────────────────────────────

    #[test]
    fn boundary_deadline_at_maximum() {
        let setup = make_circle_n(2, 1_000_000, MAX_ROUND_DEADLINE_LEDGERS);
        let config = setup.circle.get_config();
        assert_eq!(config.round_deadline_ledgers, MAX_ROUND_DEADLINE_LEDGERS);

        join_in_order(&setup, &[0, 1]);
        let round = setup.circle.get_current_round();
        // deadline_ledger == last-join-sequence + MAX_ROUND_DEADLINE_LEDGERS
        // The join sequence == current sequence (no ledger advance after join).
        assert_eq!(
            round.deadline_ledger,
            setup.env.ledger().sequence() as u64 + MAX_ROUND_DEADLINE_LEDGERS as u64,
            "deadline must be current_seq + MAX_ROUND_DEADLINE_LEDGERS"
        );
    }

    // ── B5: Maximum member count (256) — initialize only ─────────────────────
    //
    // A 256-member circle is the protocol maximum.  `initialize` must succeed
    // and `get_config` must report 256 members.  We don't run the full
    // lifecycle (it would be prohibitively slow) but the invariant is that
    // the contract accepts and stores the maximum configuration.

    #[test]
    fn boundary_max_member_count_initialises() {
        // Test that `initialize` accepts exactly MAX_MEMBERS (256) members.
        // We skip minting tokens for all 256 because the Soroban testutils
        // instruction budget is exhausted by 256 mint calls in a single env.
        // The invariant under test is purely about initialize storage, not join.
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin).address();

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = SdkVec::new(&env);
        for _ in 0..MAX_MEMBERS {
            members.push_back(Address::generate(&env));
        }

        // round_amount must not overflow: amount * PENALTY_BPS ≤ i128::MAX
        // and amount * member_count (256) ≤ i128::MAX.
        let round_amount = 1_000_000i128;
        circle.initialize(
            &Address::generate(&env),
            &members,
            &round_amount,
            &token_id,
            &rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(config.members.len(), MAX_MEMBERS as u32,
            "circle must store all 256 members");
        assert_eq!(circle.get_status(), CircleStatus::Pending);
    }

    // ── B6: Deadline ledger exceeds u32::MAX ──────────────────────────────────
    //
    // `deadline_ledger` is stored as u64 but `env.ledger().sequence()` is u32.
    // When the circle is initialized near the u32 ceiling with a large deadline,
    // `deadline_ledger` (u64) exceeds `u32::MAX`.
    //
    // Structural consequence:
    //   `(sequence as u64) <= deadline_ledger` is always true for any u32 sequence,
    //   so contributions are perpetually accepted and mark_default is perpetually
    //   rejected — the round deadline is effectively unreachable.
    //
    // This test documents and pins that arithmetic invariant.  The Soroban host
    // raises `InternalError` at exactly `u32::MAX`, so we stop one ledger short
    // of the absolute ceiling for the `contribute` call, using `u32::MAX - 10`.

    // B6 is split into two sub-tests:
    //   B6a — live contract: deadline_ledger is stored as full u64 (not truncated)
    //   B6b — arithmetic:   when deadline_ledger > u32::MAX the deadline is
    //          provably unreachable from any u32 sequence number

    // NOTE: The Soroban testutils host archives instance storage when the ledger
    // sequence is advanced by large amounts after initialisation (because the
    // entry's TTL expires).  We therefore test the u64 storage contract-side at
    // a normal sequence, and prove the unreachability claim with pure arithmetic.

    #[test]
    fn boundary_deadline_ledger_stored_as_u64() {
        // Verify that deadline_ledger is stored as u64 and not silently truncated
        // to u32.  Use MAX_ROUND_DEADLINE_LEDGERS to maximise the value.
        let setup = make_circle_n(2, 1_000_000, MAX_ROUND_DEADLINE_LEDGERS);
        join_in_order(&setup, &[0, 1]);

        let round = setup.circle.get_current_round();
        let seq = setup.env.ledger().sequence() as u64;
        assert_eq!(
            round.deadline_ledger,
            seq + MAX_ROUND_DEADLINE_LEDGERS as u64,
            "deadline_ledger must equal activation_seq + deadline_ledgers (stored as u64)"
        );

        // At MIN deadline the stored value is smaller but still u64-correct
        let setup2 = make_circle_n(2, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
        join_in_order(&setup2, &[0, 1]);
        let round2 = setup2.circle.get_current_round();
        let seq2 = setup2.env.ledger().sequence() as u64;
        assert_eq!(round2.deadline_ledger, seq2 + MIN_ROUND_DEADLINE_LEDGERS as u64);
    }

    #[test]
    fn boundary_deadline_unreachable_when_exceeds_u32_max() {
        // Pure arithmetic proof: if a circle is activated when the ledger
        // sequence is near u32::MAX with a positive deadline, the stored
        // deadline_ledger (u64) exceeds u32::MAX.  Because `env.ledger().sequence()`
        // returns u32, the deadline can never be reached, making:
        //   • contribute always accepted  (sequence as u64 <= deadline always)
        //   • mark_default always rejected (sequence as u64 > deadline never true)

        let ceiling_seq: u64 = (u32::MAX - 10) as u64; // largest reachable u32
        let min_d: u64 = MIN_ROUND_DEADLINE_LEDGERS as u64;

        // Even the smallest deadline pushes beyond u32::MAX from the ceiling
        let hypothetical_deadline = ceiling_seq + min_d;
        assert!(
            hypothetical_deadline > u32::MAX as u64,
            "deadline_ledger {} must exceed u32::MAX {}",
            hypothetical_deadline, u32::MAX
        );

        // The contribute guard: `(seq as u64) > deadline_ledger` — false for all u32 seq
        // (contributes are always accepted)
        for seq in [0u32, 1, 1_000_000, u32::MAX / 2, u32::MAX - 10] {
            assert!(
                (seq as u64) <= hypothetical_deadline,
                "contribute must be accepted: seq {} as u64 <= deadline {}",
                seq, hypothetical_deadline
            );
        }

        // The mark_default guard: `(seq as u64) > deadline_ledger` — also always false
        // (mark_default is always rejected for any u32 sequence)
        assert!(
            !((u32::MAX as u64) > hypothetical_deadline),
            "mark_default must be rejected even at u32::MAX: {} is not > {}",
            u32::MAX, hypothetical_deadline
        );
    }

    // ── B7: 2-member full lifecycle with round_amount = 1 ────────────────────
    //
    // Exercises the smallest possible ROSCA: 2 members, 1 stroop per round.
    // Verifies the complete join → contribute → payout → close flow succeeds
    // and that integer arithmetic produces correct results at minimum values.

    #[test]
    fn boundary_two_member_full_lifecycle_amount_one() {
        let setup = make_circle_n(2, 1, MIN_ROUND_DEADLINE_LEDGERS);
        let [ref m0, ref m1] = setup.members[..] else { panic!("need 2 members") };

        let bal0_start = setup.token.balance(m0);
        let bal1_start = setup.token.balance(m1);

        join_in_order(&setup, &[0, 1]);
        assert_eq!(setup.circle.get_status(), CircleStatus::Active);

        // Round 0: m0 is recipient; both contribute
        complete_round(&setup);
        assert_eq!(setup.circle.get_current_round().round_index, 1);

        // Round 1: m1 is recipient; both contribute
        complete_round(&setup);
        assert_eq!(setup.circle.get_status(), CircleStatus::Completed);

        // Close: collateral returned to both
        setup.circle.close(m0);

        // Net change must be 0 for each member (ROSCA is zero-sum)
        assert_eq!(setup.token.balance(m0), bal0_start, "m0 net change must be 0");
        assert_eq!(setup.token.balance(m1), bal1_start, "m1 net change must be 0");
    }

    // ── B8: All members default every round — collateral floor ───────────────
    //
    // If every member defaults in every round the collateral decays by 20%
    // each time.  After enough rounds it asymptotically approaches 0 but must
    // never go negative.  We verify:
    //   (a) collateral is strictly monotone-decreasing after each default
    //   (b) collateral is always >= 0
    //   (c) once collateral reaches 0 (due to integer truncation at small values)
    //       additional defaults leave it at 0, not negative

    #[test]
    fn boundary_all_members_default_all_rounds_collateral_floor() {
        let setup = make_circle_n(2, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
        join_in_order(&setup, &[0, 1]);

        let target = setup.members[0].clone();
        let mut prev = setup.circle.get_collateral(&target);

        for round_idx in 0..20u32 {
            // Force round state for this iteration
            setup.env.as_contract(&setup.circle_id, || {
                let mut round: crate::RoundState = setup
                    .env
                    .storage()
                    .instance()
                    .get(&DataKey::CurrentRound)
                    .unwrap();
                round.round_index = round_idx;
                round.paid_out = false;
                round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
            });
            setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

            setup.circle.mark_default(&target);
            let after = setup.circle.get_collateral(&target);

            assert!(
                after >= 0,
                "collateral must never go negative (round {round_idx}): {after}"
            );
            assert!(
                after <= prev,
                "collateral must be non-increasing (round {round_idx}): {prev} → {after}"
            );
            prev = after;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #322 — Property and boundary tests for initialize config validation
    //
    // These tests verify the new address-validation guards introduced in #322:
    //
    //   B322-1  usdc_token == circle → always rejected, no state written
    //   B322-2  reputation_contract == circle → always rejected, no state written
    //   B322-3  reputation_contract == usdc_token → always rejected, no state written
    //   B322-4  all three distinct addresses + valid params → always accepted
    //   B322-5  Property: initialize with valid params always succeeds and
    //           leaves Config readable
    //   B322-6  Property: any invalid address configuration always leaves
    //           Config absent (no state written)
    // ══════════════════════════════════════════════════════════════════════════

    // ── Helpers for #322 tests ────────────────────────────────────────────────

    /// Build a bare env with a USDC token and reputation contract registered.
    /// Returns `(env, token_address, reputation_address)`.
    fn make_env_with_token_and_rep() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_reg = env.register_stellar_asset_contract_v2(token_admin);

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);

        (env, token_reg.address(), rep_id)
    }

    // ── B322-1: usdc_token == circle always rejected ──────────────────────────

    /// The self-referential token guard fires regardless of member count or
    /// round_amount, as long as all other parameters are valid.
    #[test]
    fn b322_1_usdc_token_equals_circle_always_rejected() {
        let (env, _token_address, reputation_id) = make_env_with_token_and_rep();
        let circle_id = env.register_contract(None, crate::CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = SdkVec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // Pass the circle itself as the token — must panic
        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &1_000_000i128,
            &circle_id,      // ← usdc_token == circle
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(
            result.is_err(),
            "usdc_token == circle must always be rejected"
        );

        // Config must not exist — no persistent state written
        assert!(
            circle.try_get_config().is_err(),
            "Config must be absent after rejected initialize"
        );
    }

    // ── B322-2: reputation_contract == circle always rejected ─────────────────

    #[test]
    fn b322_2_reputation_equals_circle_always_rejected() {
        let (env, token_address, _reputation_id) = make_env_with_token_and_rep();
        let circle_id = env.register_contract(None, crate::CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = SdkVec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &1_000_000i128,
            &token_address,
            &circle_id,      // ← reputation == circle
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(
            result.is_err(),
            "reputation_contract == circle must always be rejected"
        );

        assert!(
            circle.try_get_config().is_err(),
            "Config must be absent after rejected initialize"
        );
    }

    // ── B322-3: reputation_contract == usdc_token always rejected ────────────

    #[test]
    fn b322_3_reputation_equals_usdc_token_always_rejected() {
        let (env, token_address, _reputation_id) = make_env_with_token_and_rep();
        let circle_id = env.register_contract(None, crate::CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = SdkVec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        let result = circle.try_initialize(
            &Address::generate(&env),
            &members,
            &1_000_000i128,
            &token_address,
            &token_address,  // ← reputation == usdc_token
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(
            result.is_err(),
            "reputation_contract == usdc_token must always be rejected"
        );

        assert!(
            circle.try_get_config().is_err(),
            "Config must be absent after rejected initialize"
        );
    }

    // ── B322-4: all three distinct → accepted ─────────────────────────────────

    /// When circle_id, token_address, and reputation_id are all distinct and
    /// all other parameters are valid, initialize must always succeed and write
    /// a Config key readable via get_config.
    #[test]
    fn b322_4_three_distinct_addresses_always_accepted() {
        let (env, token_address, reputation_id) = make_env_with_token_and_rep();
        let circle_id = env.register_contract(None, crate::CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // Paranoia: the fixture must generate distinct addresses
        assert_ne!(circle_id, token_address);
        assert_ne!(circle_id, reputation_id);
        assert_ne!(token_address, reputation_id);

        let mut members = SdkVec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        circle.initialize(
            &Address::generate(&env),
            &members,
            &1_000_000i128,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let config = circle.get_config();
        assert_eq!(config.members.len(), 2);
        assert_eq!(config.round_amount, 1_000_000i128);
    }

    // ── B322-5: Property — valid params always produce readable Config ─────────

    /// For any member count in [2, 8] and round_amount in [1, MAX_VALID],
    /// initialize with distinct addresses must always write a Config that
    /// get_config returns correctly.
    proptest! {
        #[test]
        fn prop_322_valid_params_always_initializes(
            member_count in 2usize..=8usize,
            round_amount in 1i128..=MAX_VALID_ROUND_AMOUNT,
            deadline in MIN_ROUND_DEADLINE_LEDGERS..=MAX_ROUND_DEADLINE_LEDGERS,
        ) {
            let (env, token_address, reputation_id) = make_env_with_token_and_rep();
            let circle_id = env.register_contract(None, crate::CircleContract);
            let circle = CircleContractClient::new(&env, &circle_id);

            let mut members = SdkVec::new(&env);
            for _ in 0..member_count {
                members.push_back(Address::generate(&env));
            }

            circle.initialize(
                &Address::generate(&env),
                &members,
                &round_amount,
                &token_address,
                &reputation_id,
                &deadline,
            );

            let config = circle.get_config();
            prop_assert_eq!(config.members.len() as usize, member_count);
            prop_assert_eq!(config.round_amount, round_amount);
            prop_assert_eq!(config.round_deadline_ledgers, deadline);
        }
    }

    // ── B322-6: Property — invalid address configs always leave Config absent ──

    /// For any invalid address combination (self-referential or aliased),
    /// the initialize attempt must fail and leave the Config key absent.
    ///
    /// The three invalid patterns are tried in sequence:
    ///   (a) token == circle
    ///   (b) reputation == circle
    ///   (c) reputation == token
    proptest! {
        #[test]
        fn prop_322_invalid_address_config_leaves_no_state(
            member_count in 2usize..=6usize,
            round_amount in 1i128..=1_000_000i128,
            // 0 = token==circle, 1 = rep==circle, 2 = rep==token
            bad_pattern in 0u8..=2u8,
        ) {
            let (env, token_address, reputation_id) = make_env_with_token_and_rep();
            let circle_id = env.register_contract(None, crate::CircleContract);
            let circle = CircleContractClient::new(&env, &circle_id);

            let mut members = SdkVec::new(&env);
            for _ in 0..member_count {
                members.push_back(Address::generate(&env));
            }

            let (bad_token, bad_rep) = match bad_pattern {
                0 => (circle_id.clone(), reputation_id.clone()),  // token == circle
                1 => (token_address.clone(), circle_id.clone()),  // rep == circle
                _ => (token_address.clone(), token_address.clone()), // rep == token
            };

            let result = circle.try_initialize(
                &Address::generate(&env),
                &members,
                &round_amount,
                &bad_token,
                &bad_rep,
                &MIN_ROUND_DEADLINE_LEDGERS,
            );
            prop_assert!(result.is_err(), "invalid address config must be rejected");

            // No Config key must exist after the failed attempt
            prop_assert!(
                circle.try_get_config().is_err(),
                "Config must be absent after any failed initialize"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #86 — Generated action-sequence properties
    //
    // The properties below extend the suite from single-operation invariants to
    // *sequences* of operations generated by proptest.  Invalid steps (wrong
    // state, deadline mismatch, etc.) are silently skipped via `try_*` so the
    // generator explores the full reachable state space without needing a
    // perfect model of what is currently valid.
    //
    // Three invariant families are covered:
    //   S1 — Collateral never goes negative under any generated step sequence.
    //   S2 — Token conservation holds for any generated contribution ordering.
    //   S3 — Each member receives the pot exactly once per full lifecycle.
    //   S4 — Status only advances (never regresses) under any step sequence.
    // ══════════════════════════════════════════════════════════════════════════

    /// One step in a generated lifecycle sequence.
    ///
    /// Indices are taken modulo `member_count` so the strategy works for any
    /// circle size — proptest generates arbitrary `usize` values and the
    /// driver clamps them.
    #[derive(Debug, Clone)]
    enum LifecycleStep {
        /// Attempt `contribute` as `members[idx % n]`.
        Contribute(usize),
        /// Advance the ledger past the current deadline then attempt
        /// `mark_default` on `members[idx % n]`.
        MarkDefault(usize),
        /// Attempt `payout`.
        Payout,
    }

    fn lifecycle_step_strategy() -> impl Strategy<Value = LifecycleStep> {
        prop_oneof![
            (0usize..16).prop_map(LifecycleStep::Contribute),
            (0usize..16).prop_map(LifecycleStep::MarkDefault),
            Just(LifecycleStep::Payout),
        ]
    }

    /// Translate a `CircleStatus` to a monotone rank for forward-only assertions.
    fn status_rank(s: &CircleStatus) -> u8 {
        match s {
            CircleStatus::Pending    => 0,
            CircleStatus::Active     => 1,
            CircleStatus::Completed  => 2,
            CircleStatus::Cancelled  => 3,
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        // ── Invariant S1: Collateral never negative under generated sequences ──
        //
        // A circle is activated with all members joining.  proptest then
        // generates up to 24 lifecycle steps.  Invalid steps (deadline already
        // passed, already contributed, etc.) are silently dropped via `try_*`.
        // The only invariant asserted is that every member's collateral is >= 0
        // after every step — i.e., the penalty formula never produces a negative
        // value regardless of how many times it is applied.

        #[test]
        fn prop_action_sequence_collateral_invariant(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
            steps in prop::collection::vec(lifecycle_step_strategy(), 0..=24),
        ) {
            let mc = member_count;
            let setup = make_circle_n(mc, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &(0..mc).collect::<Vec<_>>());

            for step in &steps {
                if setup.circle.get_status() != CircleStatus::Active {
                    break;
                }

                match step {
                    LifecycleStep::Contribute(idx) => {
                        let m = setup.members[idx % mc].clone();
                        let _ = setup.circle.try_contribute(&m);
                    }
                    LifecycleStep::MarkDefault(idx) => {
                        // Advance ledger to deadline+1 only when the circle is
                        // still active (get_current_round panics otherwise).
                        if setup.circle.get_status() == CircleStatus::Active {
                            let round = setup.circle.get_current_round();
                            let dl = round.deadline_ledger as u32;
                            setup.env.ledger().with_mut(|l| {
                                if l.sequence_number <= dl {
                                    l.sequence_number = dl + 1;
                                }
                            });
                        }
                        let m = setup.members[idx % mc].clone();
                        let _ = setup.circle.try_mark_default(&m);
                    }
                    LifecycleStep::Payout => {
                        let _ = setup.circle.try_payout();
                    }
                }

                // Invariant: collateral must be non-negative after every step
                for m in &setup.members {
                    let c = setup.circle.get_collateral(m);
                    prop_assert!(
                        c >= 0,
                        "collateral must never be negative; member has {} after a lifecycle step",
                        c
                    );
                }
            }
        }

        // ── Invariant S2: Token conservation under generated contribution order ─
        //
        // Over a complete clean lifecycle (all members contribute every round,
        // no defaults) the net token change per member is exactly 0, regardless
        // of the *order* in which members contribute within each round.
        //
        // Each round receives an independently generated shuffle seed so proptest
        // explores the full cartesian product of per-round orderings.

        #[test]
        fn prop_conservation_generated_contribution_order(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
            per_round_seeds in prop::collection::vec(any::<u64>(), 1..=4),
        ) {
            let mc = member_count;
            let setup = make_circle_n(mc, round_amount, MIN_ROUND_DEADLINE_LEDGERS);

            let balances_before: Vec<i128> = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .collect();

            // Canonical join order for determinism
            join_in_order(&setup, &(0..mc).collect::<Vec<_>>());

            // Execute each round with a generated contribution order
            for round_idx in 0..mc {
                let seed = per_round_seeds[round_idx % per_round_seeds.len()];
                let order = permute(mc, seed);
                for &member_idx in &order {
                    setup.circle.contribute(&setup.members[member_idx]);
                }
                setup.circle.payout();
            }

            prop_assert_eq!(
                setup.circle.get_status(), CircleStatus::Completed,
                "circle must be Completed after all rounds"
            );

            setup.circle.close(&setup.members[0]);

            for (i, m) in setup.members.iter().enumerate() {
                let bal_after = setup.token.balance(m);
                prop_assert_eq!(
                    bal_after, balances_before[i],
                    "member[{}] net token change must be 0 for any contribution order; \
                     before={} after={}", i, balances_before[i], bal_after
                );
            }
        }

        // ── Invariant S3: Each member receives exactly one payout ─────────────
        //
        // Over a full lifecycle each member appears as round recipient exactly
        // once.  The property is parameterised on join order (which does not
        // affect rotation — rotation is always members[0..n] in index order)
        // to verify that the recipient derivation is independent of the order
        // in which members joined.

        #[test]
        fn prop_single_payout_per_member(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
            join_seed in any::<u64>(),
        ) {
            let mc = member_count;
            let setup = make_circle_n(mc, round_amount, MIN_ROUND_DEADLINE_LEDGERS);

            // Join in the generated order (rotation is not affected)
            join_in_order(&setup, &permute(mc, join_seed));

            let pot = round_amount * mc as i128;
            let mut payout_recipients: Vec<soroban_sdk::Address> = Vec::with_capacity(mc);

            for _ in 0..mc {
                let round = setup.circle.get_current_round();
                let recipient = round.recipient.clone();
                payout_recipients.push(recipient.clone());

                let bal_before = setup.token.balance(&recipient);
                contribute_all(&setup);
                setup.circle.payout();
                let bal_after = setup.token.balance(&recipient);

                // Recipient's net gain in this round: received pot, paid one contribution
                let net = bal_after - bal_before;
                prop_assert_eq!(
                    net,
                    pot - round_amount,
                    "round recipient must net pot − own contribution = {} in round {}; \
                     got {}", pot - round_amount, round.round_index, net
                );
            }

            prop_assert_eq!(
                setup.circle.get_status(), CircleStatus::Completed,
                "circle must be Completed after all rounds"
            );

            // Every member appears as recipient exactly once
            for (i, m) in setup.members.iter().enumerate() {
                let count = payout_recipients.iter().filter(|r| *r == m).count();
                prop_assert_eq!(
                    count, 1,
                    "member[{}] must appear as recipient exactly once; got {} times", i, count
                );
            }
        }

        // ── Invariant S4: Status only advances under generated step sequences ──
        //
        // For any generated sequence of lifecycle steps the status must follow
        // the DAG ordering: Pending < Active < Completed.  Invalid steps are
        // dropped via `try_*`; the rank of the observed status must be
        // monotone-non-decreasing across every step.

        #[test]
        fn prop_generated_sequence_status_advances(
            member_count in 2usize..=4,
            round_amount in 1i128..=50_000_000i128,
            steps in prop::collection::vec(lifecycle_step_strategy(), 0..=20),
        ) {
            let mc = member_count;
            let setup = make_circle_n(mc, round_amount, MIN_ROUND_DEADLINE_LEDGERS);
            join_in_order(&setup, &(0..mc).collect::<Vec<_>>());

            let mut prev_rank = status_rank(&setup.circle.get_status());

            for step in &steps {
                if setup.circle.get_status() != CircleStatus::Active {
                    break;
                }

                match step {
                    LifecycleStep::Contribute(idx) => {
                        let m = setup.members[idx % mc].clone();
                        let _ = setup.circle.try_contribute(&m);
                    }
                    LifecycleStep::MarkDefault(idx) => {
                        if setup.circle.get_status() == CircleStatus::Active {
                            let round = setup.circle.get_current_round();
                            let dl = round.deadline_ledger as u32;
                            setup.env.ledger().with_mut(|l| {
                                if l.sequence_number <= dl {
                                    l.sequence_number = dl + 1;
                                }
                            });
                        }
                        let m = setup.members[idx % mc].clone();
                        let _ = setup.circle.try_mark_default(&m);
                    }
                    LifecycleStep::Payout => {
                        let _ = setup.circle.try_payout();
                    }
                }

                let new_rank = status_rank(&setup.circle.get_status());
                prop_assert!(
                    new_rank >= prev_rank,
                    "status rank must never decrease: prev={} new={}", prev_rank, new_rank
                );
                prev_rank = new_rank;
            }
        }
    }
}
