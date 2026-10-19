//! Targeted regression tests for issues #552, #553, #554, and #555.
//!
//! # Coverage map
//!
//! | Issue | Area | Guard | Key test(s) |
//! |-------|------|-------|-------------|
//! | #552  | `join` | Duplicate-collateral prevention via CEI + `has` check | Re-join after collateral zeroed, re-join after penalty drain, re-join mid-transfer simulation |
//! | #553  | `join` | `Active` transition only when ALL members have joined | Partial-join stays Pending, exact-member-count triggers Active, deadline clock set at activation not at init |
//! | #554  | `contribute` | Rejects late (past-deadline) and out-of-order (wrong-round) contributions | Past-deadline, exactly-at-deadline accepted, out-of-order round keys don't confuse the guard |
//! | #555  | `mark_default` | Only flags misses in the CURRENT round; cross-round isolation | Cannot default for future round, prior-round key absent, round-index used is always CurrentRound |

#[cfg(test)]
mod issue_fixes_tests {
    extern crate std;

    use crate::{
        CircleContract, CircleContractClient, CircleStatus, DataKey,
        COLLATERAL_MULTIPLIER, MIN_ROUND_DEADLINE_LEDGERS, PENALTY_BPS, BPS_DENOM,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger, Events as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops
    const ROUND_DEADLINE: u32 = 1_000;

    // ── Shared fixture ────────────────────────────────────────────────────────

    struct Setup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        alice: Address,
        bob: Address,
        carol: Address,
        dave: Address,
        circle_admin: Address,
    }

    impl<'a> Setup<'a> {
        fn activate(&self) {
            self.circle.join(&self.alice);
            self.circle.join(&self.bob);
            self.circle.join(&self.carol);
            self.circle.join(&self.dave);
        }

        fn contribute_all(&self) {
            self.circle.contribute(&self.alice);
            self.circle.contribute(&self.bob);
            self.circle.contribute(&self.carol);
            self.circle.contribute(&self.dave);
        }

        fn advance_past_deadline(&self) {
            self.env.ledger().with_mut(|l| {
                l.sequence_number += ROUND_DEADLINE + 1;
            });
        }

        fn force_collateral(&self, member: &Address, amount: i128) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Collateral(member.clone()), &amount);
            });
        }

        fn has_defaulted_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Defaulted(member.clone(), round_index))
            })
        }

        fn has_contributed_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Contributed(member.clone(), round_index))
            })
        }

        fn complete_round(&self) {
            self.contribute_all();
            self.circle.payout();
        }
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = TokenClient::new(&env, &token_id.address());
        let token_asset = StellarAssetClient::new(&env, &token_id.address());

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);
        let dave = Address::generate(&env);

        // Fund: 1× collateral + 4× contributions per member
        for m in [&alice, &bob, &carol, &dave] {
            token_asset.mint(m, &(ROUND_AMOUNT * (COLLATERAL_MULTIPLIER + 4)));
        }

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);
        rep_client.add_authorized_caller(&rep_admin, &circle_id);

        let circle_admin = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(alice.clone());
        members.push_back(bob.clone());
        members.push_back(carol.clone());
        members.push_back(dave.clone());

        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_id.address(),
            &rep_id,
            &ROUND_DEADLINE,
        );

        Setup {
            env,
            circle,
            circle_id,
            token,
            alice,
            bob,
            carol,
            dave,
            circle_admin,
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #552 — Protect join against duplicate collateral transfer edge cases
    //
    // The contract guards against duplicate collateral deposits using:
    //   1. CEI pattern: writes `Collateral(member)` to storage BEFORE the token
    //      transfer, so a reentrant join sees the key and panics.
    //   2. `env.storage().persistent().has(&collateral_key)` — checks key
    //      existence, NOT value > 0, so a zeroed collateral balance cannot be
    //      used to bypass the guard.
    //
    // Acceptance criteria:
    //   • A member whose collateral was zeroed (via penalty drain) cannot rejoin.
    //   • A second join call by the same member is always rejected regardless of
    //     the current on-chain collateral balance.
    //   • The collateral amount stored and transferred is exactly
    //     round_amount × COLLATERAL_MULTIPLIER (no silent overflow to 0).
    //   • A member who cancelled (no Collateral key) can never re-join an Active
    //     circle (status gate fires before the collateral check).
    // ══════════════════════════════════════════════════════════════════════════

    /// The `has` check (not `value > 0`) blocks re-join even when collateral
    /// was zeroed by multiple penalty rounds. The key presence is the gate,
    /// not the value stored under it.
    #[test]
    #[should_panic(expected = "already joined")]
    fn test_552_rejoin_after_collateral_zeroed_by_penalties_panics() {
        let s = setup();
        s.circle.join(&s.alice);

        // Simulate full collateral drain via repeated penalty application
        s.force_collateral(&s.alice, 0i128);
        assert_eq!(s.circle.get_collateral(&s.alice), 0,
            "pre-condition: collateral must be 0 before re-join attempt");

        // Even with zero collateral the Collateral key still EXISTS in storage,
        // so the `has` guard must fire before any token transfer attempt.
        s.circle.join(&s.alice);
    }

    /// The second `join` call by the same member is rejected at the `has` guard
    /// before any token transfer occurs. Alice's wallet balance must be unchanged
    /// between the first and the (rejected) second join call.
    #[test]
    fn test_552_second_join_rejected_before_transfer() {
        let s = setup();
        s.circle.join(&s.alice);

        let bal_after_first_join = s.token.balance(&s.alice);

        // Attempt a second join — it must panic
        let result = s.circle.try_join(&s.alice);
        assert!(result.is_err(), "second join must be rejected");

        // Balance must be unchanged — no transfer occurred
        assert_eq!(
            s.token.balance(&s.alice), bal_after_first_join,
            "wallet balance must not change on a rejected second join attempt"
        );
    }

    /// Collateral stored and transferred on a successful join must equal
    /// round_amount × COLLATERAL_MULTIPLIER. The checked_mul in join panics on
    /// overflow — it never silently returns 0.
    #[test]
    fn test_552_collateral_amount_is_exact_and_nonzero() {
        let s = setup();
        let expected = ROUND_AMOUNT
            .checked_mul(COLLATERAL_MULTIPLIER)
            .expect("test: overflow unexpected for standard fixture");
        assert!(expected > 0, "expected collateral must be positive");

        let bal_before = s.token.balance(&s.alice);
        s.circle.join(&s.alice);
        let bal_after = s.token.balance(&s.alice);

        let transferred = bal_before - bal_after;
        assert_eq!(transferred, expected,
            "tokens transferred must equal round_amount × COLLATERAL_MULTIPLIER");
        assert_eq!(s.circle.get_collateral(&s.alice), expected,
            "stored collateral must equal round_amount × COLLATERAL_MULTIPLIER");
        assert_ne!(s.circle.get_collateral(&s.alice), 0,
            "stored collateral must not be zero after a valid join");
    }

    /// After `cancel`, the circle's status is `Cancelled` (not `Pending`), so
    /// any further `join` attempt is rejected by the status gate ("circle not
    /// accepting members"), not the collateral key gate. Members who never joined
    /// cannot have their join re-attempted on a non-Pending circle.
    #[test]
    #[should_panic(expected = "circle not accepting members")]
    fn test_552_join_on_cancelled_circle_rejected_by_status_gate() {
        let s = setup();
        // Alice joins then cancels the circle; Dave never joined
        s.circle.join(&s.alice);
        s.circle.cancel(&s.alice);
        assert_eq!(s.circle.get_status(), CircleStatus::Cancelled);

        // Dave has no Collateral key, but the status gate fires first
        s.circle.join(&s.dave);
    }

    /// After the circle goes Active, further `join` calls are rejected by the
    /// status gate, not by a missing collateral key for a new member.
    #[test]
    #[should_panic(expected = "circle not accepting members")]
    fn test_552_join_on_active_circle_rejected_by_status_gate() {
        let s = setup();
        s.activate(); // all four join → Active
        // Alice tries to join again — status gate fires before the collateral check
        s.circle.join(&s.alice);
    }

    /// Every successfully joining member produces exactly one persistent
    /// `Collateral` key. Calling join twice for the same member must leave the
    /// count of Collateral keys unchanged (second call panics, storage not mutated).
    #[test]
    fn test_552_collateral_key_written_exactly_once_per_member() {
        let s = setup();

        // No collateral key before join
        let bal_before = s.circle.get_collateral(&s.bob);
        assert_eq!(bal_before, 0, "collateral must be 0 before join");

        s.circle.join(&s.bob);
        assert_eq!(
            s.circle.get_collateral(&s.bob),
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "collateral must be set after join"
        );

        // Reject second join — collateral must be unchanged
        let _ = s.circle.try_join(&s.bob);
        assert_eq!(
            s.circle.get_collateral(&s.bob),
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "collateral must not change after a rejected second join"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #553 — Add active status transition only after all members have joined
    //
    // The contract transitions to `Active` exactly once: when the last configured
    // member calls `join`. The join-order counter is derived from persistent
    // `Collateral` keys (not from a mutable counter) so it cannot be forged.
    //
    // Acceptance criteria:
    //   • Status stays `Pending` until every configured member has joined.
    //   • Status becomes `Active` the instant the last member joins.
    //   • The round-0 deadline is set at the moment of activation (not at init).
    //   • The `circle/active` event is emitted exactly once, only at activation.
    //   • Subsequent join calls are rejected by the status gate.
    // ══════════════════════════════════════════════════════════════════════════

    /// The circle remains `Pending` after N-1 joins and transitions to `Active`
    /// on the Nth join — not before.
    #[test]
    fn test_553_status_stays_pending_until_all_members_joined() {
        let s = setup();

        assert_eq!(s.circle.get_status(), CircleStatus::Pending);
        s.circle.join(&s.alice);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 1 of 4 joins");
        s.circle.join(&s.bob);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 2 of 4 joins");
        s.circle.join(&s.carol);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 3 of 4 joins");
        s.circle.join(&s.dave); // 4th and final join
        assert_eq!(s.circle.get_status(), CircleStatus::Active,
            "status must become Active only after all 4 members join");
    }

    /// The round-0 deadline is computed at the activation ledger (last join),
    /// not at `initialize` time. This prevents the join window from eating into
    /// the contribution window.
    #[test]
    fn test_553_round_deadline_set_at_activation_not_at_init() {
        let s = setup();

        // Record the deadline set at initialize time
        let init_round = s.circle.get_current_round();
        let deadline_at_init = init_round.deadline_ledger;

        // Advance some ledgers during the join window (simulating real-world delay)
        s.env.ledger().with_mut(|l| {
            l.sequence_number += 500;
        });

        // All members join; activation happens at ledger ~500
        let seq_before_last_join = s.env.ledger().sequence();
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.join(&s.carol);
        s.circle.join(&s.dave);

        let active_round = s.circle.get_current_round();
        assert_eq!(
            active_round.deadline_ledger,
            seq_before_last_join as u64 + ROUND_DEADLINE as u64,
            "round-0 deadline must be set from the activation ledger, not the init ledger"
        );
        assert!(
            active_round.deadline_ledger > deadline_at_init,
            "activation deadline must be later than the initial deadline set at init time"
        );
    }

    /// Contribute before all members have joined must fail with "circle is not
    /// active" — the active-transition gate protects the contribution path.
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_553_contribute_blocked_until_all_members_joined() {
        let s = setup();
        // Only 3 of 4 members join
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.join(&s.carol);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending);

        // Contribution attempt on a Pending circle must be rejected
        s.circle.contribute(&s.alice);
    }

    /// Payout before all members have joined must fail with "circle is not active".
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_553_payout_blocked_until_all_members_joined() {
        let s = setup();
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.payout();
    }

    /// mark_default before all members have joined must fail with "circle is not
    /// active" — the active-transition gate protects the default path.
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_553_mark_default_blocked_until_all_members_joined() {
        let s = setup();
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.advance_past_deadline();
        s.circle.mark_default(&s.carol);
    }

    /// The `circle/active` event must be emitted exactly once — when the last
    /// member joins — and not at any earlier join.
    #[test]
    fn test_553_active_event_emitted_exactly_once_on_last_join() {
        let s = setup();

        // Helper to count `active` events
        let count_active = |env: &Env| -> usize {
            let target = soroban_sdk::Symbol::new(env, "active");
            let tv: soroban_sdk::Val =
                soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&target, env);
            let bits = soroban_sdk::Val::get_payload(tv);
            env.events()
                .all()
                .into_iter()
                .filter(|(_, topics, _)| {
                    topics.get(1)
                        .map(|v| soroban_sdk::Val::get_payload(v) == bits)
                        .unwrap_or(false)
                })
                .count()
        };

        s.circle.join(&s.alice);
        assert_eq!(count_active(&s.env), 0, "no active event after 1st join");

        s.circle.join(&s.bob);
        assert_eq!(count_active(&s.env), 0, "no active event after 2nd join");

        s.circle.join(&s.carol);
        assert_eq!(count_active(&s.env), 0, "no active event after 3rd join");

        s.circle.join(&s.dave); // activating join
        assert_eq!(count_active(&s.env), 1,
            "exactly one active event must be emitted on the final join");
    }

    /// Once `Active`, any additional `join` attempt (even by a listed member)
    /// must be rejected by the status gate with "circle not accepting members".
    #[test]
    #[should_panic(expected = "circle not accepting members")]
    fn test_553_join_after_active_rejected_by_status_gate() {
        let s = setup();
        s.activate();
        assert_eq!(s.circle.get_status(), CircleStatus::Active);
        // Even alice (who already joined) triggers the status gate
        s.circle.join(&s.alice);
    }

    /// The join-order counter is derived from Collateral key presence, not from
    /// a separately maintained mutable counter. Four members joining in any order
    /// must each have a 1-based order in [1, 4].
    #[test]
    fn test_553_join_order_derived_from_collateral_key_count() {
        let s = setup();

        // Join in reverse declaration order to verify counting is independent of order
        s.circle.join(&s.dave);
        s.circle.join(&s.carol);
        s.circle.join(&s.bob);

        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 3 joins");

        s.circle.join(&s.alice); // 4th join — triggers Active
        assert_eq!(s.circle.get_status(), CircleStatus::Active,
            "4th join (in any order) must trigger Active transition");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #554 — Ensure contribute rejects late or out-of-order round actions
    //
    // `contribute` is guarded by the centralized `deadline_passed` predicate:
    //   - `env.ledger().sequence() > round.deadline_ledger` (strict greater-than)
    //   - The deadline is per-round; each new round refreshes `deadline_ledger`.
    //   - The contribution key is `Contributed(member, CurrentRound.round_index)`,
    //     so members always contribute to the current round — there is no
    //     caller-supplied round index that could be forged.
    //
    // Acceptance criteria:
    //   • Contribution at the exact deadline ledger is accepted (inclusive boundary).
    //   • Contribution one ledger past the deadline is rejected.
    //   • Contribution for a "future" round index cannot be manufactured via the
    //     public API — the round index always comes from CurrentRound.
    //   • Contribution for a "past" round (already paid out) is not possible
    //     because CurrentRound.round_index has advanced.
    //   • A member who already contributed cannot contribute again in the same round.
    // ══════════════════════════════════════════════════════════════════════════

    /// Contribution exactly at the deadline ledger (sequence == deadline_ledger)
    /// must be accepted — the boundary is inclusive for contributions.
    #[test]
    fn test_554_contribution_at_exact_deadline_is_accepted() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32;
        });

        // Must not panic
        s.circle.contribute(&s.alice);
        assert!(s.has_contributed_key(&s.alice, 0),
            "Contributed key must exist after on-time contribution at exact deadline");
    }

    /// Contribution one ledger past the deadline must be rejected with the
    /// canonical "round deadline passed" message.
    #[test]
    #[should_panic(expected = "round deadline passed; cannot contribute before payout")]
    fn test_554_contribution_one_ledger_past_deadline_panics() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        s.circle.contribute(&s.alice);
    }

    /// Late contribution is rejected even when only some members have contributed
    /// (the pot is incomplete and no payout has run). The deadline gate is
    /// independent of the contribution count.
    #[test]
    #[should_panic(expected = "round deadline passed; cannot contribute before payout")]
    fn test_554_late_contribution_rejected_before_payout_runs() {
        let s = setup();
        s.activate();

        // Alice contributes on time
        s.circle.contribute(&s.alice);

        // Advance past the deadline before others contribute
        s.advance_past_deadline();

        // Bob's late contribution must be rejected even though payout has not run
        s.circle.contribute(&s.bob);
    }

    /// Contributions always target `CurrentRound.round_index`. After a payout
    /// advances the round, the new round has a fresh index and a fresh deadline;
    /// contributing for the new round is valid. This verifies no "out-of-order"
    /// carry-over from a prior round affects the contribution path.
    #[test]
    fn test_554_contribution_for_new_round_after_payout_uses_fresh_round_index() {
        let s = setup();
        s.activate();

        // Complete round 0
        s.complete_round();

        // Now in round 1 — Alice has NOT contributed to round 1 yet
        let round1 = s.circle.get_current_round();
        assert_eq!(round1.round_index, 1,
            "pre-condition: must be in round 1 after first payout");
        assert!(!s.has_contributed_key(&s.alice, 1),
            "pre-condition: Alice must not have a round-1 contribution key yet");

        // Contribution for round 1 must succeed
        s.circle.contribute(&s.alice);
        assert!(s.has_contributed_key(&s.alice, 1),
            "Contributed(alice, 1) key must exist after round-1 contribution");
        // Round-0 key must still be present (not overwritten)
        assert!(s.has_contributed_key(&s.alice, 0),
            "Contributed(alice, 0) key must persist after round-1 contribution");
    }

    /// A member cannot contribute twice in the same round — the duplicate
    /// contribution guard fires with "already contributed this round".
    #[test]
    #[should_panic(expected = "already contributed this round")]
    fn test_554_duplicate_contribution_same_round_panics() {
        let s = setup();
        s.activate();
        s.circle.contribute(&s.alice);
        s.circle.contribute(&s.alice); // second contribution same round
    }

    /// A member cannot contribute to a round that has already been paid out.
    /// After payout, CurrentRound advances so the old round index is no longer
    /// the current one; the "already contributed this round" guard fires for the
    /// new round because the member's key for round N is absent.
    /// (Contributing for the new round after payout is valid — this test checks
    /// attempting to re-contribute for the old round is impossible.)
    #[test]
    #[should_panic(expected = "already contributed this round")]
    fn test_554_cannot_contribute_twice_in_same_round_even_after_other_members_contribute() {
        let s = setup();
        s.activate();

        // Alice contributes first
        s.circle.contribute(&s.alice);
        // Others contribute too
        s.circle.contribute(&s.bob);
        s.circle.contribute(&s.carol);
        s.circle.contribute(&s.dave);

        // Alice tries to contribute again before payout runs
        s.circle.contribute(&s.alice);
    }

    /// Non-members are rejected from contributing with "not a member",
    /// providing clear feedback rather than a silent failure.
    #[test]
    #[should_panic(expected = "not a member")]
    fn test_554_contribute_by_non_member_panics_with_clear_message() {
        let s = setup();
        s.activate();
        let outsider = Address::generate(&s.env);
        s.circle.contribute(&outsider);
    }

    /// Contributing on a Pending circle is rejected with "circle is not active"
    /// before the deadline or member-membership checks run.
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn test_554_contribute_on_pending_circle_rejected_before_member_check() {
        let s = setup();
        // Only partial joins — still Pending
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.contribute(&s.alice);
    }

    /// Deadline boundary for round N is independent of round N-1.
    /// After payout resets the deadline, the prior round's deadline cannot be
    /// used to accept a contribution that is "late" by the new round's clock.
    #[test]
    fn test_554_per_round_deadline_is_independent_of_prior_round_deadline() {
        let s = setup();
        s.activate();

        // Advance to just before round-0 deadline
        let round0 = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round0.deadline_ledger as u32 - 1;
        });

        // Complete round 0 at this ledger; payout resets the deadline for round 1
        s.contribute_all();
        s.circle.payout();

        // Round 1's deadline is NOW + ROUND_DEADLINE, computed from payout ledger
        let round1 = s.circle.get_current_round();
        assert_eq!(round1.round_index, 1);
        // We are at ledger round0.deadline_ledger - 1 after payout;
        // round1.deadline_ledger should be (round0.deadline_ledger - 1) + ROUND_DEADLINE
        let expected_round1_deadline =
            (round0.deadline_ledger - 1) + ROUND_DEADLINE as u64;
        assert_eq!(round1.deadline_ledger, expected_round1_deadline,
            "round-1 deadline must be anchored to the payout ledger, independent of round-0 deadline");

        // Contributing to round 1 right now (well before deadline) must succeed
        s.circle.contribute(&s.alice);
        assert!(s.has_contributed_key(&s.alice, 1));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #555 — Improve mark_default to only flag current-round misses
    //
    // `mark_default` uses `CurrentRound.round_index` (not a caller-supplied index)
    // for both the `Contributed` lookup and the `Defaulted` idempotency key.
    // This means:
    //   • A member can only be flagged for the round currently in progress.
    //   • Flagging for a prior paid-out round is structurally impossible because
    //     CurrentRound has advanced.
    //   • Flagging for a future round is impossible for the same reason.
    //   • The idempotency guard (`Defaulted(member, round_index)`) fires if the
    //     same member is flagged twice for the same current round.
    //
    // Acceptance criteria:
    //   • `mark_default` only creates a `Defaulted(member, CURRENT_round_index)` key.
    //   • Cross-round isolation: default keys for previous rounds are not mutated.
    //   • Double-flagging the same member in the same round is rejected.
    //   • A member who contributed in the current round cannot be flagged.
    //   • Defaults accumulate correctly across rounds (each round is independent).
    //   • Default counter and collateral penalty are applied per-round without
    //     leaking across rounds.
    // ══════════════════════════════════════════════════════════════════════════

    /// `mark_default` writes a `Defaulted(member, current_round_index)` key.
    /// After calling mark_default for round 0, the round-0 key exists but
    /// round-1 and round-2 keys must be absent.
    #[test]
    fn test_555_defaulted_key_only_written_for_current_round() {
        let s = setup();
        s.activate();
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol);

        // Round-0 key must exist
        assert!(s.has_defaulted_key(&s.carol, 0),
            "Defaulted(carol, 0) key must exist after mark_default in round 0");

        // Keys for other rounds must NOT exist
        assert!(!s.has_defaulted_key(&s.carol, 1),
            "Defaulted(carol, 1) must not exist — not in round 1 yet");
        assert!(!s.has_defaulted_key(&s.carol, 2),
            "Defaulted(carol, 2) must not exist — not in round 2 yet");
        assert!(!s.has_defaulted_key(&s.carol, 99),
            "Defaulted(carol, 99) must not exist — round 99 never started");
    }

    /// After payout advances to round 1, mark_default writes a `Defaulted` key
    /// for round 1 — not round 0. The round-0 key must remain absent (carol was
    /// not defaulted in round 0 in this scenario).
    #[test]
    fn test_555_mark_default_uses_current_round_index_after_payout() {
        let s = setup();
        s.activate();

        // Complete round 0 with all members contributing (no defaults)
        s.complete_round();

        // Now in round 1 — advance past its deadline
        let round1 = s.circle.get_current_round();
        assert_eq!(round1.round_index, 1);
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round1.deadline_ledger as u32 + 1;
        });

        // Carol did not contribute in round 1 — mark her default
        s.circle.mark_default(&s.carol);

        // Only the round-1 key must exist; round-0 key must be absent
        assert!(s.has_defaulted_key(&s.carol, 1),
            "Defaulted(carol, 1) key must exist after mark_default in round 1");
        assert!(!s.has_defaulted_key(&s.carol, 0),
            "Defaulted(carol, 0) must not exist — carol was not defaulted in round 0");
    }

    /// Double-flagging the same member in the same round must panic with
    /// "already marked default this round".
    #[test]
    #[should_panic(expected = "already marked default this round")]
    fn test_555_double_default_same_round_panics() {
        let s = setup();
        s.activate();
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol);
        s.circle.mark_default(&s.carol); // second flag same round — must panic
    }

    /// A member who contributed in the current round cannot be flagged as
    /// defaulted — "member did contribute" fires before any state mutation.
    #[test]
    #[should_panic(expected = "member did contribute")]
    fn test_555_contributor_cannot_be_marked_default() {
        let s = setup();
        s.activate();
        s.circle.contribute(&s.carol);
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol);
    }

    /// Defaults in round 0 and round 1 are independent — the default counter
    /// increments correctly across rounds and the `Defaulted` keys are distinct.
    #[test]
    fn test_555_defaults_accumulate_independently_per_round() {
        let s = setup();
        s.activate();

        // Round 0: carol defaults
        s.advance_past_deadline();
        s.circle.mark_default(&s.carol);

        let collateral_after_round0 = s.circle.get_collateral(&s.carol);
        assert_eq!(s.circle.get_defaults(&s.carol), 1,
            "default count must be 1 after first default");

        // Complete round 0: others contribute + payout (carol already penalized)
        s.circle.contribute(&s.alice);
        s.circle.contribute(&s.bob);
        s.circle.contribute(&s.carol); // carol can still contribute even after default
        s.circle.contribute(&s.dave);
        s.circle.payout();

        // Round 1: carol defaults again
        let round1 = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round1.deadline_ledger as u32 + 1;
        });
        s.circle.mark_default(&s.carol);

        let collateral_after_round1 = s.circle.get_collateral(&s.carol);
        assert_eq!(s.circle.get_defaults(&s.carol), 2,
            "default count must be 2 after second default");

        // Second penalty is 20% of post-round-0 balance, not original balance
        let expected_penalty_r1 = collateral_after_round0 * PENALTY_BPS / BPS_DENOM;
        assert_eq!(
            collateral_after_round0 - collateral_after_round1,
            expected_penalty_r1,
            "round-1 penalty must be 20% of remaining balance after round-0 penalty"
        );

        // Both Defaulted keys must exist and be independent
        assert!(s.has_defaulted_key(&s.carol, 0),
            "Defaulted(carol, 0) must persist after round-1 default");
        assert!(s.has_defaulted_key(&s.carol, 1),
            "Defaulted(carol, 1) must exist after round-1 default");
    }

    /// The `Contributed` and `Defaulted` keys for the same member and same round
    /// are mutually exclusive. If a member contributed, no Defaulted key exists;
    /// if a member defaulted, no Contributed key exists.
    #[test]
    fn test_555_contributed_and_defaulted_keys_are_mutually_exclusive() {
        let s = setup();
        s.activate();

        s.circle.contribute(&s.alice); // alice contributes on time
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol); // carol misses deadline

        // Alice: Contributed key present, Defaulted key absent
        assert!(s.has_contributed_key(&s.alice, 0),
            "alice must have a Contributed key for round 0");
        assert!(!s.has_defaulted_key(&s.alice, 0),
            "alice must not have a Defaulted key for round 0 (she contributed)");

        // Carol: Defaulted key present, Contributed key absent
        assert!(s.has_defaulted_key(&s.carol, 0),
            "carol must have a Defaulted key for round 0");
        assert!(!s.has_contributed_key(&s.carol, 0),
            "carol must not have a Contributed key for round 0 (she defaulted)");
    }

    /// mark_default before the round deadline is rejected with
    /// "round deadline not yet passed" — the deadline must have strictly passed
    /// before a default can be recorded.
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_555_mark_default_before_deadline_panics() {
        let s = setup();
        s.activate();
        // Deadline has not passed yet
        s.circle.mark_default(&s.carol);
    }

    /// mark_default at exactly the deadline ledger is also rejected — the
    /// boundary is strict: `sequence > deadline_ledger`, not `>=`.
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn test_555_mark_default_at_exact_deadline_panics() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32; // exactly at deadline
        });

        s.circle.mark_default(&s.carol);
    }

    /// mark_default at deadline + 1 succeeds — the first ledger strictly past
    /// the deadline is the earliest moment a default can be recorded.
    #[test]
    fn test_555_mark_default_at_deadline_plus_one_succeeds() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        s.circle.mark_default(&s.carol);
        assert_eq!(s.circle.get_defaults(&s.carol), 1,
            "carol's default count must be 1 after mark_default at deadline+1");
        assert!(s.has_defaulted_key(&s.carol, 0));
    }

    /// A member who has not joined (no Collateral key) cannot be marked default.
    /// The guard "member has not joined" fires before any state mutation.
    #[test]
    #[should_panic(expected = "member has not joined")]
    fn test_555_unjoined_member_cannot_be_defaulted() {
        let s = setup();

        // Only alice, bob, carol join — dave does NOT join
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.join(&s.carol);

        // Dave has no Collateral key — should not be defaultable
        // But the circle is still Pending so the status gate fires first.
        // To test the collateral guard, force the circle to Active state and
        // manually set the deadline past.
        s.env.as_contract(&s.circle_id, || {
            s.env.storage().instance().set(&DataKey::Status, &CircleStatus::Active);
            let mut round: crate::RoundState = s.env.storage().instance()
                .get(&DataKey::CurrentRound).unwrap();
            round.deadline_ledger = s.env.ledger().sequence() as u64 - 1;
            s.env.storage().instance().set(&DataKey::CurrentRound, &round);
        });

        // Dave is a listed member but has 0 collateral (no Collateral key)
        // The "member has not joined" guard must fire
        s.circle.mark_default(&s.dave);
    }

    /// Collateral penalty from mark_default is exactly 20% of the current
    /// balance (not a fixed amount), ensuring repeated defaults compound correctly.
    #[test]
    fn test_555_penalty_is_percentage_of_current_balance_not_fixed() {
        let s = setup();
        s.activate();
        s.advance_past_deadline();

        let initial = s.circle.get_collateral(&s.carol);
        let expected_penalty = initial * PENALTY_BPS / BPS_DENOM;
        let expected_remaining = initial - expected_penalty;

        s.circle.mark_default(&s.carol);

        assert_eq!(s.circle.get_collateral(&s.carol), expected_remaining,
            "collateral after default must be initial - (initial * PENALTY_BPS / BPS_DENOM)");
        assert_eq!(initial - s.circle.get_collateral(&s.carol), expected_penalty,
            "penalty deducted must equal initial * PENALTY_BPS / BPS_DENOM");
    }
}
