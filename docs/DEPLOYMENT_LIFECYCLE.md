# CircleUp — Deployment Lifecycle

This document defines how deployments move from active to superseded, what
metadata must be preserved, and how to prevent accidental use of stale contract
addresses. It applies to every network (testnet, staging, mainnet) and covers
the full set of deployment artifacts: manifests, profiles, env files, and
on-chain transactions.

The core commitment is that **superseded deployments are never silently
discarded**. Immutable on-chain contracts cannot be deleted; this document
defines how to make their status unambiguous.

For the deployment procedure itself (order, commands, env setup) see
[docs/RUNBOOK.md — Deployment](./RUNBOOK.md#deployment).  
For the manifest schema see
[scripts/src/deployment-manifest.ts](../scripts/src/deployment-manifest.ts).

---

## Table of Contents

- [Deployment artifacts overview](#deployment-artifacts-overview)
- [Deployment states](#deployment-states)
- [Active deployment](#active-deployment)
- [Marking a deployment superseded](#marking-a-deployment-superseded)
  - [Step 1 — Write a superseded manifest](#step-1--write-a-superseded-manifest)
  - [Step 2 — Update the active manifest](#step-2--update-the-active-manifest)
  - [Step 3 — Update profiles and env files](#step-3--update-profiles-and-env-files)
  - [Step 4 — Update the runbook](#step-4--update-the-runbook)
  - [Step 5 — Record in CHANGELOG.md](#step-5--record-in-changelogmd)
- [Manifest file naming and location](#manifest-file-naming-and-location)
- [What to retain and why](#what-to-retain-and-why)
- [Preventing accidental use of stale addresses](#preventing-accidental-use-of-stale-addresses)
  - [Profile rules enforced by validate-env.ts](#profile-rules-enforced-by-validate-envts)
  - [Manifest network guard](#manifest-network-guard)
  - [CI guard for active manifest](#ci-guard-for-active-manifest)
  - [Runtime identity verification (SDK)](#runtime-identity-verification-sdk)
- [Deployment history log](#deployment-history-log)
- [Special cases](#special-cases)
  - [Testnet resets](#testnet-resets)
  - [Emergency redeployment](#emergency-redeployment)
  - [Factory address change](#factory-address-change)

---

## Deployment artifacts overview

A complete CircleUp deployment produces the following artifacts:

| Artifact | Location | Mutable? | Notes |
|---|---|---|---|
| Deployed manifest (JSON) | `scripts/deployed-manifest.json` (active) | Yes — replaced on redeploy | Machine-readable record of all contract IDs, WASM hashes, tx hashes, network, and build info |
| Superseded manifests (JSON) | `scripts/archive/deployed-manifest-<ISO8601>.json` | No — append-only | Frozen copy of every manifest that was ever active |
| Deployment profile (env) | `profiles/testnet.env`, `profiles/staging.env`, `profiles/production.env` | Yes — updated on redeploy | Human-readable env var defaults for each network |
| Indexer env file | `indexer/.env` (gitignored) | Yes | Operator-managed; must match the active manifest's contract addresses |
| App env file | `app/.env.local` (gitignored) | Yes | Same requirement |
| On-chain contracts | Stellar network ledger | **Immutable** | Cannot be deleted; can only be marked superseded in off-chain records |
| WASM hash file | `contracts/expected-hashes.json` | Yes — updated on rebuild | SHA-256 of each compiled WASM; verified by reproducibility CI |

---

## Deployment states

Every deployment is in one of two states:

| State | Meaning |
|---|---|
| **Active** | The contract addresses currently in use by the indexer, app, and any integrators pointed at this network. There is exactly one active deployment per network at any time. |
| **Superseded** | A previous deployment on the same network. The contracts exist on-chain permanently but should not be used for new interactions. A superseded deployment has a corresponding archived manifest. |

There is no "deleted" state. Immutable on-chain contracts cannot be removed;
marking a deployment superseded is how CircleUp signals that its addresses are
no longer the canonical ones.

---

## Active deployment

The active deployment for a network is identified by:

1. **`scripts/deployed-manifest.json`** — the current manifest file at that
   path. Its `network` field identifies which network it belongs to.
2. **`profiles/<network>.env`** — the profile env file with non-empty contract
   address variables.

When both exist and agree (same contract IDs), the deployment is unambiguously
active. When they disagree, the manifest takes precedence — the profile may
lag by one edit.

---

## Marking a deployment superseded

Perform these steps in order whenever contracts are redeployed to a network
where contracts were previously deployed.

### Step 1 — Write a superseded manifest

Before overwriting `scripts/deployed-manifest.json` with the new deployment's
manifest, archive the current one:

```bash
# Capture the current timestamp in ISO 8601 format (no colons for filename safety)
$timestamp = (Get-Date -Format "yyyyMMddTHHmmssZ")
$dest = "scripts/archive/deployed-manifest-$timestamp.json"

# Create the archive directory if it does not exist
New-Item -ItemType Directory -Force -Path scripts/archive | Out-Null

# Copy — do NOT move; the active manifest stays until the new one is written
Copy-Item scripts/deployed-manifest.json $dest
```

Add a `supersededAt` and `supersededBy` field to the archived copy to make its
status self-describing:

```json
{
  "manifestVersion": "1",
  "network": "testnet",
  ...
  "supersededAt": "2026-10-16T14:30:00Z",
  "supersededBy": "deployed-manifest-20261016T143100Z.json"
}
```

These two fields are not part of the `DeploymentManifest` interface validated
by `validateManifest()` — they are metadata added only to archived copies.
`validateManifest()` ignores unknown fields, so the archived copy remains
parseable.

### Step 2 — Update the active manifest

Run the deploy script to produce the new manifest:

```bash
npm run deploy:testnet --workspace=scripts
# Writes scripts/deployed-manifest.json with new contract IDs
```

Verify the new manifest is valid before proceeding:

```bash
npx ts-node scripts/src/deployment-manifest.ts scripts/deployed-manifest.json testnet
# Must print: ✅ Manifest is valid.
```

### Step 3 — Update profiles and env files

Update `profiles/<network>.env` with the new contract addresses:

```bash
# profiles/testnet.env — fill in the addresses from the new manifest
CIRCLE_FACTORY_ADDRESS=C<new_factory_address>
REPUTATION_ADDRESS=C<new_reputation_address>
USDC_ADDRESS=C<usdc_address>
```

Communicate the new addresses to operators who maintain `indexer/.env` and
`app/.env.local`. Those files are gitignored and operator-managed; the profile
is the canonical committed reference.

### Step 4 — Update the runbook

If the redeployment changes any operational procedure (new deployment ledger
for `START_LEDGER`, a different USDC address, changed RPC URL), update the
relevant section of [docs/RUNBOOK.md](./RUNBOOK.md).

If the previous deployment had an associated incident or known issue, link to
it from the runbook's troubleshooting section.

### Step 5 — Record in CHANGELOG.md

Add a `### Deployment` entry under `[Unreleased]` in `CHANGELOG.md`:

```markdown
### Deployment
- **Testnet redeployment** (2026-10-16): superseded `C<old_factory>` / `C<old_reputation>`.
  New addresses: factory `C<new_factory>`, reputation `C<new_reputation>`.
  Archive: `scripts/archive/deployed-manifest-20261016T143000Z.json`.
  Reason: contract upgrade for Issue #NNN.
```

This entry is the human-readable audit trail that links a redeployment to the
issue or release that caused it.

---

## Manifest file naming and location

| File | Purpose |
|---|---|
| `scripts/deployed-manifest.json` | Active manifest for the most recent deployment. Replaced on every redeploy. |
| `scripts/archive/deployed-manifest-<YYYYMMDDTHHMMSSZ>.json` | Archived (superseded) manifest. Never modified after archiving. |

The `scripts/archive/` directory is committed to git. Every archived manifest
is a permanent, auditable record of a past deployment.

**Naming convention:** `deployed-manifest-<ISO8601compact>Z.json` where the
timestamp is the moment the archive copy was written, not the deployment time
(use the manifest's `deployedAt` field for the actual deployment time).

---

## What to retain and why

| Artifact | Retention requirement | Reason |
|---|---|---|
| Archived manifests (`scripts/archive/`) | **Permanent** | Contains WASM hash, deploy tx hash, deployer public key, git commit, and network passphrase. Needed to verify reproducibility claims and trace any on-chain contract to its source build. |
| `deployTxHash` per contract | **Permanent** (in manifest) | The transaction hash proves the deployment happened and when. It is the chain of custody from source code to on-chain contract. |
| `wasmHash` per contract | **Permanent** (in manifest) | Links the on-chain WASM to the build artifact verified by `contracts/expected-hashes.json` and the reproducibility CI. |
| `integrityHash` | **Permanent** (in manifest) | SHA-256 over core manifest fields; detects post-archive tampering. |
| `gitCommit` in manifest | Permanent when available | Links the deployment to the exact source commit. The deploy script populates this automatically when run inside a git repository. |
| Incident notes and post-mortems | **Permanent** | If a superseded deployment was retired due to a bug or incident, the post-mortem or issue link belongs in the CHANGELOG entry and optionally in the runbook. |
| Operator `.env` files | Do **not** commit to git | These contain network-specific values and may reference secrets; the profile files serve as the committed reference. |

**What you must not do:**

- Delete or modify an archived manifest — it is a historical record.
- Remove a `deployTxHash` or `wasmHash` from an archived manifest.
- Claim that a superseded on-chain contract was "deleted" — on Stellar, contracts
  are immutable ledger entries and cannot be removed.

---

## Preventing accidental use of stale addresses

### Profile rules enforced by validate-env.ts

`scripts/src/validate-env.ts` reads the active profile and enforces rules that
prevent stale addresses from reaching a deployment:

| Profile | Rule |
|---|---|
| `testnet` | Empty contract addresses produce a warning but not a failure — useful for fresh deploys |
| `staging` | All contract addresses must be non-empty; `NETWORK_PASSPHRASE` must not be the public testnet passphrase |
| `production` | All contract addresses required; `STELLAR_RPC_URL` must not reference a testnet hostname; passphrase must be exactly the mainnet string |

Run before any deployment:

```bash
npx ts-node scripts/src/validate-env.ts --profile testnet
# or
CIRCLEUP_PROFILE=production npx ts-node scripts/src/validate-env.ts
```

### Manifest network guard

`validateManifest()` rejects a manifest whose `network` field does not match
the caller's expected network. Use this guard in deployment scripts and CI jobs
that consume a manifest:

```typescript
import { validateManifest } from "./deployment-manifest";

const result = validateManifest("scripts/deployed-manifest.json", "testnet");
if (!result.ok) {
  console.error(result.errors);
  process.exit(1);
}
// result.manifest is now type-safe and verified
const { circleFactory, reputation } = result.manifest.contracts;
```

This guard prevents a testnet manifest from being used against a mainnet
deployment and vice-versa.

### CI guard for active manifest

Add a validation step to any CI job that reads contract addresses from the
manifest:

```yaml
- name: Validate deployment manifest
  run: npx ts-node scripts/src/deployment-manifest.ts scripts/deployed-manifest.json ${{ env.NETWORK }}
```

The script exits non-zero on any validation failure, blocking the job before
stale or tampered addresses can propagate.

### Runtime identity verification (SDK)

The checks above prove addresses are well-formed and belong to the right
manifest; they cannot prove the addresses are CircleUp contracts on the RPC's
network. The SDK's opt-in `verifyDeployment()` does that with read-only RPC
calls — no signing, no submission — and never runs during client
construction:

```ts
const client = new CircleUpClient(config); // offline
const result = await client.verifyDeployment({
  timeoutMs: 10_000,                                 // per RPC call
  expectedCircleWasmHash: manifest.contracts.circlWasmHash, // optional
});
if (!result.ok) disableWrites(result.checks);
```

| Check | Evidence |
|-------|----------|
| `network` | RPC `getNetwork().passphrase` equals `config.networkPassphrase` |
| `factory.usdc` | factory `get_usdc_token()` equals `contracts.usdc` |
| `factory.reputation` | factory `get_reputation_contract()` equals `contracts.reputation` |
| `factory.circleWasmHash` | factory `get_circle_wasm_hash()` (compared when an expected hash is given) |
| `reputation` | reputation `get_admin()` returns an address |
| `usdc` | token `decimals()` equals 7 |

Each check reports `ok`, `mismatch`, `missing` (no contract at that address on
this network), `incompatible` (unexpected method or return type),
`unreachable` (RPC error or timeout), or `skipped` (contract reads are skipped
when the network check fails). Applications should keep write actions
disabled until `result.ok` is `true`.

---

## Deployment history log

The deployment history is maintained across three places:

| Location | Granularity | Use |
|---|---|---|
| `scripts/archive/` | Per-deployment | Machine-readable; full manifest detail |
| `CHANGELOG.md` `### Deployment` entries | Per-release | Human-readable; links to issues and reasons |
| `docs/RUNBOOK.md` contract addresses section | Per-network | Operational quick-reference for the current active deployment |

When the three sources disagree, the archived manifest is the authoritative
record of what was actually deployed and when.

---

## Special cases

### Testnet resets

Stellar testnet is periodically reset by the SDF, wiping all ledger state
including deployed contracts. After a testnet reset:

1. All previous testnet deployments are effectively unreachable (the ledger
   no longer exists), but their archived manifests remain valid historical records.
2. Add a note to the archived manifest:

   ```json
   "supersededAt": "2026-10-16T00:00:00Z",
   "supersededBy": "testnet-reset",
   "supersededReason": "Stellar testnet reset — ledger history no longer accessible"
   ```

3. Run a fresh testnet deployment following the standard procedure.
4. Update `profiles/testnet.env` with the new addresses.
5. Record the reset in `CHANGELOG.md`.

Previous testnet manifests are kept even after a reset — they prove what was
deployed on the old network state and provide reference for any bugs or issues
that were reproduced there.

### Emergency redeployment

If a security vulnerability requires immediate redeployment without following
the normal notice period:

1. Follow Steps 1–5 of [Marking a deployment superseded](#marking-a-deployment-superseded)
   as quickly as possible.
2. In the archived manifest, set `supersededReason` to a brief description of
   the issue (avoid disclosing exploit details before coordinated disclosure).
3. Add a `### Security` entry in `CHANGELOG.md` referencing the new addresses
   and the disclosure timeline.
4. Notify integrators via the coordinated disclosure process in `SECURITY.md`.

### Factory address change

The factory address is the root of trust for all circle contracts — it is the
admin of the reputation contract and the deployer of all circle instances. If
the factory must be redeployed:

1. Document which circle contracts were deployed by the old factory (they are
   in `circles` table as rows with `creator` addresses that trace back to the
   old factory).
2. The old factory's authorized circles on the reputation contract retain their
   authorization until explicitly revoked by the new admin. Decide whether to
   revoke or preserve old circle authorization before redeploying.
3. Record the decision and the list of affected circle addresses in the
   CHANGELOG entry and the archived manifest's `supersededReason`.
4. Update the indexer's `CIRCLE_FACTORY_ADDRESS` env var to the new address.
   The indexer will begin tracking circles created by the new factory; circles
   created by the old factory remain in the database and their historical data
   is preserved.

---

## Contract Artifact Verification, Provenance, and Review Requirements

The compiled Soroban WASM artifacts deployed on-chain (`reputation.wasm`,
`circle_factory.wasm`, `circle.wasm`) represent the definitive executable
contracts of CircleUp. Differences in compiler version, target flags, or
optimization profiles can produce binaries that diverge from audited source.

To prevent silent supply-chain drift, unexpected compiler differences, and
unauthorized bytecode deployment, CircleUp implements a strict cryptographic
provenance and reproducibility pipeline.

### 1. Key Components

| Component | File Path | Function |
|---|---|---|
| **Pinned Toolchain** | `contracts/rust-toolchain.toml` | Pinned Rust compiler channel (e.g. `1.81.0`) and `wasm32-unknown-unknown` target. |
| **Expected Hashes** | `contracts/expected-hashes.json` | Committed SHA-256 hashes of the release WASMs built from the repository source. |
| **Build Provenance** | `contracts/provenance.json` | Machine-readable metadata capturing Git commit SHA, branch, dirty flag, toolchain, compiler version (`rustc`, `cargo`), artifact sizes, and hashes. |
| **Verification Tooling** | `scripts/src/check-artifact-hashes.ts` | CLI utility to verify hashes, generate provenance, and update expected hashes. |
| **Reproducibility CI** | `.github/workflows/reproducibility.yml` | Two-pass clean build workflow that asserts byte-for-byte determinism, verifies against `expected-hashes.json`, and uploads provenance metadata. |

### 2. The Verification Workflow

On every push and pull request touching `contracts/**`:

1. CI initializes the pinned Rust toolchain from `contracts/rust-toolchain.toml`.
2. First-pass build compiles all contracts in release mode (`--release --target wasm32-unknown-unknown`).
3. `scripts/src/check-artifact-hashes.ts --provenance` generates full provenance metadata.
4. `scripts/src/check-artifact-hashes.ts` validates that every artifact SHA-256 matches `contracts/expected-hashes.json`. If any hash differs or is unpopulated, CI fails immediately.
5. A second build is performed from a clean cache (`cargo clean`) to prove byte-for-byte determinism across builds.
6. Provenance metadata (`contracts/provenance.json`) and release binaries are published as GitHub Actions artifacts for auditability.

### 3. Review Procedure for Intentional Hash Changes

When contract source code is changed, dependencies are updated, or the Rust
toolchain is upgraded:

1. **Local Build & Hash Update**:
   - Build with the pinned toolchain:
     ```bash
     cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/Cargo.toml
     ```
   - Re-generate `expected-hashes.json` and `provenance.json`:
     ```bash
     npm run hash-artifacts --workspace=scripts
     ```
2. **Pull Request Inclusion**:
   - The updated `contracts/expected-hashes.json` (and `contracts/rust-toolchain.toml` if the toolchain was modified) **must be committed in the same PR** as the source code changes.
   - Standalone PRs that update `expected-hashes.json` without corresponding source or toolchain changes are strictly rejected.
3. **Mandatory Review Criteria**:
   - Reviewers must trace every hash change back to the concrete contract diffs in the PR.
   - At least two maintainers must approve the PR before merging.
   - The GitHub Actions `reproducibility` workflow must pass with green checks on both build passes.
4. **Release Provenance Verification**:
   - Prior to deploying contracts to testnet or mainnet, the release engineer must verify that the Git commit SHA recorded in the CI build provenance artifact matches the release git tag.
