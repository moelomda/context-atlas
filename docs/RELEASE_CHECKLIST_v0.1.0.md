# Context Atlas v0.1.0 Publication Checklist

This is the maintainer checklist for the first Context Atlas GitHub prerelease.
It is procedural guidance, not proof that a release exists. GitHub checks,
release assets, attestations, downloaded-byte verification, and the public
release record are the authoritative evidence.

## Candidate identity

- Version: `0.1.0`
- Intended annotated tag: `v0.1.0`
- Channel: experimental alpha prerelease
- Distribution: GitHub Release assets only; no npm-registry publication
- Supported Node.js range: `>=24.12.0 <25`

Do not use `v0.1.0-alpha.1` without first changing every version-bearing
manifest and the dated changelog section. The release identity validator requires
the tag, package manifest, lockfile, plugin manifest, MCP advertisement, and
changelog version to agree.

## Pull-request merge gate

The release-preparation pull request may merge only after its exact head passes:

- `Workflow lint / actionlint 1.7.12`;
- `Test / ubuntu-latest / Node 24`;
- `Test / windows-latest / Node 24`;
- `Test / macos-latest / Node 24`;
- `Test / ubuntu-latest / Node 24.12.0`;
- `Package / install smoke test / Windows`;
- `Package / install smoke test` on Linux;
- `Source coverage gate`;
- `Analyze JavaScript and TypeScript`; and
- `Review dependency changes`.

The protected Linux `Package / install smoke test` depends on the complete test
matrix and the Windows package-smoke job. It therefore cannot pass unless the
exact runtime floor and both clean installed-product paths succeed.

A canceled, skipped, action-required, stale-head, or older-commit run is not a
substitute for a successful check on the current pull-request head.

## Merge-commit gate

After the pull request merges, wait for the protected `main` push checks on the
exact merge commit. Do not tag while any required check is queued, in progress,
missing, skipped, canceled, or unsuccessful.

Confirm that `main` contains no temporary workflow, diagnostic file, generated
`dist/`, package archive, database, backup, export, coverage output, log, or
credential material.

## Create the tag

From a clean checkout after all merge-commit checks succeed:

```sh
git switch main
git pull --ff-only
git status --short
git tag -a v0.1.0 -m "Context Atlas v0.1.0 alpha"
git push origin v0.1.0
```

`git status --short` must print nothing. The tag must point to the exact verified
`main` commit. Never move, delete, or recreate a public release tag to reference
different source.

## Tag-workflow gate

The tag workflow must independently complete all of these stages:

1. release-identity and mandatory-caveat validation;
2. clean dependency installation on Node.js `24.12.0`;
3. complete behavior and source-coverage gates;
4. high-severity dependency audit;
5. plugin-runtime and legal-notice drift verification;
6. package creation and archive-boundary verification;
7. fresh installed-product smoke testing;
8. SPDX JSON SBOM generation;
9. GitHub provenance attestation for the package and SBOM;
10. SHA-256 checksum generation; and
11. GitHub prerelease creation.

Expected user-facing assets:

- `context-atlas-0.1.0.tgz`;
- `context-atlas-v0.1.0.sha256`; and
- `context-atlas-v0.1.0.spdx.json`.

A partially created release, missing asset, failed attestation, failed checksum,
failed package smoke, or failed identity check blocks publication.

## Post-publication verification

Follow [`INSTALLING_RELEASE.md`](INSTALLING_RELEASE.md) from a clean environment:

- download all three assets;
- verify both SHA-256 entries;
- verify GitHub provenance for the package and SBOM;
- install the `.tgz` with lifecycle scripts disabled;
- run `npx context-atlas --help` outside an initialized repository;
- complete the disposable quick start;
- confirm the release is marked prerelease;
- confirm the alpha, runtime, limitation, and migration caveats are visible; and
- confirm no npm-registry package was published.

Record the release tag, source commit, workflow run, package SHA-256, operating
system, and exact Node.js/npm/Git versions in issue #7. Never publish repository
contents, `.context-atlas/atlas.db`, credentials, private paths, raw chat
archives, or customer data as verification evidence.

## Stop conditions

Stop promotion and do not recommend the release when any of the following is
true:

- a required check is not green on the exact source commit;
- version-bearing files disagree;
- the package or SBOM lacks valid provenance;
- a checksum does not match;
- installed-product smoke fails on a supported platform;
- release notes omit a material limitation or migration warning;
- a security, privacy, integrity, or data-loss defect is known; or
- the public asset bytes differ from the verified candidate.

Use a corrective patch version rather than silently replacing an immutable
artifact. Follow the rollback and withdrawal policy in
[`INSTALLING_RELEASE.md`](INSTALLING_RELEASE.md#rollback-and-withdrawal-policy).
