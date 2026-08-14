# Context Atlas Product Plan

Status: implementation baseline
Audience: product, engineering, security, design, and AI-integration teams
Primary release target: local-first single-repository MVP
Runtime assumption: Node.js 24, TypeScript, Node's built-in SQLite, Git as primary evidence

## 1. Executive summary

Context Atlas is a durable project-memory layer for people and coding agents. It reconstructs what a software project is, how it reached its present state, why important choices were made, what is changing now, and which facts matter for the next task. It presents that memory as an evidence-backed overview, a navigable map, a temporal history, and a compact context package for an LLM.

The product is not another free-form documentation generator. Its contract is stronger:

1. Every factual claim must identify its source, time, confidence, and review state.
2. Observed facts, machine inferences, and human assertions must never be visually or structurally conflated.
3. History is append-only. Corrections and superseding decisions remain visible rather than rewriting the past.
4. The repository and its evidence remain authoritative; generated prose is a projection that can be invalidated and rebuilt.
5. Local processing and local storage are the defaults. Sending content to an external model is an explicit, inspectable action.
6. Context delivered to an LLM is selected for a task and token budget, not produced by indiscriminately dumping the project.

The first useful release is a CLI and localhost web application that can initialize a Git repository, index code and Markdown, construct a reviewable project map and timeline, detect stale knowledge after changes, and generate cited task-specific context packs. A read-oriented MCP server then lets compatible coding agents query the same project memory.

## 2. Problem statement

Vibe coding makes creation fast but transfers much of the implementation knowledge into temporary conversations. As the project grows:

- The programmer remembers outcomes but not interactions or rationale.
- A new chat sees only fragments and makes plausible but incompatible assumptions.
- Generated summaries silently become stale when code changes.
- Decisions are overwritten by new summaries, so nobody can reconstruct why a system looks the way it does.
- A broad context dump overwhelms both humans and model context windows.
- Sensitive repository material can leak to external providers.
- Fluent generated explanations are treated as authority despite weak or missing evidence.

The core problem is therefore not document generation. It is maintaining an intelligible, temporal, provenance-preserving model of a changing project and exposing the right subset safely to each consumer.

## 3. Vision and positioning

### 3.1 Vision

Any programmer or coding agent should be able to enter an unfamiliar project and answer, with evidence:

- What does this project do and for whom?
- How is it organized today?
- How did it become this way?
- Why were important choices made?
- Which parts are uncertain, stale, risky, or currently changing?
- What must I know before making this specific change?

### 3.2 Product promise

> A project can forget a chat, lose a team member, or change tools without losing its memory.

### 3.3 Positioning

Context Atlas sits between source control, documentation, work tracking, and coding assistants. Git proves what changed. Existing documents and human reviews explain intent. Static analysis supplies deterministic structure. Optional models propose interpretations. Context Atlas records these inputs without pretending they have equal authority.

### 3.4 Differentiators

- Temporal memory rather than a current-state-only wiki.
- Claim-level provenance rather than citations attached only to entire pages.
- Explicit uncertainty and contradiction states.
- Human approval for rationale and other high-impact interpretations.
- Task-specific, budgeted context delivery for LLMs.
- Local-first operation with deterministic functionality even when no model is configured.
- Rebuildability from evidence plus exported human knowledge.

## 4. Product principles

1. **Evidence before eloquence.** A short cited explanation is better than a comprehensive invented one.
2. **Unknown is a valid answer.** Missing rationale is shown as missing, never filled with a convenient story.
3. **History is additive.** An assertion may be corrected or superseded, but its prior existence remains auditable.
4. **Current state is a projection.** It is computed from immutable observations and reviewed assertions.
5. **Human attention is scarce.** Reviews are risk-ranked, grouped, and focused on changed or consequential claims.
6. **Progressive disclosure beats completeness on one screen.** Start with orientation; reveal evidence and history on demand.
7. **Least context is safer context.** A pack includes only what a task needs, within explicit privacy and token constraints.
8. **Local is the default trust boundary.** Network access and remote inference require affirmative configuration.
9. **Automation must be reversible.** An index can be rebuilt; generated candidates can be rejected; approved history cannot be silently erased.
10. **Agent interfaces inherit the same safety model.** MCP is not a bypass around approvals, privacy rules, or evidence requirements.

## 5. Goals and measurable outcomes

### 5.1 Product goals

- Reduce the time needed for a person with no prior knowledge to form a correct high-level mental model.
- Preserve project decisions and their evolution across commits and AI sessions.
- Warn when material project knowledge no longer matches the repository.
- Give coding models compact, relevant, cited context before they modify code.
- Make uncertainty, conflict, sensitive content, and provenance visible enough to change user behavior.
- Remain useful offline and without a paid model provider.

### 5.2 MVP outcome targets

Targets are evaluated in an opt-in test cohort; no source content is collected by default.

| Outcome | MVP target | Measurement |
|---|---:|---|
| First orientation | Median under 10 minutes for a new evaluator to answer a project comprehension rubric | Moderated onboarding test |
| Evidence correctness | At least 98% of displayed factual claims have a resolvable evidence link | Automated provenance audit plus sample review |
| Unsupported rationale | 0 unlabelled machine-generated rationale claims | Policy test and sampled review |
| Update freshness | Changed components marked fresh or stale within 60 seconds after `atlas update` on the reference repository | Integration benchmark |
| Context efficiency | At least 50% fewer input tokens than the naive relevant-directory dump, while retaining at least 90% of rubric facts | Context-pack evaluation set |
| Rebuildability | Clean rebuild produces semantically equivalent observed graph and preserves imported human assertions | Disaster-recovery test |
| Secret protection | 0 seeded high-confidence secrets sent to a mocked remote provider | Egress integration test |
| User trust calibration | At least 80% of test users correctly distinguish observed, inferred, reviewed, stale, and conflicting states | UX comprehension test |

### 5.3 North-star metric

**Verified orientation events per active repository:** a human or agent successfully uses an evidence-backed overview or context pack and confirms that it enabled a correct project action. This avoids optimizing for pages generated, nodes indexed, or tokens consumed.

## 6. Personas

### 6.1 Solo builder / vibe coder

- Builds quickly across many AI sessions.
- Has limited time for manual documentation.
- Needs to remember what changed, detect unintended architectural drift, and hand useful context to the next session.
- Primary fear: being unable to debug or safely extend a project they technically own.

### 6.2 New contributor

- Has no historical knowledge and needs a progressive introduction.
- Needs trustworthy entry points, terminology, system boundaries, known risks, and evidence.
- Primary fear: making a locally reasonable change that violates an undocumented constraint.

### 6.3 Maintainer / technical lead

- Reviews changes across modules and owns system coherence.
- Needs decision history, impact analysis, staleness signals, and review queues.
- Primary fear: generated documentation increasing confidence without increasing correctness.

### 6.4 Coding agent / LLM client

- Has a limited context window and no durable memory between sessions.
- Needs structured facts, relevant decisions, constraints, risks, unknowns, and direct evidence references.
- Primary failure mode: filling missing context with assumptions.

### 6.5 Security or privacy reviewer

- Needs to understand data flow, provider egress, secret handling, trust boundaries, and audit history.
- Primary fear: repository content or credentials leaving the machine without a controlled, reviewable decision.

### 6.6 Future returning maintainer

- Returns after weeks or months and remembers the product but not implementation detail.
- Needs a `since I was here` history, superseded decisions, and current work state.
- Primary fear: confusing an old mental model with current reality.

## 7. Jobs to be done

| ID | When | I want to | So that | Success signal |
|---|---|---|---|---|
| JTBD-01 | I open an unfamiliar repository | receive a plain-language guided overview | I can explain the product and architecture before editing | Comprehension rubric passed with cited answers |
| JTBD-02 | I return after time away | see what materially changed since a commit or date | I can update my mental model quickly | Relevant changes and superseded decisions identified |
| JTBD-03 | I plan a change | generate a task-specific context package | my agent sees constraints and affected areas without a full-repo dump | Pack meets token budget and relevance rubric |
| JTBD-04 | A summary makes a claim | inspect exactly why the system believes it | I can judge its authority | Evidence, extractor, time, confidence, and review state visible |
| JTBD-05 | Code changes | know which explanations may now be invalid | stale guidance does not survive silently | Impacted claims are invalidated or queued for review |
| JTBD-06 | An inferred decision appears | approve, edit, or reject it | project history contains intent only when a human stands behind it | Review action is audited and reversible by a new revision |
| JTBD-07 | Two sources disagree | see the conflict rather than a fabricated reconciliation | I can resolve it deliberately | Both claims and evidence remain visible |
| JTBD-08 | I configure a remote model | preview and control egress | private information stays within policy | Provider receives only approved, redacted payloads |
| JTBD-09 | The index is corrupted | rebuild from authoritative evidence | project memory is recoverable | Recovery drill passes without loss of approved knowledge |
| JTBD-10 | I use a coding assistant | query project context through a stable protocol | different tools share the same memory | MCP contract tests pass across reference clients |

## 8. Scope

### 8.1 MVP scope

- One local Git repository per Atlas workspace.
- Git worktree, reachable commit history, diffs, renames, tracked files, Markdown, common package manifests, and test paths as evidence.
- Deterministic file/module/component discovery plus optional provider-assisted candidate summaries.
- Evidence store, temporal entity/relation graph, decision and event history, contradiction records, review queue, and staleness state.
- CLI for initialization, update, status, overview, history, explain, pack, validate, review, export, import, backup, restore, and local server operation.
- Localhost web interface with overview, map, timeline, search, evidence drawer, review queue, privacy center, and health dashboard.
- Task-specific context packages in Markdown and stable JSON.
- Local stdio and localhost MCP server with read-only query tools and explicit candidate-proposal operations.
- `.atlasignore`, secret scanning, egress preview, provider allowlist, and offline/no-model mode.
- Portable JSONL/Markdown export of human knowledge plus deterministic index rebuild.

### 8.2 Post-MVP scope

- Multiple repositories in a workspace.
- Issue tracker and pull-request connectors.
- IDE sidebars and inline annotations.
- Team review roles and signed remote synchronization.
- Language-specific symbol graph adapters beyond the baseline TypeScript/JavaScript support.
- Agent hooks that require a fresh context pack before high-impact edits.
- Policy-as-code for organization-level privacy and retention.

### 8.3 Explicit non-goals

- Replacing Git, source code, issue trackers, or architecture decision records.
- Claiming complete program understanding or proving code correctness.
- Automatically deciding product or architecture strategy.
- Silently documenting every code edit with generated prose.
- Recording keystrokes, developer surveillance, or scoring individual productivity.
- Uploading a repository to a hosted service by default.
- Providing an autonomous write-capable coding agent.
- Treating embeddings or model outputs as authoritative evidence.
- Storing an unrestricted archive of private AI conversations.
- Supporting binary artifact archaeology in the MVP.

## 9. Information architecture

The user-facing product has seven connected areas:

1. **Orientation:** product purpose, users, system boundaries, vocabulary, setup, current health, and recommended first reading.
2. **Map:** component, feature, goal, decision, risk, and task nodes with typed relationships and filters.
3. **Timeline:** chronological events and valid-time history, filterable by component, concept, author, evidence type, and review state.
4. **Explain:** search for a concept, file, symbol, or statement; show current explanation, historical evolution, evidence, conflicts, and unknowns.
5. **Context pack:** describe a task, preview selected material and exclusions, set a budget, validate freshness/privacy, and export.
6. **Review:** approve, revise, reject, or defer machine-inferred claims; resolve contradictions; acknowledge staleness.
7. **Health and privacy:** ingestion status, coverage, stale claims, unresolved conflicts, sensitive paths, redaction events, provider use, backups, and validation results.

The default screen emphasizes orientation and health. It does not lead with a visually impressive but unusable all-node graph.

## 10. Evidence and authority model

### 10.1 Authority classes

| Class | Meaning | Examples | May establish rationale? |
|---|---|---|---|
| Observed | Deterministically extracted from an identified artifact | Git commit metadata, import edge, manifest dependency, file path | No, except quoted explicit text |
| Human-authored | Explicit statement imported or entered by a person | Approved decision, annotation, ADR | Yes, with attribution |
| Machine-inferred | Model or heuristic interpretation | Proposed component purpose, likely change impact | No, until reviewed; always labelled |
| Derived | Reproducible computation over other claims | current component dependency set, stale status | Only if inputs already establish it |
| Unknown | Required information is not supported | missing reason for a database choice | No |

### 10.2 Claim states

- `candidate`: proposed and not accepted as project knowledge.
- `reviewed`: a human accepted or edited the assertion.
- `rejected`: retained for audit but excluded from current projections.
- `superseded`: once valid, replaced from a specified valid time.
- `stale`: supporting evidence changed and the claim needs revalidation.
- `conflicting`: incompatible active claims exist and no resolution is recorded.
- `withdrawn`: author explicitly retracts the claim without erasing history.

### 10.3 Confidence is not authority

Confidence estimates extraction or inference reliability. Review state describes governance. A 0.99 machine inference remains unreviewed; a reviewed assertion may still be disputed or stale. The UI and API must expose both fields independently.

## 11. Functional requirements

Priority meanings: P0 is required for a safe MVP, P1 is required for public beta, and P2 is a planned extension.

### 11.1 Workspace and ingestion

| ID | Priority | Requirement |
|---|---|---|
| FR-001 | P0 | Initialize an Atlas workspace without altering tracked project files except an explicitly accepted configuration directory and ignore entry. |
| FR-002 | P0 | Record repository identity, canonical root, Git object format, default branch if detectable, current HEAD, dirty state, and Atlas configuration. |
| FR-003 | P0 | Perform a full deterministic scan of tracked text files, Markdown, supported manifests, tests, and reachable Git history within configured limits. |
| FR-004 | P0 | Perform incremental ingestion of commits and worktree changes, preserving additions, modifications, deletions, copies, and renames. |
| FR-005 | P1 | Import optional human-selected documents and conversation summaries as separately typed evidence with origin and consent metadata. |
| FR-006 | P0 | Store a content hash, source locator, observed time, extractor version, and sensitivity label for every evidence artifact. |
| FR-007 | P0 | Make ingestion resumable, idempotent, cancellable, and safe after process failure. |
| FR-008 | P0 | Apply `.atlasignore`, size, binary, generated-file, and symlink-boundary policies before content extraction or remote inference. |

### 11.2 Knowledge and time

| ID | Priority | Requirement |
|---|---|---|
| FR-009 | P0 | Represent goals, features, components, interfaces, data stores, external systems, conventions, decisions, risks, tasks, and terms as typed entities. |
| FR-010 | P0 | Represent typed, directed relationships with temporal validity, evidence, confidence, and review state. |
| FR-011 | P0 | Compute a current-state projection without deleting historical entity, relationship, or assertion revisions. |
| FR-012 | P0 | Record a chronological event stream linking meaningful repository changes, human updates, reviews, imports, and generated candidates. |
| FR-013 | P1 | Answer `as of`, `between`, and `how did this evolve` questions using valid-time and recorded-time data. |
| FR-014 | P0 | Support proposed, accepted, rejected, superseded, withdrawn, stale, and conflicting decision/assertion lifecycles. |
| FR-015 | P0 | Detect incompatible active claims and preserve both sides until an explicit resolution is recorded. |
| FR-016 | P0 | Allow human annotations and decisions to be revised only by creating new immutable revisions with attribution and rationale. |

### 11.3 Provenance, review, and freshness

| ID | Priority | Requirement |
|---|---|---|
| FR-017 | P0 | Attach claim-level evidence references and expose authority class, confidence, extractor or model identity, timestamps, and review state. |
| FR-018 | P0 | Visually and structurally distinguish observed facts, derived facts, machine inferences, human assertions, conflicts, stale claims, and unknowns. |
| FR-019 | P0 | Provide a review queue in which authorized local users can approve, edit, reject, defer, or group related candidates. |
| FR-020 | P0 | Audit every review and knowledge mutation with actor, time, before/after revision references, and optional rationale. |
| FR-021 | P0 | Invalidate or mark potentially affected claims stale when supporting evidence, dependencies, extraction rules, or policies change. |
| FR-022 | P0 | Display freshness and knowledge coverage by component, including the reason and evidence behind each status. |
| FR-023 | P0 | Validate provenance, temporal consistency, broken locators, orphan entities, unresolved conflicts, policy compliance, and stale critical claims with machine-readable exit codes. |

### 11.4 Human experience

| ID | Priority | Requirement |
|---|---|---|
| FR-024 | P0 | Generate a newcomer-oriented overview covering product purpose, users, vocabulary, architecture, data flow, setup, current state, risks, unknowns, and recommended entry points. |
| FR-025 | P0 | Render a navigable, filterable project map with progressive disclosure and accessible list/table alternatives. |
| FR-026 | P0 | Render a filterable timeline that links each event to affected entities, assertions, and source evidence. |
| FR-027 | P0 | Explain a file, symbol, component, decision, or concept with current state, history, dependencies, dependents, risks, unknowns, and evidence. |
| FR-028 | P1 | Provide a guided onboarding tour whose answers can be checked against an evidence-backed comprehension rubric. |
| FR-029 | P0 | Search titles, aliases, paths, symbols, claims, events, decisions, and evidence locally, with filters for time, type, state, and sensitivity. |
| FR-030 | P0 | Display concise empty, unknown, stale, conflict, error, and partial-index states rather than generating placeholder certainty. |

### 11.5 Context packages

| ID | Priority | Requirement |
|---|---|---|
| FR-031 | P0 | Generate a task-specific context package from a task description, current project graph, evidence, user policy, and explicit token budget. |
| FR-032 | P0 | Include relevant goals, components, interfaces, conventions, accepted decisions, constraints, risks, recent changes, tests, conflicts, unknowns, and evidence locators in a pack. |
| FR-033 | P0 | Apply deterministic ranking, deduplication, section reservations, and truncation rules, and report every material exclusion. |
| FR-034 | P0 | Block or clearly fail a pack when critical included claims are stale, conflicting, unsupported, or disallowed by privacy policy; never silently omit the warning. |
| FR-035 | P0 | Produce stable versioned Markdown and JSON pack formats containing project/HEAD identity, creation time, policy, token estimate, freshness, and content hashes. |
| FR-036 | P1 | Compare or refresh an old pack and explain which inputs and selected claims changed. |

### 11.6 Interfaces

| ID | Priority | Requirement |
|---|---|---|
| FR-037 | P0 | Provide scriptable CLI commands for init, update, status, overview, map, history, explain, search, pack, review, validate, export, import, backup, restore, serve, and MCP. |
| FR-038 | P0 | Provide a browser interface bound to loopback by default, protected against cross-origin state changes, with no required cloud account. |
| FR-039 | P0 | Provide a versioned local API used by the CLI/web layers rather than duplicating knowledge rules in presentation code. |
| FR-040 | P0 | Provide versioned MCP resources/tools for overview, search, explain, history, context-pack generation, health, and evidence retrieval. |
| FR-041 | P0 | Make MCP read-oriented by default; candidate proposals and review mutations require separately enabled capabilities and explicit user confirmation outside the model call. |
| FR-042 | P1 | Expose documented extension interfaces for evidence extractors, language analyzers, model providers, redactors, exporters, and policy checks. |

### 11.7 Privacy, portability, and recovery

| ID | Priority | Requirement |
|---|---|---|
| FR-043 | P0 | Operate without a configured model, network connection, telemetry endpoint, or hosted account. |
| FR-044 | P0 | Detect likely secrets and sensitive paths before persistence into model queues or egress, apply configured redaction/block rules, and record non-secret audit metadata. |
| FR-045 | P0 | Preview exact remote-provider payloads, destination, purpose, retention assumption, and redactions before first use and whenever policy materially changes. |
| FR-046 | P0 | Encrypt or omit configured sensitive persisted content, protect local database files with least-privilege permissions where supported, and never store provider keys in the Atlas database. |
| FR-047 | P0 | Export an open, versioned, checksum-protected representation of human-authored knowledge, decisions, reviews, configuration, and required evidence locators. |
| FR-048 | P0 | Back up, restore, and deterministically rebuild derived indexes; detect corrupted, incompatible, partial, and Git-history-rewritten states. |
| FR-049 | P1 | Support configurable retention and deletion of cached file bodies, model payloads, outputs, embeddings, and operational logs without erasing required audit history. |
| FR-050 | P1 | Generate a privacy report showing indexed scope, excluded scope, sensitivity findings, egress history, retention state, and configured providers without exposing secret values. |

## 12. Nonfunctional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Correctness | No active factual assertion may appear in an authoritative projection without at least one resolvable evidence reference or an explicit human-authored source. |
| NFR-002 | Integrity | Immutable records use content hashes and referential constraints; validation detects tampering, broken chains, and illegal temporal intervals. |
| NFR-003 | Determinism | Given identical repository objects, configuration, extractor versions, and approved knowledge, deterministic extraction and ranking produce equivalent canonical output. |
| NFR-004 | Performance | On the reference 100k-file/20k-commit repository, warm incremental update for a 50-file change completes in p95 under 60 seconds on the published reference machine. |
| NFR-005 | Performance | Local search returns the first page in p95 under 300 ms and overview opens in p95 under 1 second after indexing on the reference machine. |
| NFR-006 | Scale | MVP supports at least 100k tracked files, 20k commits, 250k assertions, and 1 million evidence edges without correctness degradation. |
| NFR-007 | Reliability | A killed ingestion process leaves the last committed projection readable and can resume or restart without duplicate semantic records. |
| NFR-008 | Recovery | Backup/restore and rebuild drills meet recovery point objective of the last committed human mutation and recovery time objective of four hours at maximum supported scale. |
| NFR-009 | Security | Network listeners bind to loopback by default; state-changing HTTP requests require session authorization and origin/CSRF protection. |
| NFR-010 | Privacy | No repository content, paths, prompts, or identifiers leave the machine unless an enabled feature and matching egress policy permit it. |
| NFR-011 | Accessibility | Core web flows meet WCAG 2.2 AA, work by keyboard, do not rely on color alone, and expose graph information through an equivalent structured view. |
| NFR-012 | Compatibility | The supported baseline is Node.js 24 on current Windows, macOS, and Linux, and Git repositories using SHA-1 or SHA-256 object formats. |
| NFR-013 | Portability | Export formats are documented, versioned, migratable, and readable without Context Atlas proprietary services. |
| NFR-014 | Observability | Every run has a correlation ID and structured local diagnostics, while logs avoid file bodies, secrets, and model payloads by default. |
| NFR-015 | Maintainability | Domain rules are tested independently of CLI, web, model, and database adapters; migrations have forward and rollback/recovery tests. |
| NFR-016 | Usability | A first-time user can initialize, inspect scope, run an update, open an overview, and generate a safe pack without reading external documentation. |
| NFR-017 | Cost control | Model usage has per-run and per-day token/cost ceilings, dry-run estimates, cache keys, and hard-stop behavior. |
| NFR-018 | Backward compatibility | Stable CLI JSON, pack, export, local API, and MCP contracts use explicit versions and compatibility tests for at least the previous minor version. |

## 13. Critical UX flows

### 13.1 First-run initialization

1. User runs `atlas init` in a Git worktree.
2. Atlas reports repository identity, current branch/HEAD, estimated scope, ignored/generated/binary files, and whether any path exits the root through a symlink.
3. Atlas explains local storage, default no-network behavior, sensitive-content policy, and optional model behavior.
4. User previews the configuration and explicitly accepts files Atlas will add.
5. Atlas creates the local store and begins deterministic indexing.
6. Progress distinguishes discovered, extracted, skipped, sensitive, failed, and pending-review items.
7. Completion opens or links to an orientation page, a health result, and the most important unknowns.

Failure behavior: if interrupted, the user retains a consistent previous snapshot and can resume. If the repository is unsupported or outside policy, initialization stops before writing project configuration.

### 13.2 Newcomer orientation

1. User opens Overview.
2. The page leads with purpose and user value, then boundaries and a small component view.
3. Each statement carries a compact authority/freshness marker; selecting it opens evidence.
4. The user follows a suggested path through vocabulary, request/data flow, setup, tests, risks, and active work.
5. Unknown or conflicting rationale is shown inline as a question, not smoothed over.
6. The user can switch to `show me the evidence` or `explain as of <date>` at any point.

### 13.3 Update after code changes

1. User runs `atlas update` or a configured watcher detects a stable change set.
2. Atlas records the old and new Git/worktree evidence identities.
3. Deterministic extractors update observations and compute an impact frontier.
4. Claims whose support changed become revalidated, stale, or conflicted according to rules.
5. Optional inference produces candidate events/explanations, never active reviewed knowledge.
6. The summary shows changed components, newly stale critical claims, conflicts, candidates, coverage regression, and failures.
7. User reviews only high-impact candidates first; low-risk items remain visibly pending.

### 13.4 Review an inferred decision

1. Review card states the proposed decision in plain language and labels it machine-inferred.
2. Evidence pane shows supporting and contradicting artifacts, relevant diff, source dates, provider/model, and confidence explanation.
3. Reviewer can approve as written, edit and approve, reject with reason, defer, or mark rationale unknown.
4. Approval creates a human-authored revision pointing to the candidate and evidence.
5. If it supersedes an existing decision, the reviewer must select the effective time and relationship.
6. Audit entry is immediately visible; the original candidate remains immutable.

### 13.5 Generate an LLM context pack

1. User describes a concrete task and optionally identifies starting files/components.
2. Atlas parses candidate concepts locally and previews relevant entities and excluded sensitive areas.
3. User chooses target format/model budget and privacy policy.
4. Atlas computes relevance, reserves space for goals/constraints/risks/unknowns, deduplicates, and checks freshness.
5. Critical stale/conflicting/unsupported inputs stop generation or require an explicit unsafe override recorded in the pack.
6. Preview shows every section, evidence link, exclusion reason, estimated tokens, and any planned external call.
7. User exports Markdown/JSON or makes it available through MCP.
8. Later refresh reports changes rather than silently replacing the old artifact.

### 13.6 Resolve a conflict

1. Conflict view presents both claims symmetrically with validity intervals and evidence.
2. User may declare one unsupported, constrain their scopes/times so both can be true, create a superseding assertion, or leave unresolved.
3. Resolution creates new revisions and an audit event; it never edits source evidence.
4. Dependent projections and packs are invalidated and rebuilt.

### 13.7 Privacy and egress review

1. User enables a model provider.
2. Atlas verifies credential reference without persisting the secret.
3. A sample/real payload preview shows destination, exact selected content, redactions, estimated tokens/cost, provider retention assumption, and policy version.
4. Secret scanning or a denied path blocks the call; user must change policy or remove content outside the one-click flow.
5. Consent is scoped to provider, repository, purpose, and policy version.
6. Audit stores hashes, counts, decisions, and destination metadata—not raw secrets or payload bodies by default.

### 13.8 Recover from corruption or rewritten Git history

1. `atlas validate` identifies database corruption, checksum mismatch, broken evidence locator, migration mismatch, or unreachable Git objects.
2. Atlas preserves the damaged store read-only for diagnosis.
3. User restores the latest backup of approved knowledge and configuration.
4. Derived observations and indexes rebuild from current Git evidence.
5. Atlas reports semantic differences, orphaned historical locators, and claims requiring re-review.
6. Recovery completes only after integrity and provenance gates pass.

## 14. Interface summary

### 14.1 CLI conventions

- Human-readable output by default; `--json` emits a versioned envelope.
- Read commands never mutate implicitly.
- Mutation commands support `--dry-run`; destructive retention actions require explicit target and confirmation unless a scoped automation flag is provided.
- Exit codes distinguish success, warnings/staleness, policy block, invalid data, partial ingestion, and internal failure.
- All commands accept `--workspace` and report resolved repository/store identity to prevent wrong-directory actions.

### 14.2 Web conventions

- Binds to `127.0.0.1`/`::1` unless the user deliberately configures another interface and authentication.
- Deep links are stable for entity, assertion revision, event, evidence, review item, and pack.
- All graph views have list/table equivalents.
- Generated language is never displayed without authority and freshness cues.

### 14.3 MCP conventions

- Read-only tools are the default capability surface.
- Responses contain stable IDs, concise text, evidence locators, confidence, freshness, and truncation metadata.
- Tool responses never imply that an inference is approved.
- Mutations create candidates or requests; they do not approve their own output.
- Each client can declare a maximum character/token budget and receives deterministic pagination/cursors.

## 15. Adoption and launch plan

### 15.1 Design-partner alpha

- 5–10 local-first solo builders with repositories of different sizes.
- Weekly observed onboarding and context-pack sessions.
- No remote telemetry requirement; participants can export a redacted diagnostics bundle.
- Gate: provenance, recovery, and secret-egress safety tests pass before any external model is enabled.

### 15.2 Private beta

- 25–50 users, including maintainers and newcomers.
- Supported operating systems and repository sizes published.
- Compare comprehension, pack quality, and maintenance effort against manual README/chat workflows.
- Gate: target freshness, performance, accessibility, data migration, and trust-calibration metrics pass.

### 15.3 Public beta

- Stable CLI/package distribution, signed artifacts, migration policy, security reporting path, and public schema documentation.
- Remote inference remains opt-in and provider adapters are separately documented.
- Gate: two successful release upgrades and disaster-recovery exercises from the prior minor version.

### 15.4 General availability

- Compatibility guarantees for persisted/exported formats and APIs.
- Defined support/deprecation windows.
- Independent threat-model review and seeded-secret egress audit.
- Evidence-backed claims and context packs evaluated on a maintained multi-project benchmark.

## 16. Product analytics and privacy-preserving metrics

Atlas must work with telemetry disabled. If a user opts in, events contain coarse counts, durations, state transitions, version/platform, and randomized installation identity; never repository names, paths, code, claims, task text, Git messages, evidence contents, or pack contents.

Measure:

- Activation funnel: init → successful update → overview viewed → evidence inspected → first pack generated.
- Time to first trustworthy overview and first useful pack.
- Candidate approval/edit/rejection/defer rates by extractor, never by developer productivity.
- Stale critical claim time-to-review.
- Conflict resolution time and recurrence.
- Context-pack token reduction and rubric recall.
- Secret/policy blocks and false-positive overrides, using categories only.
- Restore/rebuild success rate.
- Search zero-result and evidence-broken rates.
- User-reported incorrect explanation rate, with opt-in redacted report.
- Retention: repositories active after 1, 4, and 12 weeks.

Anti-metrics: number of generated summaries, total tokens used, graph size, or review volume must not be treated as success by themselves.

## 17. Business and packaging hypothesis

The open/local core should include deterministic indexing, the evidence graph, reviews, map/timeline, packs, CLI, web, MCP, export, and safety controls. Future paid value may include team synchronization, organization policies, managed connectors, enterprise identity, signed attestations, fleet health, and hosted model routing. Core safety and data portability are not premium gates.

Initial pricing research should test value against reduced onboarding time, fewer regressions, and safer agent usage—not against token volume. No pricing decision is required for MVP implementation.

## 18. Definition of MVP success

MVP is not complete merely because a graph renders or a summary is generated. It is complete only when:

1. All P0 requirements in this document have passing verification evidence recorded in `REQUIREMENTS_TRACEABILITY.md`.
2. The seven primary product risks have preventative, detective, and recovery controls with exercised tests.
3. A seeded reference project can be indexed, changed, reviewed, queried as-of, packed, exported, corrupted, restored, and rebuilt.
4. A newcomer can complete the orientation rubric without hidden project knowledge.
5. A mocked provider cannot receive seeded high-confidence secrets or ignored-path content.
6. Generated claims remain labelled and cited across CLI, web, exports, and MCP.
7. Performance, scale, accessibility, compatibility, migration, and recovery gates meet their stated NFR thresholds.

## 19. Glossary

- **Artifact:** a source object such as a Git blob, commit, diff, document, or imported note.
- **Evidence:** an immutable, addressable observation used to support or contradict a claim.
- **Entity:** a stable conceptual thing such as a component, goal, decision, risk, or task.
- **Assertion/claim:** a versioned statement about an entity or relationship.
- **Observation:** a deterministic claim directly extracted from evidence.
- **Candidate:** a machine-proposed assertion not accepted as project knowledge.
- **Projection:** a computed view such as current state, overview, map, or pack.
- **Valid time:** when a claim applies to the project being described.
- **Recorded time:** when Atlas learned or stored the claim.
- **Supersession:** a new assertion or decision replacing an older one from a specified valid time.
- **Staleness:** a state indicating that support or dependencies changed after validation.
- **Conflict:** incompatible claims active in overlapping scope and valid time.
- **Context pack:** a versioned, cited, token-budgeted project brief selected for a specific task.
- **Authority class:** observed, derived, human-authored, machine-inferred, or unknown.
- **Coverage:** how much of an expected knowledge surface has current supported assertions; it is not a correctness score.
