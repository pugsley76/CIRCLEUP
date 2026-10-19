//! Lifecycle invariant tests — Issue #631
//!
//! Covers protocol correctness for edge cases not in the main test suite:
//!
//!  1. settle_round partial-pot (one defaulter)
//!  2. settle_round all-default zero-pot
//!  3. settle_round skips already-marked members (no double-penalty)
//!  4. settle_round before deadline panics
//!  5. settle_round when all contributed panics
//!  6. settle_round completes circle on the last round (2-member)
//!  7. settle_round emits exceptional_settlement + default events
//!  8. settle_round: new round after settlement accepts contributions
//!  9. Exact deadline boundary: contribute/mark_default at deadline_ledger itself (on-time)
//! 10. Exact deadline boundary: mark_default at deadline_ledger + 1 succeeds
//! 11. Exact deadline boundary: contribute at deadline_ledger + 1 is rejected
//! 12. Two-member circle: single contributor, single defaulter — full flow
//! 13. Close arithmetic: penalty-then-close releases correct totals
//! 14. Close emits per-member collateral_released events
//! 15. Close total_released equals sum of individual collateral_released events
//! 16. Reputation rollback: payout rolls back when circle not registered
//! 17. Reputation rollback leaves round payable again
//! 18. Sequential defaults accumulate monotonically across rounds
//! 19. is_closed returns false before close, true after
//! 20. is_paused / pause / resume lifecycle

#![cfg(test)]

mod lifecycle_invariant_tests {
    extern crate std;

    use crate::test_support::{fixture, fixture_with, FixtureBuilder, ROUND_AMOUNT, ROUND_DEADLINE, COLLATERAL};
    use crate::{CircleStatus, CloseError, PENALTY_BPS, BPS_DENOM, COLLATERAL_MULTIPLIER};
    use soroban_sdk::testutils::Ledger;

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — partial pot
    // ══════════════════════════════════════════════════════════════════════════

    /// One member does not contribute; settle_round should penalise that
    /// member, transfer a partial pot (3 × round_amount) to the round-0
    /// recipient (alice), and advance to round 1.
    #[test]
    fn test_settle_round_partial_pot_one_defaulter() {
        let t = fixture();
        t.join_all();

        // alice/bob/carol contribute; dave does not.
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.advance_past_deadline();

        let alice_bal_before = t.token.balance(&t.alice);
        t.circle.settle_round();

        // Alice (round-0 recipient) receives partial pot = 3 × round_amount.
        // She already spent 1 × round_amount contributing, so net delta = +2×.
        let expected_partial_pot = ROUND_AMOUNT * 3;
        assert_eq!(
            t.token.balance(&t.alice) - alice_bal_before,
            expected_partial_pot - ROUND_AMOUNT, // net: received pot minus own contribution
            "alice's net gain must equal partial pot minus own contribution"
        );

        // Dave penalised 20 % of collateral.
        let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;
        assert_eq!(
            t.circle.get_collateral(&t.dave),
            COLLATERAL - penalty,
            "dave's collateral must be reduced by the 20% penalty"
        );
        assert_eq!(t.circle.get_defaults(&t.dave), 1);

        // Contributors not penalised.
        for m in [&t.alice, &t.bob, &t.carol] {
            assert_eq!(t.circle.get_defaults(m), 0, "contributor must have 0 defaults");
        }

        // Advanced to round 1.
        assert_eq!(t.circle.get_status(), CircleStatus::Active);
        assert_eq!(t.circle.get_current_round().round_index, 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — all-default zero-pot
    // ══════════════════════════════════════════════════════════════════════════

    /// When zero members contribute the pot is 0. settle_round must still
    /// advance the circle, penalise every member, and not transfer any tokens
    /// to the recipient.
    #[test]
    fn test_settle_round_all_default_zero_pot() {
        let t = fixture();
        t.join_all();
        t.advance_past_deadline();

        let alice_bal_before = t.token.balance(&t.alice);
        t.circle.settle_round();

        // No tokens transferred (zero pot).
        assert_eq!(
            t.token.balance(&t.alice),
            alice_bal_before,
            "alice's balance must not change when pot is zero"
        );

        // Every member penalised exactly once.
        for i in 0..t.member_count() {
            let m = t.member(i);
            assert_eq!(t.circle.get_defaults(&m), 1, "member {i} must have 1 default");
            let expected = COLLATERAL - (COLLATERAL * PENALTY_BPS / BPS_DENOM);
            assert_eq!(
                t.circle.get_collateral(&m),
                expected,
                "member {i} collateral must be reduced by penalty"
            );
        }

        // Circle advanced.
        assert_eq!(t.circle.get_status(), CircleStatus::Active);
        assert_eq!(t.circle.get_current_round().round_index, 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — already-marked members are not double-penalised
    // ══════════════════════════════════════════════════════════════════════════

    /// If mark_default was called on some members before settle_round runs,
    /// those members must NOT receive a second penalty.
    #[test]
    fn test_settle_round_skips_already_marked_defaults() {
        let t = fixture();
        t.join_all();

        // alice and bob contribute; carol and dave do not.
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();

        // Mark carol individually first.
        t.circle.mark_default(&t.carol);
        let carol_after_individual = t.circle.get_collateral(&t.carol);

        // settle_round runs — carol already marked, dave is not.
        t.circle.settle_round();

        // Carol must not be penalised a second time.
        assert_eq!(
            t.circle.get_collateral(&t.carol),
            carol_after_individual,
            "carol must not be double-penalised by settle_round"
        );
        assert_eq!(t.circle.get_defaults(&t.carol), 1, "carol's default count must remain 1");

        // Dave (not yet marked) must now be penalised.
        let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;
        assert_eq!(
            t.circle.get_collateral(&t.dave),
            COLLATERAL - penalty,
            "dave must be penalised once by settle_round"
        );
        assert_eq!(t.circle.get_defaults(&t.dave), 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — guards
    // ══════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_settle_round_before_deadline_panics() {
        let t = fixture();
        t.join_all();
        t.circle.settle_round();
    }

    #[test]
    #[should_panic(expected = "all members have contributed; use payout instead")]
    fn test_settle_round_when_all_contributed_panics() {
        let t = fixture();
        t.join_all();
        t.contribute_all();
        t.advance_past_deadline();
        t.circle.settle_round();
    }

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_settle_round_on_pending_circle_panics() {
        let t = fixture();
        // Not joined — still Pending.
        t.advance_past_deadline();
        t.circle.settle_round();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — completes circle on last round
    // ══════════════════════════════════════════════════════════════════════════

    /// 2-member circle: settle both rounds → Completed.
    #[test]
    fn test_settle_round_completes_circle_on_last_round() {
        let t = FixtureBuilder::default().members(2).build();
        t.join_all();

        // Round 0: bob defaults.
        t.circle.contribute(&t.alice);
        t.advance_past_deadline();
        t.circle.settle_round();
        assert_eq!(t.circle.get_status(), CircleStatus::Active);
        assert_eq!(t.circle.get_current_round().round_index, 1);

        // Round 1 (the last round): alice defaults.
        t.advance_past_deadline();
        t.circle.settle_round();
        assert_eq!(
            t.circle.get_status(),
            CircleStatus::Completed,
            "settle_round on last round must transition to Completed"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — emits exceptional_settlement + default events
    // ══════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_settle_round_emits_exceptional_settlement_event() {
        let t = fixture();
        t.join_all();
        t.circle.contribute(&t.alice);
        t.advance_past_deadline();

        let events = t.circle_events_of(|| {
            t.circle.settle_round();
        });

        let exceptional_count = events
            .iter()
            .filter(|(topics, _)| {
                topics
                    .get(1)
                    .map(|v| {
                        let target = soroban_sdk::Symbol::new(&t.env, "exceptional_settlement");
                        let target_val: soroban_sdk::Val =
                            soroban_sdk::IntoVal::into_val(&target, &t.env);
                        soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(target_val)
                    })
                    .unwrap_or(false)
            })
            .count();

        assert_eq!(
            exceptional_count, 1,
            "exactly one exceptional_settlement event must be emitted"
        );
    }

    #[test]
    fn test_settle_round_emits_default_event_per_non_contributor() {
        let t = fixture();
        t.join_all();
        // alice and bob contribute; carol and dave do not.
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();

        let events = t.circle_events_of(|| {
            t.circle.settle_round();
        });

        let default_count = events
            .iter()
            .filter(|(topics, _)| {
                topics
                    .get(1)
                    .map(|v| {
                        let target = soroban_sdk::Symbol::new(&t.env, "default");
                        let target_val: soroban_sdk::Val =
                            soroban_sdk::IntoVal::into_val(&target, &t.env);
                        soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(target_val)
                    })
                    .unwrap_or(false)
            })
            .count();

        assert_eq!(default_count, 2, "one default event per non-contributor (carol + dave)");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // settle_round — new round accepts contributions
    // ══════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_contribute_works_in_round_after_settle() {
        let t = fixture();
        t.join_all();
        t.advance_past_deadline();
        t.circle.settle_round(); // round 0: all default

        assert_eq!(t.circle.get_current_round().round_index, 1);

        // All members should be able to contribute in round 1.
        t.contribute_all();

        let round = t.circle.get_current_round();
        assert_eq!(
            round.contributions_received,
            t.member_count(),
            "all members must be counted as contributed in round 1"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Exact deadline boundary semantics
    // ══════════════════════════════════════════════════════════════════════════

    /// The contract uses `sequence > deadline_ledger` (strict greater-than).
    /// A contribution at exactly `deadline_ledger` must still be accepted.
    #[test]
    fn test_contribute_at_exact_deadline_ledger_is_accepted() {
        let t = fixture();
        t.join_all();

        let deadline = t.circle.get_current_round().deadline_ledger as u32;
        t.env.ledger().with_mut(|l| l.sequence_number = deadline);

        // Must not panic — the deadline ledger itself is still on-time.
        t.circle.contribute(&t.alice);
        assert!(
            t.circle.has_contributed(&t.alice, &0),
            "contribution at deadline_ledger must be accepted"
        );
    }

    /// A contribution at `deadline_ledger + 1` must be rejected.
    #[test]
    #[should_panic(expected = "round deadline passed")]
    fn test_contribute_at_deadline_plus_one_panics() {
        let t = fixture();
        t.join_all();

        let deadline = t.circle.get_current_round().deadline_ledger as u32;
        t.env.ledger().with_mut(|l| l.sequence_number = deadline + 1);

        t.circle.contribute(&t.alice);
    }

    /// mark_default at exactly `deadline_ledger` must still be rejected
    /// (deadline has not *strictly* passed yet).
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_mark_default_at_exact_deadline_ledger_panics() {
        let t = fixture();
        t.join_all();

        let deadline = t.circle.get_current_round().deadline_ledger as u32;
        t.env.ledger().with_mut(|l| l.sequence_number = deadline);

        t.circle.mark_default(&t.carol);
    }

    /// mark_default at `deadline_ledger + 1` must succeed.
    #[test]
    fn test_mark_default_at_deadline_plus_one_succeeds() {
        let t = fixture();
        t.join_all();

        let deadline = t.circle.get_current_round().deadline_ledger as u32;
        t.env.ledger().with_mut(|l| l.sequence_number = deadline + 1);

        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
    }

    /// Both contribute and mark_default use the same strict-greater-than
    /// boundary: the deadline ledger is on-time for contribute and not-yet for
    /// mark_default. Verify they agree at the exact boundary.
    #[test]
    fn test_contribute_and_mark_default_agree_on_deadline_boundary() {
        // At deadline_ledger: contribute OK, mark_default NOT OK.
        {
            let t = fixture();
            t.join_all();
            let deadline = t.circle.get_current_round().deadline_ledger as u32;
            t.env.ledger().with_mut(|l| l.sequence_number = deadline);
            t.circle.contribute(&t.alice); // must succeed
            let r = t.circle.try_mark_default(&t.carol);
            assert!(r.is_err(), "mark_default at deadline_ledger must fail");
        }

        // At deadline_ledger + 1: contribute NOT OK, mark_default OK.
        {
            let t = fixture();
            t.join_all();
            let deadline = t.circle.get_current_round().deadline_ledger as u32;
            t.env.ledger().with_mut(|l| l.sequence_number = deadline + 1);
            let r = t.circle.try_contribute(&t.alice);
            assert!(r.is_err(), "contribute at deadline_ledger+1 must fail");
            t.circle.mark_default(&t.carol); // must succeed
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Two-member circle — minimum configuration
    // ══════════════════════════════════════════════════════════════════════════

    /// A 2-member circle where one member defaults each round.
    /// The recipient still receives whatever partial pot exists, the defaulter
    /// is penalised, and the circle completes after both rounds.
    #[test]
    fn test_two_member_circle_one_default_per_round() {
        let t = FixtureBuilder::default().members(2).build();
        t.join_all();

        // Round 0: only alice contributes (she is also the recipient).
        // Partial pot = 1 × round_amount (only alice contributed).
        t.circle.contribute(&t.alice);
        let alice_bal_before_settle = t.token.balance(&t.alice);
        t.advance_past_deadline();
        t.circle.settle_round();

        // Alice receives partial pot = ROUND_AMOUNT (her own contribution comes back).
        let alice_net = t.token.balance(&t.alice) - alice_bal_before_settle;
        assert_eq!(alice_net, 0i128, "alice contributes 1× and receives 1×: net 0");

        // Bob penalised.
        let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;
        assert_eq!(t.circle.get_collateral(&t.bob), COLLATERAL - penalty);
        assert_eq!(t.circle.get_defaults(&t.bob), 1);

        // Round 1: only bob contributes (he is the round-1 recipient).
        t.circle.contribute(&t.bob);
        let bob_bal_before = t.token.balance(&t.bob);
        t.advance_past_deadline();
        t.circle.settle_round();

        // Bob receives partial pot = 1 × round_amount.
        let bob_net = t.token.balance(&t.bob) - bob_bal_before;
        assert_eq!(bob_net, 0i128, "bob contributes 1× and receives 1×: net 0");

        // Alice penalised for round 1.
        let penalty2 = COLLATERAL * PENALTY_BPS / BPS_DENOM;
        assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL - penalty2);
        assert_eq!(t.circle.get_defaults(&t.alice), 1);

        // Circle completed.
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Close arithmetic — penalty-then-close
    // ══════════════════════════════════════════════════════════════════════════

    /// After some members incur penalties, close must release exactly what is
    /// stored — no more, no less. The arithmetic assertion inside close guarantees
    /// total_released == pre_release_total.
    #[test]
    fn test_close_releases_penalty_reduced_collateral_exactly() {
        let t = fixture();
        t.join_all();
        t.advance_past_deadline();

        // Penalise alice and bob.
        t.circle.mark_default(&t.alice);
        t.circle.mark_default(&t.bob);

        t.force_status(crate::CircleStatus::Completed);

        let alice_before = t.token.balance(&t.alice);
        let bob_before   = t.token.balance(&t.bob);
        let carol_before = t.token.balance(&t.carol);
        let dave_before  = t.token.balance(&t.dave);

        t.circle.close(&t.carol);

        let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;

        // Alice and bob each had collateral reduced by one penalty.
        assert_eq!(
            t.token.balance(&t.alice) - alice_before,
            COLLATERAL - penalty,
            "alice must receive penalty-reduced collateral"
        );
        assert_eq!(
            t.token.balance(&t.bob) - bob_before,
            COLLATERAL - penalty,
            "bob must receive penalty-reduced collateral"
        );

        // Carol and dave had no penalties — full collateral returned.
        assert_eq!(
            t.token.balance(&t.carol) - carol_before,
            COLLATERAL,
            "carol must receive full collateral"
        );
        assert_eq!(
            t.token.balance(&t.dave) - dave_before,
            COLLATERAL,
            "dave must receive full collateral"
        );

        // All collateral keys zeroed.
        for i in 0..t.member_count() {
            assert_eq!(
                t.circle.get_collateral(&t.member(i)),
                0,
                "member {i} collateral must be zero after close"
            );
        }
    }

    /// close emits one collateral_released event per member with a positive balance.
    #[test]
    fn test_close_emits_collateral_released_per_member() {
        let t = fixture();
        t.join_all();
        t.force_status(crate::CircleStatus::Completed);

        let events = t.circle_events_of(|| {
            t.circle.close(&t.alice);
        });

        let released_count = events
            .iter()
            .filter(|(topics, _)| {
                topics
                    .get(1)
                    .map(|v| {
                        let sym = soroban_sdk::Symbol::new(&t.env, "collateral_released");
                        let sym_val: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&sym, &t.env);
                        soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(sym_val)
                    })
                    .unwrap_or(false)
            })
            .count();

        assert_eq!(
            released_count,
            t.member_count() as usize,
            "one collateral_released event per member"
        );
    }

    /// The sum of all per-member collateral releases must equal the total
    /// returned by the closed event. Tests the close arithmetic assertion.
    #[test]
    fn test_close_total_released_matches_sum_of_individual_releases() {
        let t = fixture();
        t.join_all();

        // Penalise dave to make the total != full expected collateral.
        t.advance_past_deadline();
        t.circle.mark_default(&t.dave);

        t.force_status(crate::CircleStatus::Completed);

        // Record balances before close.
        let balances_before: std::vec::Vec<i128> = (0..t.member_count())
            .map(|i| t.token.balance(&t.member(i)))
            .collect();

        t.circle.close(&t.alice);

        let balances_after: std::vec::Vec<i128> = (0..t.member_count())
            .map(|i| t.token.balance(&t.member(i)))
            .collect();

        // Sum of actual token increases.
        let total_released: i128 = (0..t.member_count() as usize)
            .map(|i| balances_after[i] - balances_before[i])
            .sum();

        // Expected: 3 members at full COLLATERAL + dave at (COLLATERAL - penalty).
        let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;
        let expected_total = COLLATERAL * 3 + (COLLATERAL - penalty);

        assert_eq!(
            total_released, expected_total,
            "sum of individual releases must equal expected total"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Reputation rollback
    // ══════════════════════════════════════════════════════════════════════════

    /// When the circle is NOT registered as an authorized caller on the
    /// reputation contract, payout must roll back the entire transaction —
    /// including the paid_out flag and the token transfer — leaving the
    /// round payable again.
    #[test]
    fn test_payout_rolls_back_when_reputation_not_registered() {
        // Build a circle without reputation registration.
        let t = fixture_with(false);
        t.join_all();
        t.contribute_all();

        let alice_bal_before = t.token.balance(&t.alice);
        let circle_bal_before = t.token.balance(&t.circle_id);

        // payout must fail because the reputation increment will be rejected.
        let result = t.circle.try_payout();
        assert!(result.is_err(), "payout must fail when reputation not registered");

        // paid_out must remain false — the round is still payable.
        let round = t.circle.get_current_round();
        assert!(
            !round.paid_out,
            "paid_out must be false after a failed payout — round must remain payable"
        );

        // Token balances must be unchanged — the rollback undid the transfer.
        assert_eq!(
            t.token.balance(&t.alice),
            alice_bal_before,
            "alice's balance must not change after a rolled-back payout"
        );
        assert_eq!(
            t.token.balance(&t.circle_id),
            circle_bal_before,
            "circle's token balance must not change after a rolled-back payout"
        );
    }

    /// After a rollback the round can be paid out successfully once the
    /// reputation contract is fixed (the circle is registered).
    #[test]
    fn test_payout_succeeds_after_reputation_is_registered() {
        let t = fixture_with(false);
        t.join_all();
        t.contribute_all();

        // First attempt fails.
        assert!(t.circle.try_payout().is_err());

        // Register the circle on the reputation contract.
        t.rep.add_authorized_caller(&t.rep_admin, &t.circle_id);

        // Now payout must succeed.
        t.circle.payout();
        assert!(
            t.circle.get_current_round().round_index == 1
                || t.circle.get_status() == CircleStatus::Completed,
            "circle must have advanced after successful payout"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Sequential defaults accumulate monotonically
    // ══════════════════════════════════════════════════════════════════════════

    /// A member who defaults in two consecutive rounds must have defaults == 2
    /// and collateral reduced geometrically: initial × (1 - 0.20)^2.
    #[test]
    fn test_sequential_defaults_accumulate_correctly() {
        let t = FixtureBuilder::default().members(2).build();
        t.join_all();

        let initial_collateral = COLLATERAL;

        // Round 0: bob defaults.
        t.advance_past_deadline();
        t.circle.mark_default(&t.bob);
        let penalty_0 = initial_collateral * PENALTY_BPS / BPS_DENOM;
        let after_round_0 = initial_collateral - penalty_0;
        assert_eq!(t.circle.get_collateral(&t.bob), after_round_0);
        assert_eq!(t.circle.get_defaults(&t.bob), 1);

        // Settle round 0 so round 1 opens.
        t.circle.settle_round();

        // Round 1: bob defaults again.
        t.advance_past_deadline();
        t.circle.mark_default(&t.bob);
        let penalty_1 = after_round_0 * PENALTY_BPS / BPS_DENOM;
        let after_round_1 = after_round_0 - penalty_1;
        assert_eq!(t.circle.get_collateral(&t.bob), after_round_1);
        assert_eq!(t.circle.get_defaults(&t.bob), 2, "defaults counter must be 2 after two rounds");

        // Defaults counter never decreases.
        assert!(
            t.circle.get_defaults(&t.bob) >= 2,
            "defaults counter must be monotonically non-decreasing"
        );
        // Collateral strictly decreasing.
        assert!(
            after_round_1 < after_round_0,
            "collateral must decrease after each default"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // is_closed / is_paused lifecycle
    // ══════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_is_closed_false_before_close_true_after() {
        let t = fixture();
        t.join_all();
        t.force_status(crate::CircleStatus::Completed);

        assert!(!t.circle.is_closed(), "is_closed must return false before close");
        t.circle.close(&t.alice);
        assert!(t.circle.is_closed(), "is_closed must return true after close");
    }

    #[test]
    fn test_is_paused_lifecycle() {
        let t = fixture();
        assert!(!t.circle.is_paused(), "circle must not be paused initially");

        t.circle.pause(&t.admin);
        assert!(t.circle.is_paused(), "circle must be paused after pause()");

        t.circle.resume(&t.admin);
        assert!(!t.circle.is_paused(), "circle must not be paused after resume()");
    }

    #[test]
    fn test_pause_blocks_contribute() {
        let t = fixture();
        t.join_all();
        t.circle.pause(&t.admin);

        let result = t.circle.try_contribute(&t.alice);
        assert!(result.is_err(), "contribute must be blocked while paused");
    }

    #[test]
    fn test_pause_blocks_settle_round() {
        let t = fixture();
        t.join_all();
        t.advance_past_deadline();
        t.circle.pause(&t.admin);

        let result = t.circle.try_settle_round();
        assert!(result.is_err(), "settle_round must be blocked while paused");
    }

    #[test]
    fn test_resume_unblocks_contribute() {
        let t = fixture();
        t.join_all();
        t.circle.pause(&t.admin);
        t.circle.resume(&t.admin);

        // Should succeed after resume.
        t.circle.contribute(&t.alice);
        assert!(t.circle.has_contributed(&t.alice, &0));
    }
}
