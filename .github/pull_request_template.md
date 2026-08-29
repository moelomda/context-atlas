## Problem

<!-- What user or contributor problem does this change address? Link an issue when one exists. -->

## Result

<!-- Describe the observable behavior after this change. Keep implementation detail below. -->

## Implementation notes

<!-- Explain non-obvious decisions, compatibility constraints, and rejected alternatives. -->

## Verification

<!-- List exact commands, tests, fixtures, and manual checks. Do not write only "tests pass". -->

- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run check`
- [ ] `npm audit --audit-level=high`
- [ ] `npm pack --dry-run`
- [ ] New or changed behavior has regression coverage
- [ ] Windows, Linux, and macOS implications were considered

## Trust and safety review

<!-- Explain material impacts; use "No change" only after checking the boundary. -->

- Evidence and authority:
- Freshness and history:
- Privacy, secrets, and network egress:
- Human review and MCP permissions:
- Output limits and disclosed omissions:
- Storage, migration, and rollback:

## User experience

<!-- For UI changes, attach screenshots/recordings and describe keyboard, small-screen, reduced-motion, loading, empty, and error checks. Remove this note only when the change has no visible UI. -->

## Documentation and release notes

- [ ] User-visible changes are recorded under `Unreleased` in `CHANGELOG.md`
- [ ] Commands, examples, and maturity claims are accurate
- [ ] `docs/IMPLEMENTATION_STATUS.md` is updated if verification scope changed
- [ ] No planned capability is presented as shipped

## Final contributor checklist

- [ ] This pull request is focused and contains no unrelated generated output
- [ ] No credentials, private source, local database, backup, export, log, or personal data is included
- [ ] I did not weaken or remove a failing test just to make CI pass
- [ ] Breaking changes and migrations are called out explicitly
- [ ] I have read `CONTRIBUTING.md` and agree to `CODE_OF_CONDUCT.md`
