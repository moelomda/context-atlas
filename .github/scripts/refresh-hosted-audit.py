from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "README.md",
    "all 17 workflow `uses` references are full-SHA pinned, covering seven unique commits",
    "all 20 maintained workflow `uses` references are full-SHA pinned, covering seven unique commits",
)

replace_once(
    "docs/FULL_SCOPE_AUDIT.md",
    "Audit date: 2026-08-23",
    "Audit date: 2026-08-28",
)
replace_once(
    "docs/FULL_SCOPE_AUDIT.md",
    """Context Atlas is a functioning local-first alpha release candidate, not the completed product described by the plan and not yet supported by evidence sufficient for a public-beta claim. The useful vertical slice is real: a Git repository can be initialized and scanned; relationship-aware map/timeline/overview views can be queried; proposals can be approved or rejected through the CLI or protected loopback dashboard; bounded packs can be generated, saved, compared, and refreshed; narrow export/backup retention can be explicitly applied; and 13 read-only MCP tools expose navigation plus saved-pack inspection. The generated plugin runtime has been requalified against this source, and a post-UI package candidate passed local archive verification plus clean installed CLI/web/review/privacy/override/MCP smoke. This remains local Windows evidence rather than an immutable hosted release result.
""",
    """Context Atlas is a functioning local-first alpha release candidate, not the completed product described by the plan and not yet supported by evidence sufficient for a public-beta claim. The useful vertical slice is real: a Git repository can be initialized and scanned; relationship-aware map/timeline/overview views can be queried; proposals can be approved or rejected through the CLI or protected loopback dashboard; bounded packs can be generated, saved, compared, and refreshed; narrow export/backup retention can be explicitly applied; and 13 read-only MCP tools expose navigation plus saved-pack inspection. The generated plugin runtime has been requalified against this source, and a post-UI package candidate passed local archive verification plus clean installed CLI/web/review/privacy/override/MCP smoke. Protected main history has also passed hosted cross-platform source CI, exact-floor runtime testing, Linux packed-product smoke, source coverage, CodeQL, and pull-request dependency review. The release candidate adds hosted Windows packed-product smoke; no tagged package, SBOM/provenance result, or GitHub Release exists yet.
""",
)
replace_once(
    "docs/FULL_SCOPE_AUDIT.md",
    """| Local release/security controls | Release identity and online `npm audit` passed; the audit reported zero vulnerabilities. Pinned Actionlint 1.7.12 passed four workflows, and all 17 `uses` references across seven unique commits were full-SHA pinned and resolved. | This verifies the local inputs and static workflow boundary only. It is not an independent security review or a hosted CodeQL/dependency-review/SBOM/provenance result. |
""",
    """| Release/security controls | Release identity and online `npm audit` passed; the audit reported zero vulnerabilities. Pinned Actionlint 1.7.12 passed the maintained workflows, and all 20 `uses` references across seven unique action commits are full-SHA pinned. Protected hosted CodeQL and pull-request dependency review pass on current main history. | This verifies the named local and hosted gates only. It is not an independent security review, tag-workflow result, SBOM, provenance attestation, or proof against undisclosed vulnerabilities. |
""",
)
replace_once(
    "docs/FULL_SCOPE_AUDIT.md",
    """| Packaging/release artifact | The final 124-file post-documentation candidate passed inventory, forbidden-file, size, SHA-1 and SHA-512 verification; a clean temporary install of that exact archive passed CLI, selected-source import, dashboard asset delivery/API, protected review API, extension-subpath import, privacy, override and representative MCP calls after verifying the complete 13-tool read-only inventory | This is a passing local Windows artifact boundary. Any later repack requires requalification. A local candidate does not substitute for a remote-hosted/tagged release commit; `0.1.0` remains unpublished with no hosted workflow, signed/SBOM-attested GitHub artifact, cross-platform install result or public release. |
| Git/hosting state | The candidate exists only in the local repository and no Git remote is configured | There is no GitHub URL, hosted security configuration, hosted check result, or published prerelease. A local commit does not substitute for those external gates. |
""",
    """| Packaging/release artifact | The verified 124-file candidate passed inventory, forbidden-file, size, SHA-1 and SHA-512 checks; clean installations exercised CLI, selected-source import, dashboard/API, protected review API, extension-subpath import, privacy, override and representative MCP reads after verifying the 13-tool read-only inventory. Protected CI repeats package verification and installed-product smoke on exact-minimum Node.js; the release candidate adds a Windows hosted package smoke beside the Linux gate. | Every repack requires requalification. No downloaded release asset, SBOM, provenance attestation, tag-workflow result, or public prerelease exists yet. |
| Git/hosting state | The project is a public GitHub repository with protected `main`, required hosted CI/security checks, issues, pull requests, and release automation. | This establishes repository and pre-release governance on named commits. It does not prove the tag workflow, release assets, post-download verification, production operation, or adoption outcomes. |
""",
)
replace_once(
    "docs/FULL_SCOPE_AUDIT.md",
    """The 122 passing tests still concentrate on small TypeScript fixtures. Narrow ledger fault and rendered in-app browser checks exist, but there is no durable `verification/<commit>/<run-id>/manifest.json`, coverage-to-requirement report, cross-platform execution result, scale corpus, full ingestion fault matrix, screen-reader/WCAG report, usability report, pack evaluation corpus, or signed hosted release provenance artifact.
""",
    """The 122-test suite still concentrates on small TypeScript fixtures. Protected hosted source execution now covers Windows, Linux, macOS, and the exact minimum Node.js runtime, and Linux package installation is exercised from the packed archive; the release candidate adds the corresponding Windows package installation gate. There is still no durable `verification/<commit>/<run-id>/manifest.json`, coverage-to-requirement report, scale corpus, full ingestion fault matrix, screen-reader/WCAG report, usability report, pack evaluation corpus, downloaded-release verification, or signed release provenance artifact.
""",
)
replace_once(
    "docs/FULL_SCOPE_AUDIT.md",
    """Release controls came from `package.json`, `scripts/`, `.github/`, the public governance files, and `docs/RELEASING.md`; they are not a current hosted result.
""",
    """Release controls came from `package.json`, `scripts/`, `.github/`, the public governance files, and `docs/RELEASING.md`. Protected pre-release checks now provide hosted evidence on named commits, but the tag workflow, release assets, SBOM/provenance, and post-download verification remain absent until publication.
""",
)

full_audit = Path("docs/FULL_SCOPE_AUDIT.md").read_text(encoding="utf-8")
for stale in (
    "no Git remote is configured",
    "There is no GitHub URL, hosted security configuration, hosted check result",
    "all 17 `uses` references",
):
    if stale in full_audit:
        raise SystemExit(f"Stale hosted-state claim remains in FULL_SCOPE_AUDIT.md: {stale}")

print("Refreshed hosted audit evidence and workflow reference count.")
