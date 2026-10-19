//! Tests for the shared `test_support` module (Issue #574).
//!
//! # What is tested
//!
//! 1. **FixtureBuilder defaults** — `fixture()` produces the same shape as the
//!    old hard-wired constructor: 4 members, ROUND_AMOUNT, 1_000 ledger deadline.
//! 2. **FixtureBuilder.members(n)** — produces exactly `n` members, all funded.
//! 3. **FixtureBuilder.round_amount(x)** — collateral equals `x * COLLATERAL_MULTIPLIER`.
//! 4. **FixtureBuilder.round_deadline(x)** — deadline propagates into the
//!    round-0 deadline ledger after activation.
//! 5. **FixtureBuilder.register_reputation(false)** — payout panics with the
//!    typed reputation error instead of succeeding.
//! 6. **Type-safe Fixture helpers** — `force_status`, `force_collateral`,
//!    `force_contributed`, `complete_round`, `complete_all_rounds`.
//! 7. **Regression: member() panics for out-of-bounds index** — ensures tests
//!    that call `member(i)` with a bad index get a clear failure rather than
//!    silent wrong-address behaviour.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, fixture_with, FixtureBuilder, ROUND_AMOUNT, COLLATERAL};
use crate::{CircleStatus, COLLATERAL_MULTIPLIER};
use soroban_sdk::testutils::Ledger;

// ── 1: Default fixture shape ──────────────────────────────────────────────────

#[test]
fn default_fixture_has_four_members() {
    let t = fixture();
    assert_eq!(t.member_count(), 4);
}

#[test]
fn default_fixture_round_amount_matches_constant() {
    let t = fixture();
    let config = t.circle.get_config();
    assert_eq!(config.round_amount, ROUND_AMOUNT);
}

#[test]
fn default_fixture_collateral_equals_round_amount_times_multiplier() {
    let t = fixture();
    assert_eq!(COLLATERAL, ROUND_AMOUNT * COLLATERAL_MULTIPLIER);
    for m in t.members.iter() {
        // Before join: wallet holds collateral + N round contributions
        assert_eq!(
            t.token.balance(&m),
            COLLATERAL + ROUND_AMOUNT * t.member_count() as i128,
            "each member must be funded for collateral + all rounds"
        );
    }
}

#[test]
fn default_fixture_status_is_pending_before_joins() {
    let t = fixture();
    assert_eq!(t.circle.get_status(), CircleStatus::Pending);
}

#[test]
fn default_fixture_reputation_is_wired() {
    let t = fixture();
    t.join_all();
    t.contribute_all();
    t.circle.payout(); // must not panic — circle is registered with reputation
    assert_eq!(t.rep.score(&t.alice), 1);
}

// ── 2: FixtureBuilder.members(n) ─────────────────────────────────────────────

#[test]
fn builder_two_members_produces_two_member_circle() {
    let t = FixtureBuilder::default().members(2).build();
    assert_eq!(t.member_count(), 2);
    assert_eq!(t.circle.get_config().members.len(), 2);
}

#[test]
fn builder_six_members_produces_six_member_circle() {
    let t = FixtureBuilder::default().members(6).build();
    assert_eq!(t.member_count(), 6);
    t.join_all();
    assert_eq!(t.circle.get_status(), CircleStatus::Active);
}

#[test]
fn builder_members_all_funded_for_their_round_count() {
    let n = 3u32;
    let t = FixtureBuilder::default().members(n).build();
    let expected = COLLATERAL + ROUND_AMOUNT * n as i128;
    for i in 0..n {
        assert_eq!(
            t.token.balance(&t.member(i)),
            expected,
            "member {i} must be funded for collateral + {n} rounds"
        );
    }
}

// ── 3: FixtureBuilder.round_amount(x) ────────────────────────────────────────

#[test]
fn builder_custom_round_amount_stored_in_config() {
    let custom = 50_000_000i128; // 5 USDC
    let t = FixtureBuilder::default().round_amount(custom).build();
    assert_eq!(t.circle.get_config().unwrap().round_amount, custom);
}

#[test]
fn builder_custom_round_amount_collateral_is_correct() {
    let custom = 50_000_000i128;
    let t = FixtureBuilder::default().round_amount(custom).build();
    t.circle.join(&t.alice);
    assert_eq!(
        t.circle.get_collateral(&t.alice),
        custom * COLLATERAL_MULTIPLIER,
        "collateral must equal round_amount × COLLATERAL_MULTIPLIER"
    );
}

// ── 4: FixtureBuilder.round_deadline(x) ──────────────────────────────────────

#[test]
fn builder_custom_deadline_propagates_into_round_zero() {
    let deadline_ledgers = 500u32;
    let t = FixtureBuilder::default().round_deadline(deadline_ledgers).build();
    t.join_all(); // activates, sets round-0 deadline
    let round = t.circle.get_current_round();
    let seq = t.env.ledger().sequence();
    assert_eq!(
        round.deadline_ledger,
        seq as u64 + deadline_ledgers as u64,
        "round-0 deadline must be activation_ledger + round_deadline_ledgers"
    );
}

// ── 5: FixtureBuilder.register_reputation(false) ─────────────────────────────

#[test]
fn builder_without_reputation_payout_panics() {
    let t = FixtureBuilder::default().register_reputation(false).build();
    t.join_all();
    t.contribute_all();
    assert!(
        t.circle.try_payout().is_err(),
        "payout must fail when circle is not registered with reputation"
    );
}

#[test]
fn fixture_with_false_is_equivalent_to_builder_register_reputation_false() {
    let t = fixture_with(false);
    t.join_all();
    t.contribute_all();
    assert!(t.circle.try_payout().is_err());
}

// ── 6: Type-safe Fixture helpers ─────────────────────────────────────────────

#[test]
fn helper_force_status_sets_completed_with_rounds_completed() {
    let t = fixture();
    t.join_all();
    t.force_status(CircleStatus::Completed);
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    // close() reads RoundsCompleted — must not panic
    t.circle.close(&t.alice);
}

#[test]
fn helper_force_collateral_sets_exact_value() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.force_collateral(&t.alice, 12_345_678);
    assert_eq!(t.circle.get_collateral(&t.alice), 12_345_678);
}

#[test]
fn helper_force_contributed_writes_key_readable_by_has_contributed() {
    let t = fixture();
    t.join_all();
    t.force_contributed(&t.alice, 0);
    assert!(
        t.circle.has_contributed(&t.alice, &0),
        "has_contributed must return true after force_contributed"
    );
}

#[test]
fn helper_complete_round_returns_correct_round_index() {
    let t = fixture();
    t.join_all();
    let idx = t.complete_round();
    assert_eq!(idx, 0, "first complete_round must return index 0");
    let next = t.circle.get_current_round();
    assert_eq!(next.round_index, 1);
}

#[test]
fn helper_complete_all_rounds_reaches_completed_status() {
    let t = fixture();
    t.join_all();
    t.complete_all_rounds();
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);
}

#[test]
fn helper_member_count_matches_member_vec_length() {
    let t = FixtureBuilder::default().members(3).build();
    assert_eq!(t.member_count(), t.members.len());
}

#[test]
fn helper_drain_and_refund_circle_round_trips_funds() {
    let t = fixture();
    t.join_all();
    let before = t.token.balance(&t.circle_id);
    let sink = t.drain_circle(ROUND_AMOUNT);
    assert_eq!(t.token.balance(&t.circle_id), before - ROUND_AMOUNT);
    t.refund_circle(&sink, ROUND_AMOUNT);
    assert_eq!(t.token.balance(&t.circle_id), before);
}

// ── 7: member() bounds check ──────────────────────────────────────────────────

#[test]
#[should_panic]
fn helper_member_out_of_bounds_panics() {
    let t = FixtureBuilder::default().members(2).build();
    // index 2 does not exist in a 2-member circle
    let _ = t.member(2);
}
