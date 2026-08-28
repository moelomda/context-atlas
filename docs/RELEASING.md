# Release Guide

This guide defines the reproducible GitHub release process for Context Atlas.
It does not configure npm-registry publication: the project has no declared
registry owner or trusted-publishing target yet, and release automation must not
invent either one.

User-facing download, checksum, provenance, installation, and withdrawal
instructions live in [`INSTALLING_RELEASE.md`](INSTALLING_RELEASE.md).

## Release channels

- `0.x` releases are GitHub prereleases and retain the alpha warning.
- Patch releases contain compatible fixes for the current alpha contract.
- Minor `0.x` releases may be breaking, but the changelog and release notes must
  identify every migration or compatibility impact.
- A stable `1.0.0` release requires completing and verifying the production
  gates in `IMPLEMENTATION_STATUS.md` and `IMPLEMENTATION_ROADMAP.md`; a green
  small-fixture CI run is not sufficient.

## One-time repository settings

Before the first public release, a repository administrator should:

1. use `main` as the protected default branch;
2. enable private vulnerability reporting;
3. enable Dependabot alerts and security updates;
4. require pull requests and dismiss stale approvals after new commits;
5. require conversation resolution;
6. prevent force pushes and branch deletion on `main`;
7. require the cross-platform CI, dependency-review, and CodeQL checks; and
8. restrict tag creation and GitHub Release permissions to maintainers.

Do not require a check until it has completed once on the default branch; GitHub
cannot select a check name it has never observed.

## Preflight checklist

From a clean checkout on the release commit:

```sh
npm ci
npm run check
npm run test:coverage
npm audit --audit-level=high
npm pack --ignore-scripts --dry-run
node .github/scripts/verify-release.mjs v0.1.0
```

Replace `v0.1.0` with the intended tag for later versions. Then verify all of
the following:

- `package.json`, `package-lock.json`, the Codex plugin manifest, MCP advertised
  version, tag, and dated changelog section all identify the same version;
- the implementation-status claims match current evidence;
- no generated `dist/`, database, backup, export, coverage, log, or credential
  file is staged;
- fresh installs from the packed tarball pass the CLI, loopback dashboard/API,
  MCP plugin wrapper, override-warning, and privacy smoke on Linux and Windows;
- Windows, Linux, and macOS source CI jobs pass on Node 24;
- the exact minimum Node.js `24.12.0` job passes;
- the current source-coverage thresholds pass;
- dependency review and CodeQL pass or have a documented, reviewed exception;
- installation and first-run commands work from the packed tarball in fresh
  temporary directories; and
- release notes state the alpha status, `node:sqlite` maturity, material known
  limitations, GitHub-assets-only distribution, and any migration steps.

For security-relevant releases, coordinate disclosure through a private GitHub
security advisory before creating the public tag.

## Preparing the release commit

1. Move completed entries from `Unreleased` into a dated
   `## [x.y.z] - YYYY-MM-DD` changelog section.
2. Update all version-bearing manifests. `npm version <version>
   --no-git-tag-version` updates the package and lockfile; the plugin manifest
   and MCP server version must be updated in the same pull request.
3. Review `.github/RELEASE_NOTES_PREAMBLE.md` and
   `INSTALLING_RELEASE.md` against the intended asset names.
4. Run the full preflight checklist and review the complete diff.
5. Merge the release commit through the protected branch only after CI, package
   smoke, coverage, CodeQL, and dependency review are green.

The first candidate already uses version `0.1.0`; therefore its publication tag
is `v0.1.0`. Do not create a differently named alpha tag unless every
version-bearing manifest and the dated changelog heading are changed first.

## Creating the tag

Create an annotated tag on the exact verified `main` commit and push only that
tag:

```sh
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Context Atlas v0.1.0 alpha"
git push origin v0.1.0
```

Do not tag an unmerged branch, a local-only commit, or a commit whose hosted
checks are incomplete. Never move a published release tag.

The tag triggers `.github/workflows/release.yml`. The workflow independently:

- checks that the tag, package manifest, lockfile, plugin manifest, MCP version,
  and changelog version agree;
- verifies that the mandatory release-note caveat sections are present;
- runs the complete build, test, and source-coverage gates on the exact minimum
  Node.js release;
- audits dependencies at `high` severity;
- builds an npm-compatible `.tgz` archive;
- verifies required runtime and plugin files are present, development/local
  state is absent, and the archive's recomputed SHA-1/SHA-512 values match the
  `npm pack` report;
- installs that archive into a fresh project and smoke-tests the CLI, loopback
  dashboard/API, MCP plugin wrapper, critical-override warning, and privacy
  boundary;
- generates an SPDX JSON SBOM for the archive;
- creates GitHub provenance attestations for the archive and SBOM;
- writes a SHA-256 checksum covering both release assets;
- prepends the reviewed caveat preamble to GitHub's generated release notes;
  and
- creates a GitHub prerelease for every `0.x` version.

The workflow intentionally does not run `npm publish`.

## Post-release verification

Follow [`INSTALLING_RELEASE.md`](INSTALLING_RELEASE.md) exactly on Linux and at
least one additional operating system. In addition:

1. confirm the release is marked as a prerelease;
2. confirm the three expected assets are present and non-empty;
3. verify both checksum entries;
4. verify both release-asset attestations;
5. install the `.tgz` in a new directory and run `npx context-atlas --help`;
6. complete the disposable quick-start workflow;
7. inspect the release notes for the alpha warning and known limitations; and
8. confirm no package was published to the npm registry.

Record the operating systems, Node.js/npm/Git versions, package SHA-256, and
release workflow URL in issue #7. Never include repository contents or local
Context Atlas data in that record.

## Failed release workflow

A failed tag workflow must not be repaired by uploading hand-built replacement
assets under the same release identity.

- If no GitHub Release was created, diagnose the failed job, prepare a new
  release commit when source changes are needed, and use a new version if the
  original tag was already public.
- If a partial release exists, mark it unusable before further promotion and
  document which step failed.
- If provenance, checksum, SBOM, package verification, smoke testing, audit, or
  release identity fails, treat the release as blocked rather than optional.

## Rollback and withdrawal

Follow the policy in [`INSTALLING_RELEASE.md`](INSTALLING_RELEASE.md#rollback-and-withdrawal-policy).
In particular:

- never replace an archive silently;
- never move or recreate a public tag to reference different source;
- prefer a corrective patch release when the source tag is valid;
- stop distribution and coordinate a security advisory for sensitive defects;
  and
- leave an attributable public explanation once disclosure is safe.
