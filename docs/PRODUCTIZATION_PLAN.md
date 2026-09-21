# Context Atlas: route from alpha to a product you can use daily

This plan is grounded in the checked-out implementation. New commands, modules, interfaces, and performance targets below are proposals unless explicitly identified as current. See the [branch consolidation record](CONSOLIDATION_2026-09-19.md) and [real-world benchmark protocol](REAL_WORLD_BENCHMARK_PLAN.md). Implementation of the proposed roadmap starts from the final consolidated main commit.

The first [task-context navigation milestone](TASK_CONTEXT_MILESTONE.md) now implements policy-filtered file pointers, lexical pack ranking, and a reproducible three-task development comparison. Symbol extraction, shared indexed search, incremental indexing, exact model tokenization, and downstream coding evaluation remain future work. The original gap analysis below describes the consolidation baseline.

## Product decision

Build one excellent local developer tool first: **before an agent edits a TypeScript repository, Context Atlas gives it the relevant code, tests, decisions, and constraints for that task, with working citations and an explicit freshness boundary. After the change, it updates the index and identifies which decisions need review.**

The first customer is a developer repeatedly working on a repository with a coding agent. The primary workflow is CLI plus MCP. The dashboard supports inspection and review. Success is better completed code changes with less repeated context work; a bigger knowledge graph is not the success metric.

Choose TypeScript/JavaScript as the initial semantic-analysis support boundary because this repository can dogfood it. Other languages retain clearly labeled file/document navigation until a language adapter has its own tests and evaluation. Do not claim arbitrary-language understanding from extension contracts alone.

Keep one package, one local SQLite store per worktree, and thin CLI/MCP/web adapters. Do not add accounts, a hosted service, a vector database, team permissions, billing, or a marketplace to prove this use case.

## What already exists and what is actually missing

| Area | Current implementation | Required next behavior |
| --- | --- | --- |
| Distribution | Node 24 package with CLI, MCP, ESM exports, source builds and package-smoke machinery; `private: true` | One versioned, tested downloadable package; one five-minute installation and first-task guide. Registry publication can wait. |
| Ingestion | `src/core/ingest.ts` enumerates repository files, observes directories/manifests/documents, and skips already-recorded Git commits; it deactivates and reconstructs the observed projection | Changed-file extraction, explicit deletion/rename handling, persisted extraction identity, and unchanged-work fast path |
| Code understanding | Directory components, manifest dependencies, document lead-paragraph summaries | Named symbols, imports/exports, source locations, bounded document sections, and test-to-module navigation |
| Retrieval | `relevanceScore` in `src/core/util.ts` performs keyword substring matching; query/pack code loads broad record sets | Indexed lexical retrieval plus exact path/symbol matching and bounded dependency expansion; measured selection quality |
| Freshness | Live evidence validation, repository fingerprints, guidance watermarks, snapshot-change rejection | Explicit task-start refresh and dependency-specific invalidation so an unrelated edit does not unnecessarily interrupt useful reviewed guidance |
| Agent interface | Thirteen read-only MCP tools; `atlas_context_pack` accepts task, repo, optional budget and existing override ID | Tested client setup, consistent task-start invocation, compact useful payload, actionable stale/indexing responses |
| SDK | `src/index.ts` already exports initialization, sync, search, pack and history functions | A small documented task-context facade and a working example consuming the packed package |
| Evaluation | Synthetic CLI performance harness with versioned reports and several scale fixtures | Ground-truth retrieval and paired downstream coding evaluation; performance alone cannot establish product value |

The database contains reviewed assertions and audit state as well as derived observations. Do not treat the entire `.context-atlas` directory as a disposable cache. New FTS and symbol indexes may be rebuildable; reviewed decisions still need verified backup/export and preservation across migrations.

## Use it through your own code today

The existing source supports the following workflow. These commands do not imply an npm registry release exists.

Build and package the consolidated checkout using the Node version allowed by its `engines` field:

```sh
git clone https://github.com/moelomda/context-atlas.git
cd context-atlas
npm ci
npm run check
npm pack
```

In a separate Git project, install the generated tarball as a development dependency, using its actual path and filename:

```sh
npm install --save-dev ../context-atlas/context-atlas-0.1.0.tgz
npx context-atlas init .
npx context-atlas health --repo .
npx context-atlas pack "Fix session expiry without changing the public API" --repo . --budget 8000 --json
```

Configure `.atlasignore` before the initial indexing if your project needs additional exclusions. On subsequent coding tasks, explicitly synchronize and request context:

```sh
npx context-atlas sync --repo .
npx context-atlas pack "Fix session expiry without changing the public API" --repo . --budget 8000
```

Initialization already synchronizes; a second initial sync is unnecessary. If the pack is blocked, use the health result and the actual reported remedy. Do not insert an automatic override into a wrapper. A sync updates observations; it does not automatically approve a human decision.

For an ESM TypeScript developer script, this uses the actual exported names and argument signatures in the current source:

```ts
// scripts/atlas-context.mts
import path from "node:path";
import { buildContextPack, syncRepository } from "context-atlas";

const task = process.argv[2]?.trim();
const repositoryArgument = process.argv[3];
if (!task || !repositoryArgument) {
  throw new Error('Usage: atlas-context "specific coding task" /absolute/path/to/repo');
}

const repository = path.resolve(repositoryArgument);
// The repository must already have been initialized once using the CLI.
// Running this script explicitly requests a refresh of its local Atlas state.
syncRepository(repository);
const pack = buildContextPack(repository, task, 8_000);

if (!pack.repository.synchronized || !pack.freshness.safeToUse || !pack.safety.safeToUse) {
  throw new Error("Context is not current and usable; inspect context-atlas health.");
}

process.stderr.write(JSON.stringify({
  packId: pack.packId,
  head: pack.repository.head,
  warnings: pack.warnings,
  estimate: pack.estimatedTokens,
}) + "\n");
process.stdout.write(pack.markdown);
```

Compile/run this with your project's existing TypeScript runner or compiler. For a JavaScript-only script, the same body can live in `.mjs` and run with Node. The example is verified against source signatures; runtime qualification must exercise the installed tarball. Pass stdout into the context stage of your agent runner, then let the agent open cited source files and run its normal tests. These APIs are synchronous developer tooling; avoid putting repository scans in a production application's request handler.

For MCP, configure your chosen client's local stdio server with command `node` and an absolute argument pointing to the built `dist/mcp/server.js`. Configuration file names differ by client. Always pass the target project's absolute path to tools, rather than relying on the server working directory:

```json
{
  "tool": "atlas_context_pack",
  "arguments": {
    "repo": "/absolute/path/to/your-project",
    "task": "Fix session expiry without changing the public API",
    "tokenBudget": 8000
  }
}
```

This is the tool call shape, not a universal client configuration file. Successful MCP responses use a contract envelope; consume the result under `data` and retain snapshot metadata. The MCP server is currently read-only. Refresh with the CLI before asking the agent to begin; enabling a background indexer later must be an explicit installation choice.

## Target internal architecture

Extract modules when adding behavior; avoid a wholesale rewrite of already-tested code.

| Boundary | Keep / extend | Responsibility and rule |
| --- | --- | --- |
| Repository snapshot | `core/git.ts`, `ignore.ts`, `config.ts`; new `core/freshness.ts` | Canonical worktree identity, HEAD/index/worktree/policy snapshot, changed paths and scan coverage. One request-scoped observation reused inside a guarded operation. |
| Index coordinator | `core/ingest.ts`; new `core/index-state.ts` | Plan changed artifacts, invoke extractors, stage derived changes, publish one committed index generation. Never publish a half-indexed generation. |
| Extraction | Existing manifest/document extraction; new `core/analyzers/typescript.ts` and `core/document-chunks.ts` | Deterministic observations with source ranges, content digests, extractor version and coverage diagnostics. Reuse the existing language-analyzer contract where practical. |
| Storage and history | `core/database.ts`, `ledger.ts`, `temporal.ts`, `proposals.ts` | Migrations, durable reviewed assertions, derived projections, outbox recovery. Writers serialize; reads bind to a published generation. |
| Retrieval | New `core/retrieval.ts`; callers in `query.ts` and `context-pack.ts` | One shared candidate selector, SQL limits and indexed filters, explainable ranking, bounded graph expansion. No duplicated ranking policies across adapters. |
| Context assembly | `core/context-pack.ts`, `pack-lifecycle.ts`; new `core/token-budget.ts` | Allocate useful evidence-bearing items to a bounded pack; preserve warnings, authority and evidence closure. Count exactly the representation sent to the client. |
| Product use case | New `core/task-context.ts`; exported through `src/index.ts` | Orchestrate explicit refresh, snapshot checks, retrieval and pack generation; return typed outcomes with next actions. |
| Transports | `cli.ts`, `mcp/server.ts`, `web/server.ts` | Input validation and serialization only; every surface invokes the same use cases. Keep MCP reads read-only. |

Proposed new facade, deliberately distinct from the current API:

```ts
type TaskContextRequest = {
  repo: string;
  task: string;
  tokenBudget: number;
  freshness: "require-current" | "refresh";
};

// Proposed: prepareTaskContext(request)
// Returns a discriminated outcome: ready, stale, indexing, or blocked.
// Every non-ready outcome carries a reason and concrete next action.
```

The CLI's proposed `context-atlas task "..." --refresh --json` uses this facade. Existing `pack` and MCP calls remain reads. An SDK/CLI invocation with `freshness: "refresh"` is explicit authority to update local observed state; it never grants authority to approve proposals or transmit code to a model provider.

### Incremental indexing and freshness

1. Add tables for indexed artifacts and extraction results: worktree ID, canonical relative path, content digest, extractor/version/config digest, status and last published generation. Use separate derived tables for document chunks, code symbols and import edges. Each artifact result records its source evidence IDs.
2. Capture the repository boundary before the scan. Use Git changes plus previously indexed paths to detect modifications, new files, deletion and rename; include configured untracked inputs. File-system notifications only accelerate discovery and never prove freshness.
3. Reuse extraction results only when content digest and extractor/policy identity match. Ignore-policy changes invalidate the affected index. Branch changes and rebases reconcile against the selected commit; do not assume every update is a fast-forward.
4. Do expensive reads/parsing outside the write transaction. Recheck the boundary, commit changed derived records, tombstones and generation metadata in one short transaction, and use the existing outbox discipline. Retry a bounded number of times on concurrent edits, then return an actionable stale/indexing outcome.
5. Map reviewed assertions to supporting artifact/evidence identities. Invalidate affected assertions when support changes. A broad project overview can still depend on the entire repository. Do not renew review authority merely because an extractor reruns; preserve review only when its declared dependency boundary is unchanged and validated.
6. Bind packs to repository/worktree identity, HEAD, dirty-state content fingerprint, published index generation and guidance policy. Check the snapshot again before returning a pack. Reuse a request-local validation context to reduce duplicate Git/file checks without hiding changes between operations.
7. Add optional `watch` only after the explicit task-start refresh works. Debounce events, serialize index work, recover after interruption and periodically reconcile. Test missed events, branch switches and rapid edits. State remains per worktree initially.

Do not force every read to rehash every file or replay every audit event forever. Establish measurement first, then add verified checkpoints/request-level reuse with tests showing tampering or concurrent changes cannot silently be accepted. Avoid weakening integrity checks merely to hit a latency number.

### Retrieval that can answer coding tasks

Start with deterministic extraction and lexical search; embeddings are an experiment only after a strong measured baseline.

1. Parse TypeScript/JavaScript declarations and imports without executing project code. Retain file path, symbol name/kind, exported signature, source range, digest and resolved imports. Report unresolved imports and unsupported syntax instead of inventing edges. Reuse a parser already compatible with the qualified runtime; qualify its packaged runtime cost.
2. Split Markdown by headings and code by declaration boundaries, with bounded size and enough surrounding context. Store exact source locators. Keep raw source access behind the existing path/size/secret policies.
3. Add SQLite FTS5/BM25 over names, paths, headings, signatures and selected text, using the documented `MATCH`/ranking behavior in the [official SQLite FTS5 reference](https://www.sqlite.org/fts5.html). Verify FTS5 availability on every supported Node/SQLite runtime in install tests. Parameterize SQL, escape/construct the FTS query separately, and test punctuation, quoted identifiers and malformed expressions. If unavailable, return an explicit capability limitation rather than silently advertising the same retrieval behavior.
4. Query separate bounded candidate lists for exact path/symbol matches, lexical content, reviewed constraints/decisions and recent relevant changes. Fuse rankings using a documented deterministic policy, expand one hop over real import/declaration/test links, then deduplicate overlapping spans. Global always-applicable constraints are included independently of task wording.
5. Filter stale, denied and unsupported evidence before promoting current guidance. Label unresolved/unknown areas and show why a candidate was selected. Start with small fixed candidate/edge bounds; tune on development tasks and freeze them before evaluating held-out tasks.
6. Compare current 15-section payload cost with a compact agent-facing view that includes useful excerpts, test entry points, applicable decisions and citations. Keep the durable snapshot's full audit detail. If the wire contract changes, version it and add an old-consumer compatibility fixture; do not silently reinterpret schema v2.
7. Add a pluggable target tokenizer and count the actual serialized transport payload, including metadata. Continue disclosing the current characters/4 estimator until a selected tokenizer is used. Mandatory warnings remain mandatory; fix duplicated representation and empty boilerplate before increasing context budgets.

An LLM-generated description may be useful later, but keep it a labeled inference with exact supporting evidence. It cannot manufacture the reason a design decision was made.

## The next six implementation PRs

Time ranges assume one experienced engineer who can work substantially full time, plus maintainer review. They are planning estimates, not delivery promises. Stop and change the approach when a gate fails.

Branch consolidation is the prerequisite. These are six subsequent reviewable changes, each with a measurable outcome; the design document itself does not implement them.

| PR and planning estimate | Work | Gate before advancing |
| --- | --- | --- |
| 1 — Installed daily workflow and baseline, 3–5 days | Ship a tarball consumer example; add `core/task-context.ts` and explicit refresh CLI wrapper; typed errors and concise help; instrument latency/candidate counts/bytes/Git calls; freeze the first benchmark tasks | Clean Windows/Linux installs run CLI, SDK and real MCP reads. Five representative tasks on Context Atlas and one external TS repository run end-to-end; stale/budget failures are actionable; baseline results are saved before retrieval changes |
| 2 — Useful source evidence, 3–5 days | Add document chunks, TS/JS symbol/import extraction, source ranges and derived-table migrations; reuse analyzer contract | Every extracted item resolves to a pinned source range; fixtures cover aliases, duplicate names, malformed source, excluded files and unresolved imports; no execution of repository code during extraction |
| 3 — Shared indexed retrieval, 3–5 days | Add FTS, exact symbol/path ranking, bounded relationship expansion and shared selector used by search and packs; expose opt-in selection trace | Development validation metrics improve over current Atlas and plain lexical/file search; useful decisions and tests are returned within the same budget; no freshness/exclusion regression. Keep the release holdout sealed until the implementation and protocol are frozen |
| 4 — Incremental freshness, 1–2 weeks | Add artifact digests, published generations, dependency invalidation, no-op fast path and request-scoped validation reuse | Changed-file work drops as intended; rename/delete/branch switch/concurrent-edit cases are correct; every current pack matches its snapshot; unchanged support does not trigger unnecessary re-review. Watch mode is a later optional follow-up |
| 5 — Agent contract and token control, 3–5 days | Add target-tokenizer accounting and compact agent view with an explicit versioned contract; document and smoke-test two actual MCP client integrations | Actual transport fits its declared tokenizer budget; required warnings/citations survive packing; client setup and first context request work without maintainer help; old-consumer fixture behaves as documented |
| 6 — Measured alpha release, 1–2 weeks including trials | Run the full paired coding evaluation and failure analysis; exercise upgrade/recovery; trial with 3–5 developers; publish exact artifact, release notes and reports | Predeclared evaluation criteria pass, no correctness regression is hidden by aggregate scores, install/upgrade/backup/restore works, users complete first useful tasks, actual downloadable version and reproducible reports exist |

Suggested initial usability budgets for a declared reference machine and 10,000-file TypeScript fixture: warm persistent-MCP context-pack p95 below 2 seconds, one-file incremental update p95 below 2 seconds, 50-file update below 10 seconds, and cold index below 60 seconds. These are proposed objectives to calibrate against a measured baseline under the benchmark protocol. They are not present performance claims or automatic CI thresholds. End-to-end coding success takes precedence over shaving a few milliseconds.

Keep the first product backlog small: release/install path; task-start wrapper; symbols/chunks; shared indexed retrieval; incremental freshness; compact token-accounted context; measured coding usefulness. Defer UI redesign, extra languages, remote providers, multi-repository federation and collaborative editing until users regularly benefit from that loop.

## Hooks the real benchmark needs

The benchmark should consume the public installed CLI/SDK/MCP path, not private internal helpers that bypass validation. Add a local opt-in trace containing versioned snapshot identity, retrieval/extractor versions, candidate IDs/ranks/reasons, selected source ranges, exclusion reasons, phase timings, serialized bytes and measured tokenizer counts. Avoid recording source bodies or credentials by default.

Freeze source commits, base repository snapshots, index policy and task prompts for comparisons. A coding run must log which pack was delivered and whether the agent actually consumed it; a faster unused MCP server proves little. Record index preparation cost separately and also report amortized session cost. Benchmark stale memory explicitly by changing the repository after a pack was created, not only by measuring static fixtures.

Retain the current synthetic harness for latency/scale regression. Retrieval ground truth and isolated before/after coding outcomes are separate evaluation layers. Publish failures and task-level raw results alongside aggregate numbers. The detailed benchmark protocol should define baselines, held-out tasks, leakage control, paired seeds, checks and stopping criteria before optimization begins.
