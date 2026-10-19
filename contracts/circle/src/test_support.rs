//! Shared fixture for the issue-scoped test modules:
//! `join_order_tests` (#572), `event_namespace_tests` (#566),
//! `error_path_tests` (#567) and `transfer_failure_tests` (#573).
//!
//! Mirrors the `setup_circle` fixture in `tests.rs` (4 funded members, a real
//! Stellar Asset Contract as USDC, a real reputation contract with this circle
//! registered as an authorized caller) but also exposes the asset-admin client
//! so tests can burn, re-mint and de-authorize balances to drive token-transfer
//! failures.
//!
//! # Type-safe builder API
//!
//! The top-level helpers follow a **builder-style** pattern so test modules
//! can compose exactly the environment they need without duplicating setup
//! code:
//!
//! | Builder | Creates |
//! |---------|---------|
//! | [`fixture()`] | Full 4-member circle, reputation registered |
//! | [`fixture_with(bool)`] | Same, with optional reputation registration |
//! | [`FixtureBuilder::default()`] | Start a custom fixture |
//! | [`FixtureBuilder::members(n)`] | Override member count (2–256) |
//! | [`FixtureBuilder::round_amount(x)`] | Override contribution amount |
//! | [`FixtureBuilder::round_deadline(x)`] | Override deadline ledgers |
//! | [`FixtureBuilder::register_reputation(bool)`] | Control reputation registration |
//! | [`FixtureBuilder::build()`] | Produce a `Fixture` |
//!
//! The `Fixture` struct itself exposes a rich set of type-safe helper methods
//! so test bodies remain declarative and self-documenting.

#![cfg(test)]
extern crate std;

use crate::{CircleContract, CircleContractClient, COLLATERAL_MULTIPLIER};
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events, IssuerFlags, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Val, Vec,
};

pub const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops
pub const ROUND_DEADLINE: u32 = 1_000; // ledgers
pub const COLLATERAL: i128 = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

// ─── FixtureBuilder ───────────────────────────────────────────────────────────

/// Builder for `Fixture`.  Provides a composable, type-safe API for test
/// setup so each test module can specify only the axes it cares about, without
/// duplicating boilerplate.
///
/// # Example
///
/// ```rust,ignore
/// // Two-member circle with a custom round amount, no reputation
/// let t = FixtureBuilder::default()
///     .members(2)
///     .round_amount(50_000_000)
///     .register_reputation(false)
///     .build();
/// ```
pub struct FixtureBuilder {
    member_count: u32,
    round_amount: i128,
    round_deadline: u32,
    register_reputation: bool,
}

impl Default for FixtureBuilder {
    fn default() -> Self {
        Self {
            member_count: 4,
            round_amount: ROUND_AMOUNT,
            round_deadline: ROUND_DEADLINE,
            register_reputation: true,
        }
    }
}

impl FixtureBuilder {
    /// Set the number of members (must be in `[2, MAX_MEMBERS]`).
    pub fn members(mut self, n: u32) -> Self {
        assert!(n >= 2, "FixtureBuilder: at least 2 members are required");
        self.member_count = n;
        self
    }

    /// Set the USDC contribution per member per round (in stroops).
    pub fn round_amount(mut self, amount: i128) -> Self {
        assert!(amount > 0, "FixtureBuilder: round_amount must be positive");
        self.round_amount = amount;
        self
    }

    /// Set the deadline window (in ledgers) for each round.
    pub fn round_deadline(mut self, ledgers: u32) -> Self {
        self.round_deadline = ledgers;
        self
    }

    /// Control whether the circle is registered as an authorized reputation
    /// caller.  Pass `false` to drive the unauthorized-reputation error paths.
    pub fn register_reputation(mut self, yes: bool) -> Self {
        self.register_reputation = yes;
        self
    }

    /// Build a `Fixture` from the current configuration.
    ///
    /// # Panics
    ///
    /// Panics if `member_count < 2` (checked in [`members`]).
    pub fn build(self) -> Fixture<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin);
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        let token = TokenClient::new(&env, &sac.address());
        let asset = StellarAssetClient::new(&env, &sac.address());

        let collateral = self.round_amount * COLLATERAL_MULTIPLIER;
        let per_member_funds = collateral + self.round_amount * self.member_count as i128;

        let mut members = Vec::new(&env);
        for _ in 0..self.member_count {
            let m = Address::generate(&env);
            asset.mint(&m, &per_member_funds);
            members.push_back(m);
        }

        // Convenience named aliases for the first four slots (tests that use
        // fewer than 4 members will have some of these alias the same address
        // or remain as dummy values — callers should use `member(i)` instead).
        let alice = members.get(0).unwrap_or_else(|| Address::generate(&env));
        let bob   = members.get(1).unwrap_or_else(|| Address::generate(&env));
        let carol = members.get(2).unwrap_or_else(|| Address::generate(&env));
        let dave  = members.get(3).unwrap_or_else(|| Address::generate(&env));

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let rep_id = env.register_contract(None, ReputationContract);
        let rep = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep.initialize(&rep_admin);
        if self.register_reputation {
            rep.add_authorized_caller(&rep_admin, &circle_id);
        }

        let admin = Address::generate(&env);
        circle.initialize(
            &admin,
            &members,
            &self.round_amount,
            &sac.address(),
            &rep_id,
            &self.round_deadline,
        );

        Fixture {
            env,
            circle,
            circle_id,
            token,
            asset,
            rep,
            rep_id,
            rep_admin,
            admin,
            members,
            alice,
            bob,
            carol,
            dave,
        }
    }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

pub struct Fixture<'a> {
    pub env: Env,
    pub circle: CircleContractClient<'a>,
    pub circle_id: Address,
    pub token: TokenClient<'a>,
    pub asset: StellarAssetClient<'a>,
    pub rep: ReputationContractClient<'a>,
    pub rep_id: Address,
    pub rep_admin: Address,
    pub admin: Address,
    /// Configured rotation order: alice (round 0), bob, carol, dave.
    pub members: Vec<Address>,
    pub alice: Address,
    pub bob: Address,
    pub carol: Address,
    pub dave: Address,
}

impl<'a> Fixture<'a> {
    // ── Member accessors ──────────────────────────────────────────────────────

    /// Return the member at rotation index `i` (0-based).
    ///
    /// Panics if `i >= member_count`.
    pub fn member(&self, i: u32) -> Address {
        self.members.get(i).unwrap()
    }

    /// Return the total number of configured members.
    pub fn member_count(&self) -> u32 {
        self.members.len()
    }

    // ── Lifecycle helpers ────────────────────────────────────────────────────

    /// Have every member call `join`.
    ///
    /// After this call the circle is Active.
    pub fn join_all(&self) {
        for m in self.members.iter() {
            self.circle.join(&m);
        }
    }

    /// Have every member call `contribute` for the current round.
    ///
    /// Panics (via the contract) if any member has already contributed or
    /// if the round deadline has passed.
    pub fn contribute_all(&self) {
        for m in self.members.iter() {
            self.circle.contribute(&m);
        }
    }

    /// `contribute_all` + `payout` for the current round.
    ///
    /// Returns the zero-based round index that was just completed.
    pub fn complete_round(&self) -> u32 {
        let idx = self.circle.get_current_round().round_index;
        self.contribute_all();
        self.circle.payout();
        idx
    }

    /// Drive the circle through all N rounds until `status == Completed`.
    pub fn complete_all_rounds(&self) {
        for _ in 0..self.member_count() {
            self.complete_round();
        }
    }

    // ── Ledger helpers ────────────────────────────────────────────────────────

    /// Advance the ledger sequence one past the current round deadline,
    /// enabling `mark_default` and `settle_round`.
    ///
    /// Works correctly for any deadline configured via [`FixtureBuilder::round_deadline`]:
    /// it reads the actual `deadline_ledger` from on-chain state rather than
    /// assuming the `ROUND_DEADLINE` constant.  Falls back to `ROUND_DEADLINE + 1`
    /// if the circle has not been activated yet (no current round).
    pub fn advance_past_deadline(&self) {
        let target = if let Ok(round) = self.circle.try_get_current_round() {
            match round {
                Ok(r) => (r.deadline_ledger + 1) as u32,
                Err(_) => self.env.ledger().sequence() + ROUND_DEADLINE + 1,
            }
        } else {
            self.env.ledger().sequence() + ROUND_DEADLINE + 1
        };
        let current = self.env.ledger().sequence();
        if target > current {
            let bump = target - current;
            self.env.ledger().with_mut(|l| l.sequence_number += bump);
        }
    }

    // ── Token manipulation helpers ────────────────────────────────────────────

    /// Move `amount` out of the circle's token balance so the next outgoing
    /// transfer fails with insufficient balance.  Returns the sink holding it.
    pub fn drain_circle(&self, amount: i128) -> Address {
        let sink = Address::generate(&self.env);
        self.token.transfer(&self.circle_id, &sink, &amount);
        sink
    }

    /// Return drained funds to the circle so a retried operation can succeed.
    pub fn refund_circle(&self, sink: &Address, amount: i128) {
        self.token.transfer(sink, &self.circle_id, &amount);
    }

    /// Burn a wallet's entire token balance.  Returns the amount burned.
    pub fn empty_wallet(&self, who: &Address) -> i128 {
        let bal = self.token.balance(who);
        if bal > 0 {
            self.token.burn(who, &bal);
        }
        bal
    }

    // ── Storage-manipulation helpers (test-only state injection) ─────────────

    /// Overwrite the circle's `Status` in instance storage.
    ///
    /// Use this to teleport a circle into a terminal state without running
    /// the full lifecycle, e.g. to test `close` in isolation.
    pub fn force_status(&self, status: crate::CircleStatus) {
        let n = self.members.len();
        self.env.as_contract(&self.circle_id, || {
            self.env.storage().instance().set(&crate::DataKey::Status, &status);
            if matches!(status, crate::CircleStatus::Completed) {
                self.env.storage().instance().set(&crate::DataKey::RoundsCompleted, &n);
            }
        });
    }

    /// Overwrite one member's stored collateral balance.
    ///
    /// Lets tests exercise penalty / release arithmetic starting from a
    /// precise collateral value rather than deriving it from defaults.
    pub fn force_collateral(&self, member: &Address, amount: i128) {
        self.env.as_contract(&self.circle_id, || {
            self.env.storage().persistent()
                .set(&crate::DataKey::Collateral(member.clone()), &amount);
        });
    }

    /// Forcibly write a `Contributed(member, round_index)` key.
    ///
    /// Use this to produce the "tally-mismatch" guard scenario: inject keys
    /// without going through `contribute`, so the counter stays at 0 but
    /// the keys exist.
    pub fn force_contributed(&self, member: &Address, round_index: u32) {
        self.env.as_contract(&self.circle_id, || {
            self.env.storage().persistent()
                .set(&crate::DataKey::Contributed(member.clone(), round_index), &true);
        });
    }

    // ── Event capture helpers ────────────────────────────────────────────────

    /// Run `action` and return the events the circle contract published
    /// during it as `(topics, data)`.  `events().all()` accumulates across
    /// invocations, so only the entries appended by `action` are returned.
    pub fn circle_events_of(&self, action: impl FnOnce()) -> std::vec::Vec<(Vec<Val>, Val)> {
        self.contract_events_of(&self.circle_id.clone(), action)
    }

    /// Like [`Self::circle_events_of`] but for any emitting contract.
    pub fn contract_events_of(
        &self,
        contract: &Address,
        action: impl FnOnce(),
    ) -> std::vec::Vec<(Vec<Val>, Val)> {
        let before = self.env.events().all().len();
        action();
        self.env
            .events()
            .all()
            .iter()
            .skip(before as usize)
            .filter(|(c, _, _)| c == contract)
            .map(|(_, topics, data)| (topics, data))
            .collect()
    }
}

// ─── Top-level convenience constructors ──────────────────────────────────────

/// Build a full 4-member fixture, with or without reputation registration.
///
/// `register_on_reputation = false` leaves the circle off the reputation
/// allowlist so payout's reputation call fails.  Pass `true` for normal
/// end-to-end tests.
pub fn fixture_with(register_on_reputation: bool) -> Fixture<'static> {
    FixtureBuilder::default()
        .register_reputation(register_on_reputation)
        .build()
}

/// Build the canonical 4-member fixture with reputation fully wired.
///
/// This is the entry point for the majority of tests.  Use [`fixture_with`]
/// or [`FixtureBuilder`] when you need to deviate from the defaults.
pub fn fixture() -> Fixture<'static> {
    fixture_with(true)
}
