# Runtime Support

Context Atlas currently supports:

```text
Node.js >=24.12.0 <25
npm 11.9.0 for the maintained contributor and release toolchain
```

The package manager requirement is pinned through `packageManager` for reproducible contributor and release workflows. Consumers of a packaged build may use a compatible npm version, but project automation is qualified with npm 11.9.0.

## Why the minimum is Node.js 24.12.0

Context Atlas opens SQLite databases with Node's built-in `node:sqlite` `DatabaseSync` constructor and explicitly enables its `defensive` option. Node.js added that constructor option in version 24.12.0. Advertising support for earlier Node 24 releases would therefore promise a runtime contract the project does not use or test.

See the official Node.js SQLite history for [`new DatabaseSync(path[, options])`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#new-databasesyncpath-options).

## Why later Node majors are not claimed yet

A version newer than Node 24 is not automatically considered supported. New major releases may change the built-in SQLite API, ESM behavior, test runner, permissions, warnings, or package compatibility.

Support for another Node major requires all of the following in one focused pull request:

1. a documented compatibility review of directly used Node APIs;
2. TypeScript declarations aligned with the widened runtime range;
3. build, test, coverage, package-install, CLI, dashboard/API, and MCP smoke evidence;
4. all supported operating-system jobs green; and
5. an updated engine range, lockfile, README, contribution guide, release notes, and changelog.

Until that evidence exists, use Node 24.12.0 or a newer maintenance release in the Node 24 line.

## Continuous verification

CI maintains two complementary runtime checks:

- the exact minimum, Node.js 24.12.0, runs the full project gate on Ubuntu and the installed-package smoke test;
- the latest available Node 24 maintenance release runs the full project gate on Ubuntu, Windows, and macOS;
- coverage runs on the latest Node 24 maintenance release; and
- development uses `@types/node` from the Node 24 declaration line so compilation cannot silently depend on a Node 26-only API.

The exact-floor job protects the lower boundary. The floating Node 24 jobs detect regressions introduced by later maintenance releases.

## Check your environment

```sh
node --version
npm --version
```

A supported Node version starts at `v24.12.0` and remains below `v25.0.0`.

Use a version manager or an official Node.js distribution when switching runtimes. Do not suppress an npm engine warning and treat the resulting execution as supported.

## Reporting a compatibility defect

Open a bug report with:

- the exact Node.js, npm, Git, operating-system, and architecture versions;
- whether the failure occurred from a source checkout or an installed package archive;
- the smallest safe reproduction using a disposable repository; and
- the complete error text after removing paths, credentials, repository content, and other sensitive material.

A failure on a version inside the declared range is a compatibility defect. A failure outside the range may still be useful evidence for a future support expansion, but it is not a regression against the current contract.
