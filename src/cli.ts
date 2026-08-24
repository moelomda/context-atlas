#!/usr/bin/env node
import path from "node:path";
import { getPresentedAssertion, queryPresentedAssertions } from "./core/claim-status.js";
import { atlasDirectory, initializeConfig, loadConfig, previewInitialization } from "./core/config.js";
import { buildContextPack, createContextPackOverride } from "./core/context-pack.js";
import { AtlasDatabase } from "./core/database.js";
import {
  applyExternalImport,
  previewExternalImport,
  type ExternalImportRequest,
} from "./core/external-import.js";
import { getHealthReport } from "./core/health.js";
import { getRepoStatus } from "./core/git.js";
import { syncRepository } from "./core/ingest.js";
import { flushLedgerOutbox } from "./core/ledger.js";
import {
  diffContextPackSnapshots,
  listContextPackHistory,
  refreshContextPack,
  saveContextPack,
} from "./core/pack-lifecycle.js";
import { approveProposal, createProposal, listProposals, rejectProposal } from "./core/proposals.js";
import { explainEntity, getGraph, getOverview, getTimeline, searchAtlas } from "./core/query.js";
import { getAssertionEvolution, getAssertionHistory, getAssertionReviewHistory } from "./core/temporal.js";
import {
  createBackup,
  createRebuildVerificationReport,
  importPortableExport,
  previewPortableImport,
  restoreBackup,
  verifyBackup,
  verifyPortableExport,
  writePortableExport,
} from "./core/portable.js";
import { applyRetention, generatePrivacyReport, listRetentionTombstones, previewRetention } from "./core/privacy.js";
import { startWebServer } from "./web/server.js";

interface ParsedArguments {
  command: string;
  positionals: string[];
  options: Map<string, string | boolean>;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const json = Boolean(parsed.options.get("json"));
  if (["help", "--help", "-h", ""].includes(parsed.command)) {
    process.stdout.write(HELP);
    return;
  }
  assertAllowedOptions(parsed);

  if (parsed.command === "init") {
    const target = optionString(parsed.options, "repo") ?? parsed.positionals[0] ?? process.cwd();
    if (parsed.options.get("dry-run")) {
      output({ schemaVersion: 1, operation: "init-preview", preview: previewInitialization(target) }, true);
      return;
    }
    const config = initializeConfig(target, optionString(parsed.options, "name"));
    const result = syncRepository(target);
    output({ message: `Initialized Context Atlas for ${config.projectName}.`, config, sync: result }, json);
    return;
  }

  const root = loadConfig(optionString(parsed.options, "repo") ?? process.cwd()).root;
  switch (parsed.command) {
    case "sync":
    case "update": requireExactPositionals(parsed, 0); output(syncRepository(root), json); break;
    case "overview": output(getOverview(root), json); break;
    case "status": {
      const loaded = loadConfig(root);
      const repository = getRepoStatus(root);
      const database = new AtlasDatabase(root, { readOnly: true });
      try {
        output({
          schemaVersion: 1,
          repository,
          config: loaded.config,
          store: {
            schemaVersion: database.getMeta("schema_version"),
            lastSyncedHead: database.getMeta("last_synced_head"),
            lastSyncedAt: database.getMeta("last_synced_at"),
            ledgerHead: database.getMeta("ledger_head"),
          },
          health: getHealthReport(root, database, repository),
        }, true);
      } finally {
        database.close();
      }
      break;
    }
    case "migrate": {
      const database = new AtlasDatabase(root);
      try {
        output({ schemaVersion: Number(database.getMeta("schema_version")), lastMigration: database.getMeta("last_migration") }, true);
      } finally { database.close(); }
      break;
    }
    case "map":
    case "graph": output(getGraph(root), true); break;
    case "timeline":
    case "history": output(getTimeline(root, parsed.positionals.join(" "), optionNumber(parsed.options, "limit", 200) as number), true); break;
    case "search": requirePositionals(parsed, 1); output(searchAtlas(root, parsed.positionals.join(" "), optionNumber(parsed.options, "limit", 20) as number), true); break;
    case "explain": requirePositionals(parsed, 1); output(explainEntity(root, parsed.positionals.join(" ")), true); break;
    case "pack": {
      requirePositionals(parsed, 1);
      const overrideId = optionString(parsed.options, "override");
      const pack = buildContextPack(
        root,
        parsed.positionals.join(" "),
        optionNumber(parsed.options, "budget", undefined),
        overrideId ? { overrideId } : {},
      );
      if (json) process.stdout.write(JSON.stringify(pack));
      else output(pack.markdown, false);
      break;
    }
    case "pack-save": {
      requirePositionals(parsed, 1);
      const overrideId = optionString(parsed.options, "override");
      const tokenBudget = optionNumber(parsed.options, "budget", undefined);
      const result = saveContextPack(root, parsed.positionals.join(" "), {
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(overrideId ? { overrideId } : {}),
      });
      output({ stored: result.stored, snapshot: result.summary }, true);
      break;
    }
    case "pack-history": {
      requireExactPositionals(parsed, 0);
      const limit = optionNumber(parsed.options, "limit", undefined);
      output(listContextPackHistory(root, limit === undefined ? {} : { limit }), true);
      break;
    }
    case "pack-diff": {
      requireExactPositionals(parsed, 2);
      output(diffContextPackSnapshots(root, parsed.positionals[0] as string, parsed.positionals[1] as string), true);
      break;
    }
    case "pack-refresh": {
      requireExactPositionals(parsed, 1);
      const overrideId = optionString(parsed.options, "override");
      const result = refreshContextPack(
        root,
        parsed.positionals[0] as string,
        overrideId ? { overrideId } : {},
      );
      output({
        stored: result.stored,
        changed: result.changed,
        previousSnapshotId: result.previousSnapshotId,
        snapshot: result.summary,
        diff: result.diff,
      }, true);
      break;
    }
    case "pack-override": {
      requireExactPositionals(parsed, 0);
      const actor = optionString(parsed.options, "actor");
      const reason = optionString(parsed.options, "reason");
      if (!actor || !reason) throw new Error("`pack-override` requires --actor human:<id> and --reason TEXT.");
      const task = optionString(parsed.options, "task");
      const durationMinutes = optionNumber(parsed.options, "duration", undefined);
      output(createContextPackOverride(root, {
        actor,
        reason,
        ...(task ? { task } : {}),
        ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      }), true);
      break;
    }
    case "health": output(getHealthReport(root), true); break;
    case "recover-ledger": {
      requireExactPositionals(parsed, 0);
      const database = new AtlasDatabase(root);
      try { output(flushLedgerOutbox(root, database), true); }
      finally { database.close(); }
      break;
    }
    case "validate": {
      const report = getHealthReport(root);
      output(report, true);
      if (report.checks.some((item) => item.status === "critical")) process.exitCode = 2;
      break;
    }
    case "proposals": {
      const status = parsed.positionals[0] as "pending" | "approved" | "rejected" | "superseded" | undefined;
      if (status && !["pending", "approved", "rejected", "superseded"].includes(status)) throw new Error(`Unknown proposal status: ${status}`);
      output(listProposals(root, status), true);
      break;
    }
    case "propose": {
      requireExactPositionals(parsed, 0);
      const kind = optionString(parsed.options, "kind") ?? "context_update";
      const title = optionString(parsed.options, "title");
      const summary = optionString(parsed.options, "summary");
      if (!title || !summary) throw new Error("`propose` requires --title and --summary.");
      const evidenceIds = (optionString(parsed.options, "evidence") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      const targetId = optionString(parsed.options, "target");
      output(createProposal(root, {
        kind, title, summary, evidenceIds, ...(targetId ? { targetId } : {}),
      }), true);
      break;
    }
    case "approve": {
      requireExactPositionals(parsed, 1);
      const actor = optionString(parsed.options, "actor");
      if (!actor) throw new Error("`approve` requires an attributed --actor human:<id>.");
      output(approveProposal(root, parsed.positionals[0] as string, optionString(parsed.options, "note"), actor), true);
      break;
    }
    case "reject": {
      requireExactPositionals(parsed, 1);
      const actor = optionString(parsed.options, "actor");
      if (!actor) throw new Error("`reject` requires an attributed --actor human:<id>.");
      output(rejectProposal(root, parsed.positionals[0] as string, optionString(parsed.options, "note"), actor), true);
      break;
    }
    case "assertions": {
      const validAt = optionString(parsed.options, "valid-at");
      const recordedAt = optionString(parsed.options, "recorded-at");
      const subjectId = optionString(parsed.options, "subject");
      const predicate = optionString(parsed.options, "predicate");
      output(queryPresentedAssertions(root, {
        ...(validAt ? { validAt } : {}),
        ...(recordedAt ? { recordedAt } : {}),
        ...(subjectId ? { subjectId } : {}),
        ...(predicate ? { predicate } : {}),
      }), true);
      break;
    }
    case "assertion": {
      requirePositionals(parsed, 1);
      const assertion = getPresentedAssertion(root, parsed.positionals[0] as string);
      if (!assertion) throw new Error(`Unknown assertion: ${parsed.positionals[0]}`);
      output(assertion, true);
      break;
    }
    case "assertion-history": {
      requirePositionals(parsed, 1);
      const logicalId = parsed.positionals[0] as string;
      output({ logicalId, revisions: getAssertionHistory(root, logicalId), reviews: getAssertionReviewHistory(root, logicalId) }, true);
      break;
    }
    case "assertion-evolution": {
      const subjectId = optionString(parsed.options, "subject");
      const predicate = optionString(parsed.options, "predicate");
      const recordedFrom = optionString(parsed.options, "recorded-from");
      const recordedTo = optionString(parsed.options, "recorded-to");
      const validFrom = optionString(parsed.options, "valid-from");
      const validTo = optionString(parsed.options, "valid-to");
      output(getAssertionEvolution(root, {
        ...(subjectId ? { subjectId } : {}),
        ...(predicate ? { predicate } : {}),
        ...(recordedFrom ? { recordedFrom } : {}),
        ...(recordedTo ? { recordedTo } : {}),
        ...(validFrom ? { validFrom } : {}),
        ...(validTo ? { validTo } : {}),
      }), true);
      break;
    }
    case "export": {
      const destination = path.resolve(parsed.positionals[0] ?? path.join(atlasDirectory(root), "exports", "knowledge.json"));
      const exported = writePortableExport(root, destination);
      output({ destination, checksum: exported.checksum, entities: (exported.payload.entities as unknown[]).length }, true);
      break;
    }
    case "verify-export": {
      requirePositionals(parsed, 1);
      const verification = verifyPortableExport(path.resolve(parsed.positionals[0] as string));
      output(verification, true);
      if (!verification.valid) process.exitCode = 2;
      break;
    }
    case "source-import-preview": {
      requireExactPositionals(parsed, 1);
      const request = externalImportRequest(parsed);
      output(previewExternalImport(root, path.resolve(parsed.positionals[0] as string), request), true);
      break;
    }
    case "source-import": {
      requireExactPositionals(parsed, 1);
      const request = externalImportRequest(parsed);
      const planId = optionString(parsed.options, "plan");
      if (!planId || optionString(parsed.options, "confirm") !== "IMPORT") {
        throw new Error("`source-import` requires --plan ID and --confirm IMPORT after reviewing a fresh source-import-preview.");
      }
      output(applyExternalImport(root, path.resolve(parsed.positionals[0] as string), {
        ...request,
        planId,
        confirmation: "IMPORT",
      }), true);
      break;
    }
    case "import-preview":
    case "import": {
      requireExactPositionals(parsed, 1);
      const sourceFile = path.resolve(parsed.positionals[0] as string);
      const importOptions = {
        ...(parsed.options.has("allow-repository-mismatch") ? { allowRepositoryMismatch: true } : {}),
        ...(parsed.options.has("allow-unreachable-history") ? { allowUnreachableHistory: true } : {}),
      };
      if (parsed.command === "import-preview" || parsed.options.has("dry-run")) output(previewPortableImport(root, sourceFile, importOptions), true);
      else output(importPortableExport(root, sourceFile, importOptions), true);
      break;
    }
    case "rebuild-verify": {
      requirePositionals(parsed, 1);
      output(createRebuildVerificationReport(root, path.resolve(parsed.positionals[0] as string)), true);
      break;
    }
    case "privacy": output(generatePrivacyReport(root), true); break;
    case "retention-preview": {
      requireExactPositionals(parsed, 0);
      const portableExportsOlderThanDays = optionNumber(parsed.options, "exports-days", undefined);
      const backupsOlderThanDays = optionNumber(parsed.options, "backups-days", undefined);
      output(previewRetention(root, {
        ...(portableExportsOlderThanDays !== undefined ? { portableExportsOlderThanDays } : {}),
        ...(backupsOlderThanDays !== undefined ? { backupsOlderThanDays } : {}),
      }), true);
      break;
    }
    case "retention-apply": {
      requireExactPositionals(parsed, 0);
      const planId = optionString(parsed.options, "plan");
      const actor = optionString(parsed.options, "actor");
      const reason = optionString(parsed.options, "reason");
      if (!planId || !actor || !reason || optionString(parsed.options, "confirm") !== "APPLY") {
        throw new Error("`retention-apply` requires --plan ID --actor human:<id> --reason TEXT --confirm APPLY.");
      }
      const portableExportsOlderThanDays = optionNumber(parsed.options, "exports-days", undefined);
      const backupsOlderThanDays = optionNumber(parsed.options, "backups-days", undefined);
      output(applyRetention(root, {
        ...(portableExportsOlderThanDays !== undefined ? { portableExportsOlderThanDays } : {}),
        ...(backupsOlderThanDays !== undefined ? { backupsOlderThanDays } : {}),
        planId,
        actor,
        reason,
        userConfirmed: true,
      }), true);
      break;
    }
    case "retention-history": {
      requireExactPositionals(parsed, 0);
      output({ schemaVersion: 1, tombstones: listRetentionTombstones(root) }, true);
      break;
    }
    case "backup": {
      const destination = path.resolve(parsed.positionals[0] ?? path.join(atlasDirectory(root), "backups", `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`));
      const manifest = await createBackup(root, destination);
      output({ destination, manifest }, true);
      break;
    }
    case "verify-backup": {
      requirePositionals(parsed, 1);
      const verification = verifyBackup(path.resolve(parsed.positionals[0] as string));
      output(verification, true);
      if (!verification.valid) process.exitCode = 2;
      break;
    }
    case "restore": {
      requireExactPositionals(parsed, 1);
      output(await restoreBackup(root, path.resolve(parsed.positionals[0] as string), optionString(parsed.options, "confirm") ?? ""), true);
      break;
    }
    case "serve": {
      const host = optionString(parsed.options, "host") ?? "127.0.0.1";
      const port = optionNumber(parsed.options, "port", 4242) as number;
      const running = await startWebServer(root, { host, port });
      process.stdout.write(`Context Atlas is available at ${running.url}\nPress Ctrl+C to stop.\n`);
      break;
    }
    case "evidence": {
      const database = new AtlasDatabase(root, { readOnly: true });
      try {
        if (!parsed.positionals[0]) throw new Error("`evidence` requires an evidence ID.");
        const evidence = database.getEvidence(parsed.positionals[0]);
        if (!evidence) throw new Error(`Unknown evidence: ${parsed.positionals[0]}`);
        output(evidence.sensitive ? { ...evidence, locator: "[withheld]", metadata: { withheld: true } } : evidence, true);
      } finally { database.close(); }
      break;
    }
    default: throw new Error(`Unknown command: ${parsed.command}. Run context-atlas help.`);
  }
}

function parseArguments(args: string[]): ParsedArguments {
  const command = args.shift() ?? "";
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  const booleanOptions = new Set(["json", "dry-run", "allow-repository-mismatch", "allow-unreachable-history"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    if (value.startsWith("--")) {
      const optionBody = value.slice(2);
      const equals = optionBody.indexOf("=");
      const rawKey = equals >= 0 ? optionBody.slice(0, equals) : optionBody;
      const inline = equals >= 0 ? optionBody.slice(equals + 1) : undefined;
      if (!rawKey) continue;
      if (options.has(rawKey)) throw new Error(`--${rawKey} may be supplied only once.`);
      if (booleanOptions.has(rawKey)) {
        if (inline !== undefined) throw new Error(`--${rawKey} is a flag and does not accept a value.`);
        options.set(rawKey, true);
        continue;
      }
      if (inline !== undefined) {
        if (!inline) throw new Error(`--${rawKey} requires a value.`);
        options.set(rawKey, inline);
        continue;
      }
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(rawKey, next);
        index += 1;
      } else throw new Error(`--${rawKey} requires a value.`);
    } else positionals.push(value);
  }
  return { command, positionals, options };
}

const GLOBAL_OPTIONS = new Set(["repo", "json"]);
const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  init: ["name", "dry-run"],
  sync: [],
  update: [],
  overview: [],
  status: [],
  migrate: [],
  map: [],
  graph: [],
  timeline: ["limit"],
  history: ["limit"],
  search: ["limit"],
  explain: [],
  pack: ["budget", "override"],
  "pack-save": ["budget", "override"],
  "pack-history": ["limit"],
  "pack-diff": [],
  "pack-refresh": ["override"],
  "pack-override": ["actor", "reason", "task", "duration"],
  health: [],
  "recover-ledger": [],
  validate: [],
  proposals: [],
  propose: ["kind", "title", "summary", "evidence", "target"],
  approve: ["actor", "note"],
  reject: ["actor", "note"],
  assertions: ["valid-at", "recorded-at", "subject", "predicate"],
  assertion: [],
  "assertion-history": [],
  "assertion-evolution": ["subject", "predicate", "recorded-from", "recorded-to", "valid-from", "valid-to"],
  evidence: [],
  export: [],
  "verify-export": [],
  "source-import-preview": ["type", "origin", "authority", "sensitivity", "purpose", "actor", "title", "source-time"],
  "source-import": ["type", "origin", "authority", "sensitivity", "purpose", "actor", "title", "source-time", "plan", "confirm"],
  "import-preview": ["allow-repository-mismatch", "allow-unreachable-history"],
  import: ["dry-run", "allow-repository-mismatch", "allow-unreachable-history"],
  "rebuild-verify": [],
  privacy: [],
  "retention-preview": ["exports-days", "backups-days"],
  "retention-apply": ["plan", "actor", "reason", "confirm", "exports-days", "backups-days"],
  "retention-history": [],
  backup: [],
  "verify-backup": [],
  restore: ["confirm"],
  serve: ["host", "port"],
};

function assertAllowedOptions(parsed: ParsedArguments): void {
  const commandOptions = COMMAND_OPTIONS[parsed.command];
  if (!commandOptions) return;
  const allowed = new Set([...GLOBAL_OPTIONS, ...commandOptions]);
  const unsupported = [...parsed.options.keys()].filter((key) => !allowed.has(key)).sort();
  if (unsupported.length > 0) {
    throw new Error(`${parsed.command} does not accept ${unsupported.map((key) => `--${key}`).join(", ")}.`);
  }
}

function optionString(options: Map<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

function optionNumber(options: Map<string, string | boolean>, key: string, fallback: number | undefined): number | undefined {
  const value = optionString(options, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number.`);
  return parsed;
}

function externalImportRequest(parsed: ParsedArguments): ExternalImportRequest {
  const type = optionString(parsed.options, "type");
  const sourceKind = type === "document"
    ? "external_document"
    : type === "conversation-summary"
      ? "conversation_summary"
      : null;
  if (!sourceKind) throw new Error("External source import requires --type document|conversation-summary.");
  const originLabel = optionString(parsed.options, "origin");
  const declaredAuthority = optionString(parsed.options, "authority");
  const sensitivityLabel = optionString(parsed.options, "sensitivity");
  const purpose = optionString(parsed.options, "purpose");
  const actor = optionString(parsed.options, "actor");
  if (!originLabel || !purpose || !actor
    || !["documented", "human", "unknown"].includes(declaredAuthority ?? "")
    || !["normal", "sensitive"].includes(sensitivityLabel ?? "")) {
    throw new Error(
      "External source import requires --origin LABEL --authority documented|human|unknown "
      + "--sensitivity normal|sensitive --purpose TEXT --actor human:<id>.",
    );
  }
  const title = optionString(parsed.options, "title");
  const sourceObservedAt = optionString(parsed.options, "source-time");
  return {
    sourceKind,
    originLabel,
    declaredAuthority: declaredAuthority as ExternalImportRequest["declaredAuthority"],
    sensitivityLabel: sensitivityLabel as ExternalImportRequest["sensitivityLabel"],
    purpose,
    actor,
    ...(title ? { title } : {}),
    ...(sourceObservedAt ? { sourceObservedAt } : {}),
  };
}

function requirePositionals(parsed: ParsedArguments, minimum: number): void {
  if (parsed.positionals.length < minimum) throw new Error(`${parsed.command} requires an argument.`);
}

function requireExactPositionals(parsed: ParsedArguments, expected: number): void {
  if (parsed.positionals.length !== expected) {
    throw new Error(`${parsed.command} requires exactly ${expected} positional argument${expected === 1 ? "" : "s"}.`);
  }
}

function output(value: unknown, json: boolean): void {
  if (typeof value === "string" && !json) process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const HELP = `Context Atlas — evidence-backed temporal project memory

Usage:
  context-atlas init [repo] [--name NAME] [--dry-run]
  context-atlas sync [--repo PATH]
  context-atlas status [--repo PATH]
  context-atlas migrate [--repo PATH]
  context-atlas overview [--json]
  context-atlas map
  context-atlas timeline [query] [--limit N]
  context-atlas search <query> [--limit N]
  context-atlas explain <entity-or-path>
  context-atlas pack <task> [--budget TOKENS] [--override ID] [--json]
  context-atlas pack-save <task> [--budget TOKENS] [--override ID]
  context-atlas pack-history [--limit N]
  context-atlas pack-diff <left-snapshot-id> <right-snapshot-id>
  context-atlas pack-refresh <snapshot-id> [--override ID]
  context-atlas pack-override --actor human:<id> --reason TEXT [--task TEXT] [--duration MINUTES]
  context-atlas health
  context-atlas recover-ledger
  context-atlas validate
  context-atlas proposals [pending|approved|rejected|superseded]
  context-atlas propose --kind KIND --title TITLE --summary TEXT --evidence ID[,ID] [--target ID]
  context-atlas approve <proposal-id> --actor human:<id> [--note TEXT]
  context-atlas reject <proposal-id> --actor human:<id> [--note TEXT]
  context-atlas assertions [--valid-at ISO] [--recorded-at ISO] [--subject ID] [--predicate NAME]
  context-atlas assertion <assertion-id>
  context-atlas assertion-history <logical-id>
  context-atlas assertion-evolution [--recorded-from ISO] [--recorded-to ISO] [--valid-from ISO] [--valid-to ISO]
  context-atlas evidence <evidence-id>
  context-atlas export [destination]
  context-atlas verify-export <file>
  context-atlas source-import-preview <file> --type document|conversation-summary --origin LABEL --authority documented|human|unknown --sensitivity normal|sensitive --purpose TEXT --actor human:<id> [--title TEXT] [--source-time ISO]
  context-atlas source-import <file> --plan ID --confirm IMPORT --type document|conversation-summary --origin LABEL --authority documented|human|unknown --sensitivity normal|sensitive --purpose TEXT --actor human:<id> [--title TEXT] [--source-time ISO]
  context-atlas import-preview <file> [--allow-repository-mismatch] [--allow-unreachable-history]
  context-atlas import <file> [--dry-run] [--allow-repository-mismatch] [--allow-unreachable-history]
  context-atlas rebuild-verify <file>
  context-atlas privacy
  context-atlas retention-preview [--exports-days N] [--backups-days N]
  context-atlas retention-apply --plan ID --actor human:<id> --reason TEXT --confirm APPLY [--exports-days N] [--backups-days N]
  context-atlas retention-history
  context-atlas backup [destination]
  context-atlas verify-backup <directory>
  context-atlas restore <directory> --confirm RESTORE
  context-atlas serve [--host 127.0.0.1] [--port 4242]

Safety model:
  Repository observations are automatic and evidence-backed. Generated narratives remain pending
  until explicitly approved through an attributed human CLI or protected loopback dashboard action;
  agent MCP tools remain read-only. Full raw diffs and file bodies are not retained; bounded sanitized
  extracts and metadata may be stored. Sensitive paths and detected secrets are excluded.
`;

main().catch((error: unknown) => {
  process.stderr.write(`Context Atlas error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
