---
name: context-atlas
description: Retrieve and interpret durable, evidence-backed project memory from Context Atlas, including overviews, architecture, chronology, decisions, risks, provenance, health, and task-specific context packs. Use when Codex must onboard to an unfamiliar repository, explain how or why code evolved, prepare context before a meaningful code change, investigate past decisions, or assess context freshness and conflicts.
---

# Context Atlas

Use the `context-atlas` MCP server as a high-level project memory layer. Treat its claims as indexed knowledge with provenance, not as a substitute for the repository.

Every successful tool response uses a versioned envelope. Read the payload from `data`, preserve `contractVersion`, and use `snapshot.repositoryId`, `snapshot.head`, and `snapshot.knowledgeWatermark` when comparing results from separate calls.

## Establish context

Before making a meaningful code change:

1. Resolve the target repository from the active workspace and pass its absolute path as `repo` to every tool. Do not rely on the MCP process working directory.
2. Call `atlas_health` to check initialization, freshness, pending proposals, and integrity warnings.
3. Call `atlas_context_pack` with a concrete description of the task. Supply `tokenBudget` only when the user or surrounding task gives a real budget.
4. Follow the context pack's evidence into relevant files, tests, configuration, and Git history before editing.
5. Use narrower read tools when the pack exposes uncertainty, conflicts, missing coverage, or stale knowledge.

For onboarding or broad explanations, start with `atlas_overview`, then narrow the inquiry instead of dumping the entire project history.

## Use read-only tools freely

Use these tools without requesting separate permission when they are relevant to the user's request:

- `atlas_overview(repo?)`: Explain the project's purpose, current architecture, major components, and status.
- `atlas_context_pack(task, tokenBudget?, overrideId?, repo?)`: Retrieve focused context, constraints, decisions, risks, and evidence for a task. Pass `overrideId` only when the user explicitly identifies an existing human-created override for this task.
- `atlas_pack_history(limit?, repo?)`: List immutable saved task-context snapshots newest first.
- `atlas_pack_snapshot(snapshotId, includePack?, repo?)`: Verify one saved snapshot; keep `includePack` false unless the full historical pack is needed.
- `atlas_pack_diff(leftSnapshotId, rightSnapshotId, repo?)`: Explain exactly what changed between two saved context snapshots, including freshness, topology, evidence, and warnings.
- `atlas_explain(target, repo?)`: Explain a component, feature, file, decision, risk, or other known target.
- `atlas_history(query?, limit?, repo?)`: Trace chronological changes and superseded decisions. Keep limits focused.
- `atlas_health(repo?)`: Check freshness, integrity, and pending-memory state.
- `atlas_search(query, limit?, repo?)`: Find relevant entities and evidence before requesting deeper explanations.
- `atlas_evidence(evidenceId, repo?)`: Resolve an evidence ID to safe provenance metadata. Sensitive locators remain withheld.
- `atlas_assertions(validAt?, recordedAt?, subjectId?, predicate?, repo?)`: Read accepted assertions as they were valid and known at two independent time coordinates.
- `atlas_assertion_history(logicalId, repo?)`: Inspect every immutable revision and actor-attributed review action for one logical assertion.
- `atlas_assertion_evolution(subjectId?, predicate?, recordedFrom?, recordedTo?, validFrom?, validTo?, repo?)`: Trace assertion revisions across a bounded valid-time or recorded-time window.

Prefer one focused query over several broad queries. Re-query only when the first result identifies a concrete gap.

## Preserve epistemic boundaries

- Cite the evidence identifiers or source paths returned by Context Atlas near the claims they support.
- State confidence when the server reports it. Preserve uncertainty rather than rounding it up.
- Label inferred claims as inferred and pending proposals as pending. Never present either as established fact.
- Distinguish current state from historical state and mark superseded decisions explicitly.
- If indexed context conflicts with current code, tests, configuration, or Git evidence, report the conflict and treat current repository evidence as authoritative for implementation state.
- Do not invent a rationale when evidence only proves what changed. Say that the reason is unknown.
- Explain important findings in plain language suitable for a developer with no prior project knowledge.

## Preserve the read-only boundary

- The Context Atlas MCP surface is read-only. It cannot synchronize, save or refresh packs, apply retention, create proposals, approve, reject, or otherwise mutate project memory.
- Never translate a request to inspect, explain, search, plan, review, or modify source code into permission to run a Context Atlas CLI mutation.
- Use `context-atlas sync` or `context-atlas propose` only when the user explicitly asks for that exact state change and a trusted human-operated terminal is available.
- Never approve or reject a proposal through MCP; no such MCP capability exists by design.
- Use `context-atlas approve <id> --actor human:<id>` or `context-atlas reject <id> --actor human:<id>` only when the user explicitly directs that exact outcome for an identified proposal. Do not select a proposal or outcome on the user's behalf.
- If `atlas_context_pack` reports `context_pack_blocked`, stop and surface the critical findings. MCP cannot create an override. A human may create a short-lived, immutable CLI override with an attributed actor and rationale; never create or select one on the user's behalf. If the user explicitly supplies its ID, MCP may apply that already-existing task/health-scoped override, but the response remains `OVERRIDDEN CRITICAL / navigation-only` and the warning must never be softened or omitted.
- After any explicit CLI mutation, report what changed, what remains pending, and the evidence or proposal identifier.

## Answer with a high-level map

For broad project questions, organize the response around:

1. Product purpose and users.
2. Major components and their relationships.
3. Important chronology and decision rationale.
4. Current work, constraints, and known risks.
5. Uncertainty, stale areas, pending proposals, and supporting evidence.

For task preparation, lead with the task-relevant components, constraints, prior decisions, likely blast radius, and validation expectations.
