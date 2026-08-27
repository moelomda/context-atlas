# Contributing Paths

Context Atlas welcomes contributors who care about developer tools, project knowledge, Git, TypeScript, SQLite, MCP, accessibility, privacy, testing, documentation, or open-source operations. You do not need to understand the whole system before making a useful contribution.

This guide maps common contribution types to the relevant code, tests, and trust boundaries.

## Start in 15 minutes

1. Read the project summary and safety model in [`README.md`](../README.md).
2. Run the disposable-repository workflow in [`QUICK_START.md`](QUICK_START.md).
3. Read the contribution rules in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
4. Choose one open issue with a scope you can explain and test.
5. Comment on the issue before starting significant implementation work.

In the issue comment, state:

```text
Behavior I plan to change:
Evidence or test that will prove it:
Compatibility, privacy, security, or migration impact:
Expected pull-request size:
```

A comment is coordination, not permanent ownership. Maintainers may suggest a smaller first change or identify an invariant that the issue description does not mention.

## Choose a contribution track

### 1. Documentation and onboarding

Good for first-time contributors and people evaluating the product from a user's perspective.

Typical work:

- correct a command or platform-specific instruction;
- improve examples and expected-output descriptions;
- clarify errors, empty states, limits, or known limitations;
- create a synthetic tutorial repository or walkthrough;
- improve architecture diagrams without changing their meaning; or
- verify a guide from a clean checkout and record the environment.

Start with:

- [`README.md`](../README.md)
- [`QUICK_START.md`](QUICK_START.md)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`ROADMAP.md`](../ROADMAP.md)
- files under `docs/`

Current entry point: [issue #3 — cross-platform five-minute quick start](https://github.com/moelomda/context-atlas/issues/3).

### 2. Accessibility and dashboard experience

Good for frontend developers, designers, accessibility testers, and contributors who can reproduce browser behavior carefully.

Typical work:

- keyboard and focus behavior;
- screen-reader names and live-region behavior;
- small-screen layouts;
- reduced-motion behavior;
- empty, loading, stale, conflicting, and failure states;
- graph readability and bounded rendering; or
- consistent explanations of authority, evidence, and freshness.

Start with:

- `src/web/public/index.html`
- `src/web/public/app.js`
- `src/web/public/styles.css`
- `src/web/server.ts`
- web-related tests under `tests/`

Dashboard changes must preserve escaping, loopback-only serving, same-origin mutation controls, bounded requests, and the separation between human review and agent capabilities. Include screenshots or a short recording and describe keyboard checks in the pull request.

### 3. Tests, fixtures, and public contracts

Good for contributors who want a contained engineering task without redesigning core semantics.

Typical work:

- exact boundary tests;
- platform-specific path and Git fixtures;
- malformed-input and recovery tests;
- API/MCP contract fixtures;
- package-install smoke coverage;
- deterministic synthetic-secret cases; or
- compatibility tests for the minimum supported runtime.

Start with:

- `tests/`
- `.github/workflows/ci.yml`
- `.github/scripts/`
- `src/core/contracts.ts`
- `src/mcp/`

Current entry points:

- [issue #2 — unify external-import size contracts](https://github.com/moelomda/context-atlas/issues/2)
- [issue #4 — test the exact minimum Node.js runtime](https://github.com/moelomda/context-atlas/issues/4)

Strong tests prove public behavior and failure behavior with disposable data. Avoid tests that depend on a developer's home directory, global Git configuration, network access, wall-clock timing, or private repositories.

### 4. Git ingestion and repository modeling

Good for developers familiar with Git plumbing, filesystem behavior, parsing, and incremental indexing.

Typical work:

- NUL-safe Git command parsing;
- rename, worktree, submodule, sparse-checkout, or object-format fixtures;
- fewer Git subprocesses;
- incremental/full equivalence;
- safe path normalization and ignore behavior; or
- bounded repository fingerprinting.

Start with:

- `src/core/git.ts`
- `src/core/ingest.ts`
- `src/core/ignore.ts`
- `src/core/config.ts`
- ingestion and Git tests under `tests/`

Never introduce shell-string command construction for repository-controlled input. Keep argument-array process calls, explicit limits, canonical paths, and sensitive-path policy intact.

### 5. Storage, integrity, and recovery

Good for experienced contributors comfortable with SQLite, migrations, transactions, immutable audit records, crash behavior, and data compatibility.

Typical work:

- query pagination and indexes;
- migration fixtures;
- backup/restore qualification;
- outbox and ledger recovery;
- concurrent-access behavior;
- corruption detection; or
- structured operational diagnostics.

Start with:

- `src/core/database.ts`
- `src/core/ledger.ts`
- `src/core/portable.ts`
- storage, ledger, migration, and recovery tests
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`RISK_REGISTER.md`](RISK_REGISTER.md)

Changes in this track require explicit rollback or recovery evidence. Do not rewrite immutable history, silently repair corruption, or weaken durable-write settings merely to improve benchmark numbers.

### 6. Context packs, search, and temporal knowledge

Good for developers interested in relevance, deterministic selection, knowledge graphs, bitemporal state, explainability, and coding-agent context.

Typical work:

- selection and relevance fixtures;
- bounded search and graph queries;
- incremental size accounting;
- tokenizer adapters;
- evidence closure;
- temporal assertion history; or
- clearer exclusions, conflicts, and unknowns.

Start with:

- `src/core/context-pack.ts`
- `src/core/query.ts`
- `src/core/temporal.ts`
- `src/core/claim-status.ts`
- context-pack, query, and temporal tests

A relevance improvement is incomplete if it hides omitted material or removes evidence, authority, freshness, conflict, or truncation metadata. Generated narrative remains non-authoritative until explicitly reviewed.

### 7. MCP and extension ecosystem

Good for developers familiar with MCP clients, schemas, adapters, plugins, and compatibility contracts.

Typical work:

- a second-client conformance fixture;
- extension examples;
- schema boundary tests;
- installed-package MCP smoke tests;
- clearer extension diagnostics; or
- compatibility/deprecation documentation.

Start with:

- `src/mcp/`
- `src/extensions/`
- `plugin/context-atlas/`
- [`EXTENSIONS.md`](EXTENSIONS.md)
- MCP and extension tests

MCP is intentionally read-only. Do not add synchronization, proposal creation, human review decisions, pack persistence, or retention application to the agent surface without an approved architecture change.

### 8. Security and privacy

Good for experienced security-minded contributors. Public issues must never contain real vulnerabilities, credentials, proprietary source, personal data, or real `.context-atlas` state.

Typical non-sensitive public work:

- synthetic secret-detector fixtures;
- safe diagnostics;
- permission and path-policy tests;
- egress contract tests;
- threat-model documentation; or
- pluggable scanner interfaces that retain the built-in safe baseline.

Start with:

- [`SECURITY.md`](../SECURITY.md)
- `src/core/security.ts`
- `src/core/privacy.ts`
- `src/core/egress.ts`
- `src/web/server.ts`
- security, privacy, and egress tests

Report an actual vulnerability privately through the process in `SECURITY.md`. Do not open a public issue or proof-of-concept pull request for it.

### 9. Performance and production qualification

Good for contributors who can measure before optimizing and preserve correctness under load.

Typical work:

- synthetic benchmark generators;
- versioned benchmark result schemas;
- SQL-level filtering and pagination;
- batched Git history extraction;
- worker isolation;
- memory and subprocess instrumentation; or
- regression budgets.

Start with [issue #6 — reproducible large-repository benchmark harness](https://github.com/moelomda/context-atlas/issues/6).

Performance claims must identify the repository class, hardware, OS, Node version, Git version, commit SHA, warm/cold state, sample count, and measured percentile. A fast nine-entity fixture is useful regression evidence but not production-scale qualification.

### 10. Release engineering and open-source operations

Good for contributors interested in packaging, reproducibility, SBOMs, provenance, changelogs, triage, and sustainable project governance.

Typical work:

- clean-install verification;
- release-note review;
- checksum documentation;
- package-boundary tests;
- support and triage documentation;
- contributor metrics without hidden telemetry; or
- maintainer/governance proposals.

Start with:

- `.github/workflows/`
- `.github/scripts/`
- [`RELEASING.md`](RELEASING.md)
- [`CHANGELOG.md`](../CHANGELOG.md)
- [issue #7 — first verified alpha prerelease](https://github.com/moelomda/context-atlas/issues/7)

Release tags and production credentials remain maintainer operations. Pull requests from forks must not require secrets.

## Repository map

| Path | Responsibility | Review sensitivity |
| --- | --- | --- |
| `src/core/` | Evidence, Git, storage, temporal knowledge, context packs, privacy, recovery | High; many product invariants live here |
| `src/web/` | Loopback HTTP API and local dashboard | High for browser security and human mutations |
| `src/mcp/` | Read-only coding-agent interface | High for capability and output-boundary changes |
| `src/extensions/` | Trusted in-process extension contracts | High for schema and executable-code boundaries |
| `src/cli.ts` | Human-operated command surface | Medium to high; preserve exit and confirmation behavior |
| `tests/` | Behavioral, security, portability, recovery, and package evidence | Every behavior change should update this evidence |
| `plugin/` | Codex plugin source and generated runtime | Generated artifacts must stay deterministic |
| `.github/` | CI, security scanning, templates, release automation | High for supply chain and release changes |
| `docs/` | Architecture, product, risk, release, and contributor guidance | Must distinguish shipped behavior from plans |

## Local verification

Install dependencies once:

```sh
npm ci
```

During development, run the smallest relevant test first, then the complete project gate before requesting review:

```sh
npm run check
npm audit --audit-level=high
npm pack --dry-run
```

Follow any additional checks named in the issue. Changes involving packaging, the generated plugin runtime, migrations, backup/restore, egress, or browser behavior require their specialized checks and manual evidence.

The repository is adding dedicated lint and format gates through [issue #5](https://github.com/moelomda/context-atlas/issues/5). Until that lands, preserve the surrounding style and avoid unrelated formatting churn.

## Pull-request shape

A reviewable pull request normally has:

- one user-visible or engineering outcome;
- a concise explanation of the previous behavior;
- automated evidence for the new and failure paths;
- explicit compatibility, privacy, security, and migration notes;
- documentation and changelog changes when behavior changes; and
- no generated, local, secret, or proprietary files.

Prefer separate pull requests for:

- mechanical formatting and behavior;
- refactoring and feature changes;
- benchmark infrastructure and performance optimizations;
- schema migration and unrelated query cleanup; or
- security hardening and new product surface.

## Trust-boundary checklist

Before requesting review, ask:

- Does any generated or inferred statement gain authority without human review?
- Can uncertainty, stale state, conflict, truncation, or exclusions disappear at an output boundary?
- Can repository data leave the machine through a new path?
- Can a secret-like value enter storage, logs, errors, fixtures, UI, MCP output, or egress?
- Can an agent perform a new mutation?
- Can a path escape the intended repository or local state directory?
- Can a partial write look successful?
- Can an older database, package, runtime, or client observe incompatible behavior without a versioned error?
- Is a previously bounded operation now proportional to the whole repository without a disclosed cap?

A “yes” does not automatically make a change unacceptable, but it requires explicit design, tests, documentation, and maintainer review.

## Current public milestone

The active project tracker is [issue #8 — contributor-ready public alpha](https://github.com/moelomda/context-atlas/issues/8). It prioritizes installation, runtime compatibility, contract consistency, contributor onboarding, a verified prerelease, and reproducible performance evidence before broad feature expansion.

Small, well-tested contributions that move that milestone forward are more valuable right now than large speculative rewrites.
