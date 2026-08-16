## Alpha release

This `0.x` release is an alpha prerelease. Interfaces, storage formats, and
upgrade requirements may change before `1.0.0`; do not treat this build as a
stable production contract.

## Runtime warning

Context Atlas requires Node.js 24 or newer. The built-in `node:sqlite` API used
by this release is still labeled experimental by Node.js.

## Known limitations

- Context Atlas is a navigation and project-memory aid, not proof that indexed
  source code, generated explanations, or proposed changes are correct.
- Current validation is centered on small disposable repositories. Large-scale
  performance, rendered-browser accessibility, screen-reader behavior,
  penetration testing, and broad crash/power-loss coverage remain incomplete.
- The graph is structural and evidence-backed, but it is not yet a complete
  semantic or bitemporal model of every project fact.

## Upgrade and migration caveats

- Read the dated changelog section for this tag before upgrading, and back up
  the repository's `.context-atlas/` directory before changing versions.
- Existing repositories retain their configured context-pack budget, including
  the legacy 4,000-token default; new repositories default to 8,000 tokens.
- Extraction-policy or `.atlasignore` changes invalidate the guidance
  watermark. Synchronize again and human-review replacement claims; legacy
  reviewed claims without a watermark intentionally fail closed.
- This workflow publishes GitHub release assets only. It does not publish an
  npm-registry package.

