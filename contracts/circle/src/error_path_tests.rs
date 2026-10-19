//! Error-path tests for removed unsafe unwrap/default patterns (issue #567).
//!
//! # Invariants under test
//!
//! 1. A failed reputation increment is never swallowed: payout and
//!    settle_round panic with the typed `ReputationError` in the message and
//!    roll back the whole settlement (no pot transfer, round still payable).
//! 2. A missing `RoundsCompleted` counter is reported as a storage
//!    inconsistency instead of being silently restarted at 0.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, fixture_with, ROUND_AMOUNT};
use crate::{CircleStatus, DataKey};

// ── 1: reputation failures ───────────────────────────────────────────────────

#[test]
#[should_panic(expected = "UnauthorizedCaller")]
fn payout_reports_typed_error_when_circle_not_registered() {
    let t = fixture_with(false);
    t.join_all();
    t.contribute_all();
    t.circle.payout();
}

#[test]
#[should_panic(expected = "UnauthorizedCaller")]
fn payout_reports_typed_error_when_circle_revoked() {
    let t = fixture();
    t.rep.remove_authorized_caller(&t.rep_admin, &t.circle_id);
    t.join_all();
    t.contribute_all();
    t.circle.payout();
}

#[test]
fn failed_reputation_increment_rolls_back_payout() {
    let t = fixture_with(false);
    t.join_all();
    t.contribute_all();
    let circle_balance = t.token.balance(&t.circle_id);
    let alice_balance = t.token.balance(&t.alice);

    assert!(t.circle.try_payout().is_err());

    let round = t.circle.get_current_round();
    assert!(!round.paid_out, "paid_out must roll back");
    assert_eq!(round.round_index, 0);
    assert_eq!(t.token.balance(&t.circle_id), circle_balance);
    assert_eq!(t.token.balance(&t.alice), alice_balance);
    assert_eq!(t.rep.score(&t.alice), 0);

    // Once the operator registers the circle, the same round pays out.
    t.rep.add_authorized_caller(&t.rep_admin, &t.circle_id);
    t.circle.payout();
    assert_eq!(t.token.balance(&t.alice), alice_balance + ROUND_AMOUNT * 4);
    assert_eq!(t.rep.score(&t.alice), 1);
}

#[test]
#[should_panic(expected = "UnauthorizedCaller")]
fn settle_round_reports_typed_error_when_circle_not_registered() {
    let t = fixture_with(false);
    t.join_all();
    t.circle.contribute(&t.alice);
    t.advance_past_deadline();
    t.circle.settle_round();
}

#[test]
fn failed_reputation_increment_rolls_back_settle_round_penalties() {
    let t = fixture_with(false);
    t.join_all();
    t.circle.contribute(&t.alice);
    t.advance_past_deadline();
    let bob_collateral = t.circle.get_collateral(&t.bob);

    assert!(t.circle.try_settle_round().is_err());

    assert!(!t.circle.get_current_round().paid_out);
    assert_eq!(t.circle.get_collateral(&t.bob), bob_collateral);
    assert_eq!(t.circle.get_defaults(&t.bob), 0);
}

// ── 2: RoundsCompleted must exist ────────────────────────────────────────────

fn remove_rounds_completed(t: &crate::test_support::Fixture) {
    t.env.as_contract(&t.circle_id, || {
        t.env.storage().instance().remove(&DataKey::RoundsCompleted);
    });
}

#[test]
#[should_panic(expected = "RoundsCompleted missing")]
fn payout_rejects_missing_rounds_completed() {
    let t = fixture();
    t.join_all();
    t.contribute_all();
    remove_rounds_completed(&t);
    t.circle.payout();
}

#[test]
#[should_panic(expected = "RoundsCompleted missing")]
fn settle_round_rejects_missing_rounds_completed() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&t.alice);
    t.advance_past_deadline();
    remove_rounds_completed(&t);
    t.circle.settle_round();
}

#[test]
#[should_panic(expected = "RoundsCompleted missing")]
fn close_rejects_missing_rounds_completed_on_completed_circle() {
    let t = fixture();
    t.join_all();
    for _ in 0..4 {
        t.contribute_all();
        t.circle.payout();
    }
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);
    remove_rounds_completed(&t);
    t.circle.close(&t.alice);
}
