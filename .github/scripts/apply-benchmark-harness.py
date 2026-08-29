import json
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package["scripts"]
scripts["benchmark:generate"] = "node scripts/benchmark/generate-fixture.mjs"
scripts["benchmark"] = "node scripts/benchmark/run-benchmark.mjs"
scripts["benchmark:validate"] = "node scripts/benchmark/validate-report.mjs"
ordered_names = [
    "build",
    "dev",
    "start",
    "mcp",
    "typecheck:tests",
    "lint",
    "format",
    "format:check",
    "quality",
    "test",
    "test:coverage",
    "check",
    "benchmark:generate",
    "benchmark",
    "benchmark:validate",
    "prepack",
]
package["scripts"] = {name: scripts[name] for name in ordered_names}
package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

replace_once(
    "README.md",
    '''The current local worktree has passed the normal behavioral suite''',
    '''Reproducible synthetic performance measurement is documented in [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md). The lightweight smoke scenario runs through the public CLI in CI and emits a validated, versioned JSON artifact; larger named scenarios remain explicit local or release-qualification workloads.

The current local worktree has passed the normal behavioral suite''',
)

replace_once(
    "CHANGELOG.md",
    '''- Repository-independent `version`, `--version`, and `-v` CLI diagnostics backed by package metadata, including a versioned JSON form used by tests and installed-product verification.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.''',
    '''- Repository-independent `version`, `--version`, and `-v` CLI diagnostics backed by package metadata, including a versioned JSON form used by tests and installed-product verification.
- A deterministic synthetic benchmark harness with named file-count, history, relationship-density, and untracked-content scenarios; public-command timings, p50/p95, RSS where available, database bytes, Git Trace2 process counts, output counts, schema validation, CI smoke artifacts, and an explicitly limited reference baseline.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.''',
)

replace_once(
    "CONTRIBUTING.md",
    '''Small focused pull requests are preferred. A good pull request usually:
''',
    '''Performance changes should follow [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md): use the same scenario hash for before/after reports, explain output-count changes, and avoid treating one hosted runner as a production-scale claim.

Small focused pull requests are preferred. A good pull request usually:
''',
)
