//! Event namespace consistency tests (issue #566).
//!
//! # Invariants under test
//!
//! 1. Every event the circle publishes has exactly two topics, topic 0 is
//!    [`EVENT_NAMESPACE`], and the first data field is the emitting circle's
//!    address.  This is what lets the indexer filter on one topic and decode
//!    `member` from data index 1 for every circle event.
//! 2. The `default` event has the same shape whether it comes from
//!    `mark_default` or from `settle_round`.
//! 3. The reputation contract's `score_updated` event is published under
//!    `reputation::EVENT_NAMESPACE` with data `(member, new_score)`.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, Fixture, COLLATERAL};
use crate::{CircleStatus, BPS_DENOM, EVENT_NAMESPACE, PENALTY_BPS};
use soroban_sdk::{testutils::Events as _, Address, FromVal, Symbol, TryFromVal, Val, Vec};

type Events = std::vec::Vec<(Vec<Val>, Val)>;

/// Assert invariant 1 for every event in `events` and return their names in
/// emission order.
fn check_circle_events(t: &Fixture, events: &Events) -> std::vec::Vec<std::string::String> {
    let ns = Symbol::new(&t.env, EVENT_NAMESPACE);
    let mut names = std::vec::Vec::new();
    for (topics, data) in events {
        assert_eq!(topics.len(), 2, "circle events use a two-symbol topic");
        let topic0 = Symbol::from_val(&t.env, &topics.get(0).unwrap());
        assert_eq!(topic0, ns, "topic 0 must be EVENT_NAMESPACE");

        let name = Symbol::from_val(&t.env, &topics.get(1).unwrap());
        let fields = Vec::<Val>::try_from_val(&t.env, data)
            .unwrap_or_else(|_| panic!("event {:?} data must be a tuple", name));
        let first = Address::try_from_val(&t.env, &fields.get(0).unwrap())
            .unwrap_or_else(|_| panic!("event {:?} data[0] must be an address", name));
        assert_eq!(first, t.circle_id, "event {:?} data[0] must be the circle address", name);

        names.push(std::format!("{:?}", name));
    }
    names
}

fn default_events(t: &Fixture, events: &Events) -> std::vec::Vec<(Address, Address, i128, u32, i128)> {
    let name = Symbol::new(&t.env, "default");
    events
        .iter()
        .filter(|(topics, _)| Symbol::from_val(&t.env, &topics.get(1).unwrap()) == name)
        .map(|(_, data)| FromVal::from_val(&t.env, data))
        .collect()
}

/// Run `action`, check invariant 1 on what it emitted, and require each name
/// in `expected` to appear among those events.
fn assert_emits(t: &Fixture, action: impl FnOnce(), expected: &[&str]) {
    let events = t.circle_events_of(action);
    assert!(!events.is_empty(), "expected circle events for {expected:?}");
    let names = check_circle_events(t, &events);
    for e in expected {
        assert!(
            names.iter().any(|n| n.contains(e)),
            "expected a {e} event, got {names:?}"
        );
    }
}

#[test]
fn namespace_constant_is_circle() {
    assert_eq!(EVENT_NAMESPACE, "circle");
}

#[test]
fn every_event_in_completed_lifecycle_is_namespaced() {
    // `initialized` is published inside fixture(); everything the circle has
    // emitted so far is that one event.
    let t = fixture();
    let init: Events = t
        .env
        .events()
        .all()
        .iter()
        .filter(|(c, _, _)| *c == t.circle_id)
        .map(|(_, topics, data)| (topics, data))
        .collect();
    let names = check_circle_events(&t, &init);
    assert!(names.iter().any(|n| n.contains("initialized")), "got {names:?}");

    assert_emits(&t, || t.circle.join(&t.alice), &["joined"]);
    t.circle.join(&t.bob);
    t.circle.join(&t.carol);
    assert_emits(&t, || t.circle.join(&t.dave), &["joined", "active"]);

    for round in 0..4u32 {
        assert_emits(&t, || t.circle.contribute(&t.alice), &["contributed"]);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        t.circle.contribute(&t.dave);
        let expected: &[&str] = if round < 3 {
            &["payout", "round_started"]
        } else {
            &["payout", "completed"]
        };
        assert_emits(&t, || t.circle.payout(), expected);
    }
    assert_eq!(t.circle.get_status(), CircleStatus::Completed);

    assert_emits(&t, || t.circle.pause(&t.admin), &["paused"]);
    assert_emits(&t, || t.circle.resume(&t.admin), &["resumed"]);
    assert_emits(&t, || t.circle.close(&t.alice), &["collateral_released", "closed"]);
}

#[test]
fn every_event_in_cancelled_lifecycle_is_namespaced() {
    let t = fixture();
    t.circle.join(&t.alice);
    assert_emits(&t, || t.circle.cancel(&t.alice), &["cancelled"]);
    assert_emits(&t, || t.circle.close(&t.alice), &["collateral_released", "closed"]);
}

#[test]
fn every_event_in_exceptional_settlement_is_namespaced() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&t.alice);
    t.circle.contribute(&t.bob);
    t.advance_past_deadline();

    assert_emits(&t, || t.circle.mark_default(&t.carol), &["default"]);
    assert_emits(
        &t,
        || t.circle.settle_round(),
        &["default", "exceptional_settlement", "payout", "round_started"],
    );
}

/// Regression: settle_round used to emit `default` without the leading
/// circle_address, so the indexer (which reads member from index 1) recorded
/// the penalty amount as the member address.
#[test]
fn default_event_shape_matches_between_mark_default_and_settle_round() {
    let t = fixture();
    t.join_all();
    t.circle.contribute(&t.alice);
    t.circle.contribute(&t.bob);
    t.advance_past_deadline();

    let from_mark = default_events(&t, &t.circle_events_of(|| t.circle.mark_default(&t.carol)));
    assert_eq!(from_mark.len(), 1);

    let from_settle = default_events(&t, &t.circle_events_of(|| t.circle.settle_round()));
    assert_eq!(from_settle.len(), 1, "only dave is newly penalised by settle_round");

    let penalty = COLLATERAL * PENALTY_BPS / BPS_DENOM;
    assert_eq!(
        from_mark[0],
        (t.circle_id.clone(), t.carol.clone(), penalty, 0u32, COLLATERAL - penalty)
    );
    assert_eq!(
        from_settle[0],
        (t.circle_id.clone(), t.dave.clone(), penalty, 0u32, COLLATERAL - penalty)
    );
}

#[test]
fn reputation_score_updated_uses_reputation_namespace() {
    let t = fixture();
    t.join_all();
    t.contribute_all();

    let rep_events = t.contract_events_of(&t.rep_id.clone(), || t.circle.payout());
    assert_eq!(rep_events.len(), 1, "payout awards exactly one reputation point");

    let (topics, data) = rep_events[0].clone();
    assert_eq!(topics.len(), 2);
    assert_eq!(
        Symbol::from_val(&t.env, &topics.get(0).unwrap()),
        Symbol::new(&t.env, reputation::EVENT_NAMESPACE)
    );
    assert_eq!(
        Symbol::from_val(&t.env, &topics.get(1).unwrap()),
        Symbol::new(&t.env, "score_updated")
    );
    let (member, score): (Address, u32) = FromVal::from_val(&t.env, &data);
    assert_eq!(member, t.alice);
    assert_eq!(score, 1);
    assert_eq!(t.rep.score(&t.alice), 1);
}
