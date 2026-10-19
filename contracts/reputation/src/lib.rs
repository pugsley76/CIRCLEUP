//! Reputation contract — tracks completed-rounds score per wallet address.
//!
//! # Authorization model
//!
//! `increment` may only be called by an **authorized circle contract** — not
//! by the member whose score is being updated.  This prevents any wallet from
//! self-awarding reputation points outside of a legitimate ROSCA payout.
//!
//! The factory registers each newly deployed circle by calling
//! `add_authorized_caller` (admin-only).  The factory itself is set as `admin`
//! during `initialize`.
//!
//! ```text
//!   factory.create_circle()
//!     └─► reputation.add_authorized_caller(circle_address)   [admin = factory]
//!         └─► circle.payout()
//!               └─► reputation.increment(member)             [caller = circle]
//! ```
//!
//! # Authorization invariants
//!
//! The allowlist is the trust boundary for every point ever awarded, so the
//! following hold in **every** state this contract can reach:
//!
//! 1. **Admin-only management** — only the address stored under
//!    [`DataKey::Admin`] can register or revoke a caller.
//! 2. **Uniqueness** — [`DataKey::AuthorizedCallers`] holds each address at
//!    most once.  `add_authorized_caller` is idempotent and
//!    `remove_authorized_caller` filters out *every* matching entry, so no
//!    sequence of admin calls can leave a duplicate behind.
//! 3. **Revocation is permanent** — a revoked address is recorded in
//!    [`DataKey::RevokedCallers`] and can never be authorized again on this
//!    contract instance; re-registration fails with
//!    [`ReputationError::CallerRevoked`].
//! 4. **Revocation outranks the allowlist** — `increment` rejects a revoked
//!    address *before* it consults the allowlist, so a stale entry left by a
//!    partially applied factory reconfiguration cannot resurrect a revoked
//!    circle's ability to award points.
//! 5. **Scores are monotonic** — `increment` is the only writer of
//!    [`DataKey::Score`] and only ever adds 1.  There is no decrement or reset
//!    entry point, so revoking a circle freezes the points it awarded instead
//!    of rewriting history.
//!
//! Both caller lists live in instance storage, so their TTL is bound to the
//! contract instance itself and a revocation cannot lapse the way an expiring
//! persistent entry could.
//!
//! # Events
//!
//! All events use the two-symbol topic prefix `("reputation", <event_name>)` so
//! the indexer can filter with `topic0 == "reputation"`.
//!
//! Every authorization transition emits exactly one event, and a call that
//! changes nothing (re-registering an already-authorized circle) emits none, so
//! an off-chain replay of these events reproduces the on-chain allowlist
//! exactly.  Storage stays the source of truth regardless: the current state is
//! also readable directly via `get_authorized_callers` and
//! `get_revoked_callers`.
//!
//! ## `reputation` / `score_updated`
//!
//! Emitted after every successful `increment` call.
//!
//! | Part | Shape | Meaning |
//! |------|-------|---------|
//! | **Topics** | `(Symbol("reputation"), Symbol("score_updated"))` | Stable filter keys |
//! | **Data** | `(Address, u32)` | `(member, new_total_score)` |
//!
//! ## `reputation` / `caller_added`
//!
//! Emitted when admin registers a caller that was not already authorized.
//!
//! | **Data** | `Address` | The newly authorized circle contract address |
//!
//! ## `reputation` / `caller_removed`
//!
//! Emitted when admin revokes an authorized caller.  Revocation is permanent,
//! so at most one of these is emitted per address.
//!
//! | **Data** | `Address` | The revoked circle contract address |

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol, Vec};

// ─── Events ───────────────────────────────────────────────────────────────────

/// Topic-0 namespace shared by every event this contract publishes.
///
/// Mirrors `circle::EVENT_NAMESPACE`: topics are `(EVENT_NAMESPACE, <name>)`.
pub const EVENT_NAMESPACE: &str = "reputation";

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Completed-rounds score for a wallet.
    Score(Address),
    /// Admin address — the only address allowed to manage authorized callers.
    /// Set once at `initialize` time; typically the factory contract.
    Admin,
    /// Vec<Address> of circle contracts permitted to call `increment`.
    AuthorizedCallers,
    /// Vec<Address> of circle contracts permanently barred from calling
    /// `increment`.  Append-only: entries are written by
    /// `remove_authorized_caller` and never cleared.
    RevokedCallers,
    /// Reentrancy guard held for the duration of `initialize`.
    ///
    /// Set as the very first storage write in `initialize` and cleared once
    /// all setup fully commits.  If a reentrant call lands mid-initialize
    /// (e.g. a future cross-contract call is added here) the flag is already
    /// present and the call panics immediately, before any partial state is
    /// visible to the reentrant path.  The `Admin` key absence alone is not a
    /// safe guard because a reentrant call would also see `Admin` absent.
    Initializing,
}

// ─── Contract errors ──────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ReputationError {
    /// `increment` was called by an address that is revoked, or that is not in
    /// `AuthorizedCallers`.
    UnauthorizedCaller = 1,
    /// `add_authorized_caller` or `remove_authorized_caller` was called by a
    /// non-admin address.
    NotAdmin = 2,
    /// `remove_authorized_caller` was asked to remove an address that is not
    /// currently in the authorized list.
    CallerNotFound = 3,
    /// A mutating entry-point was called before `initialize`.
    NotInitialized = 4,
    /// `add_authorized_caller` was asked to re-register an address that has
    /// already been revoked.  Revocation cannot be undone.
    CallerRevoked = 5,
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Current allowlist, or an empty list if none has been stored yet.
fn authorized_callers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::AuthorizedCallers)
        .unwrap_or_else(|| Vec::new(env))
}

/// Addresses that have been permanently revoked.
fn revoked_callers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::RevokedCallers)
        .unwrap_or_else(|| Vec::new(env))
}

/// Assert that `caller` signed this invocation **and** is the stored admin.
///
/// Both allowlist mutations go through here so the two paths cannot drift apart
/// on who is allowed to move the trust boundary.
fn require_admin(env: &Env, caller: &Address) -> Result<(), ReputationError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ReputationError::NotInitialized)?;

    caller.require_auth();
    if *caller != admin {
        return Err(ReputationError::NotAdmin);
    }

    Ok(())
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Called once by the deployer.
    ///
    /// `admin` is the only address permitted to register or revoke authorized
    /// callers via `add_authorized_caller` / `remove_authorized_caller`.  In
    /// the standard CircleUp deployment the factory contract is passed as admin
    /// so it can register each circle it deploys.
    ///
    /// # Reentrancy guard
    ///
    /// Sets `DataKey::Initializing` as the very first storage write and clears
    /// it once all setup commits.  This prevents a reentrant call from racing
    /// through a second initialize mid-flight and observing a partially
    /// initialized state.  The `Admin` key absence alone is not a sufficient
    /// guard because a reentrant call would also see `Admin` absent.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        // Reentrancy guard: set the Initializing flag before any other write.
        // A reentrant call arriving mid-initialize (e.g. if a future change
        // introduces a cross-contract call here) sees this flag and panics
        // immediately, preventing partial state from being observed or committed.
        if env.storage().instance().has(&DataKey::Initializing) {
            panic!("initialize already in progress");
        }
        env.storage().instance().set(&DataKey::Initializing, &true);

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);

        let empty: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &empty);
        env.storage()
            .instance()
            .set(&DataKey::RevokedCallers, &empty);

        // Clear the reentrancy guard once all setup commits successfully.
        env.storage().instance().remove(&DataKey::Initializing);
    }

    // ── Authorized-caller management ──────────────────────────────────────────

    /// Register `circle` as a contract that may call `increment`.
    ///
    /// Only the admin (typically the factory) may call this.  The call is
    /// idempotent: re-registering an already-authorized circle succeeds without
    /// appending a duplicate entry and without emitting a second event.
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::NotAdmin`] — caller is not the admin.
    /// - [`ReputationError::CallerRevoked`] — `circle` was previously revoked.
    pub fn add_authorized_caller(
        env: Env,
        caller: Address,
        circle: Address,
    ) -> Result<(), ReputationError> {
        require_admin(&env, &caller)?;

        // Revocation is permanent.  Refusing re-registration here is what stops
        // a factory-level reconfiguration or a re-deploy sequence from quietly
        // restoring a circle that was taken out of the trust boundary on
        // purpose.
        if revoked_callers(&env).contains(&circle) {
            return Err(ReputationError::CallerRevoked);
        }

        let mut callers = authorized_callers(&env);
        if callers.contains(&circle) {
            return Ok(());
        }

        callers.push_back(circle.clone());
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &callers);

        env.events().publish(
            (
                Symbol::new(&env, EVENT_NAMESPACE),
                Symbol::new(&env, "caller_added"),
            ),
            circle,
        );

        Ok(())
    }

    /// Permanently revoke `circle`'s permission to call `increment`.
    ///
    /// Only the admin may call this.  `circle` is dropped from the allowlist
    /// and recorded as revoked; it can never be registered again.
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::NotAdmin`] — caller is not the admin.
    /// - [`ReputationError::CallerNotFound`] — `circle` was not in the list.
    pub fn remove_authorized_caller(
        env: Env,
        caller: Address,
        circle: Address,
    ) -> Result<(), ReputationError> {
        require_admin(&env, &caller)?;

        // Rebuild the allowlist without `circle`.  Filtering instead of
        // removing a single index means that if the list ever holds the address
        // more than once, one call clears all of them — a partial removal would
        // leave the circle authorized.
        let callers = authorized_callers(&env);
        let mut remaining: Vec<Address> = Vec::new(&env);
        for addr in callers.iter() {
            if addr != circle {
                remaining.push_back(addr);
            }
        }

        if remaining.len() == callers.len() {
            return Err(ReputationError::CallerNotFound);
        }

        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &remaining);

        // Tombstone the address.  `increment` consults this list first, so the
        // circle stays locked out even if a stale allowlist entry survives.
        let mut revoked = revoked_callers(&env);
        revoked.push_back(circle.clone());
        env.storage()
            .instance()
            .set(&DataKey::RevokedCallers, &revoked);

        env.events().publish(
            (
                Symbol::new(&env, EVENT_NAMESPACE),
                Symbol::new(&env, "caller_removed"),
            ),
            circle,
        );

        Ok(())
    }

    // ── Mutation ──────────────────────────────────────────────────────────────

    /// Increment `member`'s completed-rounds score by 1.
    ///
    /// `circle` must be an address registered via `add_authorized_caller` and
    /// never revoked.  The Soroban host **automatically authorizes**
    /// `circle.require_auth()` when the call originates from the circle
    /// contract itself (Contract Invoker rule), so no external signature is
    /// required in cross-contract calls.  A wallet calling this directly would
    /// have to produce a signature for the circle's address, which it cannot do
    /// — effectively blocking direct calls.
    ///
    /// # Authorization flow
    ///
    /// ```text
    /// circle.payout()
    ///   └─► reputation.increment(circle_address, member)
    ///             ├─► circle.require_auth()  — auto-granted by Soroban host
    ///             ├─► rejects if circle is in RevokedCallers
    ///             └─► requires circle to be in AuthorizedCallers
    /// ```
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::UnauthorizedCaller`] — `circle` is revoked, or is
    ///   not in the `AuthorizedCallers` list.
    pub fn increment(env: Env, circle: Address, member: Address) -> Result<(), ReputationError> {
        // Verify the contract has been initialized before doing anything else.
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(ReputationError::NotInitialized);
        }

        // Require auth from the circle address.  When called from within a
        // circle contract via a cross-contract call, Soroban's Contract Invoker
        // rule auto-grants this — no external signature needed.  A direct call
        // from a wallet would require the wallet to hold the circle's key,
        // which is impossible in practice.
        circle.require_auth();

        // Revocation is checked first, and independently of the allowlist, so
        // authorization never depends on the allowlist being clean.
        if revoked_callers(&env).contains(&circle) {
            return Err(ReputationError::UnauthorizedCaller);
        }

        if !authorized_callers(&env).contains(&circle) {
            return Err(ReputationError::UnauthorizedCaller);
        }

        // Load current score; default to 0 for first-time members.
        let current: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Score(member.clone()))
            .unwrap_or(0);

        // `overflow-checks` is on for the release profile, so an overflow traps
        // and aborts the transaction rather than wrapping the score back to 0.
        let new_score = current + 1;

        env.storage()
            .persistent()
            .set(&DataKey::Score(member.clone()), &new_score);

        // Extend TTL so scores survive well beyond the circle's lifetime.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Score(member.clone()), 100_000, 200_000);

        // Emit (member, new_total_score) so indexers and frontends can show
        // both *who* received the point and *what their total score is now*
        // without a separate `score` query.
        env.events().publish(
            (
                Symbol::new(&env, EVENT_NAMESPACE),
                Symbol::new(&env, "score_updated"),
            ),
            (member, new_score),
        );

        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Returns the number of completed rounds for `member` (0 if none on record).
    pub fn score(env: Env, member: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Score(member))
            .unwrap_or(0)
    }

    /// Returns the list of currently authorized circle contracts.
    pub fn get_authorized_callers(env: Env) -> Vec<Address> {
        authorized_callers(&env)
    }

    /// Returns the list of permanently revoked circle contracts.
    ///
    /// Exposed so auditors and indexers can read the whole authorization state
    /// straight from storage instead of replaying `caller_added` /
    /// `caller_removed` events to work out which addresses are barred.
    pub fn get_revoked_callers(env: Env) -> Vec<Address> {
        revoked_callers(&env)
    }

    /// Returns the admin address.
    ///
    /// Panics with a clear message if called before `initialize`.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("reputation: get_admin called before initialize"))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events};
    use soroban_sdk::{Env, FromVal, TryFromVal, Val};

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct Setup<'a> {
        env: Env,
        admin: Address,
        client: ReputationContractClient<'a>,
        contract_id: Address,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        Setup {
            env,
            admin,
            client,
            contract_id,
        }
    }

    /// How many times `addr` appears in `list`.
    fn occurrences(list: &Vec<Address>, addr: &Address) -> u32 {
        let mut n = 0;
        for entry in list.iter() {
            if entry == *addr {
                n += 1;
            }
        }
        n
    }

    /// Overwrite the stored allowlist directly, simulating state left behind by
    /// a corrupted migration or a partially applied reconfiguration.  No public
    /// entry point can produce such a list, which is exactly why the defensive
    /// paths have to be reached this way.
    fn force_authorized_callers(s: &Setup, entries: &[&Address]) {
        let mut list: Vec<Address> = Vec::new(&s.env);
        for entry in entries {
            list.push_back((*entry).clone());
        }
        s.env.as_contract(&s.contract_id, || {
            s.env
                .storage()
                .instance()
                .set(&DataKey::AuthorizedCallers, &list);
        });
    }

    /// Force a member's score directly in persistent storage, bypassing the
    /// `increment` entry point.  Used to exercise boundary and overflow cases
    /// that would otherwise require running `increment` u32::MAX times.
    fn force_score(s: &Setup, member: &Address, score: u32) {
        s.env.as_contract(&s.contract_id, || {
            s.env
                .storage()
                .persistent()
                .set(&DataKey::Score(member.clone()), &score);
        });
    }

    /// Data payloads of every emitted event whose second topic is `name`.
    ///
    /// Topic symbols longer than nine characters are host objects rather than
    /// small values, so they have to be converted back to `Symbol` before
    /// comparing — comparing the raw `Val` payloads matches on object handle
    /// and never finds anything.
    fn events_named(env: &Env, name: &str) -> std::vec::Vec<Val> {
        let target = Symbol::new(env, name);
        env.events()
            .all()
            .into_iter()
            .filter(|(_contract, topics, _data)| {
                topics
                    .get(1)
                    .and_then(|topic| Symbol::try_from_val(env, &topic).ok())
                    .map(|topic| topic == target)
                    .unwrap_or(false)
            })
            .map(|(_contract, _topics, data)| data)
            .collect()
    }

    /// The address carried by the single event named `name`.
    fn only_address_event(env: &Env, name: &str) -> Address {
        let events = events_named(env, name);
        assert_eq!(events.len(), 1, "expected exactly one '{}' event", name);
        Address::from_val(env, &events[0])
    }

    // ── initialize ────────────────────────────────────────────────────────────

    #[test]
    fn test_score_starts_at_zero() {
        let s = setup();
        let member = Address::generate(&s.env);
        assert_eq!(s.client.score(&member), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let s = setup();
        s.client.initialize(&s.admin);
    }

    #[test]
    fn test_get_admin_returns_initialized_admin() {
        let s = setup();
        assert_eq!(s.client.get_admin(), s.admin);
    }

    #[test]
    fn test_initialize_starts_with_empty_caller_lists() {
        let s = setup();
        assert_eq!(s.client.get_authorized_callers().len(), 0);
        assert_eq!(s.client.get_revoked_callers().len(), 0);
    }

    // ── initialize: reentrancy guard ──────────────────────────────────────────

    /// The reentrancy guard (DataKey::Initializing) is set before any other
    /// storage write in `initialize`.  Simulating a reentrant call by
    /// pre-setting the flag must cause initialize to panic with
    /// "initialize already in progress" rather than proceeding.
    #[test]
    #[should_panic(expected = "initialize already in progress")]
    fn test_initialize_reentrancy_guard_fires() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        // Pre-set the Initializing flag to simulate a reentrant call landing
        // mid-initialize (e.g. from a future cross-contract call added there).
        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        // Must panic: Initializing flag already set.
        client.initialize(&Address::generate(&env));
    }

    /// After a reentrancy-guard failure the Admin key must remain absent,
    /// confirming the guard fires before any committed state.
    #[test]
    fn test_initialize_reentrancy_guard_leaves_no_admin_state() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        let result = client.try_initialize(&Address::generate(&env));
        assert!(result.is_err(), "initialize with Initializing flag set must fail");

        // Admin key must not have been written — verify directly via storage.
        let admin_present = env.as_contract(&contract_id, || {
            env.storage().instance().has(&DataKey::Admin)
        });
        assert!(!admin_present, "Admin key must be absent after reentrancy-guard failure");
    }

    /// A reentrancy-guard failure must leave the caller lists absent (not
    /// written as empty vecs), so a retry with a correct admin succeeds cleanly.
    #[test]
    fn test_initialize_reentrancy_guard_allows_retry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        // First attempt: fail via reentrancy guard simulation.
        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });
        let bad = client.try_initialize(&Address::generate(&env));
        assert!(bad.is_err(), "first initialize must fail");

        // Clear the simulated flag so a retry can proceed.
        env.as_contract(&contract_id, || {
            env.storage().instance().remove(&DataKey::Initializing);
        });

        // Second attempt with a correct admin must succeed.
        let good_admin = Address::generate(&env);
        client.initialize(&good_admin);
        assert_eq!(client.get_admin(), good_admin, "retry must store the correct admin");
        assert_eq!(client.get_authorized_callers().len(), 0);
        assert_eq!(client.get_revoked_callers().len(), 0);
    }

    // ── initialize: admin immutability ────────────────────────────────────────

    /// The admin stored at initialize time must be exactly the address passed in.
    /// Re-initializing with a different admin must be rejected and leave the
    /// original admin unchanged.
    #[test]
    fn test_admin_immutable_after_initialize() {
        let s = setup();
        let original_admin = s.client.get_admin();

        // Attempt to overwrite with a different admin — must fail.
        let attacker = Address::generate(&s.env);
        let result = s.client.try_initialize(&attacker);
        assert!(result.is_err(), "second initialize must be rejected");

        // Admin must still be the original.
        assert_eq!(
            s.client.get_admin(),
            original_admin,
            "admin must be immutable after initialize"
        );
    }

    /// get_admin before initialize must panic with a clear message.
    #[test]
    #[should_panic(expected = "reputation: get_admin called before initialize")]
    fn test_get_admin_before_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        client.get_admin(); // must panic
    }

    // ── admin-auth: add_authorized_caller ─────────────────────────────────────

    /// Only the stored admin may add an authorized caller.  Any other address
    /// must receive NotAdmin regardless of whether mock_all_auths is active
    /// (the guard checks the stored admin address, not just the signature).
    #[test]
    fn test_add_authorized_caller_requires_stored_admin_identity() {
        let s = setup();
        let circle = Address::generate(&s.env);

        // A brand-new address that has not been set as admin must be rejected.
        let non_admin = Address::generate(&s.env);
        let result = s.client.try_add_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "add_authorized_caller must reject any address that is not the stored admin"
        );

        // The list must remain empty after the rejected call.
        assert_eq!(
            s.client.get_authorized_callers().len(), 0,
            "authorized callers must be empty after rejected add"
        );
    }

    /// A series of different non-admin addresses must all be rejected.
    /// This confirms the check is against the stored admin identity,
    /// not merely the absence of a signature.
    #[test]
    fn test_add_authorized_caller_rejects_multiple_non_admins() {
        let s = setup();
        let circle = Address::generate(&s.env);

        for _ in 0..5 {
            let stranger = Address::generate(&s.env);
            let result = s.client.try_add_authorized_caller(&stranger, &circle);
            assert_eq!(
                result,
                Err(Ok(ReputationError::NotAdmin)),
                "every non-admin address must be rejected by add_authorized_caller"
            );
        }

        assert_eq!(s.client.get_authorized_callers().len(), 0);
    }

    /// add_authorized_caller called before initialize must return NotInitialized
    /// (the require_admin helper checks for Admin key absence first).
    #[test]
    fn test_add_authorized_caller_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let result = client.try_add_authorized_caller(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "add_authorized_caller before initialize must return NotInitialized"
        );
    }

    // ── admin-auth: remove_authorized_caller ──────────────────────────────────

    /// Only the stored admin may remove an authorized caller.
    #[test]
    fn test_remove_authorized_caller_requires_stored_admin_identity() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);

        let non_admin = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "remove_authorized_caller must reject any address that is not the stored admin"
        );

        // The circle must remain in the authorized list.
        assert!(
            s.client.get_authorized_callers().contains(&circle),
            "circle must remain authorized after rejected remove"
        );
        // And must not appear in the revoked list.
        assert!(
            !s.client.get_revoked_callers().contains(&circle),
            "circle must not be revoked after a rejected remove"
        );
    }

    /// remove_authorized_caller called before initialize must return NotInitialized.
    #[test]
    fn test_remove_authorized_caller_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let result = client.try_remove_authorized_caller(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "remove_authorized_caller before initialize must return NotInitialized"
        );
    }

    // ── admin-auth: increment ─────────────────────────────────────────────────

    /// increment called before initialize must return NotInitialized — the
    /// contract must check for Admin key presence before any other logic.
    #[test]
    fn test_increment_before_initialize_returns_not_initialized_detailed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let result = client.try_increment(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "increment before initialize must return NotInitialized"
        );
    }

    /// After revocation, the admin is still the stored admin and can still
    /// manage the allowlist for other circles — revocation of one circle
    /// must not affect admin identity or other circles' authorization.
    #[test]
    fn test_admin_auth_unaffected_by_revocation() {
        let s = setup();
        let circle_a = Address::generate(&s.env);
        let circle_b = Address::generate(&s.env);

        s.client.add_authorized_caller(&s.admin, &circle_a);
        s.client.add_authorized_caller(&s.admin, &circle_b);

        // Revoke circle_a
        s.client.remove_authorized_caller(&s.admin, &circle_a);

        // Admin identity must be unchanged.
        assert_eq!(s.client.get_admin(), s.admin, "admin must be unchanged after revocation");

        // Admin must still be able to manage circle_b.
        let new_circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &new_circle);
        assert!(
            s.client.get_authorized_callers().contains(&new_circle),
            "admin must still be able to add new callers after revoking another"
        );

        // circle_a is revoked; circle_b is still authorized.
        assert!(!s.client.get_authorized_callers().contains(&circle_a));
        assert!(s.client.get_authorized_callers().contains(&circle_b));
    }

    // ── initialize: state written atomically ──────────────────────────────────

    /// After a successful initialize the contract must expose all four expected
    /// storage entries: Admin, AuthorizedCallers (empty), RevokedCallers (empty),
    /// and score queries return 0 for any unknown address.
    #[test]
    fn test_initialize_writes_all_expected_state() {
        let s = setup();

        // Admin is the provided address.
        assert_eq!(s.client.get_admin(), s.admin);

        // Both caller lists start empty.
        let authorized = s.client.get_authorized_callers();
        let revoked = s.client.get_revoked_callers();
        assert_eq!(authorized.len(), 0, "AuthorizedCallers must be empty after initialize");
        assert_eq!(revoked.len(), 0, "RevokedCallers must be empty after initialize");

        // Any member score query returns 0.
        let unknown = Address::generate(&s.env);
        assert_eq!(s.client.score(&unknown), 0, "score for unknown member must be 0");
    }

    /// The admin address is stored exactly as passed — not hashed, normalized,
    /// or transformed.  Verifying identity with `==` must succeed.
    #[test]
    fn test_initialize_stores_admin_address_verbatim() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(
            client.get_admin(),
            admin,
            "stored admin must be byte-identical to the address passed to initialize"
        );
    }

    // ── add_authorized_caller ─────────────────────────────────────────────────

    #[test]
    fn test_add_authorized_caller_by_admin_succeeds() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert!(s.client.get_authorized_callers().contains(&circle));
    }

    /// Re-registering the same circle must leave the allowlist unique.
    #[test]
    fn test_add_authorized_caller_is_idempotent() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.add_authorized_caller(&s.admin, &circle);
        let callers = s.client.get_authorized_callers();
        assert_eq!(occurrences(&callers, &circle), 1);
        assert_eq!(callers.len(), 1);
    }

    #[test]
    fn test_add_authorized_caller_non_admin_returns_not_admin_error() {
        let s = setup();
        let non_admin = Address::generate(&s.env);
        let circle = Address::generate(&s.env);
        let result = s.client.try_add_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "non-admin must receive NotAdmin error"
        );
        assert_eq!(s.client.get_authorized_callers().len(), 0);
    }

    // ── remove_authorized_caller ──────────────────────────────────────────────

    #[test]
    fn test_remove_authorized_caller_by_admin_succeeds() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        assert!(!s.client.get_authorized_callers().contains(&circle));
        assert!(s.client.get_revoked_callers().contains(&circle));
    }

    #[test]
    fn test_remove_authorized_caller_not_found_returns_error() {
        let s = setup();
        let circle = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&s.admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::CallerNotFound)),
            "removing unknown caller must return CallerNotFound"
        );
        assert_eq!(
            s.client.get_revoked_callers().len(),
            0,
            "a failed removal must not tombstone anything"
        );
    }

    #[test]
    fn test_remove_authorized_caller_non_admin_returns_not_admin_error() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        let non_admin = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "non-admin must receive NotAdmin error on remove"
        );
        assert!(
            s.client.get_authorized_callers().contains(&circle),
            "a rejected removal must leave the allowlist untouched"
        );
    }

    /// One removal must clear every copy of the address, so a list corrupted
    /// with duplicates cannot leave the circle partially authorized.
    #[test]
    fn test_remove_clears_every_duplicate_allowlist_entry() {
        let s = setup();
        let circle = Address::generate(&s.env);
        let other = Address::generate(&s.env);
        force_authorized_callers(&s, &[&circle, &other, &circle]);

        s.client.remove_authorized_caller(&s.admin, &circle);

        let callers = s.client.get_authorized_callers();
        assert_eq!(occurrences(&callers, &circle), 0);
        assert_eq!(
            occurrences(&callers, &other),
            1,
            "removal must not disturb other entries"
        );
    }

    // ── revocation is permanent ───────────────────────────────────────────────

    #[test]
    fn test_revoked_caller_cannot_increment() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);

        s.client.remove_authorized_caller(&s.admin, &s.contract_id);

        let result = s.client.try_increment(&s.contract_id, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "a revoked circle must not be able to award points"
        );
        assert_eq!(
            s.client.score(&member),
            1,
            "revocation freezes the score, it does not rewrite it"
        );
    }

    #[test]
    fn test_revoked_caller_cannot_be_re_added() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);

        let result = s.client.try_add_authorized_caller(&s.admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::CallerRevoked)),
            "revocation must be irreversible"
        );
        assert!(!s.client.get_authorized_callers().contains(&circle));
    }

    // ── Monotonicity: overflow and boundary ───────────────────────────────────

    /// Score can grow up to u32::MAX without unexpected clamping or wrapping.
    /// This verifies the happy path right at the boundary: MAX - 1 → MAX.
    #[test]
    fn test_score_at_u32_max_minus_one_increments_to_max() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        force_score(&s, &member, u32::MAX - 1);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(
            s.client.score(&member),
            u32::MAX,
            "score must be able to reach u32::MAX without wrapping or clamping"
        );
    }

    /// Incrementing from u32::MAX must trap rather than silently wrap back to 0.
    /// The release profile sets overflow-checks = true; in the test environment
    /// Rust's debug overflow checks also fire, so this panic is deterministic.
    #[test]
    fn test_score_overflow_at_u32_max_traps() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        force_score(&s, &member, u32::MAX);
        // The increment must fail (overflow trap) rather than wrap to 0.
        let result = s.client.try_increment(&s.contract_id, &member);
        assert!(
            result.is_err(),
            "score must not silently wrap past u32::MAX — the operation must trap"
        );
        // The failed call must leave the score unchanged at u32::MAX.
        assert_eq!(
            s.client.score(&member),
            u32::MAX,
            "score must remain at u32::MAX after the failed increment"
        );
    }

    /// One authorized `increment` call creates exactly one score point.
    /// This pin-tests the "one qualifying circle completion = one defined increment"
    /// requirement from Issue 89.
    #[test]
    fn test_one_authorized_completion_adds_exactly_one_point() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        let before = s.client.score(&member);
        s.client.increment(&s.contract_id, &member);
        let after = s.client.score(&member);
        assert_eq!(
            after,
            before + 1,
            "one authorized increment must add exactly one point"
        );
    }

    /// Score for a member with no recorded history must be zero — not an error,
    /// not None, not a missing-key panic.  The contract must return 0 for any
    /// unknown address.
    #[test]
    fn test_unknown_member_score_is_deterministically_zero() {
        let s = setup();
        let unknown = Address::generate(&s.env);
        assert_eq!(
            s.client.score(&unknown),
            0,
            "score for an address with no history must be deterministically 0"
        );
    }

    /// The core stale-permission case: even if the allowlist is corrupted so
    /// that a revoked circle appears in it again — twice, at that — `increment`
    /// must still refuse, because revocation is checked independently.
    #[test]
    fn test_stale_allowlist_entry_cannot_resurrect_revoked_caller() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.remove_authorized_caller(&s.admin, &s.contract_id);

        force_authorized_callers(&s, &[&s.contract_id, &s.contract_id]);

        let result = s.client.try_increment(&s.contract_id, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "a stale allowlist entry must not re-authorize a revoked circle"
        );
        assert_eq!(s.client.score(&member), 0);
    }

    /// Repeated admin churn must not accumulate duplicates or reopen access.
    #[test]
    fn test_repeated_admin_updates_keep_lists_consistent() {
        let s = setup();
        let kept = Address::generate(&s.env);
        let revoked = Address::generate(&s.env);

        s.client.add_authorized_caller(&s.admin, &kept);
        s.client.add_authorized_caller(&s.admin, &revoked);
        s.client.remove_authorized_caller(&s.admin, &revoked);

        // Three further attempts to bring the revoked circle back.
        for _ in 0..3 {
            assert_eq!(
                s.client.try_add_authorized_caller(&s.admin, &revoked),
                Err(Ok(ReputationError::CallerRevoked))
            );
            s.client.add_authorized_caller(&s.admin, &kept);
        }

        let callers = s.client.get_authorized_callers();
        assert_eq!(callers.len(), 1, "allowlist must hold only the kept circle");
        assert_eq!(occurrences(&callers, &kept), 1);
        assert_eq!(occurrences(&s.client.get_revoked_callers(), &revoked), 1);
    }

    // ── increment: authorization ──────────────────────────────────────────────

    #[test]
    fn test_increment_by_unauthorized_caller_returns_error() {
        let s = setup();
        let member = Address::generate(&s.env);
        let unregistered_circle = Address::generate(&s.env);
        // No circle registered — increment must be rejected.
        let result = s.client.try_increment(&unregistered_circle, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "unregistered caller must receive UnauthorizedCaller error"
        );
    }

    #[test]
    fn test_increment_by_authorized_caller_succeeds() {
        let s = setup();
        let member = Address::generate(&s.env);
        // Register the reputation contract itself as an authorized caller
        // so we can exercise the happy path from within the test environment.
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(s.client.score(&member), 1);
    }

    #[test]
    fn test_increment_multiple_times() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);
        s.client.increment(&s.contract_id, &member);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(s.client.score(&member), 3);
    }

    #[test]
    fn test_independent_scores_across_members() {
        let s = setup();
        let alice = Address::generate(&s.env);
        let bob = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &alice);
        s.client.increment(&s.contract_id, &alice);
        s.client.increment(&s.contract_id, &bob);
        assert_eq!(s.client.score(&alice), 2);
        assert_eq!(s.client.score(&bob), 1);
    }

    /// Every accepted increment adds exactly one, and every rejected one adds
    /// nothing — the score only ever moves up, and only for a valid circle.
    #[test]
    fn test_score_is_monotonic_and_only_moves_for_valid_circles() {
        let s = setup();
        let member = Address::generate(&s.env);
        let impostor = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);

        let mut expected = 0u32;
        for _ in 0..5 {
            assert_eq!(
                s.client.try_increment(&impostor, &member),
                Err(Ok(ReputationError::UnauthorizedCaller))
            );
            assert_eq!(s.client.score(&member), expected);

            s.client.increment(&s.contract_id, &member);
            expected += 1;
            assert_eq!(s.client.score(&member), expected);
        }
    }

    #[test]
    fn test_increment_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let circle = Address::generate(&env);
        let member = Address::generate(&env);
        let result = client.try_increment(&circle, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "increment before initialize must return NotInitialized"
        );
    }

    // ── event semantics ───────────────────────────────────────────────────────

    #[test]
    fn test_score_updated_event_carries_member_and_new_total() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);

        let events = events_named(&s.env, "score_updated");
        assert_eq!(
            events.len(),
            1,
            "expected exactly one 'score_updated' event"
        );

        let (evt_member, evt_score): (Address, u32) = FromVal::from_val(&s.env, &events[0]);
        assert_eq!(evt_member, member, "event must carry the member address");
        assert_eq!(evt_score, 1u32, "event must carry the new total score");
    }

    #[test]
    fn test_rejected_increment_emits_no_event() {
        let s = setup();
        let member = Address::generate(&s.env);
        let impostor = Address::generate(&s.env);
        let _ = s.client.try_increment(&impostor, &member);
        assert_eq!(events_named(&s.env, "score_updated").len(), 0);
    }

    #[test]
    fn test_caller_added_event_carries_circle_address() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert_eq!(only_address_event(&s.env, "caller_added"), circle);
    }

    #[test]
    fn test_caller_removed_event_carries_circle_address() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        assert_eq!(only_address_event(&s.env, "caller_removed"), circle);
    }

    /// An idempotent re-registration is not a state transition, so replaying
    /// the event stream must not show it as one.
    #[test]
    fn test_duplicate_add_emits_only_one_caller_added_event() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert_eq!(events_named(&s.env, "caller_added").len(), 1);
    }

    /// A rejected re-registration must leave no trace in the event stream
    /// either, so an off-chain replay never resurrects the circle.
    #[test]
    fn test_rejected_re_add_emits_no_caller_added_event() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        let _ = s.client.try_add_authorized_caller(&s.admin, &circle);

        assert_eq!(events_named(&s.env, "caller_added").len(), 1);
        assert_eq!(events_named(&s.env, "caller_removed").len(), 1);
    }
}
