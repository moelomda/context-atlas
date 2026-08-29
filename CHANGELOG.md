# Changelog

All notable changes to Context Atlas are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because Context Atlas is still on the `0.x` line, minor releases may include
breaking changes. Those changes must be called out explicitly.

## [Unreleased]

Reserved for changes after `0.1.0` is tagged or published. Version `0.1.0`
below remains an **unreleased release candidate**; its dated heading is the
candidate identity used by release validation, not evidence that a GitHub
Release or package has been published.

## [0.1.0] - 2026-08-28

### Added

- Cross-platform CI, security analysis, dependency review, issue forms, and a
  tag-gated GitHub Release workflow.
- Contributor, security, conduct, and release-maintenance documentation.
- Cross-platform release-asset download, checksum/provenance verification,
  tarball installation, incident, rollback, and withdrawal documentation.
- Packed-product installation smoke coverage on Linux and Windows at the exact
  minimum supported Node.js runtime.
- Repository-independent `version`, `--version`, and `-v` CLI diagnostics backed by package metadata, including a versioned JSON form used by tests and installed-product verification.
- A deterministic synthetic benchmark harness with named file-count, history, relationship-density, and untracked-content scenarios; public-command timings, p50/p95, RSS where available, database bytes, Git Trace2 process counts, output counts, schema validation, CI smoke artifacts, and an explicitly limited reference baseline.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.
- Newcomer overview, bounded mind map, timeline, search, and evidence-linked
  explanations.
- Task-bounded context packs with repository identity, evidence references,
  freshness warnings, and a machine-readable safety verdict.
- Human-reviewed narrative proposal, approval, rejection, and conflict flows.
- Protected loopback browser review workspace with evidence readiness, conflict
  grouping, immutable review history, explicit confirmation, exact same-origin
  checks, bounded JSON, and an in-memory session token.
- Explicit one-source document/conversation-summary import through CLI and the
  protected dashboard, with zero-write preview, exact-byte/source/provenance
  consent, plan revalidation, atomic evidence/entity/event/audit writes,
  metadata-only sensitive handling, idempotence, and portable transfer.
- Six public versioned trusted-code extension ports for extractors, analyzers,
  providers, redactors, exporters, and validators, with fail-atomic schema and
  semantic checks, immutable registry identity, quarantine, portable export
  names, UTF-8 span validation, and secret-output defenses.
- A provider-neutral exact-byte egress gateway library with block/redact policy,
  scoped consent and revocation, one-attempt authorization, allowlists,
  token/cost ceilings, credential indirection, durable receipts, and no
  automatic retry. No CLI, web, or MCP provider is enabled in this alpha.
- Tamper-evident action ledger, checksummed exports, verified backups, and
  recoverable restore.
- Loopback-only interactive dashboard with overview, map, timeline, and health
  views.
- Stdio MCP server with 13 read-only tools, including immutable saved-pack
  history, snapshot, and diff reads. Synchronization, proposal creation,
  proposal decisions, pack persistence/refresh, and retention remain absent
  from MCP.
- Self-contained Codex plugin bundle.
- Automated tests for the implemented alpha acceptance boundary.
- Context-pack schema v2 with 15 required typed sections, whole-item allocation,
  exact material-exclusion reasons, evidence closure, deterministic selection
  manifests, and a hard cap over the complete compact JSON representation.
- Relationship-aware graph, explain, and pack contracts with fail-closed
  current-use status, authority, confidence, and evidence validation. Active
  relationships participate in whole-item pack selection and evidence closure.
- Immutable, content-addressed context-pack snapshots under
  `.context-atlas/packs/`, plus CLI save/history/diff/refresh workflows and
  read-only MCP history/snapshot/diff inspection. Distinct history is capped at
  256 and refuses overflow without deleting old snapshots.
- Narrow confirmed retention for individually inventoried portable-export and
  physical-backup files, bound to a fresh preview plan, attributed human actor,
  rationale, and exact confirmation. Immutable ledger tombstones distinguish
  started, completed, and partial outcomes.
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
- SQLite schema v6 event-integrity and external-import bindings: immutable timeline content digests,
  one-time ledger attachment, domain-correct ledger-action checks, and protected
  v3/v4/v5 migration backfill, plus canonical immutable import records and a
  per-store origin-path identity salt.
- Proposal approval now revalidates every evidence locator/digest/policy outcome,
  and synchronization refuses to mutate a store with damaged timeline bindings.
- Dashboard accessibility semantics including a skip link, live regions,
  keyboard-search listbox behavior, roving map focus, focusable semantic tables,
  reduced-motion behavior, and high-contrast/forced-colors styles.
- Build-time plugin legal notices generated from the dependencies actually
  bundled by esbuild, plus package/release checks for plugin license, notices,
  runtime freshness, and cross-manifest version drift.

### Changed

- Contributor verification now includes repository-pinned Biome lint and formatting gates for maintained TypeScript, JavaScript, and JSON on Windows, Linux, macOS, and the exact minimum Node.js runtime. Generated artifacts and local state remain outside the mechanical formatting boundary.
- Runtime support is now explicitly Node.js `>=24.12.0 <25`, with an exact-floor CI job, installed-package smoke testing at the floor, and Node 24 type declarations.
- Dashboard external imports now consume the core/API 256 KiB decoded-source contract, while the HTTP transport ceiling is derived separately for base64 and bounded metadata overhead. Boundary tests cover one byte below, the exact limit, one byte above, and transport overflow.
- Generic README setup and development examples now use the cross-platform
  `npm` command instead of the Windows-specific `npm.cmd` shim.
- The tag release workflow runs on exact-minimum Node.js `24.12.0`, and the
  pinned CodeQL and release-attestation actions were refreshed to reviewed
  patch releases without introducing floating action references.
- Overview, graph, search, explain, assertion, API, MCP, pack, and dashboard
  presentation paths expose or consume explicit current-use status, settled
  state, reason, authority, evidence, and warnings instead of treating an
  immutable accepted row as automatically current.
- New repositories default to an 8,000-token pack budget. Existing repositories
  retain their configured value, including the legacy 4,000-token default,
  until an operator changes it.
- The 13-tool MCP surface remains read-only. `atlas_context_pack` may consume an
  existing task-scoped, unexpired human CLI override ID, but cannot create or
  mutate one and cannot hide the overridden-critical warning.
- CLI JSON packs are emitted as compact JSON, and the MCP pack tool budgets its
  complete tool result rather than duplicating the pack in text.
- The HTTP API now reports split capabilities: its protected loopback human
  review surface can approve or reject proposals, while the agent/MCP surface
  remains read-only. Other product mutations remain CLI workflows.
- Proposal decisions now acquire the SQLite write transaction before re-reading
  and conditionally transitioning pending state, so a competing review cannot
  emit a second assertion, event, or ledger action after losing the transition.
- Versioned HTTP, MCP, and live context-pack reads compare database, live
  repository, ledger/synchronization, and guidance boundaries and refuse a
  mixed-snapshot response. Saved-pack MCP reads use compact single-copy
  structured payloads, and every MCP tool result has a fail-closed character
  ceiling.

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
- Saved-pack persistence refuses unsafe paths, symlinks, hard-linked ignore
  files, unstable repository/policy snapshots, malformed or oversized files,
  and silent history eviction.
- Retention apply refuses stale plans, incomplete inventories, changed files,
  unsafe directory chains, symlinks, and hard-linked files. Canonical database,
  ledger, review history, and SQLite operational state are never candidates;
  the feature does not claim secure-media erasure or general cache/log cleanup.
- The CLI rejects duplicate, missing-value, unknown, and command-inapplicable
  options; a safety-looking flag such as `--dry-run` cannot be silently ignored
  by `retention-apply`.
- External imports reject directories, devices, unsafe paths, hard links,
  invalid UTF-8, binary/NUL data, oversized inputs, secrets, plan drift, and
  forged import/ledger/event bindings. Imported bodies remain framed as
  untrusted evidence and sensitive bodies never enter SQLite.

### Verification status

- The current local worktree passed the normal behavioral suite (122/122 tests
  in 693,394 ms) and coverage run (122/122 tests in 901,735 ms; 95.40% lines,
  96.07% functions, and 76.81% branches), plus strict source/test TypeScript,
  JavaScript/JSON/YAML, release-identity, and online dependency-audit gates. The
  audit reported zero vulnerabilities; this is not an independent security
  assessment.
- The regenerated plugin exposes the same 13 read-only tools in source and the
  bundled runtime. Plugin/skill validators passed, independent runtime/notices
  regeneration hashes matched, and the real regenerated runtime passed its MCP
  regression (1/1).
- Pinned Actionlint 1.7.12 passed all maintained workflows. Every workflow
  `uses` reference remains full-SHA pinned. Protected hosted CI, exact-floor
  tests, package smoke, coverage, CodeQL, and dependency review are established
  gates; publication requires those gates on the exact release candidate,
  including Linux and Windows installed-package smoke. No tag workflow, SBOM,
  provenance attestation, or GitHub Release exists until publication.
- Rendered in-app browser QA on 2026-08-23 covered the desktop viewport plus
  390×844 and 320×720, including the selected-source preview/consent/apply flow.
  Confirmation remained hidden until preview, responsive overflow was checked,
  and the console stayed clean. Premature confirmation visibility and 320px
  horizontal overflow found during QA were fixed; the updated web suite passed
  6/6. This is not a screen-reader, WCAG, cross-browser, or other-OS result.
- After those feature/UI fixes, a 124-file local package candidate was rebuilt and
  requalified: inventory/forbidden-file/size/SHA-1/SHA-512 verification passed,
  and a clean temporary installation passed the installed CLI, dashboard asset
  delivery/API, selected-source import, protected review API, public extension
  subpath, privacy, override, and MCP smoke. The
  smoke verified the full 13-tool read-only inventory and exercised
  representative navigation, pack-history, evidence, and override reads.
  Hosted SBOM/provenance and publication remain pending.
- Request-scoped repository and evidence reuse reduced a real small-fixture
  `/api/v1/overview` request from roughly 8–12 seconds and 58 Git subprocesses
  to 1.48–1.61 seconds and 12 subprocesses while retaining post-read snapshot
  validation.

### Known limitations

- Node 24 labels the built-in SQLite API used by this release experimental.
- Current verification uses small disposable repositories; scale, rendered
  accessibility, usability, penetration, and broad process-crash testing remain
  incomplete.
- The graph is structural rather than a complete semantic or bitemporal project
  model.
- Relationship presentation and pack selection currently scan all retained
  relationships, graph edges have no independent cap, and saved-pack history
  verifies all retained snapshots before slicing the requested limit. The
  256-snapshot ceiling is not an aggregate-memory benchmark.
- Private-path detection is deliberately heuristic for arbitrary custom POSIX
  roots, and path-based retention cannot eliminate a malicious same-user
  directory-component swap race with ordinary Node filesystem APIs.
- Extension code is trusted in-process code rather than a sandbox, and the
  egress gateway remains a library boundary without persistent product
  credential/consent/budget stores, provider configuration UI, or a real
  provider adapter.
- Context Atlas is a navigation aid, not proof that source code or generated
  changes are correct.
