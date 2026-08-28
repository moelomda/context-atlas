from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


readme_alpha = """This repository contains the source for a working experimental `0.1.0` alpha release candidate: a Node.js CLI, local web dashboard, TypeScript library, stdio MCP server, and Codex plugin bundle. The generated plugin runtime, local behavioral gates, package candidate, clean installed-package smoke, hosted cross-platform CI, CodeQL, and dependency review have been verified. A GitHub release has not yet been published; `0.1.0` remains unpublished, and the broader production plan remains explicitly tracked in `ROADMAP.md` and `docs/`.
"""
replace_once(
    "README.md",
    readme_alpha,
    readme_alpha
    + "\nRelease-asset download, checksum, provenance, tarball-install, and rollback instructions are in [`docs/INSTALLING_RELEASE.md`](docs/INSTALLING_RELEASE.md). Until the first tag succeeds, use the source-checkout quick start below.\n",
)
replace_once(
    "README.md",
    "These checks do not substitute for GitHub-hosted CI, CodeQL, dependency review, SBOM, or provenance jobs.",
    "These local checks complement the protected hosted CI, CodeQL, and dependency-review gates. SBOM and provenance remain tag-workflow outputs and do not exist until the release workflow succeeds.",
)

replace_once(
    "CHANGELOG.md",
    """## [Unreleased]

### Changed

- Updated README documentation to use cross-platform `npm` commands instead of Windows-specific `npm.cmd` in generic sections

Reserved for changes after `0.1.0` is tagged or published. Version `0.1.0`
""",
    """## [Unreleased]

Reserved for changes after `0.1.0` is tagged or published. Version `0.1.0`
""",
)
replace_once(
    "CHANGELOG.md",
    """- Contributor, security, conduct, and release-maintenance documentation.
""",
    """- Contributor, security, conduct, and release-maintenance documentation.
- Cross-platform release-asset download, checksum/provenance verification,
  tarball installation, incident, rollback, and withdrawal documentation.
- Packed-product installation smoke coverage on Linux and Windows at the exact
  minimum supported Node.js runtime.
""",
)
replace_once(
    "CHANGELOG.md",
    """- Dashboard external imports now consume the core/API 256 KiB decoded-source contract, while the HTTP transport ceiling is derived separately for base64 and bounded metadata overhead. Boundary tests cover one byte below, the exact limit, one byte above, and transport overflow.
""",
    """- Dashboard external imports now consume the core/API 256 KiB decoded-source contract, while the HTTP transport ceiling is derived separately for base64 and bounded metadata overhead. Boundary tests cover one byte below, the exact limit, one byte above, and transport overflow.
- Generic README setup and development examples now use the cross-platform
  `npm` command instead of the Windows-specific `npm.cmd` shim.
- The tag release workflow runs on exact-minimum Node.js `24.12.0`, and the
  pinned CodeQL and release-attestation actions were refreshed to reviewed
  patch releases without introducing floating action references.
""",
)
replace_once(
    "CHANGELOG.md",
    """- Pinned Actionlint 1.7.12 passed all four workflows. All 17 workflow `uses`
  references are full-SHA pinned across seven unique commits, and those commits
  were resolved and verified. No remote or hosted CI/security/release result
  exists yet.
""",
    """- Pinned Actionlint 1.7.12 passed all maintained workflows. Every workflow
  `uses` reference remains full-SHA pinned. Protected hosted CI, exact-floor
  tests, package smoke, coverage, CodeQL, and dependency review are established
  gates; publication requires those gates on the exact release candidate,
  including Linux and Windows installed-package smoke. No tag workflow, SBOM,
  provenance attestation, or GitHub Release exists until publication.
""",
)

replace_once(
    "docs/IMPLEMENTATION_STATUS.md",
    """Audit date: 2026-08-23
Baseline: current `0.1.0` release-candidate files after local runtime, browser, latest-package, and clean-install verification; no remote-hosted/tagged release commit, hosted run, or publication exists
Classification: working experimental alpha candidate; not a production, public-beta, or release approval
""",
    """Audit date: 2026-08-28
Baseline: current `0.1.0` release-candidate source after local verification plus protected hosted CI, exact-floor runtime, package-smoke, coverage, CodeQL, and dependency-review gates; no tagged release, SBOM/provenance output, or publication exists
Classification: working experimental alpha candidate; not a production or public-beta approval
""",
)
replace_once(
    "docs/IMPLEMENTATION_STATUS.md",
    """`LOCAL PASS` below describes only the exact worktree, command, environment, or manual flow named in the boundary. It is not evidence for another operating system, browser, repository scale, immutable commit, or hosted run. `SOURCE-INSPECTED` means implementation and assertions are present without broader runtime proof. `UNVERIFIED` means the final result is unknown, not that the product gate failed.
""",
    """`LOCAL PASS` below describes only the exact worktree, command, environment, or manual flow named in the boundary. `HOSTED PASS` describes only the immutable commit, runner, and workflow named in the boundary. Neither is evidence for another browser, repository scale, release asset, or operational condition. `SOURCE-INSPECTED` means implementation and assertions are present without broader runtime proof. `UNVERIFIED` means the final result is unknown, not that the product gate failed.
""",
)
replace_once(
    "docs/IMPLEMENTATION_STATUS.md",
    """| Package/archive/fresh install | **LOCAL PASS** | The final 124-file post-documentation candidate passed inventory, forbidden-file, size, SHA-1, and SHA-512 verification. A clean temporary project installed that exact archive and its dependencies and passed installed CLI, selected-source import, dashboard asset delivery/API, protected review API, public extension-subpath import, privacy, override, and representative MCP calls after verifying the full 13-tool read-only inventory. Exact digest and size evidence lives in the generated local report, and every later repack requires requalification. This is local Windows evidence, not a hosted or cross-platform artifact result. |
""",
    """| Package/archive/fresh install | **LOCAL WINDOWS PASS / HOSTED LINUX PASS; HOSTED WINDOWS GATE ADDED** | The verified 124-file candidate passed inventory, forbidden-file, size, SHA-1, and SHA-512 checks. Clean installations exercised the CLI, selected-source import, dashboard/API, protected review API, public extension subpath, privacy, override, and representative MCP reads after verifying the 13-tool read-only inventory. Protected CI installs and smokes the packed archive on exact-minimum Node.js; this release candidate adds the same installed-product gate on Windows. Every repack requires requalification, and no published release asset exists yet. |
""",
)
replace_once(
    "docs/IMPLEMENTATION_STATUS.md",
    """| Release identity and workflow syntax/supply-chain pins | **LOCAL PASS** | Release identity passed for candidate `v0.1.0`. Pinned Actionlint 1.7.12 passed all four workflows; all 17 `uses` references are full-SHA pinned, covering seven unique commits that were resolved and verified. `0.1.0` is still unreleased. |
| Hosted CI, CodeQL, dependency review, SBOM/provenance, release | **UNVERIFIED** | No Git remote is configured, so no exact-commit hosted check, repository security setting, signed artifact, or published prerelease exists. |
""",
    """| Release identity and workflow syntax/supply-chain pins | **LOCAL PASS / HOSTED GATES PRESENT** | Release identity passes for candidate `v0.1.0`. Actionlint remains pinned, every workflow action reference uses a full commit SHA, and release execution is fixed to exact-minimum Node.js `24.12.0`. `0.1.0` is still unreleased. |
| Hosted CI, CodeQL, dependency review, SBOM/provenance, release | **HOSTED PRE-RELEASE GATES PASS / PUBLICATION PENDING** | Protected main history has completed cross-platform CI, exact-floor testing, Linux installed-package smoke, source coverage, and CodeQL; dependency review is enforced on pull requests. The release-candidate workflow adds Windows installed-package smoke and must pass on its exact head. No tag workflow, SBOM, provenance attestation, or GitHub Release exists until publication. |
""",
)
replace_once(
    "docs/IMPLEMENTATION_STATUS.md",
    """7. **Runtime and distribution:** Node 24 still labels the built-in SQLite API experimental. The full local behavior/coverage runs, regenerated runtime/legal drift, 13-tool runtime regression, release identity, workflow lint/pin inspection, dependency audit, narrow rendered-browser checks, latest post-UI archive verification, clean install, and installed CLI/web/MCP/privacy/override smoke passed. Hosted workflows, repository security settings, signing/SBOM/provenance, cross-platform artifact execution, and actual prerelease creation remain unverified or absent.
""",
    """7. **Runtime and distribution:** Node.js 24 exposes the built-in SQLite API as a release-candidate API rather than a fully stable contract. Local behavior/coverage, regenerated runtime/legal drift, the 13-tool runtime regression, release identity, workflow lint/pin inspection, dependency audit, narrow rendered-browser checks, archive verification, clean install, and installed CLI/web/MCP/privacy/override smoke passed. Protected hosted cross-platform source CI, exact-floor testing, Linux packed-product smoke, coverage, CodeQL, and pull-request dependency review are established; the release candidate adds hosted Windows packed-product smoke. Tag execution, SBOM, provenance, actual release assets, and post-download verification remain pending until publication.
""",
)
replace_once(
    "docs/IMPLEMENTATION_STATUS.md",
    """> Context Atlas 0.1 is an experimental local-first alpha release candidate implementing evidence-backed Git ingestion, reviewed temporal assertions, relationship-aware current-use presentation guards, schema-v2 bounded navigation packs with immutable local history/diff/refresh, a recoverable audit outbox, protected human proposal review and external-source import, narrow confirmed export/backup retention with tombstones, six trusted-code extension ports, a provider-neutral egress safety library, and a regenerated 13-tool read-only MCP adapter. Its current Windows worktree passed 122/122 normal and coverage tests, the reported aggregate coverage thresholds, narrow three-viewport in-app browser QA, and the local runtime/workflow/dependency gates listed above.

It is **not release-approved or published**. The latest local package candidate and clean-install smoke pass, but a local candidate commit alone does not provide a remote, tag, or hosted result. Claim only the exact local suite, coverage, runtime, in-app-browser, and packaged-artifact boundaries above; do not claim hosted/cross-platform release approval, WCAG/screen-reader/cross-browser support, crash/scale qualification, production safety, public-beta readiness, completion of the broader plan, or predictable adoption until those residuals have scope-matched evidence on the exact remotely hosted release commit.
""",
    """> Context Atlas 0.1 is an experimental local-first alpha release candidate implementing evidence-backed Git ingestion, reviewed temporal assertions, relationship-aware current-use presentation guards, schema-v2 bounded navigation packs with immutable local history/diff/refresh, a recoverable audit outbox, protected human proposal review and external-source import, narrow confirmed export/backup retention with tombstones, six trusted-code extension ports, a provider-neutral egress safety library, and a regenerated 13-tool read-only MCP adapter. Its local Windows evidence includes the 122-test normal and coverage suites, aggregate coverage thresholds, and narrow three-viewport in-app browser QA. Protected hosted history has also passed cross-platform source CI, exact-floor runtime testing, Linux packed-product smoke, source coverage, CodeQL, and pull-request dependency review; the release candidate adds Windows packed-product smoke and exact-minimum release execution.

It is **not published**. It becomes ready for the maintainer tag only after the exact release-candidate head passes protected CI, both installed-package smoke jobs, coverage, CodeQL, and dependency review and is merged without modification. Even then, do not claim production safety, public-beta readiness, WCAG/screen-reader/cross-browser support, crash/scale qualification, broader-plan completion, SBOM/provenance success, or a GitHub Release until the tag workflow and post-download verification produce that scope-matched evidence.
""",
)

print("Prepared release-candidate documentation consistently.")
