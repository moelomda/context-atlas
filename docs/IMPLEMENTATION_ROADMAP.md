# Context Atlas Implementation Roadmap

Status: executable delivery plan
Planning unit: focused engineering week
Baseline team: one senior full-stack engineer/founder, with part-time product/design and security review
Technology: Node.js 24, strict TypeScript, built-in SQLite, Git, local-first CLI/web/MCP

## 1. Delivery strategy

Build Context Atlas from the evidence kernel outward. The product must be trustworthy before it is impressive:

1. Establish repository identity, immutable evidence, transactions, and validation.
2. Build deterministic current/temporal knowledge and prove incremental equivalence.
3. Add human review, staleness, conflict, export, and recovery.
4. Expose one domain implementation through CLI, localhost web, and MCP.
5. Add context selection and strict budgets.
6. Only then enable optional model inference behind privacy and candidate-only controls.
7. Expand UX and integrations after integrity, security, and recovery gates pass.

This order intentionally prevents a generated-summary prototype from becoming the accidental source of truth.

## 2. Planning assumptions

- The schedule below is approximately 30–38 focused engineering weeks for a safe public beta by one experienced full-time engineer. Two engineers with clear ownership can reduce calendar time, but not eliminate security, usability, soak, and design-partner feedback time.
- GA follows at least 6–10 weeks of beta evidence rather than a predetermined date.
- The first supported code-analysis target is TypeScript/JavaScript plus language-neutral Git/Markdown/manifest/test evidence.
- The web UI is local and served by the Atlas process. It has no account, cloud sync, or external database.
- The core remains useful without an LLM. Model-provider support is an optional beta feature.
- One repository per workspace is supported through MVP/beta; multi-repository workspaces are deferred.
- `npm` workspaces, strict TypeScript, Node's test runner, and Node's built-in SQLite are the provisional low-dependency defaults. ADR-001 can replace the package/build choice only before public contract stabilization.
- All schedule estimates include implementation tests but not unbounded feature exploration.

## 3. Release milestones

| Milestone | Indicative weeks | User-visible outcome | Non-negotiable exit evidence |
|---|---:|---|---|
| M0 — Foundation | 1–2 | Installable developer CLI skeleton and versioned contracts | Reproducible checks, ADR baseline, cross-platform CI |
| M1 — Evidence kernel | 3–5 | Initialize/index a Git repository and inspect evidence/status | Idempotency, crash safety, path/symlink/secret-scope tests |
| M2 — Temporal knowledge | 6–9 | Current map data, timeline, evidence-backed explain/search | Temporal/property tests, full-vs-incremental equivalence |
| M3 — Governance and recovery | 10–13 | Review candidates, decisions, conflicts, staleness, export/restore | No in-place history mutation; corruption/rebuild drills |
| M4 — CLI MVP | 14–16 | Complete local no-model workflow from terminal | P0 CLI contract, golden E2E, usability dry run |
| M5 — Web orientation | 17–20 | Newcomer overview, map, timeline, evidence, review, health | Accessibility, bounded-map, loopback security gates |
| M6 — Context packs and MCP | 21–24 | Generate cited budgeted packs and query via coding agents | Token/relevance evaluation, MCP capability/security tests |
| M7 — Optional inference/privacy | 25–27 | Safe candidate suggestions through one provider adapter | Seeded-secret egress, injection, consent, cost gates |
| M8 — Design-partner alpha | 28–30 | 5–10 users run real local projects | Reliability/utility thresholds, incident and migration rehearsal |
| M9 — Private/public beta | 31–38 | Supported package and documented schemas | Scale, upgrade, threat review, signing, launch metrics |
| M10 — GA | Evidence-driven | Stable compatibility/support commitments | GA criteria in section 15, two successful upgrade cycles |

Milestones are gates, not date promises. A failed integrity/privacy/recovery gate extends the milestone; scope is reduced only by moving non-P0 features, not by weakening a safety invariant.

## 4. Cross-cutting definition of done

Every implementation item is done only when:

- Behavior is connected to a requirement and, where applicable, a risk control/test ID.
- Domain rule and error behavior are documented in code-level contracts.
- Automated positive, negative, boundary, and recovery tests pass.
- Structured output is versioned when consumed outside its module.
- Authority, evidence, time, freshness, sensitivity, and truncation metadata survive all affected interfaces.
- Logs and errors are checked for source/secret leakage.
- A migration or compatibility impact is explicitly marked `none` or tested.
- Cross-platform behavior is tested or a documented support limitation is emitted.
- Documentation and `REQUIREMENTS_TRACEABILITY.md` verification evidence are updated.
- No unrelated failing checks or hidden manual repair step remains.

An individual phase exits only when its named gate suite has a machine-readable result and the team has inspected what those tests actually cover.

## 5. Workstreams

| Workstream | Scope | Primary owner | Starts | Critical dependencies |
|---|---|---|---|---|
| WS-A Domain/integrity | entities, assertions, time, review, conflict, staleness | Core engineer | M0 | None |
| WS-B Git/extraction | repository evidence, incremental changes, TS/Markdown/manifests | Ingestion engineer | M0 | Domain evidence contracts |
| WS-C Storage/recovery | SQLite, migrations, transactions, backup/export/rebuild | Storage engineer | M0 | Identity and temporal ADRs |
| WS-D Product interfaces | CLI, HTTP, web, accessibility | Full-stack engineer | M1 | Application query/command ports |
| WS-E Context/MCP | search selection, ranking, pack formats, MCP contracts | Context engineer | M2 | Current graph, policy engine |
| WS-F Privacy/security | classification, secret scan, egress, threat tests | Security owner | M0 | Cross-cuts every boundary |
| WS-G Optional inference | provider abstraction, structured candidates, evaluation | Inference engineer | M3 | Review + privacy gates |
| WS-H Quality/launch | fixtures, benchmarks, usability, docs, packaging, support | Product/quality owner | M0 | Cross-cuts all milestones |

With one engineer, the owner labels are hats and the critical path follows milestone order. With multiple engineers, no more than one person changes canonical schema/domain invariants without a coordinating review.

## 6. Phase 0 — Foundation and decisions (M0, weeks 1–2)

### Objective

Create a small, repeatable engineering foundation and freeze the invariants that would be costly to retrofit.

### Work packages

#### P0.1 Repository and toolchain

- Create npm workspace/module layout from `ARCHITECTURE.md`.
- Pin Node 24 support; enable strict TypeScript including unchecked-index and exact-optional-property checks where practical.
- Configure Node test runner, coverage, formatting/linting, typecheck, build, and clean-package smoke test.
- Establish deterministic UTC/locale behavior in tests.
- Configure Windows, macOS, and Linux CI with no-network core integration job.
- Add safe temporary-workspace helpers that never operate on workspace root.

Deliverable: a clean checkout installs/builds/tests and packages the CLI skeleton on all supported platforms.

#### P0.2 Contract and ID baseline

- Define version-envelope schema used by CLI JSON, local API, MCP, packs, and exports.
- Implement opaque ID types and canonical JSON/content hashing rules.
- Define error taxonomy and proposed CLI exit codes.
- Define actor, producer, authority, lifecycle, sensitivity, snapshot, and watermark primitives.
- Establish compatibility fixture directory and golden-update review policy.

Deliverable: contract package tests reject unknown invalid state while preserving forward-compatible extension fields according to policy.

#### P0.3 Architecture decisions

Write and approve ADR-001 through ADR-008 from `ARCHITECTURE.md`, with provisional decisions for ADR-009 through ADR-012. In particular, settle:

- Package/module boundaries.
- UUIDv7 versus namespaced content-derived IDs.
- SQLite worker/transaction strategy.
- Assertion predicate/value registry and custom namespace policy.
- Bitemporal interval and supersession semantics.
- Git invocation, path normalization, and SHA-1/SHA-256 support.
- Ignore/classification/secret policy precedence.
- Public contract versioning/deprecation policy.

#### P0.4 Threat and test fixtures

- Generate the small known-truth project, temporal decision project, Git edge-case project, malicious-content project, and synthetic-secret corpus.
- Declare every synthetic secret test-only so repository scanners can distinguish fixtures from live credentials.
- Turn primary risk tests into initially failing named suites or executable test specifications.
- Establish security disclosure and incident template.

### Exit gate M0

- CI green on three operating systems.
- Architecture decisions resolve identity/time/storage/security ambiguities.
- Contract schemas and error/exit semantics are versioned.
- Risk test IDs exist in test inventory.
- No feature code can bypass the domain/application ports by direct presentation-to-SQL access.

## 7. Phase 1 — Evidence kernel and safe ingestion (M1, weeks 3–5)

### Objective

Turn a Git worktree into immutable, hash-addressed evidence through a resumable transaction without generating narrative claims.

### Work packages

#### P1.1 Workspace initialization (`FR-001`, `FR-002`)

- Resolve canonical Git top-level/common directory and object format.
- Capture HEAD/ref/default-branch discovery, dirty state, merge/rebase/sparse/submodule/LFS indicators.
- Implement `atlas init --dry-run` scope/config preview.
- Create local store/config only after explicit acceptance; never rewrite existing files silently.
- Persist workspace/repository identity and reject wrong-root/wrong-repository mutation.

#### P1.2 Policy-first discovery (`FR-003`, `FR-008`, `FR-043`)

- Implement `.atlasignore` parsing and deterministic precedence with Git ignored/tracked state.
- Classify binary, generated, oversized, symlink, outside-root, submodule, and unsupported files before body extraction.
- Enumerate paths using NUL-delimited Git formats and argument-array process calls.
- Capture full/history scope configuration so a later timeline states what was not scanned.
- Ensure deterministic indexing makes no network call.

#### P1.3 Evidence schema/storage (`FR-006`)

- Implement initial SQLite migrations for workspace, repository, snapshot, run, artifact, fragment, audit, and schema ledger.
- Enforce strict tables, foreign keys, hashes, unique identity, safe JSON validation, and one-writer lease.
- Run database work through the selected dedicated worker/serialized port.
- Implement evidence resolvers for Git object, file-at-commit, diff, and worktree snapshot.

#### P1.4 Resumable full/incremental runs (`FR-004`, `FR-007`)

- Implement staging run namespace, checkpoints, bounded batches, cancellation, and atomic current-snapshot pointer.
- Ingest commits/DAG metadata, changes, renames/copies, tracked files, modes, hashes, and worktree delta.
- Detect unstable worktree reads by pre/post fingerprint.
- Implement full and incremental equivalence comparator for canonical evidence.

#### P1.5 Privacy baseline (`FR-044`, `FR-046`)

- Add sensitivity classes and path-policy results to artifacts.
- Integrate a deterministic synthetic-secret scanner interface and block storing prohibited cache bodies.
- Ensure logs contain only safe run IDs, counts, phases, versions, and error codes.
- Add local permission hardening where operating system APIs support it; report inability rather than claim success.

### Tests and evidence

- `T-GIT-001`, `T-GIT-002`, `T-GIT-005`, `T-GIT-006`.
- `T-STORE-001`, `T-STORE-002`, `T-STORE-003` for evidence-stage transactions.
- `T-SUP-001` no-network suite.
- Full ingestion twice creates no semantic duplicates.
- Cancellation/kill at each phase leaves prior snapshot valid.
- Denied symlink/outside-root body is never read, verified by a tripwire fixture.

### Exit gate M1

`atlas init`, `atlas update --no-inference`, `atlas status`, and evidence inspection work on the fixture repositories. No narrative summary is required yet. Integrity validation proves each stored artifact identity and a clean rebuild reproduces the canonical evidence set.

## 8. Phase 2 — Deterministic temporal knowledge (M2, weeks 6–9)

### Objective

Construct a useful high-level graph, current projection, history, search, and explanation exclusively from deterministic evidence and explicit source statements.

### Work packages

#### P2.1 Entity/assertion model (`FR-009`–`FR-012`, `FR-017`)

- Add entity, alias, assertion revision, assertion-evidence, event, dependency-edge, projection-manifest, and FTS schemas.
- Implement typed predicate registry for package/module/component/interface/test/goal/term/source-statement facts.
- Enforce evidence, authority, scope, confidence-method, valid/recorded time, producer, and lifecycle invariants.
- Create current assertion projection bound to committed source snapshot and knowledge watermark.

#### P2.2 Deterministic extractors

- Manifest extractor: package identity, scripts, dependencies, engines, workspace/entry-point declarations.
- TypeScript/JavaScript analyzer: module and selected symbol import/export graph, parser coverage diagnostics.
- Markdown extractor: headings, links, explicit ADR/decision patterns, setup/test commands as quoted source statements.
- Test extractor: test paths/suites/commands and conservative subject links.
- Configuration extractor: only versioned recognized schemas/patterns.
- Entity boundary rules initially favor explicit packages/configured roots; ambiguous merge/continuity creates a candidate.

#### P2.3 Temporal engine (`FR-011`–`FR-016`)

- Implement valid-time/recorded-time queries, exclusive end intervals, supersession rules, cycle prevention, and multiplicity registry.
- Build event stream for meaningful source changes and deterministic extraction changes.
- Add current/as-of/between query API.
- Implement conflict detection for overlapping incompatible active scalar assertions.
- Treat late-recorded human/source facts honestly in fixtures.

#### P2.4 Search/explain/map data (`FR-024`–`FR-030`)

- Build local FTS documents for entities, aliases, paths, symbols, assertions, events, and safe evidence metadata.
- Implement exact/path/symbol/alias/FTS rank and filters.
- Implement bounded map slice with typed edge filters, maximum nodes, summarized frontier, cursor, and temporal point.
- Implement explain DTO with current state, dependencies/dependents, history, risks/unknowns/conflicts, evidence.
- Create deterministic overview outline and plain blocks. Missing product purpose/rationale must show unknown, not generic generated prose.

#### P2.5 Validation (`FR-023`)

- Add referential, hash, evidence-resolution, current-projection watermark, temporal interval/cycle, authority, duplicate identity, and coverage-gap rules.
- Implement `quick`, `full`, and test-only deep comparison modes.
- Return machine-readable finding IDs/severity and CLI exit semantics.

### Tests and evidence

- `T-HAL-001`, `T-HAL-003`–`T-HAL-006` deterministic portions.
- `T-HIST-001` model invariant; `T-MET-001`–`T-MET-003`.
- Property tests generate random assertion histories and compare temporal queries with a simple reference model.
- Full versus incremental ingestion yields semantically equivalent observed graph.
- Search/overview/map have known golden output with claim/evidence manifests.
- Unsupported syntax produces coverage gaps, never guessed facts.

### Exit gate M2

A user can run local/no-model update, overview, map, history, explain, and search against the known-truth project. Every surfaced statement resolves to evidence; as-of queries pass the temporal oracle; unknown/conflict states are explicit.

## 9. Phase 3 — Governance, freshness, export, and recovery (M3, weeks 10–13)

### Objective

Make project knowledge maintainable and recoverable: humans can add/review intent, changes invalidate dependent knowledge, conflicts are resolvable, and canonical history survives failure.

### Work packages

#### P3.1 Candidate/review workflow (`FR-014`, `FR-016`, `FR-019`, `FR-020`)

- Add candidate batch, review action, actor, annotation, and audit schemas.
- Implement approve/edit-and-approve/reject/defer/unknown/withdraw as new records.
- Require support and a review actor for rationale; show impact before supersession.
- Implement optimistic knowledge-watermark conflict handling.
- Prevent an inference/producer actor from reviewing its own candidate.

#### P3.2 Conflict lifecycle (`FR-015`)

- Implement rules that create conflicts without mutating either claim.
- Support resolution through scope/time correction, unsupported declaration, or superseding assertion.
- Recompute dependent projections after resolution.
- Expose unresolved critical conflicts in health and query metadata.

#### P3.3 Dependency and staleness (`FR-021`, `FR-022`)

- Record evidence/rule/policy/upstream assertion dependencies.
- Compute reverse impact frontier after each update.
- Auto-revalidate only deterministic equivalent support; queue human rationale/ambiguous inferences.
- Distinguish repository, extraction, assertion, projection, and pack freshness.
- Explain the exact cause and last validated snapshot for every stale status.

#### P3.4 Portable export/import (`FR-047`, `NFR-013`)

- Define canonical JSONL manifest, schema version, checksums, identity/revision/audit ordering, source locators, and sensitivity metadata.
- Export human-approved knowledge/config/reviews/audit plus necessary safe evidence identity; omit derived caches by default.
- Import through dry-run validation, collision/lineage plan, and all-or-nothing canonical transaction.
- Publish schema examples and compatibility fixtures.

#### P3.5 Backup/restore/rebuild (`FR-048`)

- Implement atomic physical backup where safe plus portable canonical backup.
- Add optional encryption adapter without storing key in Atlas database.
- Restore only after checksum/schema/repository identity preview; preserve current store until new one validates.
- Rebuild derived evidence/index/projections from Git plus imported canonical knowledge.
- Detect Git rewrite/unreachable objects and produce orphan/re-review report.

### Tests and evidence

- `T-HIST-001`–`T-HIST-004`, `T-HIST-007`, `T-HIST-008`.
- `T-STALE-001`–`T-STALE-006`, `T-STALE-008`.
- `T-HAL-007`; `T-ADOPT-002`.
- Random crash and tamper injection; corrupted canonical/derived distinction tests.
- Export/import semantic comparator verifies identity, revision, validity, review, and audit order.

### Exit gate M3

A decision can be proposed, reviewed, superseded, made stale by code change, conflicted, resolved, exported, restored into a clean store, and queried historically with no in-place mutation or lost provenance.

## 10. Phase 4 — Complete CLI MVP (M4, weeks 14–16)

### Objective

Deliver the full safe local workflow through a scriptable and understandable CLI before the web UI introduces another surface.

### Work packages

#### P4.1 Command surface (`FR-037`)

Implement the documented commands and `--json` versioned envelopes:

- init/update/status
- overview/map/history/explain/search
- review list/approve/edit/reject/defer/unknown/withdraw
- validate
- export/import/backup/restore
- serve/MCP placeholders until their milestone

Read commands identify the snapshot/watermark read. Mutations support dry run where meaningful and report the audit/mutation ID.

#### P4.2 Terminal UX

- Clear orientation output and next action.
- Consistent labels for observed/derived/human/inferred/unknown/stale/conflicting.
- Evidence locators resolvable through a command without displaying prohibited bodies.
- Noninteractive behavior has no prompts; interactive confirmations enumerate exact target/effect.
- TTY/non-TTY, Unicode/no-color, narrow terminal, and Windows path tests.

#### P4.3 Operations

- Structured safe diagnostics and redacted bundle preview.
- Writer-lock visibility, cancellation, resume selection, migration status, backup age.
- Shell completion generation is P1 and can move to beta.

### Tests and evidence

- Golden CLI text and JSON for every success/warning/error class.
- End-to-end `init → update → overview → explain → annotate/review → change → stale → validate → export → restore`.
- New evaluator completes no-model flow without external docs (`NFR-016`).
- Wrong-directory and wrong-repository mutation tests.

### Exit gate M4

All P0 CLI behavior has stable contracts, clear error/exit semantics, and a tested recovery path. The CLI alone provides meaningful product value.

## 11. Phase 5 — Local web orientation and review (M5, weeks 17–20)

### Objective

Make the mental model visible and navigable without weakening the domain, privacy, or authority rules established through the CLI.

### Work packages

#### P5.1 Local API/server (`FR-038`, `FR-039`)

- Implement `/api/v1` read/query and scoped mutation routes using application ports.
- Bind loopback by default with random port option.
- Add session bootstrap, same-origin/Host checks, CSRF protection, restrictive CSP, no wildcard CORS, request/body/rate limits, and safe shutdown.
- Version response envelope; snapshot/watermark/warnings included everywhere.
- Add server contract tests and generated API reference from schemas.

#### P5.2 Overview and health (`FR-022`, `FR-024`, `FR-030`)

- Product purpose/users/vocabulary/boundaries/current state/data flow/setup/tests/risks/unknowns/entry points.
- Freshness and coverage by component with reasons, not one misleading score.
- Clear empty/partial/error/stale/conflict states.
- Deep evidence drawer that exposes provenance without overwhelming initial view.

#### P5.3 Map, timeline, explain, and search (`FR-025`–`FR-029`)

- Bounded focused map with type/time/state filters and summarized frontier.
- Equivalent accessible list/table and keyboard navigation.
- Filterable timeline with event grouping and evidence links.
- Search with exact/path/symbol/lexical match reasons and filters.
- Explain page for entity/path/symbol/claim plus current/history/dependency/risk/evidence.

#### P5.4 Review and conflict UI

- Risk-ranked queue, batch grouping only for homogeneous low-risk candidates.
- Symmetric conflict comparison and explicit resolution choices.
- Evidence, support/contradiction, authority/confidence, impact, and audit preview before review action.
- Unsafe/high-impact actions require clear consequence and cannot be initiated by untrusted rendered content.

#### P5.5 Accessibility and usability

- WCAG 2.2 AA automated and manual checks.
- Screen-reader names/landmarks/live ingestion status.
- Do not rely on color; compact labels remain in copied text.
- Newcomer moderated rubric and trust-calibration study.

### Tests and evidence

- `T-LOAD-001`, `T-LOAD-004`, `T-LOAD-006`.
- `T-AUTH-001`–`T-AUTH-004` across web.
- `T-LOCAL-001`, `T-LOCAL-002`, `T-LOCAL-004`, `T-LOCAL-005`.
- XSS corpus, malicious Markdown, large graph, browser refresh during update, stale session/watermark conflicts.
- Keyboard-only and screen-reader manual test scripts.

### Exit gate M5

A newcomer can orient, inspect evidence, search/explain, navigate history/map, and review a change. Security suite proves a malicious site/repository cannot mutate or execute through the local UI. The structured list view supports every core graph task.

## 12. Phase 6 — Context packs and MCP (M6, weeks 21–24)

### Objective

Deliver relevant, bounded, inspectable context to humans and coding agents through stable formats and a least-capability protocol.

### Work packages

#### P6.1 Pack selector (`FR-031`–`FR-034`)

- Normalize task concepts locally; seed exact path/symbol/entity/user pins.
- Implement typed bounded graph expansion and deterministic feature scores.
- Reserve budget for identity/goals, architecture, decisions/constraints, risks/conflicts/unknowns, tests, recent changes, and evidence.
- Deduplicate assertions/evidence and apply policy before body selection.
- Refuse too-small budgets and block critical stale/conflicting/unsupported content unless a reviewed override is supplied.
- Return material exclusion and truncation reasons.

#### P6.2 Pack formats and lifecycle (`FR-035`, `FR-036`)

- Canonical versioned JSON manifest and Markdown renderer.
- Include snapshot/watermark/task hash/budget estimator/policy/selector versions/selected hashes/warnings/exclusions.
- Store immutable manifest and output hashes.
- Refresh/compare identifies input, selected-claim, warning, and format changes.

#### P6.3 Evaluation harness

- Create task/fact/risk/test rubrics for known-truth repositories.
- Compare against full-repo, relevant-directory, README-only, and naive lexical baselines.
- Measure critical fact recall, unsupported fact rate, precision, redundancy, warning retention, token reduction, and downstream task outcomes later.
- Publish reference estimator limitations and hard character cap.

#### P6.4 MCP (`FR-040`, `FR-041`)

- Implement stdio tools/resources for overview, search, explain, history, evidence, health, and pack generation.
- Add server-enforced response caps, cursors, snapshot/watermark, authority/freshness/warnings.
- Add separately disabled proposal/update-request capabilities; no review approval tool in MVP.
- Optional loopback HTTP transport uses short-lived scoped token and explicit launch.
- Validate across at least two reference MCP clients or protocol harnesses.

### Tests and evidence

- `T-TOK-001`–`T-TOK-004`, `T-TOK-007`.
- `T-ACT-001`–`T-ACT-003`.
- `T-AUTH-001`–`T-AUTH-003`, `T-AUTH-006` on MCP/packs.
- `T-LOCAL-003`, `T-LOCAL-004`.
- Stable serialization/deterministic ordering and one-version-back contract fixtures.

### Exit gate M6

On the evaluation corpus, packs meet token reduction/recall targets, retain critical safety sections, list exclusions, and reproduce from manifests. MCP cannot exceed configured size/privacy/capability limits and never strips authority metadata.

## 13. Phase 7 — Optional inference and egress privacy (M7, weeks 25–27)

### Objective

Add useful machine-proposed explanations/events without allowing a model to become authority or a privacy bypass.

### Work packages

#### P7.1 Provider-neutral inference (`FR-042`, `FR-043`)

- Define provider interface over an already selected/redacted payload.
- Support one provider adapter plus deterministic mock; no provider SDK in domain/application layers.
- Structured output includes atomic claim, allowed evidence IDs, contradiction IDs, unknowns, confidence basis.
- Record provider/model/prompt/input/policy/redactor versions and safe token/cost metadata.
- Reject malformed/fabricated/unsupported output atomically.

#### P7.2 Privacy/egress gate (`FR-044`–`FR-046`, `FR-050`)

- Classification and secret scan before selection and after redaction.
- Exact payload/destination/purpose/retention-assumption/token/cost preview.
- Consent scoped to repository/provider/purpose/policy version; policy change re-prompts.
- Credential references only; integrate OS/env source without storing value.
- Egress audit stores hashes/categories/counts/status, not raw secret/payload by default.
- Privacy report covers indexed/denied scope, finding categories, cache/retention, providers, and egress history.

#### P7.3 Candidate generation and review

- Candidate purposes initially limited to component purpose, semantic event grouping, change-impact questions, and missing-context questions.
- Rationale suggestions are worded as questions/candidates and never activated without review.
- Input minimum and evidence sufficiency policy prevents broad speculative summary calls.
- Risk-ranked review and repeated-rejection suppression.

#### P7.4 Injection/cost defenses

- Fixed prompt template treats repository content as delimited untrusted evidence.
- Output never executes or controls capabilities.
- Per-run/day token/cost ceiling, dry-run estimate, cancellation, timeout, safe cache key.
- Quarantine/invalidator by provider/model/template version.

### Tests and evidence

- `T-HAL-002`, inference cases of `T-HAL-001`–`T-HAL-008`.
- `T-PRIV-001`–`T-PRIV-007`.
- `T-INJ-001`–`T-INJ-004`.
- `T-PROV-001`; `T-TOK-002`, `T-TOK-005` as supported.
- Byte-for-byte mocked egress capture proves no seeded secret/denied content.

### Exit gate M7

Remote inference remains disabled by default. Enabling it requires informed scoped consent. Every output is a cited candidate; fabricated evidence and policy violations fail closed. The entire deterministic suite passes with network denied and provider absent.

## 14. Phase 8 — Design-partner alpha (M8, weeks 28–30)

### Objective

Prove that the system reduces context debt on real projects without creating unacceptable maintenance or trust problems.

### Cohort

- 5–10 opt-in solo builders/maintainers.
- Mix of small and medium TypeScript/JavaScript repositories, Windows/macOS/Linux, old/new histories.
- At least two evaluators enter a project with no prior knowledge.
- No proprietary content is collected; sessions can use screen sharing or user-generated redacted diagnostic exports.

### Alpha protocol

1. Baseline: user explains project and prepares an LLM task using current workflow.
2. Initialize/update Atlas locally with inference off.
3. Complete newcomer orientation and evidence rubric.
4. Add/review one decision and make a code change that invalidates context.
5. Generate/use a pack for a real bounded task.
6. Restore/rebuild a copied test workspace.
7. Optionally enable inference after privacy walkthrough.
8. Collect structured utility, correctness, maintenance, trust-calibration, and failure feedback.

### Alpha thresholds

- Median first orientation under 10 minutes after indexing.
- At least 98% displayed factual-claim evidence resolution in sampled projects.
- Zero unlabelled inferred rationale claims.
- No seeded secret egress.
- At least 70% of sessions rate pack or orientation as materially useful.
- Median ongoing review/maintenance under 5 minutes for a typical bounded update, excluding initial indexing.
- All SEV-1/SEV-2 issues fixed and regression-tested before expanding cohort.

### Operational work

- Add opt-in redacted diagnostic exporter and support bundle preview.
- Create issue taxonomy aligned to requirement/risk IDs.
- Run first incident tabletop and restore drill.
- Measure extractor coverage gaps before adding languages/features.
- Freeze nonessential features during final alpha week and focus on correctness/reliability.

## 15. Phase 9 — Private and public beta (M9, weeks 31–38)

### Objective

Turn the design-partner build into a supportable, secure, portable release with published limits.

### Required work

#### P9.1 Scale/performance

- Generate and publish reference-machine specification and 100k-file/20k-commit/250k-assertion/1m-edge fixtures.
- Profile query plans, memory, database size, ingestion backpressure, and cancellation.
- Meet NFR-004/005/006 or revise supported scale transparently before public release; do not claim unsupported thresholds.

#### P9.2 Compatibility/migrations

- Upgrade every supported fixture and compare canonical semantics.
- Exercise export/import and backup/restore from previous minor version.
- Define support/deprecation window and migration failure recovery.
- Test SHA-256 Git, unusual path, merge DAG, sparse/submodule/LFS declared behavior.

#### P9.3 Product quality

- Guided onboarding tour and comprehension rubric (`FR-028`).
- Pack refresh/compare and retention/privacy report P1 behavior.
- Refine queue grouping, saved filters, empty/error language from alpha evidence.
- Complete WCAG 2.2 AA audit and remediate.

#### P9.4 Release/security

- Dependency/SBOM review, signed/checksummed packages, protected release workflow.
- Independent threat-model review and targeted penetration test.
- Mocked and synthetic real-provider egress audit.
- Security policy/reporting channel, incident runbook, release advisory mechanism.
- License/privacy/telemetry documentation; telemetry remains opt-in.

#### P9.5 Distribution

- Package CLI with Node 24 engine declaration and integrity metadata.
- Document installation, local data paths, backup, uninstall/retention behavior, supported Git/platform limits.
- Publish pack/export/API/MCP schemas and examples.
- Provide one broadly compatible MCP setup guide. A product-specific plugin may wrap this later without changing core contracts.

### Public-beta gate

- All P0 requirements verified; no open SEV-1/SEV-2.
- Primary risk tests pass and residual scores are at/below target.
- Performance/accessibility/compatibility/recovery NFRs pass on published fixtures.
- Two release-candidate upgrades and restore drills pass.
- Trust-calibration result at least 80% and context pack meets 50% token reduction/90% rubric-fact target on maintained corpus.
- Known limitations are visible in product and release notes, not buried in developer documentation.

## 16. GA criteria (M10)

Do not declare GA until:

1. Public beta has run for at least 6 weeks and includes two successful upgrade cycles.
2. No unresolved systemic provenance, history, or secret-egress failure exists.
3. Crash-free successful command/run rate and restore success meet published service-quality thresholds using opt-in/local diagnostics evidence.
4. 25+ active repositories have completed at least four weekly update cycles, or equivalent meaningful design-partner evidence exists.
5. Newcomer comprehension, pack relevance, trust calibration, freshness latency, and maintenance-time targets remain stable.
6. Supported data/contract compatibility and deprecation policies are published.
7. Independent security findings are resolved or explicitly accepted with scope/expiry/disclosure.
8. A full requirement-by-requirement completion audit in `REQUIREMENTS_TRACEABILITY.md` points to current artifacts and test results.

## 17. Detailed P1/post-MVP backlog

Prioritize only after public-beta evidence identifies the bottleneck.

### Knowledge depth

- Additional language analyzers through the extractor interface.
- Reviewed entity merge/split UX and semantic continuity assistance.
- Richer data/request-flow inference with explicit coverage.
- Issue/PR/ADR imports with source-specific authority.
- Historical branch/release views.

### Integrations

- IDE sidebar and `explain selection` action.
- Codex/other coding-tool plugin that calls the same MCP/API; no private alternate knowledge path.
- Pre-task hook that checks pack freshness and relevant critical conflicts.
- Post-change hook that runs `atlas update --no-inference` and proposes a review summary.

### Teams

- Multi-repository workspace.
- Signed synchronization of canonical human knowledge.
- Roles/review policies and organization-level egress/retention rules.
- Conflict-free offline review synchronization with immutable revision preservation.

### Advanced retrieval

- Optional local embeddings as a derived privacy-scoped index.
- Evaluation-driven graph-learning ranker, still deterministic/versioned at inference time.
- Task templates with acceptance/test checklists.

Explicitly defer autonomous approval, autonomous code writes, silent cloud upload, surveillance analytics, and proprietary-only export formats.

## 18. Verification artifact plan

Each CI/release run should produce an artifact manifest containing:

- Source commit and dirty state.
- Node/platform versions.
- Contract/schema/migration/extractor/selector/prompt/policy versions.
- Test suite IDs executed, counts, duration, failures, quarantine state.
- Coverage by domain risk/requirement, not merely lines.
- Performance fixture and machine identity/specification.
- Security scan/SBOM/signing result.
- Migration/export/restore semantic comparison hashes.
- Pack evaluation metrics and corpus version.
- Accessibility/manual test record where automation is insufficient.

`REQUIREMENTS_TRACEABILITY.md` should link each requirement to the most recent durable artifact location. A green generic test job without test-to-requirement mapping is insufficient completion evidence.

## 19. Release dashboards and operating metrics

### Integrity

- Active claims with resolvable evidence.
- Unlabelled inferred claims (target zero).
- Broken provenance and temporal invariant findings.
- Incorrect/unsupported user reports per 100 verified orientation events.

### Freshness

- Update-needed detection time and update duration.
- Critical stale claim age.
- Projection/pack snapshot mismatch frequency.
- Full-vs-incremental equivalence failures (target zero).

### Usefulness

- Time to newcomer rubric completion.
- Verified orientation events per active repository.
- Pack critical-fact recall, precision, and downstream task outcome.
- Search zero-result and evidence-inspection completion.

### Burden

- Review minutes and queue age by severity.
- Candidate edit/reject/defer/unknown rate by producer version.
- Updates that create no material review action.

### Safety and operations

- Egress blocks by safe category, never secret value.
- Restore/rebuild success and age of last verified backup.
- Crash-free completed runs and migration failures.
- Token/cost ceiling events and pack token reduction.

Do not collect these centrally without explicit telemetry consent. Design-partner metrics may be captured manually or through user-exported aggregate diagnostics.

## 20. Staffing and review responsibilities

For one founder, schedule explicit review days so the same person does not treat implementation confidence as independent assurance. Before public beta, obtain outside review for the security boundary and onboarding/trust UX.

Minimum responsibility map:

| Area | Implements | Required reviewer |
|---|---|---|
| Temporal/authority invariants | Core engineer | Storage/integrity peer |
| SQLite migrations/recovery | Storage engineer | Core engineer + restore drill owner |
| Git/path/symlink handling | Ingestion engineer | Security reviewer |
| Egress/credentials/secrets | Security engineer | Independent security reviewer |
| Context ranking/packs | Context engineer | Product evaluator using known-truth rubric |
| Web/MCP authorization | Full-stack/MCP engineer | Security reviewer |
| Accessibility/trust labels | Product/design | Independent user/accessibility evaluator |
| Release artifacts/migrations | Release owner | Second approver |

No person/provider/model may both generate an inferred claim and supply the review action that promotes it.

## 21. Decision and change-control rules

- A change to evidence identity, assertion semantics, temporal rules, authority lifecycle, privacy precedence, export schema, or pack warning policy requires an ADR update and migration/evaluation plan.
- A contract-breaking change requires a version increment, compatibility fixture, release note, and supported migration.
- A failing primary-risk test cannot be waived as flaky without owner, issue, root-cause hypothesis, expiry, and a compensating release block.
- Model/prompt changes are treated like code changes: versioned, evaluated, attributable, and reversible.
- User feedback can reprioritize UX/features but cannot remove a P0 integrity/privacy invariant without rescoping the product claim and updating all documents.

## 22. First 20 implementation issues

This is the recommended starting order for the implementation board:

1. `CA-001` Create workspace/toolchain/CI skeleton and dependency-direction checks.
2. `CA-002` Define versioned envelope, error taxonomy, and opaque ID/hash primitives.
3. `CA-003` Approve ADR-001–ADR-004.
4. `CA-004` Approve temporal/Git/privacy/contract ADR-005–ADR-008.
5. `CA-005` Generate known-truth, temporal, Git-edge, malicious, and secret fixtures.
6. `CA-006` Implement workspace/repository resolution and dry-run init.
7. `CA-007` Implement policy-first path classification and `.atlasignore`.
8. `CA-008` Implement SQLite migration ledger, strict schema, worker, and writer lease.
9. `CA-009` Implement immutable artifact/fragment storage and Git locators.
10. `CA-010` Implement full Git discovery with path-safe formats.
11. `CA-011` Implement staged ingestion, atomic snapshot pointer, checkpoints, cancellation.
12. `CA-012` Implement incremental commit/worktree delta including rename/delete.
13. `CA-013` Implement quick/full integrity validation and safe structured diagnostics.
14. `CA-014` Implement entity/assertion/evidence domain invariants and schema.
15. `CA-015` Implement manifest and TypeScript module/import extractors.
16. `CA-016` Implement Markdown/test extractors with coverage diagnostics.
17. `CA-017` Implement current projection and event timeline.
18. `CA-018` Implement bitemporal/supersession/conflict query engine and property tests.
19. `CA-019` Implement FTS/search, bounded map DTO, explain, deterministic overview.
20. `CA-020` Prove full-vs-incremental equivalence and M2 exit gate.

Each issue must reference the relevant requirement and risk-test IDs before work begins.

## 23. Scope-cut rules under schedule pressure

Safe candidates to move later:

- Additional languages/providers.
- Animated/custom graph layout.
- Guided tour automation (manual onboarding can precede it).
- Embeddings and semantic search.
- HTTP MCP transport if stdio satisfies design partners.
- Optional conversation import.
- Saved views, shell completions, advanced event grouping.

Unsafe cuts that block the claimed MVP:

- Claim-level provenance/authority labels.
- Candidate-only model output and independent review.
- Temporal append-only history.
- Staleness and conflict warnings.
- Policy-first ignore/secret/egress controls.
- Transactional update, validation, export, restore, and rebuild.
- Mandatory pack warnings/exclusions and hard budgets.
- Loopback/MCP capability security.
- No-model/offline functionality.

If an unsafe control cannot ship, disable the dependent feature. For example, ship no remote inference rather than inference without a secret-egress gate.

## 24. Immediate implementation handoff

The first implementation iteration should end with a narrow vertical proof:

1. `atlas init --dry-run` resolves a fixture repository and shows exact allowed/denied scope.
2. Accepted init creates a versioned SQLite workspace.
3. `atlas update --no-inference` records Git HEAD, tracked artifacts, hashes, and one supported manifest extractor in a staged transaction.
4. `atlas status --json` reports committed snapshot, counts, coverage, and validation state.
5. Repeating update is idempotent.
6. Killing update at injected checkpoints leaves the previous snapshot valid.
7. A denied symlink and seeded secret cannot enter prohibited body cache/log output.

This slice proves the architecture's hardest foundation before expanding the graph or UI.
