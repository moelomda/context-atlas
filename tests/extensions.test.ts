import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sha256 } from "../src/core/util.js";
import {
  EXTENSION_SCHEMA_VERSION,
  ExtensionRegistry,
  ExtensionRegistryError,
  computeCanonicalExportDigest,
  computeProviderPayloadDigest,
  computeValidatorSubjectDigest,
  defineExtension,
  defineExtensionModule,
  extensionRefFor,
  type ApprovedArtifactV1,
  type EvidenceExtractorInputV1,
  type EvidenceExtractorOutputV1,
  type ExporterInputV1,
  type ExporterOutputV1,
  type ExtensionAdapterV1,
  type ExtensionErrorCode,
  type InferenceProviderInputV1,
  type InferenceProviderOutputV1,
  type LanguageAnalyzerInputV1,
  type LanguageAnalyzerOutputV1,
  type RedactorInputV1,
  type RedactorOutputV1,
  type ValidatorInputV1,
  type ValidatorOutputV1,
  type ValidatorSubjectV1,
} from "../src/extensions/index.js";

const observedAt = "2026-08-21T00:00:00.000Z";
let extractorSawFrozenInput = false;
let extractorContextKeys: string[] = [];

const extractorAdapter: ExtensionAdapterV1<"evidence-extractor"> = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "test.manifest-extractor",
    version: "1.2.3",
    kind: "evidence-extractor",
    displayName: "Manifest extractor",
    description: "Extracts a package identity from policy-approved JSON bytes.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      artifactKinds: ["manifest"],
      mediaTypes: ["application/json"],
      maxArtifactBytes: 64 * 1024,
      maxObservations: 20,
    },
  },
  run(input, context) {
    extractorSawFrozenInput = Object.isFrozen(input) && Object.isFrozen(input.policy) && Object.isFrozen(input.artifact);
    extractorContextKeys = Object.keys(context).sort();
    assert.equal(Object.isFrozen(context), true);
    return validExtractorOutput(input);
  },
});

const analyzerAdapter: ExtensionAdapterV1<"language-analyzer"> = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "test.typescript-analyzer",
    version: "2.0.0-beta.1",
    kind: "language-analyzer",
    displayName: "TypeScript analyzer",
    description: "Finds an exported function in approved TypeScript source.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      languages: ["typescript"],
      mediaTypes: ["text/typescript"],
      maxArtifactBytes: 64 * 1024,
      maxStructures: 100,
    },
  },
  run: (input) => validAnalyzerOutput(input),
});

const providerAdapter: ExtensionAdapterV1<"inference-provider"> = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "test.mock-provider",
    version: "1.0.0",
    kind: "inference-provider",
    displayName: "Deterministic mock provider",
    description: "Returns one cited candidate from an already-approved payload.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      purposes: ["component-purpose"],
      models: ["mock-v1"],
      maxCandidates: 4,
      maxOutputTokens: 512,
    },
  },
  run: (input) => validProviderOutput(input),
});

const redactorAdapter: ExtensionAdapterV1<"redactor"> = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "test.credential-redactor",
    version: "1.0.0+fixture",
    kind: "redactor",
    displayName: "Credential redactor",
    description: "Marks a synthetic credential span for core-owned replacement.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      categories: ["credential"],
      actions: ["redact", "block"],
      maxItems: 8,
      maxSpans: 16,
    },
  },
  run: (input) => validRedactorOutput(input),
});

const exporterAdapter: ExtensionAdapterV1<"exporter"> = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "test.markdown-exporter",
    version: "1.0.0",
    kind: "exporter",
    displayName: "JSON exporter",
    description: "Serializes a canonical DTO without receiving a destination path.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      formats: ["canonical-json"],
      mediaTypes: ["application/json"],
      maxArtifacts: 2,
      maxTotalBytes: 1024 * 1024,
    },
  },
  run: (input) => validExporterOutput(input),
});

const validatorAdapter: ExtensionAdapterV1<"validator"> = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "test.summary-validator",
    version: "1.0.0",
    kind: "validator",
    displayName: "Summary validator",
    description: "Reports an empty summary without receiving a mutable database handle.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      scopes: ["entity"],
      ruleIds: ["summary-required"],
      maxFindings: 10,
    },
  },
  run: (input) => validValidatorOutput(input),
});

const allExtensions = [
  extractorAdapter,
  analyzerAdapter,
  providerAdapter,
  redactorAdapter,
  exporterAdapter,
  validatorAdapter,
] as const;

test("all six extension ports execute through immutable, versioned, provenance-bearing contracts", async () => {
  const registry = new ExtensionRegistry();
  const descriptors = registry.registerModule(defineExtensionModule({
    schemaVersion: EXTENSION_SCHEMA_VERSION,
    extensions: allExtensions,
  }));
  assert.equal(descriptors.length, 6);
  assert.equal(registry.list().length, 6);
  assert.ok(registry.list().every((item) => item.executionTrust === "in-process-trusted-code" && !item.quarantined));
  assert.match(registry.fingerprint(), /^[a-f0-9]{64}$/);

  const extractorInput = makeExtractorInput();
  const firstExtraction = await registry.runEvidenceExtractor(extractorAdapter.manifest.id, extractorInput);
  const repeatedExtraction = await registry.runEvidenceExtractor(extractorAdapter.manifest.id, extractorInput);
  assert.equal(extractorSawFrozenInput, true);
  assert.deepEqual(extractorContextKeys, ["signal"]);
  assert.equal(firstExtraction.output.observations[0]?.value, "fixture-shop");
  assert.equal(firstExtraction.outputDigest, repeatedExtraction.outputDigest);
  assert.match(firstExtraction.inputDigest, /^[a-f0-9]{64}$/);
  assert.equal(firstExtraction.producer.version, extractorAdapter.manifest.version);
  assert.equal(Object.isFrozen(firstExtraction), true);
  assert.equal(Object.isFrozen(firstExtraction.output), true);

  const analyzed = await registry.runLanguageAnalyzer(analyzerAdapter.manifest.id, makeAnalyzerInput());
  assert.equal(analyzed.output.symbols[0]?.name, "charge");
  assert.equal(analyzed.output.edges[0]?.kind, "exports");

  const inferred = await registry.runInferenceProvider(providerAdapter.manifest.id, makeProviderInput());
  assert.deepEqual(inferred.output.candidates[0]?.supportingEvidenceIds, ["evidence_readme"]);
  assert.equal(inferred.output.candidates[0]?.confidenceBasis.method, "model");

  const redacted = await registry.runRedactor(redactorAdapter.manifest.id, makeRedactorInput());
  assert.equal(redacted.output.items[0]?.action, "redact");
  assert.equal(redacted.output.items[0]?.spans[0]?.category, "credential");

  const exported = await registry.runExporter(exporterAdapter.manifest.id, makeExporterInput());
  assert.equal(exported.output.artifacts[0]?.fileName, "context-atlas.json");
  assert.deepEqual(
    JSON.parse(Buffer.from(exported.output.artifacts[0]?.bytesBase64 ?? "", "base64").toString("utf8")),
    { project: "fixture-shop" },
  );

  const validated = await registry.runValidator(validatorAdapter.manifest.id, makeValidatorInput());
  assert.equal(validated.output.findings[0]?.ruleId, "summary-required");
  assert.equal(validated.output.findings[0]?.status, "critical");
});

test("registration order does not change the fingerprint and quarantine is exact and visible", async () => {
  const forward = new ExtensionRegistry();
  for (const extension of allExtensions) forward.register(extension);
  const reverse = new ExtensionRegistry();
  for (const extension of [...allExtensions].reverse()) reverse.register(extension);
  assert.equal(forward.fingerprint(), reverse.fingerprint());
  assert.deepEqual(
    forward.list().map((item) => item.extensionRef),
    reverse.list().map((item) => item.extensionRef),
  );

  const reference = extensionRefFor(extractorAdapter.manifest);
  forward.quarantine(reference);
  assert.notEqual(forward.fingerprint(), reverse.fingerprint());
  assert.equal(forward.list("evidence-extractor")[0]?.quarantined, true);
  await assert.rejects(
    () => forward.runEvidenceExtractor(extractorAdapter.manifest.id, makeExtractorInput()),
    registryError("extension_quarantined"),
  );
  const preQuarantined = new ExtensionRegistry({ quarantined: [reference] });
  preQuarantined.register(extractorAdapter);
  await assert.rejects(
    () => preQuarantined.runEvidenceExtractor(extractorAdapter.manifest.id, makeExtractorInput()),
    registryError("extension_quarantined"),
  );
});

test("invalid manifests, duplicate IDs, and partial modules are rejected atomically", () => {
  const invalidVersion = {
    manifest: { ...extractorAdapter.manifest, version: "v1", unexpected: true },
    run: extractorAdapter.run,
  };
  assert.throws(() => new ExtensionRegistry().register(invalidVersion as never), registryError("invalid_manifest"));
  const invalidPrerelease = {
    manifest: { ...extractorAdapter.manifest, version: "1.0.0-01" },
    run: extractorAdapter.run,
  };
  assert.throws(() => new ExtensionRegistry().register(invalidPrerelease as never), registryError("invalid_manifest"));
  for (const version of [
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0-",
    "1.0.0-alpha..1",
    "1.0.0+",
    "1.0.0+build..1",
    "1.0.0+build+again",
    `1.0.0-${"a".repeat(180)}.`,
  ]) {
    const invalidSemver = {
      manifest: { ...extractorAdapter.manifest, version },
      run: extractorAdapter.run,
    };
    assert.throws(() => new ExtensionRegistry().register(invalidSemver as never), registryError("invalid_manifest"));
  }

  const registry = new ExtensionRegistry();
  registry.register(extractorAdapter);
  assert.throws(() => registry.register(extractorAdapter), registryError("duplicate_extension"));

  const atomic = new ExtensionRegistry();
  const invalidApi = {
    manifest: { ...analyzerAdapter.manifest, extensionApiVersion: 2 },
    run: analyzerAdapter.run,
  };
  assert.throws(() => atomic.registerModule({
    schemaVersion: 1,
    extensions: [extractorAdapter, invalidApi as never],
  }), registryError("invalid_manifest"));
  assert.equal(atomic.list().length, 0);

  assert.throws(() => new ExtensionRegistry().registerModule({
    schemaVersion: 1,
    extensions: [extractorAdapter, extractorAdapter],
  }), registryError("duplicate_extension"));
});

test("module registration reads only exact dense ordinary arrays and never dispatches an attacker-owned map", () => {
  let hostileMapCalled = false;
  const hostileMap = [extractorAdapter];
  Object.defineProperty(hostileMap, "map", {
    configurable: true,
    value: () => {
      hostileMapCalled = true;
      return [];
    },
  });
  const hostileRegistry = new ExtensionRegistry();
  assert.throws(
    () => hostileRegistry.registerModule({ schemaVersion: 1, extensions: hostileMap } as never),
    registryError("invalid_manifest"),
  );
  assert.equal(hostileMapCalled, false);
  assert.equal(hostileRegistry.list().length, 0);

  const sparse = new Array(1);
  assert.throws(
    () => new ExtensionRegistry().registerModule({ schemaVersion: 1, extensions: sparse } as never),
    registryError("invalid_manifest"),
  );

  let accessorRead = false;
  const accessor = [extractorAdapter];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return extractorAdapter;
    },
  });
  assert.throws(
    () => new ExtensionRegistry().registerModule({ schemaVersion: 1, extensions: accessor } as never),
    registryError("invalid_manifest"),
  );
  assert.equal(accessorRead, false);

  const symbolProperty = [extractorAdapter];
  Object.defineProperty(symbolProperty, Symbol("hidden"), { value: extractorAdapter });
  assert.throws(
    () => new ExtensionRegistry().registerModule({ schemaVersion: 1, extensions: symbolProperty } as never),
    registryError("invalid_manifest"),
  );

  const inherited = [extractorAdapter];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  assert.throws(
    () => new ExtensionRegistry().registerModule({ schemaVersion: 1, extensions: inherited } as never),
    registryError("invalid_manifest"),
  );
});

test("adapter invocation has no registry-entry receiver", async () => {
  let receiver: unknown = "not-called";
  const receiverProbe: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: { ...validatorAdapter.manifest, id: "test.receiver-probe" },
    run(this: unknown, input) {
      receiver = this;
      return validValidatorOutput(input);
    },
  });
  const registry = new ExtensionRegistry();
  registry.register(receiverProbe);
  await registry.runValidator(receiverProbe.manifest.id, makeValidatorInput());
  assert.equal(receiver, undefined);
});

test("every port rejects invalid input before invoking its adapter", async () => {
  const registry = populatedRegistry();
  const extractor = makeExtractorInput();
  await assert.rejects(
    () => registry.runEvidenceExtractor(extractorAdapter.manifest.id, {
      ...extractor,
      artifact: { ...extractor.artifact, relativePath: "../package.json" },
    }),
    registryError("invalid_input"),
  );

  const analyzer = makeAnalyzerInput();
  await assert.rejects(
    () => registry.runLanguageAnalyzer(analyzerAdapter.manifest.id, { ...analyzer, language: "python" }),
    registryError("invalid_input"),
  );

  const provider = makeProviderInput();
  await assert.rejects(
    () => registry.runInferenceProvider(providerAdapter.manifest.id, { ...provider, payloadDigest: "0".repeat(64) }),
    registryError("invalid_input"),
  );

  const redactor = makeRedactorInput();
  await assert.rejects(
    () => registry.runRedactor(redactorAdapter.manifest.id, {
      ...redactor,
      items: redactor.items.map((item) => ({ ...item, textDigest: "0".repeat(64) })),
    }),
    registryError("invalid_input"),
  );

  const exporter = makeExporterInput();
  await assert.rejects(
    () => registry.runExporter(exporterAdapter.manifest.id, {
      ...exporter,
      canonical: { ...exporter.canonical, contentDigest: "0".repeat(64) },
    }),
    registryError("invalid_input"),
  );

  const validator = makeValidatorInput();
  await assert.rejects(
    () => registry.runValidator(validatorAdapter.manifest.id, {
      ...validator,
      subjects: validator.subjects.map((subject) => ({ ...subject, digest: "0".repeat(64) })),
    }),
    registryError("invalid_input"),
  );
});

test("extractor and analyzer outputs cannot fabricate evidence, spans, or structural references", async () => {
  const invalidExtractor: ExtensionAdapterV1<"evidence-extractor"> = defineExtension({
    manifest: extractorAdapter.manifest,
    run(input) {
      const output = validExtractorOutput(input);
      return {
        ...output,
        observations: output.observations.map((item) => ({
          ...item,
          fragment: { ...item.fragment, artifactId: "artifact_fabricated", endByte: input.artifact.byteLength + 1 },
        })),
      };
    },
  });
  const extractorRegistry = new ExtensionRegistry();
  extractorRegistry.register(invalidExtractor);
  await assert.rejects(
    () => extractorRegistry.runEvidenceExtractor(invalidExtractor.manifest.id, makeExtractorInput()),
    registryError("invalid_output"),
  );

  const invalidAnalyzer: ExtensionAdapterV1<"language-analyzer"> = defineExtension({
    manifest: analyzerAdapter.manifest,
    run(input) {
      const output = validAnalyzerOutput(input);
      return {
        ...output,
        edges: output.edges.map((edge) => ({ ...edge, target: { localId: "symbol_missing", externalName: null } })),
      };
    },
  });
  const analyzerRegistry = new ExtensionRegistry();
  analyzerRegistry.register(invalidAnalyzer);
  await assert.rejects(
    () => analyzerRegistry.runLanguageAnalyzer(invalidAnalyzer.manifest.id, makeAnalyzerInput()),
    registryError("invalid_output"),
  );

});

test("provider output is atomic and cannot invent evidence or self-promote authority", async () => {
  const fabricatedEvidence: ExtensionAdapterV1<"inference-provider"> = defineExtension({
    manifest: providerAdapter.manifest,
    run(input) {
      const output = validProviderOutput(input);
      return {
        ...output,
        candidates: output.candidates.map((candidate) => ({
          ...candidate,
          supportingEvidenceIds: ["evidence_fabricated"],
        })),
      };
    },
  });
  const evidenceRegistry = new ExtensionRegistry();
  evidenceRegistry.register(fabricatedEvidence);
  await assert.rejects(
    () => evidenceRegistry.runInferenceProvider(fabricatedEvidence.manifest.id, makeProviderInput()),
    registryError("invalid_output"),
  );

  const selfApproving: ExtensionAdapterV1<"inference-provider"> = defineExtension({
    manifest: providerAdapter.manifest,
    run(input) {
      const output = validProviderOutput(input);
      return {
        ...output,
        candidates: output.candidates.map((candidate) => ({
          ...candidate,
          value: { summary: "Suggested purpose", approved: true, authority: "human" },
        })),
      };
    },
  });
  const authorityRegistry = new ExtensionRegistry();
  authorityRegistry.register(selfApproving);
  await assert.rejects(
    () => authorityRegistry.runInferenceProvider(selfApproving.manifest.id, makeProviderInput()),
    registryError("invalid_output"),
  );

  const normalizedSelfApproving: ExtensionAdapterV1<"inference-provider"> = defineExtension({
    manifest: { ...providerAdapter.manifest, id: "test.normalized-authority-provider" },
    run(input) {
      const output = validProviderOutput(input);
      return {
        ...output,
        candidates: output.candidates.map((candidate) => ({
          ...candidate,
          value: { summary: "Suggested purpose", "ＡＰＰＲＯＶＥＤ＿ＢＹ": "human" },
        })),
      };
    },
  });
  const normalizedAuthorityRegistry = new ExtensionRegistry();
  normalizedAuthorityRegistry.register(normalizedSelfApproving);
  await assert.rejects(
    () => normalizedAuthorityRegistry.runInferenceProvider(
      normalizedSelfApproving.manifest.id,
      providerInputFor(normalizedSelfApproving.manifest.id),
    ),
    registryError("invalid_output"),
  );

  const authorityValues: Array<InferenceProviderOutputV1["candidates"][number]["value"]> = [
    { is_approved: true },
    { approval_status: "pending" },
    { authority_level: "model" },
    { lifecycle_state: "active" },
    { review_status: "complete" },
    "human-approved",
  ];
  for (const [index, value] of authorityValues.entries()) {
    const adapter: ExtensionAdapterV1<"inference-provider"> = defineExtension({
      manifest: { ...providerAdapter.manifest, id: `test.authority-variant-provider-${index}` },
      run(input) {
        const output = validProviderOutput(input);
        return {
          ...output,
          candidates: output.candidates.map((candidate) => ({ ...candidate, value })),
        };
      },
    });
    const registry = new ExtensionRegistry();
    registry.register(adapter);
    await assert.rejects(
      () => registry.runInferenceProvider(adapter.manifest.id, providerInputFor(adapter.manifest.id)),
      registryError("invalid_output"),
    );
  }
});

test("provider candidates are bound to policy subjects, predicates, model, and disjoint evidence roles", async () => {
  const cases: Array<{
    id: string;
    mutate: (output: InferenceProviderOutputV1) => InferenceProviderOutputV1;
  }> = [
    {
      id: "test.wrong-model-provider",
      mutate: (output) => ({ ...output, modelVersion: "unrequested-model" }),
    },
    {
      id: "test.unknown-subject-provider",
      mutate: (output) => ({
        ...output,
        candidates: output.candidates.map((candidate) => ({ ...candidate, subjectId: "component_not_allowed" })),
      }),
    },
    {
      id: "test.unknown-predicate-provider",
      mutate: (output) => ({
        ...output,
        candidates: output.candidates.map((candidate) => ({ ...candidate, predicate: "component.owner" })),
      }),
    },
    {
      id: "test.conflicting-citation-provider",
      mutate: (output) => ({
        ...output,
        candidates: output.candidates.map((candidate) => ({
          ...candidate,
          contradictingEvidenceIds: [...candidate.supportingEvidenceIds],
        })),
      }),
    },
  ];
  for (const fixture of cases) {
    const adapter: ExtensionAdapterV1<"inference-provider"> = defineExtension({
      manifest: { ...providerAdapter.manifest, id: fixture.id },
      run(input) {
        return fixture.mutate(validProviderOutput(input));
      },
    });
    const registry = new ExtensionRegistry();
    registry.register(adapter);
    await assert.rejects(
      () => registry.runInferenceProvider(adapter.manifest.id, providerInputFor(adapter.manifest.id)),
      registryError("invalid_output"),
    );
  }

  const reservedPredicateInput = providerInputFor(providerAdapter.manifest.id, {
    allowedPredicates: ["authority.level"],
  });
  const registry = new ExtensionRegistry();
  registry.register(providerAdapter);
  await assert.rejects(
    () => registry.runInferenceProvider(providerAdapter.manifest.id, reservedPredicateInput),
    registryError("invalid_input"),
  );

  const unseenAllowedEvidence = providerInputFor(providerAdapter.manifest.id, {
    allowedEvidenceIds: ["evidence_readme", "evidence_never_supplied"],
  });
  await assert.rejects(
    () => registry.runInferenceProvider(providerAdapter.manifest.id, unseenAllowedEvidence),
    registryError("invalid_input"),
  );
});

test("redactor, exporter, and validator outputs fail closed on boundary escape", async () => {
  const missingRedactionItem: ExtensionAdapterV1<"redactor"> = defineExtension({
    manifest: redactorAdapter.manifest,
    run: () => ({ schemaVersion: 1, items: [] }),
  });
  const redactorRegistry = new ExtensionRegistry();
  redactorRegistry.register(missingRedactionItem);
  await assert.rejects(
    () => redactorRegistry.runRedactor(missingRedactionItem.manifest.id, makeRedactorInput()),
    registryError("invalid_output"),
  );

  const overlappingRedaction: ExtensionAdapterV1<"redactor"> = defineExtension({
    manifest: { ...redactorAdapter.manifest, id: "test.overlapping-redactor" },
    run(input) {
      const output = validRedactorOutput(input);
      const item = output.items[0];
      assert.ok(item);
      return {
        ...output,
        items: [{
          ...item,
          spans: [
            { startByte: 11, endByte: 20, category: "credential", confidence: 1, action: "redact" as const },
            { startByte: 19, endByte: 25, category: "credential", confidence: 1, action: "redact" as const },
          ],
        }],
      };
    },
  });
  const overlapRegistry = new ExtensionRegistry();
  overlapRegistry.register(overlappingRedaction);
  await assert.rejects(
    () => overlapRegistry.runRedactor(overlappingRedaction.manifest.id, makeRedactorInput()),
    registryError("invalid_output"),
  );

  const traversingExporter: ExtensionAdapterV1<"exporter"> = defineExtension({
    manifest: exporterAdapter.manifest,
    run(input) {
      const output = validExporterOutput(input);
      return {
        ...output,
        artifacts: output.artifacts.map((artifact) => ({ ...artifact, fileName: "../outside.json" })),
      };
    },
  });
  const exporterRegistry = new ExtensionRegistry();
  exporterRegistry.register(traversingExporter);
  await assert.rejects(
    () => exporterRegistry.runExporter(traversingExporter.manifest.id, makeExporterInput()),
    registryError("invalid_output"),
  );

  const corruptExporter: ExtensionAdapterV1<"exporter"> = defineExtension({
    manifest: { ...exporterAdapter.manifest, id: "test.corrupt-exporter" },
    run(input) {
      const output = validExporterOutput(input);
      return {
        ...output,
        artifacts: output.artifacts.map((artifact) => ({
          ...artifact,
          byteLength: artifact.byteLength + 1,
          sha256: "0".repeat(64),
        })),
      };
    },
  });
  const corruptExportRegistry = new ExtensionRegistry();
  corruptExportRegistry.register(corruptExporter);
  await assert.rejects(
    () => corruptExportRegistry.runExporter(corruptExporter.manifest.id, makeExporterInput()),
    registryError("invalid_output"),
  );

  const escapingValidator: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: validatorAdapter.manifest,
    run(input) {
      const output = validValidatorOutput(input);
      return {
        ...output,
        findings: output.findings.map((finding) => ({
          ...finding,
          subjectIds: ["entity_not_supplied"],
          evidenceIds: ["evidence_not_supplied"],
        })),
      };
    },
  });
  const validatorRegistry = new ExtensionRegistry();
  validatorRegistry.register(escapingValidator);
  await assert.rejects(
    () => validatorRegistry.runValidator(escapingValidator.manifest.id, makeValidatorInput()),
    registryError("invalid_output"),
  );

});

test("binary artifact fragments retain exact arbitrary byte offsets", async () => {
  const binaryBytes = Buffer.from([0x41, 0x80, 0x42]);
  const binaryArtifact: ApprovedArtifactV1 = {
    schemaVersion: 1,
    artifactId: "artifact_binary",
    kind: "other",
    relativePath: "fixture.bin",
    mediaType: "application/octet-stream",
    bytesBase64: binaryBytes.toString("base64"),
    byteLength: binaryBytes.byteLength,
    sha256: sha256(binaryBytes),
    observedAt,
  };
  const binaryExtractor: ExtensionAdapterV1<"evidence-extractor"> = defineExtension({
    manifest: {
      ...extractorAdapter.manifest,
      id: "test.binary-fragment-extractor",
      description: "Reads an exact byte from an approved binary artifact.",
      capabilities: {
        ...extractorAdapter.manifest.capabilities,
        artifactKinds: ["other"],
        mediaTypes: ["application/octet-stream"],
      },
    },
    run(input) {
      return {
        schemaVersion: 1,
        observations: [{
          observationId: "observation_binary_byte",
          claimKey: "binary_byte_value",
          subject: { localKey: "binary_fixture", entityType: "binary", title: "fixture.bin" },
          predicate: "binary.byte",
          value: 128,
          fragment: { artifactId: input.artifact.artifactId, startByte: 1, endByte: 2 },
          dependencies: [{ kind: "artifact" as const, id: input.artifact.artifactId, digest: input.artifact.sha256 }],
          confidence: { method: "deterministic" as const, score: 1, explanation: "Read the selected byte." },
        }],
        diagnostics: [],
        coverage: { bytesExamined: input.artifact.byteLength, bytesCovered: 1, complete: true },
      };
    },
  });
  const registry = new ExtensionRegistry();
  registry.register(binaryExtractor);
  const result = await registry.runEvidenceExtractor(binaryExtractor.manifest.id, {
    schemaVersion: 1,
    artifact: binaryArtifact,
    policy: {
      schemaVersion: 1,
      policyVersion: "binary-policy-v1",
      allowedEntityTypes: ["binary"],
      allowedPredicates: ["binary.byte"],
      maxObservations: 2,
    },
  });
  assert.deepEqual(result.output.observations[0]?.fragment, { artifactId: "artifact_binary", startByte: 1, endByte: 2 });
});

test("artifact and redaction byte spans cannot split UTF-8 code points", async () => {
  const unicodeExtractor: ExtensionAdapterV1<"evidence-extractor"> = defineExtension({
    manifest: {
      ...extractorAdapter.manifest,
      id: "test.unicode-fragment-extractor",
      capabilities: {
        ...extractorAdapter.manifest.capabilities,
        artifactKinds: ["document"],
        mediaTypes: ["text/plain"],
      },
    },
    run(input) {
      return {
        schemaVersion: 1,
        observations: [{
          observationId: "observation_unicode",
          claimKey: "unicode_value",
          subject: { localKey: "document_unicode", entityType: "document", title: "unicode.txt" },
          predicate: "document.text",
          value: "é",
          fragment: { artifactId: input.artifact.artifactId, startByte: 1, endByte: 2 },
          dependencies: [{ kind: "artifact" as const, id: input.artifact.artifactId, digest: input.artifact.sha256 }],
          confidence: { method: "deterministic" as const, score: 1, explanation: "Fixture fragment." },
        }],
        diagnostics: [],
        coverage: { bytesExamined: input.artifact.byteLength, bytesCovered: 1, complete: true },
      };
    },
  });
  const unicodeArtifact = makeArtifact("artifact_unicode", "document", "unicode.txt", "text/plain", "é");
  const extractorRegistry = new ExtensionRegistry();
  extractorRegistry.register(unicodeExtractor);
  await assert.rejects(
    () => extractorRegistry.runEvidenceExtractor(unicodeExtractor.manifest.id, {
      schemaVersion: 1,
      artifact: unicodeArtifact,
      policy: {
        schemaVersion: 1,
        policyVersion: "unicode-policy-v1",
        allowedEntityTypes: ["document"],
        allowedPredicates: ["document.text"],
        maxObservations: 2,
      },
    }),
    registryError("invalid_output"),
  );

  const text = "ésecret";
  const unicodeRedactorInput: RedactorInputV1 = {
    schemaVersion: 1,
    policyVersion: "redaction-policy-v1",
    allowedCategories: ["credential"],
    maxSpans: 2,
    items: [{ itemId: "item_unicode", text, textDigest: sha256(text) }],
  };
  const splittingRedactor: ExtensionAdapterV1<"redactor"> = defineExtension({
    manifest: { ...redactorAdapter.manifest, id: "test.splitting-redactor" },
    run(input) {
      const item = input.items[0];
      assert.ok(item);
      return {
        schemaVersion: 1,
        items: [{
          itemId: item.itemId,
          sourceDigest: item.textDigest,
          action: "redact",
          spans: [{ startByte: 1, endByte: 2, category: "credential", confidence: 1, action: "redact" }],
        }],
      };
    },
  });
  const redactorRegistry = new ExtensionRegistry();
  redactorRegistry.register(splittingRedactor);
  await assert.rejects(
    () => redactorRegistry.runRedactor(splittingRedactor.manifest.id, unicodeRedactorInput),
    registryError("invalid_output"),
  );
});

test("export artifacts use portable Windows-safe NFC basenames with case-folded uniqueness", async () => {
  const badNames = [
    "CON.json",
    "LPT9.txt",
    "report.json:alternate-stream",
    "report.json.",
    "report.json ",
    "bad\u0001name.json",
    "e\u0301.json",
    "CONIN$.txt",
    "evil\u202Ename.json",
    `${"界".repeat(100)}.json`,
  ];
  for (const [index, fileName] of badNames.entries()) {
    const adapter = exporterWithNames(`test.unsafe-name-exporter-${index}`, [fileName]);
    const registry = new ExtensionRegistry();
    registry.register(adapter);
    await assert.rejects(
      () => registry.runExporter(adapter.manifest.id, makeExporterInput()),
      registryError("invalid_output"),
    );
  }

  for (const [index, names] of [
    ["Report.json", "report.json"],
    ["É.json", "e\u0301.json"],
    ["\uD800.txt", "\uD801.txt"],
  ].entries()) {
    const adapter = exporterWithNames(`test.colliding-name-exporter-${index}`, names);
    const registry = new ExtensionRegistry();
    registry.register(adapter);
    await assert.rejects(
      () => registry.runExporter(adapter.manifest.id, makeExporterInput()),
      registryError("invalid_output"),
    );
  }
});

test("secret-shaped manifests, credential values, and extension outputs fail closed without echoing secrets", async () => {
  const secret = `sk-${"A".repeat(32)}`;
  assert.throws(
    () => new ExtensionRegistry().register({
      manifest: { ...validatorAdapter.manifest, description: `Leaked ${secret}` },
      run: validatorAdapter.run,
    }),
    (error: unknown) => error instanceof ExtensionRegistryError
      && error.code === "invalid_manifest"
      && !error.message.includes(secret),
  );

  const providerRegistry = new ExtensionRegistry();
  providerRegistry.register(providerAdapter);
  await assert.rejects(
    () => providerRegistry.runInferenceProvider(
      providerAdapter.manifest.id,
      providerInputFor(providerAdapter.manifest.id, { credentialReference: `credential-store:${secret}` }),
    ),
    (error: unknown) => error instanceof ExtensionRegistryError
      && error.code === "invalid_input"
      && !error.message.includes(secret),
  );

  const leakingProvider: ExtensionAdapterV1<"inference-provider"> = defineExtension({
    manifest: { ...providerAdapter.manifest, id: "test.leaking-provider" },
    run(input) {
      const output = validProviderOutput(input);
      return {
        ...output,
        candidates: output.candidates.map((candidate) => ({ ...candidate, value: `Leaked ${secret}` })),
      };
    },
  });
  const leakingProviderRegistry = new ExtensionRegistry();
  leakingProviderRegistry.register(leakingProvider);
  await assert.rejects(
    () => leakingProviderRegistry.runInferenceProvider(
      leakingProvider.manifest.id,
      providerInputFor(leakingProvider.manifest.id),
    ),
    (error: unknown) => error instanceof ExtensionRegistryError
      && error.code === "invalid_output"
      && !error.message.includes(secret),
  );

  const leakingExporter: ExtensionAdapterV1<"exporter"> = defineExtension({
    manifest: { ...exporterAdapter.manifest, id: "test.leaking-exporter" },
    run() {
      const bytes = Buffer.from(`{"token":"${secret}"}`, "utf16le");
      return {
        schemaVersion: 1,
        artifacts: [{
          fileName: "leak.txt",
          mediaType: "application/json",
          encoding: "base64",
          bytesBase64: bytes.toString("base64"),
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        }],
        warnings: [],
      };
    },
  });
  const leakingExporterRegistry = new ExtensionRegistry();
  leakingExporterRegistry.register(leakingExporter);
  await assert.rejects(
    () => leakingExporterRegistry.runExporter(leakingExporter.manifest.id, makeExporterInput()),
    registryError("invalid_output"),
  );
});

test("adapter exceptions, timeouts, cancellation, accessors, and cyclic output are rejected without leaking secrets", async () => {
  const secret = "sk-contract-error-must-not-leak";
  const throwing: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: validatorAdapter.manifest,
    run: () => { throw new Error(secret); },
  });
  const throwingRegistry = new ExtensionRegistry();
  throwingRegistry.register(throwing);
  await assert.rejects(
    () => throwingRegistry.runValidator(throwing.manifest.id, makeValidatorInput()),
    (error: unknown) => error instanceof ExtensionRegistryError
      && error.code === "execution_failed"
      && !error.message.includes(secret)
      && !JSON.stringify({ code: error.code, message: error.message, extensionRef: error.extensionRef }).includes(secret),
  );

  const slow: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: { ...validatorAdapter.manifest, id: "test.slow-validator" },
    run: () => new Promise((resolve) => setTimeout(() => resolve({ schemaVersion: 1, findings: [] }), 50)),
  });
  const slowRegistry = new ExtensionRegistry();
  slowRegistry.register(slow);
  await assert.rejects(
    () => slowRegistry.runValidator(slow.manifest.id, makeValidatorInput(), { timeoutMs: 5 }),
    registryError("execution_timeout"),
  );

  let completedAfterTimeout = false;
  const continuing: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: { ...validatorAdapter.manifest, id: "test.continuing-validator" },
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completedAfterTimeout = true;
      return { schemaVersion: 1, findings: [] };
    },
  });
  const continuingRegistry = new ExtensionRegistry();
  continuingRegistry.register(continuing);
  await assert.rejects(
    () => continuingRegistry.runValidator(continuing.manifest.id, makeValidatorInput(), { timeoutMs: 5 }),
    registryError("execution_timeout"),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completedAfterTimeout, true);

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    () => slowRegistry.runValidator(slow.manifest.id, makeValidatorInput(), { signal: abortController.signal }),
    registryError("execution_cancelled"),
  );
  await assert.rejects(
    () => slowRegistry.runValidator(slow.manifest.id, makeValidatorInput(), { timeoutMs: 10, unexpected: true } as never),
    registryError("invalid_options"),
  );

  const getterOutput: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: { ...validatorAdapter.manifest, id: "test.getter-validator" },
    run() {
      const output: Record<string, unknown> = { schemaVersion: 1 };
      Object.defineProperty(output, "findings", { enumerable: true, get: () => { throw new Error(secret); } });
      return output;
    },
  });
  const getterRegistry = new ExtensionRegistry();
  getterRegistry.register(getterOutput);
  await assert.rejects(
    () => getterRegistry.runValidator(getterOutput.manifest.id, makeValidatorInput()),
    registryError("invalid_output"),
  );

  const cyclicOutput: ExtensionAdapterV1<"validator"> = defineExtension({
    manifest: { ...validatorAdapter.manifest, id: "test.cyclic-validator" },
    run() {
      const output: { schemaVersion: 1; findings: unknown[]; self?: unknown } = { schemaVersion: 1, findings: [] };
      output.self = output;
      return output;
    },
  });
  const cyclicRegistry = new ExtensionRegistry();
  cyclicRegistry.register(cyclicOutput);
  await assert.rejects(
    () => cyclicRegistry.runValidator(cyclicOutput.manifest.id, makeValidatorInput()),
    registryError("invalid_output"),
  );
});

test("extension documentation makes the installed-code trust boundary explicit", () => {
  const documentation = readFileSync(new URL("../docs/EXTENSIONS.md", import.meta.url), "utf8");
  assert.match(documentation, /trusted code/i);
  assert.match(documentation, /not sandboxed/i);
  assert.match(documentation, /operating-system permissions/i);
  assert.match(documentation, /no automatic discovery/i);
  assert.match(documentation, /schema validation.*cannot prevent/i);
  assert.match(documentation, /does not (?:hash|attest).*adapter code/i);
  assert.match(documentation, /cannot interrupt synchronous/i);
  assert.match(documentation, /timed-out.*(?:continue|still run)/i);
  assert.match(documentation, /host.*(?:precondition|responsib)/i);
  assert.match(documentation, /secret.*heuristic/i);
});

function populatedRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.registerModule(defineExtensionModule({ schemaVersion: 1, extensions: allExtensions }));
  return registry;
}

function makeArtifact(
  artifactId: string,
  kind: ApprovedArtifactV1["kind"],
  relativePath: string,
  mediaType: string,
  text: string,
): ApprovedArtifactV1 {
  const bytes = Buffer.from(text, "utf8");
  return {
    schemaVersion: 1,
    artifactId,
    kind,
    relativePath,
    mediaType,
    bytesBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    observedAt,
  };
}

function makeExtractorInput(): EvidenceExtractorInputV1 {
  return {
    schemaVersion: 1,
    artifact: makeArtifact("artifact_package", "manifest", "package.json", "application/json", "{\"name\":\"fixture-shop\"}"),
    policy: {
      schemaVersion: 1,
      policyVersion: "extract-policy-v1",
      allowedEntityTypes: ["manifest"],
      allowedPredicates: ["package.name"],
      maxObservations: 5,
    },
  };
}

function validExtractorOutput(input: EvidenceExtractorInputV1): EvidenceExtractorOutputV1 {
  const source = Buffer.from(input.artifact.bytesBase64, "base64").toString("utf8");
  const parsed = JSON.parse(source) as { name: string };
  return {
    schemaVersion: 1,
    observations: [{
      observationId: "observation_package_name",
      claimKey: "package_name_fixture_shop",
      subject: { localKey: "manifest_package", entityType: "manifest", title: "package.json" },
      predicate: "package.name",
      value: parsed.name,
      fragment: { artifactId: input.artifact.artifactId, startByte: 0, endByte: input.artifact.byteLength },
      dependencies: [{ kind: "artifact", id: input.artifact.artifactId, digest: input.artifact.sha256 }],
      confidence: { method: "deterministic", score: 1, explanation: "Parsed the declared JSON package name." },
    }],
    diagnostics: [],
    coverage: { bytesExamined: input.artifact.byteLength, bytesCovered: input.artifact.byteLength, complete: true },
  };
}

function makeAnalyzerInput(): LanguageAnalyzerInputV1 {
  return {
    schemaVersion: 1,
    artifact: makeArtifact(
      "artifact_billing",
      "source",
      "src/billing.ts",
      "text/typescript",
      "export function charge(cents: number): boolean { return cents > 0; }\n",
    ),
    language: "typescript",
    policy: { schemaVersion: 1, policyVersion: "analyzer-policy-v1", maxStructures: 20 },
  };
}

function validAnalyzerOutput(input: LanguageAnalyzerInputV1): LanguageAnalyzerOutputV1 {
  const source = Buffer.from(input.artifact.bytesBase64, "base64").toString("utf8");
  const match = /export function\s+([A-Za-z_$][\w$]*)/.exec(source);
  if (!match?.[1] || match.index === undefined) throw new Error("fixture analyzer input is unsupported");
  const nameStart = source.indexOf(match[1], match.index);
  const moduleId = "module_billing";
  const symbolId = "symbol_charge";
  return {
    schemaVersion: 1,
    modules: [{
      localId: moduleId,
      name: "src/billing.ts",
      fragment: { artifactId: input.artifact.artifactId, startByte: 0, endByte: input.artifact.byteLength },
    }],
    symbols: [{
      localId: symbolId,
      moduleId,
      name: match[1],
      kind: "function",
      exported: true,
      fragment: { artifactId: input.artifact.artifactId, startByte: nameStart, endByte: nameStart + match[1].length },
    }],
    edges: [{
      localId: "edge_exports_charge",
      kind: "exports",
      sourceId: moduleId,
      target: { localId: symbolId, externalName: null },
      fragment: { artifactId: input.artifact.artifactId, startByte: match.index, endByte: nameStart + match[1].length },
    }],
    tests: [],
    diagnostics: [],
    coverage: { bytesExamined: input.artifact.byteLength, bytesCovered: input.artifact.byteLength, complete: true },
  };
}

function makeProviderInput(): InferenceProviderInputV1 {
  const text = "Fixture Shop processes subscription charges.";
  const material: Omit<InferenceProviderInputV1, "payloadDigest"> = {
    schemaVersion: 1,
    providerId: providerAdapter.manifest.id,
    purpose: "component-purpose",
    model: "mock-v1",
    templateVersion: "component-purpose-v1",
    policyVersion: "egress-policy-v1",
    redactorVersions: ["credential-redactor-v1"],
    credentialReference: null,
    maxOutputTokens: 128,
    timeoutMs: 1_000,
    segments: [{ segmentId: "segment_readme", evidenceId: "evidence_readme", text, textDigest: sha256(text) }],
    allowedEvidenceIds: ["evidence_readme"],
    allowedSubjectIds: ["component_billing"],
    allowedPredicates: ["component.purpose"],
  };
  return { ...material, payloadDigest: computeProviderPayloadDigest(material) };
}

function providerInputFor(
  providerId: string,
  overrides: Partial<Omit<InferenceProviderInputV1, "payloadDigest">> = {},
): InferenceProviderInputV1 {
  const { payloadDigest: _payloadDigest, ...base } = makeProviderInput();
  const material: Omit<InferenceProviderInputV1, "payloadDigest"> = {
    ...base,
    ...overrides,
    providerId,
  };
  return { ...material, payloadDigest: computeProviderPayloadDigest(material) };
}

function validProviderOutput(input: InferenceProviderInputV1): InferenceProviderOutputV1 {
  return {
    schemaVersion: 1,
    modelVersion: input.model,
    candidates: [{
      candidateId: "candidate_component_purpose",
      subjectId: "component_billing",
      predicate: "component.purpose",
      value: "Processes subscription charges.",
      supportingEvidenceIds: [input.segments[0]?.evidenceId ?? ""],
      contradictingEvidenceIds: [],
      unknowns: ["Payment processor is not established by the supplied evidence."],
      confidenceBasis: { method: "model", explanation: "The candidate paraphrases only the supplied segment." },
    }],
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33, costMicros: null, currency: null },
    finishReason: "completed",
  };
}

function makeRedactorInput(): RedactorInputV1 {
  const text = "credential=sk-test-secret";
  return {
    schemaVersion: 1,
    policyVersion: "redaction-policy-v1",
    allowedCategories: ["credential"],
    maxSpans: 4,
    items: [{ itemId: "item_prompt", text, textDigest: sha256(text) }],
  };
}

function validRedactorOutput(input: RedactorInputV1): RedactorOutputV1 {
  return {
    schemaVersion: 1,
    items: input.items.map((item) => {
      const match = "sk-test-secret";
      const characterStart = item.text.indexOf(match);
      const startByte = Buffer.byteLength(item.text.slice(0, characterStart), "utf8");
      return {
        itemId: item.itemId,
        sourceDigest: item.textDigest,
        action: "redact" as const,
        spans: [{
          startByte,
          endByte: startByte + Buffer.byteLength(match, "utf8"),
          category: "credential",
          confidence: 1,
          action: "redact" as const,
        }],
      };
    }),
  };
}

function makeExporterInput(): ExporterInputV1 {
  const material = {
    schemaVersion: 1 as const,
    format: "context-atlas-canonical" as const,
    formatVersion: 2,
    snapshot: { repositoryId: "repository_fixture", head: "a".repeat(40), knowledgeWatermark: "ledger_fixture" },
    payload: { project: "fixture-shop" },
  };
  return {
    schemaVersion: 1,
    canonical: { ...material, contentDigest: computeCanonicalExportDigest(material) },
    requestedFormat: "canonical-json",
    maxOutputBytes: 64 * 1024,
    options: { pretty: false },
  };
}

function validExporterOutput(input: ExporterInputV1): ExporterOutputV1 {
  const bytes = Buffer.from(JSON.stringify(input.canonical.payload), "utf8");
  return {
    schemaVersion: 1,
    artifacts: [{
      fileName: "context-atlas.json",
      mediaType: "application/json",
      encoding: "base64",
      bytesBase64: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }],
    warnings: [],
  };
}

function exporterWithNames(id: string, fileNames: string[]): ExtensionAdapterV1<"exporter"> {
  return defineExtension({
    manifest: { ...exporterAdapter.manifest, id },
    run(input) {
      const output = validExporterOutput(input);
      const artifact = output.artifacts[0];
      assert.ok(artifact);
      return {
        ...output,
        artifacts: fileNames.map((fileName) => ({ ...artifact, fileName })),
      };
    },
  });
}

function makeValidatorInput(): ValidatorInputV1 {
  const material: Omit<ValidatorSubjectV1, "digest"> = {
    subjectId: "entity_project",
    kind: "project",
    payload: { summary: "" },
    evidenceIds: ["evidence_readme"],
  };
  return {
    schemaVersion: 1,
    policyVersion: "validation-policy-v1",
    scope: "entity",
    maxFindings: 5,
    allowedEvidenceIds: ["evidence_readme"],
    subjects: [{ ...material, digest: computeValidatorSubjectDigest(material) }],
  };
}

function validValidatorOutput(input: ValidatorInputV1): ValidatorOutputV1 {
  const subject = input.subjects[0];
  const payload = subject?.payload as { summary?: unknown } | undefined;
  return {
    schemaVersion: 1,
    findings: payload?.summary === "" && subject ? [{
      findingId: "finding_summary_required",
      ruleId: "summary-required",
      status: "critical",
      code: "empty-summary",
      subjectIds: [subject.subjectId],
      evidenceIds: [...subject.evidenceIds],
      message: "The canonical project summary is empty.",
      recommendation: "Review and add an evidence-backed project summary.",
    }] : [],
  };
}

function registryError(code: ExtensionErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof ExtensionRegistryError && error.code === code;
}
