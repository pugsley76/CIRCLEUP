//! Failed token-transfer handling (issue #573).
//!
//! Every fund-moving entry point goes through `safe_transfer`.  For each one
//! these tests drive a real token failure (empty wallet, de-authorized
//! trustline, or an under-funded circle) and assert that:
//!
//! 1. the call fails with the contextual `USDC transfer failed during …`
//!    message rather than an opaque token trap;
//! 2. every storage write made before the transfer is rolled back
//!    (collateral slot, contribution record, `paid_out`, penalties, `Closed`);
//! 3. the same call succeeds once the cause is fixed — nothing is left in a
//!    half-applied state that blocks a retry.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, COLLATERAL, ROUND_AMOUNT};
use crate::CircleStatus;

// ── join ─────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "USDC transfer failed during join collateral deposit")]
fn join_with_empty_wallet_panics_with_context() {
    let t = fixture();
    t.empty_wallet(&t.alice);
    t.circle.join(&t.alice);
}

#[test]
fn join_with_empty_wallet_rolls_back_and_can_retry() {
    let t = fixture();
    let bal = t.empty_wallet(&t.alice);

    assert!(t.circle.try_join(&t.alice).is_err());
    assert_eq!(t.circle.get_collateral(&t.alice), 0, "reserved slot must roll back");
    assert_eq!(t.token.balance(&t.circle_id), 0);

    t.asset.mint(&t.alice, &bal);
    t.circle.join(&t.alice);
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
    assert_eq!(t.token.balance(&t.circle_id), COLLATERAL);
}

#[test]
fn join_with_deauthorized_trustline_rolls_back_and_can_retry() {
    let t = fixture();
    t.asset.set_authorized(&t.alice, &false);

    assert!(t.circle.try_join(&t.alice).is_err());
    assert_eq!(t.circle.get_collateral(&t.alice), 0);

    t.asset.set_authorized(&t.alice, &true);
    t.circle.join(&t.alice);
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
}

#[test]
fn join_locks_exactly_the_recorded_collateral() {
    let t = fixture();
    let before = t.token.balance(&t.alice);
    t.circle.join(&t.alice);
    let locked = before - t.token.balance(&t.alice);
    assert_eq!(locked, t.circle.get_collateral(&t.alice));
    assert_eq!(locked, t.token.balance(&t.circle_id));
}

#[test]
fn failed_last_join_does_not_activate_circle() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.join(&t.bob);
    t.circle.join(&t.carol);
    t.empty_wallet(&t.dave);

    assert!(t.circle.try_join(&t.dave).is_err());
    assert_eq!(t.circle.get_status(), CircleStatus::Pending);
}

// ── contribute ───────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "USDC transfer failed during round contribution")]
fn contribute_with_empty_wallet_panics_with_context() {
    let t = fixture();
    t.join_all();
    t.empty_wallet(&t.alice);
    t.circle.contribute(&t.alice);
}

#[test]
fn contribute_with_empty_wallet_rolls_back_and_can_retry() {
    let t = fixture();
    t.join_all();
    let bal = t.empty_wallet(&t.alice);

    assert!(t.circle.try_contribute(&t.alice).is_err());
    assert!(!t.circle.has_contributed(&t.alice, &0));
    assert_eq!(t.circle.get_current_round().contributions_received, 0);

    t.asset.mint(&t.alice, &bal);
    t.circle.contribute(&t.alice);
    assert!(t.circle.has_contributed(&t.alice, &0));
    assert_eq!(t.circle.get_current_round().contributions_received, 1);
}

// ── payout ───────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "USDC transfer failed during round payout")]
fn payout_from_underfunded_circle_panics_with_context() {
    let t = fixture();
    t.join_all();
    t.contribute_all();
    // Drain everything (pot + locked collateral) so the pot cannot be covered.
    t.drain_circle(t.token.balance(&t.circle_id));
    t.circle.payout();
}

#[test]
fn payout_from_underfunded_circle_rolls_back_and_can_retry() {
    let t = fixture();
    t.join_all();
    t.contribute_all();
    let alice_before = t.token.balance(&t.alice);
    let held = t.token.balance(&t.circle_id);
    let sink = t.drain_circle(held);

    assert!(t.circle.try_payout().is_err());
    let round = t.circle.get_current_round();
    assert!(!round.paid_out, "paid_out must roll back");
    assert_eq!(round.round_index, 0);
    assert_eq!(t.token.balance(&t.alice), alice_before);
    assert_eq!(t.rep.score(&t.alice), 0, "reputation must not be awarded");

    t.refund_circle(&sink, held);
    t.circle.payout();
    assert_eq!(t.token.balance(&t.alice), alice_before + ROUND_AMOUNT * 4);
    assert_eq!(t.circle.get_current_round().round_index, 1);
}

// ── settle_round ─────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "USDC transfer failed during exceptional round settlement")]
fn settle_round_from_underfunded_circle_panics_with_context() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&t.alice);
    t.advance_past_deadline();
    t.drain_circle(t.token.balance(&t.circle_id));
    t.circle.settle_round();
}

#[test]
fn settle_round_from_underfunded_circle_rolls_back_penalties_and_can_retry() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&t.alice);
    t.advance_past_deadline();
    let drained = t.token.balance(&t.circle_id);
    let sink = t.drain_circle(drained);

    assert!(t.circle.try_settle_round().is_err());
    assert!(!t.circle.get_current_round().paid_out);
    for m in [&t.bob, &t.carol, &t.dave] {
        assert_eq!(t.circle.get_collateral(m), COLLATERAL, "penalty must roll back");
        assert_eq!(t.circle.get_defaults(m), 0);
    }

    t.refund_circle(&sink, drained);
    t.circle.settle_round();
    assert_eq!(t.circle.get_current_round().round_index, 1);
    assert_eq!(t.circle.get_defaults(&t.bob), 1);
}

// ── close ────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "USDC transfer failed during collateral release")]
fn close_from_underfunded_circle_panics_with_context() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);
    t.drain_circle(COLLATERAL);
    t.circle.close(&t.alice);
}

#[test]
fn close_from_underfunded_circle_rolls_back_and_can_retry() {
    let t = fixture();
    t.join_all();
    for _ in 0..4 {
        t.contribute_all();
        t.circle.payout();
    }
    let held = t.token.balance(&t.circle_id);
    assert_eq!(held, COLLATERAL * 4);
    let sink = t.drain_circle(held);

    assert!(t.circle.try_close(&t.alice).is_err());
    assert!(!t.circle.is_closed(), "Closed flag must roll back");
    for m in t.members.iter() {
        assert_eq!(t.circle.get_collateral(&m), COLLATERAL, "collateral must roll back");
    }

    t.refund_circle(&sink, held);
    let bob_before = t.token.balance(&t.bob);
    t.circle.close(&t.alice);
    assert!(t.circle.is_closed());
    assert_eq!(t.token.balance(&t.bob), bob_before + COLLATERAL);
    assert_eq!(t.token.balance(&t.circle_id), 0);
}
