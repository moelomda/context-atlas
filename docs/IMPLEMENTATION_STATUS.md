# Context Atlas Implementation Status

Audit date: 2026-08-17
Baseline: current frozen `0.1.0` worktree; no immutable release commit has completed the final gates
Classification: working experimental alpha candidate; not a production, public-beta, or release approval

This status is intentionally narrower than the product plan. The requirement-by-requirement assessment remains in [`FULL_SCOPE_AUDIT.md`](./FULL_SCOPE_AUDIT.md); source presence or a test definition does not complete a plan item.

## Current verification status

`SOURCE-INSPECTED` below means the implementation and focused assertions are present in the frozen tree. It does not mean the current candidate was executed successfully. `DIRECT PASS` describes only the exact no-worker command named in the boundary. `UNVERIFIED` means the final result is unknown, not that the product gate failed.

| Gate | Current result | Exact boundary |
| --- | --- | --- |
| Source and test TypeScript graphs | **DIRECT PASS** | Direct strict no-emit compilation passed for `src/**/*.ts` and the combined source/test project on the current worktree. This is type safety, not behavioral execution. |
| `npm run check` | **UNVERIFIED** | The final `npm test` attempt reached 14 test files but the Node runner rejected every worker before loading assertions with `spawn EPERM`; the complete current build-and-test result is therefore not certified here. |
| `npm run test:coverage` | **UNVERIFIED** | No current coverage result exists for this frozen source. Earlier totals and percentages are retired. |
| Narrow ledger/event runtime | **PARTIAL DIRECT PASS** | A direct compiled SQLite harness passed transactional event binding, immutable content, wrong-ledger-kind rejection and v4→v5 backfill. Spawn-dependent process-kill, torn-tail and concurrent-recovery assertions remain unexecuted on this snapshot. |
| Plugin runtime/legal drift | **DIRECT PASS** | Direct TypeScript emit, web copy, esbuild bundle, deterministic third-party notices and license copy were regenerated; a second independent generation matched all shipped hashes. Plugin and skill validators passed. |
| MCP conformance and compact response cap | **PARTIAL DIRECT PASS** | Direct source and extracted-archive stdio handshakes discovered exactly 10 tools and all 10 declared read-only; `atlas_context_pack` exposes existing `overrideId` consumption. Full context-pack response-cap assertions did not run. |
| Package/archive/fresh install | **PARTIAL DIRECT PASS** | The current real archive passed required/forbidden inventory, byte-size, recomputed SHA-1/SHA-512, legal-file and identity checks; extracted CLI help, three dashboard assets and bundled MCP discovery passed. A clean dependency install plus live CLI/web/MCP workflow remains hosted-CI work. |
| Web/API and rendered browser | **PARTIAL DIRECT PASS** | The compiled static UI contract test passed and the built server directly refused `0.0.0.0`. No current Git-backed API integration, cross-browser render, screenshot, keyboard script, screen-reader result, or WCAG report is certified here. |
| Offline high-severity dependency audit | **DIRECT PASS** | `npm audit --offline --audit-level=high` reported zero known vulnerabilities in the current lockfile; this is not an independent security review. |
| Hosted CI, audit, CodeQL, dependency review, release | **UNVERIFIED** | Workflow definitions exist, but the exact release commit and hosted results are still pending. |

## Source-inspected alpha boundary

- Context-pack schema v2 always carries 15 required sections: identity/authority, warnings, goals, components, interfaces, conventions, decisions, constraints, risks, recent changes, tests, conflicts, unknowns, evidence, and exclusions. Each section is explicitly `present`, `none`, or `unknown`.
- Pack allocation is whole-item: selected entities, assertions, and events render without substring truncation; every material candidate in the bounded selector universe is included or carries an exact ID, section, evidence IDs, and exclusion reason. Ambient non-material records are counted separately. Selection/Markdown parity and evidence closure are asserted by focused source tests.
- The hard pack budget covers the complete compact JSON object using the disclosed characters-divided-by-four estimator. The MCP adapter reserves room for its complete tool-result envelope. A request at the 500-token input floor is refused with a computed minimum when the mandatory envelope cannot fit.
- Current evidence is locally revalidated before authoritative presentation or packing. File locators require a canonical repository-relative non-symlink text file within the bounded size and current policy; Git locators require a canonical reachable commit; repository/component locators are recomputed from the bounded live observation. Digests must be canonical SHA-256. Unknown provider kinds remain `provider-not-validated`.
- Overview, graph, search, explain, current assertion, CLI, `/api/v1`, MCP, pack, and dashboard contracts carry explicit presentation status, settled state, reason, authority, evidence, and warnings. Stale/conflicting/unknown reviewed prose is withheld as current summary while immutable history remains queryable.
- A guidance-dependency watermark binds reviewed claims to effective extraction configuration, ordered `.atlasignore` policy, configuration-schema version, and extractor version. It is distinct from the SQLite migration version; runtime-only pack-budget changes do not alter it.
- Product mutations use the schema-v5 store, retaining the immutable SQLite outbox and fsynced hash-ledger reconciliation while adding immutable timeline content digests and one-time, domain-checked event-to-ledger bindings. Narrow fault-test definitions cover event-row tamper rejection, committed-outbox process kill, torn and malformed ledger framing, byte-preserving refusal, and two recovery processes serializing one append.
- Proposal approval revalidates current evidence rather than trusting stored rows, synchronization preflights event content/ledger bindings before mutation, and both fresh and legacy local ignore files protect full migration snapshots before they are written.
- The MCP inventory remains 10 tools and read-only: no synchronization, proposal, approval, or rejection tool exists. `atlas_context_pack` can only consume an already-created, matching, unexpired human CLI override ID; it cannot create or mutate one, it keeps the overridden-critical warning prominent, and an override cannot bypass evidence closure.
- The dashboard source adds skip navigation, live status regions, combobox/listbox search semantics, roving map focus, keyboard navigation, focusable semantic map/component tables, and reduced-motion, increased-contrast, and forced-colors handling.
- Portable schema v2, checksummed export/import, backup/restore primitives, privacy inventory, and non-destructive retention preview remain available at the previously implemented alpha depth.
- New repositories are initialized with an 8,000-token default. Existing repositories keep their stored setting, including the legacy 4,000-token value, unless an operator edits the configuration.
- Distribution controls now define plugin license copying, third-party notice generation from actual bundle inputs, generated-runtime/license/notices drift rejection, required package assets, forbidden local state, and version parity across tag, package, lockfile, plugin manifest, MCP advertisement, and changelog. The package is marked private and the workflow still does not publish to npm.

## Compatibility and operator action

- Pack consumers must handle `schemaVersion: 2` and the 15-section/compact-JSON selection contract. This is an explicit `0.x` contract change.
- Updating the program does not rewrite an existing repository's configured pack budget; legacy 4,000-token repositories remain at 4,000 until changed.
- Accepted assertions created before guidance-watermark tracking are presented as `unknown`, and health reports a critical guidance-boundary finding. Synchronization creates a watermarked replacement overview proposal, but old reviewed prose does not become current merely because sync completed.
- An operator must synchronize under the new extraction boundary and complete a new human review. Other legacy accepted assertions require a supported superseding reviewed revision. There is deliberately no migration that silently upgrades historical review authority.

## Four requested outcomes

| Outcome | Status | What exists | Exact residual |
| --- | --- | --- | --- |
| Detailed product and implementation plan | **IMPLEMENTED as planning** | Five planning documents define requirements, architecture, risks, milestones, and proof expectations. | Most production/beta proof remains absent; planning is not shipment. |
| Start-to-now human mind map | **PARTIAL** | Reachable Git history, repository structure, manifests, documents, decisions, assertions, relationships, and events feed a bounded SVG plus semantic table and timeline. | No full symbol/feature/data-flow model, branch-lineage or historical graph view, maximum-repository result, or newcomer study. |
| Newcomer explanation with no prior knowledge | **PARTIAL** | Overview, guided briefing, current-use labels, evidence IDs, risks, unknowns, and entry points exist. | No known-truth rubric completion, rendered cross-browser proof, manual accessibility result, or measured comprehension. |
| Durable high-level LLM continuity | **PARTIAL** | Local reviewed memory, schema-v2 bounded packs, explicit evidence/current-use metadata, and a 10-tool read-only MCP adapter exist in source. | No enforced pre-change invocation, persistent pack refresh/diff/history, provider-tokenizer matrix, multi-repository memory, or long-session/downstream coding evaluation. |

## Exact remaining release and product residuals

1. **Pack lifecycle and evaluation:** no immutable saved-pack history, refresh/diff command, historical pack mode, provider tokenizer, target-corpus recall/token-reduction result, downstream-change benchmark, or one-version-back contract fixture. `unknown` sections report missing knowledge; they do not prove it.
2. **Evidence and provenance:** provider-specific validators, extractor identity on every claim, semantic-support review, complete rendered-claim denominator, relocation support, and broad race/permission/path corpora are missing. The local file validator is bounded to 1,000,000 bytes.
3. **Authority and governance:** no authenticated human identity or roles, full edit/defer/unknown/withdraw lifecycle, optimistic review watermark, symmetric conflict resolution, dependency invalidation graph, or complete seven-state cross-interface parity/accessibility matrix exists.
4. **Recovery:** the new fault cases are narrow. There is no disk-full test, kill at every ingestion/flush phase, SQLite corruption matrix, checkpoint/cancel/resume, general concurrent product-writer proof, copy-verify-swap restore, real deterministic derived rebuild, Git-rewrite drill, or maximum-scale RPO/RTO result.
5. **MCP:** resources, cursors, requested snapshots, every-tool response-cap cases, second-client conformance, and a trusted optional mutation-capability design are missing. MCP remains intentionally read-only.
6. **UI and web:** review/conflict mutation workspace, complete evidence drill-down, large-graph rendered proof, browser matrix, responsive screenshot QA, manual keyboard/screen-reader run, WCAG 2.2 AA audit, and usability/trust studies are missing.
7. **Runtime and distribution:** Node 24 still labels the built-in SQLite API experimental. Direct emit/runtime/legal/archive/extracted CLI+MCP/static-dashboard/audit checks passed at the boundaries above; the full behavioral suite and coverage, clean dependency-install/live web smoke, hosted workflows, repository security settings, signing/SBOM/provenance, rendered-browser checks, and actual prerelease creation remain pending.
8. **Scale and product breadth:** incremental/resumable ingestion, FTS and semantic analyzers, retention deletion/tombstones, provider/egress/consent, encrypted portable archives, external conversation/document imports, extension ports, IDE integration, collaboration, and public-beta scale/adoption evidence remain partial or missing as recorded in the full audit.

## Release decision

The frozen tree supports this source-level statement only:

> Context Atlas 0.1 is an experimental local-first alpha candidate whose source implements evidence-backed Git ingestion, reviewed temporal assertions, current-use presentation guards, locally validated evidence, schema-v2 bounded navigation packs, a recoverable audit outbox, a structural dashboard, and a 10-tool read-only MCP adapter.

It is **not release-approved in this workspace**. Do not claim a passing current suite, coverage level, packaged runtime, browser/accessibility result, crash/scale qualification, production safety, public-beta readiness, or completion of the broader plan until the pending gates and residual work have scope-matched evidence on an immutable release commit.
