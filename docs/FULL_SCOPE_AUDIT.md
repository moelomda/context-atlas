# Context Atlas Full-Scope Completion Audit

Status: **candidate audit; not a release approval**
Audit date: 2026-08-14
Scope: the current worktree versus `PRODUCT_PLAN.md`, `REQUIREMENTS_TRACEABILITY.md`, `RISK_REGISTER.md`, `IMPLEMENTATION_ROADMAP.md`, and the user's stated launch objective.

## 1. Verdict

Context Atlas is a functioning local-first alpha prototype, not the completed product described by the plan and not yet supported by evidence sufficient for a public-beta claim. The useful vertical slice is real: a Git repository can be initialized and scanned, a structural map/timeline/overview can be queried, proposals can be approved or rejected, bounded packs can be generated, and the same data is exposed through a dashboard and MCP. The repository also contains a packaged plugin and recovery primitives.

The full-scope claim is not true. At this audit snapshot:

- **FRs:** 0 of 50 are proven at their complete specified scope; 46 are partial and 4 are missing. No FR remains directly contradicted after the final MCP/health pass, but no FR meets every acceptance/evidence clause either.
- **NFRs:** 0 of 18 are proven at their specified scale/platform scope; 15 are partial and 3 scale/performance NFRs are missing; none is now directly contradicted by the inspected happy-path architecture, but fault/scale/compatibility/human proof remains far below the required matrices.
- **Global controls:** 3 of 28 are strongly evidenced, 21 are partial, 3 are missing, and 1 is contradicted because stale accepted overview text can still be rendered as settled.
- **Milestones:** none of M0-M10 meets its stated exit gate; M0-M7 are partial, and M8-M10 require external beta/adoption evidence that does not exist.
- The claim that this is guaranteed to earn **100,000 GitHub stars is impossible to prove or guarantee through engineering**. Stars are an external adoption outcome. Product quality, launch execution, community trust, timing, and continued maintenance can improve its probability, never make it certain.

The most serious blockers are not cosmetic:

1. Schema v4 now stages audit entries in an immutable SQLite outbox inside the mutation transaction; `flushLedgerOutbox` holds `BEGIN IMMEDIATE` while it fsyncs NDJSON and records immutable receipts, and `recover-ledger` reconciles committed-but-unflushed entries. Rollback and simulated post-commit recovery tests pass. There is still no true process-kill/torn-line/disk-full/two-process matrix, ingestion checkpoint/cancellation/resume, staged-current pointer, or maximum-scale recovery proof.
2. Immutable, actor-attributed bitemporal assertions now drive approved overview knowledge and are exposed through CLI, web API, read-only MCP, packs, export/import, and history/evolution reads. The lifecycle is still incomplete: no product defer/unknown/withdraw/edit commands, no complete transition/property model, no symmetric conflict resolution, and no dependency invalidation.
3. Critical packs now fail closed and require an immutable, attributed, expiring override, and tiny budgets are rejected. At the valid 500-token minimum, mandatory identity/constraint/risk/unknown sections can still be truncated instead of refusing, material exclusions lack reasons, and structured included-assertion IDs can name claims absent from Markdown. Stale/privacy fixtures, immutable pack storage/refresh, and evaluation evidence also remain absent.
4. Health now exposes a categorical verdict, safe-to-use flag, critical/warning counts and per-component evidence/freshness/reasons, while capping its compatibility score beneath degraded/blocked verdicts. A stale accepted overview can nevertheless remain the main summary without item-level stale labeling; the global degraded warning is not equivalent to marking the claim itself.
5. Canonical portable import, privacy reporting, and non-destructive retention preview now exist. Selected external document/conversation import, a real derived-index rebuild, retention deletion/tombstones, provider/egress consent, and extension interfaces remain absent.
6. The dashboard has an interactive SVG, guided briefing and filter-synchronized semantic HTML node table. It still lacks complete evidence drill-down, review/conflict workspace and independently verified rendered-browser/WCAG/screen-reader/usability results.
7. Scale, performance, broad fault injection, cross-version contract/MCP conformance, independent security, and user-study gates have no scope-matched artifacts. One schema 3→4 migration snapshot/atomicity test is useful but not a migration matrix.

## 2. Evidence policy and snapshot

### Status meanings

| Status | Meaning in this audit |
|---|---|
| **IMPLEMENTED + strong evidence** | Every acceptance clause is implemented and a current, scope-matched automated or manual artifact proves it. |
| **PARTIAL** | Useful implementation or narrow tests exist, but one or more acceptance clauses, interfaces, scales, failure modes, or proof artifacts are absent. |
| **MISSING** | No meaningful implementation of the requirement exists. Documentation or a placeholder does not count. |
| **CONTRADICTED** | Current code or observed behavior violates an explicit clause or invariant. |

Code presence alone is not strong evidence. A small-fixture test is not evidence for a 100k-file requirement, a source-regex test is not a WCAG audit, and a checksum test is not a disaster-recovery drill.

`docs/IMPLEMENTATION_STATUS.md` was regenerated after the functional freeze and now summarizes the 26-test/read-only-MCP/temporal/migration/import/component-health alpha. This audit still does not use that self-reported status as implementation evidence: every classification below is based on inspected source, tests, and observed checks. The summary must continue to be generated from and identified with the exact release commit so it cannot drift from this matrix.

### Read-only checks observed during the audit

| Check | Observed result | What it proves / does not prove |
|---|---|---|
| `npm.cmd run build` | Passed on the final audited source snapshot | Current TypeScript and asset build completed on this Windows machine. It does not prove another OS, migration, or runtime behavior. |
| `npm.cmd test` | Passed **26/26** on the final audited source snapshot in about 121 seconds | CLI (1), database/migration (2), E2E (4), ledger (3), MCP (1), portable (4), privacy (2), security (5), temporal (2), and web (2) passed on small Windows fixtures. This is a useful alpha gate, not scale/platform/full-fault/accessibility proof. |
| `npm.cmd run test:coverage` | Passed **26/26** and the enforced 85% line / 55% branch / 85% function thresholds; observed aggregate source coverage was **93.53% / 67.73% / 94.53%** | This proves broad line/function exercise of the present TypeScript implementation on the same small fixtures. Coverage is not semantic requirement, fault, scale, platform, security, or human evidence. |
| Packaging/release checks | Current `npm.cmd pack --dry-run --json` reported **90** expected entries; clean tarball install plus packaged CLI-help smoke, YAML parsing, `actionlint`, and `npm audit --audit-level=high` passed in the repository-launch pass | This supports package/repository hygiene. Dashboard/MCP runtime from the tarball, signed provenance/SBOM, and an actual GitHub-hosted workflow/release remain unproven. |
| Git state | The project was nested under the parent workspace Git root and appeared as an untracked directory when inspected | There was no immutable candidate source commit to identify. A later repository-infrastructure change must be re-audited from its final commit. |

Named tests currently concentrate on tiny TypeScript fixtures. There is no durable `verification/<commit>/<run-id>/manifest.json`, no coverage-to-requirement report, no current cross-platform execution result, no scale corpus, no fault-injection result, no accessibility report, no usability report, no pack evaluation corpus, and no signed release provenance artifact.

Primary evidence paths inspected directly (all relative to the repository root) were: ingestion/storage in `src/core/{git,ingest,database,ledger,config,ignore,security}.ts`; temporal governance in `src/core/{temporal,proposals,health}.ts`; query/contracts in `src/core/{query,contracts}.ts` and `src/cli.ts`; packs/MCP in `src/core/context-pack.ts`, `src/mcp/server.ts`, and `plugin/context-atlas/`; web in `src/web/server.ts` and `src/web/public/{index.html,app.js,styles.css}`; portability/privacy in `src/core/{portable,privacy}.ts`; and the 26 executable cases in `tests/{cli,database,e2e,ledger,mcp,portable,privacy,security,temporal,web}.test.ts`. Release evidence came from `package.json`, `scripts/`, `.github/`, the public governance files, and `docs/RELEASING.md`.

## 3. Functional requirements (FR-001 through FR-050)

### Workspace and ingestion

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-001 | P0 | PARTIAL | `previewInitialization` and CLI `init --dry-run` enumerate intended writes; `tests/cli.test.ts` asserts preview creates no `.context-atlas`. Normal init is a direct write+sync operation; there is no cross-platform before/after byte oracle, explicit acceptance record, or rejection E2E. | Freeze init contract; test preserve/reject/wrong-root cases. Depends on C-009/C-015. |
| FR-002 | P0 | PARTIAL | `getRepoStatus` now derives canonical root, repository ID, object format, branch/default branch, HEAD, dirty/shallow and special Git states; `tests/cli.test.ts` checks a SHA-1 main-branch fixture. Configuration hash persistence and wrong-repository mutation rejection are absent; no detached/SHA-256/worktree matrix exists. | Repository identity guard and fixture matrix. Depends on C-015/C-022. |
| FR-003 | P0 | PARTIAL | `listRepositoryFiles`, `getCommits`, manifest/document extraction, and scan limits exist in `ingest.ts`. The store has no full discovered/skipped inventory with per-reason oracle; code/tests/symbols are not comprehensively extracted; only a tiny fixture is tested. | Versioned discovery inventory and known-truth oracle. Depends on FR-008. |
| FR-004 | P0 | PARTIAL | New commits create idempotent commit events and file status includes rename/copy fields; removed observed entities are marked. The implementation performs a full current scan, not resumable incremental worktree ingestion; no unstable-read detection or full-vs-incremental semantic comparator is tested. | Incremental engine and V-004 matrix. Depends on FR-007/C-014. |
| FR-005 | P1 | MISSING | `src/core/portable.ts` and the CLI now import Context Atlas's own canonical export, but there is still no adapter for explicitly selected external documents or conversation summaries and no origin/consent/authority/sensitivity contract or E2E for that requirement. | Canonical human-source model before any external conversation/document import. |
| FR-006 | P0 | PARTIAL | `evidence` rows require ID/kind/locator/digest/observed time/sensitivity/metadata and use deterministic IDs; seeded secret checks cover selected stores. Extractor/version identity is absent, locators are not generally resolved and rehashed, and omission/tamper constraint coverage is incomplete. | Evidence resolver + producer/version fields + full provenance audit. |
| FR-007 | P0 | PARTIAL | `syncRepository` commits its projection and immutable ledger-outbox rows in one SQLite transaction; flush holds `BEGIN IMMEDIATE` while it fsyncs NDJSON/records receipts. `tests/ledger.test.ts` proves rollback adds no line and one committed-but-unflushed entry recovers without duplication, while E2E proves one pre-commit failure rolls back. Repeated fixture sync is mostly idempotent. There are no checkpoints, cancellation/resume, actual process-kill/torn-line/disk-full/two-process tests or full boundary matrix. | Complete V-007/T-FR-007 fault injection and resumable ingestion before reliability claims. |
| FR-008 | P0 | PARTIAL | `.atlasignore`, excluded/sensitive paths, maximum reads, root containment, symlink checks, Git argument arrays, and NUL path enumeration exist; `security.test.ts` covers basic ignore/traversal. Binary/generated classification, denied-read tripwires, race-safe symlink handling, per-reason inventory, and edge-path matrix are absent. | Policy-first inventory/tripwire suite. Depends on C-009/C-022. |

### Knowledge and time

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-009 | P0 | PARTIAL | Stored types include project, component, manifest, dependency, document, decision, narrative. Goals, features, interfaces, stores, external systems, conventions, risks, tasks, terms, and explicit unknown/extension types are not modeled. | Typed domain registry and entity golden. |
| FR-010 | P0 | PARTIAL | Legacy relationships have direction/type/confidence/evidence/active state. The new `assertions` subsystem adds evidence roles, authority/review lifecycle, valid/recorded time and immutable revisions, with interval checks. Relationships themselves remain non-temporal, and there is no predicate multiplicity/relationship-revision oracle. | Integrate assertion/relation temporal schema. Depends on FR-011/FR-014. |
| FR-011 | P0 | PARTIAL | `entity_versions` retains structural snapshots, and assertion queries select immutable revisions by valid/recorded time; approved overview and pack reads now use the accepted canonical assertion chain. Map/search/timeline still use mutable entity/relationship projections, and there is no explicit immutable committed-snapshot record/current pointer tying every projection/read to one watermark. | Complete canonical projection and add snapshot-pointer/read-consistency oracle. |
| FR-012 | P0 | PARTIAL | Git commits and approval/rejection actions create ordered events with evidence; commit insert is idempotent. Candidate creation, imports, all human annotations, affected assertions/entities, and a lifecycle-wide duplicate oracle are incomplete. | Event contract tied to immutable mutations. |
| FR-013 | P1 | PARTIAL | `queryAssertions`, `getAssertionHistory`, and `getAssertionEvolution` implement valid-time, recorded-time, history, and range/evolution reads; `tests/temporal.test.ts` checks one late-recorded revision. CLI, `/api/v1` and three MCP tools expose them. Recorded times need not be monotonic across revisions, and there is no reference temporal-model/property suite, time integration into map/explain, or complete backdated/superseded oracle. | Add reference-model property tests and time-aware map/explain contracts. |
| FR-014 | P0 | PARTIAL | `src/core/proposals.ts` now creates a proposed assertion and records accept/reject/supersede revisions; reviews require an explicit `human:` actor in the CLI. `src/core/temporal.ts` names every required lifecycle/action and enforces several boundaries. Product commands still lack defer, unknown, withdraw, and edit-and-accept; transition rules are incomplete, effective-time handling is basic, and trusted capabilities cannot distinguish a real human from a model-supplied `human:` string. | Complete lifecycle state machine, product commands, and trusted actor/capability model. |
| FR-015 | P0 | PARTIAL | Pending-proposal conflicts are preserved until explicit rejection/approval in `tests/e2e.test.ts`; `detectAssertionConflicts` preserves incompatible accepted scalar claims while exempting registered multi-valued predicates, and `tests/temporal.test.ts` checks both. There is no symmetric correction operation, interval/scope resolution UX, explicit resolution assertion, or dependent recomputation. | Add resolution revisions, dependency invalidation, and a conflict property oracle. |
| FR-016 | P0 | PARTIAL | `assertions` and `review_actions` have no-update/no-delete triggers; proposal approval writes one canonical logical chain, requires rationale when revising accepted overview knowledge, and primary overview/pack/API/MCP reads consume it. Temporal/E2E tests prove direct update refusal and one superseding overview. Low-level reviewed revisions can still omit rationale, full edit/withdraw/supersede product flows are absent, and mutable projections are not mechanically constrained to derive only from immutable revisions. | Enforce rationale/transition rules on all human paths and run V-003/T-FR-016 across projections. |

### Provenance, review, and freshness

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-017 | P0 | PARTIAL | Assertions contain evidence roles, authority, confidence, producer, lifecycle/review and valid/recorded time and are exposed through CLI/API/MCP/pack/export. Entity/map/search/timeline DTOs expose a smaller legacy subset, map nodes expose only evidence counts, extractor identity is absent, and no cross-interface metadata parity suite exists. | Complete canonical assertion metadata across every view. |
| FR-018 | P0 | PARTIAL | Text labels for confidence/status and non-color UI cues exist. The specified seven authority/health states are not independently modeled, unknown is usually prose, and reviewed versus human-authored versus derived/inferred semantics do not survive every surface. | Authority/lifecycle vocabulary and V-008. |
| FR-019 | P0 | PARTIAL | CLI can list, approve, and reject eligible proposals; it requires an attributed `human:` actor and applies evidence/conflict/revision-rationale gates. The actor is not authenticated/role-authorized, and edit-and-approve, defer, unknown, withdraw, safe grouping/bulk action, optimistic watermark and web review queue are absent. | Trusted actor/capability model and full review E2E. |
| FR-020 | P0 | PARTIAL | `review_actions` records actor, assertion/previous IDs, action, rationale/digest and time and is immutable; CLI/web/MCP history surfaces expose it, and portable v2 transfers it. Schema v4 transactionally stages the hash-ledger entry with product mutations and reconciles durable NDJSON through immutable receipts. Not every repository/knowledge mutation has before/after assertion references, review rows are not individually content-hashed, and the full mutation/tamper/secret matrix is absent. | Complete mutation manifest, hash coverage and tamper/fault suite. |
| FR-021 | P0 | PARTIAL | A newly observed commit marks the approved overview stale; time windows and repository-head health checks exist; `e2e.test.ts` checks that warning. There is no dependency frontier or rule/extractor/policy invalidation, deterministic revalidation, pack lineage, or exact cause per dependent. | Dependency records + reverse invalidator + T-STALE matrix. |
| FR-022 | P0 | PARTIAL | `getHealthReport` now returns categorical `healthy`/`degraded`/`blocked`, `safeToUse`, critical/warning counts, detailed checks, and per-component current/stale/unsupported status with reason/evidence/last-seen; E2E/web tests exercise them. The dashboard leads with the verdict/component table and caps the retained compatibility score so warnings cannot appear green. Repository/extraction/knowledge/projection dimensions and coverage denominators are still incomplete, and the score remains visually prominent. | Complete dimension/denominator model and validate interpretation with users. |
| FR-023 | P0 | PARTIAL | `health`/`validate` check SQLite, physical+virtual ledger integrity, pending outbox recovery, event coverage, repo head, age, evidence, assertion support/review, scalar conflicts, overrides, secrets, proposal conflicts and history/scan completeness; CLI uses exit 2 for critical. Supersession cycles, locator rehash, orphans, policy/stale-critical findings, migration compatibility and quick/full rule versions are absent. | Versioned validator registry and seeded finding matrix. |

### Human experience

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-024 | P0 | PARTIAL | `getOverview` and the dashboard briefing show purpose, structural components, decision documents, setup sources, risks, unknowns, and entry points with selected evidence IDs; E2E checks a subset. Users, vocabulary, boundaries, data/request flow, tests/current work, and claim-by-claim traceability are incomplete. | Known-truth overview rubric and evidence manifest. |
| FR-025 | P0 | PARTIAL | `getGraph` caps/sorts nodes and reports totals/truncation; the UI supports filters, pan/zoom, node focus/spatial keyboard movement and a filter-synchronized semantic HTML table covering every displayed node with caption, scoped headers, node actions, status/confidence/evidence and selected-row state. `tests/web.test.ts` checks source structure. Time/focus/frontier/cursor queries, evidence drill-down, a 100k-file test and rendered keyboard/screen-reader/browser proof are absent. | Bounded query contract plus scale/rendered a11y proof. |
| FR-026 | P0 | PARTIAL | Timeline is ordered, query/type-filterable, keyboard navigable, and shows commit/files/evidence counts. It lacks entity/time/authority/review filters, direct assertion/entity/evidence resolution, and grouping with drilldown. | Timeline query contract and event-evidence links. |
| FR-027 | P0 | PARTIAL | `explainEntity` resolves an ID or fuzzy entity/path and returns entity, evidence, relationships, versions, related objects and selected history. Symbols/concepts/decisions are not comprehensively indexed; dependencies/dependents/risks/unknowns are not typed sections; no temporal point or ambiguity response exists. | Symbol/index model and explain contract matrix. |
| FR-028 | P1 | PARTIAL | The interactive multi-step “90-second briefing” is a real onboarding aid. It has no checkable comprehension answers/rubric, no user correction flow, and no measured first-time-user result. Source-regex assertions in `web.test.ts` do not prove usability. | MV-001 moderated/unmoderated study and correction workflow. |
| FR-029 | P0 | PARTIAL | Local lexical ranking searches entity titles/summaries/payload and up to 1,000 events. It is not SQLite FTS; aliases, symbols, claims and evidence are incomplete, and time/type/state/sensitivity filters, match reasons, cursor and snapshot are absent. | FTS schema/search oracle/privacy/latency suite. |
| FR-030 | P0 | PARTIAL | Dashboard loading/empty/error states, textual stale/conflict warnings and pack critical warnings exist. Cross-interface unknown/stale/conflict/error/partial-index fixtures and DTO parity do not; a stale narrative can still be returned as the main overview summary without item-level status. | Shared presentation-state contract and snapshots. |

### Context packages

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-031 | P0 | PARTIAL | `buildContextPack` deterministically ranks current entities/events and enforces an explicit budget; accepted assertions are included, but globally rather than task-ranked/graph-expanded. `tests/e2e.test.ts` proves two small packs stay within 500/800-token estimates. No clean-store determinism/evaluation oracle proves task relevance or policy equivalence. | Pack corpus, graph-aware selector versions and canonical determinism test. |
| FR-032 | P0 | PARTIAL | Packs contain project, accepted temporal assertions, components/documents, decisions, tests/constraints, history, warnings, unknown guidance and evidence. Goals, interfaces, conventions, risks, conflicts and absent-section semantics are not reliably represented as mandatory typed sections, and no recall rubric exists. | Structured section schema + recall rubric. |
| FR-033 | P0 | PARTIAL | Ranking/order and character-derived cap are deterministic, evidence is deduplicated, truncation retains a safety/evidence tail, and a budget below 500 is refused. Material exclusions are only a count, identity/constraint/risk/unknown sections lack formal reservations, token estimation is approximate, and `includedAssertionIds` can name assertions omitted from Markdown by the 20-item render slice. No property corpus proves the contract. | Reserved allocator, exact exclusion manifest, renderer/selection parity, tokenizer/property tests. |
| FR-034 | P0 | PARTIAL | `buildContextPack` throws `ContextPackBlockedError` on critical health, while `createContextPackOverride` requires an attributed human, rationale, matching critical/task digest and expiry. Overrides are immutable and visibly embedded in structured/Markdown output; `tests/e2e.test.ts` proves conflict refusal, scoped override, mismatch rejection and mutation refusal. Stale is only a warning, privacy-denied input is not a critical fixture, override behavior is not exercised through every adapter, and no complete unsupported/stale/privacy matrix exists. | Complete T-FR-034/T-AUTH-003/T-PRIV-002 across CLI/API/MCP/Markdown/JSON. |
| FR-035 | P0 | PARTIAL | The object contains schema/pack ID, repository branch/HEAD, creation time, budget estimate, content hash, included entity/assertion IDs, safety/override and warnings; Markdown is embedded. Policy/selector/extractor/tokenizer versions, knowledge watermark, selected/excluded input hashes and stable JSON/Markdown golden fixtures are absent. | Canonical manifest/renderers and one-version-back fixtures. |
| FR-036 | P1 | MISSING | Packs are not persistently immutable objects and there is no refresh/compare command or input/selection/warning diff. | Finish FR-035 manifest then add lifecycle store/diff. |

### Interfaces

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-037 | P0 | PARTIAL | CLI now includes init/dry-run, sync, read-only status/overview/map/history/explain/search/evidence, safe pack/override, proposal review, temporal assertion/history/evolution, validate, explicit migration/ledger recovery, export/import preview/import, rebuild verification, privacy, retention preview, backup/restore and serve; `tests/cli.test.ts` exercises a subset. Full review lifecycle and a `context-atlas mcp` subcommand remain absent, JSON lacks one stable envelope, and dry-run/error/exit-code/state coverage is incomplete. | Run the command-by-state no-mutation/schema/envelope matrix and complete the named review/MCP surface. |
| FR-038 | P0 | PARTIAL | Server refuses non-loopback binds, uses GET/HEAD only, validates API Host as loopback, sets CSP/nosniff/referrer policy, bounds query strings/limits, and tests CSP/bind/traversal. It has no session bootstrap, origin/CSRF/rate/body framework for future mutations and lacks forged-Host/DNS-rebind/XSS-corpus/security-review evidence. | Keep web read-only or add full session controls; run T-LOCAL matrix. |
| FR-039 | P0 | PARTIAL | `/api/v1` and read-only `makeContractEnvelope` provide version/snapshot envelopes; the dashboard consumes v1 overview/graph/timeline/health/search and `tests/web.test.ts` checks the contract. CLI and web server still call storage-coupled core functions directly, legacy unversioned API routes remain, CLI JSON is not the same envelope, and no dependency/parity test prevents adapter drift. | Cross-adapter semantic and architecture tests plus contract unification. |
| FR-040 | P0 | PARTIAL | MCP exposes the seven required read functions plus assertion/history/evolution: 10 tools with versioned envelopes/schemas. `tests/mcp.test.ts` proves the exact inventory is read-only and exercises overview, temporal reads, pack and evidence through one client. Resources, cursors, response-cap/truncation cases, requested snapshots, complete warning parity and a second client are unproven. | MCP conformance and cross-interface metadata suite. |
| FR-041 | P0 | PARTIAL | The final MCP server is strictly read-only: sync/propose/review tools are absent, all 10 tools declare `readOnlyHint`, and `tests/mcp.test.ts` asserts the full inventory. This strongly proves the default boundary. The specified separately enabled candidate/update capability and trusted-host out-of-band confirmation/audit path are not implemented, so the complete conditional mutation contract is not proven. | Preserve the read-only default; design/test trusted capability grants before adding any mutation. |
| FR-042 | P1 | MISSING | No versioned extractor/analyzer/provider/redactor/exporter/validator extension ports or adapter contract suite exists. | Stabilize domain contracts before extensions. |

### Privacy, portability, and recovery

| Req | Pri | Status | Authoritative evidence and gap | Launch dependency / next proof |
|---|---:|---|---|---|
| FR-043 | P0 | PARTIAL | The implemented core has no provider/account/telemetry dependency and local fixture workflows work without model configuration. There is no network-tripwire E2E covering every named command/API/MCP operation, and optional provider behavior is absent rather than safely disabled. | No-network full workflow artifact. |
| FR-044 | P0 | PARTIAL | Sensitive path checks and common secret regexes run before selected persistence; commit text is sanitized; `.atlasignore` applies; privacy/portable output reports only safe categories/counts. Seeded tests keep one canary out of DB/ledger/pack/web/export/report. There is no model queue/egress, post-redaction scan, scanner-failure path, encoded/filename/task/import corpus, or full byte-capture audit. | V-005 corpus and fail-closed scanner gateway. |
| FR-045 | P0 | MISSING | No provider, payload preview, destination/purpose/retention display, consent record, policy-version prompt, token/cost preview, or mock-provider trace exists. | Provider-neutral port after privacy policy and credential model. |
| FR-046 | P0 | PARTIAL | Sensitive bodies are generally omitted, DB mode `0600` is attempted, the privacy report exposes whether least privilege could be verified, and seeded tests scan local outputs plus portable export for a canary. Permission-setting failure remains best-effort, Windows mode is unverifiable, encryption/credential adapters are absent, and logs/backups are not exhaustively scanned or encrypted. | Enforced/reported permission matrix plus storage encryption/credential/log-backup tests. |
| FR-047 | P0 | PARTIAL | Portable schema v2 in `src/core/portable.ts` includes configuration, reviewed entities/proposals, assertions, immutable reviews, safe evidence locators, derived collections and audit data with checksum/semantic hash. `tests/portable.test.ts` proves tamper rejection, dry-run non-mutation, clone semantic transfer/idempotence, collision refusal and repository-lineage refusal. Import deliberately selects only canonical knowledge; there is no published standalone schema/independent parser, v1 migration/import, prior-version compatibility fixture, or cross-implementation round trip. | Publish schema/minimal parser and migration/compatibility suite. |
| FR-048 | P0 | PARTIAL | Checksummed backup/restore, repository lineage/head checks and semantic comparison exist; schema upgrades now reject future/malformed versions, take a pre-migration `VACUUM INTO` snapshot and apply DDL transactionally, with a 3→4 test. `tests/portable.test.ts` proves a small approved-knowledge restore. `createRebuildVerificationReport` explicitly performs no rebuild, and restore still overwrites live files without copy-verify-swap/post-swap rollback. Maximum-scale corruption/partial/Git-rewrite/RPO/RTO and multi-version drills are absent. | Implement real deterministic rebuild and hardened swap; expand migration/disaster-recovery matrices. |
| FR-049 | P1 | PARTIAL | `previewRetention` and CLI `retention-preview` inventory protected canonical/audit/SQLite state, operator-managed exports/backups, absent model/cache classes, thresholds and aggregate candidates without paths; `tests/privacy.test.ts` proves it never deletes. Actual configurable deletion, dependency impact, audit tombstones, cache invalidation/non-resurrection and operational-log handling are intentionally unsupported. | Retention apply/tombstone engine after data-class/dependency contracts stabilize. |
| FR-050 | P1 | PARTIAL | `generatePrivacyReport` reports bounded indexed/excluded/sensitive scope, stored finding categories, storage permissions, explicit provider/egress absence, retention state and limitations without paths/secret values; CLI and `tests/privacy.test.ts` exercise it. The oracle does not fully reconcile every class/store at scale, stored-text scanning is bounded to known columns, and real provider/egress/retention histories cannot be represented or tested yet. | Full reconciliation oracle plus provider/retention event stores and compatibility fixtures. |

## 4. Nonfunctional requirements (NFR-001 through NFR-018)

| Req | Status | Evidence and reason it is not proven | Priority / dependency |
|---|---|---|---|
| NFR-001 | PARTIAL | Active entities require primary evidence; accepted assertions resolve typed support and are queried across primary views; health detects missing/invalid support. No locator resolver+rehash pass, semantic support audit, complete displayed-claim denominator, or cross-interface provenance manifest exists. | Alpha blocker; FR-006/017/023. |
| NFR-002 | PARTIAL | Assertions use content hashes, FKs, interval checks and immutability triggers; reviews, overrides, outbox and receipts are immutable. Product mutations stage audit transactionally, ledger/portable checks detect selected tampering, and 3→4 migration/future-version refusal are tested. Assertion `contentHash` excludes `recordedAt`, health does not recompute hashes/full predecessor chains or run a foreign-key audit, direct assertion writes bypass the outbox, and no comprehensive tamper/migration property suite exists. | Alpha integrity blocker; FR-016/020 and C-014. |
| NFR-003 | PARTIAL | Stable hashing/IDs/ranking exist, while timestamps/UUID mutations and unversioned extractor/policy inputs remain; no clean-store, OS, or canonical-output equivalence result exists. | Beta gate; FR-004/031/035. |
| NFR-004 | MISSING | No 100k-file/20k-commit reference fixture or valid p95 update benchmark exists. | Public-beta gate after true incremental ingestion. |
| NFR-005 | MISSING | No maximum-scale randomized latency distribution or query-plan artifact exists. | Public-beta gate after FTS. |
| NFR-006 | MISSING | No 100k/20k/250k/1m scale fixture or OOM/invariant report exists. Current defaults even cap scan/history below or differently from parts of this target. | Public-beta gate. |
| NFR-007 | PARTIAL | A committed projection plus ledger outbox is recoverable and rollback does not leak an external entry in `tests/ledger.test.ts`; the prior snapshot remains readable around the simulated boundary. There is no actual killed-process/partial-line/disk-full/two-writer matrix, checkpoint/cancellation/resume mechanism, or large-run duplicate oracle. | Immediate reliability gate; C-014/V-007. |
| NFR-008 | PARTIAL | Small checksummed backup/restore and canonical clone-import tests preserve approved assertions/reviews. There is no real derived rebuild, maximum-scale corruption/Git-rewrite drill, timed last-human-mutation RPO, or four-hour RTO artifact. | Beta recovery gate. |
| NFR-009 | PARTIAL | Loopback refusal, API Host validation and CSP exist; cross-OS listener inspection, complete Host/origin/session/CSRF/rate tests and security review do not. HTTP currently exposes no mutation routes. | Alpha security gate before any web writes. |
| NFR-010 | PARTIAL | No provider/telemetry client exists; the privacy report explicitly records zero configured providers/egress attempts and local outputs pass a seeded-secret scan. There is still no network tripwire or byte-capture proof for every workflow, and path/identifier handling is not exhaustively audited. | Every release; FR-043-045. |
| NFR-011 | PARTIAL | Semantic HTML, skip link, labels, keyboard graph navigation, text states, reduced-motion/contrast CSS and an equivalent filter-synchronized semantic node table exist. Source tests check its caption/scoped-header/table CSS contract. There is no rendered-browser automated WCAG report, screen-reader/keyboard script result, focus/contrast audit or complete-flow accessibility evidence. | Public-beta gate; FR-025/MV-004. |
| NFR-012 | PARTIAL | Node 24 is declared and Git accepts 40-64 hex hashes; one Windows SHA-1 fixture passes. No current macOS/Linux CI evidence or SHA-256/unusual-path/process matrix exists. | Public-beta gate. |
| NFR-013 | PARTIAL | Portable v2 is open JSON with version/checksum/semantic hash, v1 can be verified, and an Atlas-to-Atlas clone round trip is tested. No published standalone schema/independent parser, v1 migration/import, previous-version fixture or cross-implementation readability result exists. | Beta gate; FR-047. |
| NFR-014 | PARTIAL | Ingestion records a run ID/status and versioned API/MCP envelopes carry request IDs. There is no shared structured diagnostic/log schema, request/run phase correlation throughout, diagnostic-bundle preview, or secret/body scan result. | Alpha operations requirement. |
| NFR-015 | PARTIAL | Core functions are separated, read services can use read-only storage, and the CI definition now enforces 85% line / 55% branch / 85% function source coverage (independently observed at 93.53% / 67.73% / 94.53%). Schema v4 has a pre-migration snapshot, transactional DDL and one 3→4/future-version test. Domain/storage/application concerns remain coupled, there is no architecture dependency test/in-memory domain suite, rollback is snapshot recovery rather than a tested migration path, and no multi-version/corrupt migration matrix exists. | Release gate before broader schema evolution. |
| NFR-016 | PARTIAL | CLI help/quick-start material and the guided briefing support the named first-run flow. No first-time participant evidence proves init preview/update/overview/safe pack without external docs, facilitator help or hidden recovery steps. | Alpha/manual usability gate. |
| NFR-017 | PARTIAL | Local pack output enforces a 500-20k estimated-token cap and refuses undersized requests. There is no provider usage, per-run/day cost ceiling, dry-run estimate, cache key, overrun simulation or hard-stop call ledger. | Required with FR-045/provider feature. |
| NFR-018 | PARTIAL | CLI/pack/export/API/MCP carry several explicit versions and database future versions fail closed, but there is no previous-minor contract fixture, schema-diff review, or compatible migration/error matrix across those five public contracts. Database migration alone does not complete this requirement. | Public-beta and every subsequent release. |

## 5. Global risk controls (C-001 through C-028)

| Control | Status | Evidence and unresolved control gap | Priority / dependency |
|---|---|---|---|
| C-001 | PARTIAL | Evidence/confidence/source/times exist on entities, while assertions add producer, authority, lifecycle, review, valid/recorded time and typed evidence roles and now appear in major surfaces. Extractor/policy identity, locator verification and all-surface claim parity remain incomplete. | P0; FR-006/017. |
| C-002 | PARTIAL | Accepted proposal knowledge produces immutable assertion/review revisions, and mutation audit entries are transactionally staged in an immutable outbox before durable ledger reconciliation; temporal/E2E/ledger/portable tests exercise narrow paths. Entity/proposal rows remain mutable projections, direct assertion writes bypass the ledger, and comprehensive record/hash/supersession validation is incomplete. | P0 integration/integrity blocker. |
| C-003 | PARTIAL | Candidate assertions are separate from accepted canonical assertions; proposal review requires a CLI `human:` actor, MCP has no approval tool, and inferred producer self-review is rejected. Trusted-host identity is not established, full lifecycle capabilities are absent, and direct library approval still defaults an actor. | P0; trusted actor/lifecycle model. |
| C-004 | PARTIAL | Proposal evidence IDs must exist locally, but no model-output schema/role allowlist or fabricated-batch atomic rejection pipeline exists. | M7 provider dependency. |
| C-005 | PARTIAL | Repository changes stale one overview and health compares HEAD/time; no dependency graph/frontier exists. | P0; FR-021. |
| C-006 | PARTIAL | SQLite/physical+virtual ledger/evidence/assertion/override/health validation and one migration/future-version check exist; full provenance resolution, supersession cycles, content-hash recomputation, temporal properties, policy/multi-version migration and release exit rules do not. | P0; FR-023. |
| C-007 | PARTIAL | Overview-first UI, bounded SVG, filters, keyboard nodes and an equivalent synchronized semantic table exist. Frontier/cursor semantics, 100k behavior and rendered accessibility/usability results remain absent. | P0; FR-025. |
| C-008 | PARTIAL | Pack rank/cap/safety tail, assertion inclusion and tiny-budget refusal exist; mandatory typed-section reservations, material exclusion reasons, selector manifest/evaluation and tokenizer oracle do not. | P0; FR-031-035. |
| C-009 | PARTIAL | Ignore/path/sensitive/symlink/size checks exist; full pre-read classification and tripwire coverage do not. | P0; FR-008/044. |
| C-010 | MISSING | No pre/post-redaction remote-egress gateway or scanner-failure-closed path exists. | M7 prerequisite. |
| C-011 | MISSING | No egress preview, scoped consent, provider allowlist or egress audit exists. | M7 prerequisite. |
| C-012 | IMPLEMENTED + strong evidence | There is no model/provider/telemetry path; the HTTP server defaults to loopback and rejects non-loopback binding; `web.test.ts` proves refusal on the current platform. Re-audit when any provider or HTTP transport is added. | Preserve as a regression gate. |
| C-013 | PARTIAL | Versioned checksummed export, canonical transactional import, semantic hash, backup/restore, repository-lineage checks and a protected 3→4 migration snapshot exist with small tests. A real deterministic derived rebuild, prior-version contract migration, encrypted export and full disaster-recovery proof do not. | P0; FR-047/048. |
| C-014 | PARTIAL | Ingestion uses `BEGIN IMMEDIATE`; schema v4 stages immutable audit outbox rows with the mutation, and flush holds another immediate transaction while it fsyncs external lines and records immutable receipts. Rollback/no-append and one committed/unflushed recovery are tested. No explicit staged-current pointer, checkpoint/resume/cancellation or true process-kill/disk-full/torn-line/two-process matrix exists. | Highest-priority remaining reliability proof. |
| C-015 | PARTIAL | Project payload/envelopes include repository identity, HEAD and ledger-head watermark; sync projection and audit watermark commit together in SQLite. There is no explicit immutable snapshot record/current pointer or reader watermark consistency oracle across every adapter. | P0; FR-011. |
| C-016 | CONTRADICTED | Critical conflicts block packs, and health now becomes categorically degraded with component reasons; nevertheless a stale accepted overview can still render as the main settled summary without item-level stale status. A global degraded warning is not claim labeling, privacy-denied pack behavior is unproven, and this violates the control's “never rendered as settled fact” rule. | P0 false-authority blocker. |
| C-017 | PARTIAL | Dynamic dashboard values are escaped and CSP forbids inline execution; no provider untrusted-content boundary/injection corpus exists. | P0 web, M7 inference. |
| C-018 | IMPLEMENTED + strong evidence | MCP exposes exactly 10 read-only tools; synchronization, proposals and review are absent and CLI-only. `tests/mcp.test.ts` asserts the exact inventory and `readOnlyHint` on every tool. Re-audit this control before introducing any optional mutation capability, which would require trusted-host enablement/confirmation. | Preserve as an agent-facing regression gate. |
| C-019 | PARTIAL | Loopback, Host validation, CSP and read-only HTTP are present; no session/origin/CSRF/rate framework or full attack suite exists. | Required before web mutation. |
| C-020 | PARTIAL | Pack token cap exists; provider cost ceilings, dry-run usage and safe cache are absent. | M7; NFR-017. |
| C-021 | MISSING | There is no redacted structured diagnostic subsystem or diagnostic-bundle scan. | Alpha operations. |
| C-022 | PARTIAL | Git uses argument arrays/NUL paths and root/symlink checks; unusual path/SHA-256/merge/sparse/submodule/LFS and race tests are absent. | P0/Beta compatibility. |
| C-023 | PARTIAL | Lockfile, few dependencies, MIT/security/contributor/release docs, pinned-action CI/CodeQL/dependency-review and a tag release workflow now exist. They have not run on an immutable candidate commit; SBOM/signing/provenance, protected repository settings and extension trust review are not proven. | GitHub prerelease gate. |
| C-024 | PARTIAL | Pending/conflicting proposal counts and recommendations exist; no risk-ranked grouped queue, defer/unknown actions or SLA. | Alpha usability. |
| C-025 | PARTIAL | A disposable known-truth-ish fixture and one secret canary exist; temporal, attack, scale, multi-platform and human evaluation corpora do not. | Foundation for every risk claim. |
| C-026 | PARTIAL | `previewRetention` provides aggregate impact preview and explicitly protects canonical/audit history; `tests/privacy.test.ts` proves non-deletion. Apply/delete, dependency impact, tombstones and cache non-resurrection controls do not exist. | P1; FR-049. |
| C-027 | IMPLEMENTED + strong evidence | `createContextPackOverride` stores attributed human/reason/task/critical digests and expiry; database triggers prevent update/delete; resulting structured safety and Markdown visibly embed the override. `tests/e2e.test.ts` proves refusal, scoped use, prominent output and mutation rejection. Preserve and extend this exact control across adapters. | Current core/CLI control is strong; re-audit any new pack surface. |
| C-028 | PARTIAL | A revised accepted overview creates a superseding immutable canonical assertion with actor/rationale and current overview/pack reads select it; `tests/e2e.test.ts` checks one chain. There is no user correction/withdraw command, bad-claim quarantine, or dependent projection/pack invalidation sweep. | P0; FR-016/020/021. |

## 6. Risk-level residual audit (R-001 through R-017)

| Risk | Status | Current mitigation and why residual remains launch-blocking |
|---|---|---|
| R-001 Summary hallucination | PARTIAL | Structured evidence and pending proposals help, but no complete claim manifest, semantic support audit, model-output gate, withdrawal sweep or known-truth hallucination suite exists. |
| R-002 Stale context | PARTIAL | HEAD/time checks and coarse overview staleness exist; dependency/rule/policy invalidation and immutable pack refresh do not. |
| R-003 Information overload | PARTIAL | Node/token caps and a semantic table alternative exist; no large-fixture frontier/cursor, grouping, dedup corpus or usability result exists. |
| R-004 False authority | CONTRADICTED | Critical packs fail closed and health now has categorical/component states, but stale accepted overview text can still render as the settled summary without claim-level stale labeling. That directly violates C-016; privacy-denied handling and seven-state interface parity also remain incomplete. |
| R-005 Sensitive leakage | PARTIAL | Local omission/redaction, portable-output sanitization and privacy-report scans cover a canary; exact remote egress, scanner failure, diagnostics, encrypted backups and the full adversarial corpus are untested. |
| R-006 History corruption | PARTIAL | Immutable canonical assertions/reviews, transactional audit outbox with serialized durable flush, portable checksums/import, migration snapshots and backups cover important paths. Direct assertion writes bypass the ledger, validators do not recompute every assertion/supersession chain, and process-kill/torn-line/corruption/multi-version/rebuild matrices are absent. |
| R-007 Token waste/cost | PARTIAL | Packs are bounded and tiny budgets refuse; no target tokenizer, section guarantee, exclusion manifest, provider cost/cache control or 50%/90% evaluation exists. |
| R-008 Prompt injection | PARTIAL | Escaping/CSP and server-side MCP boundaries help; no inference prompt/schema pipeline or malicious-content corpus is exercised. |
| R-009 Loopback/MCP abuse | PARTIAL | Loopback/Host/read-only HTTP and an exactly read-only 10-tool MCP inventory close the current mutation path. Full forged-Host/origin/rate/oversize T-LOCAL coverage, two-client conformance and a future trusted capability mechanism remain absent. |
| R-010 Supply chain | PARTIAL | Minimal dependencies and lockfile exist; signing, SBOM/provenance, reproducibility, protected publish and quarantine drills are unproven. |
| R-011 Store failure/data loss | PARTIAL | Verified backups, pre-restore recovery copies, canonical clone import, protected transactional schema migration and serialized recoverable ledger outbox improve resilience. Copy-verify-swap, disk-full/real process-kill/torn-line/two-process/corrupt-derived/max-scale drills and a real rebuild remain absent. |
| R-012 Git/filesystem edges | PARTIAL | Safe invocation and some boundary checks exist; the named Git edge-case matrix is largely absent. |
| R-013 Review fatigue | PARTIAL | Deterministic observations and pending counts exist; queue ranking/grouping/defer/unknown/noise studies do not. |
| R-014 Misleading metrics | PARTIAL | Health now leads with categorical verdict/safety/counts and component evidence/freshness/reasons, and a warning/critical caps the retained compatibility score below healthy-looking ranges. The score ring is still prominent, dimension/coverage denominators are incomplete, and no metric-interpretation study exists. |
| R-015 Performance/scale | PARTIAL | Responses are capped; no incremental backpressure/cancellation, FTS, query-plan or published benchmark exists. The complete 26-test tiny-fixture suite took about 121 seconds on this Windows workspace, which is not a scale result. |
| R-016 Provider drift/lock-in | PARTIAL | The deterministic core works without a provider; the provider-neutral adapter/version/cache/evaluation mechanisms are missing. |
| R-017 Damaging change from wrong context | PARTIAL | Critical conflicts now block packs absent a scoped human override, and packs retain navigation-only, tests/constraints, unknown and evidence guidance. Stale/privacy criticality, mandatory section coverage, pack mismatch hooks and downstream coding evaluation are absent. |

## 7. Roadmap milestones and post-MVP feature promises

### Milestones M0-M10

| Milestone | Status | Exit-gate evidence and blocking dependency |
|---|---|---|
| M0 Foundation | PARTIAL | Build/toolchain/contracts/docs and three-OS CI/release workflow definitions exist. No immutable candidate commit or successful workflow run was available; approved ADR files, compatibility fixtures, executable risk inventory and architecture boundary test were not proven. |
| M1 Evidence kernel | PARTIAL | Init/status/evidence scanning work; schema v4 adds transactional ledger staging, durable reconciliation, recovery visibility and narrow rollback/post-commit tests. Resumable checkpoints/cancellation, explicit writer lease/current pointer, denied-read tripwire, real phase-kill/disk-full/two-writer tests and clean rebuild equivalence remain absent. |
| M2 Temporal knowledge | PARTIAL | Immutable bitemporal assertions now drive approved overview/pack knowledge and have CLI/API/MCP history/evolution surfaces; scalar conflict and multi-valued behavior have narrow tests. Semantic analyzers/FTS, temporal relationships, reference-model property tests, incremental equivalence, full provenance and the unknown/coverage model are missing. |
| M3 Governance/recovery | PARTIAL | Primary proposal review creates actor-attributed immutable canonical revisions, mutation audit uses a transactional outbox, conflicts fail closed, portable v2 imports reviewed knowledge transactionally, schema migration snapshots exist, and backup/restore is tested. Full lifecycle/correction, dependency invalidation, real rebuild and corruption/Git-rewrite/scale drills remain absent. |
| M4 CLI MVP | PARTIAL | The CLI now has most named read/review/temporal/import/privacy/migration/recovery functions, read paths are read-only, and one packaged CLI E2E passes. It still lacks full review and a CLI MCP subcommand, common versioned JSON envelopes, complete dry-run/exit/state coverage, no-model usability evidence and the recovery E2E matrix. |
| M5 Web orientation | PARTIAL | A polished overview/briefing/SVG/timeline/health shell consumes `/api/v1` DTOs and includes a filter-synchronized semantic graph table. Explain/evidence/review/conflict flows, legacy-route removal, rendered WCAG/screen-reader/manual evidence and the full loopback attack suite are absent. |
| M6 Context packs/MCP | PARTIAL | Packs include accepted assertions, reject tiny budgets, fail closed on critical findings and support immutable scoped overrides; stdio MCP now exposes 10 strictly read-only versioned tools. Mandatory pack sections/exclusions, manifest lifecycle, safety fixture breadth, evaluation, response caps/cursors, resources, two clients, optional trusted mutation capabilities and previous-version fixtures are missing. |
| M7 Optional inference/privacy | PARTIAL | A secret-safe privacy report and non-destructive retention inventory exist and explicitly report that provider/egress capability is absent. No provider-neutral inference adapter, exact egress preview/consent gateway, model candidate pipeline, injection suite, cost controls or retention apply path exists. |
| M8 Design-partner alpha | MISSING | No 5-10 user cohort, protocol data, thresholds, incident tabletop or migration rehearsal exists. |
| M9 Private/public beta | MISSING | No scale/accessibility/compatibility/security-review/signing/release-candidate evidence meets the public-beta gate. |
| M10 GA | MISSING | The mandatory six-week beta, two upgrades, 25 active repositories, independent security closure and full verified ledger cannot exist yet. This is inherently time- and adoption-dependent. |

### Explicit P1/post-MVP backlog from the roadmap

| Planned feature | Status | Evidence / dependency |
|---|---|---|
| Additional language analyzers | MISSING | Only language-neutral structure and selected manifests/docs; requires extension/analyzer contracts. |
| Reviewed entity merge/split and continuity | MISSING | No entity lineage operations; requires immutable assertion model. |
| Rich data/request-flow inference | MISSING | No flow model; requires symbols/interfaces and evidence coverage. |
| Issue/PR/ADR imports with source authority | PARTIAL | ADR-like repository documents are recognized, but no import adapter/origin/consent model exists. |
| Historical branch/release views | MISSING | Timeline is current reachable linearized history, not branch/release temporal views. |
| IDE sidebar / explain selection | MISSING | No IDE integration exists. |
| Codex/other coding-tool plugin | IMPLEMENTED + strong evidence | Self-contained Codex plugin and copied-runtime MCP integration test exist; revalidate packaged artifact on the final release commit. |
| Pre-task freshness/conflict hook | MISSING | No hook or persisted pack lifecycle exists. |
| Post-change update/review hook | MISSING | No hook/watcher exists. |
| Multi-repository workspace | MISSING | Single repository is hard-scoped. |
| Signed canonical-knowledge synchronization | MISSING | No synchronization/identity/signature protocol exists. |
| Roles/review/organization policy | MISSING | Actor strings are now recorded, but no authenticated identity, role, organization policy or authorization model exists. |
| Conflict-free offline review synchronization | MISSING | No replication/CRDT protocol exists. |
| Optional local embeddings | MISSING | No embedding index/provider exists. |
| Evaluation-driven graph-learning ranker | MISSING | Ranking is fixed lexical/structural. |
| Task templates with acceptance/test checklists | MISSING | No template model/UI exists. |

The roadmap's explicit non-goals—autonomous approval/code writes, silent cloud upload, surveillance analytics, and proprietary-only export—remain appropriately absent and should stay absent.

## 8. Product outcomes and manual gates

| Planned outcome/gate | Status | Required evidence still missing |
|---|---|---|
| Newcomer orientation median under 10 minutes / MV-001 | MISSING | Participant script, sample, timings, correctness and evidence-resolution results. The briefing UI is not a study. |
| At least 98% claim evidence resolution | PARTIAL | Structural primary-evidence check exists; complete displayed-claim denominator and semantic support sample do not. |
| Zero unlabelled generated rationale | PARTIAL | Current automatic narratives remain proposals, but no model pipeline or all-surface lifecycle audit exists. |
| Fresh/stale within 60 seconds | MISSING | Reference repo/machine, repeated runs and p95 distribution. |
| At least 50% token reduction with at least 90% rubric facts | MISSING | Versioned corpus, baselines, tokenizer method, selection manifests and per-task metrics. |
| Rebuild semantic equivalence | MISSING | Clean Git+human export rebuild and canonical semantic diff. |
| Zero seeded secret egress | MISSING | Byte-capturing mock provider covering code/path/commit/task/import/encoded/scanner-failure inputs. Local non-retention tests are not egress evidence. |
| At least 80% trust-state classification / MV-002 | MISSING | User sample and seven-state confusion matrix in visual/plain/accessibility modes. |
| MV-003 review burden | MISSING | Normal/mechanical/semantic update study and bounded review-time result. |
| MV-004 keyboard/screen-reader | MISSING | The source now contains an equivalent, filter-synchronized semantic table for graph nodes, but no manual keyboard/screen-reader script result exists across every core flow. |
| MV-005 incident tabletop | MISSING | Signed scenario record for false claim, secret egress, corrupted history and release compromise. |
| MV-006 disaster recovery | MISSING | Maximum-scale previous-version corruption/Git-rewrite restore with RPO/RTO and semantic comparison. |

## 9. User-objective audit

| User objective | Status | Current evidence and honest conclusion |
|---|---|---|
| A detailed plan for the project | IMPLEMENTED + strong evidence | Product, architecture, risk, roadmap and traceability documents form a detailed plan. This does not mean their features are shipped. |
| A start-to-now project mind map understandable with no prior knowledge | PARTIAL | Overview, briefing, bounded structural map and reachable commit timeline exist. History is capped, shallow history can be unavailable, semantics/rationale are sparse, data flow/vocabulary/users are incomplete, and no newcomer has been measured. |
| Durable high-level context for an LLM | PARTIAL | Context packs and 10 strictly read-only MCP tools carry evidence, accepted temporal assertions, versioned snapshots and a navigation-only boundary; critical packs fail closed unless an immutable scoped human override exists. Required section/exclusion manifests, durable pack lifecycle/refresh, all-risk safety coverage and relevance/downstream evaluation are incomplete. |
| Ship every feature in the plan | CONTRADICTED | Four FRs, three scale/performance NFRs, three controls, M8-M10 and nearly all explicit post-MVP features have no implementation. The claim is false even though no FR is now directly contradicted; C-016 and V-006 still expose concrete authority/pack-safety violations. |
| A “very cool interactive UI” | PARTIAL | The UI is visually ambitious and interactive (briefing, responsive navigation, search, SVG pan/zoom/filter/focus, synchronized semantic node table, timeline navigation, health filtering). “Cool” is subjective and unprovable; complete product flows, rendered browser QA, usability and accessibility evidence are missing. |
| Iteratively test until launch confidence is justified | PARTIAL | The final audited build and all 26 current tests pass. Required full crash/disk/scale/security/accessibility/usability/compatibility/rebuild/provider suites and requirement-linked verification artifacts still do not exist, so this supports an experimental alpha rather than public-beta confidence. |
| Launch on GitHub | PARTIAL | License, README, changelog, conduct, contributing, security/release guides, issue/PR templates, Dependabot, pinned-action CI/CodeQL/dependency review, tag release workflow, a current 90-entry package boundary and clean packaged CLI-help smoke exist. A final independent Git commit, successful hosted workflows, repository security settings, packaged dashboard/MCP runtime smoke, screenshots/demo, provenance/SBOM and release-candidate audit must be verified from the actual GitHub repository. |
| Be 100% sure it will get 100k GitHub stars | MISSING / IMPOSSIBLE TO PROVE | No test can guarantee a future social adoption number. Replace this with measurable leading indicators: activation, successful orientation, weekly retained repos, pack utility, issue response time, contributor conversion, release reliability and organic star velocity. |

## 10. Smallest coherent launch-critical slices

Work should proceed in this dependency order. Shipping cosmetic breadth before Slice 1 would compound risk.

| Slice | Included work | Depends on | Exit evidence |
|---|---|---|---|
| **0. Reproducible GitHub prototype** | Independent clean Git repository/commit; CI on Windows/Linux/macOS Node 24; lint/type/build/test/package; packed fresh-install CLI+web+MCP smoke; dependency/SBOM checks; honest alpha release notes; screenshots/demo; issue/PR/security templates. | Current vertical slice. | Required checks green on the exact release commit; tarball checksum and install smoke artifact; no untracked/generated secrets. |
| **1. Trustworthy history kernel** | Build on the schema-v4 outbox with explicit writer ownership, staged/current snapshot semantics, checkpoints/cancellation/resume, disk-full/real process-kill/partial-line recovery, transactional audit for direct assertion writes, repository-identity mutation guard and a multi-version migration matrix. Preserve current read-only services and immutable assertion/review/outbox records. | Must precede stronger history/review/pack claims. | V-002, V-003, V-004 and V-007 plus T-STORE/T-HIST matrices; previous snapshot always readable and every read-command byte hash unchanged. |
| **2. Safe governance and pack contract** | Complete lifecycle/correction and conflict resolution; dependency staleness; make component health/coverage denominators primary and de-emphasize the retained aggregate compatibility score; validator registry; mandatory pack sections/exclusion reasons; extend fail-closed/override behavior to stale/unsupported/privacy fixtures and every adapter; immutable pack manifest/refresh diff; cross-interface authority metadata; MCP mutation capabilities absent by default and granted/confirmed by a trusted host. | Slice 1 canonical model. | V-001/V-006/V-008, all P0 AUTH/STALE/TOK/ACT cases and golden CLI/API/MCP/export parity. |
| **3. Complete local human product** | Known-truth overview; FTS/explain/timeline filters; evidence resolver UI; finish and render-verify the existing SVG/table map pair; web review/conflict workspace; onboarding rubric; responsive/rendered/accessibility hardening. | Slice 2 DTOs and states. | FR-024-030 contracts, WCAG 2.2 AA report, MV-001/MV-002/MV-004, large bounded-map test. |
| **4. Portability and privacy beta** | Build on portable v2 import/privacy preview with a real deterministic rebuild, migrations/previous-version fixtures, retention apply+tombstones, provider-neutral optional inference, exact egress preview/consent, secret byte-capture, cost/injection gates and extension ports. | Slices 1-3, stable schemas. | V-005, full PRIV/INJ/PROV tests, independent import/export/rebuild semantic round trip, prior-version restore. |
| **5. Public-beta scale and adoption** | 100k/20k/250k/1m fixture, performance/RPO/RTO, threat review/pen test, signed release provenance, design-partner studies and two RC upgrades. | All prior slices. | Every P0 row verified; NFR-004-013/018 artifacts; M8/M9 thresholds. |

## 11. What cannot be proven inside this worktree

The following require external or time-based evidence and must not be converted into code-complete checkboxes:

- 100,000 GitHub stars or any guaranteed adoption outcome;
- newcomer comprehension, trust calibration, “coolness,” review burden, and utility without real participants;
- three-platform behavior without CI/runners on those platforms;
- GitHub branch protection, private vulnerability reporting and trusted-publish settings without the actual repository configuration;
- independent security review or penetration-test closure without an independent reviewer;
- six weeks of public beta, two successful real upgrades, 25 active repositories, contributor/community health, and incident response maturity;
- provider retention/deletion behavior beyond what a provider contract and observed API can support.

## 12. Named CLI workflow audit

The roadmap names a complete command surface. Aliases do not fill missing semantics.

| Planned command | Current state | Status / missing proof |
|---|---|---|
| `init --dry-run` | Implemented; returns a write preview and CLI test proves no Atlas directory is created. | PARTIAL: preserve/reject/cross-platform filesystem oracle absent. |
| `init` | Implemented; writes config then syncs. | PARTIAL: no explicit accepted-plan record or interruption/recovery E2E. |
| `update` / `sync` | Implemented. | PARTIAL: not incremental/resumable/cancellable/crash-atomic. |
| `status` | Implemented read-only with repository/store/health identity. | PARTIAL: no stable common CLI envelope, byte-level no-mutation test or wrong-repository mutation guard. |
| `migrate` | Implemented explicitly; schema 3→4 takes a protected snapshot and DDL is transactional. | PARTIAL: one narrow migration only; no rollback command, prior/minor matrix or corrupt/disk-full cases. |
| `overview` | Implemented. | PARTIAL: overview rubric and metadata parity incomplete. |
| `map` | Implemented as JSON; web SVG consumes graph data. | PARTIAL: no focus/time/cursor/frontier/table contract. |
| `history` / `timeline` | Implemented for event text filter/limit. | PARTIAL: no entity/time/authority/review/as-of CLI filters. |
| `explain` | Implemented for entity/fuzzy path. | PARTIAL: no ambiguity contract, symbol depth or temporal option. |
| `search` | Implemented lexical/local. | PARTIAL: no FTS/filter/cursor/snapshot/match-reason contract. |
| `pack` | Implemented Markdown/JSON selection over entities/events/accepted assertions; refuses tiny budgets and critical health absent a matching override. | PARTIAL: mandatory section/exclusion manifest, stale/privacy block fixtures, stable full manifest and evaluation are incomplete. |
| `pack-override` | Implemented with required human actor, rationale, optional task scope and expiry; immutable record is embedded in output. | PARTIAL command proof: core E2E is strong, but adapter/help/error/expiry matrix is incomplete. |
| `review list` | Available indirectly as `proposals`. | PARTIAL: candidate types/metadata/risk ordering incomplete. |
| `review approve` | Available as `approve`; CLI requires `--actor human:<id>` and writes a canonical accepted revision. | PARTIAL: no optimistic watermark/effective-time option, role authorization or full state matrix. |
| `review edit` | Not available through product command. | MISSING. |
| `review reject` | Available as `reject`; CLI requires a human actor and writes a rejected assertion revision. | PARTIAL: no role authorization, optimistic watermark or full state matrix. |
| `review defer` | Not available through product command. | MISSING. |
| `review unknown` | Not available through product command. | MISSING. |
| `review withdraw` | Not available through product command. | MISSING. |
| `validate` | Implemented as health checks, exit 2 on critical. | PARTIAL: named validator rule matrix/modes absent. |
| `recover-ledger` | Implemented; reconciles immutable committed outbox entries to fsynced NDJSON and receipts. | PARTIAL: simulated boundary is tested, but real process-kill/partial-write/disk-full recovery matrix is absent. |
| Temporal assertion reads | `assertions`, `assertion`, `assertion-history`, and `assertion-evolution` are implemented. | PARTIAL: no reference-model matrix or integration into every planned read command. |
| `export` / verify | Implemented portable v2 checksum/semantic-hash export and verification. | PARTIAL: published independent schema/parser/migration/compatibility evidence is incomplete. |
| `import` | `import-preview` and all-or-nothing canonical `import` with dry-run, lineage/head/collision gates are implemented. | PARTIAL: legacy migration, independent parser, full derived rebuild and CLI state matrix are absent; mismatch overrides are not actor-audited. |
| `rebuild-verify` | Implemented as an explicitly verification-only semantic comparison. | PARTIAL: it correctly does **not** perform the required derived-index rebuild. |
| `privacy` | Implemented bounded privacy report. | PARTIAL: no real provider/egress/retention event history and no full reconciliation oracle. |
| `retention-preview` | Implemented aggregate, non-destructive preview. | PARTIAL: apply/delete/tombstone/non-resurrection behavior is absent. |
| `backup` / verify | Implemented. | PARTIAL: identity/scale/fault matrix incomplete. |
| `restore` | Implemented with exact token, verified source and pre-restore recovery backup. | PARTIAL: safe copy-verify-swap/post-swap rollback, rebuild/migration/Git-rewrite/scale drill incomplete. |
| `serve` | Implemented loopback web server. | PARTIAL: complete security/a11y/product-surface gates absent. |
| `MCP` command | Dedicated `context-atlas-mcp` package binary exists and exposes 10 strictly read-only tools, but no `context-atlas mcp` subcommand. | PARTIAL: roadmap command mismatch, resources/cursors/caps/two-client conformance and optional trusted capability design remain. |

## 13. High-risk invariants V-001 through V-008

| Invariant | Status | Current evidence and decisive gap |
|---|---|---|
| V-001 active-claim support | PARTIAL | Entity and assertion structural evidence checks exist. No complete active canonical projection resolution+rehash and semantic support review across every rendered claim exists. |
| V-002 no self-approval | PARTIAL | MCP has no approval; CLI approval requires an attributed `human:` actor; the assertion API rejects an inferred producer reviewing itself. `human:` is only a string convention, trusted-host identity/roles are absent, and the library approval function has a default actor. |
| V-003 append-only history | PARTIAL | Assertion/review/outbox/receipt triggers and temporal/E2E/ledger tests prove the primary approved-overview history is revision-only and product mutations stage audit transactionally. Mutable projections are not mechanically bound to assertions, direct `recordAssertionRevision` has no ledger entry, and comprehensive phase-kill/content-hash/supersession tamper matrices are absent. |
| V-004 incremental equivalence | MISSING | No real incremental engine, generated rename/delete/copy/merge/config/rule matrix, canonical comparator or replay artifact. |
| V-005 secret non-egress | MISSING | Local canary non-retention tests exist, but there is no provider byte-capture across all sources/scanner failure/output boundaries. |
| V-006 pack safety/budget | CONTRADICTED | Hard cap/tiny refusal, safety tail, evidence retention, critical-conflict refusal and immutable scoped override work. At the 500-token minimum, identity/constraint/risk/unknown sections may be truncated rather than generation refusing; material exclusions lack reasons, and structured `includedAssertionIds` can include facts omitted from Markdown. This violates the invariant's mandatory-section-or-refuse and exclusion-report clauses. |
| V-007 crash-safe current projection | PARTIAL | Schema v4 commits projection and immutable audit outbox together and serializes durable flush/receipt under `BEGIN IMMEDIATE`; rollback/no-append and committed/unflushed reconciliation tests pass and health distinguishes recoverable pending entries. There is no actual killed-process test at each phase, torn-line/disk-full/two-process coverage, checkpoint/resume or explicit current-snapshot pointer oracle. |
| V-008 cross-interface authority | PARTIAL | Assertion authority/confidence/lifecycle/evidence now serialize through CLI, `/api/v1`, pack JSON/Markdown, MCP and portable export, and the UI has text/non-color states. No seven-state seeded matrix proves semantic parity, omission safety or CSS-free/accessibility meaning across every surface. |

## 14. Named risk-test inventory

`RISK_REGISTER.md` defines 97 named scenarios. At the time of inspection, `rg` found **no `T-*` risk ID in `tests/` or `src/`**. Several prose-named tests are useful analogues, but none covers a whole family or emits the required release artifact. The table below accounts for every named range; `UNVERIFIED` means the specified scenario/gate has no scope-matched result.

| Named tests | Count | Closest current analogue | Strict audit result |
|---|---:|---|---|
| T-HAL-001 through T-HAL-008 | 8 | Overview unknown text, evidence gate, temporal test. | UNVERIFIED: no fabricated-ID batch, rejected-option, identity collision, unsupported parser, sentence manifest, withdrawal sweep or backdated-rationale suite. |
| T-STALE-001 through T-STALE-008 | 8 | New commit marks one approved overview stale. | UNVERIFIED: delete/rename/transitive/rule-policy/immutable-pack/equivalence/offline-fingerprint/human-rationale matrix absent. |
| T-LOAD-001 through T-LOAD-006 | 6 | Three-node graph bound plus SVG and equivalent semantic-table source checks. | UNVERIFIED as a family: no 100k rendered map/table, newcomer study, 500-commit grouping, dedup corpus or volume-buried conflict result. |
| T-AUTH-001 through T-AUTH-006 | 6 | Actor-attributed assertions, an exact read-only MCP inventory, critical-pack refusal and immutable scoped override. | UNVERIFIED as a family: no seven-state all-interface parity, 0.99-inference fixture, CSS-free contract, trust study or optional trusted-host capability audit. |
| T-PRIV-001 through T-PRIV-009 | 9 | One `.env` canary is absent from local outputs/export/privacy report; bounded report and retention preview tests pass. | UNVERIFIED as a family: no exact egress, post-redaction/scanner-failure, credential/log matrix, consent, MCP sensitive request, encrypted backup or telemetry capture. |
| T-HIST-001 through T-HIST-009 | 9 | Primary overview revisions are immutable, ledger tamper/outbox recovery, schema 3→4 migration, small restore and canonical clone import pass. | UNVERIFIED as a family: no real phase kills/partial writes, comprehensive assertion-row tamper, Git rewrite, merge/split, multi-upgrades, real derived rebuild or retention-deletion cases. |
| T-TOK-001 through T-TOK-008 | 8 | Small token caps, tiny-budget refusal, safety-tail retention and deterministic code paths. | UNVERIFIED as a family: no baseline target, dedup property, unlimited MCP cap/cursor case, provider usage/cache, formal section reservation or unrelated-refresh comparison. |
| T-INJ-001 through T-INJ-005 | 5 | HTML escaping/CSP source assertions and MCP scope. | UNVERIFIED: no malicious README/fake evidence/script-command/client escalation/obfuscation corpus through inference and rendered outputs. |
| T-LOCAL-001 through T-LOCAL-005 | 5 | Non-loopback refusal, CSP and traversal tests; Host validation code. | UNVERIFIED: no cross-origin mutation, forged Host/DNS-rebind assertion, scoped token, oversize service-availability and full non-loopback-auth matrix. |
| T-SUP-001 through T-SUP-004 | 4 | Core has no provider dependency; lockfile/workflow definitions exist. | UNVERIFIED: no network-denied trace, tampered release rejection, restricted adapter or producer quarantine result. |
| T-STORE-001 through T-STORE-005 | 5 | Failed in-process sync rollback, committed/unflushed outbox recovery, verified backup/restore, pre-restore recovery copy and transactional schema migration. | UNVERIFIED: actual process kill, partial ledger line, disk full, two writers, copy-verify-swap, derived rebuild and maximum-scale restore absent. |
| T-GIT-001 through T-GIT-006 | 6 | Argument arrays/NUL parsing/symlink code and SHA-length acceptance. | UNVERIFIED: unusual filenames, rename ambiguity, merge DAG, SHA-256 repository, denied-read symlink tripwire and unstable worktree tests absent. |
| T-ADOPT-001 through T-ADOPT-004 | 4 | No-model small-fixture flow and guided briefing. | UNVERIFIED: mechanical-refactor queue, recorded unknown suppression, full network-denied workflow and weekly design-partner result absent. |
| T-MET-001 through T-MET-003 | 3 | Categorical health verdict/safety/counts and component evidence/freshness/reasons are exposed, with the retained compatibility score capped under warnings/critical findings. | UNVERIFIED: denied-scope denominator, high-confidence unsupported case, extractor-failure coverage visibility and user interpretation have no scope-matched tests; the aggregate score remains visually prominent. |
| T-PERF-001 through T-PERF-004 | 4 | Bounded response sizes only. | UNVERIFIED: no published full-index, warm-update, max-query or cancellation benchmark. |
| T-PROV-001 through T-PROV-003 | 3 | Deterministic core works without configured provider. | UNVERIFIED: no network-tripwire full flow, model-version differentiation or provider adapter swap. |
| T-ACT-001 through T-ACT-004 | 4 | Pack contains decisions/history/tests/unknowns/evidence and a critical conflict requires a scoped override. | UNVERIFIED as a family: no rubric-complete interface/constraint retention, old-pack mismatch hook or downstream coding benchmark. |

This inventory is why a raw test count cannot justify the full plan. Before a public-beta gate, the test runner should emit these IDs and link each result to fixture/corpus/schema/policy/source-commit hashes.

## 15. Release claim allowed by current evidence

The strongest defensible wording is:

> “Context Atlas 0.1 is an experimental local-first alpha demonstrating evidence-backed Git ingestion, immutable reviewed temporal assertions, a recoverable audit outbox, a structural dashboard, fail-closed bounded navigation packs, a 10-tool read-only stdio MCP adapter, canonical portable import/export, privacy inventory, and basic backup/restore on small fixtures. It is not yet crash/scale-qualified, fully MCP-conformance-tested, accessibility-verified, provider-ready, or a production-safe source of truth.”

Do not claim all planned features, crash-safe history, complete bitemporal reconstruction, deterministic derived rebuild, retention deletion, WCAG conformance, large-repository support, comprehensive secret protection, safe provider integration, public-beta readiness, or predictable GitHub adoption until the corresponding rows above have current scope-matched evidence.
