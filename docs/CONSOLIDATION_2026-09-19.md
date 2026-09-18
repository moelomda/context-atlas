# Branch consolidation — 2026-09-19

The integration branch starts from `main` at `0b4eecba4aea5f2ac70415032254446177e13cbf` and records the ancestry of all ten other remote branch tips observed at the start of the work. GitHub requires linear history on `main`, so the reviewed consolidated tree lands there as one squash commit. Original commits remain reachable through the retained source and integration branch references; existing commits are not rewritten.

## Branch disposition

| Source branch | Observed tip | Resolution |
| --- | --- | --- |
| `feat/cli-version` | `bd43ec4` | Already shipped through a squash merge; its tree equals the corresponding earlier main commit. Record ancestry without reverting later work. |
| `chore/code-quality-gate` | `b8bff06` | Same quality-gate tree already in main. Preserve later benchmark work. |
| `chore/code-quality-gate-clean` | `5f5d95b` | Identical to the original quality-gate branch; reconcile ancestry. |
| `perf/reproducible-benchmarks` | `ed585eb` | Harness already shipped. Keep main's newer observed-count validation and corrected baseline. |
| `perf/reproducible-benchmarks-clean` | `9d47c1c` | Tree identical to starting main; reconcile ancestry. |
| `perf/batch-git-history` | `10e663e` | Materialize staged implementation and tests; correct the parser against actual NUL-framed Git output. Remove the temporary self-modifying qualification workflow and patcher after applying their intended change. |
| `dependabot/github_actions/github-actions-minor-patch-8c617679c3` | `d3ba7b3` | Integrate pinned Actions updates. |
| `dependabot/npm_and_yarn/npm-production-minor-patch-7257b05964` | `fca9aa1` | Integrate Zod lockfile update; regenerate bundled runtime/notices. |
| `dependabot/npm_and_yarn/npm-development-minor-patch-f0e7fc11c5` | `59a236a` | Integrate Biome/tsx updates and align Biome's schema version. |
| `dependabot/npm_and_yarn/types/node-26.4.0` | `015ab84` | Preserve branch history but resolve the package conflict to Node 24 declarations, matching the declared runtime contract. Ignore future Node 25+ typings until runtime support is deliberately expanded. |

Ancestry-only merges are intentional for the verified duplicate trees. Reapplying their older file contents would regress the current source. The Node typings resolution is also intentional: merging a dependency proposal does not justify advertising APIs absent from the supported runtime.

## Corrections made during integration

- The staged history optimization expected newline-terminated commit headers. Real `git diff-tree --stdin -z` emits NUL-terminated headers; the staged implementation failed its real repository test. The parser now uses the actual framing.
- New regression coverage compares batched history with the previous per-commit extractor on real SHA-1 and SHA-256 repositories. It includes roots, merges, empty commits, renames, Unicode paths, bounded history, malformed/truncated records and hash-looking filenames. Newline filenames are exercised on platforms that permit them.
- Git history discovery uses bounded batches, with smaller retries when accumulated output would exceed the process buffer. A small history uses three Git subprocesses (HEAD check, log, one batched diff), instead of two plus one per selected commit. This is a subprocess-count property, not an end-to-end speedup claim; larger windows require multiple batches.
- The dependency branches' historical Windows package failures came from audit findings. Compatible lockfile updates advance `fast-uri` to 3.1.8, `hono` to 4.13.8 and `qs` to 6.16.0. The current local audit reports zero findings; this is time-specific dependency evidence.
- The generated MCP bundle and third-party notices are rebuilt from the consolidated source/dependencies.

## Validation evidence

Before publication, this integration must pass the standard source/test gate, installed-package checks, dependency audit, deterministic benchmark smoke and the protected hosted checks. The pull request and its checks are the authoritative record for the tested integration commit. Local measurements must retain their source commit and dirty-state metadata.

The initial focused Windows run passed all four new Git-history tests on Node 24.14.0 and Git 2.47.1. No real-world retrieval or paid agent-outcome benchmark has been performed by this consolidation. The existing synthetic harness uses an explicit pack override and is not a claim of normal-workflow availability or improved coding success.

The actionable follow-on work is in [PRODUCTIZATION_PLAN.md](PRODUCTIZATION_PLAN.md), and the evaluation design is in [REAL_WORLD_BENCHMARK_PLAN.md](REAL_WORLD_BENCHMARK_PLAN.md). Those proposed features and thresholds are not implemented by merging branches.
