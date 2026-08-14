# Changelog

All notable changes to Context Atlas are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because Context Atlas is still on the `0.x` line, minor releases may include
breaking changes. Those changes must be called out explicitly.

## [Unreleased]

No changes yet.

## [0.1.0] - 2026-08-14

### Added

- Cross-platform CI, security analysis, dependency review, issue forms, and a
  tag-gated GitHub Release workflow.
- Contributor, security, conduct, and release-maintenance documentation.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.
- Newcomer overview, bounded mind map, timeline, search, and evidence-linked
  explanations.
- Task-bounded context packs with repository identity, evidence references,
  freshness warnings, and a machine-readable safety verdict.
- Human-reviewed narrative proposal, approval, rejection, and conflict flows.
- Tamper-evident action ledger, checksummed exports, verified backups, and
  recoverable restore.
- Loopback-only interactive dashboard with overview, map, timeline, and health
  views.
- Stdio MCP server with ten read-only tools; synchronization, proposal creation,
  approval, and rejection remain explicit human-operated CLI actions.
- Self-contained Codex plugin bundle.
- Automated tests for the implemented alpha acceptance boundary.

### Security

- Sensitive path withholding, common secret-pattern redaction, `.atlasignore`,
  static path validation, Content Security Policy, and loopback-only HTTP
  serving.

### Known limitations

- Node 24 labels the built-in SQLite API used by this release experimental.
- Current verification uses small disposable repositories; scale, accessibility,
  usability, penetration, and process-crash testing remain incomplete.
- The graph is structural rather than a complete semantic or bitemporal project
  model.
- Context Atlas is a navigation aid, not proof that source code or generated
  changes are correct.
