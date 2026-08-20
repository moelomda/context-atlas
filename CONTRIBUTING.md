# Contributing to Context Atlas

Thanks for helping make project memory more trustworthy. Context Atlas is an
early local-first tool, and contributions are most useful when they preserve its
evidence, uncertainty, privacy, and recoverability guarantees.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. For
security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public
issue.

## Before you start

- Search existing issues before filing a new one.
- Use a feature request for product discussion before investing in a large
  change.
- Keep pull requests focused. A small change with convincing evidence is easier
  to review than a broad rewrite.
- Do not include repository contents, credentials, customer data, or a real
  `.context-atlas/atlas.db` in an issue or test fixture.

Maintainers may close proposals that undermine the product's trust boundaries,
including silently accepting generated claims as fact, exposing non-loopback
HTTP access without authentication, or sending repository data to a remote
service without explicit consent and an egress review.

## Development setup

Requirements:

- Git
- Node.js 24 or newer
- npm (the version bundled with Node.js is sufficient)

Install and verify the project:

```sh
npm ci
npm run check
```

`npm run check` compiles the TypeScript project and runs the automated suite.
The implementation currently uses Node's built-in SQLite API, which Node 24
labels experimental. Warnings from that API are expected in this alpha; crashes,
data loss, or cross-platform differences are not.

For local CLI work:

```sh
npm run build
node dist/cli.js help
```

Use a disposable Git repository for manual tests. Context Atlas writes local
state to `<repository>/.context-atlas/`.

## Choosing an issue

Good first contributions are narrow, testable improvements to documentation,
accessibility, fixture coverage, error messages, and platform compatibility.

For implementation work, comment on the issue with:

1. the behavior you intend to change;
2. the evidence or test that will prove it;
3. any compatibility, privacy, or migration implications.

An issue comment does not reserve work indefinitely. It helps contributors
avoid duplicating effort and gives maintainers a chance to surface design
constraints.

## Product invariants

Every change must preserve these rules:

1. **Evidence before authority.** Generated or inferred narratives remain
   proposals until a human explicitly reviews them.
2. **Uncertainty stays visible.** Confidence, freshness, conflicting evidence,
   and truncation must survive every output boundary.
3. **Local by default.** Repository data does not leave the machine without an
   explicit, reviewable feature and user action.
4. **Secrets are not context.** Never store raw diffs or known sensitive files.
   New ingestion paths need redaction and seeded-secret tests.
5. **History fails closed.** Integrity failures must be reported; they must not
   be silently repaired or presented as healthy.
6. **Agent tools are read-only.** MCP cannot synchronize, create proposals,
   decide reviews, persist/refresh packs, or apply retention. Proposal approval
   and rejection require an explicit human action through the CLI or protected
   loopback dashboard; the remaining mutations are human-operated CLI flows.
7. **Output is bounded.** Maps, searches, timelines, and context packs must
   disclose limits and omissions.

The architectural rationale and remaining limitations are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md), and
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

## Testing expectations

Run the full gate before submitting:

```sh
npm run check
npm audit --audit-level=high
npm pack --dry-run
```

Add or update tests for behavior changes. A strong test:

- uses a disposable fixture rather than developer-owned data;
- proves the public behavior, not a private implementation detail;
- includes the relevant failure path;
- seeds synthetic secret-like content when an output boundary changes;
- checks stale, truncated, or conflicting states when relevant; and
- is deterministic on Windows, Linux, and macOS.

Changes involving storage, the ledger, backup/restore, or migrations should
also prove rollback or recovery behavior. UI changes should include keyboard,
small-screen, reduced-motion, empty, loading, and error-state checks.

Pack-lifecycle changes must preserve immutable snapshot verification, evidence
closure, repository/policy stability, the 256-item refusal boundary, and the
ignored `.context-atlas/packs/` storage scope. Retention changes must use only
disposable fixtures and prove fresh-plan confirmation, protected canonical/audit
state, unsafe-path refusal, and truthful completed/partial tombstones.

The current suite is intentionally modest. Passing it is necessary, but it is
not evidence of large-repository scale, WCAG conformance, penetration testing,
or production-GA reliability.

## Pull requests

Use the pull request template and include:

- a concise problem statement;
- the user-visible result;
- the tests and manual checks run;
- screenshots or a short recording for visible UI changes;
- privacy, security, compatibility, and migration notes; and
- documentation or changelog updates when behavior changes.

Keep generated build output (`dist/`), coverage files, local databases, exports,
backups, saved packs, and credentials out of commits. Do not weaken a failing
test merely to make CI green.

Pull requests from forks receive a read-only token and must not require secrets.
Maintainers will decide when a change is ready to merge and may request a
smaller scope or an architecture note for durable decisions.

## Documentation

Use plain language and distinguish these terms consistently:

- **observed**: derived directly from repository evidence;
- **documented**: stated in a project document;
- **inferred**: a non-authoritative conclusion;
- **approved**: explicitly reviewed by a human;
- **stale**: potentially outdated relative to repository state.

Do not describe a planned requirement as shipped. Update
`docs/IMPLEMENTATION_STATUS.md` when verification materially changes, and add a
concise entry under `Unreleased` in `CHANGELOG.md` for user-visible changes.

## Releases

Releases are maintainer operations governed by
[`docs/RELEASING.md`](docs/RELEASING.md). Contributors should not change a
version number merely to land a feature.
