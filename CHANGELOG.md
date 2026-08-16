# Changelog

All notable changes to Context Atlas are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because Context Atlas is still on the `0.x` line, minor releases may include
breaking changes. Those changes must be called out explicitly.

## [Unreleased]

Reserved for changes after the `0.1.0` release candidate is frozen.

## [0.1.0] - 2026-08-17

### Added

- Cross-platform CI, security analysis, dependency review, issue forms, and a
  tag-gated GitHub Release workflow.
- Contributor, security, conduct, and release-maintenance documentation.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.
- Newcomer overview, bounded mind map, timeline, search, and evidence-linked
  explanations.
- Task-bounded context packs with repository identity, evidence references,
  freshness warnings, and a machine-readable safety verdict.
- Human-reviewed narrative proposal, approval, rejection, and conflict flows.
- Tamper-evident action ledger, checksummed exports, verified backups, and
  recoverable restore.
- Loopback-only interactive dashboard with overview, map, timeline, and health
  views.
- Stdio MCP server with ten read-only tools; synchronization, proposal creation,
  approval, and rejection remain explicit human-operated CLI actions.
- Self-contained Codex plugin bundle.
- Automated tests for the implemented alpha acceptance boundary.
- Context-pack schema v2 with 15 required typed sections, whole-item allocation,
  exact material-exclusion reasons, evidence closure, deterministic selection
  manifests, and a hard cap over the complete compact JSON representation.
- Current-evidence locator validation for canonical repository files, reachable
  Git commits, repository snapshots, and component snapshots. Missing, changed,
  unreachable, unsafe, policy-denied, or unvalidated support cannot settle
  current guidance.
- A guidance-dependency watermark covering extraction-affecting configuration,
  effective ignore policy, configuration-schema version, and extractor version.
  Policy drift requires synchronization and human re-review; legacy reviewed
  claims without a watermark fail closed.
- Narrow ledger fault fixtures for a committed-outbox process kill, torn-tail
  and framing refusal, recovery-head mismatch, and two-process reconciliation.
- SQLite schema v5 event-integrity bindings: immutable timeline content digests,
  one-time ledger attachment, domain-correct ledger-action checks, and protected
  v3/v4 migration backfill.
- Proposal approval now revalidates every evidence locator/digest/policy outcome,
  and synchronization refuses to mutate a store with damaged timeline bindings.
- Dashboard accessibility semantics including a skip link, live regions,
  keyboard-search listbox behavior, roving map focus, focusable semantic tables,
  reduced-motion behavior, and high-contrast/forced-colors styles.
- Build-time plugin legal notices generated from the dependencies actually
  bundled by esbuild, plus package/release checks for plugin license, notices,
  runtime freshness, and cross-manifest version drift.

### Changed

- Overview, graph, search, explain, assertion, API, MCP, pack, and dashboard
  presentation paths expose or consume explicit current-use status, settled
  state, reason, authority, evidence, and warnings instead of treating an
  immutable accepted row as automatically current.
- New repositories default to an 8,000-token pack budget. Existing repositories
  retain their configured value, including the legacy 4,000-token default,
  until an operator changes it.
- The ten-tool MCP surface remains read-only. `atlas_context_pack` may consume an
  existing task-scoped, unexpired human CLI override ID, but cannot create or
  mutate one and cannot hide the overridden-critical warning.
- CLI JSON packs are emitted as compact JSON, and the MCP pack tool budgets its
  complete tool result rather than duplicating the pack in text.

### Security

- Sensitive path withholding, common secret-pattern redaction, `.atlasignore`,
  static path validation, Content Security Policy, and loopback-only HTTP
  serving. Repository-specific exclusions also redact matching paths from Git
  event summaries before timeline, search, explain, or pack output is stored.
- Fresh and legacy `.context-atlas/.gitignore` files protect database migration
  snapshots before a full pre-upgrade SQLite copy is created.
- Unsettled, inferred, conflicting, stale, or evidence-invalid claims are
  withheld or explicitly labeled across primary read surfaces. Integrity
  overrides cannot bypass claim-level evidence closure.

### Verification status

- Direct source/test typechecks, deterministic runtime/legal regeneration,
  plugin validation, read-only MCP discovery, archive integrity, extracted CLI
  and bundled-MCP smoke, static dashboard contract, loopback refusal, and the
  offline high-severity dependency audit passed on the candidate worktree.
- The frozen candidate's full suite, coverage, packed fresh-install smoke,
  hosted SBOM/provenance jobs, and rendered-browser checks are **UNVERIFIED**.
  This managed sandbox rejects required child-process spawns with `EPERM`, and
  final gates on an immutable release commit are still pending. Old test totals,
  coverage percentages, and fixed package-entry counts are retired.

### Known limitations

- Node 24 labels the built-in SQLite API used by this release experimental.
- Current verification uses small disposable repositories; scale, rendered
  accessibility, usability, penetration, and broad process-crash testing remain
  incomplete.
- The graph is structural rather than a complete semantic or bitemporal project
  model.
- Context Atlas is a navigation aid, not proof that source code or generated
  changes are correct.
