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
scripts["lint"] = "biome lint . --error-on-warnings"
scripts["format"] = "biome format --write ."
scripts["format:check"] = "biome format . --error-on-warnings"
scripts["quality"] = "npm run lint && npm run format:check"
scripts["check"] = "npm run quality && npm run build && npm run typecheck:tests && npm test"
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
    "prepack",
]
package["scripts"] = {name: scripts[name] for name in ordered_names}
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

biome = {
    "$schema": "https://biomejs.dev/schemas/2.5.10/schema.json",
    "vcs": {
        "enabled": True,
        "clientKind": "git",
        "useIgnoreFile": True,
        "defaultBranch": "main",
    },
    "files": {
        "ignoreUnknown": True,
        "includes": [
            "src/**/*.ts",
            "src/**/*.js",
            "tests/**/*.ts",
            "scripts/**/*.mjs",
            ".github/scripts/**/*.mjs",
            "plugin/context-atlas/scripts/**/*.mjs",
            "package.json",
            "tsconfig.json",
            "tsconfig.tests.json",
            "plugin/context-atlas/manifest.json",
            "biome.json",
            "!!dist",
            "!!coverage",
            "!!node_modules",
            "!!plugin/context-atlas/runtime",
            "!!.context-atlas",
            "!!package-artifacts",
            "!!package-smoke",
            "!!release-artifacts",
            "!!package-lock.json",
        ],
    },
    "formatter": {
        "enabled": True,
        "indentStyle": "space",
        "indentWidth": 2,
        "lineEnding": "lf",
        "lineWidth": 140,
        "attributePosition": "auto",
        "bracketSpacing": True,
    },
    "linter": {
        "enabled": True,
        "rules": {"recommended": True},
    },
    "assist": {"enabled": False},
    "javascript": {
        "formatter": {
            "quoteStyle": "double",
            "jsxQuoteStyle": "double",
            "semicolons": "always",
            "trailingCommas": "all",
            "arrowParentheses": "always",
            "bracketSameLine": False,
            "quoteProperties": "asNeeded",
        }
    },
}
Path("biome.json").write_text(json.dumps(biome, indent=2) + "\n", encoding="utf-8")

replace_once(
    "CONTRIBUTING.md",
    """Install and verify the project:

```sh
npm ci
npm run check
```

`npm run check` compiles the TypeScript project and runs the automated suite.""",
    """Install and verify the project:

```sh
npm ci
npm run check
```

`npm run check` runs non-mutating Biome lint and formatting checks, compiles the TypeScript project, type-checks the test graph, and runs the automated suite. Use `npm run format` to apply the project formatter locally; editor integration is optional and must use the repository-pinned Biome version.""",
)
replace_once(
    "CONTRIBUTING.md",
    """Run the full gate before submitting:

```sh
npm run check
npm audit --audit-level=high
npm pack --dry-run
```""",
    """Run the full gate before submitting:

```sh
npm run lint
npm run format:check
npm run check
npm audit --audit-level=high
npm pack --dry-run
```

`lint` and `format:check` are intentionally non-mutating. Generated plugin runtime, dependency lock metadata, build output, coverage, package smoke directories, and local Context Atlas state are excluded from mechanical formatting; their own generation and boundary checks remain authoritative.""",
)

replace_once(
    ".github/pull_request_template.md",
    """- [ ] `npm run check`
- [ ] `npm audit --audit-level=high`""",
    """- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run check`
- [ ] `npm audit --audit-level=high`""",
)

replace_once(
    "README.md",
    """```sh
npm run build
npm test
```""",
    """```sh
npm run lint
npm run format:check
npm run check
```

`npm run format` applies the repository-pinned formatter. The non-mutating quality gates cover maintained TypeScript, JavaScript, and JSON source while excluding generated artifacts and local state.""",
)

replace_once(
    "CHANGELOG.md",
    """### Changed

- Runtime support is now explicitly Node.js `>=24.12.0 <25`, with an exact-floor CI job, installed-package smoke testing at the floor, and Node 24 type declarations.""",
    """### Changed

- Contributor verification now includes repository-pinned Biome lint and formatting gates for maintained TypeScript, JavaScript, and JSON on Windows, Linux, macOS, and the exact minimum Node.js runtime. Generated artifacts and local state remain outside the mechanical formatting boundary.
- Runtime support is now explicitly Node.js `>=24.12.0 <25`, with an exact-floor CI job, installed-package smoke testing at the floor, and Node 24 type declarations.""",
)
