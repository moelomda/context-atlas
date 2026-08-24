import path from "node:path";
import { z } from "zod";
import { findSecrets } from "../core/security.js";
import { sha256, stableStringify } from "../core/util.js";
import {
  EXTENSION_API_VERSION,
  EXTENSION_SCHEMA_VERSION,
  type ApprovedArtifactV1,
  type ArtifactFragmentV1,
  type CanonicalExportDtoV1,
  type EvidenceExtractorInputV1,
  type EvidenceExtractorOutputV1,
  type ExporterInputV1,
  type ExporterOutputV1,
  type ExtensionInputFor,
  type ExtensionKind,
  type ExtensionManifestFor,
  type ExtensionManifestV1,
  type ExtensionOutputFor,
  type InferenceProviderInputV1,
  type InferenceProviderOutputV1,
  type JsonValue,
  type LanguageAnalyzerInputV1,
  type LanguageAnalyzerOutputV1,
  type RedactorInputV1,
  type RedactorOutputV1,
  type ValidatorInputV1,
  type ValidatorOutputV1,
  type ValidatorSubjectV1,
} from "./contracts.js";

export const MAX_EXTENSION_INPUT_SERIALIZED_BYTES = 4 * 1024 * 1024;
export const MAX_EXTENSION_OUTPUT_SERIALIZED_BYTES = 8 * 1024 * 1024;
export const MAX_EXPORT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_EXTENSION_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_EXTENSION_TIMEOUT_MS = 30_000;

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_JSON_STRING = 1024 * 1024;
const MAX_JSON_ARRAY_ITEMS = 10_000;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 50_000;
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_EXPORT_OUTPUT_BYTES / 3) * 4 + 4;
const MAX_IDENTIFIER_LENGTH = 256;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/;
const SAFE_EXTENSION_ID = /^[a-z0-9][a-z0-9._/@+\-]{0,127}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:+\-]{0,127}$/;
const SAFE_PREDICATE = /^[a-z][a-z0-9_.:\-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-]*$/;
const RESERVED_AUTHORITY_TOKENS = new Set([
  "acceptance", "accepted", "approval", "approvalstate", "approved", "approvedby", "authority",
  "canonicalauthority", "humanapproved", "lifecycle", "review", "reviewed", "reviewedby", "reviewer",
  "reviewerid", "reviewstate", "approvalstatus", "authoritylevel", "lifecyclestate", "reviewstatus",
]);

function isAsciiDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isSemverCoreNumber(value: string): boolean {
  if (value.length === 0 || (value.length > 1 && value[0] === "0")) return false;
  for (const character of value) {
    if (!isAsciiDigit(character)) return false;
  }
  return true;
}

function isSemverIdentifier(value: string, allowLeadingZeroNumeric: boolean): boolean {
  if (value.length === 0) return false;
  let numeric = true;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!digit) numeric = false;
    if (!digit && !upper && !lower && character !== "-") return false;
  }
  return allowLeadingZeroNumeric || !numeric || value.length === 1 || value[0] !== "0";
}

function isSemver(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;

  const plus = value.indexOf("+");
  if (plus !== -1) {
    if (plus === value.length - 1 || value.indexOf("+", plus + 1) !== -1) return false;
    const buildIdentifiers = value.slice(plus + 1).split(".");
    if (!buildIdentifiers.every((identifier) => isSemverIdentifier(identifier, true))) return false;
  }

  const coreAndPrerelease = plus === -1 ? value : value.slice(0, plus);
  const dash = coreAndPrerelease.indexOf("-");
  if (dash !== -1) {
    if (dash === coreAndPrerelease.length - 1) return false;
    const prereleaseIdentifiers = coreAndPrerelease.slice(dash + 1).split(".");
    if (!prereleaseIdentifiers.every((identifier) => isSemverIdentifier(identifier, false))) return false;
  }

  const core = dash === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, dash);
  const coreNumbers = core.split(".");
  return coreNumbers.length === 3 && coreNumbers.every(isSemverCoreNumber);
}

export class ExtensionContractValidationError extends Error {
  constructor() {
    super("Extension contract validation failed.");
    this.name = "ExtensionContractValidationError";
  }
}

const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH).regex(SAFE_IDENTIFIER);
const extensionIdSchema = z.string().min(1).max(128).regex(SAFE_EXTENSION_ID);
const nameSchema = z.string().min(1).max(128).regex(SAFE_NAME);
const predicateSchema = z.string().min(1).max(128).regex(SAFE_PREDICATE);
const digestSchema = z.string().regex(SHA256);
const mediaTypeSchema = z.string().max(200).regex(MEDIA_TYPE);
const shortTextSchema = z.string().min(1).max(2_000);
const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(MAX_JSON_STRING),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema).max(MAX_JSON_ARRAY_ITEMS),
  z.record(z.string().min(1).max(256), jsonValueSchema),
]));

const approvedArtifactKindSchema = z.enum(["source", "document", "manifest", "test", "configuration", "other"]);
const inferencePurposeSchema = z.enum(["component-purpose", "semantic-event-grouping", "change-impact", "missing-context"]);
const validationScopeSchema = z.enum(["evidence", "entity", "relationship", "assertion", "pack", "export", "provider-request"]);

const artifactFragmentSchema = z.object({
  artifactId: identifierSchema,
  startByte: safeIntegerSchema,
  endByte: safeIntegerSchema,
}).strict();

const coverageDiagnosticSchema = z.object({
  code: nameSchema,
  severity: z.enum(["info", "warning", "error"]),
  message: shortTextSchema,
  coverageGap: z.boolean(),
  fragment: artifactFragmentSchema.nullable(),
}).strict();

const coverageSummarySchema = z.object({
  bytesExamined: safeIntegerSchema,
  bytesCovered: safeIntegerSchema,
  complete: z.boolean(),
}).strict();

const approvedArtifactSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  artifactId: identifierSchema,
  kind: approvedArtifactKindSchema,
  relativePath: z.string().min(1).max(1_000),
  mediaType: mediaTypeSchema,
  bytesBase64: z.string().max(MAX_BASE64_CHARACTERS),
  byteLength: safeIntegerSchema,
  sha256: digestSchema,
  observedAt: z.string().min(1).max(100),
}).strict();

const evidenceExtractorCapabilitiesSchema = z.object({
  artifactKinds: z.array(approvedArtifactKindSchema).min(1).max(6),
  mediaTypes: z.array(mediaTypeSchema).min(1).max(128),
  maxArtifactBytes: z.number().int().min(1).max(MAX_EXTENSION_INPUT_SERIALIZED_BYTES),
  maxObservations: z.number().int().min(1).max(10_000),
}).strict();

const languageAnalyzerCapabilitiesSchema = z.object({
  languages: z.array(nameSchema).min(1).max(128),
  mediaTypes: z.array(mediaTypeSchema).min(1).max(128),
  maxArtifactBytes: z.number().int().min(1).max(MAX_EXTENSION_INPUT_SERIALIZED_BYTES),
  maxStructures: z.number().int().min(1).max(10_000),
}).strict();

const inferenceProviderCapabilitiesSchema = z.object({
  purposes: z.array(inferencePurposeSchema).min(1).max(4),
  models: z.array(z.string().min(1).max(200)).min(1).max(128),
  maxCandidates: z.number().int().min(1).max(256),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
}).strict();

const redactorCapabilitiesSchema = z.object({
  categories: z.array(nameSchema).min(1).max(128),
  actions: z.array(z.enum(["redact", "block"])).min(1).max(2),
  maxItems: z.number().int().min(1).max(4_096),
  maxSpans: z.number().int().min(1).max(4_096),
}).strict();

const exporterCapabilitiesSchema = z.object({
  formats: z.array(nameSchema).min(1).max(128),
  mediaTypes: z.array(mediaTypeSchema).min(1).max(128),
  maxArtifacts: z.number().int().min(1).max(16),
  maxTotalBytes: z.number().int().min(1).max(MAX_EXPORT_OUTPUT_BYTES),
}).strict();

const validatorCapabilitiesSchema = z.object({
  scopes: z.array(validationScopeSchema).min(1).max(7),
  ruleIds: z.array(nameSchema).min(1).max(256),
  maxFindings: z.number().int().min(1).max(1_000),
}).strict();

const manifestCommon = {
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  extensionApiVersion: z.literal(EXTENSION_API_VERSION),
  id: extensionIdSchema,
  version: z.string().min(1).max(200).refine(isSemver),
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  deterministic: z.boolean(),
  inputSchemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  outputSchemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
} as const;

export const extensionManifestSchema = z.discriminatedUnion("kind", [
  z.object({ ...manifestCommon, kind: z.literal("evidence-extractor"), capabilities: evidenceExtractorCapabilitiesSchema }).strict(),
  z.object({ ...manifestCommon, kind: z.literal("language-analyzer"), capabilities: languageAnalyzerCapabilitiesSchema }).strict(),
  z.object({ ...manifestCommon, kind: z.literal("inference-provider"), capabilities: inferenceProviderCapabilitiesSchema }).strict(),
  z.object({ ...manifestCommon, kind: z.literal("redactor"), capabilities: redactorCapabilitiesSchema }).strict(),
  z.object({ ...manifestCommon, kind: z.literal("exporter"), capabilities: exporterCapabilitiesSchema }).strict(),
  z.object({ ...manifestCommon, kind: z.literal("validator"), capabilities: validatorCapabilitiesSchema }).strict(),
]);

const evidenceExtractorInputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  artifact: approvedArtifactSchema,
  policy: z.object({
    schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
    policyVersion: nameSchema,
    allowedEntityTypes: z.array(nameSchema).min(1).max(256),
    allowedPredicates: z.array(predicateSchema).min(1).max(256),
    maxObservations: z.number().int().min(1).max(10_000),
  }).strict(),
}).strict();

const extractedObservationSchema = z.object({
  observationId: identifierSchema,
  claimKey: identifierSchema,
  subject: z.object({
    localKey: identifierSchema,
    entityType: nameSchema,
    title: z.string().min(1).max(500),
  }).strict(),
  predicate: predicateSchema,
  value: jsonValueSchema,
  fragment: artifactFragmentSchema,
  dependencies: z.array(z.object({
    kind: z.enum(["artifact", "policy", "extension"]),
    id: identifierSchema,
    digest: digestSchema,
  }).strict()).min(1).max(256),
  confidence: z.object({
    method: z.enum(["deterministic", "heuristic"]),
    score: z.number().min(0).max(1).nullable(),
    explanation: shortTextSchema,
  }).strict(),
}).strict();

const evidenceExtractorOutputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  observations: z.array(extractedObservationSchema).max(10_000),
  diagnostics: z.array(coverageDiagnosticSchema).max(1_000),
  coverage: coverageSummarySchema,
}).strict();

const languageAnalyzerInputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  artifact: approvedArtifactSchema,
  language: nameSchema,
  policy: z.object({
    schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
    policyVersion: nameSchema,
    maxStructures: z.number().int().min(1).max(10_000),
  }).strict(),
}).strict();

const analyzedModuleSchema = z.object({
  localId: identifierSchema,
  name: z.string().min(1).max(500),
  fragment: artifactFragmentSchema,
}).strict();

const analyzedSymbolSchema = z.object({
  localId: identifierSchema,
  moduleId: identifierSchema,
  name: z.string().min(1).max(500),
  kind: z.enum(["function", "class", "interface", "type", "variable", "method", "unknown"]),
  exported: z.boolean(),
  fragment: artifactFragmentSchema,
}).strict();

const analyzedEdgeSchema = z.object({
  localId: identifierSchema,
  kind: z.enum(["imports", "exports", "calls", "implements", "extends", "tests"]),
  sourceId: identifierSchema,
  target: z.object({
    localId: identifierSchema.nullable(),
    externalName: z.string().min(1).max(500).nullable(),
  }).strict(),
  fragment: artifactFragmentSchema,
}).strict();

const analyzedTestSchema = z.object({
  localId: identifierSchema,
  moduleId: identifierSchema,
  title: z.string().min(1).max(1_000),
  fragment: artifactFragmentSchema,
}).strict();

const languageAnalyzerOutputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  modules: z.array(analyzedModuleSchema).max(10_000),
  symbols: z.array(analyzedSymbolSchema).max(10_000),
  edges: z.array(analyzedEdgeSchema).max(10_000),
  tests: z.array(analyzedTestSchema).max(10_000),
  diagnostics: z.array(coverageDiagnosticSchema).max(1_000),
  coverage: coverageSummarySchema,
}).strict();

const inferenceProviderInputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  providerId: extensionIdSchema,
  purpose: inferencePurposeSchema,
  model: z.string().min(1).max(200),
  templateVersion: nameSchema,
  policyVersion: nameSchema,
  redactorVersions: z.array(nameSchema).min(1).max(128),
  credentialReference: z.string().min(1).max(500)
    .regex(/^(?:env|os-keychain|credential-store):[A-Za-z_][A-Za-z0-9_.:\-]{0,255}$/).nullable(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
  timeoutMs: z.number().int().min(1).max(MAX_EXTENSION_TIMEOUT_MS),
  segments: z.array(z.object({
    segmentId: identifierSchema,
    evidenceId: identifierSchema,
    text: z.string().max(MAX_TEXT_BYTES),
    textDigest: digestSchema,
  }).strict()).min(1).max(1_000),
  allowedEvidenceIds: z.array(identifierSchema).min(1).max(10_000),
  allowedSubjectIds: z.array(identifierSchema).min(1).max(10_000),
  allowedPredicates: z.array(predicateSchema).min(1).max(256),
  payloadDigest: digestSchema,
}).strict();

const inferenceProviderOutputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  modelVersion: z.string().min(1).max(200),
  candidates: z.array(z.object({
    candidateId: identifierSchema,
    subjectId: identifierSchema,
    predicate: predicateSchema,
    value: jsonValueSchema,
    supportingEvidenceIds: z.array(identifierSchema).min(1).max(256),
    contradictingEvidenceIds: z.array(identifierSchema).max(256),
    unknowns: z.array(z.string().min(1).max(2_000)).max(32),
    confidenceBasis: z.object({
      method: z.literal("model"),
      explanation: shortTextSchema,
    }).strict(),
  }).strict()).max(256),
  usage: z.object({
    inputTokens: safeIntegerSchema,
    outputTokens: safeIntegerSchema,
    totalTokens: safeIntegerSchema,
    costMicros: safeIntegerSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  }).strict(),
  finishReason: z.enum(["completed", "length", "cancelled", "filtered"]),
}).strict();

const redactorInputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  policyVersion: nameSchema,
  allowedCategories: z.array(nameSchema).min(1).max(128),
  maxSpans: z.number().int().min(1).max(4_096),
  items: z.array(z.object({
    itemId: identifierSchema,
    text: z.string().max(MAX_TEXT_BYTES),
    textDigest: digestSchema,
  }).strict()).min(1).max(4_096),
}).strict();

const redactorOutputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  items: z.array(z.object({
    itemId: identifierSchema,
    sourceDigest: digestSchema,
    action: z.enum(["allow", "redact", "block"]),
    spans: z.array(z.object({
      startByte: safeIntegerSchema,
      endByte: safeIntegerSchema,
      category: nameSchema,
      confidence: z.number().min(0).max(1),
      action: z.enum(["redact", "block"]),
    }).strict()).max(4_096),
  }).strict()).max(4_096),
}).strict();

const canonicalExportDtoSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  format: z.literal("context-atlas-canonical"),
  formatVersion: z.number().int().min(1).max(1_000_000),
  snapshot: z.object({
    repositoryId: identifierSchema,
    head: z.string().min(1).max(128).nullable(),
    knowledgeWatermark: z.string().min(1).max(256),
  }).strict(),
  payload: jsonValueSchema,
  contentDigest: digestSchema,
}).strict();

const exporterInputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  canonical: canonicalExportDtoSchema,
  requestedFormat: nameSchema,
  maxOutputBytes: z.number().int().min(1).max(MAX_EXPORT_OUTPUT_BYTES),
  options: z.record(z.string().min(1).max(128), jsonValueSchema),
}).strict();

const exporterOutputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  artifacts: z.array(z.object({
    fileName: z.string().min(1).max(255),
    mediaType: mediaTypeSchema,
    encoding: z.literal("base64"),
    bytesBase64: z.string().max(MAX_BASE64_CHARACTERS),
    byteLength: safeIntegerSchema,
    sha256: digestSchema,
  }).strict()).min(1).max(16),
  warnings: z.array(z.string().min(1).max(2_000)).max(128),
}).strict();

const validatorSubjectSchema = z.object({
  subjectId: identifierSchema,
  kind: nameSchema,
  payload: jsonValueSchema,
  evidenceIds: z.array(identifierSchema).max(1_000),
  digest: digestSchema,
}).strict();

const validatorInputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  policyVersion: nameSchema,
  scope: validationScopeSchema,
  maxFindings: z.number().int().min(1).max(1_000),
  allowedEvidenceIds: z.array(identifierSchema).max(10_000),
  subjects: z.array(validatorSubjectSchema).min(1).max(10_000),
}).strict();

const validatorOutputSchema = z.object({
  schemaVersion: z.literal(EXTENSION_SCHEMA_VERSION),
  findings: z.array(z.object({
    findingId: identifierSchema,
    ruleId: nameSchema,
    status: z.enum(["info", "warning", "critical"]),
    code: nameSchema,
    subjectIds: z.array(identifierSchema).min(1).max(1_000),
    evidenceIds: z.array(identifierSchema).max(1_000),
    message: shortTextSchema,
    recommendation: z.string().max(2_000),
  }).strict()).max(1_000),
}).strict();

export function parseExtensionManifest(value: unknown): ExtensionManifestV1 {
  const parsed = extensionManifestSchema.safeParse(value);
  if (!parsed.success) throw new ExtensionContractValidationError();
  const manifest = parsed.data as ExtensionManifestV1;
  validateManifestSemantics(manifest);
  return manifest;
}

export function parseExtensionInput<K extends ExtensionKind>(kind: K, value: unknown): ExtensionInputFor<K> {
  return parsePortValue(kind, value, "input") as ExtensionInputFor<K>;
}

export function parseExtensionOutput<K extends ExtensionKind>(kind: K, value: unknown): ExtensionOutputFor<K> {
  return parsePortValue(kind, value, "output") as ExtensionOutputFor<K>;
}

export function validateExtensionInputSemantics<K extends ExtensionKind>(
  kind: K,
  input: ExtensionInputFor<K>,
  manifest: ExtensionManifestFor<K>,
): void {
  switch (kind) {
    case "evidence-extractor":
      validateEvidenceExtractorInput(input as EvidenceExtractorInputV1, manifest as ExtensionManifestFor<"evidence-extractor">);
      break;
    case "language-analyzer":
      validateLanguageAnalyzerInput(input as LanguageAnalyzerInputV1, manifest as ExtensionManifestFor<"language-analyzer">);
      break;
    case "inference-provider":
      validateInferenceProviderInput(input as InferenceProviderInputV1, manifest as ExtensionManifestFor<"inference-provider">);
      break;
    case "redactor":
      validateRedactorInput(input as RedactorInputV1, manifest as ExtensionManifestFor<"redactor">);
      break;
    case "exporter":
      validateExporterInput(input as ExporterInputV1, manifest as ExtensionManifestFor<"exporter">);
      break;
    case "validator":
      validateValidatorInput(input as ValidatorInputV1, manifest as ExtensionManifestFor<"validator">);
      break;
  }
  assertSerializedWithin(input, MAX_EXTENSION_INPUT_SERIALIZED_BYTES);
}

export function validateExtensionOutputSemantics<K extends ExtensionKind>(
  kind: K,
  input: ExtensionInputFor<K>,
  output: ExtensionOutputFor<K>,
  manifest: ExtensionManifestFor<K>,
): void {
  switch (kind) {
    case "evidence-extractor":
      validateEvidenceExtractorOutput(
        input as EvidenceExtractorInputV1,
        output as EvidenceExtractorOutputV1,
        manifest as ExtensionManifestFor<"evidence-extractor">,
      );
      break;
    case "language-analyzer":
      validateLanguageAnalyzerOutput(
        input as LanguageAnalyzerInputV1,
        output as LanguageAnalyzerOutputV1,
        manifest as ExtensionManifestFor<"language-analyzer">,
      );
      break;
    case "inference-provider":
      validateInferenceProviderOutput(
        input as InferenceProviderInputV1,
        output as InferenceProviderOutputV1,
        manifest as ExtensionManifestFor<"inference-provider">,
      );
      break;
    case "redactor":
      validateRedactorOutput(
        input as RedactorInputV1,
        output as RedactorOutputV1,
        manifest as ExtensionManifestFor<"redactor">,
      );
      break;
    case "exporter":
      validateExporterOutput(
        input as ExporterInputV1,
        output as ExporterOutputV1,
        manifest as ExtensionManifestFor<"exporter">,
      );
      break;
    case "validator":
      validateValidatorOutput(
        input as ValidatorInputV1,
        output as ValidatorOutputV1,
        manifest as ExtensionManifestFor<"validator">,
      );
      break;
  }
  assertNoSecretShapedStructured(output);
  if (kind !== "exporter") assertSerializedWithin(output, MAX_EXTENSION_OUTPUT_SERIALIZED_BYTES);
}

export function computeProviderPayloadDigest(input: Omit<InferenceProviderInputV1, "payloadDigest">): string {
  return sha256(stableStringify(input));
}

export function computeCanonicalExportDigest(value: Omit<CanonicalExportDtoV1, "contentDigest">): string {
  return sha256(stableStringify(value));
}

export function computeValidatorSubjectDigest(value: Omit<ValidatorSubjectV1, "digest">): string {
  return sha256(stableStringify(value));
}

function parsePortValue(kind: ExtensionKind, value: unknown, phase: "input" | "output"): unknown {
  const schema = phase === "input"
    ? ({
        "evidence-extractor": evidenceExtractorInputSchema,
        "language-analyzer": languageAnalyzerInputSchema,
        "inference-provider": inferenceProviderInputSchema,
        redactor: redactorInputSchema,
        exporter: exporterInputSchema,
        validator: validatorInputSchema,
      } as const)[kind]
    : ({
        "evidence-extractor": evidenceExtractorOutputSchema,
        "language-analyzer": languageAnalyzerOutputSchema,
        "inference-provider": inferenceProviderOutputSchema,
        redactor: redactorOutputSchema,
        exporter: exporterOutputSchema,
        validator: validatorOutputSchema,
      } as const)[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ExtensionContractValidationError();
  assertJsonSafety(parsed.data);
  return parsed.data;
}

function validateManifestSemantics(manifest: ExtensionManifestV1): void {
  if (manifest.id.includes("..") || manifest.id.includes("//")) fail();
  assertNoSecretShapedStructured(manifest);
  switch (manifest.kind) {
    case "evidence-extractor":
      assertUnique(manifest.capabilities.artifactKinds);
      assertUnique(manifest.capabilities.mediaTypes);
      break;
    case "language-analyzer":
      assertUnique(manifest.capabilities.languages);
      assertUnique(manifest.capabilities.mediaTypes);
      break;
    case "inference-provider":
      assertUnique(manifest.capabilities.purposes);
      assertUnique(manifest.capabilities.models);
      break;
    case "redactor":
      assertUnique(manifest.capabilities.categories);
      assertUnique(manifest.capabilities.actions);
      break;
    case "exporter":
      assertUnique(manifest.capabilities.formats);
      assertUnique(manifest.capabilities.mediaTypes);
      break;
    case "validator":
      assertUnique(manifest.capabilities.scopes);
      assertUnique(manifest.capabilities.ruleIds);
      break;
  }
}

function validateEvidenceExtractorInput(input: EvidenceExtractorInputV1, manifest: ExtensionManifestFor<"evidence-extractor">): void {
  validateApprovedArtifact(input.artifact, manifest.capabilities.maxArtifactBytes);
  if (!manifest.capabilities.artifactKinds.includes(input.artifact.kind)
    || !manifest.capabilities.mediaTypes.includes(input.artifact.mediaType)
    || input.policy.maxObservations > manifest.capabilities.maxObservations) fail();
  assertUnique(input.policy.allowedEntityTypes);
  assertUnique(input.policy.allowedPredicates);
}

function validateEvidenceExtractorOutput(
  input: EvidenceExtractorInputV1,
  output: EvidenceExtractorOutputV1,
  manifest: ExtensionManifestFor<"evidence-extractor">,
): void {
  const artifactBytes = decodeCanonicalBase64(input.artifact.bytesBase64);
  const maximum = Math.min(input.policy.maxObservations, manifest.capabilities.maxObservations);
  if (output.observations.length > maximum) fail();
  assertUnique(output.observations.map((item) => item.observationId));
  assertUnique(output.observations.map((item) => item.claimKey));
  for (const observation of output.observations) {
    if (!input.policy.allowedEntityTypes.includes(observation.subject.entityType)
      || !input.policy.allowedPredicates.includes(observation.predicate)) fail();
    validateFragment(observation.fragment, input.artifact, artifactBytes);
    if (!observation.dependencies.some((dependency) =>
      dependency.kind === "artifact"
      && dependency.id === input.artifact.artifactId
      && dependency.digest === input.artifact.sha256)) fail();
    assertUnique(observation.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}`));
    assertJsonSafety(observation.value);
  }
  validateDiagnostics(output.diagnostics, input.artifact, artifactBytes);
  validateCoverage(output.coverage, input.artifact.byteLength);
}

function validateLanguageAnalyzerInput(input: LanguageAnalyzerInputV1, manifest: ExtensionManifestFor<"language-analyzer">): void {
  validateApprovedArtifact(input.artifact, manifest.capabilities.maxArtifactBytes);
  if (!manifest.capabilities.languages.includes(input.language)
    || !manifest.capabilities.mediaTypes.includes(input.artifact.mediaType)
    || input.policy.maxStructures > manifest.capabilities.maxStructures) fail();
}

function validateLanguageAnalyzerOutput(
  input: LanguageAnalyzerInputV1,
  output: LanguageAnalyzerOutputV1,
  manifest: ExtensionManifestFor<"language-analyzer">,
): void {
  const artifactBytes = decodeCanonicalBase64(input.artifact.bytesBase64);
  const total = output.modules.length + output.symbols.length + output.edges.length + output.tests.length;
  if (total > Math.min(input.policy.maxStructures, manifest.capabilities.maxStructures)) fail();
  const structuralIds = [...output.modules, ...output.symbols, ...output.tests].map((item) => item.localId);
  assertUnique(structuralIds);
  const knownIds = new Set(structuralIds);
  const moduleIds = new Set(output.modules.map((item) => item.localId));
  for (const module of output.modules) validateFragment(module.fragment, input.artifact, artifactBytes);
  for (const symbol of output.symbols) {
    if (!moduleIds.has(symbol.moduleId)) fail();
    validateFragment(symbol.fragment, input.artifact, artifactBytes);
  }
  assertUnique(output.edges.map((item) => item.localId));
  for (const edge of output.edges) {
    if (!knownIds.has(edge.sourceId)) fail();
    if ((edge.target.localId === null) === (edge.target.externalName === null)) fail();
    if (edge.target.localId !== null && !knownIds.has(edge.target.localId)) fail();
    validateFragment(edge.fragment, input.artifact, artifactBytes);
  }
  for (const test of output.tests) {
    if (!moduleIds.has(test.moduleId)) fail();
    validateFragment(test.fragment, input.artifact, artifactBytes);
  }
  validateDiagnostics(output.diagnostics, input.artifact, artifactBytes);
  validateCoverage(output.coverage, input.artifact.byteLength);
}

function validateInferenceProviderInput(
  input: InferenceProviderInputV1,
  manifest: ExtensionManifestFor<"inference-provider">,
): void {
  if (input.providerId !== manifest.id
    || !manifest.capabilities.purposes.includes(input.purpose)
    || !manifest.capabilities.models.includes(input.model)
    || input.maxOutputTokens > manifest.capabilities.maxOutputTokens) fail();
  assertUnique(input.redactorVersions);
  assertUnique(input.allowedEvidenceIds);
  assertUnique(input.allowedSubjectIds);
  assertUnique(input.allowedPredicates);
  assertUnique(input.segments.map((item) => item.segmentId));
  for (const predicate of input.allowedPredicates) assertProviderPredicateIsNotReserved(predicate);
  if (input.credentialReference !== null) assertNoSecretShapedText(input.credentialReference);
  const allowed = new Set(input.allowedEvidenceIds);
  const suppliedEvidence = new Set(input.segments.map((segment) => segment.evidenceId));
  if (allowed.size !== suppliedEvidence.size || [...allowed].some((evidenceId) => !suppliedEvidence.has(evidenceId))) fail();
  for (const segment of input.segments) {
    if (!allowed.has(segment.evidenceId) || sha256(segment.text) !== segment.textDigest) fail();
    assertNoSecretShapedText(segment.text);
  }
  const { payloadDigest: _payloadDigest, ...material } = input;
  if (computeProviderPayloadDigest(material) !== input.payloadDigest) fail();
}

function validateInferenceProviderOutput(
  input: InferenceProviderInputV1,
  output: InferenceProviderOutputV1,
  manifest: ExtensionManifestFor<"inference-provider">,
): void {
  if (output.modelVersion !== input.model
    || output.candidates.length > manifest.capabilities.maxCandidates
    || output.usage.outputTokens > input.maxOutputTokens
    || output.usage.totalTokens !== output.usage.inputTokens + output.usage.outputTokens
    || ((output.usage.costMicros === null) !== (output.usage.currency === null))) fail();
  assertUnique(output.candidates.map((item) => item.candidateId));
  const allowed = new Set(input.allowedEvidenceIds);
  const allowedSubjects = new Set(input.allowedSubjectIds);
  const allowedPredicates = new Set(input.allowedPredicates);
  for (const candidate of output.candidates) {
    assertUnique(candidate.supportingEvidenceIds);
    assertUnique(candidate.contradictingEvidenceIds);
    const support = new Set(candidate.supportingEvidenceIds);
    if (!allowedSubjects.has(candidate.subjectId) || !allowedPredicates.has(candidate.predicate)
      || candidate.contradictingEvidenceIds.some((evidenceId) => support.has(evidenceId))
      || [...candidate.supportingEvidenceIds, ...candidate.contradictingEvidenceIds]
        .some((evidenceId) => !allowed.has(evidenceId))) fail();
    assertProviderPredicateIsNotReserved(candidate.predicate);
    assertNoAuthorityKeys(candidate.value);
  }
}

function validateRedactorInput(input: RedactorInputV1, manifest: ExtensionManifestFor<"redactor">): void {
  if (input.items.length > manifest.capabilities.maxItems
    || input.maxSpans > manifest.capabilities.maxSpans
    || input.allowedCategories.some((category) => !manifest.capabilities.categories.includes(category))) fail();
  assertUnique(input.allowedCategories);
  assertUnique(input.items.map((item) => item.itemId));
  for (const item of input.items) if (sha256(item.text) !== item.textDigest) fail();
}

function validateRedactorOutput(
  input: RedactorInputV1,
  output: RedactorOutputV1,
  manifest: ExtensionManifestFor<"redactor">,
): void {
  if (output.items.length !== input.items.length) fail();
  assertUnique(output.items.map((item) => item.itemId));
  const inputById = new Map(input.items.map((item) => [item.itemId, item]));
  let spanCount = 0;
  for (const item of output.items) {
    const source = inputById.get(item.itemId);
    if (!source || item.sourceDigest !== source.textDigest) fail();
    const bytes = Buffer.byteLength(source.text, "utf8");
    const sourceBytes = Buffer.from(source.text, "utf8");
    let previousEnd = -1;
    for (const span of item.spans) {
      spanCount += 1;
      if (span.startByte < previousEnd || span.endByte <= span.startByte || span.endByte > bytes
        || !isUtf8CodePointBoundary(sourceBytes, span.startByte)
        || !isUtf8CodePointBoundary(sourceBytes, span.endByte)
        || !input.allowedCategories.includes(span.category)
        || !manifest.capabilities.categories.includes(span.category)
        || !manifest.capabilities.actions.includes(span.action)) fail();
      previousEnd = span.endByte;
    }
    const expectedAction = item.spans.some((span) => span.action === "block")
      ? "block"
      : item.spans.length > 0 ? "redact" : "allow";
    if (item.action !== expectedAction) fail();
  }
  if (spanCount > Math.min(input.maxSpans, manifest.capabilities.maxSpans)) fail();
}

function validateExporterInput(input: ExporterInputV1, manifest: ExtensionManifestFor<"exporter">): void {
  if (!manifest.capabilities.formats.includes(input.requestedFormat)
    || input.maxOutputBytes > manifest.capabilities.maxTotalBytes) fail();
  const { contentDigest: _contentDigest, ...material } = input.canonical;
  if (computeCanonicalExportDigest(material) !== input.canonical.contentDigest) fail();
  assertJsonSafety(input.canonical.payload);
  assertJsonSafety(input.options);
}

function validateExporterOutput(
  input: ExporterInputV1,
  output: ExporterOutputV1,
  manifest: ExtensionManifestFor<"exporter">,
): void {
  if (output.artifacts.length > manifest.capabilities.maxArtifacts) fail();
  assertUnique(output.artifacts.map((item) => portableFileNameKey(item.fileName)));
  let totalBytes = 0;
  for (const artifact of output.artifacts) {
    if (!isSafeFileName(artifact.fileName) || !manifest.capabilities.mediaTypes.includes(artifact.mediaType)) fail();
    const bytes = decodeCanonicalBase64(artifact.bytesBase64);
    if (bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.sha256) fail();
    if (isTextualMediaType(artifact.mediaType)) assertNoSecretShapedText(decodeCanonicalUtf8Text(bytes));
    else assertNoSecretShapedText(bytes.toString("utf8"));
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > input.maxOutputBytes || totalBytes > manifest.capabilities.maxTotalBytes || totalBytes > MAX_EXPORT_OUTPUT_BYTES) fail();
}

function validateValidatorInput(input: ValidatorInputV1, manifest: ExtensionManifestFor<"validator">): void {
  if (!manifest.capabilities.scopes.includes(input.scope)
    || input.maxFindings > manifest.capabilities.maxFindings) fail();
  assertUnique(input.allowedEvidenceIds);
  assertUnique(input.subjects.map((item) => item.subjectId));
  const allowedEvidence = new Set(input.allowedEvidenceIds);
  for (const subject of input.subjects) {
    assertUnique(subject.evidenceIds);
    if (subject.evidenceIds.some((evidenceId) => !allowedEvidence.has(evidenceId))) fail();
    const { digest: _digest, ...material } = subject;
    if (computeValidatorSubjectDigest(material) !== subject.digest) fail();
  }
}

function validateValidatorOutput(
  input: ValidatorInputV1,
  output: ValidatorOutputV1,
  manifest: ExtensionManifestFor<"validator">,
): void {
  if (output.findings.length > Math.min(input.maxFindings, manifest.capabilities.maxFindings)) fail();
  assertUnique(output.findings.map((item) => item.findingId));
  const subjects = new Set(input.subjects.map((item) => item.subjectId));
  const evidence = new Set(input.allowedEvidenceIds);
  for (const finding of output.findings) {
    if (!manifest.capabilities.ruleIds.includes(finding.ruleId)
      || finding.subjectIds.some((id) => !subjects.has(id))
      || finding.evidenceIds.some((id) => !evidence.has(id))) fail();
    assertUnique(finding.subjectIds);
    assertUnique(finding.evidenceIds);
  }
}

function validateApprovedArtifact(artifact: ApprovedArtifactV1, maximumBytes: number): void {
  if (!isSafeRelativePath(artifact.relativePath) || !Number.isFinite(Date.parse(artifact.observedAt))) fail();
  const bytes = decodeCanonicalBase64(artifact.bytesBase64);
  if (bytes.byteLength !== artifact.byteLength || bytes.byteLength > maximumBytes || sha256(bytes) !== artifact.sha256) fail();
  if (isTextualMediaType(artifact.mediaType)) decodeCanonicalUtf8Text(bytes);
}

function validateFragment(fragment: ArtifactFragmentV1, artifact: ApprovedArtifactV1, bytes: Buffer): void {
  const requiresUtf8Boundary = isTextualMediaType(artifact.mediaType);
  if (fragment.artifactId !== artifact.artifactId
    || fragment.endByte <= fragment.startByte
    || fragment.endByte > artifact.byteLength
    || (requiresUtf8Boundary && !isUtf8CodePointBoundary(bytes, fragment.startByte))
    || (requiresUtf8Boundary && !isUtf8CodePointBoundary(bytes, fragment.endByte))) fail();
}

function validateDiagnostics(
  diagnostics: Array<{ fragment: ArtifactFragmentV1 | null }>,
  artifact: ApprovedArtifactV1,
  bytes: Buffer,
): void {
  for (const diagnostic of diagnostics) if (diagnostic.fragment) validateFragment(diagnostic.fragment, artifact, bytes);
}

function validateCoverage(coverage: { bytesExamined: number; bytesCovered: number; complete: boolean }, totalBytes: number): void {
  if (coverage.bytesExamined > totalBytes || coverage.bytesCovered > coverage.bytesExamined
    || (coverage.complete && coverage.bytesExamined !== totalBytes)) fail();
}

function assertNoAuthorityKeys(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoAuthorityKeys(item);
    return;
  }
  if (typeof value === "string") {
    if (isReservedAuthorityToken(value)) fail();
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (isReservedAuthorityToken(key)) fail();
    assertNoAuthorityKeys(child);
  }
}

function assertJsonSafety(value: unknown): void {
  let nodes = 0;
  const visit = (child: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail();
    if (child === null || typeof child === "string" || typeof child === "boolean") return;
    if (typeof child === "number") {
      if (!Number.isFinite(child)) fail();
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) visit(item, depth + 1);
      return;
    }
    if (!child || typeof child !== "object") fail();
    for (const [key, item] of Object.entries(child)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail();
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function assertSerializedWithin(value: unknown, maximumBytes: number): void {
  if (Buffer.byteLength(stableStringify(value), "utf8") > maximumBytes) fail();
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail();
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value === "") return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail();
  return bytes;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/")
    || /^[A-Za-z]:/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.split("/").includes("..");
}

function isSafeFileName(value: string): boolean {
  if (!isWellFormedUnicode(value) || Buffer.byteLength(value, "utf8") > 255
    || value !== value.normalize("NFC") || value === "." || value === ".."
    || /[ .]$/.test(value) || /\p{Cf}/u.test(value)
    || /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/u.test(value) || path.basename(value) !== value) return false;
  const folded = value.toLocaleLowerCase("en-US");
  return !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3])(?:\.|$)/u.test(folded);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function portableFileNameKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US").normalize("NFC");
}

function isUtf8CodePointBoundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.byteLength || (offset > 0 && offset < bytes.byteLength
    && ((bytes[offset] ?? 0) & 0xc0) !== 0x80);
}

function normalizeAuthorityToken(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function isReservedAuthorityToken(value: string): boolean {
  const normalized = normalizeAuthorityToken(value);
  return RESERVED_AUTHORITY_TOKENS.has(normalized)
    || /^(?:is)?(?:acceptance|accepted|approval|approved|authority|lifecycle|review|reviewed|reviewer)(?:by|id|level|state|status)?$/.test(normalized);
}

function assertProviderPredicateIsNotReserved(predicate: string): void {
  for (const part of predicate.split(/[.:-]/)) {
    if (isReservedAuthorityToken(part)) fail();
  }
}

function isTextualMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLocaleLowerCase("en-US");
  return normalized.startsWith("text/") || normalized === "application/json" || normalized.endsWith("+json")
    || normalized === "application/javascript" || normalized === "application/x-javascript"
    || normalized === "application/xml" || normalized.endsWith("+xml")
    || normalized === "application/yaml" || normalized === "application/x-yaml";
}

function decodeCanonicalUtf8Text(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) fail();
  return text;
}

function assertNoSecretShapedStructured(value: unknown): void {
  assertNoSecretShapedText(stableStringify(value));
}

function assertNoSecretShapedText(value: string): void {
  if (findSecrets(value).length > 0) fail();
}

function fail(): never {
  throw new ExtensionContractValidationError();
}
