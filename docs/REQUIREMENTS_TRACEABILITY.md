# Context Atlas Requirements Traceability and Verification Ledger

Status: verification design; implementation evidence not yet recorded
Source requirements: `PRODUCT_PLAN.md`
Architecture: `ARCHITECTURE.md`
Risk controls/tests: `RISK_REGISTER.md`
Delivery phases: `IMPLEMENTATION_ROADMAP.md`

## 1. Purpose and evidence policy

This ledger prevents `implemented` from meaning `code exists` and prevents a narrow green test from supporting a broad product claim. For every requirement it identifies:

- The owning architecture component and roadmap work package.
- The user-observable acceptance result.
- The planned automated/manual verification.
- The durable artifact that must exist before completion is claimed.
- The risk/control relationship where applicable.

At creation time, all implementation rows are **PLANNED / UNVERIFIED**. Documentation is design evidence, not implementation proof. As work lands, update each row with an exact current artifact—test result, schema/migration, contract golden, benchmark, signed release record, rendered accessibility report, or observed user study. Do not change a row to `VERIFIED` based solely on a developer statement, code presence, line coverage, or a test whose assertions do not cover the entire requirement.

## 2. Status definitions

| Status | Meaning |
|---|---|
| PLANNED | Verification design exists; implementation evidence is absent |
| IN PROGRESS | Some implementation/evidence exists, but one or more acceptance clauses are unproven |
| BLOCKED | A named external prerequisite prevents verification; blocker/owner/date are recorded |
| FAILED | Current authoritative evidence contradicts the requirement |
| VERIFIED | Current evidence proves every acceptance clause at the required scope |
| DEFERRED | Requirement is intentionally outside the current release; release claim excludes it |

`VERIFIED` must include an evidence pointer and observed version/commit. P0 rows must all be verified for MVP. P1 rows are public-beta gates unless the product plan explicitly assigns another gate.

## 3. Verification artifact convention

The implementation should publish a per-run manifest under a stable CI/release artifact location conceptually equivalent to:

```text
verification/<source-commit>/<run-id>/
  manifest.json
  unit-results.json
  integration-results.json
  e2e-results.json
  contract-results.json
  risk-results.json
  migration-results.json
  pack-evaluation.json
  performance-results.json
  accessibility-report.md
  usability-report.md
  sbom-and-release-provenance.json
```

The exact CI path may differ, but the manifest must record source commit/dirty state, environment, test IDs, fixture/corpus versions, schema/extractor/policy/selector versions, result, and artifact hashes. Manual verification includes evaluator, date, script version, observed result, and redacted evidence.

## 4. Functional requirement traceability

### 4.1 Workspace and ingestion

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-001 | P0 | Workspace service, CLI init / P1.1 | `T-FR-001`: dry run lists exact writes; accepted init adds only approved Atlas config/store/ignore changes; pre-existing files byte-compare unchanged; rejection performs no write | Cross-platform E2E filesystem manifest before/after plus CLI golden | C-009, R-012 | PLANNED |
| FR-002 | P0 | Git adapter, workspace store / P1.1 | `T-FR-002`: fixture matrix verifies canonical root, repo ID, object format, HEAD/ref/default-branch state, dirty state, and config hash; wrong repository mutation is rejected | Git fixture integration result and persisted DTO golden | C-015, C-022, R-012 | PLANNED |
| FR-003 | P0 | Discovery + extractors / P1.2, P2.2 | `T-FR-003`: known fixture proves all in-policy tracked text/Markdown/manifests/tests and configured reachable commits are discovered; excluded/unsupported counts and reasons match oracle | Full-scan inventory semantic diff against fixture oracle | C-009, C-022 | PLANNED |
| FR-004 | P0 | Incremental ingestion / P1.4 | `T-FR-004`: add/modify/delete/copy/rename/commit/worktree matrix yields expected evidence/events; final canonical result equals full reindex | Incremental/full semantic comparison; `T-GIT-002` result | C-005, C-014, R-002, R-012 | PLANNED |
| FR-005 | P1 | Import adapter / post-MVP or P9 | `T-FR-005`: only explicitly selected doc/conversation summary is imported; origin, consent, authority, sensitivity, hash, and time persist; dry-run/reject have no mutation | Import contract/E2E manifest and consent audit record | C-001, C-009, C-011, R-005 | PLANNED |
| FR-006 | P0 | Evidence store / P1.3 | `T-FR-006`: every artifact row has resolvable typed locator, content hash, observed time, extractor version, and sensitivity; validator rejects omission/tampering | Schema constraint test, provenance audit, `T-HIST-003` | C-001, C-002, R-001, R-006 | PLANNED |
| FR-007 | P0 | Ingestion orchestrator + SQLite / P1.4 | `T-FR-007`: repeated input is semantically idempotent; cancellation and crash at each checkpoint preserve prior committed snapshot and resume/restart without duplicates | Fault-injection report, `T-STORE-001`, `T-PERF-004` | C-014, R-006, R-011 | PLANNED |
| FR-008 | P0 | Policy/discovery boundary / P1.2 | `T-FR-008`: ignore, binary, generated, size, symlink, and denied-boundary fixtures are classified before body extraction; tripwire proves prohibited bytes were not read | Policy matrix, filesystem tripwire trace, `T-GIT-005` | C-009, C-022, R-005, R-012 | PLANNED |

### 4.2 Knowledge and time

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-009 | P0 | Domain/entity model + extractors / P2.1–P2.2 | `T-FR-009`: fixture yields expected goal, feature, component, interface, store, external system, convention, decision, risk, task, and term types; unsupported types remain unknown/extension, not coerced | Entity/predicate golden and schema validation results | C-001, R-001, R-003 | PLANNED |
| FR-010 | P0 | Assertion/relation domain / P2.1 | `T-FR-010`: each relation has direction/type, valid interval, evidence, authority/confidence, lifecycle; invalid interval/missing support is rejected | Property/schema tests and graph golden | C-001, C-006, R-001, R-006 | PLANNED |
| FR-011 | P0 | Current projector + temporal domain / P2.1, P2.3 | `T-FR-011`: current view selects correct active revisions while old revisions remain byte-identical/queryable; pointer references one committed snapshot/watermark | Temporal oracle comparison, canonical row hashes | C-002, C-015, R-002, R-006 | PLANNED |
| FR-012 | P0 | Event projector / P2.3 | `T-FR-012`: repository changes, human annotations/reviews/imports/candidates produce ordered typed events linked to affected entities/assertions/evidence; rerun adds no duplicate semantic event | Timeline golden across fixture lifecycle | C-001, C-002, R-006 | PLANNED |
| FR-013 | P1 | Temporal query service / P2.3, P9 | `T-FR-013`: `as of valid time`, `known at recorded time`, `between`, and evolution queries match reference temporal model including late-recorded and superseded facts | Property-test seed/replay artifacts and temporal golden | C-002, C-006, R-001, R-006 | PLANNED |
| FR-014 | P0 | Assertion/decision lifecycle / P2.3, P3.1 | `T-FR-014`: candidate→review/reject/defer and reviewed→supersede/withdraw/stale/conflict transitions obey matrix; forbidden self-approval/in-place edit fails | Lifecycle state-machine property tests; `T-AUTH-002` | C-002, C-003, R-004, R-006 | PLANNED |
| FR-015 | P0 | Conflict engine / P2.3, P3.2 | `T-FR-015`: overlapping incompatible fixture claims create visible conflict preserving both; resolution creates new revisions and recomputes dependents | Conflict oracle and `T-LOAD-006`, `T-ACT-002` | C-016, R-001, R-004, R-017 | PLANNED |
| FR-016 | P0 | Annotation/review service / P3.1 | `T-FR-016`: edit/withdraw/supersede creates new revision with actor/time/rationale link; direct update/delete attempt fails; old historical query unchanged | Database mutation guard and `T-HIST-001` | C-002, C-028, R-006 | PLANNED |

### 4.3 Provenance, review, and freshness

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-017 | P0 | Evidence/assertion service + all presenters / P2.1 onward | `T-FR-017`: every claim on CLI/web/pack/export/MCP exposes resolvable evidence, authority, confidence method, producer/model/extractor, times, and review state; fabricated IDs rejected | Cross-interface metadata contract matrix; `T-HAL-002`, `T-AUTH-001` | C-001, C-004, R-001, R-004 | PLANNED |
| FR-018 | P0 | Authority policy + presentation contracts / P2.1 onward | `T-FR-018`: seven authority/health states serialize distinctly and remain understandable without color/CSS; inferred content never appears in reviewed set | Contract goldens, accessibility result, `T-AUTH-002`, `T-AUTH-004` | C-003, C-016, R-004 | PLANNED |
| FR-019 | P0 | Review application service + CLI/web / P3.1, P5.4 | `T-FR-019`: authorized actor can approve/edit/reject/defer/group only eligible candidates; stale watermark and heterogeneous unsafe bulk action are rejected | Review E2E and state-machine results | C-003, C-024, R-004, R-013 | PLANNED |
| FR-020 | P0 | Audit service / P3.1 | `T-FR-020`: each mutation/review records actor/time/type/before-after IDs/rationale and hash-chain link; tampering detected; secret values absent | Audit event golden, tamper and log scan results | C-002, C-021, R-005, R-006 | PLANNED |
| FR-021 | P0 | Dependency/staleness engine / P3.3 | `T-FR-021`: artifact, dependency, rule, extractor, and policy changes invalidate correct frontier; deterministic equivalent support revalidates, human rationale is not rewritten | `T-STALE-001`–`T-STALE-006`, `T-STALE-008` report | C-005, R-002 | PLANNED |
| FR-022 | P0 | Health projector / P3.3, P5.2 | `T-FR-022`: each component shows repository/extraction/knowledge/projection freshness, coverage denominator/exclusions, reason and last validation snapshot; no misleading aggregate green score | Health fixture golden, `T-MET-001`, `T-MET-003` | C-005, C-024, R-002, R-014 | PLANNED |
| FR-023 | P0 | Validation service + CLI / P2.5 onward | `T-FR-023`: seeded broken provenance, interval, cycle, locator, orphan, conflict, policy, stale critical, tamper, and partial migration each produce correct finding/exit code; clean fixture passes | Versioned validation-rule matrix and CLI exit-code result | C-006, R-001, R-002, R-005, R-006 | PLANNED |

### 4.4 Human experience

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-024 | P0 | Overview projector + CLI/web / P2.4, P5.2 | `T-FR-024`: known-truth overview covers purpose/users/vocabulary/architecture/data flow/setup/current state/risks/unknowns/entry points; every statement traces; missing rationale says unknown | Overview rubric/golden, `T-HAL-001`, `T-HAL-006` | C-001, C-007, C-016, R-001, R-003 | PLANNED |
| FR-025 | P0 | Map query + web / P2.4, P5.3 | `T-FR-025`: map supports focus/type/time/state filters, bounded nodes/frontier/cursor/evidence drilldown, and equivalent keyboard table/list on scale fixture | Map contract/performance and `T-LOAD-001`, accessibility report | C-007, R-003, R-015 | PLANNED |
| FR-026 | P0 | Timeline query + web / P2.3, P5.3 | `T-FR-026`: filters by entity/type/time/authority/review; every event opens affected objects/evidence; grouping preserves drilldown and temporal order | Timeline E2E/golden; `T-LOAD-003` when P1 grouping ships | C-007, R-003, R-006 | PLANNED |
| FR-027 | P0 | Explain query + CLI/web/MCP / P2.4 onward | `T-FR-027`: file/symbol/component/decision/concept fixtures return current/history/dependencies/dependents/risks/unknowns/evidence at requested time with explicit no-match/ambiguity | Explain contract matrix and temporal golden | C-001, C-016, R-001, R-004 | PLANNED |
| FR-028 | P1 | Guided onboarding / P9.3 | `T-FR-028`: first-time evaluator completes evidence-backed orientation rubric and can inspect/correct answers; median time meets target | Moderated usability report, `T-LOAD-002`, trust result | C-007, C-025, R-003, R-004 | PLANNED |
| FR-029 | P0 | SQLite FTS/search service / P2.4 | `T-FR-029`: titles/aliases/paths/symbols/claims/events/decisions/evidence are findable with time/type/state/sensitivity filters; match reason/cursor/snapshot visible; policy-hidden body not leaked | Search oracle, latency report, privacy cases | C-007, C-009, R-003, R-005 | PLANNED |
| FR-030 | P0 | Shared presentation-state contracts / P2.4, P5 | `T-FR-030`: empty/unknown/stale/conflict/error/partial index fixtures display distinct concise states on CLI/web/API/MCP; no placeholder summary generated | Cross-interface snapshot suite | C-016, R-001, R-004 | PLANNED |

### 4.5 Context packages

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-031 | P0 | Pack application/selector / P6.1 | `T-FR-031`: identical task/snapshot/policy/budget yields canonical-equivalent pack selection; task-specific fixture selects relevant graph instead of full dump | Pack evaluation/manifest determinism; `T-TOK-001` | C-008, R-007, R-017 | PLANNED |
| FR-032 | P0 | Pack selector / P6.1 | `T-FR-032`: task rubric verifies relevant goals/components/interfaces/conventions/decisions/constraints/risks/recent changes/tests/conflicts/unknowns/evidence retained when present; absent sections say none/unknown | Per-section recall report; `T-TOK-007`, `T-ACT-001` | C-008, C-016, R-004, R-007, R-017 | PLANNED |
| FR-033 | P0 | Ranking/budget engine / P6.1 | `T-FR-033`: stable rank/order, dedup, reserved sections, hard character/token cap, deterministic truncation, material exclusion reasons; tiny budget refuses | Property tests and `T-TOK-002`–`T-TOK-004` | C-008, C-020, R-003, R-007 | PLANNED |
| FR-034 | P0 | Pack validation/policy / P6.1 | `T-FR-034`: stale/conflicting/unsupported/privacy-denied critical fixtures block; configured override creates actor/time/reason record and prominent immutable warning on all surfaces | `T-AUTH-003`, `T-ACT-002`, `T-PRIV-002` | C-016, C-027, R-002, R-004, R-005, R-017 | PLANNED |
| FR-035 | P0 | Pack serializers/store / P6.2 | `T-FR-035`: JSON/Markdown include schema/pack ID, repo/snapshot, time, policy/versions, budget estimate, freshness, selected/excluded hashes and warnings; output hashes stable | Contract goldens and reproducibility report | C-008, C-015, R-002, R-006, R-007 | PLANNED |
| FR-036 | P1 | Pack lifecycle / P6.2, P9 | `T-FR-036`: refresh after relevant/unrelated changes reports exact input/selection/warning changes, keeps old pack immutable, and avoids unrelated churn | `T-STALE-005`, `T-TOK-008`, pack diff golden | C-005, C-008, R-002, R-007 | PLANNED |

### 4.6 Interfaces

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-037 | P0 | CLI adapter / P4 | `T-FR-037`: every named command supports documented success/error/warning flow; `--json` validates version schema; read commands do not mutate; dry runs and exit codes are correct | CLI command×state matrix and golden E2E | C-006, C-021 | PLANNED |
| FR-038 | P0 | Local server/web / P5.1 | `T-FR-038`: runs with no account on loopback; non-loopback without auth refuses; forged Host/origin/CSRF/XSS/oversize cases fail without mutation | `T-LOCAL-001`, `T-LOCAL-002`, `T-LOCAL-004`, `T-LOCAL-005` | C-012, C-019, R-005, R-009 | PLANNED |
| FR-039 | P0 | Application/API contracts / P5.1 | `T-FR-039`: CLI/web/MCP fixture queries produce semantically consistent DTOs from application service; architecture test prevents presentation code importing SQLite repositories directly | Dependency-boundary test and cross-adapter semantic contract | C-015, R-006 | PLANNED |
| FR-040 | P0 | MCP adapter / P6.4 | `T-FR-040`: overview/search/explain/history/pack/health/evidence tools pass schema, cursor/budget/snapshot/warning cases across reference clients | MCP conformance/contract report | C-008, C-016, R-004, R-007 | PLANNED |
| FR-041 | P0 | Capability/actor service + MCP / P6.4 | `T-FR-041`: default client cannot mutate; separately enabled propose/update creates only candidate/request; no tool approves; trusted host confirmation and audit required | `T-AUTH-006`, `T-LOCAL-003`, `T-INJ-004` | C-003, C-018, R-004, R-008, R-009 | PLANNED |
| FR-042 | P1 | Extension ports/contracts / P7, P9 | `T-FR-042`: test extractor/analyzer/provider/redactor/exporter/validator adapters run through versioned narrow schemas; invalid output rejected; docs state installed extensions are trusted code | Adapter contract suite, documentation/release review | C-023, R-010, R-016 | PLANNED |

### 4.7 Privacy, portability, and recovery

| Req | Pri | Owning component / phase | Acceptance and verification | Required proof artifact | Risks/controls | Status |
|---|---|---|---|---|---|---|
| FR-043 | P0 | Core/application wiring / P1 onward | `T-FR-043`: with network denied, no provider credential, no account/telemetry, init/update/overview/map/history/explain/search/review/validate/export/restore/pack/MCP reads function | No-network E2E, `T-ADOPT-003`, `T-PROV-001` | C-012, R-005, R-016 | PLANNED |
| FR-044 | P0 | Privacy policy/scanners / P1.5, P7.2 | `T-FR-044`: secret/path fixtures are detected before prohibited persistence/egress, configured redact/block applies, scanner error fails remote closed, audit contains category/hash not value | `T-PRIV-001`–`T-PRIV-004` byte-capture report | C-009, C-010, R-005 | PLANNED |
| FR-045 | P0 | Egress preview/consent / P7.2 | `T-FR-045`: first provider/purpose/policy call shows exact payload/destination/purpose/retention assumption/redactions/tokens/cost; no consent means no network; material policy change re-prompts | Mock provider trace, consent/audit records, `T-PRIV-006` | C-011, R-005, R-007 | PLANNED |
| FR-046 | P0 | Storage privacy + credential adapter / P1.5, P7.2 | `T-FR-046`: configured secret bodies omitted/encrypted, DB permissions attempted/reported, provider key exists only in approved credential source; DB/log/export scans find no seeded values | Filesystem permission matrix, store/log scan, `T-PRIV-005` | C-010, C-021, C-026, R-005 | PLANNED |
| FR-047 | P0 | Export/import / P3.4 | `T-FR-047`: versioned checksummed open export preserves human knowledge/decisions/reviews/config/required locators/order; documented independent parser validates it; tamper fails import | Export schema, compatibility fixture, semantic round trip | C-013, R-006, R-011 | PLANNED |
| FR-048 | P0 | Backup/recovery + validation / P3.5 | `T-FR-048`: backup/restore and clean rebuild preserve last committed human mutation; detect corruption/partial/incompatible/Git rewrite; never overwrite known-good store before validation | `T-HIST-004`, `T-HIST-007`, `T-HIST-008`, `T-STORE-002/004/005` | C-013, C-014, R-006, R-011, R-012 | PLANNED |
| FR-049 | P1 | Retention service / P9 | `T-FR-049`: scoped dry run enumerates bodies/payloads/outputs/embeddings/logs and dependent outputs; deletion follows policy, approved audit minimum/tombstone remains, caches cannot resurrect data | Retention impact/after-state manifest, `T-HIST-009` | C-026, R-005, R-006 | PLANNED |
| FR-050 | P1 | Privacy report / P7.2, P9 | `T-FR-050`: report accurately enumerates indexed/excluded scope, finding categories, egress metadata, retention/provider state; seeded secret values absent; counts reconcile with store | Privacy report oracle and output secret scan | C-011, C-021, R-005, R-014 | PLANNED |

## 5. Nonfunctional requirement traceability

| Req | Owning work / release gate | Scope-matched verification | Required proof artifact | Status |
|---|---|---|---|---|
| NFR-001 | Domain/validation / every release | Query all active authoritative assertions at maximum fixture scale; assert permitted resolvable support or explicit human source; render surfaces cross-check same invariant; seeded unsupported assertion blocks | Provenance audit plus `T-HAL-006`/cross-interface manifest | PLANNED |
| NFR-002 | Storage/integrity / M1 onward | Tamper evidence/assertion/audit/hash/interval/foreign key/supersession cycle and verify detection/refusal; migration keeps chain valid | `T-HIST-003`, constraint/property/migration report | PLANNED |
| NFR-003 | Extractors/ranker/projectors / M2, M6 | Repeat on identical Git objects/config/approved knowledge/versions across clean stores and supported OSes; canonicalize and semantic-hash observed graph, rank order, outputs | Cross-run/cross-platform determinism report | PLANNED |
| NFR-004 | Ingestion / beta | On published reference machine and 100k/20k fixture, run representative 50-file warm changes enough times for valid p95; include parser/cache versions and peak resource use | Versioned performance result showing p95 <60s | PLANNED |
| NFR-005 | Search/overview / beta | At maximum knowledge scale, randomized representative warm queries/open actions; p95 search first page <300ms and overview <1s, excluding unsupported environment variance by stated method | Query benchmark with distributions and query plans | PLANNED |
| NFR-006 | Whole system / beta | Build fixture with ≥100k files, 20k commits, 250k assertions, 1m evidence edges; complete update/search/map/temporal/pack/backup validation with no invariant loss/OOM | Scale E2E report, DB size/peak memory/duration | PLANNED |
| NFR-007 | Ingestion/storage / M1 onward | Kill at every named stage/transaction boundary under repeated seeds; prior committed projection readable; resume/restart creates no semantic duplicates | `T-STORE-001`, crash matrix | PLANNED |
| NFR-008 | Backup/recovery / beta | Maximum-scale backup, last human mutation, corruption, restore/rebuild timed; verify RPO last committed mutation and RTO <4h plus semantic comparison | Disaster-recovery signed drill record | PLANNED |
| NFR-009 | Local server/security / M5 onward | Bind/listener inspection on each OS; non-loopback refusal; origin/Host/CSRF/session/CSP/CORS/mutation tests and targeted security review | `T-LOCAL` suite, security headers capture, review report | PLANNED |
| NFR-010 | Privacy/egress / every release with network | Run core under network tripwire; opt-in provider through byte-capture proxy; verify only policy-approved payload and no default egress/telemetry/path IDs | No-network trace plus `T-PRIV` egress report | PLANNED |
| NFR-011 | Web/design / beta | Automated WCAG checks plus keyboard and screen-reader scripts for init status/orientation/map-equivalent/timeline/search/evidence/review/pack/health; contrast and non-color states | Accessibility report with issues/remediation, `T-LOAD-005` | PLANNED |
| NFR-012 | Platform/Git / beta | CI/E2E on current Windows/macOS/Linux Node 24; SHA-1/SHA-256 fixtures; path/encoding/process semantics | Platform matrix, `T-GIT-001`, `T-GIT-004` | PLANNED |
| NFR-013 | Export/contracts / beta onward | Independent minimal parser reads documented export; previous-version fixture migrates; no hosted/proprietary service or Atlas DB internals needed | Export schema/parser repo artifact and round-trip report | PLANNED |
| NFR-014 | Diagnostics / M1 onward | Every run/request sample has correlation/phase/version/status; seeded repository bodies/secrets/prompts/tasks/model outputs absent from logs/default diagnostic bundle | Structured-log schema test and secret/content scan | PLANNED |
| NFR-015 | Architecture/migrations / every release | Dependency rule proves domain imports no adapter; domain tests run in memory; each migration has clean/old/corrupt/rollback-or-export recovery cases | Architecture test, unit and migration matrices | PLANNED |
| NFR-016 | First-run UX / M4/beta | First-time participant initializes, previews scope, updates, opens overview, and generates safe pack without external docs or facilitator intervention; errors included | Unmoderated task success report | PLANNED |
| NFR-017 | Cost/pack / M6 onward | Dry-run shows estimate; per-run/day ceilings enforced under mocked usage/overrun; safe cache key cases; hard stop creates no additional provider calls | `T-TOK-002`, `T-TOK-005/006`, provider call ledger | PLANNED |
| NFR-018 | Contracts/release / beta onward | Current implementation consumes previous minor CLI JSON/pack/export/API/MCP fixtures or emits documented compatible migration/error; schema diff reviewed | Cross-version contract matrix for current and previous minor | PLANNED |

## 6. Primary risk-to-control-to-test traceability

| Risk | Preventative evidence required | Detective evidence required | Recovery evidence required | Release-blocking tests |
|---|---|---|---|---|
| R-001 Summary hallucination | C-001/C-003/C-004 structured evidence and candidate separation | C-006 provenance audit and known-truth rubric | C-028 withdrawal/invalidation/quarantine workflow | T-HAL-001–008 as release tier applies |
| R-002 Staleness | C-005 dependency graph, C-015 snapshot-bound projections | Health/fingerprint/full-incremental equivalence | Impact sweep, stale pack marking, full reindex | T-STALE-001–008 as release tier applies |
| R-003 Overload | C-007 bounded/progressive UI, C-008 budgets/dedup | Usability, duplicate/event burst, pack precision measures | Disposable projection rerank and reviewed merge/split | T-LOAD-001–006 as release tier applies |
| R-004 False authority | C-003/C-016 labels/lifecycle on all surfaces, C-018 MCP boundary | Cross-contract metadata lint and trust study | Format invalidation, correction and affected-pack warning | T-AUTH-001–006 as release tier applies |
| R-005 Sensitive leakage | C-009/C-010/C-011/C-012/C-019/C-021/C-026 | Byte-capture egress, log/export/privacy audit | Cache purge, session rotation, incident/credential-rotation metadata | T-PRIV-001–009 as release tier applies |
| R-006 History corruption | C-002/C-014/C-015 immutable transactions | C-006 hash/temporal/integrity validation | C-013 verified backup/export/restore/rebuild | T-HIST-001–009 as release tier applies |
| R-007 Token waste | C-008/C-020 deterministic budgets/cost ceilings | Pack manifest and relevance/token corpus | Regenerate/quarantine selector, hard provider stop | T-TOK-001–008 as release tier applies |

## 7. Jobs-to-be-done coverage

| Job | Requirements that enable it | Outcome verification |
|---|---|---|
| JTBD-01 unfamiliar repository orientation | FR-003, FR-009–012, FR-017–018, FR-022, FR-024–030 | Newcomer comprehension rubric, evidence resolution, time-to-orientation |
| JTBD-02 return and see material changes | FR-004, FR-011–014, FR-021–023, FR-026 | Change-since task on temporal fixture and returning-user study |
| JTBD-03 task-specific agent context | FR-031–036, FR-040–041 | Pack token/recall benchmark and downstream task evaluation |
| JTBD-04 inspect why claim is believed | FR-006, FR-017–018, FR-023, FR-027 | Cross-interface evidence resolution task |
| JTBD-05 detect invalid explanations | FR-004, FR-021–023, FR-034, FR-036 | Staleness/incremental equivalence and old-pack tests |
| JTBD-06 govern inferred decision | FR-014–016, FR-019–020, FR-041 | Candidate/review/supersede audit E2E |
| JTBD-07 surface and resolve disagreement | FR-015, FR-018–020, FR-023, FR-030, FR-034 | Conflict fixture resolution and dependent invalidation |
| JTBD-08 control provider egress | FR-008, FR-043–046, FR-049–050 | Exact mocked egress and privacy report/retention tests |
| JTBD-09 recover project memory | FR-006–007, FR-020, FR-023, FR-047–049 | Corruption/export/restore/rebuild semantic drill |
| JTBD-10 share memory with coding tools | FR-031–035, FR-039–041 | MCP conformance, cap/privacy/authority tests |

## 8. Product outcome traceability

| Product target | Requirements | Measurement design | Minimum evidence for claim |
|---|---|---|---|
| Newcomer orientation under 10 minutes | FR-024–030, NFR-016 | Participant with no prior knowledge completes purpose/users/components/data-flow/constraints/risks/setup rubric | Moderated/unmoderated study with task script, timings, correctness, sample size |
| ≥98% factual-claim evidence resolution | FR-006, FR-017, FR-023, NFR-001 | Enumerate displayed factual claim manifests on sampled/fixture repos and resolve evidence | Automated audit plus human support-quality sample; denominator documented |
| Zero unlabelled generated rationale | FR-014, FR-018–020, NFR-001 | Search canonical/current/presentation outputs for inferred rationale lacking label/review | Structural lifecycle assertion plus cross-interface output audit |
| Fresh/stale within 60 seconds after update | FR-004, FR-021–023, NFR-004 | 50-file reference change from command start through committed health state | p95 benchmark with reference machine/corpus/run count |
| ≥50% token reduction and ≥90% rubric facts | FR-031–035, NFR-003/017 | Compare Atlas pack to naive relevant-directory dump on versioned task corpus | Corpus/version, selection manifests, tokenizer method, per-task/aggregate metrics |
| Rebuild semantic equivalence | FR-006–007, FR-047–048, NFR-003/008 | Export approved knowledge, rebuild clean store from Git, compare canonical observed/human graph | Semantic hash/diff plus audit/revision/locator comparison |
| Zero seeded secret egress | FR-008, FR-043–046, NFR-010 | Byte-capturing mock provider across code/path/commit/task/redaction/scanner-failure corpus | Captured bytes hash/scan, test corpus manifest, policy/provider versions |
| ≥80% trust-state classification | FR-017–018, FR-030, FR-034–035, NFR-011 | Users classify observed/inferred/reviewed/stale/conflicting examples without coaching | Study design, sample, per-state confusion matrix, accessibility modes |

## 9. Interface metadata parity matrix

The following fields must survive every presentation boundary. Contract tests should use one seeded claim in each state and compare semantic availability, not pixel-identical formatting.

| Metadata | CLI text | CLI JSON | Web/API | Pack Markdown | Pack JSON | MCP | Export |
|---|---:|---:|---:|---:|---:|---:|---:|
| Stable claim/entity ID | Required | Required | Required | Required in evidence index | Required | Required | Required |
| Authority class | Required | Required | Required | Required | Required | Required | Required |
| Review/lifecycle state | Required | Required | Required | Required | Required | Required | Required |
| Freshness and reason | Required | Required | Required | Required when non-fresh | Required | Required | Required snapshot state |
| Confidence and method | Required when present | Required | Required | Required for inference | Required | Required | Required |
| Valid and recorded time | On evidence/detail | Required | Required | Relevant time + locator | Required | Required | Required |
| Evidence locator(s) | Required | Required | Required | Required | Required | Required subject to policy | Required |
| Conflict/unknown warnings | Required before guidance | Required top-level + item | Required | Required before affected content | Required | Required top-level + item | Required |
| Snapshot/watermark | Required | Required | Required | Required | Required | Required | Required |
| Truncation/exclusions | When applicable | Required | Required | Required | Required | Required | Required if applicable |
| Unsafe override actor/reason | Required | Required | Required | Required prominently | Required | Required | Required |

Failure on any required cell blocks FR-017, FR-018, and the affected interface requirement.

## 10. Verification specifications for high-risk invariants

### V-001 Active-claim support invariant

Query the complete active authoritative projection—not a sample—and assert that every claim has at least one permitted, resolvable supporting evidence edge or explicit human-authored source. Then resolve locators and verify content hashes. Sample human review checks whether evidence semantically supports the rendered statement; structural presence alone cannot prove support quality.

### V-002 No self-approval invariant

Generate candidates through every extractor/provider/client actor class and attempt every review mutation using the same and model-controlled actor/capability. Database/application/API/MCP paths must all reject. Direct database constraint/validation should detect a manually seeded illegal state.

### V-003 Append-only history invariant

Record row/content hashes, perform edit/approve/reject/supersede/withdraw/conflict resolution, and prove old rows/hashes persist, revision order is valid, audit links exist, historical queries retain old results at old recorded time, and current projection changes only through new records.

### V-004 Incremental equivalence invariant

From the same repository/config/version baseline, compare:

1. One full update at final state.
2. The real sequence of intermediate commits/worktree changes through incremental updates.

Canonical observed entities/assertions/evidence identities and current semantic values must match after excluding deliberately occurrence-specific run metadata. Run across rename/delete/copy/merge/config/rule-change fixtures.

### V-005 Secret non-egress invariant

Place unique synthetic canaries in code, ignored path, Git message, filename, task text, imported note, encoded content, and material that survives first redaction. Route every provider operation through a byte-capturing mock. Assert none of the canaries or denied body hashes occurs in adapter input, network bytes, logs, DB disallowed columns, pack, MCP, telemetry, diagnostic bundle, or default export. Force scanner failure and prove no network attempt.

### V-006 Pack safety/budget invariant

For generated/random graphs and budgets:

- Output never exceeds hard character cap.
- Token estimate follows declared method and configured ceiling.
- Mandatory identity, warning, constraint/risk/unknown, and evidence sections are either present or generation refuses.
- Every included factual claim has permitted evidence.
- Every material exclusion/truncation is reported.
- Identical canonical inputs produce identical selected order/output hash.

### V-007 Crash-safe current projection invariant

Inject process termination/error before and after each staging/checkpoint/artifact/assertion/validation/commit-pointer/projection phase. A fresh process must see either the old committed snapshot or the fully committed new one, never a hybrid. Resume/restart is idempotent and never deletes a known-good store automatically.

### V-008 Cross-interface authority invariant

Seed observed, derived, human-reviewed, inferred-candidate, stale, conflicting, and unknown cases. Retrieve via all interface cells in section 9 and verify state/authority/warning/evidence equivalence. Strip CSS/color and copy Markdown/plain text to ensure meaning remains.

## 11. Manual verification gates

Some requirements cannot be proven by automation alone.

| Gate | Script | Pass condition | Release |
|---|---|---|---|
| MV-001 Newcomer comprehension | Give participant no project briefing; use overview/map/search/evidence to answer rubric | Correct purpose/users/boundaries/components/data flow/constraint/risk/setup answers; median under target | Alpha/beta |
| MV-002 Trust calibration | Show realistic outputs in seven states across visual/plain modes | ≥80% correct classification; critical stale/inferred cases not treated as settled | Beta |
| MV-003 Review burden | Run normal/mechanical/semantic updates on design-partner repo | Critical items found; typical bounded update median review target; no pressure to invent rationale | Alpha/beta |
| MV-004 Keyboard/screen-reader | Execute all core web flows without graph/pointer/color dependence | Equivalent result, logical focus/order/announcements, no blocking issue | Beta/GA |
| MV-005 Incident tabletop | Simulate false reviewed claim, secret egress, corrupted history, compromised release | Team scopes by versions/hashes, contains, recovers, communicates without leaking more data | Beta/GA |
| MV-006 Disaster recovery | Restore maximum-scale previous-version backup after corruption/Git rewrite | RPO/RTO met; semantic diff and orphan/review report accurate | Beta/GA |

## 12. Completion audit procedure

Before calling a milestone or release complete:

1. Resolve the exact source commit, build, schema, fixture, and policy versions being audited.
2. List all requirements in scope by priority/milestone; do not start from passing tests.
3. For each row, open the named proof artifact and confirm its assertions cover the full acceptance statement and supported scale/interface.
4. Confirm test fixtures actually contain the intended failure/edge condition.
5. Treat skipped, quarantined, flaky, stale, missing, or environment-mismatched evidence as unverified.
6. Re-run high-risk invariants V-001 through V-008 on the candidate release.
7. Inspect manual gate reports and outstanding accessibility/security/usability issues.
8. Compare risk residuals to targets and ensure every accepted gap has owner, scope, expiry, disclosure, and compensating control.
9. Verify migration/export/restore from the previous supported version and a clean no-model/no-network run.
10. Update this ledger with exact artifact links and statuses, then obtain release owner and independent reviewer sign-off.

Absence of a discovered defect is not completion evidence. A requirement is verified only by positive proof at its stated scope.

## 13. Current baseline

As of this document's creation, the product, architecture, risk, roadmap, and traceability specifications exist. No application implementation or test artifact is claimed by this documentation task. Therefore:

- Functional requirements FR-001 through FR-050: **PLANNED / UNVERIFIED**.
- Nonfunctional requirements NFR-001 through NFR-018: **PLANNED / UNVERIFIED**.
- Risk controls C-001 through C-028: designed, not implementation-verified.
- Release milestones M0 through M10: not proven complete by this ledger.

The implementation team must replace this baseline with evidence as work proceeds; it must never bulk-mark rows verified based on milestone naming alone.
