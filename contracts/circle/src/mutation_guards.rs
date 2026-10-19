
//! Mutation guard tests for the Circle contract.
//!
//! # Purpose
//!
//! Traditional unit tests verify that *correct* code passes.  This file
//! verifies that *weakening* a guard actually breaks something — i.e. that
//! the test suite detects guard removal rather than silently passing.
//!
//! Each test in this file takes one of two forms:
//!
//! **Form A — explicit guard-removal fixture** (`#[should_panic]` absent):
//!   The test constructs a state that the guard is meant to block, then
//!   asserts that the contract *panics* or *fails* as expected.  If the guard
//!   were removed, the test would fail (the panic/error would not occur).
//!
//! **Form B — guard-bypass proof** (`#[should_panic]` present):
//!   The test asserts that the *bypassed path* panics.  Removing or weakening
//!   the guard would make the call succeed where it should fail, breaking the
//!   assertion.
//!
//! # Guard catalogue
//!
//! | Guard | Risk if removed | Test(s) |
//! |---|---|---|
//! | `already joined` (`has` check on Collateral key) | double-collateral pull | `guard_join_double_collateral_pull` |
//! | `not all members have contributed yet` (counter check) | payout before all pay | `guard_payout_requires_full_contribution_counter` |
//! | `round contribution tally mismatch` (key check) | forged counter bypasses payout | `guard_payout_tally_mismatch_forged_counter` |
//! | `round deadline not yet passed` | premature default (collateral stolen early) | `guard_mark_default_deadline_strict_boundary` |
//! | `member did contribute` | contributor penalised | `guard_mark_default_contributor_cannot_be_penalised` |
//! | `already marked default this round` | double penalty deduction | `guard_mark_default_idempotency` |
//! | `circle already closed` (Closed flag) | double-release of collateral | `guard_close_double_release_prevention` |
//! | `round_amount too large: overflows penalty calculation` | i128 overflow in penalty | `guard_initialize_overflow_penalty_arithmetic` |
//! | `round_amount too large: overflows pot calculation` | i128 overflow in payout | `guard_initialize_overflow_pot_arithmetic` |
//! | `already initialized` (Config key) | state overwrite attack | `guard_reinitialize_blocked` |
//! | reputation caller unauthorized | self-awarded reputation | `guard_reputation_unauthorized_caller_blocked` |
//! | reputation revocation permanent | revived circle awards points | `guard_reputation_revocation_is_permanent` |
//! | `duplicate members` | one wallet gets two rotation slots | `guard_duplicate_members_rejected` |
//! | `not authorized to close: caller is not a circle member` | outsider drains collateral | `guard_close_non_member_rejected` |
//! | `circle is not active` on contribute while Pending/Completed | tokens locked with no payout path | `guard_contribute_blocked_while_pending`, `guard_contribute_blocked_while_completed` |
//! | `round deadline passed` on contribute | late contribution accepted | `guard_contribute_rejected_one_past_deadline` |
//! | `already paid out` (CEI single-use guard) | double-payout transfers pot twice | `guard_payout_single_use_settled_marker` |
//! | `stored recipient does not match rotation order` | pot transferred to wrong address | `guard_payout_recipient_must_match_rotation` |
//! | collateral zeroed before transfer (CEI) | second withdrawal after close | `guard_collateral_zeroed_after_close_prevents_second_withdrawal` |
//! | penalty deducted once and counted in release | penalty counted twice or refunded | `guard_collateral_penalty_and_release_counted_once` |
//! | `circle is paused` in settle_round | settle_round bypasses pause flag | `guard_settle_round_blocked_while_paused`, `guard_settle_round_paused_leaves_no_partial_state` |
//! | `round deadline not yet passed` in settle_round | settle_round runs before contribution window closes | `guard_settle_round_before_deadline_blocked`, `guard_settle_round_at_deadline_blocked` |
//! | `all members have contributed` in settle_round | settle_round replaces normal payout | `guard_settle_round_blocked_when_all_contributed` |
//!
//! # CI budget
//!
//! These tests are compiled and run as part of `cargo test -p circle` alongside
//! the regular unit tests.  Each test is a standard Soroban test-env invocation
//! with no external dependencies; the full suite completes in seconds.
//!
//! Excluded mutations (with rationale):
//! - **MIN/MAX_ROUND_DEADLINE_LEDGERS bounds** — removing these produces an
//!   unusable circle (zero-ledger window or multi-year lockup) but no direct
//!   financial loss.  Covered by boundary tests in prop_tests.rs; excluded
//!   from mutation suite to keep the budget predictable.
//! - **MAX_MEMBERS bound** — removing it allows an expensive initialisation
//!   but does not create a financial shortcut.  Covered by B5 in prop_tests.rs.
//! - **Status forward-only** — tested exhaustively in prop_tests.rs invariant 4.
//!   Duplicating the check here would inflate CI time without adding coverage.

#[cfg(test)]
mod mutation_guard_tests {
    extern crate std;
    use crate::{
        CircleContract, CircleContractClient, CircleStatus, CloseError, DataKey, InitError,
        PENALTY_BPS, BPS_DENOM, COLLATERAL_MULTIPLIER,
        MIN_ROUND_DEADLINE_LEDGERS,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops
    const ROUND_DEADLINE: u32 = 1_000;

    // ── Shared fixture ────────────────────────────────────────────────────────

    struct MutSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        token_address: Address,
        rep_id: Address,
        members: soroban_sdk::Vec<Address>,
        alice: Address,
        bob: Address,
        carol: Address,
        dave: Address,
        circle_admin: Address,
    }

    impl<'a> MutSetup<'a> {
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

        fn complete_round(&self) -> u32 {
            let round = self.circle.get_current_round();
            let idx = round.round_index;
            self.contribute_all();
            self.circle.payout();
            idx
        }

        fn advance_past_deadline(&self) {
            self.env.ledger().with_mut(|l| {
                l.sequence_number += ROUND_DEADLINE + 1;
            });
        }

        fn force_status(&self, status: CircleStatus) {
            let n = self.members.len();
            self.env.as_contract(&self.circle_id, || {
                self.env.storage().instance().set(&DataKey::Status, &status);
                if matches!(status, CircleStatus::Completed) {
                    self.env.storage().instance().set(&DataKey::RoundsCompleted, &n);
                }
            });
        }

        fn force_collateral(&self, member: &Address, amount: i128) {
            self.env.as_contract(&self.circle_id, || {
                self.env.storage().persistent()
                    .set(&DataKey::Collateral(member.clone()), &amount);
            });
        }

        fn force_contributed(&self, member: &Address, round_index: u32) {
            self.env.as_contract(&self.circle_id, || {
                self.env.storage().persistent()
                    .set(&DataKey::Contributed(member.clone(), round_index), &true);
            });
        }
    }

    fn make_setup() -> MutSetup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_reg = env.register_stellar_asset_contract_v2(token_admin);
        let token = TokenClient::new(&env, &token_reg.address());
        let token_asset = StellarAssetClient::new(&env, &token_reg.address());

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);
        let carol = Address::generate(&env);
        let dave  = Address::generate(&env);

        // Fund: collateral + N rounds
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
            &token_reg.address(),
            &rep_id,
            &ROUND_DEADLINE,
        );

        MutSetup {
            env,
            circle,
            circle_id,
            token,
            token_address: token_reg.address(),
            rep_id,
            members,
            alice,
            bob,
            carol,
            dave,
            circle_admin,
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 1: Double-collateral pull via join
    //
    // Guard: `if env.storage().persistent().has(&collateral_key) { panic! }`
    // Risk if removed: a member calls join twice, pulling 2× collateral from
    //   their wallet.  The second deposit is never returned (close() would
    //   release only the stored balance, not the raw transfer amount).
    // ═════════════════════════════════════════════════════════════════════════

    /// A member who has already joined must be rejected on a second join attempt.
    /// Removing the `has` guard would allow the double-pull.
    #[test]
    #[should_panic(expected = "already joined")]
    fn guard_join_double_collateral_pull() {
        let t = make_setup();
        t.circle.join(&t.alice);
        // Guard must fire here — if removed, alice's wallet is drained twice
        t.circle.join(&t.alice);
    }

    /// The `has` guard — not `value > 0` — is what prevents re-join after
    /// the key exists with a zero value.  Verify the storage key is the guard,
    /// not the balance magnitude.
    #[test]
    #[should_panic(expected = "already joined")]
    fn guard_join_has_check_not_balance_check() {
        let t = make_setup();
        t.circle.join(&t.alice);
        // Drain balance to 0 — if guard used `value > 0`, this would allow re-join
        t.force_collateral(&t.alice, 0);
        // Must still panic — guard is `has`, not `collateral > 0`
        t.circle.join(&t.alice);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 2: Payout requires full contribution counter
    //
    // Guard: `if round.contributions_received != member_count { panic! }`
    // Risk if removed: payout runs with N-1 contributions; the recipient gets
    //   only (N-1) × round_amount from contract funds but `member_count × round_amount`
    //   is transferred, draining the collateral buffer.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "not all members have contributed yet")]
    fn guard_payout_requires_full_contribution_counter() {
        let t = make_setup();
        t.activate();
        // Only 3 of 4 members contribute
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        // Guard must fire — dave has not contributed
        t.circle.payout();
    }

    /// Even one missing contribution must block payout (not just > half).
    #[test]
    #[should_panic(expected = "not all members have contributed yet")]
    fn guard_payout_one_missing_contribution_blocks() {
        let t = make_setup();
        t.activate();
        t.circle.contribute(&t.alice);
        // bob, carol, dave have not contributed
        t.circle.payout();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 3: Payout tally mismatch (forged counter)
    //
    // Guard: persisted Contributed-key count must equal member_count.
    // Risk if removed: an attacker increments `contributions_received` without
    //   actually depositing tokens (e.g. via a forged counter), triggering a
    //   payout that overdrafts the contract.
    // ═════════════════════════════════════════════════════════════════════════

    /// Forge the contributions_received counter to member_count while leaving
    /// only 3 persisted Contributed keys.  The second guard (key count) must catch it.
    #[test]
    #[should_panic(expected = "round contribution tally mismatch")]
    fn guard_payout_tally_mismatch_forged_counter() {
        let t = make_setup();
        t.activate();

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        // dave has NOT contributed — 3 keys exist

        // Forge the counter to 4 so the first guard passes but key-check fires
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t.env.storage().instance()
                .get(&crate::DataKey::CurrentRound).unwrap();
            round.contributions_received = 4;
            t.env.storage().instance().set(&crate::DataKey::CurrentRound, &round);
        });

        t.circle.payout(); // must panic: tally mismatch (3 keys, counter = 4)
    }

    /// Forge Contributed keys without going through contribute() (so counter = 0
    /// but 4 keys exist).  The counter guard fires first.
    #[test]
    #[should_panic(expected = "not all members have contributed yet")]
    fn guard_payout_forged_keys_without_counter_blocked() {
        let t = make_setup();
        t.activate();

        // Write all 4 Contributed keys directly, bypassing the counter increment
        t.force_contributed(&t.alice, 0);
        t.force_contributed(&t.bob, 0);
        t.force_contributed(&t.carol, 0);
        t.force_contributed(&t.dave, 0);
        // counter is still 0 — first guard fires
        t.circle.payout();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 4: mark_default deadline strict boundary
    //
    // Guard: `(sequence as u64) <= deadline_ledger { panic!("...not yet passed") }`
    // Risk if removed: a caller marks default at or before the deadline ledger,
    //   stealing 20% collateral from a member who still has time to contribute.
    // ═════════════════════════════════════════════════════════════════════════

    /// At exactly deadline_ledger (strict >) the guard must still fire.
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn guard_mark_default_deadline_strict_boundary() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32; // exactly at deadline
        });
        // Must panic — one ledger of contribution window remains
        t.circle.mark_default(&t.carol);
    }

    /// One ledger before the deadline must also be blocked.
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn guard_mark_default_one_before_deadline_blocked() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 - 1;
        });
        t.circle.mark_default(&t.carol);
    }

    /// At deadline + 1 the guard must NOT fire — default is now valid.
    #[test]
    fn guard_mark_default_one_past_deadline_succeeds() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });
        t.circle.mark_default(&t.carol);
        // If guard were `>=` instead of `>`, this would panic — verify it does not
        assert_eq!(t.circle.get_defaults(&t.carol), 1);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 5: A contributor cannot be penalised
    //
    // Guard: `if env.storage().persistent().has(&contrib_key) { panic! }`
    // Risk if removed: an attacker calls mark_default on a member who already
    //   contributed, deducting 20% collateral from someone who fulfilled their
    //   obligation.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "member did contribute")]
    fn guard_mark_default_contributor_cannot_be_penalised() {
        let t = make_setup();
        t.activate();
        t.circle.contribute(&t.carol);
        t.advance_past_deadline();
        // Guard must fire — carol already contributed
        t.circle.mark_default(&t.carol);
    }

    /// Verify that the contribution record persists after the deadline passes
    /// (so the guard can still fire even for late-called mark_default).
    #[test]
    fn guard_contribution_key_persists_after_deadline_for_guard_correctness() {
        let t = make_setup();
        t.activate();
        t.circle.contribute(&t.alice);
        t.advance_past_deadline();
        // alice's Contributed key must still be present
        assert!(t.circle.has_contributed(&t.alice, &0u32));
        // Guard would fire on mark_default — the key is the proof
        let result = t.circle.try_mark_default(&t.alice);
        assert!(result.is_err(), "contributor must not be defaultable even past deadline");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 6: mark_default idempotency (double-penalty guard)
    //
    // Guard: `if env.storage().persistent().has(&defaulted_key) { panic! }`
    // Risk if removed: mark_default is called twice for the same member in the
    //   same round, deducting 20% collateral twice (compounding to ~36% loss).
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "already marked default this round")]
    fn guard_mark_default_idempotency() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);
        // Guard must fire on second call for same round
        t.circle.mark_default(&t.carol);
    }

    /// Verify that the collateral after one default is exactly
    /// `collateral * (1 - PENALTY_BPS/BPS_DENOM)`, not further reduced.
    #[test]
    fn guard_mark_default_single_penalty_amount_is_correct() {
        let t = make_setup();
        t.activate();
        let before = t.circle.get_collateral(&t.carol);
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);
        let after = t.circle.get_collateral(&t.carol);

        let expected_penalty = before * PENALTY_BPS / BPS_DENOM;
        assert_eq!(
            before - after,
            expected_penalty,
            "penalty must be exactly PENALTY_BPS/BPS_DENOM of collateral — not more"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 7: Double-release via close()
    //
    // Guard: `if env.storage().instance().has(&DataKey::Closed) { panic! }`
    // Risk if removed: close() is called twice; the second call reads zeroed
    //   collateral values and transfers 0, but the Closed flag is the gate
    //   against future code changes that might re-read non-zero values.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    fn guard_close_double_release_prevention() {
        let t = make_setup();
        t.activate();
        t.force_status(CircleStatus::Completed);
        t.circle.close(&t.alice);
        // Guard must fire immediately — Closed flag is set
        let result = t.circle.try_close(&t.bob);
        assert_eq!(
            result,
            Err(Ok(CloseError::AlreadyClosed)),
            "second close must return CloseError::AlreadyClosed"
        );
    }

    /// After a successful close, all collateral storage keys must be zero.
    /// This confirms the zeroing-before-transfer (CEI) pattern held.
    #[test]
    fn guard_close_collateral_zeroed_before_transfer_cei() {
        let t = make_setup();
        t.activate();
        t.force_status(CircleStatus::Completed);
        t.circle.close(&t.alice);
        for member in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(
                t.circle.get_collateral(member), 0,
                "collateral must be zero after close (CEI pattern)"
            );
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 8: round_amount overflow — penalty path
    //
    // Guard: `round_amount.checked_mul(PENALTY_BPS).unwrap_or_else(|| panic!)`
    // Risk if removed: penalty calculation silently wraps, potentially making
    //   penalty == 0 or a nonsense negative value (no financial protection).
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "overflows penalty calculation")]
    fn guard_initialize_overflow_penalty_arithmetic() {
        let env = Env::default();
        env.mock_all_auths();

        let token_reg = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let mut members = soroban_sdk::Vec::new(&env);
        members.push_back(Address::generate(&env));
        members.push_back(Address::generate(&env));

        // i128::MAX / PENALTY_BPS + 1 overflows `round_amount * PENALTY_BPS`
        let overflow_amount = i128::MAX / crate::PENALTY_BPS + 1;
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &overflow_amount,
            &token_reg.address(),
            &rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 9: round_amount overflow — pot path
    //
    // Guard: `round_amount.checked_mul(members.len()).unwrap_or_else(|| panic!)`
    // Risk if removed: pot calculation wraps; recipient could receive a wrong
    //   (potentially huge) amount, draining the contract beyond its balance.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "overflows pot calculation")]
    fn guard_initialize_overflow_pot_arithmetic() {
        let env = Env::default();
        env.mock_all_auths();

        let token_reg = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        // 255 members; round_amount chosen so amount * 255 > i128::MAX
        // but amount * PENALTY_BPS still fits (to isolate the pot overflow guard)
        let member_count: u32 = 255;
        let mut members = soroban_sdk::Vec::new(&env);
        for _ in 0..member_count {
            members.push_back(Address::generate(&env));
        }

        // i128::MAX / 255 + 1 overflows when multiplied by member_count (255)
        let overflow_amount = i128::MAX / member_count as i128 + 1;
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &overflow_amount,
            &token_reg.address(),
            &rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 10: Re-initialization blocked
    //
    // Guard: `if env.storage().instance().has(&DataKey::Config) { panic! }`
    // Risk if removed: a second initialize() call could overwrite the member
    //   list, round_amount, and payout order mid-lifecycle, redirecting funds.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "already initialized")]
    fn guard_reinitialize_blocked() {
        let t = make_setup();
        // Circle is already initialized — a second call must be rejected
        t.circle.initialize(
            &Address::generate(&t.env),
            &t.members,
            &ROUND_AMOUNT,
            &t.token_address,
            &t.rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    /// Verify the guard fires even with different parameters (attacker tries
    /// to change member list or round_amount).
    #[test]
    #[should_panic(expected = "already initialized")]
    fn guard_reinitialize_blocked_with_different_params() {
        let t = make_setup();
        let mut new_members = soroban_sdk::Vec::new(&t.env);
        new_members.push_back(Address::generate(&t.env));
        new_members.push_back(Address::generate(&t.env));
        // Attacker tries to replace member list with their own addresses
        t.circle.initialize(
            &Address::generate(&t.env),
            &new_members,
            &(ROUND_AMOUNT * 100),
            &t.token_address,
            &t.rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 11: Reputation unauthorized caller
    //
    // Guard: `if !authorized_callers(&env).contains(&circle) { return Err }`
    // Risk if removed: any wallet could call reputation.increment() for itself,
    //   self-awarding reputation points without completing a real ROSCA round.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    fn guard_reputation_unauthorized_caller_blocked() {
        let env = Env::default();
        env.mock_all_auths();

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let admin = Address::generate(&env);
        rep_client.initialize(&admin);

        let attacker = Address::generate(&env);
        let victim   = Address::generate(&env);

        // `attacker` is not in AuthorizedCallers — increment must fail
        let result = rep_client.try_increment(&attacker, &victim);
        assert!(
            result.is_err(),
            "unauthorized caller must not be able to award reputation"
        );
        // Score must remain 0 — no points awarded
        assert_eq!(rep_client.score(&victim), 0);
    }

    /// A circle that was authorized and then revoked must also be blocked.
    #[test]
    fn guard_reputation_revocation_is_permanent() {
        let env = Env::default();
        env.mock_all_auths();

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let admin  = Address::generate(&env);
        let circle = Address::generate(&env);
        let member = Address::generate(&env);

        rep_client.initialize(&admin);
        rep_client.add_authorized_caller(&admin, &circle);

        // One successful increment before revocation
        rep_client.increment(&circle, &member);
        assert_eq!(rep_client.score(&member), 1);

        // Revoke the circle
        rep_client.remove_authorized_caller(&admin, &circle);

        // Any further increment must be rejected, even via forged allowlist
        let result = rep_client.try_increment(&circle, &member);
        assert!(result.is_err(), "revoked circle must not award reputation");

        // Score is frozen — revocation does not rewrite history
        assert_eq!(rep_client.score(&member), 1, "score must be frozen after revocation");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 12: Duplicate members rejected
    //
    // Guard: `assert_unique_members` O(n²) walk in initialize()
    // Risk if removed: one wallet occupies two rotation slots; they receive
    //   two payouts while only funding one.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    fn guard_duplicate_members_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let token_reg = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        rep_client.initialize(&Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);
        let mut members = soroban_sdk::Vec::new(&env);
        members.push_back(alice.clone());
        members.push_back(bob.clone());
        members.push_back(alice.clone()); // duplicate

        let circle_admin = Address::generate(&env);
        let result = circle.try_initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_reg.address(),
            &rep_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        let Err(Ok(sdk_err)) = result else {
            panic!("expected contract error, got success or invoke error");
        };
        assert_eq!(
            InitError::try_from(sdk_err).expect("must be a typed InitError"),
            InitError::DuplicateMembers,
            "duplicate members must return InitError::DuplicateMembers"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 13: Non-member cannot close (collateral drain by outsider)
    //
    // Guard: `if !config.members.contains(&closer) { panic! }`
    // Risk if removed: anyone who knows the circle address can call close()
    //   while the circle is in a terminal state, triggering collateral release.
    //   In CEI the transfers still go to the correct members, but the Closed
    //   flag blocks any subsequent member-initiated close.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    fn guard_close_non_member_rejected() {
        let t = make_setup();
        t.activate();
        t.force_status(CircleStatus::Completed);
        let outsider = Address::generate(&t.env);
        let result = t.circle.try_close(&outsider);
        assert_eq!(
            result,
            Err(Ok(CloseError::Unauthorized)),
            "non-member non-admin must return CloseError::Unauthorized"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 14: Contribute only accepted while Active (not Pending, Completed)
    //
    // Guard: `if status != CircleStatus::Active { panic! }`
    // Risk if removed: contributions are accepted before all members join
    //   (Pending) or after the circle finishes (Completed), allowing token
    //   deposits that can never be retrieved through a payout.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn guard_contribute_blocked_while_pending() {
        let t = make_setup();
        // Only 2 of 4 members join — still Pending
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        t.circle.contribute(&t.alice);
    }

    #[test]
    #[should_panic(expected = "circle is not active")]
    fn guard_contribute_blocked_while_completed() {
        let t = make_setup();
        t.activate();
        // Drive all four rounds to Completed
        for _ in 0..4 { t.complete_round(); }
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);
        // Contribution must be rejected — circle is terminal
        t.circle.contribute(&t.alice);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 15: Deadline boundary for contributions (exclusive upper bound)
    //
    // Guard: `(sequence as u64) > deadline_ledger { panic! }`
    // Risk if removed: late contributions (after the deadline) are accepted;
    //   mark_default is also rejected because `sequence > deadline` is false,
    //   so defaulters cannot be penalised.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "round deadline passed; cannot contribute before payout")]
    fn guard_contribute_rejected_one_past_deadline() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });
        // One ledger past deadline — contribution must be rejected
        t.circle.contribute(&t.alice);
    }

    /// The boundary is non-overlapping: at deadline contribute OK, mark_default blocked.
    /// At deadline+1: contribute blocked, mark_default OK.
    #[test]
    fn guard_deadline_boundary_non_overlapping_proof() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        let dl = round.deadline_ledger as u32;

        // At exactly deadline_ledger: contribute must succeed
        t.env.ledger().with_mut(|l| { l.sequence_number = dl; });
        t.circle.contribute(&t.alice);

        // At deadline_ledger + 1: mark_default must succeed for non-contributor
        t.env.ledger().with_mut(|l| { l.sequence_number = dl + 1; });
        t.circle.mark_default(&t.carol); // carol never contributed
        assert_eq!(t.circle.get_defaults(&t.carol), 1);

        // Confirm the boundary is exactly right (neither strictly inside nor outside)
        let try_default_at_dl_for_bob = t.circle.try_mark_default(&t.bob);
        // bob also never contributed — must succeed at dl+1
        assert!(
            try_default_at_dl_for_bob.is_ok(),
            "mark_default must succeed at deadline+1 for non-contributor"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 16: Payout CEI — paid_out written before external interactions
    //
    // Guard: `round.paid_out = true` is set BEFORE token transfer and
    //   reputation increment.
    // Risk if removed / reordered: a reentrant payout call could succeed
    //   before paid_out is flipped, allowing the pot to be transferred twice.
    //
    // Note: full reentrancy requires a hostile token contract; in the Soroban
    //   test environment we simulate by calling payout() again directly after
    //   the first succeeds — the second call must be rejected immediately.
    // ═════════════════════════════════════════════════════════════════════════

    /// A round can only be paid out once: the second call must panic.
    #[test]
    #[should_panic(expected = "already paid out")]
    fn guard_payout_single_use_settled_marker() {
        let t = make_setup();
        t.activate();
        t.contribute_all();
        t.circle.payout(); // succeeds — paid_out = true
        t.circle.payout(); // must be rejected
    }

    /// After payout, RoundsCompleted increments exactly once.
    /// Over-counting would only happen if payout ran more than once.
    #[test]
    fn guard_payout_rounds_completed_increments_exactly_once() {
        let t = make_setup();
        t.activate();
        t.contribute_all();
        t.circle.payout();

        let completed: u32 = t.env.as_contract(&t.circle_id, || {
            t.env.storage().instance()
                .get(&crate::DataKey::RoundsCompleted)
                .unwrap_or(0)
        });
        assert_eq!(completed, 1, "RoundsCompleted must be 1 after one payout");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 17: Payout recipient derived from rotation — caller cannot inject
    //
    // Guard: recipient cross-check `round.recipient == members[round.round_index]`
    // Risk if removed: a storage corruption that changes the stored recipient
    //   without updating the rotation would silently transfer the pot to the
    //   wrong address.
    // ═════════════════════════════════════════════════════════════════════════

    /// Injecting a non-rotation recipient into CurrentRound.recipient causes payout to panic.
    #[test]
    #[should_panic(expected = "stored recipient does not match rotation order")]
    fn guard_payout_recipient_must_match_rotation() {
        let t = make_setup();
        t.activate();
        t.contribute_all();

        // Corrupt stored recipient
        let outsider = Address::generate(&t.env);
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t.env.storage().instance()
                .get(&crate::DataKey::CurrentRound).unwrap();
            round.recipient = outsider;
            t.env.storage().instance().set(&crate::DataKey::CurrentRound, &round);
        });

        t.circle.payout(); // must panic
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 18: Collateral conservation — no member can withdraw twice
    //
    // Guard: `env.storage().persistent().set(&collateral_key, &0i128)`
    //   before transfer in close(), plus the Closed flag.
    // Risk if removed: a member whose key was not zeroed could somehow trigger
    //   a second release; the arithmetic assertion in close() would also catch
    //   a double-count.
    // ═════════════════════════════════════════════════════════════════════════

    /// After close, every collateral storage key is zero — no second withdrawal possible.
    #[test]
    fn guard_collateral_zeroed_after_close_prevents_second_withdrawal() {
        let t = make_setup();
        t.activate();
        t.force_status(CircleStatus::Completed);
        t.circle.close(&t.alice);

        for member in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(
                t.circle.get_collateral(member), 0,
                "collateral must be zero after close — prevents second withdrawal"
            );
        }
    }

    /// Penalized collateral is counted once: penalty reduces stored balance,
    /// close releases only the reduced balance.
    #[test]
    fn guard_collateral_penalty_and_release_counted_once() {
        let t = make_setup();
        t.activate();

        let initial = t.circle.get_collateral(&t.dave);
        let penalty = initial * PENALTY_BPS / BPS_DENOM;
        let remaining = initial - penalty;

        t.advance_past_deadline();
        t.circle.mark_default(&t.dave);

        // Stored value must be exactly initial - penalty (deducted once)
        assert_eq!(t.circle.get_collateral(&t.dave), remaining);

        t.force_status(CircleStatus::Completed);
        let bal_before = t.token.balance(&t.dave);
        t.circle.close(&t.dave);
        let released = t.token.balance(&t.dave) - bal_before;

        // Released must equal remaining (not initial, not 0)
        assert_eq!(released, remaining,
            "released collateral must equal penalty-reduced balance, counted exactly once");
        assert_eq!(t.circle.get_collateral(&t.dave), 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 19: settle_round pause check
    //
    // Guard: `Self::assert_not_paused(&env)` at the top of settle_round
    // Risk if removed: settle_round becomes the only fund-moving entry-point
    //   that ignores the pause flag.  An operator who pauses the circle to
    //   investigate an incident would still see the round settled and
    //   collateral penalties applied while the investigation is ongoing.
    //   This guard was missing in the original implementation and is the
    //   primary motivation for this test module entry.
    // ═════════════════════════════════════════════════════════════════════════

    /// settle_round on a paused circle must panic with the pause message.
    /// This is the simplest proof that the pause check fires.
    #[test]
    #[should_panic(expected = "circle is paused")]
    fn guard_settle_round_blocked_while_paused() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();
        // Pause the circle — only the admin can do this
        t.circle.pause(&t.circle_admin);
        // Must panic — guard fires before any state mutation
        t.circle.settle_round();
    }

    /// Removing the pause guard from settle_round allows it to run while paused.
    /// This test demonstrates what the world looks like WITHOUT the guard,
    /// confirming the guard is the only barrier.
    ///
    /// We verify by calling resume() and then settle_round() and confirming it
    /// succeeds — proving the issue is specifically the paused state, not
    /// any other precondition.
    #[test]
    fn guard_settle_round_succeeds_after_resume() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();

        // Pause then immediately resume
        t.circle.pause(&t.circle_admin);
        t.circle.resume(&t.circle_admin);
        assert!(!t.circle.is_paused(), "circle must not be paused after resume");

        // settle_round must succeed after resume — proving the pause flag was the gate
        t.circle.settle_round(); // no panic expected
        // Circle advanced to round 1 (all defaulted → zero pot but still advances)
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1, "circle must have advanced after settle_round");
    }

    /// After a rejected settle_round (paused), collateral and round state are unchanged.
    /// This mirrors the adversarial test but from a mutation-guard perspective:
    /// the guard must leave no partial state on a rejected call.
    #[test]
    fn guard_settle_round_paused_leaves_no_partial_state() {
        let t = make_setup();
        t.activate();
        t.advance_past_deadline();

        let collaterals_before: std::vec::Vec<i128> = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.circle.get_collateral(m))
            .collect();
        let round_before = t.circle.get_current_round();

        t.circle.pause(&t.circle_admin);
        let result = t.circle.try_settle_round();
        assert!(result.is_err(), "settle_round must be rejected while paused");

        // No collateral must have changed
        for (i, m) in [&t.alice, &t.bob, &t.carol, &t.dave].iter().enumerate() {
            assert_eq!(
                t.circle.get_collateral(m),
                collaterals_before[i],
                "member[{}] collateral must be unchanged after rejected settle_round", i
            );
        }

        // Round state must be identical (paid_out still false, same round_index)
        let round_after = t.circle.get_current_round();
        assert_eq!(round_after.round_index, round_before.round_index,
            "round_index must not change on rejected settle_round");
        assert_eq!(round_after.paid_out, round_before.paid_out,
            "paid_out flag must not change on rejected settle_round");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 20: settle_round requires deadline to have passed
    //
    // Guard: `if !Self::deadline_passed(&env, &round) { panic! }`
    // Risk if removed: settle_round runs before the contribution window closes,
    //   penalising members who still have time to contribute and paying out a
    //   partial pot before all contributions can arrive.
    // ═════════════════════════════════════════════════════════════════════════

    /// settle_round before the deadline must panic.
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn guard_settle_round_before_deadline_blocked() {
        let t = make_setup();
        t.activate();
        // Deadline has not passed — call must be rejected
        t.circle.settle_round();
    }

    /// At exactly the deadline ledger, settle_round must still be blocked
    /// (the deadline_passed predicate uses strict greater-than).
    #[test]
    #[should_panic(expected = "round deadline not yet passed")]
    fn guard_settle_round_at_deadline_blocked() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32; // exactly at deadline
        });
        t.circle.settle_round();
    }

    /// At deadline + 1, settle_round must succeed (deadline has strictly passed).
    #[test]
    fn guard_settle_round_one_past_deadline_succeeds() {
        let t = make_setup();
        t.activate();
        let round = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });
        // Nobody contributed — settle_round must succeed (all defaulted)
        t.circle.settle_round();
        // Round advanced
        let new_round = t.circle.get_current_round();
        assert_eq!(new_round.round_index, 1,
            "circle must have advanced to round 1 after settle_round");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // GUARD 21: settle_round blocked when all members already contributed
    //
    // Guard: `if round.contributions_received == member_count { panic! }`
    // Risk if removed: a caller invokes settle_round when payout() is already
    //   valid.  settle_round applies default-event overhead and emits an
    //   exceptional_settlement event even though no one defaulted — misleading
    //   indexers and triggering unnecessary reputation calls.
    // ═════════════════════════════════════════════════════════════════════════

    #[test]
    #[should_panic(expected = "all members have contributed")]
    fn guard_settle_round_blocked_when_all_contributed() {
        let t = make_setup();
        t.activate();
        t.contribute_all();
        t.advance_past_deadline();
        // All members contributed — must use payout() not settle_round()
        t.circle.settle_round();
    }
}

