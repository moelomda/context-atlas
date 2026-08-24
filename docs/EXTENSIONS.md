# Context Atlas extension contracts

Context Atlas extension API version 1 exposes six narrow, schema-validated ports: evidence extractors, language analyzers, inference providers, redactors, exporters, and validators. The API is intended for explicit local integration. It is separate from the bundled Codex plugin and does not create a marketplace, installer, or remote extension service.

## Trust boundary

> **Extensions are trusted code.** An extension runs inside the Context Atlas process with the current user's operating-system permissions. It is **not sandboxed**. Schema validation limits which returned data Context Atlas accepts; schema validation cannot prevent an extension from reading files, using the network, modifying data, consuming CPU or memory, hanging, or crashing the process. Install, import, and register only code you have reviewed and chosen to trust.

There is no automatic discovery. Context Atlas does not scan `node_modules`, the repository, environment variables, or arbitrary package exports for extensions. A host must obtain user trust before importing installed code and then register the already-imported module explicitly. Importing first and asking later is not a security boundary because JavaScript executes during module evaluation.

Timeouts and `AbortSignal` are cooperative safeguards. They can stop the host from waiting for an asynchronous result and notify a well-behaved adapter, but they cannot interrupt synchronous or malicious in-process code. Timed-out asynchronous code may continue to run and cause side effects after the host returns a timeout error. A future isolated worker or process model would be a separate security feature.

The registry rejects known secret-shaped text in manifests, inference-provider segments and credential references, accepted structured outputs, and decoded exporter artifacts. That scan is a heuristic defense, not proof that content is secret-free: unknown formats, encodings, fragments, and deliberately disguised values can pass it. It also does not make an extension unable to read secrets through ambient Node.js or operating-system capabilities.

The host is responsible for the security and policy preconditions outside these data contracts: approving artifact paths and bytes, enforcing denied-path and secret policy, selecting and redacting provider material, showing the exact egress preview, obtaining scoped consent, allowlisting opaque credential references, and safely choosing export destinations. A successful registry validation does not establish any of those decisions.

## Compatibility and identity

Every manifest, input, output, module, and result envelope declares schema version `1`. The registry accepts extension API version `1` and exact input/output schema version `1`; unsupported or unknown versions fail closed. Adapter implementation versions use SemVer and are part of the immutable producer identity.

The registry keys adapters by `kind:id`, permits one loaded version for that key, and records `kind:id@version`, a manifest digest, input digest, and output digest for each accepted run. Its deterministic fingerprint sorts enabled manifests and includes quarantine state. Hosts should include that fingerprint in extraction, validation, cache, and freshness watermarks whenever extensions affect canonical guidance.

`manifestDigest` and the registry fingerprint cover validated manifest data only. This layer does not hash or attest adapter code, package/module bytes, transitive dependencies, closures, or runtime configuration. Reusing an unchanged manifest with changed code is therefore not detected by this layer; a package verifier or signed, content-addressed installation record must supply code identity before registration when that guarantee is required. Likewise, `deterministic: true` is a manifest declaration whose reproducibility is observable through output digests but is not enforced by the registry.

An upgrade is a new producer version. Do not reuse a version for different code or behavior. A quarantined exact producer remains visible in inventory but cannot run.

## Explicit registration

An extension package exports an inertly described module value after the user has decided to import that package:

```ts
import {
  ExtensionRegistry,
  defineExtension,
  defineExtensionModule,
} from "context-atlas/extensions";

const extractor = defineExtension({
  manifest: {
    schemaVersion: 1,
    extensionApiVersion: 1,
    id: "example.package-manifest",
    version: "1.0.0",
    kind: "evidence-extractor",
    displayName: "Example package manifest extractor",
    description: "Reads approved package metadata.",
    deterministic: true,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    capabilities: {
      artifactKinds: ["manifest"],
      mediaTypes: ["application/json"],
      maxArtifactBytes: 262_144,
      maxObservations: 100,
    },
  },
  run(input) {
    // The adapter receives approved bytes and metadata, never a database or
    // repository-root capability. Its unknown output is validated at runtime.
    return {
      schemaVersion: 1,
      observations: [],
      diagnostics: [],
      coverage: {
        bytesExamined: input.artifact.byteLength,
        bytesCovered: 0,
        complete: true,
      },
    };
  },
});

export const contextAtlasExtensionModule = defineExtensionModule({
  schemaVersion: 1,
  extensions: [extractor],
});

const registry = new ExtensionRegistry();
registry.registerModule(contextAtlasExtensionModule);
```

`defineExtension` and `defineExtensionModule` provide TypeScript authoring help. Registration and execution still perform runtime checks. The registry keeps raw adapter functions private; consumers execute only through the typed `runEvidenceExtractor`, `runLanguageAnalyzer`, `runInferenceProvider`, `runRedactor`, `runExporter`, and `runValidator` methods.

Module registration accepts only a non-empty, exact dense ordinary array with own data properties for every index. Sparse arrays, accessors, extra properties (including an own `map`), symbols, and custom prototypes are invalid manifests. Invocation uses an `undefined` receiver; an adapter never receives the internal registry entry as `this`.

## Port boundaries

### Evidence extractor

Receives one policy-approved artifact with a safe repository-relative path, media type, canonical base64 bytes, byte length, SHA-256 digest, and observation time. It emits extension-local observations, exact byte fragments, dependencies, confidence basis, diagnostics, and coverage.

The registry verifies bytes and digests, artifact capabilities, fragment bounds, policy allowlists, unique deterministic keys, and an exact artifact dependency. Extractors cannot assign canonical authority, review state, or database identities.

### Language analyzer

Receives one approved artifact plus a declared language and bounded structure policy. It emits extension-local modules, symbols, edges, tests, diagnostics, and coverage.

Every module reference, edge endpoint, and fragment must resolve within the returned local graph and supplied artifact. Undeclared languages/media types, dangling references, invalid spans, and excessive output reject the entire result.

### Inference provider

Receives only an already-selected and already-redacted payload: bounded text segments, their digests and allowed evidence IDs, explicit allowed subject IDs and predicates, a purpose, model, prompt-template/policy/redactor versions, output/timeout limits, and a credential reference rather than a credential value. It returns structured candidates and safe usage metadata.

This port is **not an egress-consent gateway** and does not by itself authorize network use. Application code must keep remote invocation disabled until it has produced the exact egress preview and obtained repository/provider/purpose/policy-scoped consent. Credential references are opaque, allowlisted names; a raw credential value is invalid, and the registry neither resolves nor authorizes a reference. The contract binds every candidate to an allowed subject and predicate, requires the returned model version to equal the requested model, requires supporting and contradicting evidence to be disjoint, rejects reserved approval/authority/review/lifecycle predicate namespaces and normalized key variants, and rejects fabricated evidence references. One invalid candidate rejects the complete provider batch.

### Redactor

Receives bounded text items and their digests. It returns one decision per input item and byte spans labelled `redact` or `block`. The extension does not return replacement text; the trusted core owns any materialization step.

The registry validates source digests, item completeness, declared categories/actions, sorted non-overlapping spans, UTF-8 byte bounds and code-point boundaries, overall action, and configured limits. Artifact fragments for textual media likewise may not split a UTF-8 code point; byte-oriented binary media retain arbitrary exact byte offsets. Invalid output fails closed.

### Exporter

Receives a versioned canonical export DTO and format options, never a database handle or destination path. It returns bounded base64 artifacts with safe basenames, media types, byte lengths, and SHA-256 digests. The core remains responsible for choosing and safely writing destinations.

Traversal names, undeclared formats/media types, noncanonical base64, digest/length mismatch, duplicate portable names, or output over the caller/manifest/global ceiling reject the complete export. A portable basename must be well-formed Unicode, NFC-normalized, at most 255 UTF-8 bytes, and excludes Windows device names, alternate-data-stream colons and other Windows-invalid characters, controls and format controls, separators, and trailing dots/spaces. Uniqueness is checked after NFC normalization and case folding so artifacts cannot alias on common case-insensitive filesystems. The host must stage writes outside sensitive/repository paths, refuse unintended overwrites, and atomically publish only after its destination policy succeeds.

### Validator

Receives immutable canonical subject DTOs, a validation scope, policy version, and evidence allowlist. It returns findings only; it has no mutation result and receives no database capability.

Finding rule IDs must be declared by the manifest, and every subject/evidence reference must be present in the supplied input. Unknown references or excessive findings reject the entire result.

## Runtime behavior

Before invoking an adapter, the registry:

1. Rejects accessors, functions, special prototypes, cycles, unsafe keys, excessive nesting, and unsupported contract fields in structured input.
2. Applies strict Zod validation and port-specific semantic validation.
3. Clones and deeply freezes the accepted input.
4. Checks manifest capabilities and exact quarantine state.
5. Invokes the adapter with only an `AbortSignal` execution context.

After invocation it repeats the structured-data, strict-schema, semantic, and size checks, then returns a deeply frozen provenance envelope. Any output violation is atomic: no partial observation, candidate, redaction, artifact, or finding escapes.

Adapter exceptions are converted to safe codes without copying the adapter's message or source content into the public error. Registry errors expose a stable code and exact validated producer reference where applicable.

## Current limits

- Registration is in-process and explicit; no package loader or trust-confirmation UI is included in this contract layer.
- A narrow interface is not a capability sandbox because installed JavaScript can use ambient Node.js APIs.
- Provider ports require a separate egress preview/consent service before production wiring.
- Secret-shape screening is heuristic and is not a credential vault, a data-loss-prevention proof, or a substitute for host approval and redaction policy. Textual exporter artifacts must be canonical UTF-8; binary and unknown encodings cannot receive encoding-independent secret guarantees from this layer.
- Registry fingerprints attest manifests and quarantine state, not executable code identity; production package verification must be integrated separately.
- Contract validation proves structural/provenance safety at the boundary, not the semantic correctness of an extension's claims.
- Deterministic adapters are expected to produce the same accepted output for the same input; the envelope makes drift observable, while corpus-level reproducibility remains the extension author's responsibility.
