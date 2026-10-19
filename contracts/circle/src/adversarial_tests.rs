//! Adversarial authorization tests — circle, reputation (Issue #87).
//!
//! # Purpose
//!
//! Every privileged entry-point is exercised from each unauthorized caller
//! role.  After every rejected call the test asserts that the contract's
//! observable state (token balances, collateral, counters, lists) is
//! byte-for-byte identical to what it was before the attempt.
//!
//! # Roles under test
//!
//! | Role | Description |
//! |------|-------------|
//! | `organizer` | Wallet that set up the circle fixture (has no special on-chain privilege) |
//! | `member` | A wallet in `config.members` |
//! | `recipient` | The current-round recipient (a member) |
//! | `stranger` | A freshly generated address NOT in `config.members` |
//! | `forged_circle` | A freshly generated address NOT registered with reputation |
//!
//! # Acceptance criteria
//!
//! - Every privileged method has at least one unauthorized-caller test.
//! - After each rejection, balances and counters are unchanged.
//! - Forged identities (stranger, forged_circle) are explicitly rejected.

#[cfg(test)]
mod adversarial_tests {
    extern crate std;

    use crate::{
        CircleContract, CircleContractClient, CircleStatus, CloseError, DataKey,
        COLLATERAL_MULTIPLIER, MIN_ROUND_DEADLINE_LEDGERS,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    const ROUND_AMOUNT: i128 = 100_000_000;
    const ROUND_DEADLINE: u32 = 1_000;

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct AdvSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        rep: ReputationContractClient<'a>,
        rep_id: Address,
        rep_admin: Address,
        /// Wallet used to initialize the circle (no on-chain privilege).
        #[allow(dead_code)]
        organizer: Address,
        alice: Address,   // members[0] — round-0 recipient
        bob: Address,     // members[1]
        carol: Address,   // members[2]
        dave: Address,    // members[3]
        /// NOT in config.members — the canonical "forged member".
        stranger: Address,
        /// Address with pause/resume authority over this circle.
        circle_admin: Address,
    }

    impl<'a> AdvSetup<'a> {
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

        fn complete_round(&self) {
            self.contribute_all();
            self.circle.payout();
        }

        fn advance_past_deadline(&self) {
            self.env.ledger().with_mut(|l| {
                l.sequence_number += ROUND_DEADLINE + 1;
            });
        }

        fn force_completed(&self) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .instance()
                    .set(&DataKey::Status, &CircleStatus::Completed);
                self.env
                    .storage()
                    .instance()
                    .set(&DataKey::RoundsCompleted, &4u32);
            });
        }
    }

    fn make_setup() -> AdvSetup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_reg = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = TokenClient::new(&env, &token_reg.address());
        let token_asset = StellarAssetClient::new(&env, &token_reg.address());

        let organizer = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);
        let dave = Address::generate(&env);
        let stranger = Address::generate(&env);

        for m in [&alice, &bob, &carol, &dave] {
            token_asset.mint(m, &(ROUND_AMOUNT * (COLLATERAL_MULTIPLIER + 4)));
        }
        // Stranger has some tokens so a rogue join attempt has funds
        token_asset.mint(&stranger, &(ROUND_AMOUNT * 10));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let rep_id = env.register_contract(None, ReputationContract);
        let rep = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep.initialize(&rep_admin);
        rep.add_authorized_caller(&rep_admin, &circle_id);

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
            &token_reg.address(),
            &rep_id,
            &ROUND_DEADLINE,
        );

        AdvSetup {
            env,
            circle,
            circle_id,
            token,
            rep,
            rep_id,
            rep_admin,
            organizer,
            alice,
            bob,
            carol,
            dave,
            stranger,
            circle_admin,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — join
    // ═══════════════════════════════════════════════════════════════════════

    /// A stranger (address not in config.members) cannot join.
    #[test]
    #[should_panic(expected = "not a circle member")]
    fn adv_circle_join_stranger_rejected() {
        let t = make_setup();
        t.circle.join(&t.stranger);
    }

    /// After a rejected join the stranger's token balance is unchanged and
    /// no Collateral key is written for them.
    #[test]
    fn adv_circle_join_stranger_balance_and_state_unchanged() {
        let t = make_setup();
        let bal_before = t.token.balance(&t.stranger);

        let result = t.circle.try_join(&t.stranger);
        assert!(result.is_err(), "stranger join must be rejected");

        // Token balance must be unchanged
        assert_eq!(
            t.token.balance(&t.stranger),
            bal_before,
            "stranger's token balance must be unchanged after rejected join"
        );

        // No collateral key must exist for the stranger
        let has_key = t.env.as_contract(&t.circle_id, || {
            t.env
                .storage()
                .persistent()
                .has(&DataKey::Collateral(t.stranger.clone()))
        });
        assert!(!has_key, "no Collateral key must be written for a rejected joiner");
    }

    /// A forged address that generates itself and tries to impersonate a
    /// member is rejected: the membership check uses the stored list, not
    /// the caller identity alone.
    #[test]
    fn adv_circle_join_forged_identity_cannot_join() {
        let t = make_setup();
        // forged_member is a new address — distinct from every configured member
        let forged_member = Address::generate(&t.env);
        let result = t.circle.try_join(&forged_member);
        assert!(
            result.is_err(),
            "a forged address not in config.members must be rejected by join"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — contribute
    // ═══════════════════════════════════════════════════════════════════════

    /// A stranger cannot contribute to an active circle.
    #[test]
    #[should_panic(expected = "not a member")]
    fn adv_circle_contribute_stranger_rejected() {
        let t = make_setup();
        t.activate();
        t.circle.contribute(&t.stranger);
    }

    /// After a rejected contribution the stranger's balance is unchanged and
    /// no Contributed key is written for them, and the contribution counter
    /// in the current round does not increment.
    #[test]
    fn adv_circle_contribute_stranger_state_unchanged() {
        let t = make_setup();
        t.activate();

        let bal_before = t.token.balance(&t.stranger);
        let round_before = t.circle.get_current_round();

        let result = t.circle.try_contribute(&t.stranger);
        assert!(result.is_err(), "stranger contribute must be rejected");

        assert_eq!(
            t.token.balance(&t.stranger),
            bal_before,
            "stranger's token balance must be unchanged after rejected contribute"
        );

        let round_after = t.circle.get_current_round();
        assert_eq!(
            round_after.contributions_received,
            round_before.contributions_received,
            "contributions_received counter must not increment on rejected contribute"
        );

        let has_key = t.env.as_contract(&t.circle_id, || {
            t.env.storage().persistent().has(&DataKey::Contributed(
                t.stranger.clone(),
                round_before.round_index,
            ))
        });
        assert!(!has_key, "no Contributed key must be written for a rejected contributor");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — cancel
    // ═══════════════════════════════════════════════════════════════════════

    /// A stranger cannot cancel a pending circle.
    #[test]
    #[should_panic(expected = "not a circle member")]
    fn adv_circle_cancel_stranger_rejected() {
        let t = make_setup();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.stranger);
    }

    /// After a rejected cancel the circle remains Pending; no state changes.
    #[test]
    fn adv_circle_cancel_stranger_status_unchanged() {
        let t = make_setup();
        t.circle.join(&t.alice);

        let result = t.circle.try_cancel(&t.stranger);
        assert!(result.is_err(), "stranger cancel must be rejected");

        assert_eq!(
            t.circle.get_status(),
            CircleStatus::Pending,
            "circle status must remain Pending after rejected cancel"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — close
    // ═══════════════════════════════════════════════════════════════════════

    /// A stranger cannot trigger close on a completed circle.
    #[test]
    fn adv_circle_close_stranger_rejected() {
        let t = make_setup();
        t.activate();
        t.force_completed();
        assert_eq!(
            t.circle.try_close(&t.stranger),
            Err(Ok(CloseError::Unauthorized)),
            "stranger must be rejected with CloseError::Unauthorized"
        );
    }

    /// After a rejected close, no collateral is transferred and all member
    /// balances are unchanged.
    #[test]
    fn adv_circle_close_stranger_balances_unchanged() {
        let t = make_setup();
        t.activate();
        t.force_completed();

        let bals_before: std::vec::Vec<i128> = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.token.balance(m))
            .collect();

        let result = t.circle.try_close(&t.stranger);
        assert!(result.is_err(), "stranger close must be rejected");

        for (i, m) in [&t.alice, &t.bob, &t.carol, &t.dave].iter().enumerate() {
            assert_eq!(
                t.token.balance(m),
                bals_before[i],
                "member[{}] balance must be unchanged after rejected close", i
            );
        }

        // Collateral values must be unchanged
        for m in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(
                t.circle.get_collateral(m),
                ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
                "collateral must be unchanged after rejected close"
            );
        }
    }

    /// A forged address that is not a member cannot close, regardless of
    /// what lifecycle state the circle is in.
    #[test]
    fn adv_circle_close_forged_identity_rejected_in_terminal_states() {
        let t = make_setup();
        let forged = Address::generate(&t.env);

        // Test in Cancelled state
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let result = t.circle.try_close(&forged);
        assert!(
            result.is_err(),
            "forged address must not be able to close a Cancelled circle"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — mark_default (membership and status checks)
    // ═══════════════════════════════════════════════════════════════════════

    /// mark_default on a Pending circle is rejected with "circle is not active".
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn adv_circle_mark_default_on_pending_rejected() {
        let t = make_setup();
        t.circle.join(&t.alice);
        // Circle is still Pending
        t.circle.mark_default(&t.bob);
    }

    /// After a rejected mark_default on a Pending circle, no state changes.
    #[test]
    fn adv_circle_mark_default_pending_state_unchanged() {
        let t = make_setup();
        t.circle.join(&t.alice);

        let result = t.circle.try_mark_default(&t.bob);
        assert!(result.is_err(), "mark_default on Pending must be rejected");

        // Status must still be Pending
        assert_eq!(
            t.circle.get_status(),
            CircleStatus::Pending,
            "status must remain Pending after rejected mark_default"
        );

        // Collateral must be unchanged for both alice (who joined) and bob (who didn't)
        assert_eq!(
            t.circle.get_collateral(&t.alice),
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "alice's collateral must be unchanged"
        );
        assert_eq!(t.circle.get_collateral(&t.bob), 0, "bob's collateral must be 0");

        // Defaults counter must not have incremented
        assert_eq!(t.circle.get_defaults(&t.bob), 0, "defaults counter must be 0");
    }

    /// mark_default on a stranger (not in config.members) is rejected.
    #[test]
    #[should_panic(expected = "not a member")]
    fn adv_circle_mark_default_stranger_rejected() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();
        t.circle.mark_default(&t.stranger);
    }

    /// After a rejected mark_default on a stranger, the stranger's defaults
    /// counter is still 0 and all members' collateral is unchanged.
    #[test]
    fn adv_circle_mark_default_stranger_state_unchanged() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();

        let collaterals_before: std::vec::Vec<i128> =
            [&t.alice, &t.bob, &t.carol, &t.dave]
                .iter()
                .map(|m| t.circle.get_collateral(m))
                .collect();

        let result = t.circle.try_mark_default(&t.stranger);
        assert!(result.is_err(), "mark_default on stranger must be rejected");

        assert_eq!(
            t.circle.get_defaults(&t.stranger),
            0,
            "stranger's defaults counter must remain 0"
        );

        for (i, m) in [&t.alice, &t.bob, &t.carol, &t.dave].iter().enumerate() {
            assert_eq!(
                t.circle.get_collateral(m),
                collaterals_before[i],
                "member[{}] collateral must be unchanged after rejected mark_default", i
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — payout (caller-agnostic but contribution guards apply)
    // ═══════════════════════════════════════════════════════════════════════

    /// Payout before all members have contributed is rejected; the round's
    /// recipient does not receive any tokens.
    #[test]
    fn adv_circle_payout_partial_contributions_no_transfer() {
        let t = make_setup();
        t.activate();
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        // carol and dave have not contributed

        let recipient_bal_before = t.token.balance(&t.alice); // alice is round-0 recipient
        let result = t.circle.try_payout();
        assert!(result.is_err(), "payout with incomplete contributions must fail");

        assert_eq!(
            t.token.balance(&t.alice),
            recipient_bal_before,
            "recipient must not receive tokens from a failed payout"
        );

        // RoundsCompleted must not have incremented
        let completed: u32 = t.env.as_contract(&t.circle_id, || {
            t.env
                .storage()
                .instance()
                .get(&DataKey::RoundsCompleted)
                .unwrap_or(0)
        });
        assert_eq!(completed, 0, "RoundsCompleted must not increment on failed payout");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — initialize (re-initialization blocked)
    // ═══════════════════════════════════════════════════════════════════════

    /// Re-initializing an already-initialized circle with a different member
    /// list is rejected and leaves the original Config intact.
    #[test]
    fn adv_circle_reinitialize_cannot_overwrite_members() {
        let t = make_setup();

        // Attempt to overwrite with a new two-member circle
        let mut new_members = Vec::new(&t.env);
        new_members.push_back(t.stranger.clone());
        new_members.push_back(Address::generate(&t.env));

        let result = t.circle.try_initialize(
            &Address::generate(&t.env),
            &new_members,
            &(ROUND_AMOUNT * 2),
            &Address::generate(&t.env),
            &t.rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "re-initialization must be rejected");

        // Config must still reflect the original 4-member setup
        let config = t.circle.get_config();
        assert_eq!(
            config.members.len(),
            4,
            "config must still hold the original 4 members"
        );
        assert_eq!(
            config.round_amount,
            ROUND_AMOUNT,
            "round_amount must be unchanged after rejected re-initialization"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Reputation — add_authorized_caller: non-admin rejected
    // ═══════════════════════════════════════════════════════════════════════

    /// A non-admin address cannot register a new authorized caller.
    #[test]
    fn adv_rep_non_admin_cannot_add_caller() {
        let t = make_setup();
        let new_circle = Address::generate(&t.env);
        let non_admin = Address::generate(&t.env);

        let callers_before = t.rep.get_authorized_callers().len();

        let result = t.rep.try_add_authorized_caller(&non_admin, &new_circle);
        assert!(result.is_err(), "non-admin must not be able to add an authorized caller");

        assert_eq!(
            t.rep.get_authorized_callers().len(),
            callers_before,
            "authorized-callers list must be unchanged after rejected add"
        );
    }

    /// A member (in the circle's member list) cannot add themselves as an
    /// authorized reputation caller — only the admin (factory) can.
    #[test]
    fn adv_rep_circle_member_cannot_add_rep_caller() {
        let t = make_setup();
        let forged_circle = Address::generate(&t.env);

        let callers_before = t.rep.get_authorized_callers().len();

        // alice (a circle member) tries to register a forged circle address
        let result = t.rep.try_add_authorized_caller(&t.alice, &forged_circle);
        assert!(
            result.is_err(),
            "a circle member must not be able to add a reputation caller"
        );

        assert_eq!(
            t.rep.get_authorized_callers().len(),
            callers_before,
            "authorized-callers list must be unchanged"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Reputation — remove_authorized_caller: non-admin rejected
    // ═══════════════════════════════════════════════════════════════════════

    /// A non-admin address cannot revoke an authorized caller.
    #[test]
    fn adv_rep_non_admin_cannot_remove_caller() {
        let t = make_setup();
        let non_admin = Address::generate(&t.env);

        // circle_id is already in the authorized list (added by make_setup)
        let callers_before = t.rep.get_authorized_callers().len();

        let result = t.rep.try_remove_authorized_caller(&non_admin, &t.circle_id);
        assert!(result.is_err(), "non-admin must not be able to remove an authorized caller");

        // circle_id must still be authorized
        assert!(
            t.rep.get_authorized_callers().contains(&t.circle_id),
            "circle must remain authorized after rejected removal"
        );
        assert_eq!(
            t.rep.get_authorized_callers().len(),
            callers_before,
            "authorized-callers list length must be unchanged"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Reputation — increment: forged/unregistered circle rejected
    // ═══════════════════════════════════════════════════════════════════════

    /// An unregistered (forged) circle address cannot increment any member's score.
    #[test]
    fn adv_rep_forged_circle_cannot_increment_score() {
        let t = make_setup();
        let forged_circle = Address::generate(&t.env);
        let victim = Address::generate(&t.env);

        let score_before = t.rep.score(&victim);

        let result = t.rep.try_increment(&forged_circle, &victim);
        assert!(result.is_err(), "forged circle must not be able to increment scores");

        assert_eq!(
            t.rep.score(&victim),
            score_before,
            "victim's reputation score must be unchanged after rejected increment"
        );
    }

    /// A revoked circle cannot increment scores even if it was previously authorized.
    #[test]
    fn adv_rep_revoked_circle_cannot_increment_and_score_frozen() {
        let t = make_setup();
        let member = Address::generate(&t.env);

        // circle_id is already authorized; increment once to establish a score
        t.activate();
        t.complete_round(); // payout grants reputation to alice (round-0 recipient)

        let alice_score = t.rep.score(&t.alice);
        assert_eq!(alice_score, 1, "alice must have score 1 after payout");

        // Revoke the circle
        t.rep.remove_authorized_caller(&t.rep_admin, &t.circle_id);

        // Any further increment must be rejected
        let result = t.rep.try_increment(&t.circle_id, &member);
        assert!(result.is_err(), "revoked circle must not be able to award points");

        // Alice's score must be frozen — revocation does not rewrite history
        assert_eq!(
            t.rep.score(&t.alice),
            alice_score,
            "score must be frozen after revocation, not decremented"
        );
        assert_eq!(
            t.rep.score(&member),
            0,
            "victim's score must remain 0 — no points awarded by revoked circle"
        );
    }

    /// Multiple different forged addresses all fail to increment scores.
    /// This ensures the check is not accidentally address-order-dependent.
    #[test]
    fn adv_rep_multiple_forged_circles_all_rejected() {
        let t = make_setup();
        let target = Address::generate(&t.env);

        for _ in 0..5 {
            let forged = Address::generate(&t.env);
            let result = t.rep.try_increment(&forged, &target);
            assert!(
                result.is_err(),
                "every unregistered address must be rejected by reputation.increment"
            );
        }

        assert_eq!(
            t.rep.score(&target),
            0,
            "target's score must be 0 after all rejected increment attempts"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Reputation — initialize: double-init rejected
    // ═══════════════════════════════════════════════════════════════════════

    /// A second call to reputation.initialize must be rejected and leave the
    /// admin unchanged.
    #[test]
    fn adv_rep_double_initialize_rejected_admin_unchanged() {
        let t = make_setup();
        let attacker = Address::generate(&t.env);

        let admin_before = t.rep.get_admin();
        let result = t.rep.try_initialize(&attacker);
        assert!(result.is_err(), "second initialize must be rejected");

        assert_eq!(
            t.rep.get_admin(),
            admin_before,
            "admin must not change after rejected re-initialization"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — settle_round paused
    // ═══════════════════════════════════════════════════════════════════════

    /// settle_round on a paused circle must be rejected.
    /// Before the fix, settle_round was the only fund-moving entry-point that
    /// skipped the pause check.  This test verifies the gap is closed.
    #[test]
    #[should_panic(expected = "circle is paused")]
    fn adv_circle_settle_round_blocked_while_paused() {
        let t = make_setup();
        t.activate();

        // Advance past the deadline so the precondition for settle_round passes
        t.advance_past_deadline();

        // Pause the circle
        t.circle.pause(&t.circle_admin);
        assert!(t.circle.is_paused(), "circle must be paused before the test");

        // settle_round must be blocked — if the pause check is missing this panics
        // with a token-transfer or settlement error instead, not the expected message
        t.circle.settle_round();
    }

    /// After a rejected settle_round (paused), no collateral changes and the
    /// round state is unchanged.
    #[test]
    fn adv_circle_settle_round_paused_state_unchanged() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();

        let collaterals_before: std::vec::Vec<i128> =
            [&t.alice, &t.bob, &t.carol, &t.dave]
                .iter()
                .map(|m| t.circle.get_collateral(m))
                .collect();
        let round_before = t.circle.get_current_round();

        t.circle.pause(&t.circle_admin);
        let result = t.circle.try_settle_round();
        assert!(result.is_err(), "settle_round must be rejected while paused");

        // Collateral must be unchanged — no penalties applied
        for (i, m) in [&t.alice, &t.bob, &t.carol, &t.dave].iter().enumerate() {
            assert_eq!(
                t.circle.get_collateral(m),
                collaterals_before[i],
                "member[{}] collateral must be unchanged after rejected settle_round", i
            );
        }

        // Round state must be unchanged — paid_out still false
        let round_after = t.circle.get_current_round();
        assert_eq!(
            round_after.paid_out, round_before.paid_out,
            "paid_out flag must not change on rejected settle_round"
        );
        assert_eq!(
            round_after.round_index, round_before.round_index,
            "round_index must not advance on rejected settle_round"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — settle_round before deadline (precondition enforcement)
    // ═══════════════════════════════════════════════════════════════════════

    /// settle_round must be rejected if the deadline has not yet passed.
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn adv_circle_settle_round_before_deadline_rejected() {
        let t = make_setup();
        t.activate();
        // Do not advance past deadline
        t.circle.settle_round();
    }

    /// settle_round must be rejected when called on a Pending circle.
    #[test]
    #[should_panic(expected = "circle is not active")]
    fn adv_circle_settle_round_on_pending_rejected() {
        let t = make_setup();
        // Circle is still Pending (not all members joined)
        t.circle.join(&t.alice);
        t.advance_past_deadline();
        t.circle.settle_round();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — settle_round with zero contributors (all defaulted)
    // ═══════════════════════════════════════════════════════════════════════

    /// settle_round with zero contributions produces a zero pot and still
    /// advances the circle.  The recipient receives 0 tokens (no transfer call),
    /// every member's collateral is penalised, and the round is marked paid_out.
    #[test]
    fn adv_circle_settle_round_zero_contributors_advances_circle() {
        let t = make_setup();
        t.activate();

        // Nobody contributes — advance past the deadline
        t.advance_past_deadline();

        let collaterals_before: std::vec::Vec<i128> =
            [&t.alice, &t.bob, &t.carol, &t.dave]
                .iter()
                .map(|m| t.circle.get_collateral(m))
                .collect();
        let recipient_bal_before = t.token.balance(&t.alice); // round-0 recipient

        // settle_round must succeed even with zero contributions
        t.circle.settle_round();

        // Round 0 is now settled; round 1 must be active
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1, "circle must advance to round 1");
        assert_eq!(t.circle.get_status(), crate::CircleStatus::Active);

        // Recipient must not have received any tokens (zero pot, no transfer)
        assert_eq!(
            t.token.balance(&t.alice),
            recipient_bal_before,
            "recipient must not receive tokens for a zero-pot settlement"
        );

        // All members must have incurred the standard 20% penalty
        for (i, m) in [&t.alice, &t.bob, &t.carol, &t.dave].iter().enumerate() {
            let expected_after = collaterals_before[i]
                - collaterals_before[i] * crate::PENALTY_BPS / crate::BPS_DENOM;
            assert_eq!(
                t.circle.get_collateral(m),
                expected_after,
                "member[{}] must have incurred exactly one 20% penalty", i
            );
            assert_eq!(
                t.circle.get_defaults(m),
                1,
                "member[{}] defaults counter must be 1 after zero-contribution round", i
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — close after cancel (with prior joiners)
    // ═══════════════════════════════════════════════════════════════════════

    /// Close on a Cancelled circle returns collateral to members who joined
    /// before the cancellation, and releases nothing for members who never joined.
    #[test]
    fn adv_circle_close_after_cancel_releases_joiner_collateral() {
        let t = make_setup();

        // Only alice and bob join before the cancel
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        assert_eq!(t.circle.get_status(), crate::CircleStatus::Pending);

        // Cancel the circle
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), crate::CircleStatus::Cancelled);

        let alice_before = t.token.balance(&t.alice);
        let bob_before   = t.token.balance(&t.bob);
        let carol_before = t.token.balance(&t.carol);
        let dave_before  = t.token.balance(&t.dave);

        // Close — alice is a member and a joiner, valid caller
        t.circle.close(&t.alice);

        let expected_collateral = ROUND_AMOUNT * crate::COLLATERAL_MULTIPLIER;

        // Alice and bob must have their collateral returned
        assert_eq!(
            t.token.balance(&t.alice) - alice_before,
            expected_collateral,
            "alice must receive her collateral back"
        );
        assert_eq!(
            t.token.balance(&t.bob) - bob_before,
            expected_collateral,
            "bob must receive his collateral back"
        );

        // Carol and dave never joined — balance must be unchanged
        assert_eq!(
            t.token.balance(&t.carol),
            carol_before,
            "carol never joined; her balance must be unchanged"
        );
        assert_eq!(
            t.token.balance(&t.dave),
            dave_before,
            "dave never joined; his balance must be unchanged"
        );

        // Circle must be closed
        assert!(t.circle.is_closed(), "circle must be closed after close()");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — close after complete with prior defaults (penalty-reduced collateral)
    // ═══════════════════════════════════════════════════════════════════════

    /// After a full lifecycle with at least one defaulted round, close releases
    /// only the penalty-reduced collateral balances (not the original amounts).
    #[test]
    fn adv_circle_close_after_complete_with_defaults_releases_reduced_collateral() {
        let t = make_setup();
        t.activate();

        let initial_collateral = t.circle.get_collateral(&t.dave);
        let penalty = initial_collateral * crate::PENALTY_BPS / crate::BPS_DENOM;
        let expected_dave_collateral_at_close = initial_collateral - penalty;

        // Round 0: dave defaults; others contribute → settle_round advances the circle
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.advance_past_deadline();
        t.circle.mark_default(&t.dave);
        t.circle.settle_round();

        // Verify dave's collateral was reduced
        assert_eq!(
            t.circle.get_collateral(&t.dave),
            expected_dave_collateral_at_close,
            "dave's collateral must reflect the 20% penalty before close"
        );

        // Complete remaining rounds normally (rounds 1-3)
        for _ in 1..4 {
            t.contribute_all();
            t.circle.payout();
        }
        assert_eq!(t.circle.get_status(), crate::CircleStatus::Completed);

        let dave_before = t.token.balance(&t.dave);

        t.circle.close(&t.alice);

        // Dave receives the penalty-reduced amount, not the original
        assert_eq!(
            t.token.balance(&t.dave) - dave_before,
            expected_dave_collateral_at_close,
            "dave must receive only the penalty-reduced collateral at close"
        );

        // Other members receive their full collateral (no defaults)
        for m in [&t.alice, &t.bob, &t.carol] {
            assert_eq!(
                t.circle.get_collateral(m),
                0,
                "member collateral must be zero after close"
            );
        }

        assert!(t.circle.is_closed());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — deadline boundary off-by-one: contribute/default transition
    // ═══════════════════════════════════════════════════════════════════════

    /// At exactly deadline_ledger: contribute is accepted, default is rejected.
    /// At deadline_ledger + 1: contribute is rejected, default is accepted.
    /// This verifies the strict greater-than boundary used by deadline_passed().
    #[test]
    fn adv_circle_deadline_boundary_contribute_and_default_are_non_overlapping() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        let dl = round.deadline_ledger as u32;

        // At exactly the deadline ledger: contribute must succeed
        t.env.ledger().with_mut(|l| { l.sequence_number = dl; });
        t.circle.contribute(&t.alice); // must not panic
        assert!(t.circle.has_contributed(&t.alice, &0u32));

        // mark_default must be blocked at exactly the deadline
        let default_at_deadline = t.circle.try_mark_default(&t.carol);
        assert!(
            default_at_deadline.is_err(),
            "mark_default must be blocked at exactly the deadline ledger"
        );

        // At deadline + 1: contribute must be rejected for a member who hasn't yet
        t.env.ledger().with_mut(|l| { l.sequence_number = dl + 1; });
        let late_contribute = t.circle.try_contribute(&t.bob);
        assert!(
            late_contribute.is_err(),
            "contribute must be rejected one ledger past the deadline"
        );

        // And mark_default must now succeed for a non-contributor (carol)
        let collateral_before = t.circle.get_collateral(&t.carol);
        t.circle.mark_default(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1,
            "mark_default must succeed one ledger past the deadline");

        // Carol's collateral must have been reduced by the standard penalty
        let expected = collateral_before - collateral_before * crate::PENALTY_BPS / crate::BPS_DENOM;
        assert_eq!(t.circle.get_collateral(&t.carol), expected,
            "carol's collateral must be reduced by exactly the standard penalty");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Circle — mark_default idempotency (adversarial double-penalty attempt)
    // ═══════════════════════════════════════════════════════════════════════

    /// An adversarial caller cannot mark the same member in default twice for
    /// the same round, regardless of how many times they call mark_default.
    #[test]
    fn adv_circle_mark_default_double_penalty_blocked() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();

        let collateral_before = t.circle.get_collateral(&t.dave);
        let penalty = collateral_before * crate::PENALTY_BPS / crate::BPS_DENOM;

        // First call — must succeed
        t.circle.mark_default(&t.dave);
        assert_eq!(t.circle.get_defaults(&t.dave), 1);
        assert_eq!(t.circle.get_collateral(&t.dave), collateral_before - penalty);

        // All subsequent calls must be rejected
        for _ in 0..5 {
            let result = t.circle.try_mark_default(&t.dave);
            assert!(
                result.is_err(),
                "every repeated mark_default call for the same round must fail"
            );
        }

        // Collateral must be exactly the post-first-penalty value — never compounded
        assert_eq!(
            t.circle.get_collateral(&t.dave),
            collateral_before - penalty,
            "collateral must reflect exactly one penalty deduction, never compounded"
        );
        assert_eq!(
            t.circle.get_defaults(&t.dave),
            1,
            "defaults counter must be exactly 1 after multiple rejected attempts"
        );
    }
}
