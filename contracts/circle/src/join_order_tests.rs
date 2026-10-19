//! Join-order and address-mismatch tests (issue #572).
//!
//! # Invariants under test
//!
//! 1. **Join order never changes the rotation.**  The payout recipient of
//!    round `i` is always `members[i]` from `initialize`, no matter in which
//!    order members call `join`.
//! 2. **`joined.join_order` reflects join sequence, not member index.**
//! 3. **No round operation runs before activation.**  While any member has
//!    not joined, `contribute`, `payout`, `mark_default` and `settle_round`
//!    are rejected and move no funds.
//! 4. **Join is only open while Pending and unpaused.**  Joining after
//!    activation, after cancellation, before initialization or while paused
//!    is rejected.
//! 5. **The acting address must be the signing address and a configured
//!    member.**  Signing as one member while naming another, or naming an
//!    address outside `members`, is rejected with no state change.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, Fixture, COLLATERAL, ROUND_AMOUNT};
use crate::{CircleContract, CircleContractClient, CircleStatus};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, FromVal, IntoVal,
};

/// Have `member` join and decode the single `joined` event it emits.
fn join_and_decode(t: &Fixture, member: &Address) -> (Address, Address, u32, i128) {
    let joined: std::vec::Vec<_> = t
        .circle_events_of(|| t.circle.join(member))
        .into_iter()
        .filter(|(topics, _)| {
            topics.len() == 2
                && soroban_sdk::Symbol::from_val(&t.env, &topics.get(1).unwrap())
                    == soroban_sdk::Symbol::new(&t.env, "joined")
        })
        .collect();
    assert_eq!(joined.len(), 1, "expected exactly one joined event");
    FromVal::from_val(&t.env, &joined[0].1)
}

// ── 1 & 2: join order vs rotation order ──────────────────────────────────────

#[test]
fn reverse_join_order_keeps_configured_rotation() {
    let t = fixture();
    // Join in the reverse of the configured order.
    for i in (0..4).rev() {
        t.circle.join(&t.member(i));
    }
    assert_eq!(t.circle.get_status(), CircleStatus::Active);

    // Every round pays members[i], not the i-th joiner.
    for i in 0..4u32 {
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, i);
        assert_eq!(
            round.recipient,
            t.member(i),
            "round {i} recipient must follow members[], not join order"
        );
        let before = t.token.balance(&t.member(i));
        t.contribute_all();
        t.circle.payout();
        // Pot is 4 × round_amount; the recipient paid 1 × of it this round.
        assert_eq!(
            t.token.balance(&t.member(i)) - before,
            ROUND_AMOUNT * 3,
            "round {i} pot must reach members[{i}]"
        );
    }
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);
}

#[test]
fn interleaved_join_order_keeps_configured_rotation() {
    let t = fixture();
    for m in [&t.carol, &t.alice, &t.dave, &t.bob] {
        t.circle.join(m);
    }
    assert_eq!(t.circle.get_current_round().recipient, t.alice);
    t.contribute_all();
    t.circle.payout();
    assert_eq!(t.circle.get_current_round().recipient, t.bob);
}

#[test]
fn joined_event_order_is_join_sequence_not_member_index() {
    let t = fixture();
    let expected = [(&t.dave, 1u32), (&t.bob, 2), (&t.alice, 3), (&t.carol, 4)];
    for (member, order) in expected {
        let (circle_addr, who, join_order, collateral) = join_and_decode(&t, member);
        assert_eq!(circle_addr, t.circle_id);
        assert_eq!(&who, member);
        assert_eq!(join_order, order, "join_order must count joins, not index");
        assert_eq!(collateral, COLLATERAL);
    }
}

#[test]
fn circle_activates_only_on_last_join_regardless_of_order() {
    let t = fixture();
    for m in [&t.dave, &t.carol, &t.bob] {
        t.circle.join(m);
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
    }
    t.circle.join(&t.alice);
    assert_eq!(t.circle.get_status(), CircleStatus::Active);
}

// ── 3: round operations before activation ────────────────────────────────────

#[test]
fn round_operations_rejected_while_partially_joined() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.join(&t.bob);
    t.circle.join(&t.carol); // dave has not joined
    let circle_balance = t.token.balance(&t.circle_id);
    let alice_balance = t.token.balance(&t.alice);

    assert!(t.circle.try_contribute(&t.alice).is_err());
    assert!(t.circle.try_payout().is_err());
    t.advance_past_deadline();
    assert!(t.circle.try_mark_default(&t.dave).is_err());
    assert!(t.circle.try_settle_round().is_err());

    assert_eq!(t.circle.get_status(), CircleStatus::Pending);
    assert_eq!(t.token.balance(&t.circle_id), circle_balance);
    assert_eq!(t.token.balance(&t.alice), alice_balance);
    assert!(!t.circle.has_contributed(&t.alice, &0));
    assert_eq!(t.circle.get_defaults(&t.dave), 0);
}

#[test]
#[should_panic(expected = "circle is not active")]
fn contribute_before_all_joined_panics() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.contribute(&t.alice);
}

#[test]
#[should_panic(expected = "circle is not active")]
fn contribute_before_any_join_panics() {
    let t = fixture();
    t.circle.contribute(&t.alice);
}

// ── 4: join window ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "circle: join called before initialize")]
fn join_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleContract);
    CircleContractClient::new(&env, &id).join(&Address::generate(&env));
}

#[test]
#[should_panic(expected = "circle not accepting members")]
fn rejoin_after_activation_panics() {
    let t = fixture();
    t.join_all();
    t.circle.join(&t.alice);
}

#[test]
fn join_after_cancel_rejected_without_taking_funds() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);
    let bob_balance = t.token.balance(&t.bob);

    assert!(t.circle.try_join(&t.bob).is_err());
    assert_eq!(t.token.balance(&t.bob), bob_balance);
    assert_eq!(t.circle.get_collateral(&t.bob), 0);
    assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "circle not accepting members")]
fn join_after_cancel_panics() {
    let t = fixture();
    t.circle.cancel(&t.alice);
    t.circle.join(&t.bob);
}

#[test]
fn join_while_paused_rejected_then_accepted_after_resume() {
    let t = fixture();
    t.circle.pause(&t.admin);
    assert!(t.circle.try_join(&t.alice).is_err());
    assert_eq!(t.circle.get_collateral(&t.alice), 0);

    t.circle.resume(&t.admin);
    let (_, _, join_order, _) = join_and_decode(&t, &t.alice);
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
    assert_eq!(join_order, 1, "rejected paused join must not consume a slot");
}

// ── 5: address mismatches ────────────────────────────────────────────────────

#[test]
fn join_by_non_member_rejected_without_state_change() {
    let t = fixture();
    let stranger = Address::generate(&t.env);
    t.asset.mint(&stranger, &COLLATERAL);

    assert!(t.circle.try_join(&stranger).is_err());
    assert_eq!(t.token.balance(&stranger), COLLATERAL);
    assert_eq!(t.token.balance(&t.circle_id), 0);
    assert_eq!(t.circle.get_collateral(&stranger), 0);
    assert_eq!(t.circle.get_status(), CircleStatus::Pending);
}

#[test]
#[should_panic(expected = "not a circle member")]
fn join_by_non_member_panics() {
    let t = fixture();
    t.circle.join(&Address::generate(&t.env));
}

#[test]
#[should_panic(expected = "not a circle member")]
fn cancel_by_non_member_panics() {
    let t = fixture();
    t.circle.cancel(&Address::generate(&t.env));
}

#[test]
#[should_panic(expected = "not a member")]
fn contribute_by_non_member_panics() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&Address::generate(&t.env));
}

/// Alice signs, but the call names Bob: Bob's `require_auth` has no matching
/// signature, so the join is rejected and neither wallet is debited.
#[test]
fn join_signed_by_different_member_rejected() {
    let t = fixture();
    let alice_before = t.token.balance(&t.alice);
    let bob_before = t.token.balance(&t.bob);

    t.env.mock_auths(&[MockAuth {
        address: &t.alice,
        invoke: &MockAuthInvoke {
            contract: &t.circle_id,
            fn_name: "join",
            args: (t.bob.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.circle.try_join(&t.bob).is_err());

    t.env.mock_all_auths();
    assert_eq!(t.circle.get_collateral(&t.bob), 0);
    assert_eq!(t.token.balance(&t.alice), alice_before);
    assert_eq!(t.token.balance(&t.bob), bob_before);
    assert_eq!(t.token.balance(&t.circle_id), 0);
}

/// Control for the mismatch test: the same explicit-auth setup succeeds when
/// the signer and the named member are the same address.
#[test]
fn join_signed_by_same_member_succeeds() {
    let t = fixture();
    t.env.mock_auths(&[MockAuth {
        address: &t.alice,
        invoke: &MockAuthInvoke {
            contract: &t.circle_id,
            fn_name: "join",
            args: (t.alice.clone(),).into_val(&t.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &t.token.address,
                fn_name: "transfer",
                args: (t.alice.clone(), t.circle_id.clone(), COLLATERAL).into_val(&t.env),
                sub_invokes: &[],
            }],
        },
    }]);
    t.circle.join(&t.alice);
    t.env.mock_all_auths();
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
}

#[test]
fn contribute_signed_by_different_member_rejected() {
    let t = fixture();
    t.join_all();
    let bob_before = t.token.balance(&t.bob);

    t.env.mock_auths(&[MockAuth {
        address: &t.alice,
        invoke: &MockAuthInvoke {
            contract: &t.circle_id,
            fn_name: "contribute",
            args: (t.bob.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.circle.try_contribute(&t.bob).is_err());

    t.env.mock_all_auths();
    assert!(!t.circle.has_contributed(&t.bob, &0));
    assert_eq!(t.token.balance(&t.bob), bob_before);
    assert_eq!(t.circle.get_current_round().contributions_received, 0);
}

#[test]
fn close_by_non_member_rejected_and_collateral_kept() {
    let t = fixture();
    t.circle.join(&t.alice);
    t.circle.cancel(&t.alice);

    assert!(t.circle.try_close(&Address::generate(&t.env)).is_err());
    assert!(!t.circle.is_closed());
    assert_eq!(t.circle.get_collateral(&t.alice), COLLATERAL);
}
