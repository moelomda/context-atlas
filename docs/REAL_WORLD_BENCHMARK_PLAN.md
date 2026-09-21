# Context Atlas: benchmark plan grounded in the current implementation

Reviewed source: `context-atlas-review`, commit `0b4eecba4aea5f2ac70415032254446177e13cbf` on 2026-09-19. This is an implementation plan, not a report of evaluations already run. Recheck any affected measurements against the final consolidated commit. No paid model calls were made for this review.

The product claim to test is: **a developer or agent can complete a real repository change with fewer missed constraints, at acceptable total time and cost, because Atlas supplies relevant and current evidence.** A faster `pack` command alone does not establish that claim.

## What the existing benchmark proves

The [task-context navigation milestone](TASK_CONTEXT_MILESTONE.md) additionally provides `npm run benchmark:tasks`, a paired comparison on three manually selected development tasks at a pinned real-repository revision. It measures expected component selection and explicit file pointers, preserves failures and raw outputs, and does not implement the held-out retrieval or coding-outcome evaluation proposed below.

The repository already has a useful deterministic CLI performance smoke harness in `scripts/benchmark/`. It records the source commit, dirty state, fixture configuration hash, environment versions, elapsed time, output bytes, Node RSS on Linux, Git subprocess counts, and database size. Keep it.

These commands work with the existing harness from the repository root (use the supported Node 24 runtime):

```sh
npm ci
npm run build
npm run benchmark:generate -- --scenario smoke --clean
npm run benchmark -- --scenario smoke --samples 2 --output ./smoke-current.json
npm run benchmark:validate -- --file ./smoke-current.json
```

For an existing larger scenario, substitute `files-10k`, `history-5k`, `relationships-dense`, or `untracked-bounded` in both generation and execution. `--samples 50` currently increases read samples only, up to the current maximum of 50; it does not repeat init/sync. The current report still uses the disclosed override path and estimated budget described below. Do not present a smoke run as a retrieval-quality or agent-success result.

Its current limits are concrete:

- `smoke` has 80 generated source files, 12 commits, and two read samples. Init and incremental sync get one sample each regardless of `--samples`. The nearest-rank `p95` in `common.mjs` is therefore just the maximum of two observations, or the lone observation. This is useful smoke evidence, not a tail-latency estimate.
- `run-benchmark.mjs` always creates a five-minute `human:benchmark` override and supplies it to the pack operation. The report discloses this. That measures the override path; it does not show that an ordinary user obtains an unblocked useful pack. Keep this case as a separately labeled recovery/performance scenario and add normal allow/block paths.
- It asks one broad task, `understand component dependencies`, with a 20,000-token estimated budget. The published fixture selects 142 items and excludes none for budget. That does not stress selective retrieval or realistic small context budgets.
- The runner measures a one-file appended comment for incremental sync. It does not qualify a 50-file edit, rename/delete, branch switch, long history, growing Atlas history, or an unchanged sync.
- Nonzero command exit rejects the runner, so there is no complete report covering all failed/refused operations. The report validator verifies shape and positive output counts; it does not establish task relevance, semantic correctness, summary arithmetic, or freshness.
- `estimateTokens()` is `ceil(value.length / 4)`. This is disclosed estimation, not target-model token counting. Output bytes are also not tokens.
- RSS samples the Node process every 10 ms on Linux and omits Git children; on Windows it is null. It is neither full-process-tree memory nor a cross-platform peak measurement.
- There is no human-labeled retrieval set or downstream coding outcome study. Existing product-plan targets such as 90% fact recall and 50% token reduction remain hypotheses.

## Track 1: reproducible performance and operational reliability

First repair measurement, then optimize.

1. Add a report v2 with **one durable record per attempted operation**, including outcome (`ok`, `expected_block`, `unexpected_block`, `timeout`, `crash`, `invalid_output`), exit code, elapsed time, inputs, selected output digest, and failure details. Write append-only JSONL as each operation finishes; summarize later. Add a hard timeout. Never silently drop slow or failed runs.
2. Record CPU model, logical CPUs, RAM, storage/filesystem, OS version, Atlas commit and build/package hash, dependency lock hash, Node/npm/Git versions, concurrency, scenario/query-set hash, pack budget/tokenizer, initial Atlas-state digest, and cache policy. Record the full command and preserve reproducibility metadata without private absolute paths.
3. Separate CLI startup, persistent MCP round-trip, and library-call measurements. A CLI operation launches a new process; it cannot substitute for IDE/MCP latency. Report cold Atlas state separately from cold OS page cache. Do not call deletion of `.context-atlas` an OS-cold benchmark.
4. On a stable Linux reference runner, perform five warmup reads and at least 100 measured read requests per workload across five independent sessions. Use a fixed varied query set and balanced randomized order. Publish raw samples, p50/p95, success rate, and confidence intervals; suppress tail claims for the two-sample CI smoke. For expensive init/sync, begin with 10 independent fresh-state repetitions and report every value plus median/range; obtain 100 or more if making a p95 SLO claim. The count alone does not eliminate environmental noise.
5. Repeat before/after versions on the same machine with alternating order. Compare only semantically equivalent outputs; a result that is faster because it omits evidence or refuses more often is not a performance win.
6. Use existing `smoke`, `files-10k`, `history-5k`, `relationships-dense`, and `untracked-bounded` fixtures. Add combinations (many files plus long history), unchanged sync, 1/10/50-file changes, add/delete/rename, branch switch, untracked pressure, stale/refusal/explicit-override cases, and 1/128/256 saved packs with realistic and near-limit snapshot sizes. History scans of 256 snapshots deserve their own memory/latency test.
7. Add three consented or public real repositories at pinned revisions: a small TypeScript package, a medium application, and a workspace monorepo. Start with the user's own active code where licenses/privacy allow. The manifest must record exact repository URL, commit, license, language mix, file/commit counts, and build instructions. Do not choose names or revisions for a published score until they are actually checked out and measured. Later add the planned 100k-file/20k-commit fixture; the existing 10k/5k scenarios cannot substantiate that claim.

Initial engineering targets on a published reference machine and a declared 10k-file workload: warm persistent-MCP search p95 below 300 ms, overview below 1 second, useful pack below 2 seconds, and a 50-file sync below 10 seconds. These are proposed product targets, not observed results or universal promises. Calibrate a performance regression gate after stable measurements; a candidate gate is a repeatable >20% slowdown plus a material absolute difference, not a failure on one noisy run.

## Track 2: useful, current context measured against gold answers

Create a small human-reviewed corpus before adding embeddings. Start with **30 development/pilot tasks** across the three repositories, then create a **separate locked holdout of at least 50 tasks** that is never used to tune retrieval. Split by related issue/feature family and repository/time where possible so variants do not leak across splits. Thirty tasks is an engineering pilot, not a statistically powerful public product claim; 50 holdout tasks may still be inconclusive for small effects. Expand to at least 150 tasks across five or more repositories after the protocol stabilizes and the pilot supports a sample-size calculation.

Cover bug localization, feature changes, impact analysis, historical design constraints, stale decisions, contradictory evidence, no-answer cases, and cross-module dependencies. Include queries whose wording differs from identifiers; the existing substring scorer is vulnerable here. Include budget levels such as 2k, 4k, and 8k actual target-tokenizer tokens, including correctly refused envelopes.

For each task, have two reviewers define, before seeing Atlas output:

- the task prompt and available-at timestamp/base commit;
- the required facts and critical constraints, with weights and exact source locators/content hashes;
- graded relevance for candidate files/symbols/documents (for ranked retrieval metrics);
- accepted evidence alternatives, superseded facts, and disallowed future information;
- the expected outcome (`answer`, `block`, or `unknown`) and the reason;
- the rubric for a correct eventual change, where applicable.

Adjudicate disagreements and record agreement. The required facts must come from the task and repository evidence, not from what Atlas happens to retrieve. A model judge may assist triage; human review owns the gold data and ambiguous correctness decisions.

Compare these context strategies at the same actual context budget:

1. No prebuilt Atlas context: the normal agent's filesystem/Git/search tools remain available.
2. A fixed lexical baseline using `rg` or BM25, with a documented selection algorithm that never sees the gold answer.
3. A fixed naive directory/document dump selected from task text, not oracle knowledge. This is the denominator for the current 50% token-reduction hypothesis, not the sole competitive baseline.
4. The current Atlas selector, frozen by commit.
5. Proposed Atlas improvements, one at a time: symbol extraction, BM25, graph expansion, then optional embeddings/reranker. Changes must beat the lexical baseline before increasing complexity.

Report separately:

- **Weighted fact recall:** covered gold-fact weight divided by required gold-fact weight, per task and macro-averaged. Also report critical-constraint recall.
- **Evidence validity:** cited locators that resolve to the expected content at the permitted revision; citation presence alone is insufficient.
- **Unsupported/stale fact rate:** asserted facts unsupported by permitted evidence, and superseded facts presented as current. Score sampled output assertions with an explicit rubric and denominator.
- **Rank quality:** Recall@k and nDCG@k for the ranked file/symbol list, if that list is exposed; pack fact recall is a distinct metric.
- **Coverage and availability:** valid packs / all answerable attempts; correct blocks / unsafe attempts; false blocks / answerable attempts; latency to useful pack; manual review count and minutes. A product that avoids errors by blocking every request is unusable.
- **Budget compliance and efficiency:** actual tokens, estimator error, duplicate context, and tokens per covered critical fact. Measure complete serialized material actually sent, including MCP envelopes or Markdown duplication if the integration sends them. Do not add JSON and Markdown when only one is sent.

Refused answerable tasks receive zero delivered fact recall in the all-attempts score and remain in the denominator. Also provide conditional quality on successful packs, clearly labeled. Expected safety blocks count as correct safety outcomes, not as useful answers. Never create automatic benchmark overrides to improve these scores.

Initial hypotheses: at least 90% weighted fact recall and 95% critical-fact recall on answerable cases; zero observed invalid critical citations or stale-critical-fact uses in the test corpus; no actual token-budget overruns; useful unblocked packs for at least 95% of ordinary answerable tasks; 50% fewer context tokens than the specified naive dump. Publish confidence intervals and counts. Zero observed failures in a small corpus is not proof of zero risk. Missing these targets is diagnostic feedback, not a reason to remove hard tasks.

## Track 3: paired real coding outcomes

Only this track tests whether Atlas improves coding. Use the same agent scaffold, model snapshot, system prompt, tools, time limit, tool-call limit, maximum spend, and code state for each treatment. Let every arm inspect normal source and Git; Atlas adds context rather than replacing essential coding tools. Record precisely which extra Atlas tool or preflight prompt is enabled.

Use the 30 development/pilot tasks × 3 treatments × 3 attempts = **270 independently executed agent runs**. Treatments are the normal agent, lexical retrieval, and Atlas. Validate the harness offline first, then optionally do one attempt per treatment before expanding to three. This is a debugging pilot and may be expensive: implement a dry run and cost estimate first, and enforce an explicit total spend cap. Do not start provider calls merely because the harness exists. Estimate final-study size from pilot variance and discordant paired outcomes; 30 tasks cannot support a universal claim of a five-percentage-point improvement. Run the locked 50+ task holdout only after freezing the protocol and implementation; expand its size if the planned statistical sensitivity requires it.

Each task gets a fresh isolated checkout/container. Randomize treatment order, disable sharing of conversation/cache outputs across arms, and store seeds where supported. Multiple attempts estimate reliability, not a best-of-three score. Report mean success across all attempts; do not select the best patch. Cluster uncertainty by task and report repository-level variation because repetitions of the same task are not independent new tasks.

Define success before running: issue-specific withheld tests pass; existing regression tests pass; build/type checks pass where relevant; independently reviewed required constraints are met. Run the task's failing checks on the base version and its known correct patch during corpus validation. Test crashes and malformed patches are failures. Reviewers who judge final patches should be blind to treatment. Tests need not be perfect; report missing coverage instead of calling test passage complete correctness.

Use two workload families:

- **Single-session changes** show whether better context improves localization and implementation.
- **Continuity/temporal episodes** simulate the distinctive Atlas promise: session A establishes a reviewed design decision; a real code/branch change occurs; session B starts without hidden chat state and must honor current constraints. Give baseline agents the same underlying prior notes/documents and Git history that Atlas received. Compare against a realistic saved handoff/summary baseline as well as lexical search. Measure re-discovery time, obsolete assumptions, missed constraints, and maintenance/review time.

No future leakage: construct a standalone repository containing only the base commit's allowed ancestry. A Git worktree at an old commit is insufficient because `.git` refs/objects may expose future solutions. Remove future remotes/branches/objects from the agent-visible artifact; validate reachability and source hashes. Keep gold patches, held-out tests, future issue comments, and scoring files outside the agent container. Prevent the evaluator from indexing a current checkout or future Atlas database. Freeze Atlas memory from evidence available at the task cutoff. Model pretraining contamination cannot be fully eliminated for public historical tasks; add private/consented or newly authored tasks and disclose this limitation.

Primary metric: **successful changes / all assigned attempts**, including Atlas refusal, timeout, crash, tool failure, and budget exhaustion. Also report treatment attribution so evaluator-infrastructure outages are visible. If a protocol-defined infrastructure fault invalidates a pair, preserve it in the raw ledger and rerun all arms of that pair under the same policy; publish both assigned-attempt and evaluable-set denominators.

Secondary metrics: missed constraints, regression rate, wall time, tool calls, full agent input/output/cache tokens, context retrieval tokens, human review minutes, and total USD. Include Atlas initialization/synchronization and model/provider work; show first-use cost and a clearly assumed amortized repeated-use cost separately. **Cost per solved task = total cost of all attempts / successful attempts.** Do not compare only the fast/successful runs.

For intervals use a paired task-cluster bootstrap of the treatment difference; pre-register the resampling procedure and report all per-task outcomes. For independent one-attempt-per-task success proportions, Wilson intervals are appropriate; do not apply a binomial interval to correlated repeats as if each were a new independent task. A release decision hypothesis is either a positive success-rate difference with a meaningful effect, or established noninferiority within a prespecified five-percentage-point margin plus at least 20% lower cost or time. The lower confidence bound must satisfy the selected quality criterion; lack of statistical significance does not establish equivalence. Choose one primary criterion before the holdout run and report inconclusive results honestly.

The reproducible patch-application/test approach is supported by the official [SWE-bench evaluation harness](https://www.swebench.com/SWE-bench/reference/harness/) and [evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/). Adopt that structure for Atlas-specific tasks; a SWE-bench score alone would not establish long-session memory quality. The [NIST technical note on confidence intervals](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2119.pdf) explains why interval choice and small sample sizes matter for estimated proportions.

## Concrete implementation sequence

All commands below marked proposed require implementation; they are not current CLI features.

**PR 1 — Benchmark truthfulness (no model calls).** Update `scripts/benchmark/run-benchmark.mjs`, `common.mjs`, `validate-report.mjs`, and `docs/BENCHMARKING.md`. Add per-attempt outcomes/timeouts, no-override/expected-block/override lanes, warmups, cache labels, independent init/sync samples, complete raw records, recomputed aggregate validation, and minimum-count warnings. Keep the current smoke schema readable or version it explicitly. Test timeout/refusal recording and summary recomputation because those failures would invalidate evidence.

**PR 2 — Golden retrieval corpus and tokenizer.** Add `benchmarks/corpus/v1/manifest.json`, `tasks.jsonl`, `annotations.jsonl`, `splits.json`, `scripts/eval/validate-corpus.mjs`, `run-retrieval.mjs`, `score-retrieval.mjs`, and a version-pinned tokenizer adapter. Add exact source/evidence/hash checks, task cutoff checks, baseline selection, and deterministic outputs. Keep holdout gold/evaluation artifacts inaccessible to the subject. Use actual target tokenizer IDs and versions; if unknown, report an estimate and do not label it an exact token count.

**PR 3 — Isolated agent evaluation.** Add `scripts/eval/run-agent.mjs`, `grade-patch.mjs`, `summarize.mjs`, a provider/scaffold adapter, replayable Docker environment definitions, and run manifests. An offline/mock mode must validate scheduling and cost-cap behavior without API charges. Require `--dry-run` to list matrix/cost bounds, and an explicit run budget for paid execution.

**PR 4 — Publish evidence.** Add `docs/benchmarks/<atlas-commit>/report.md`, aggregated JSON, anonymized per-task JSONL, corpus version and hashes, relevant patches, test logs, trace hashes, price snapshot, environment manifest, and limitations. Keep secrets/private source out of public artifacts. CI runs deterministic smoke and a small retrieval regression set; a stable scheduled runner handles scale; paid holdout agent evaluations run only for selected release candidates.

Proposed commands after those PRs:

```sh
npm run eval:validate -- --corpus benchmarks/corpus/v1
npm run eval:retrieval -- --split pilot --baselines lexical,atlas --budgets 2000,4000,8000
npm run eval:agent -- --split pilot --arms normal,lexical,atlas --repeats 3 --dry-run
npm run eval:agent -- --split pilot --arms normal,lexical,atlas --repeats 3 --max-cost-usd 50
npm run eval:report -- --run <run-id>
```

The dollar cap is an illustrative operator-chosen ceiling, not a prediction that 270 runs cost $50. The runner must stop scheduling new attempts at the cap and record unfinished/blocked attempts instead of implying completion. No paid API benchmark was run for this review.

Minimal task record fields: `taskId`, `repositoryId`, `baseCommit`, `allowedHistoryDigest`, `availableAt`, `prompt`, `split`, `category`, `expectedContextOutcome`, `goldFacts[]` with criticality/evidence, `goldRelevance[]`, `environmentImageDigest`, `testSpecDigest`, `rubricVersion`, and `reviewerAgreement`.

Minimal run record fields: `runId`, `taskId`, `attempt`, `arm`, `atlasCommit`, `atlasPackageHash`, `corpusHash`, `modelSnapshot`, `scaffoldVersion`, `promptHash`, `toolConfigurationHash`, `tokenizerVersion`, `environmentDigest`, `baseCommit`, `initialMemoryDigest`, `seed`, `outcome`, `failureCategory`, `actualUsage`, `estimatedUsage`, `costBreakdown`, `timings`, `reviewMinutes`, `packDigest`, `traceDigest`, `patchDigest`, and `graderResult`.

The first deliverable should be a table with columns **normal agent / lexical context / Atlas**, rows **success rate, missed constraints, total time, total tokens, cost per solved task, and false-block rate**, plus raw counts and uncertainty. If Atlas fails to beat lexical search, improve retrieval and onboarding before adding providers, collaboration, or more governance layers.
