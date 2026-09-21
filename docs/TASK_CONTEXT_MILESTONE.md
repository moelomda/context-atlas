# Task-context navigation milestone

The first product milestone addresses a concrete failure: on the consolidated `fcb5b0f559119c68b60bdba123a732bfcd818bbd` repository, an 8,000-token pack for “Bound Git history extraction without losing rename or merge behavior” omitted both `src/core` and `tests`.

## Implemented behavior

- Rank optional candidates across sections by task relevance. All fifteen sections, safety checks, evidence closure, and the complete exclusion manifest remain mandatory. Section priority breaks relevance ties.
- Match lexical words and split camelCase, underscores, and hyphens. A query for `git` no longer incidentally matches `.github`. This is deterministic lexical retrieval, without semantic embeddings or stemming.
- Persist component file inventories from the existing bounded repository scan. Ignore policies and sensitive-path filtering still apply; filenames containing detected secrets are additionally withheld from the new inventory field.
- Withhold detected secret filenames in new Git events. Redact legacy event titles, summaries, and current/previous paths when presenting timeline, overview, search, explanation, and newly built packs. Immutable stored events and their audit bindings are preserved; this is not retroactive erasure of stored history, backups, or previously saved pack artifacts.
- Render at most four matching file paths per selected component. Component snapshot evidence validates inventory membership/size, not semantic file contents. Paths are labeled “inventory only; inspect current contents.” No source text or inferred function behavior is added.
- Recognize plural test/spec directory names. Keep exact exclusions in structured selection and Markdown; stop repeating excluded IDs in the section field named `includedItemIds`.

This remains a navigation tool. Ranking can miss synonyms, useful files with unrelated names, or facts absent from the index. Parent and child components can repeat pointers. Large mandatory exclusion manifests can still exhaust a small budget. Search retains its previous ranking function; shared indexed retrieval is a separate roadmap item.

## Use after upgrading

Build or install the new package, then synchronize each existing target repository:

```sh
npx context-atlas sync --repo /absolute/path/to/project
npx context-atlas health --repo /absolute/path/to/project
npx context-atlas pack "Your specific coding task" --repo /absolute/path/to/project --budget 8000
```

Initialize a new target once with `context-atlas init` instead of synchronizing an uninitialized store. MCP remains read-only: refresh through the CLI before the agent calls `atlas_context_pack`. SDK consumers continue using `syncRepository` and `buildContextPack`.

The extraction identity advances to `repository-extractor-v2`. Previously accepted guidance follows existing freshness rules and may require a new human-reviewed proposal; sync does not approve it. Never auto-create an override to suppress that finding. Existing configured budgets are preserved.

The JSON shape remains schema 2. Policy identifiers change to `task-ranked-v3` and `markdown-v3`. Consumers must not hard-code the old identifiers. The exclusions section's `includedItemIds` is now empty; use `selection.exclusions` for exact excluded IDs, sections, evidence references, and reasons. Markdown retains every exact ID/reason pair.

## Reproduce the development comparison

Build two independent CLI installations: the consolidation baseline and the candidate. Both must use supported Node 24 and their locked dependencies. A previously installed baseline package also works. From the candidate checkout, run:

```sh
npm run build
npm run benchmark:tasks -- --repo /absolute/path/to/context-atlas --cases scripts/benchmark/task-pack-cases.json --baseline-cli /absolute/path/to/baseline/dist/cli.js --candidate-cli /absolute/path/to/candidate/dist/cli.js --output /absolute/path/to/new-comparison-directory
```

The output parent must exist; the output directory itself must not exist. The source repository must contain the pinned revision in the cases file. The runner creates independent local clones, checks out that exact revision, initializes each store with its respective CLI, and submits identical task text at budget 8,000. It does not alter the source checkout, delete existing directories, approve proposals, create overrides, or call model providers.

The report records the pinned source revision, case-file digest, hashes of both built runtime directories, Node/platform, setup outcomes, task failures, selected records, and navigation metrics. Each CLI stdout/stderr is saved separately. Failed/refused packs receive zero hits. The process exits nonzero if any candidate task lacks a usable in-budget pack or either expected file/component. Runtimes' dependency locks and raw outputs should accompany published results; the runtime digest alone does not identify every installed dependency.

Metrics are deliberately narrow:

- **File-pointer recall:** fraction of the two manually labeled paths appearing as exact JSON-quoted paths in usable pack Markdown. This tests the new pointer renderer; the old renderer did not expose this form. It is not a fair standalone measure of overall retrieval quality.
- **Component recall:** fraction of the expected `src/core`/`tests` component evidence locators in a usable pack. This comparison is available on both renderers and directly checks the original failure.
- **Budget:** compact JSON characters and the existing characters/4 token estimate, not exact model tokens.

The three cases (Git history, pack budgeting, privacy export) are development cases chosen during implementation. They are neither held out nor representative of all coding tasks. Do not report their pass rate as general retrieval accuracy or coding success. No latency improvement is inferred from this runner.

The next evaluation step is the separately labeled multi-repository pilot, sealed holdout, and paired coding evaluation in [REAL_WORLD_BENCHMARK_PLAN.md](REAL_WORLD_BENCHMARK_PLAN.md). Next implementation work is symbol/source-span extraction and shared indexed retrieval, followed by incremental refresh and exact transport token accounting.
