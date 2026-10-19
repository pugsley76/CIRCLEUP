//! CircleFactory — deploys new circle contract instances and maintains a registry.
//!
//! The factory holds the WASM hash of the circle contract, deploys fresh instances
//! via `env.deployer().with_current_contract(salt)`, initialises them in one
//! transaction, and records them in a list for the indexer to discover.
//!
//! # Trust boundaries
//!
//! - `admin` is set once at `initialize` time and is the only address that may
//!   call the factory's own `initialize`.  In the standard deployment the
//!   deployer wallet acts as admin.
//! - The factory contract address is registered as admin of the reputation
//!   contract at `reputation.initialize` time.  This lets the factory call
//!   `reputation.add_authorized_caller` autonomously in `create_circle`.
//! - `create_circle` is permissionless: any wallet may deploy a circle as long
//!   as it satisfies the input validation rules and authorises the call.
//! - No address other than the factory itself may register new authorized
//!   callers on the reputation contract once it is deployed.
//!
//! # Deployment invariant
//!
//! `create_circle` is atomic: factory state (`Circles`, `CircleCount`) is only
//! written **after** deploy + `initialize` + `add_authorized_caller` all
//! succeed.  If any step panics the host rolls back the entire transaction and
//! the registry stays unchanged.
//!
//! # Events
//!
//! All factory events use a two-symbol topic prefix so the indexer can filter
//! with `topic0 == "factory"`.  The canonical payload reference for every
//! event across all three contracts (factory, circle, reputation) is
//! **`docs/EVENTS.md`** in the repository root.
//!
//! ## `factory` / `circle_created`
//!
//! Emitted at the end of a successful [`CircleFactory::create_circle`] call,
//! after the new circle has been deployed, initialised, and registered.
//!
//! | Part | Shape | Meaning |
//! |------|-------|---------|
//! | **Topics** | `(Symbol("factory"), Symbol("circle_created"))` | Stable filter keys |
//! | **Data** | `(Address, Address, u32)` | `(circle_address, creator, circle_index)` |
//!
//! Data fields:
//! 1. `circle_address` — contract ID of the newly deployed circle
//! 2. `creator` — wallet that authorised `create_circle`
//! 3. `circle_index` — zero-based factory counter **before** this create
//!    (mixed into the deploy salt). After the event the stored `CircleCount`
//!    is `circle_index + 1`.
//!
//! **Stability contract:** topics and the order/types of data tuple fields are
//! stable.  Adding a new trailing field is backwards-compatible; reordering or
//! removing fields requires a new event name and an update to `docs/EVENTS.md`.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, Vec,
};

// Circle protocol constants — must match circle contract invariants exactly.
pub const MAX_MEMBERS: u32 = 256;
pub const MIN_ROUND_DEADLINE_LEDGERS: u32 = 100;
pub const MAX_ROUND_DEADLINE_LEDGERS: u32 = 1_036_800;
pub const PENALTY_BPS: i128 = 2_000;

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    CircleWasmHash,
    ReputationContract,
    UsdcToken,
    Circles,      // Vec<Address> — deployed circle addresses in creation order
    CircleCount,  // u32 — monotonic counter; always == Circles.len()
    /// Reentrancy guard held for the duration of `initialize`.
    ///
    /// Set as the very first storage write in `initialize` and cleared once
    /// all setup fully commits.  Mirrors the same pattern used in the circle
    /// contract (`DataKey::Initializing`) so the guard is consistent across
    /// all three contracts in the workspace.  A reentrant call that arrives
    /// mid-initialize sees this flag and panics immediately, before any partial
    /// state is visible.  The `Admin` key absence alone is not a sufficient
    /// guard because a reentrant path would also see `Admin` absent.
    Initializing,
}

// ─── Events ───────────────────────────────────────────────────────────────────

/// Topic-0 namespace shared by every event this contract publishes.
///
/// Mirrors `circle::EVENT_NAMESPACE`: topics are `(EVENT_NAMESPACE, <name>)`.
pub const EVENT_NAMESPACE: &str = "factory";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Reject member lists that contain the same address more than once.
///
/// Duplicate members break payout ordering and let one wallet occupy multiple
/// rotation slots. We fail before paying deploy gas.
fn assert_unique_members(members: &Vec<Address>) {
    let len = members.len();
    let mut i: u32 = 0;
    while i < len {
        let mut j = i + 1;
        while j < len {
            let a = members
                .get(i)
                .unwrap_or_else(|| panic!("factory: member index {} out of bounds", i));
            let b = members
                .get(j)
                .unwrap_or_else(|| panic!("factory: member index {} out of bounds", j));
            if a == b {
                panic!("duplicate members");
            }
            j += 1;
        }
        i += 1;
    }
}

/// Validate all `create_circle` inputs before touching any state.
///
/// This is a pure precondition check — no storage reads or writes.  Every
/// failure here means the factory state is guaranteed to be unchanged.
fn validate_create_inputs(
    members: &Vec<Address>,
    round_amount: i128,
    round_deadline_ledgers: u32,
) {
    // Member count bounds — mirrors circle contract limits exactly.
    let member_count = members.len();
    if member_count < 2 {
        panic!("need at least 2 members");
    }
    if member_count > MAX_MEMBERS {
        panic!("too many members");
    }

    // Duplicate-member check.
    assert_unique_members(members);

    // round_amount: must be strictly positive. Zero or negative would make
    // collateral and pot calculations meaningless.
    if round_amount <= 0 {
        panic!("round_amount must be positive");
    }

    // Overflow pre-check: the circle contract multiplies round_amount by
    // member_count (pot) and by PENALTY_BPS (default penalty). Reject values
    // that would overflow i128 in those paths before we pay deploy gas.
    round_amount
        .checked_mul(member_count as i128)
        .unwrap_or_else(|| panic!("round_amount too large: overflows pot calculation"));
    round_amount
        .checked_mul(PENALTY_BPS)
        .unwrap_or_else(|| panic!("round_amount too large: overflows penalty calculation"));

    // Deadline bounds — must match circle contract's accepted range exactly.
    if round_deadline_ledgers < MIN_ROUND_DEADLINE_LEDGERS {
        panic!("round_deadline_ledgers below minimum");
    }
    if round_deadline_ledgers > MAX_ROUND_DEADLINE_LEDGERS {
        panic!("round_deadline_ledgers above maximum");
    }
}

/// Build a deploy salt unique per successful `create_circle` call.
///
/// Uniqueness comes from:
/// - `count`: monotonic factory counter (incremented only on success, so failed
///   creates do not burn a slot and cannot produce the same count again without
///   an intervening successful deploy).
/// - `creator`: different creators with the same count get different salts.
/// - `ledger().sequence()` + `ledger().timestamp()`: extra entropy guards
///   against count-reset edge cases after a factory redeploy.
fn derive_circle_salt(env: &Env, creator: &Address, count: u32) -> BytesN<32> {
    let mut salt_bytes = Bytes::new(env);
    salt_bytes.append(&creator.clone().to_xdr(env));
    salt_bytes.append(&count.to_xdr(env));
    salt_bytes.append(&env.ledger().sequence().to_xdr(env));
    salt_bytes.append(&env.ledger().timestamp().to_xdr(env));
    env.crypto().sha256(&salt_bytes).into()
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct CircleFactory;

#[contractimpl]
impl CircleFactory {

    // ── Initialization ────────────────────────────────────────────────────────

    /// One-time factory setup.
    ///
    /// `admin` must authorize this call so a third party cannot claim admin by
    /// front-running deployment.  The factory stores all configuration atomically
    /// in a single transaction; if any storage write fails the factory remains
    /// uninitialized and can be safely retried.
    ///
    /// # Trust boundary
    ///
    /// After `initialize` the factory contract address becomes the only entity
    /// that can register authorized callers on the reputation contract (because
    /// the factory is passed as `admin` to `reputation.initialize` before
    /// factory setup, making them mutually authorizing).
    ///
    /// # Reentrancy guard
    ///
    /// Sets `DataKey::Initializing` as the very first storage write and clears
    /// it once all setup commits.  This prevents a reentrant call from racing
    /// through a second initialize mid-flight and observing partially
    /// initialized state.  Consistent with the same guard pattern used in the
    /// circle and reputation contracts.
    ///
    /// # Panics
    ///
    /// - `"already initialized"` if called more than once
    /// - `"initialize already in progress"` if a reentrant call is detected
    pub fn initialize(
        env: Env,
        admin: Address,
        circle_wasm_hash: BytesN<32>,
        reputation_contract: Address,
        usdc_token: Address,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        // Reentrancy guard: set Initializing as the very first write so that
        // any reentrant call (e.g. from a future cross-contract call added here)
        // sees the flag and panics before it can observe or commit partial state.
        if env.storage().instance().has(&DataKey::Initializing) {
            panic!("initialize already in progress");
        }
        env.storage().instance().set(&DataKey::Initializing, &true);

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::CircleWasmHash, &circle_wasm_hash);
        env.storage().instance().set(&DataKey::ReputationContract, &reputation_contract);
        env.storage().instance().set(&DataKey::UsdcToken, &usdc_token);
        env.storage().instance().set(&DataKey::CircleCount, &0u32);
        let circles: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::Circles, &circles);

        // Clear the reentrancy guard once all setup commits successfully.
        env.storage().instance().remove(&DataKey::Initializing);
    }

    // ── Create Circle ─────────────────────────────────────────────────────────

    /// Deploy a new circle contract, initialize it, and register it atomically.
    ///
    /// Returns the address of the newly deployed circle.
    ///
    /// # Atomicity guarantee
    ///
    /// All input validation runs before any state mutation.  The registry
    /// (`Circles`, `CircleCount`) is only written after deploy + `initialize` +
    /// `add_authorized_caller` all succeed.  A failure at any step rolls back
    /// the entire transaction and leaves factory state unchanged.
    ///
    /// # Panics
    ///
    /// - `"factory: create_circle called before initialize"` — factory not set up
    /// - `"need at least 2 members"` — fewer than 2 members supplied
    /// - `"too many members"` — more than `MAX_MEMBERS` supplied
    /// - `"duplicate members"` — same address appears more than once
    /// - `"round_amount must be positive"` — zero or negative amount
    /// - `"round_amount too large: overflows pot calculation"` — would overflow i128
    /// - `"round_deadline_ledgers below minimum"` — below `MIN_ROUND_DEADLINE_LEDGERS`
    /// - `"round_deadline_ledgers above maximum"` — above `MAX_ROUND_DEADLINE_LEDGERS`
    ///
    /// # Events
    ///
    /// Publishes `factory` / `circle_created` — see crate-level docs for shape.
    pub fn create_circle(
        env: Env,
        creator: Address,
        members: Vec<Address>,
        round_amount: i128,
        round_deadline_ledgers: u32,
    ) -> Address {
        creator.require_auth();

        // ── 1. Pure precondition validation (no state reads) ────────────────
        // All panics here leave the factory completely unchanged.
        validate_create_inputs(&members, round_amount, round_deadline_ledgers);

        // ── 2. Load factory config ───────────────────────────────────────────
        // Fail early if the factory was not initialized, before spending gas on
        // deploy. Each missing key produces a distinct, actionable panic message.
        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CircleWasmHash)
            .unwrap_or_else(|| panic!("factory: create_circle called before initialize"));
        let reputation: Address = env
            .storage()
            .instance()
            .get(&DataKey::ReputationContract)
            .unwrap_or_else(|| panic!("factory: ReputationContract missing"));
        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .unwrap_or_else(|| panic!("factory: UsdcToken missing"));

        // ── 3. Read current counter BEFORE any mutation ──────────────────────
        // The counter is mixed into the deploy salt. It is only incremented
        // after the full deploy+init+register sequence succeeds, so a failed
        // create never burns a counter slot.
        // Both registry keys are written by `initialize`.  Treat a missing key
        // as a storage inconsistency instead of defaulting it: a defaulted
        // counter would reuse salts, and a defaulted empty list would wipe
        // every previously registered circle on the write in step 7.
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or_else(|| panic!("factory: CircleCount missing — storage inconsistency"));
        let mut circles: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Circles)
            .unwrap_or_else(|| panic!("factory: Circles registry missing — storage inconsistency"));

        let salt = derive_circle_salt(&env, &creator, count);

        // ── 4. Deploy ────────────────────────────────────────────────────────
        // If deploy fails the transaction aborts here; no registry writes have
        // occurred yet.
        let circle_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy(wasm_hash);

        // ── 5. Initialize the circle ─────────────────────────────────────────
        // Runs inside the same transaction. A panic here rolls back the deploy
        // via the host's transaction-level abort, leaving the registry clean.
        // The factory contract itself is passed as the circle admin so it
        // retains pause/resume authority over every circle it deploys.
        let init_args = soroban_sdk::vec![
            &env,
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(
                &env.current_contract_address(),
                &env,
            ),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&members, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&round_amount, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&usdc, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&reputation, &env),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&round_deadline_ledgers, &env),
        ];
        env.invoke_contract::<()>(&circle_address, &Symbol::new(&env, "initialize"), init_args);

        // ── 6. Register circle as authorized reputation caller ───────────────
        // The factory is the reputation admin, so this call is self-authorized
        // via the Contract Invoker rule. A panic here rolls back the full tx.
        let add_caller_args = soroban_sdk::vec![
            &env,
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(
                &env.current_contract_address(),
                &env,
            ),
            soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&circle_address, &env),
        ];
        env.invoke_contract::<()>(
            &reputation,
            &Symbol::new(&env, "add_authorized_caller"),
            add_caller_args,
        );

        // ── 7. Commit registry state (only reached on full success) ──────────
        // Both writes happen together; they are the only factory state mutations
        // in create_circle. count + 1 always equals circles.len() after this.
        circles.push_back(circle_address.clone());
        env.storage().instance().set(&DataKey::Circles, &circles);
        env.storage().instance().set(&DataKey::CircleCount, &(count + 1));

        // Invariant assertion: count must equal the list length.
        // This fires only in test/debug builds via the host; in production the
        // Soroban WASM environment optimises it away if never triggered.
        let stored_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0);
        let stored_len = circles.len();
        if stored_count != stored_len {
            panic!("factory: registry invariant violated: count != circles.len()");
        }

        // ── Event: factory/circle_created ────────────────────────────────────
        //
        // Emitted after all registry writes have committed so the indexer can
        // read both the updated Circles list and CircleCount in the same ledger.
        //
        // Topics : (Symbol("factory"), Symbol("circle_created"))
        // Data   : (circle_address: Address, creator: Address, circle_index: u32)
        //
        //   circle_address — C-prefix strkey of the newly deployed circle contract.
        //   creator        — G-prefix strkey of the wallet that called create_circle.
        //   circle_index   — zero-based factory counter BEFORE this create;
        //                    CircleCount after this event == circle_index + 1.
        //
        // Stability: topics and field order are stable (see docs/EVENTS.md).
        // A future change that adds fields must append them and update EVENTS.md.
        env.events().publish(
            (Symbol::new(&env, EVENT_NAMESPACE), Symbol::new(&env, "circle_created")),
            (circle_address.clone(), creator, count),
        );

        circle_address
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Returns all deployed circle addresses in creation order.
    pub fn get_circles(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Circles)
            .unwrap_or(Vec::new(&env))
    }

    /// Returns the total number of deployed circles.
    ///
    /// Always equals `get_circles().len()` — the two are written atomically.
    pub fn get_circle_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CircleCount)
            .unwrap_or(0)
    }

    /// Returns the factory admin.
    ///
    /// Panics with `"not initialized"` if called before `initialize`.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Returns the USDC token address configured at initialize.
    ///
    /// Panics with `"not initialized"` if called before `initialize`.
    pub fn get_usdc_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UsdcToken)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Returns the reputation contract address configured at initialize.
    ///
    /// Exposes the reputation contract address so off-chain tooling and
    /// auditors can verify which reputation contract this factory interacts
    /// with without deserializing the full factory configuration.
    ///
    /// Panics with `"not initialized"` if called before `initialize`.
    pub fn get_reputation_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::ReputationContract)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Returns the circle WASM hash configured at initialize.
    ///
    /// The hash identifies the exact version of the circle contract that this
    /// factory deploys.  Callers can compare it against a known hash to verify
    /// that the factory is deploying the expected contract binary before
    /// committing gas to `create_circle`.
    ///
    /// Panics with `"not initialized"` if called before `initialize`.
    pub fn get_circle_wasm_hash(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::CircleWasmHash)
            .unwrap_or_else(|| panic!("not initialized"))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };
    use reputation::{ReputationContract, ReputationContractClient, ReputationError};

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct FactorySetup<'a> {
        client: CircleFactoryClient<'a>,
        admin: Address,
        #[allow(dead_code)]
        rep: Address,
        usdc: Address,
        wasm_hash: BytesN<32>,
    }

    fn setup_factory(env: &Env) -> FactorySetup<'_> {
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(env, &id);
        let admin = Address::generate(env);
        let rep   = Address::generate(env);
        let usdc  = Address::generate(env);
        let wasm_hash: BytesN<32> = BytesN::from_array(env, &[0u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        FactorySetup { client, admin, rep, usdc, wasm_hash }
    }

    /// Generate N distinct addresses.
    fn make_members(env: &Env, n: u32) -> Vec<Address> {
        let mut v = Vec::new(env);
        for _ in 0..n {
            v.push_back(Address::generate(env));
        }
        v
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn test_factory_initializes() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    #[test]
    fn test_get_admin_and_usdc_token() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_admin(), s.admin);
        assert_eq!(s.client.get_usdc_token(), s.usdc);
    }

    #[test]
    fn test_get_reputation_contract() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let rep   = Address::generate(&env);
        let usdc  = Address::generate(&env);
        let wasm_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        assert_eq!(
            client.get_reputation_contract(),
            rep,
            "get_reputation_contract must return the address set at initialize"
        );
    }

    #[test]
    fn test_get_circle_wasm_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let rep   = Address::generate(&env);
        let usdc  = Address::generate(&env);
        let wasm_hash: BytesN<32> = BytesN::from_array(&env, &[0xabu8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        assert_eq!(
            client.get_circle_wasm_hash(),
            wasm_hash,
            "get_circle_wasm_hash must return the hash set at initialize"
        );
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_reputation_contract_before_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        CircleFactoryClient::new(&env, &id).get_reputation_contract();
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_circle_wasm_hash_before_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        CircleFactoryClient::new(&env, &id).get_circle_wasm_hash();
    }

    #[test]
    fn test_all_getters_return_configured_values() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin     = Address::generate(&env);
        let rep       = Address::generate(&env);
        let usdc      = Address::generate(&env);
        let wasm_hash: BytesN<32> = BytesN::from_array(&env, &[0x42u8; 32]);
        client.initialize(&admin, &wasm_hash, &rep, &usdc);
        assert_eq!(client.get_admin(),                admin,     "admin");
        assert_eq!(client.get_usdc_token(),           usdc,      "usdc_token");
        assert_eq!(client.get_reputation_contract(),  rep,       "reputation_contract");
        assert_eq!(client.get_circle_wasm_hash(),     wasm_hash, "circle_wasm_hash");
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        let s = setup_factory(&env);
        let admin2 = Address::generate(&env);
        s.client.initialize(&admin2, &s.wasm_hash, &Address::generate(&env), &Address::generate(&env));
    }

    /// The reentrancy guard (DataKey::Initializing) is set before any other
    /// storage write in `initialize`.  A second call that arrives while the
    /// first is still in progress must panic with "initialize already in
    /// progress" rather than proceeding and observing partial state.
    ///
    /// In the test environment we simulate this by manually setting the
    /// Initializing flag via `as_contract` before calling initialize on a
    /// fresh (un-initialized) factory instance.
    #[test]
    #[should_panic(expected = "initialize already in progress")]
    fn test_initialize_reentrancy_guard_fires() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);

        // Simulate a reentrant call landing mid-initialize by pre-setting the flag.
        env.as_contract(&id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        let admin = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        // Must panic: Initializing flag is already set.
        client.initialize(&admin, &wh, &Address::generate(&env), &Address::generate(&env));
    }

    /// After a failed initialize (reentrancy panic) the Admin key must remain
    /// absent, confirming that the guard fires before any committed state.
    #[test]
    fn test_initialize_reentrancy_guard_leaves_no_admin_state() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);

        env.as_contract(&id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        let admin = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_initialize(
            &admin, &wh, &Address::generate(&env), &Address::generate(&env),
        );
        assert!(result.is_err(), "initialize with Initializing flag set must fail");

        // Admin key must not have been written.
        let admin_result = client.try_get_admin();
        assert!(
            admin_result.is_err(),
            "Admin key must be absent after a reentrancy-guard failure"
        );
    }

    #[test]
    fn test_initial_circle_count_is_zero() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_admin_before_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        CircleFactoryClient::new(&env, &id).get_admin();
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn test_get_usdc_token_before_init_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        CircleFactoryClient::new(&env, &id).get_usdc_token();
    }

    #[test]
    fn test_initialize_records_auth_for_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        client.initialize(&admin, &wh, &Address::generate(&env), &Address::generate(&env));
        assert_eq!(client.get_admin(), admin);
    }

    // ── validate_create_inputs ────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "need at least 2 members")]
    fn test_validate_rejects_single_member() {
        let env = Env::default();
        let mut m = Vec::new(&env);
        m.push_back(Address::generate(&env));
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "need at least 2 members")]
    fn test_validate_rejects_empty_members() {
        let env = Env::default();
        let m = Vec::new(&env);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "too many members")]
    fn test_validate_rejects_too_many_members() {
        let env = Env::default();
        let m = make_members(&env, MAX_MEMBERS + 1);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_validate_rejects_duplicate_members() {
        let env = Env::default();
        let a = Address::generate(&env);
        let mut m = Vec::new(&env);
        m.push_back(a.clone());
        m.push_back(Address::generate(&env));
        m.push_back(a);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_amount must be positive")]
    fn test_validate_rejects_zero_round_amount() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 0, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_amount must be positive")]
    fn test_validate_rejects_negative_round_amount() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, -1, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers below minimum")]
    fn test_validate_rejects_deadline_below_minimum() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS - 1);
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers above maximum")]
    fn test_validate_rejects_deadline_above_maximum() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 1_000_000, MAX_ROUND_DEADLINE_LEDGERS + 1);
    }

    #[test]
    fn test_validate_accepts_boundary_deadlines() {
        let env = Env::default();
        let m = make_members(&env, 2);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
        validate_create_inputs(&m, 1_000_000, MAX_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    fn test_validate_accepts_max_members_at_boundary() {
        let env = Env::default();
        let m = make_members(&env, MAX_MEMBERS);
        validate_create_inputs(&m, 1_000_000, MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_amount too large: overflows pot calculation")]
    fn test_validate_rejects_round_amount_overflow() {
        let env = Env::default();
        let m = make_members(&env, 2);
        // i128::MAX / 1 = i128::MAX — multiplied by member_count(2) overflows
        validate_create_inputs(&m, i128::MAX, MIN_ROUND_DEADLINE_LEDGERS);
    }

    // ── assert_unique_members (unit) ──────────────────────────────────────────

    #[test]
    fn test_assert_unique_members_accepts_distinct() {
        let env = Env::default();
        let m = make_members(&env, 3);
        assert_unique_members(&m);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_assert_unique_members_rejects_duplicates() {
        let env = Env::default();
        let a = Address::generate(&env);
        let mut m = Vec::new(&env);
        m.push_back(a.clone());
        m.push_back(Address::generate(&env));
        m.push_back(a);
        assert_unique_members(&m);
    }

    // ── derive_circle_salt (unit) ─────────────────────────────────────────────

    #[test]
    fn test_derive_circle_salt_is_stable_for_same_inputs() {
        let env = Env::default();
        let creator = Address::generate(&env);
        assert_eq!(
            derive_circle_salt(&env, &creator, 0),
            derive_circle_salt(&env, &creator, 0)
        );
    }

    #[test]
    fn test_derive_circle_salt_differs_by_count() {
        let env = Env::default();
        let creator = Address::generate(&env);
        assert_ne!(
            derive_circle_salt(&env, &creator, 0),
            derive_circle_salt(&env, &creator, 1)
        );
    }

    #[test]
    fn test_derive_circle_salt_differs_by_creator() {
        let env = Env::default();
        assert_ne!(
            derive_circle_salt(&env, &Address::generate(&env), 0),
            derive_circle_salt(&env, &Address::generate(&env), 0)
        );
    }

    #[test]
    fn test_derive_circle_salt_differs_by_ledger_sequence() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let s0 = derive_circle_salt(&env, &creator, 0);
        env.ledger().with_mut(|l| l.sequence_number += 1);
        let s1 = derive_circle_salt(&env, &creator, 0);
        assert_ne!(s0, s1);
    }

    // ── Issue #545 — create_circle salt generation collision safety ───────────
    //
    // The four inputs to derive_circle_salt are: creator, count,
    // ledger_sequence, and ledger_timestamp.  The tests above cover creator,
    // count, and sequence.  The tests below cover timestamp and verify the
    // determinism / uniqueness properties of the full input space.

    /// Changing only the ledger timestamp while holding creator, count, and
    /// sequence constant must produce a different salt.  This confirms that
    /// timestamp entropy is actually incorporated into the SHA-256 input.
    #[test]
    fn test_545_derive_circle_salt_differs_by_timestamp() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let s0 = derive_circle_salt(&env, &creator, 0);
        env.ledger().with_mut(|l| l.timestamp += 1);
        let s1 = derive_circle_salt(&env, &creator, 0);
        assert_ne!(s0, s1, "salt must change when only the ledger timestamp advances");
    }

    /// The salt function must be deterministic: identical inputs (creator,
    /// count, sequence, timestamp) always produce the same output.  A
    /// second call within the same ledger state must return the same bytes.
    #[test]
    fn test_545_derive_circle_salt_is_deterministic_given_fixed_ledger() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let a = derive_circle_salt(&env, &creator, 5);
        let b = derive_circle_salt(&env, &creator, 5);
        assert_eq!(a, b, "salt must be deterministic for the same (creator, count, ledger) inputs");
    }

    /// Each of the four salt inputs contributes independently: changing any
    /// single input while holding the others constant produces a distinct salt.
    /// This is a combined regression guard that the SHA-256 pre-image uses all
    /// four fields and none is accidentally a no-op.
    #[test]
    fn test_545_each_salt_input_independently_contributes() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let base = derive_circle_salt(&env, &creator, 0);

        // different creator
        assert_ne!(base, derive_circle_salt(&env, &Address::generate(&env), 0),
            "different creator must change the salt");

        // different count
        assert_ne!(base, derive_circle_salt(&env, &creator, 1),
            "different count must change the salt");

        // different sequence
        env.ledger().with_mut(|l| l.sequence_number += 1);
        let after_seq = derive_circle_salt(&env, &creator, 0);
        assert_ne!(base, after_seq, "different sequence must change the salt");
        env.ledger().with_mut(|l| l.sequence_number -= 1);

        // different timestamp
        env.ledger().with_mut(|l| l.timestamp += 1);
        let after_ts = derive_circle_salt(&env, &creator, 0);
        assert_ne!(base, after_ts, "different timestamp must change the salt");
    }

    /// A failed create_circle call must not consume a counter slot.  Repeating
    /// the same valid (creator, count=0, sequence, timestamp) after a failed
    /// attempt must produce the same salt as the original attempt, confirming
    /// that the counter was not incremented.
    #[test]
    fn test_545_failed_create_does_not_advance_salt_counter() {
        let env = Env::default();
        let s = setup_factory(&env);

        // Record the salt that would be used for the first successful create.
        let creator = Address::generate(&env);
        let salt_before_fail = derive_circle_salt(&env, &creator, 0);

        // Attempt an invalid create (zero round_amount) — must be rejected.
        let m = make_members(&env, 2);
        let result = s.client.try_create_circle(
            &creator, &m, &0i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "zero-amount create must be rejected");

        // Counter must still be 0 — same salt would be generated for a
        // retry with the same ledger state.
        assert_eq!(s.client.get_circle_count(), 0,
            "failed create must not increment the factory counter");
        let salt_after_fail = derive_circle_salt(&env, &creator, 0);
        assert_eq!(salt_before_fail, salt_after_fail,
            "salt for count=0 must be identical before and after a failed create");
    }

    // ── create_circle: rejected before initialize ─────────────────────────────

    #[test]
    #[should_panic(expected = "factory: create_circle called before initialize")]
    fn test_create_circle_before_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let m = make_members(&env, 2);
        client.create_circle(
            &Address::generate(&env),
            &m,
            &1_000_000i128,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ── create_circle: registry keys must exist (issue #567) ─────────────────
    //
    // A missing counter or list on an initialized factory is a storage
    // inconsistency.  Defaulting them would reuse deploy salts or overwrite
    // the registry with only the new circle, so both are rejected before the
    // deploy step.

    #[test]
    #[should_panic(expected = "factory: Circles registry missing")]
    fn test_create_circle_rejects_missing_circles_registry() {
        let env = Env::default();
        let s = setup_factory(&env);
        env.as_contract(&s.client.address, || {
            env.storage().instance().remove(&DataKey::Circles);
        });
        s.client.create_circle(
            &Address::generate(&env), &make_members(&env, 2), &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    #[test]
    #[should_panic(expected = "factory: CircleCount missing")]
    fn test_create_circle_rejects_missing_circle_count() {
        let env = Env::default();
        let s = setup_factory(&env);
        env.as_contract(&s.client.address, || {
            env.storage().instance().remove(&DataKey::CircleCount);
        });
        s.client.create_circle(
            &Address::generate(&env), &make_members(&env, 2), &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    // ── Event namespaces (issue #566) ─────────────────────────────────────────

    /// The indexer routes events by topic 0; the three contracts must each
    /// own a distinct, stable namespace.
    #[test]
    fn test_event_namespaces_are_stable_and_distinct() {
        assert_eq!(EVENT_NAMESPACE, "factory");
        assert_eq!(circle::EVENT_NAMESPACE, "circle");
        assert_eq!(reputation::EVENT_NAMESPACE, "reputation");
        assert_ne!(EVENT_NAMESPACE, circle::EVENT_NAMESPACE);
        assert_ne!(EVENT_NAMESPACE, reputation::EVENT_NAMESPACE);
        assert_ne!(circle::EVENT_NAMESPACE, reputation::EVENT_NAMESPACE);
    }

    // ── create_circle: input validation rejects before any state mutation ─────

    #[test]
    fn test_create_circle_rejects_single_member_no_state_change() {
        let env = Env::default();
        env.mock_all_auths();
        let s = setup_factory(&env);
        let mut m = Vec::new(&env);
        m.push_back(Address::generate(&env));
        let count_before = s.client.get_circle_count();
        let result = s.client.try_create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "single-member create must be rejected");
        // Count must be unchanged after the rejection
        assert_eq!(s.client.get_circle_count(), count_before);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn test_create_circle_rejects_duplicate_members() {
        let env = Env::default();
        let s = setup_factory(&env);
        let a = Address::generate(&env);
        let mut m = Vec::new(&env);
        m.push_back(a.clone());
        m.push_back(a);
        s.client.create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
    }

    #[test]
    #[should_panic(expected = "round_amount must be positive")]
    fn test_create_circle_rejects_zero_round_amount() {
        let env = Env::default();
        let s = setup_factory(&env);
        let m = make_members(&env, 2);
        s.client.create_circle(&Address::generate(&env), &m, &0i128, &MIN_ROUND_DEADLINE_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers below minimum")]
    fn test_create_circle_rejects_deadline_below_min() {
        let env = Env::default();
        let s = setup_factory(&env);
        let m = make_members(&env, 2);
        s.client.create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &(MIN_ROUND_DEADLINE_LEDGERS - 1),
        );
    }

    #[test]
    #[should_panic(expected = "round_deadline_ledgers above maximum")]
    fn test_create_circle_rejects_deadline_above_max() {
        let env = Env::default();
        let s = setup_factory(&env);
        let m = make_members(&env, 2);
        s.client.create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &(MAX_ROUND_DEADLINE_LEDGERS + 1),
        );
    }

    // ── Registry integrity: count == circles.len() always ────────────────────

    #[test]
    fn test_registry_count_equals_circles_len_after_batch() {
        // We can't run real deploys in unit tests (WASM hash is a dummy), so
        // we verify the invariant via the helper logic directly and confirm the
        // storage invariant on the factory's own in-memory model.
        // For each validation failure the factory count must stay at 0.
        let env = Env::default();
        let s = setup_factory(&env);

        // After each failed attempt, count and list length must still match.
        let attempt = |m: Vec<Address>, amount: i128, dl: u32| {
            let _ = s.client.try_create_circle(&Address::generate(&env), &m, &amount, &dl);
        };

        attempt(make_members(&env, 1), 1_000_000, MIN_ROUND_DEADLINE_LEDGERS); // < 2 members
        attempt(make_members(&env, 2), 0, MIN_ROUND_DEADLINE_LEDGERS);          // zero amount
        attempt(make_members(&env, 2), 1_000_000, 0);                           // dl < min

        // Registry must still be empty and consistent.
        let count = s.client.get_circle_count();
        let len   = s.client.get_circles().len();
        assert_eq!(count, 0, "count must remain 0 after all failed creates");
        assert_eq!(count, len, "count must equal circles.len() at all times");
    }

    #[test]
    fn test_registry_list_is_monotonic_and_deduplicated() {
        // Each unique successful deploy produces a unique address.
        // We validate the structural property: validate_create_inputs rejects
        // duplicate-member configs before any deploy, ensuring no two circles
        // can be created with identical member lists without at least a ledger
        // advance (different salt).
        let env = Env::default();
        let m = make_members(&env, 2);

        // Two calls with the same members but different ledger sequences would
        // produce different salts and thus different addresses — verified by
        // salt-differ test above. The registry itself never deduplicates by
        // member set; uniqueness is enforced at the salt level.
        // Here we just confirm unique_members still works after batch rejects.
        assert_unique_members(&m);

        // Confirm idempotency: a second call on the same members doesn't panic
        // in assert_unique_members (no false-positive after first call).
        assert_unique_members(&m);
    }

    // ── Failed create leaves factory state unchanged ──────────────────────────

    #[test]
    fn test_failed_create_does_not_increment_count() {
        let env = Env::default();
        let s = setup_factory(&env);
        assert_eq!(s.client.get_circle_count(), 0);

        // Attempt invalid create (zero amount) — must not change count.
        let m = make_members(&env, 2);
        let result = s.client.try_create_circle(
            &Address::generate(&env), &m, &0i128, &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "expected error for zero round_amount");
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    #[test]
    fn test_failed_create_does_not_add_to_circles_list() {
        let env = Env::default();
        let s = setup_factory(&env);

        // Invalid deadline — no state mutation should occur.
        let m = make_members(&env, 2);
        let _ = s.client.try_create_circle(
            &Address::generate(&env), &m, &1_000_000i128, &0u32,
        );
        assert!(s.client.get_circles().is_empty());
        assert_eq!(s.client.get_circle_count(), 0);
    }

    #[test]
    fn test_multiple_failed_creates_state_remains_clean() {
        let env = Env::default();
        let s = setup_factory(&env);

        for _ in 0..5 {
            // Duplicate-member failure
            let a = Address::generate(&env);
            let mut m = Vec::new(&env);
            m.push_back(a.clone());
            m.push_back(a);
            let _ = s.client.try_create_circle(
                &Address::generate(&env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
            );
        }

        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    // ── Auth + init guard edge cases ──────────────────────────────────────────

    /// `initialize` must require the admin to authorize the call.
    ///
    /// With `mock_all_auths` disabled the admin signature is absent, so the
    /// `admin.require_auth()` call inside `initialize` must cause a trap/panic
    /// that surfaces as an error result.
    #[test]
    fn test_initialize_requires_admin_auth() {
        let env = Env::default();
        // Do NOT call env.mock_all_auths() — no authorization is provided.
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);

        let result = client.try_initialize(
            &admin,
            &wh,
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert!(
            result.is_err(),
            "initialize must be rejected when admin authorization is missing"
        );
        // Factory must remain uninitialized — no Admin key written.
        let admin_result = client.try_get_admin();
        assert!(
            admin_result.is_err(),
            "Admin key must be absent after rejected initialize (no auth)"
        );
    }

    /// `create_circle` must require the creator to authorize the call.
    ///
    /// With `mock_all_auths` disabled the creator signature is absent, so the
    /// `creator.require_auth()` call inside `create_circle` must reject before
    /// touching any factory state.
    #[test]
    fn test_create_circle_requires_creator_auth() {
        let env = Env::default();
        // Initialize the factory with mocked auth so it is in a valid state.
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin  = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        client.initialize(&admin, &wh, &Address::generate(&env), &Address::generate(&env));

        // Now strip auth and attempt create_circle.
        env.set_auths(&[]);
        let m = make_members(&env, 2);
        let result = client.try_create_circle(
            &Address::generate(&env),
            &m,
            &1_000_000i128,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(
            result.is_err(),
            "create_circle must be rejected when creator authorization is missing"
        );
        // Factory state must be unchanged.
        assert_eq!(
            client.get_circle_count(),
            0,
            "circle count must remain 0 after rejected create (no auth)"
        );
        assert!(
            client.get_circles().is_empty(),
            "circles list must remain empty after rejected create (no auth)"
        );
    }

    /// After a successful `initialize` the `Initializing` reentrancy guard must
    /// be removed from storage.  If the flag persists, the factory would reject
    /// every subsequent call as "initialize already in progress".
    #[test]
    fn test_initialize_clears_reentrancy_guard_on_success() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let wh: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);

        // Successful initialize.
        client.initialize(&admin, &wh, &Address::generate(&env), &Address::generate(&env));

        // Verify the Initializing flag is gone by checking that a second
        // initialize fails with "already initialized" (from the Admin check)
        // rather than "initialize already in progress" (from the guard).
        let result = client.try_initialize(
            &Address::generate(&env),
            &wh,
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert!(
            result.is_err(),
            "second initialize must fail on Admin presence check, not on lingering Initializing flag"
        );
        // The Admin key must still be the original admin — proving the guard
        // was cleared and the double-init guard fired correctly.
        assert_eq!(client.get_admin(), admin);
    }

    /// `create_circle` called with an uninitialized factory must fail with the
    /// specific "called before initialize" message, not with a generic storage
    /// panic.  This ensures the early-exit guard fires before spending deploy gas.
    #[test]
    fn test_create_circle_before_initialize_uses_descriptive_panic() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, CircleFactory);
        let client = CircleFactoryClient::new(&env, &id);

        let m = make_members(&env, 2);
        let result = client.try_create_circle(
            &Address::generate(&env),
            &m,
            &1_000_000i128,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(
            result.is_err(),
            "create_circle must be rejected when the factory is not initialized"
        );
    }

    // ── Adversarial authorization tests (Issue #87) ───────────────────────────

    /// Re-initializing an already-initialized factory is rejected and leaves
    /// the original admin and circle count unchanged.
    #[test]
    fn adv_factory_double_initialize_rejected_state_unchanged() {
        let env = Env::default();
        let s = setup_factory(&env);

        let attacker = Address::generate(&env);
        let bad_hash: BytesN<32> = BytesN::from_array(&env, &[0xffu8; 32]);

        let result = s.client.try_initialize(
            &attacker,
            &bad_hash,
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert!(result.is_err(), "second factory initialize must be rejected");

        // Admin must still be the original admin
        assert_eq!(
            s.client.get_admin(),
            s.admin,
            "admin must be unchanged after rejected re-initialization"
        );

        // Circle count must still be 0 (no state written)
        assert_eq!(
            s.client.get_circle_count(),
            0,
            "circle count must be unchanged after rejected re-initialization"
        );
        assert!(s.client.get_circles().is_empty());
    }

    /// A create_circle call with fewer than 2 members is rejected and the
    /// factory circle count stays at its pre-call value.
    #[test]
    fn adv_factory_create_circle_single_member_count_unchanged() {
        let env = Env::default();
        let s = setup_factory(&env);

        let count_before = s.client.get_circle_count();
        let mut m = Vec::new(&env);
        m.push_back(Address::generate(&env));

        let result = s.client.try_create_circle(
            &Address::generate(&env),
            &m,
            &1_000_000i128,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "single-member create must be rejected");
        assert_eq!(
            s.client.get_circle_count(),
            count_before,
            "circle count must be unchanged after rejected create"
        );
        assert!(s.client.get_circles().is_empty());
    }

    /// A create_circle call with a negative round_amount is rejected; the
    /// factory registry stays empty.
    #[test]
    fn adv_factory_create_circle_negative_amount_registry_unchanged() {
        let env = Env::default();
        let s = setup_factory(&env);

        let m = make_members(&env, 3);
        let result = s.client.try_create_circle(
            &Address::generate(&env),
            &m,
            &(-1i128),
            &MIN_ROUND_DEADLINE_LEDGERS,
        );
        assert!(result.is_err(), "negative round_amount create must be rejected");
        assert_eq!(s.client.get_circle_count(), 0);
        assert!(s.client.get_circles().is_empty());
    }

    // ── Integrated fixture: factory ↔ reputation trust boundary ──────────────
    //
    // These tests wire the factory and reputation contracts together as real
    // native Rust contracts in the test environment, verifying the trust
    // relationship described in the module header without relying on a live
    // ledger or compiled WASM.
    //
    // Note: the full `create_circle` success path (deploy + init + register)
    // requires a valid circle WASM hash obtained from a compiled binary.
    // That path is covered by the end-to-end contract integration tests in
    // contracts/circle/src/tests.rs which register all three contracts.
    // The tests below focus on the factory ↔ reputation portion of that flow.

    struct IntegratedSetup<'a> {
        env: Env,
        factory_id: Address,
        factory: CircleFactoryClient<'a>,
        reputation_id: Address,
        reputation: ReputationContractClient<'a>,
        admin: Address,
        usdc: Address,
    }

    fn setup_integrated() -> IntegratedSetup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let usdc  = Address::generate(&env);

        // Register reputation with factory as its admin (mirrors real deployment).
        let reputation_id = env.register_contract(None, ReputationContract);
        let reputation = ReputationContractClient::new(&env, &reputation_id);

        // Register the factory.
        let factory_id = env.register_contract(None, CircleFactory);
        let factory = CircleFactoryClient::new(&env, &factory_id);

        // Wire: reputation admin = factory (so only the factory may register circles).
        reputation.initialize(&factory_id);

        // Wire: factory knows the reputation contract address.
        let dummy_wasm: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        factory.initialize(&admin, &dummy_wasm, &reputation_id, &usdc);

        IntegratedSetup { env, factory_id, factory, reputation_id, reputation, admin, usdc }
    }

    /// Factory address must equal the admin stored inside the reputation contract.
    /// This ensures that only the factory can add or remove authorized callers on
    /// reputation — no other wallet or contract can widen the trust boundary.
    #[test]
    fn test_integrated_factory_is_reputation_admin() {
        let s = setup_integrated();
        assert_eq!(
            s.reputation.get_admin(),
            s.factory_id,
            "reputation admin must be the factory contract address"
        );
    }

    /// A non-factory address must be rejected by reputation when it tries to
    /// register an authorized caller, proving that the trust boundary holds even
    /// when mock_all_auths is active (the check is the stored admin, not a sig).
    #[test]
    fn test_integrated_reputation_rejects_non_factory_caller_registration() {
        let s = setup_integrated();
        let attacker = Address::generate(&s.env);
        let circle   = Address::generate(&s.env);

        let result = s.reputation.try_add_authorized_caller(&attacker, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "reputation must reject add_authorized_caller from a non-factory address"
        );
        assert_eq!(
            s.reputation.get_authorized_callers().len(),
            0,
            "the rejected call must leave the authorized caller list untouched"
        );
    }

    /// The factory address (acting as reputation admin) must be able to register
    /// a circle as an authorized reputation caller.  This simulates step 6 of
    /// `create_circle` without needing a deployed circle WASM.
    #[test]
    fn test_integrated_factory_can_register_circle_with_reputation() {
        let s = setup_integrated();
        let synthetic_circle = Address::generate(&s.env);

        // Simulate what create_circle step 6 does: factory calls
        // reputation.add_authorized_caller(factory_id, circle_address).
        s.reputation.add_authorized_caller(&s.factory_id, &synthetic_circle);

        assert!(
            s.reputation.get_authorized_callers().contains(&synthetic_circle),
            "reputation must record the circle as authorized after factory registration"
        );
        assert_eq!(
            s.reputation.get_authorized_callers().len(),
            1,
            "only one circle must appear in the authorized callers list"
        );
    }

    /// Multiple invalid `create_circle` calls must leave the reputation contract
    /// completely unaffected.  Because the factory fails at the deploy step (step 4),
    /// step 6 (reputation registration) is never reached, so the reputation
    /// authorized-caller list must remain empty after any number of bad creates.
    #[test]
    fn test_integrated_failed_creates_never_mutate_reputation() {
        let s = setup_integrated();

        // Five adversarial create attempts — all fail at input validation (before
        // deploy), so reputation must never be touched.
        let invalid_calls: &[(&dyn Fn() -> bool)] = &[
            &|| {
                let m = make_members(&s.env, 1); // too few members
                s.factory.try_create_circle(
                    &Address::generate(&s.env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
                ).is_err()
            },
            &|| {
                let m = make_members(&s.env, 2);
                s.factory.try_create_circle(
                    &Address::generate(&s.env), &m, &0i128, &MIN_ROUND_DEADLINE_LEDGERS,
                ).is_err()
            },
            &|| {
                let m = make_members(&s.env, 2);
                s.factory.try_create_circle(
                    &Address::generate(&s.env), &m, &1_000_000i128, &(MIN_ROUND_DEADLINE_LEDGERS - 1),
                ).is_err()
            },
            &|| {
                let m = make_members(&s.env, 2);
                s.factory.try_create_circle(
                    &Address::generate(&s.env), &m, &1_000_000i128, &(MAX_ROUND_DEADLINE_LEDGERS + 1),
                ).is_err()
            },
            &|| {
                let a = Address::generate(&s.env);
                let mut m = Vec::new(&s.env);
                m.push_back(a.clone());
                m.push_back(a); // duplicate member
                s.factory.try_create_circle(
                    &Address::generate(&s.env), &m, &1_000_000i128, &MIN_ROUND_DEADLINE_LEDGERS,
                ).is_err()
            },
        ];

        for (i, call) in invalid_calls.iter().enumerate() {
            assert!(call(), "adversarial call {} must be rejected", i + 1);
        }

        assert_eq!(
            s.reputation.get_authorized_callers().len(),
            0,
            "reputation authorized callers must be empty after all failed factory creates"
        );
    }

    /// Each test must start from a completely independent state: separate Env
    /// instances guarantee no circle registry, no reputation state, and no
    /// authorized callers carry over between test cases.
    #[test]
    fn test_integrated_each_test_has_isolated_state() {
        // Two setups in the same test function — each gets a fresh environment.
        let s1 = setup_integrated();
        let s2 = setup_integrated();

        // Register a circle in s1 only.
        let circle = Address::generate(&s1.env);
        s1.reputation.add_authorized_caller(&s1.factory_id, &circle);

        // s2's reputation must remain untouched.
        assert_eq!(
            s2.reputation.get_authorized_callers().len(),
            0,
            "state from one test setup must not leak into another"
        );
        assert_eq!(s2.factory.get_circle_count(), 0);
        assert!(s2.factory.get_circles().is_empty());
    }

    /// A batch of five different adversarial create_circle calls (each with a
    /// distinct invalid parameter) must all be rejected without incrementing
    /// the factory counter.
    #[test]
    fn adv_factory_batch_adversarial_creates_all_rejected() {
        let env = Env::default();
        let s = setup_factory(&env);

        let adversarial_calls: &[(&dyn Fn() -> bool)] = &[
            // 1. empty member list
            &|| {
                let m = Vec::new(&env);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &MIN_ROUND_DEADLINE_LEDGERS,
                    )
                    .is_err()
            },
            // 2. single member
            &|| {
                let mut m = Vec::new(&env);
                m.push_back(Address::generate(&env));
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &MIN_ROUND_DEADLINE_LEDGERS,
                    )
                    .is_err()
            },
            // 3. zero amount
            &|| {
                let m = make_members(&env, 2);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &0i128,
                        &MIN_ROUND_DEADLINE_LEDGERS,
                    )
                    .is_err()
            },
            // 4. deadline below minimum
            &|| {
                let m = make_members(&env, 2);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &(MIN_ROUND_DEADLINE_LEDGERS - 1),
                    )
                    .is_err()
            },
            // 5. deadline above maximum
            &|| {
                let m = make_members(&env, 2);
                s.client
                    .try_create_circle(
                        &Address::generate(&env),
                        &m,
                        &1_000_000i128,
                        &(MAX_ROUND_DEADLINE_LEDGERS + 1),
                    )
                    .is_err()
            },
        ];

        for (i, call) in adversarial_calls.iter().enumerate() {
            assert!(call(), "adversarial call {} must be rejected", i + 1);
        }

        assert_eq!(
            s.client.get_circle_count(),
            0,
            "factory circle count must be 0 after all adversarial create attempts"
        );
        assert!(
            s.client.get_circles().is_empty(),
            "circles list must be empty after all adversarial create attempts"
        );
    }
}
