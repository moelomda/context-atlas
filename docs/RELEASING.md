# Release Guide

This guide defines the reproducible GitHub release process for Context Atlas.
It does not configure npm-registry publication: the project has no declared
registry owner or trusted-publishing target yet, and release automation must not
invent either one.

## Release channels

- `0.x` releases are prereleases and retain the alpha warning.
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
npm audit --audit-level=high
npm pack --dry-run
```

Then verify all of the following:

- the version in `package.json` and `package-lock.json` is identical;
- `CHANGELOG.md` has a dated section for that exact version;
- the implementation-status claims match current evidence;
- no generated `dist/`, database, backup, export, coverage, log, or credential
  file is staged;
- the plugin's copied-runtime integration test passes;
- Windows, Linux, and macOS CI jobs pass on Node 24;
- dependency review and CodeQL pass or have a documented, reviewed exception;
- installation and first-run commands work from the packed tarball in a fresh
  temporary directory; and
- release notes state the alpha status, experimental SQLite dependency, material
  known limitations, and any migration steps.

For security-relevant releases, coordinate disclosure through a private GitHub
security advisory before creating the public tag.

## Creating a release

1. Move the completed entries from `Unreleased` into a dated
   `## [x.y.z] - YYYY-MM-DD` changelog section.
2. Update both package manifests with `npm version <version> --no-git-tag-version`.
3. Run the full preflight checklist and review the resulting diff.
4. Merge the release commit through the protected branch.
5. Create an annotated `v<version>` tag on that exact commit and push the tag.

The tag triggers `.github/workflows/release.yml`. The workflow independently:

- checks that the tag, package manifest, lockfile, and changelog version agree;
- runs the complete build and test gate on Node 24;
- audits dependencies at `high` severity;
- builds an npm-compatible `.tgz` archive;
- verifies required runtime and plugin files are present and development/local
  state is absent;
- writes a SHA-256 checksum; and
- creates a GitHub prerelease for every `0.x` version.

The workflow intentionally does not run `npm publish`.

## Post-release verification

Download the release tarball and checksum from GitHub, then verify the digest:

```sh
sha256sum --check context-atlas-*.tgz.sha256
```

Install the tarball in a new temporary directory, run
`context-atlas --help`, initialize a disposable Git fixture, start the dashboard
on loopback, and run an MCP discovery/read smoke test. Confirm that the release
is marked prerelease for `0.x`, that notes mention known limitations, and that
no registry package was published unintentionally.

If a release artifact is wrong but the source tag is correct, do not replace it
silently. Document the problem and publish a new patch version. If the tag points
to the wrong commit or contains a security issue, stop distribution, publish an
advisory as appropriate, and follow GitHub's documented revocation procedure.
