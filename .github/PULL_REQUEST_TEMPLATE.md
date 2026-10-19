## Summary

<!-- What does this PR do? One or two sentences. -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code cleanup
- [ ] Documentation update
- [ ] CI / tooling change
- [ ] Contract change (requires extra review)
- [ ] Removes or renames a public interface (REST field, SDK export, contract event, or error message — see [Deprecation Policy](../docs/DEPRECATION_POLICY.md))

## Related Issue

Closes #<!-- issue number -->

## Changes Made

<!-- List the key changes by package. Be specific about contract, SDK, indexer, or app. -->

- 
- 
- 

## Traceability

<!-- How do the acceptance criteria for the linked issue map to observable evidence? -->
<!-- For each criterion, name the test, the documented outcome, or the CHANGELOG entry that satisfies it. -->
<!-- If a criterion has no test yet, note the gap and open a follow-up issue. -->
<!-- See docs/TRACEABILITY_POLICY.md for the full convention. -->

| Acceptance criterion | Evidence (test name / doc section / CHANGELOG entry) |
|---|---|
|  |  |

## Testing

<!-- How did you test this? What scenarios did you cover? -->

- [ ] Ran `cargo test` in `contracts/`
- [ ] Ran `npx tsc --noEmit` in `indexer/` and `scripts/`
- [ ] Ran `npm run build --workspace=app`
- [ ] Ran `npm run lint --workspace=app`
- [ ] Tested manually on testnet (if contract change)

## Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have updated `CHANGELOG.md` under `[Unreleased]` with `**Issue NNN**:` prefix on new bullets
- [ ] I have added or updated relevant documentation
- [ ] I have not committed `.env` files or secrets
- [ ] CI passes on this branch
- [ ] If this PR removes or renames a public interface, I have followed the [Deprecation Policy](../docs/DEPRECATION_POLICY.md) notice procedure
- [ ] If this PR redeploys contracts, I have followed the [Deployment Lifecycle](../docs/DEPLOYMENT_LIFECYCLE.md) to archive the superseded manifest

## Screenshots (if applicable)

<!-- Add screenshots for UI changes -->
