# CircleUp — SDK Contract Fixture Maintenance Guide

This document explains the fixture strategy used to protect the SDK ↔ contract
boundary, what to do when a contract interface changes, and how to add coverage
for new methods.

See also: [`docs/API_INVARIANTS.md`](./API_INVARIANTS.md) for the full
invariant catalog, [`docs/EVENTS.md`](./EVENTS.md) for event payload shapes.

---

## Why fixtures exist

A TypeScript client can call the wrong contract method, pass arguments in the
wrong order, or use the wrong XDR type for a parameter — and all of these will
**compile without error**. The failure only surfaces at runtime as an opaque
Soroban host error. By the time it reaches a user it looks like a network
problem or an unrelated contract trap.

The fixture tests in `sdk/src/__tests__/contractFixtures.test.ts` and
`contractFixtures.extended.test.ts` close this gap by:

1. Encoding each contract method's arguments as base64 XDR using the same SDK
   builder functions the application uses (`scAddress`, `scU32`, `scI128`, …).
2. Decoding the XDR back and comparing each field to the expected native value.
3. Running this on every CI build so a signature drift is caught before
   deployment, not after.

If a method's argument count, argument order, or argument type changes in Rust,
the fixture will fail to decode — or will decode to wrong values — and the test
will fail loudly in CI.

---

## File layout

| File | What it tests |
|------|---------------|
| `sdk/src/__tests__/contractFixtures.test.ts` | **Argument shapes** — the XDR encoding of every contract method's parameters |
| `sdk/src/__tests__/contractFixtures.extended.test.ts` | **Return-value shapes** — the wire format produced by `scValToNative` for contract return types, validated against `mapRawConfig`, `mapRawRoundState`, and the individual decode helpers |

---

## How `scValToNative` maps Soroban types

When the Stellar SDK decodes a Soroban return value with `scValToNative`, the
types map as follows. Fixtures and tests rely on this mapping being stable:

| Soroban / Rust type | Native JS type |
|---------------------|---------------|
| `Symbol` | `string` |
| `Address` | `string` (strkey — `G…` or `C…`) |
| `u32` | `number` |
| `i128` | `bigint` |
| `u64` | `bigint` |
| `bool` | `boolean` |
| `Vec<T>` | `T[]` (array) |
| struct (e.g. `CircleConfig`) | plain object with **snake_case** keys matching the Rust field names |
| `Symbol` enum variant | `string` matching the variant name |

The **snake_case → camelCase conversion is done by the SDK's `mapRaw*`
helpers**, not by `scValToNative`. Fixtures test the raw snake_case wire shape;
the `mapRaw*` tests in `contractFixtures.extended.test.ts` validate the
conversion.

---

## Updating fixtures after a contract change

### 1. Argument shape change (parameter added, removed, reordered, or retyped)

When a contract method's Rust signature changes, the corresponding test in
`contractFixtures.test.ts` will fail with a length or value mismatch.

**Steps:**

1. Open `sdk/src/__tests__/contractFixtures.test.ts`.
2. Find the `describe` block for the changed method.
3. Update the `encodeFixture([…])` call to match the new Rust signature,
   using the SDK encoder functions:
   - `scAddress(addr)` — for `Address` parameters
   - `scU32(n)` — for `u32` parameters
   - `scI128(n)` — for `i128` parameters
   - `scBool(b)` — for `bool` parameters
   - `scAddressVec([…])` — for `Vec<Address>` parameters
4. Update `expectedNativeArgs` in `assertFixture(…)` to match what
   `scValToNative` will produce for the new shape.
5. Update the SDK client method in `sdk/src/client.ts` that builds
   these arguments (`FactoryClient`, `CircleClient`, or `ReputationClient`).
6. Run `npm run test --workspace=sdk` and confirm all tests pass.
7. Note the breaking change in `CHANGELOG.md` under the next version.

### 2. Return-value shape change (struct field added, removed, or retyped)

When a contract's return struct changes (e.g. `CircleConfig` gains a field),
the `mapRaw*` function in `sdk/src/types.ts` must be updated, and the
corresponding test in `contractFixtures.extended.test.ts` will fail.

**Steps:**

1. Update the `RawCircleConfig` or `RawRoundState` interface in
   `sdk/src/types.ts` to match the new Rust struct.
2. Update `mapRawConfig` or `mapRawRoundState` to decode the new field.
3. Update `WIRE_CONFIG` or `WIRE_ROUND` in
   `sdk/src/__tests__/fixtures.ts` to include the new field.
4. Update the expectations in `contractFixtures.extended.test.ts`.
5. Run the tests and confirm passing.
6. Update `docs/API_INVARIANTS.md` section 9 to reflect the new field.

### 3. Protocol constant change (PENALTY_BPS, MAX_MEMBERS, etc.)

The `ProtocolParams` tests in `contractFixtures.extended.test.ts` pin the
values of every compile-time constant in the circle contract. If a constant
changes:

1. Update the expected values in the `ProtocolParams — expected constant values`
   describe block.
2. Update `docs/API_INVARIANTS.md` (sections 2 and 5) to reflect the new value.
3. Update any UI or SDK code that references the constant directly (search for
   `PENALTY_BPS`, `MAX_MEMBERS`, `MIN_ROUND_DEADLINE_LEDGERS`, etc.).

---

## Adding a fixture for a new contract method

1. Add a `describe` block in `contractFixtures.test.ts` with:
   - A comment containing the full Rust signature (copy from `lib.rs`).
   - One fixture for the typical case.
   - One fixture for each relevant boundary value (minimum, maximum, edge input).
   - An `it("fixture is deterministic")` test that re-encodes and compares.

2. If the method has a non-trivial return type, add a decode test in
   `contractFixtures.extended.test.ts` validating the wire shape.

3. Run `npm run test --workspace=sdk` — if the new method is already callable
   from the SDK client, the fixture must pass.

**Template:**

```typescript
/**
 * Rust signature: my_method(env, param_a: Address, param_b: u32) -> SomeResult
 */
describe("my_method", () => {
  const FIXTURE = encodeFixture([
    scAddress(SOME_ADDR),
    scU32(42),
  ]);

  it("encodes correctly", () => {
    assertFixture(FIXTURE, [SOME_ADDR, 42]);
  });

  it("fixture is deterministic", () => {
    expect(encodeFixture([scAddress(SOME_ADDR), scU32(42)])).toBe(FIXTURE);
  });
});
```

---

## Covered methods (current)

### CircleFactory

| Method | File |
|--------|------|
| `create_circle` | `contractFixtures.test.ts` |

### Circle

| Method | File |
|--------|------|
| `initialize` | `contractFixtures.test.ts` |
| `join` | `contractFixtures.test.ts` |
| `cancel` | `contractFixtures.test.ts` |
| `contribute` | `contractFixtures.test.ts` |
| `payout` | `contractFixtures.test.ts` |
| `settle_round` | `contractFixtures.test.ts` |
| `mark_default` | `contractFixtures.test.ts` |
| `close` | `contractFixtures.test.ts` |
| `pause` | `contractFixtures.test.ts` |
| `resume` | `contractFixtures.test.ts` |
| `get_config` | `contractFixtures.test.ts` |
| `get_status` | `contractFixtures.test.ts` |
| `get_current_round` | `contractFixtures.test.ts` |
| `get_collateral` | `contractFixtures.test.ts` |
| `get_defaults` | `contractFixtures.test.ts` |
| `has_contributed` | `contractFixtures.test.ts` |
| `get_protocol_params` | `contractFixtures.test.ts` |
| `get_pot_amount` | `contractFixtures.test.ts` |
| `get_admin` | `contractFixtures.test.ts` |
| `get_usdc_token` | `contractFixtures.test.ts` |
| `is_closed` | `contractFixtures.test.ts` |
| `is_paused` | `contractFixtures.test.ts` |
| `CircleConfig` return shape | `contractFixtures.extended.test.ts` |
| `RoundState` return shape | `contractFixtures.extended.test.ts` |
| `ProtocolParams` constant values | `contractFixtures.extended.test.ts` |

### Reputation

| Method | File |
|--------|------|
| `score` | `contractFixtures.test.ts` |
| `increment` | `contractFixtures.test.ts` |
| `add_authorized_caller` | `contractFixtures.test.ts` |
| `remove_authorized_caller` | `contractFixtures.test.ts` |
| `get_authorized_callers` | `contractFixtures.test.ts` |
| `get_revoked_callers` | `contractFixtures.test.ts` |
| `get_admin` | `contractFixtures.test.ts` |

---

## CI integration

The fixture tests run as part of `npm run test --workspace=sdk`. They are
included in the CI workflow at `.github/workflows/ci.yml` under the SDK test
step and will block merging if any fixture fails.

A fixture failure means **one of these things happened:**

1. A contract method signature changed without the SDK being updated.
2. A protocol constant changed without the fixture being updated.
3. A return struct field was renamed, added, or removed.
4. The SDK encoder (`scAddress`, `scU32`, etc.) changed its output format.

In every case the fix is to update both the SDK and the fixture together so
they agree, then commit and re-run CI.
