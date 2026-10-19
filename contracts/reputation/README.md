# Reputation Contract

The reputation contract tracks per-address reputation scores for CircleUp members.
Scores are incremented as members complete lifecycle milestones (joining a circle,
completing a cycle, etc.) and are read by the app and indexer to surface member
standing.

## Authorization invariant

`increment` is a privileged state transition: it mutates a member's on-chain
reputation and therefore MUST only be invoked by an authorized caller.

- The contract stores an `admin` address at initialization time.
- Only the stored `admin` may call `increment`. Any other caller is rejected.
- Unauthorized calls MUST fail loudly with a typed contract error
  (`Error::Unauthorized`) rather than silently no-op'ing, so that callers and the
  indexer can observe and surface the failure instead of recording a misleading
  success.
- Authorized calls preserve the existing behavior: the target member's score is
  incremented by the supplied amount and the updated score is persisted.

This invariant exists because reputation is user-visible and drives product
behavior; allowing arbitrary callers to increment scores would let anyone inflate
member standing and corrupt the state the app and indexer rely on.

## Interface

### `initialize(admin: Address)`

Stores the `admin` address that is authorized to increment reputation. Must be
called once before any increment.

### `increment(caller: Address, member: Address, amount: u32)`

Increments `member`'s reputation by `amount`.

- Requires `caller` to be the stored `admin`; otherwise returns
  `Error::Unauthorized`.
- Requires `caller` authorization (signature) via `caller.require_auth()`.
- On success, persists the updated score for `member`.

### `get(member: Address) -> u32`

Returns the current reputation score for `member` (0 if never incremented).

## Errors

| Error | Meaning |
| --- | --- |
| `Unauthorized` | The caller is not the stored `admin` and may not increment reputation. |
| `NotInitialized` | `increment` was called before `initialize`. |

## Testing

Authorization is covered by tests that assert:

- the authorized `admin` can increment and the score is persisted, and
- an unauthorized caller is rejected with `Error::Unauthorized` and the score is
  left unchanged.
