//! Cancellation and collateral recovery invariants tests — Issue #689
//!
//! # Protocol Invariants Under Test
//!
//! 1. **Cancellation Timing**:
//!    - Circle can ONLY be cancelled while in `Pending` state (before all members join).
//!    - Cancellation while `Active` must be strictly rejected.
//!    - Cancellation while `Completed` must be strictly rejected.
//!
//! 2. **Partial Membership Cancellation**:
//!    - Circle can be cancelled when 0 members have joined.
//!    - Circle can be cancelled when 1 member has joined.
//!    - Circle can be cancelled when several (e.g. 2 or 3 of 4) members have joined.
//!
//! 3. **Collateral Recovery Accuracy**:
//!    - ONLY members who actually joined receive their collateral back.
//!    - Members who have not joined receive zero collateral refund.
//!    - Contract token balance is exactly zero after close settlement.
//!    - Member collateral storage entries are zeroed out after settlement.
//!
//! 4. **Repeat Close Rejection**:
//!    - Calling `close()` more than once on a cancelled circle must fail with `CloseError::AlreadyClosed`.
//!    - Storage and balances remain completely unaltered by repeated calls.
//!
//! 5. **Unauthorized Actors Rejected**:
//!    - Non-member addresses cannot call `cancel()` (rejected with panic).
//!    - Non-member addresses (neither admin nor configured member) cannot call `close()`
//!      (rejected with `CloseError::Unauthorized`).
//!    - Both configured circle members and the circle contract admin are authorized to call `close()`.
//!
//! 6. **Post-Cancellation State Invariants**:
//!    - Circle status is `CircleStatus::Cancelled`.
//!    - `join()` is rejected in `Cancelled` state.
//!    - `contribute()` is rejected in `Cancelled` state.
//!    - `payout()` is rejected in `Cancelled` state.
//!
//! 7. **Event Emission Integrity**:
//!    - `cancelled` event is emitted with `(circle_address, caller, ledger_sequence)`.
//!    - `collateral_released` event is emitted only for members who actually deposited collateral.
//!    - `closed` event is emitted with reason `"cancelled"`, total_released, and total_expected_collateral.
//!
//! 8. **No Cross-Member Withdrawal**:
//!    - A closer (whether they joined or not) cannot claim another member's collateral.
//!    - Collateral is strictly returned to the address of the member who deposited it.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, COLLATERAL};
use crate::{CircleStatus, CloseError, EVENT_NAMESPACE};
use soroban_sdk::{
    testutils::Address as _,
    Address, FromVal, Symbol, Val, Vec,
};

type EventRecord = (Vec<Val>, Val);

/// Filter circle events matching a specific subtopic name (e.g. "cancelled", "collateral_released", "closed").
fn filter_circle_events(
    env: &soroban_sdk::Env,
    _circle_id: &Address,
    events: &[EventRecord],
    topic_name: &str,
) -> std::vec::Vec<Val> {
    let ns = Symbol::new(env, EVENT_NAMESPACE);
    let target = Symbol::new(env, topic_name);
    let mut matching = std::vec::Vec::new();

    for (topics, data) in events {
        if topics.len() >= 2 {
            let topic0 = Symbol::from_val(env, &topics.get(0).unwrap());
            let topic1 = Symbol::from_val(env, &topics.get(1).unwrap());
            if topic0 == ns && topic1 == target {
                matching.push(data.clone());
            }
        }
    }
    matching
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Cancellation Timing
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_cancel_pending_succeeds_and_sets_cancelled_status() {
    let t = fixture();
    assert_eq!(t.circle.get_status(), CircleStatus::Pending);

    // Cancel while 0 members joined
    t.circle.cancel(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "can only cancel a pending circle")]
fn test_cancel_after_active_rejected() {
    let t = fixture();
    t.join_all();
    assert_eq!(t.circle.get_status(), CircleStatus::Active);

    // Should panic: cannot cancel active circle
    t.circle.cancel(&t.alice);
}

#[test]
#[should_panic(expected = "can only cancel a pending circle")]
fn test_cancel_after_completed_rejected() {
    let t = fixture();
    t.join_all();
    t.complete_all_rounds();
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);

    // Should panic: cannot cancel completed circle
    t.circle.cancel(&t.alice);
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Partial Membership & Collateral Recovery Accuracy
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_cancel_with_zero_joiners_recovers_cleanly() {
    let t = fixture();

    // Initial balances before any action
    let init_alice = t.token.balance(&t.alice);
    let init_bob = t.token.balance(&t.bob);
    let init_carol = t.token.balance(&t.carol);
    let init_dave = t.token.balance(&t.dave);
    assert_eq!(t.token.balance(&t.circle_id), 0);

    // 0 members joined; alice cancels
    t.circle.cancel(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Close by alice
    let res = t.circle.close(&t.alice);
    assert_eq!(res, ());
    assert!(t.circle.is_closed());

    // All balances must remain exactly as initially minted
    assert_eq!(t.token.balance(&t.alice), init_alice);
    assert_eq!(t.token.balance(&t.bob), init_bob);
    assert_eq!(t.token.balance(&t.carol), init_carol);
    assert_eq!(t.token.balance(&t.dave), init_dave);
    assert_eq!(t.token.balance(&t.circle_id), 0);
}

#[test]
fn test_cancel_with_one_joiner_refunds_only_joined_member() {
    let t = fixture();

    let init_alice = t.token.balance(&t.alice);
    let init_bob = t.token.balance(&t.bob);
    let init_carol = t.token.balance(&t.carol);
    let init_dave = t.token.balance(&t.dave);

    // Only Alice joins
    t.circle.join(&t.alice);
    assert_eq!(t.token.balance(&t.alice), init_alice - COLLATERAL);
    assert_eq!(t.token.balance(&t.circle_id), COLLATERAL);
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
    assert_eq!(t.circle.get_collateral(&t.bob), 0);

    // Bob (a configured member who did not join) cancels
    t.circle.cancel(&t.bob);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Admin triggers close
    t.circle.close(&t.admin);
    assert!(t.circle.is_closed());

    // Exact balance verification: Alice received her collateral back
    assert_eq!(t.token.balance(&t.alice), init_alice, "alice collateral restored");
    assert_eq!(t.token.balance(&t.bob), init_bob, "bob balance unchanged");
    assert_eq!(t.token.balance(&t.carol), init_carol, "carol balance unchanged");
    assert_eq!(t.token.balance(&t.dave), init_dave, "dave balance unchanged");
    assert_eq!(t.token.balance(&t.circle_id), 0, "contract token balance strictly 0");

    // Collateral storage entries zeroed
    assert_eq!(t.circle.get_collateral(&t.alice), 0);
}

#[test]
fn test_cancel_with_several_joiners_refunds_joined_members_and_leaves_unjoined_intact() {
    let t = fixture();

    let init_alice = t.token.balance(&t.alice);
    let init_bob = t.token.balance(&t.bob);
    let init_carol = t.token.balance(&t.carol);
    let init_dave = t.token.balance(&t.dave);

    // Alice and Bob join (2 of 4)
    t.circle.join(&t.alice);
    t.circle.join(&t.bob);
    assert_eq!(t.token.balance(&t.circle_id), COLLATERAL * 2);

    // Carol cancels
    t.circle.cancel(&t.carol);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Dave (did not join) triggers close
    t.circle.close(&t.dave);
    assert!(t.circle.is_closed());

    // Balance checks
    assert_eq!(t.token.balance(&t.alice), init_alice, "alice refunded");
    assert_eq!(t.token.balance(&t.bob), init_bob, "bob refunded");
    assert_eq!(t.token.balance(&t.carol), init_carol, "carol unchanged");
    assert_eq!(t.token.balance(&t.dave), init_dave, "dave unchanged");
    assert_eq!(t.token.balance(&t.circle_id), 0, "contract balance zero");

    // Storage checks
    assert_eq!(t.circle.get_collateral(&t.alice), 0);
    assert_eq!(t.circle.get_collateral(&t.bob), 0);
    assert_eq!(t.circle.get_collateral(&t.carol), 0);
    assert_eq!(t.circle.get_collateral(&t.dave), 0);
}

#[test]
fn test_cancel_with_three_joiners_partial_membership() {
    let t = fixture();

    let init_alice = t.token.balance(&t.alice);
    let init_bob = t.token.balance(&t.bob);
    let init_carol = t.token.balance(&t.carol);
    let init_dave = t.token.balance(&t.dave);

    // Alice, Bob, and Carol join (3 of 4)
    t.circle.join(&t.alice);
    t.circle.join(&t.bob);
    t.circle.join(&t.carol);
    assert_eq!(t.token.balance(&t.circle_id), COLLATERAL * 3);

    // Dave calls cancel
    t.circle.cancel(&t.dave);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Close called by Alice
    t.circle.close(&t.alice);
    assert!(t.circle.is_closed());

    // Alice, Bob, Carol refunded; Dave unchanged
    assert_eq!(t.token.balance(&t.alice), init_alice);
    assert_eq!(t.token.balance(&t.bob), init_bob);
    assert_eq!(t.token.balance(&t.carol), init_carol);
    assert_eq!(t.token.balance(&t.dave), init_dave);
    assert_eq!(t.token.balance(&t.circle_id), 0);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Repeat Close & Premature Close Rejection
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_repeat_close_on_cancelled_circle_rejected() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);

    // First close succeeds
    assert_eq!(t.circle.close(&t.alice), ());
    assert!(t.circle.is_closed());

    // Second close must fail with AlreadyClosed
    let second = t.circle.try_close(&t.alice);
    assert_eq!(second, Err(Ok(CloseError::AlreadyClosed)));

    // Third close from another member also fails with AlreadyClosed
    let third = t.circle.try_close(&t.bob);
    assert_eq!(third, Err(Ok(CloseError::AlreadyClosed)));
}

#[test]
fn test_close_rejected_while_pending() {
    let t = fixture();
    assert_eq!(t.circle.get_status(), CircleStatus::Pending);

    // Attempting close while Pending must return NotTerminalState
    let res = t.circle.try_close(&t.alice);
    assert_eq!(res, Err(Ok(CloseError::NotTerminalState)));
    assert!(!t.circle.is_closed());
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Unauthorized Actors Rejection
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "not a circle member")]
fn test_unauthorized_cancel_rejected() {
    let t = fixture();
    let stranger = Address::generate(&t.env);

    // Stranger cannot cancel circle
    t.circle.cancel(&stranger);
}

#[test]
fn test_unauthorized_close_rejected() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);

    let stranger = Address::generate(&t.env);

    // Stranger cannot close circle
    let res = t.circle.try_close(&stranger);
    assert_eq!(res, Err(Ok(CloseError::Unauthorized)));
    assert!(!t.circle.is_closed());

    // State and collateral undisturbed
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
    assert_eq!(t.token.balance(&t.circle_id), COLLATERAL);
}

#[test]
fn test_authorized_closers_admin_and_members() {
    // Test 1: Admin can close
    let t1 = fixture();
    t1.circle.cancel(&t1.alice);
    assert_eq!(t1.circle.close(&t1.admin), ());
    assert!(t1.circle.is_closed());

    // Test 2: Any member can close
    let t2 = fixture();
    t2.circle.cancel(&t2.alice);
    assert_eq!(t2.circle.close(&t2.dave), ());
    assert!(t2.circle.is_closed());
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. Post-Cancellation Lifecycle Invariants
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "circle not accepting members")]
fn test_join_rejected_after_cancellation() {
    let t = fixture();
    t.circle.cancel(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Bob tries to join after cancellation
    t.circle.join(&t.bob);
}

#[test]
#[should_panic(expected = "circle is not active")]
fn test_contribute_rejected_after_cancellation() {
    let t = fixture();
    t.circle.cancel(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Alice tries to contribute after cancellation
    t.circle.contribute(&t.alice);
}

#[test]
#[should_panic(expected = "circle is not active")]
fn test_payout_rejected_after_cancellation() {
    let t = fixture();
    t.circle.cancel(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

    // Payout call after cancellation
    t.circle.payout();
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. Event Emission Integrity
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_cancellation_and_close_events_emitted_accurately() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.join(&t.bob);

    // 1. Capture cancel event
    let cancel_events = t.circle_events_of(|| {
        t.circle.cancel(&t.carol);
    });

    let cancelled_payloads = filter_circle_events(&t.env, &t.circle_id, &cancel_events, "cancelled");
    assert_eq!(cancelled_payloads.len(), 1, "exactly one cancelled event");

    let (c_circle, c_caller, c_ledger): (Address, Address, u32) =
        FromVal::from_val(&t.env, &cancelled_payloads[0]);
    assert_eq!(c_circle, t.circle_id);
    assert_eq!(c_caller, t.carol);
    assert_eq!(c_ledger, t.env.ledger().sequence());

    // 2. Capture close event and collateral_released events
    let close_events = t.circle_events_of(|| {
        t.circle.close(&t.dave);
    });

    // collateral_released events should be emitted ONLY for Alice and Bob
    let released_payloads =
        filter_circle_events(&t.env, &t.circle_id, &close_events, "collateral_released");
    assert_eq!(released_payloads.len(), 2, "collateral released for 2 joined members");

    let (r1_circle, r1_member, r1_amount): (Address, Address, i128) =
        FromVal::from_val(&t.env, &released_payloads[0]);
    assert_eq!(r1_circle, t.circle_id);
    assert_eq!(r1_member, t.alice);
    assert_eq!(r1_amount, COLLATERAL);

    let (r2_circle, r2_member, r2_amount): (Address, Address, i128) =
        FromVal::from_val(&t.env, &released_payloads[1]);
    assert_eq!(r2_circle, t.circle_id);
    assert_eq!(r2_member, t.bob);
    assert_eq!(r2_amount, COLLATERAL);

    // closed event
    let closed_payloads = filter_circle_events(&t.env, &t.circle_id, &close_events, "closed");
    assert_eq!(closed_payloads.len(), 1, "exactly one closed event");

    let (cl_circle, cl_closer, cl_released, cl_expected, cl_reason): (
        Address,
        Address,
        i128,
        i128,
        Symbol,
    ) = FromVal::from_val(&t.env, &closed_payloads[0]);

    let expected_total_collateral = COLLATERAL * 4; // 4 members * COLLATERAL
    assert_eq!(cl_circle, t.circle_id);
    assert_eq!(cl_closer, t.dave);
    assert_eq!(cl_released, COLLATERAL * 2);
    assert_eq!(cl_expected, expected_total_collateral);
    assert_eq!(cl_reason, Symbol::new(&t.env, "cancelled"));
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. No Cross-Member Withdrawal
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_no_cross_member_withdrawal_by_closer() {
    let t = fixture();

    // Alice joins with collateral
    t.circle.join(&t.alice);

    let alice_bal_after_join = t.token.balance(&t.alice);
    let dave_bal_before_close = t.token.balance(&t.dave);

    // Dave (who did not join and has 0 collateral) cancels and closes
    t.circle.cancel(&t.dave);
    t.circle.close(&t.dave);

    // Dave receives 0 from settlement; Alice receives her exact collateral
    assert_eq!(
        t.token.balance(&t.dave),
        dave_bal_before_close,
        "closer who did not join cannot withdraw funds"
    );
    assert_eq!(
        t.token.balance(&t.alice),
        alice_bal_after_join + COLLATERAL,
        "alice receives strictly her deposited collateral"
    );
    assert_eq!(t.token.balance(&t.circle_id), 0);
}
