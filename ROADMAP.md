# Context Atlas Public Roadmap

Context Atlas is building a local-first, evidence-backed memory layer for software projects and coding agents. The goal is not to generate another plausible project summary. The goal is to preserve project knowledge with visible evidence, time, authority, uncertainty, and human review.

This public roadmap turns the detailed engineering plans under [`docs/`](docs/) into a shorter path that users and contributors can follow.

## Current stage

Context Atlas is a working experimental alpha. It already includes a TypeScript library, CLI, loopback dashboard, SQLite knowledge store, temporal evidence model, immutable audit ledger, bounded context packs, read-only MCP server, extension contracts, tests, cross-platform CI, CodeQL, dependency review, and a release workflow.

It is **not production-ready yet**. There is no published GitHub release, large-repository performance is not qualified, the minimum runtime contract needs exact-version validation, and several core modules need scale and maintainability work.

## Current milestone: contributor-ready public alpha

The immediate objective is to make the project easy to install, understand, test, improve, and release without weakening its trust boundaries.

The milestone is complete when:

- a new user can install a verified prerelease and complete a useful workflow in under ten minutes;
- supported Node.js and operating-system versions are explicit and tested at their exact compatibility floor;
- the repository has a public, prioritized issue backlog with beginner, intermediate, and advanced contribution paths;
- the quick start, demo, architecture map, and known limitations agree with the shipped product;
- browser, CLI, HTTP, MCP, package, and extension contracts are consistent and covered by boundary tests;
- a reproducible benchmark suite publishes latency, memory, database-size, and Git-subprocess baselines;
- the first GitHub prerelease includes checksums, an SBOM, provenance attestations, migration notes, and installation smoke evidence; and
- no open critical integrity, privacy, data-loss, or remote-egress defect is known.

Milestones are evidence gates, not date promises. A security, privacy, integrity, or recovery failure extends a milestone rather than weakening the invariant.

## Product principles

Every release and contribution must preserve these rules:

1. **Evidence before authority.** Generated or inferred text never silently becomes project truth.
2. **Local by default.** Repository data stays on the developer's machine unless an explicit, reviewable egress workflow is used.
3. **Uncertainty remains visible.** Freshness, confidence, conflicts, evidence readiness, truncation, and exclusions survive every output boundary.
4. **Fail closed on integrity.** Corruption, stale guidance, unstable repository state, or unsafe policy changes are reported rather than hidden.
5. **Useful without an LLM.** Deterministic indexing, navigation, history, search, and context generation remain core product capabilities.
6. **Agent access stays bounded.** MCP is read-only; sensitive human decisions remain explicit human operations.
7. **Cross-platform behavior is a contract.** Windows, Linux, and macOS differences must be tested or disclosed.
8. **Small, reviewable changes win.** Production readiness comes from measured improvements, not feature volume.

## Release horizons

### `0.1.x` — Public alpha and contributor foundation

**User outcome:** A developer can install Context Atlas, index a real but moderate repository, inspect evidence-backed context, and connect a supported MCP client.

Primary work:

- exact runtime compatibility and package installation;
- first prerelease and repeatable release operations;
- five-minute product demo and example repository;
- consistent browser/server/core contracts;
- linting, formatting, contribution automation, and issue triage;
- initial performance benchmark harness and published baseline;
- high-value bug fixes without expanding product scope.

### `0.2.x` — Scale, responsiveness, and ecosystem beta

**User outcome:** Context Atlas remains responsive and predictable on substantially larger repositories and supports extension authors through stable contracts.

Primary work:

- batch Git history extraction instead of per-commit subprocess patterns;
- SQL-level filtering, pagination, and explicit graph/relationship caps;
- worker-thread or worker-process isolation for expensive Git and SQLite work;
- incremental Context Pack size accounting and provider-aware token counters;
- benchmark regression gates for representative repository sizes;
- stronger extension examples, conformance suites, and a second MCP client;
- accessibility and browser qualification.

### `0.5.x` — Release candidate and operational hardening

**User outcome:** Teams can pilot Context Atlas on important repositories with documented recovery, upgrade, security, and support procedures.

Primary work:

- crash, interruption, disk-full, migration, restore, and concurrent-access qualification;
- independent threat-model and security review;
- pluggable secret scanners with deterministic built-in protection;
- stable public schemas and deprecation policy;
- structured diagnostics that do not expose repository content or secrets;
- two successful upgrade cycles across retained fixtures;
- design-partner evidence from real repositories.

### `1.0.0` — Production-ready local project memory

**User outcome:** Context Atlas has stable compatibility commitments, measured reliability and scale, a documented support model, and a sustainable maintainer community.

A `1.0.0` release requires evidence for all of the following:

- **Compatibility:** exact supported runtime floor, operating-system matrix, package/API/MCP compatibility tests, and documented deprecation periods.
- **Reliability:** verified migrations, backup/restore, interrupted-write recovery, corruption detection, and clear operator repair paths.
- **Scale:** published p50/p95 latency, memory, database-size, and subprocess results on named repository classes with enforced regression budgets.
- **Security and privacy:** independent review, threat model, safe local identity boundary, secret-seeded tests, egress controls, SBOM, provenance, and vulnerability response process.
- **Usability:** a first useful result in minutes, accessible primary workflows, actionable errors, and tested empty/loading/degraded states.
- **Governance:** transparent decisions, responsive triage, maintained contributor documentation, release ownership, and more than one person able to review core changes.

## Workstreams and contribution paths

| Workstream | Beginner-friendly examples | Deeper engineering examples |
| --- | --- | --- |
| Product and onboarding | Quick-start corrections, examples, screenshots, clearer errors | First-run workflow, guided setup, design-partner studies |
| Core integrity and storage | Boundary fixtures, error-message tests, traceability updates | Migrations, crash recovery, audit outbox, concurrency |
| Git ingestion and performance | Synthetic fixtures, measurement scripts | Batched history extraction, cache design, worker isolation |
| Context packs and search | Relevance fixtures, tokenizer test corpora | Incremental budgeting, ranking diversity, provider token adapters |
| Dashboard and accessibility | Keyboard, small-screen, empty-state fixes | WCAG qualification, large-graph rendering, browser matrix |
| MCP and extensions | Example extension, client setup documentation | Conformance suite, schema evolution, trusted-host boundaries |
| Security and privacy | Synthetic secret cases, safe diagnostic tests | Scanner adapters, local identity, independent threat review |
| Release engineering | Release documentation and install checks | Reproducibility, signing, provenance, upgrade automation |

A good first contribution should be narrow, testable, and useful without requiring the contributor to understand the entire evidence model. Advanced changes that touch authority, persistence, temporal semantics, egress, or public contracts should start with an issue and a small design note.

## Maintainer operating model

During the alpha stage:

- issues are the public source of truth for near-term work;
- durable architecture decisions are recorded as ADRs or equivalent design notes;
- one issue should normally produce one focused pull request;
- user-visible changes update the changelog and implementation status;
- maintainers should explain declined proposals in terms of product scope or invariants;
- security reports follow [`SECURITY.md`](SECURITY.md), never public issues; and
- feature growth is paused when compatibility, reliability, or performance debt threatens the current milestone.

The project should add a formal maintainer ladder and decision policy before the public beta: contributor, reviewer, area maintainer, and release maintainer. Access must follow sustained demonstrated responsibility, not only commit count.

## Success measures

Context Atlas is local-first and should not add hidden telemetry to measure success. Evidence should instead come from opt-in reports, public issues, benchmark artifacts, release downloads, and design-partner sessions.

Useful milestone indicators include:

- successful clean-install reports on all supported platforms;
- median time to first useful overview and context pack;
- benchmark regressions caught before merge;
- issue first response and pull-request review time;
- number of active non-maintainer contributors;
- percentage of newcomer pull requests that pass the documented local gate; and
- number of repositories completing an upgrade without manual data repair.

## Deliberately deferred

The following are not current priorities unless evidence changes the roadmap:

- hosted SaaS or mandatory cloud accounts;
- automatic repository-data upload;
- autonomous agent writes or human-review decisions through MCP;
- multi-repository workspaces;
- broad language-semantic analysis before the core scale contract is proven;
- an extension marketplace before extension contracts and security boundaries stabilize; and
- feature additions that do not improve the contributor-ready alpha exit criteria.

## How to contribute

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), run `npm ci` and `npm run check`, then choose or open a focused issue. In your issue comment, state the behavior you plan to change, the test or evidence that will prove it, and any compatibility, privacy, security, or migration impact.

The detailed architecture, implementation, risk, and release plans remain available in:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md)
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)
- [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md)
- [`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md)
- [`docs/RELEASING.md`](docs/RELEASING.md)
