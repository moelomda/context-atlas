export const EXTENSION_API_VERSION = 1 as const;
export const EXTENSION_SCHEMA_VERSION = 1 as const;

export type ExtensionKind = "evidence-extractor" | "language-analyzer" | "inference-provider" | "redactor" | "exporter" | "validator";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ApprovedArtifactKind = "source" | "document" | "manifest" | "test" | "configuration" | "other";
export type InferencePurpose = "component-purpose" | "semantic-event-grouping" | "change-impact" | "missing-context";
export type ValidationScope = "evidence" | "entity" | "relationship" | "assertion" | "pack" | "export" | "provider-request";

export interface EvidenceExtractorCapabilitiesV1 {
  artifactKinds: ApprovedArtifactKind[];
  mediaTypes: string[];
  maxArtifactBytes: number;
  maxObservations: number;
}

export interface LanguageAnalyzerCapabilitiesV1 {
  languages: string[];
  mediaTypes: string[];
  maxArtifactBytes: number;
  maxStructures: number;
}

export interface InferenceProviderCapabilitiesV1 {
  purposes: InferencePurpose[];
  models: string[];
  maxCandidates: number;
  maxOutputTokens: number;
}

export interface RedactorCapabilitiesV1 {
  categories: string[];
  actions: Array<"redact" | "block">;
  maxItems: number;
  maxSpans: number;
}

export interface ExporterCapabilitiesV1 {
  formats: string[];
  mediaTypes: string[];
  maxArtifacts: number;
  maxTotalBytes: number;
}

export interface ValidatorCapabilitiesV1 {
  scopes: ValidationScope[];
  ruleIds: string[];
  maxFindings: number;
}

export interface ExtensionCapabilitiesByKind {
  "evidence-extractor": EvidenceExtractorCapabilitiesV1;
  "language-analyzer": LanguageAnalyzerCapabilitiesV1;
  "inference-provider": InferenceProviderCapabilitiesV1;
  redactor: RedactorCapabilitiesV1;
  exporter: ExporterCapabilitiesV1;
  validator: ValidatorCapabilitiesV1;
}

export interface ExtensionManifestBaseV1<K extends ExtensionKind> {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  extensionApiVersion: typeof EXTENSION_API_VERSION;
  id: string;
  version: string;
  kind: K;
  displayName: string;
  description: string;
  deterministic: boolean;
  inputSchemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  outputSchemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  capabilities: ExtensionCapabilitiesByKind[K];
}

export type EvidenceExtractorManifestV1 = ExtensionManifestBaseV1<"evidence-extractor">;
export type LanguageAnalyzerManifestV1 = ExtensionManifestBaseV1<"language-analyzer">;
export type InferenceProviderManifestV1 = ExtensionManifestBaseV1<"inference-provider">;
export type RedactorManifestV1 = ExtensionManifestBaseV1<"redactor">;
export type ExporterManifestV1 = ExtensionManifestBaseV1<"exporter">;
export type ValidatorManifestV1 = ExtensionManifestBaseV1<"validator">;

export type ExtensionManifestV1 =
  | EvidenceExtractorManifestV1
  | LanguageAnalyzerManifestV1
  | InferenceProviderManifestV1
  | RedactorManifestV1
  | ExporterManifestV1
  | ValidatorManifestV1;

export interface ApprovedArtifactV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  artifactId: string;
  kind: ApprovedArtifactKind;
  relativePath: string;
  mediaType: string;
  bytesBase64: string;
  byteLength: number;
  sha256: string;
  observedAt: string;
}

export interface ArtifactFragmentV1 {
  artifactId: string;
  startByte: number;
  endByte: number;
}

export interface CoverageDiagnosticV1 {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  coverageGap: boolean;
  fragment: ArtifactFragmentV1 | null;
}

export interface CoverageSummaryV1 {
  bytesExamined: number;
  bytesCovered: number;
  complete: boolean;
}

export interface EvidenceExtractorInputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  artifact: ApprovedArtifactV1;
  policy: {
    schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
    policyVersion: string;
    allowedEntityTypes: string[];
    allowedPredicates: string[];
    maxObservations: number;
  };
}

export interface ExtractedObservationV1 {
  observationId: string;
  claimKey: string;
  subject: {
    localKey: string;
    entityType: string;
    title: string;
  };
  predicate: string;
  value: JsonValue;
  fragment: ArtifactFragmentV1;
  dependencies: Array<{
    kind: "artifact" | "policy" | "extension";
    id: string;
    digest: string;
  }>;
  confidence: {
    method: "deterministic" | "heuristic";
    score: number | null;
    explanation: string;
  };
}

export interface EvidenceExtractorOutputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  observations: ExtractedObservationV1[];
  diagnostics: CoverageDiagnosticV1[];
  coverage: CoverageSummaryV1;
}

export interface LanguageAnalyzerInputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  artifact: ApprovedArtifactV1;
  language: string;
  policy: {
    schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
    policyVersion: string;
    maxStructures: number;
  };
}

export interface AnalyzedModuleV1 {
  localId: string;
  name: string;
  fragment: ArtifactFragmentV1;
}

export interface AnalyzedSymbolV1 {
  localId: string;
  moduleId: string;
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method" | "unknown";
  exported: boolean;
  fragment: ArtifactFragmentV1;
}

export interface AnalyzedEdgeV1 {
  localId: string;
  kind: "imports" | "exports" | "calls" | "implements" | "extends" | "tests";
  sourceId: string;
  target: {
    localId: string | null;
    externalName: string | null;
  };
  fragment: ArtifactFragmentV1;
}

export interface AnalyzedTestV1 {
  localId: string;
  moduleId: string;
  title: string;
  fragment: ArtifactFragmentV1;
}

export interface LanguageAnalyzerOutputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  modules: AnalyzedModuleV1[];
  symbols: AnalyzedSymbolV1[];
  edges: AnalyzedEdgeV1[];
  tests: AnalyzedTestV1[];
  diagnostics: CoverageDiagnosticV1[];
  coverage: CoverageSummaryV1;
}

export interface InferenceProviderSegmentV1 {
  segmentId: string;
  evidenceId: string;
  text: string;
  textDigest: string;
}

export interface InferenceProviderInputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  providerId: string;
  purpose: InferencePurpose;
  model: string;
  templateVersion: string;
  policyVersion: string;
  redactorVersions: string[];
  credentialReference: string | null;
  maxOutputTokens: number;
  timeoutMs: number;
  segments: InferenceProviderSegmentV1[];
  allowedEvidenceIds: string[];
  allowedSubjectIds: string[];
  allowedPredicates: string[];
  payloadDigest: string;
}

export interface InferenceCandidateV1 {
  candidateId: string;
  subjectId: string;
  predicate: string;
  value: JsonValue;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  unknowns: string[];
  confidenceBasis: {
    method: "model";
    explanation: string;
  };
}

export interface InferenceProviderOutputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  modelVersion: string;
  candidates: InferenceCandidateV1[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costMicros: number | null;
    currency: string | null;
  };
  finishReason: "completed" | "length" | "cancelled" | "filtered";
}

export interface RedactorInputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  policyVersion: string;
  allowedCategories: string[];
  maxSpans: number;
  items: Array<{
    itemId: string;
    text: string;
    textDigest: string;
  }>;
}

export interface RedactionSpanV1 {
  startByte: number;
  endByte: number;
  category: string;
  confidence: number;
  action: "redact" | "block";
}

export interface RedactorOutputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  items: Array<{
    itemId: string;
    sourceDigest: string;
    action: "allow" | "redact" | "block";
    spans: RedactionSpanV1[];
  }>;
}

export interface CanonicalExportDtoV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  format: "context-atlas-canonical";
  formatVersion: number;
  snapshot: {
    repositoryId: string;
    head: string | null;
    knowledgeWatermark: string;
  };
  payload: JsonValue;
  contentDigest: string;
}

export interface ExporterInputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  canonical: CanonicalExportDtoV1;
  requestedFormat: string;
  maxOutputBytes: number;
  options: { [key: string]: JsonValue };
}

export interface ExporterOutputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  artifacts: Array<{
    fileName: string;
    mediaType: string;
    encoding: "base64";
    bytesBase64: string;
    byteLength: number;
    sha256: string;
  }>;
  warnings: string[];
}

export interface ValidatorSubjectV1 {
  subjectId: string;
  kind: string;
  payload: JsonValue;
  evidenceIds: string[];
  digest: string;
}

export interface ValidatorInputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  policyVersion: string;
  scope: ValidationScope;
  maxFindings: number;
  allowedEvidenceIds: string[];
  subjects: ValidatorSubjectV1[];
}

export interface ValidatorFindingV1 {
  findingId: string;
  ruleId: string;
  status: "info" | "warning" | "critical";
  code: string;
  subjectIds: string[];
  evidenceIds: string[];
  message: string;
  recommendation: string;
}

export interface ValidatorOutputV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  findings: ValidatorFindingV1[];
}

export interface ExtensionPortContractMap {
  "evidence-extractor": {
    manifest: EvidenceExtractorManifestV1;
    input: EvidenceExtractorInputV1;
    output: EvidenceExtractorOutputV1;
  };
  "language-analyzer": {
    manifest: LanguageAnalyzerManifestV1;
    input: LanguageAnalyzerInputV1;
    output: LanguageAnalyzerOutputV1;
  };
  "inference-provider": {
    manifest: InferenceProviderManifestV1;
    input: InferenceProviderInputV1;
    output: InferenceProviderOutputV1;
  };
  redactor: {
    manifest: RedactorManifestV1;
    input: RedactorInputV1;
    output: RedactorOutputV1;
  };
  exporter: {
    manifest: ExporterManifestV1;
    input: ExporterInputV1;
    output: ExporterOutputV1;
  };
  validator: {
    manifest: ValidatorManifestV1;
    input: ValidatorInputV1;
    output: ValidatorOutputV1;
  };
}

export type ExtensionManifestFor<K extends ExtensionKind> = ExtensionPortContractMap[K]["manifest"];
export type ExtensionInputFor<K extends ExtensionKind> = ExtensionPortContractMap[K]["input"];
export type ExtensionOutputFor<K extends ExtensionKind> = ExtensionPortContractMap[K]["output"];

export interface ExtensionRunContext {
  signal: AbortSignal;
}

export interface ExtensionAdapterV1<K extends ExtensionKind> {
  manifest: ExtensionManifestFor<K>;
  run(input: Readonly<ExtensionInputFor<K>>, context: ExtensionRunContext): unknown | Promise<unknown>;
}

export type AnyExtensionAdapterV1 = {
  [K in ExtensionKind]: ExtensionAdapterV1<K>;
}[ExtensionKind];

export interface ExtensionModuleV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  extensions: readonly AnyExtensionAdapterV1[];
}

export interface RegisteredExtensionDescriptorV1 {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  extensionRef: string;
  manifestDigest: string;
  executionTrust: "in-process-trusted-code";
  quarantined: boolean;
  manifest: ExtensionManifestV1;
}

export interface ExtensionRunEnvelopeV1<O> {
  schemaVersion: typeof EXTENSION_SCHEMA_VERSION;
  kind: ExtensionKind;
  producer: {
    id: string;
    version: string;
    manifestDigest: string;
  };
  inputDigest: string;
  outputDigest: string;
  output: O;
}

export interface ExtensionRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ExtensionErrorCode =
  | "invalid_manifest"
  | "duplicate_extension"
  | "extension_not_found"
  | "extension_quarantined"
  | "invalid_input"
  | "invalid_output"
  | "invalid_options"
  | "execution_failed"
  | "execution_timeout"
  | "execution_cancelled";

export function defineExtension<K extends ExtensionKind>(extension: ExtensionAdapterV1<K>): ExtensionAdapterV1<K> {
  return extension;
}

export function defineExtensionModule(module: ExtensionModuleV1): ExtensionModuleV1 {
  return module;
}
