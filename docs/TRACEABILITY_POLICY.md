# CircleUp — Issue Traceability Policy

This document defines a lightweight convention for linking issues to the work
that closes them. It applies to pull requests, test names, migration
descriptions, and changelog entries across all five packages: `contracts`,
`sdk`, `indexer`, `app`, and `scripts`.

The goal is not to annotate every line of code with a tracker reference — it
is to make it easy to answer two questions after the fact:

1. **What work closed this issue?** — given an issue number, find the PR,
   the affected tests, and the CHANGELOG entry.
2. **Why does this code exist?** — given a PR or a test, trace it back to the
   issue that motivated it and the acceptance criteria that defined "done".

---

## Table of Contents

- [Where issue references belong](#where-issue-references-belong)
  - [Pull requests](#pull-requests)
  - [CHANGELOG entries](#changelog-entries)
  - [Test names](#test-names)
  - [Migration descriptions](#migration-descriptions)
  - [Source code comments](#source-code-comments)
- [Where issue references do NOT belong](#where-issue-references-do-not-belong)
- [Acceptance criteria and observable outcomes](#acceptance-criteria-and-observable-outcomes)
- [Cross-package changes](#cross-package-changes)
- [Reference format](#reference-format)
- [Quick decision guide](#quick-decision-guide)

---

## Where issue references belong

### Pull requests

Every PR must reference at least one issue using the GitHub closing keyword in
the PR description so the issue is automatically closed on merge:

```
Closes #477
```

For a PR that partially addresses an issue without closing it:

```
Addresses #477 (address validation — form layer only; contract layer in #501)
```

Use the **Related Issue** field in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`).
Do not embed the issue number only in the commit message body — it will be lost
after a squash merge unless the PR description also carries it.

**Multi-package PRs:** when a single issue spans contracts, SDK, indexer, and
app, one PR per package is preferred so each can be reviewed independently.
Each PR links back to the same issue. The first PR to land adds the CHANGELOG
entry; subsequent PRs reference it with "Part of #NNN — see [PR #X] for
changelog entry."

### CHANGELOG entries

Every user-visible change in `CHANGELOG.md` must carry the issue number that
motivated it. Format:

```markdown
### Added
- **Issue 477**: Address validation for every member entry on the create flow …
```

The issue number appears at the start of the bullet, in bold, so the file is
`grep`-able:

```bash
# Find all CHANGELOG entries for issue 477
Select-String -Path CHANGELOG.md -Pattern "Issue 477"
```

A CHANGELOG entry without an issue number is acceptable only for:
- Internal refactors with no user-visible effect (use `chore` commit type and
  omit from CHANGELOG entirely, or add without an issue reference).
- Documentation-only changes that do not correspond to a tracked issue.

In both cases, note the absence explicitly:

```markdown
- Homepage hero copy rewritten around what the visitor does and gets
  *(no issue — copywriting only)*
```

### Test names

Issue references in test names are useful when the test encodes a
**non-obvious invariant** that would be puzzling without context, or when the
test was written specifically to verify an acceptance criterion that is not
self-evident from the code.

**Include the issue number in the test name when:**
- The test covers a bug fix and the bug had a specific, non-obvious trigger.
- The test verifies an acceptance criterion word-for-word (especially for
  financial guards and security invariants).
- The test is the primary evidence that a requirement was met.

```typescript
// Good — the issue number explains why this non-obvious edge case is tested
it("issue-477: rejects a 56-char base32 string that fails CRC16 checksum", () => { ... });

// Good — the guard exists because of a specific reported exploit path
it("issue-28: duplicate event delivery is a silent no-op (ON CONFLICT DO NOTHING)", () => { ... });
```

**Omit the issue number when:**
- The test name is already descriptive enough to stand alone.
- Adding the issue number would make the name redundant or harder to read.
- The test covers general behaviour, not a specific bug or acceptance criterion.

```typescript
// Fine without an issue number — the name is self-contained
it("rejects a contribution submitted after the round deadline", () => { ... });
it("score is monotonically non-decreasing across multiple increments", () => { ... });
```

The rule of thumb: if a future contributor would ask "why does this test exist?"
without the issue number, add it. If the test name already answers that
question, leave it out.

**Rust test names** follow the same rule:

```rust
// Good — guards a specific reported double-spend path
#[test]
fn guard_join_double_collateral_pull() { ... }

// Fine — the invariant is obvious from the name
#[test]
fn prop_contribution_total_equals_round_amount_times_member_count() { ... }
```

### Migration descriptions

Every migration file must include a header comment that explains:
1. What schema change it makes.
2. Why the change was needed (link to the issue or describe the motivation
   in one sentence).
3. Any invariants or constraints the migration enforces.

```sql
-- Migration 003: canonical event identity and idempotency constraints
--
-- Issue 28: At-least-once polling makes duplicate delivery normal. This migration
-- adds network context and stronger uniqueness constraints to enforce idempotency
-- at the database layer rather than relying on process memory.
--
-- Event identity is defined by: ledger, tx_hash, event_index
```

The issue reference in the migration comment is the link between the schema
change and the requirement it satisfies. This matters because migrations are
permanent — a reviewer reading the file three years later needs to understand
why it exists without access to the original PR.

When the migration addresses no specific issue (pure housekeeping), note that:

```sql
-- Migration 005: add rate-limit env var validation
-- No associated issue — follow-up cleanup from the API rate-limit refactor.
```

### Source code comments

**Do not** routinely annotate source code with issue numbers. The codebase
should read as documentation of what the system does, not as a changelog of
when things changed.

The one exception is a `// TODO(#NNN):` or `// FIXME(#NNN):` comment marking
known incomplete work with a live issue:

```typescript
// TODO(#512): remove this workaround once the RPC supports streaming events
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
```

```rust
// TODO(#389): replace hard-coded PENALTY_BPS with a per-circle configurable rate
const PENALTY_BPS: i128 = 2000;
```

These are acceptable because they point to open issues. Closed-issue
annotations (`// Fixed by #NNN`) add noise without value — the git log and
CHANGELOG already record that.

---

## Where issue references do NOT belong

- **Commit messages** (beyond `Closes #NNN` in the footer) — commit messages
  should describe what changed, not link to a tracker. The PR description is
  the place for context.
- **Variable and function names** — never name something `fixIssue477` or
  `issue28Handler`. Name things after what they do.
- **Inline code comments on unchanged lines** — do not add `// Issue 28`
  annotations to existing code just to document its history.
- **Test `describe` block names** when the issue number belongs in the `it`
  name instead.

---

## Acceptance criteria and observable outcomes

Every issue that produces a PR must have acceptance criteria that map to at
least one of:

- A **named test** (unit, integration, or incident reproduction) that passes
  when the criterion is met.
- A **documented operator outcome** (a runbook step, a health-check result, an
  API response shape) that can be verified without running tests.
- A **CHANGELOG entry** that describes the observable change for integrators.

When writing a PR description, state explicitly how each acceptance criterion
maps to evidence:

```
Acceptance criterion: "Integrators have a documented path to learn about breaking changes"
Evidence: docs/DEPRECATION_POLICY.md — "Integrators" section; CHANGELOG `### Deprecated` block format defined

Acceptance criterion: "Public interfaces are not removed silently"
Evidence: DEPRECATION_POLICY.md notice-period table; test obligation per lifecycle phase defined
```

If an acceptance criterion cannot be mapped to an observable test or documented
outcome, it is not "done" — it is aspirational. Flag this in the PR description
and open a follow-up issue.

---

## Cross-package changes

CircleUp spans five packages. A change that touches more than one package
requires issue traceability at each layer. Use this checklist when the issue
scope crosses packages:

- [ ] The PR description lists every package touched and the change in each.
- [ ] The CHANGELOG entry mentions all affected packages inline:
  ```markdown
  - **Issue 28**: Canonical event identity (`indexer`, `sdk`)
  ```
- [ ] If tests were added in multiple packages, each test name or describe
  block makes the scope clear:
  ```
  "issue-28 [indexer]: duplicate event delivery is a silent no-op"
  "issue-28 [sdk]: contract fixture XDR remains stable across releases"
  ```
- [ ] Migration files reference the issue in their header comment.
- [ ] The Definition of Done in CONTRIBUTING.md is satisfied for every scope
  touched (Scope A through G as applicable).

The PR template's **Changes Made** field should enumerate the packages:

```
- `indexer`: migration 003, event_index column, unique index on (ledger, tx_hash, event_index)
- `sdk`: contractFixtures.test.ts — 22 new XDR fixture tests
- `app`: no changes
```

---

## Reference format

Use `#NNN` (hash + number) for issue references everywhere. This is the
format GitHub renders as a link automatically in PR descriptions, commit
messages, and CHANGELOG files viewed on github.com.

In plain-text contexts (SQL migration comments, Rust source `// TODO`):
use `Issue NNN` or `#NNN` — both are searchable.

```bash
# Find all references to issue 477 across the entire repo
Select-String -Recurse -Path . -Pattern "(#477|Issue 477)" -Include "*.ts","*.rs","*.sql","*.md"
```

---

## Quick decision guide

| Situation | Action |
|---|---|
| Opening a PR that closes an issue | Add `Closes #NNN` to the PR description **Related Issue** field |
| Adding to CHANGELOG | Start the bullet with `**Issue NNN**:` |
| Writing a test for a specific bug fix | Include `issue-NNN:` in the `it()` or test function name |
| Writing a test for general behaviour | No issue number needed |
| Writing a migration | Include `Issue NNN` in the header comment |
| Marking incomplete work in source | `// TODO(#NNN):` comment pointing to an open issue |
| Annotating already-shipped code | Do not add issue numbers retroactively |
| A PR touches contracts + indexer + app | One CHANGELOG entry per issue, listing all affected packages |
| Acceptance criterion has no test | Note the gap in the PR description; open a follow-up issue |
