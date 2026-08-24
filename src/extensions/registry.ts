import { sha256, stableStringify } from "../core/util.js";
import {
  EXTENSION_SCHEMA_VERSION,
  type EvidenceExtractorInputV1,
  type EvidenceExtractorOutputV1,
  type ExporterInputV1,
  type ExporterOutputV1,
  type ExtensionAdapterV1,
  type ExtensionErrorCode,
  type ExtensionInputFor,
  type ExtensionKind,
  type ExtensionManifestFor,
  type ExtensionManifestV1,
  type ExtensionModuleV1,
  type ExtensionOutputFor,
  type ExtensionRunContext,
  type ExtensionRunEnvelopeV1,
  type ExtensionRunOptions,
  type InferenceProviderInputV1,
  type InferenceProviderOutputV1,
  type LanguageAnalyzerInputV1,
  type LanguageAnalyzerOutputV1,
  type RedactorInputV1,
  type RedactorOutputV1,
  type RegisteredExtensionDescriptorV1,
  type ValidatorInputV1,
  type ValidatorOutputV1,
} from "./contracts.js";
import {
  DEFAULT_EXTENSION_TIMEOUT_MS,
  ExtensionContractValidationError,
  MAX_EXTENSION_TIMEOUT_MS,
  parseExtensionInput,
  parseExtensionManifest,
  parseExtensionOutput,
  validateExtensionInputSemantics,
  validateExtensionOutputSemantics,
} from "./schemas.js";

interface RegistryEntry {
  manifest: ExtensionManifestV1;
  manifestDigest: string;
  extensionRef: string;
  run: (input: unknown, context: ExtensionRunContext) => unknown | Promise<unknown>;
}

interface PreparedEntry extends RegistryEntry {
  key: string;
}

export interface ExtensionRegistryOptions {
  quarantined?: Iterable<string>;
}

export class ExtensionRegistryError extends Error {
  readonly code: ExtensionErrorCode;
  readonly extensionRef: string | null;

  constructor(code: ExtensionErrorCode, extensionRef: string | null = null) {
    super(messageForError(code));
    this.name = "ExtensionRegistryError";
    this.code = code;
    this.extensionRef = extensionRef;
  }
}

export class ExtensionRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #quarantined = new Set<string>();

  constructor(options: ExtensionRegistryOptions = {}) {
    if (options.quarantined) {
      for (const extensionRef of options.quarantined) {
        if (typeof extensionRef !== "string" || extensionRef.length === 0 || extensionRef.length > 512) {
          throw new ExtensionRegistryError("invalid_options");
        }
        this.#quarantined.add(extensionRef);
      }
    }
  }

  register<K extends ExtensionKind>(adapter: ExtensionAdapterV1<K>): RegisteredExtensionDescriptorV1 {
    const entry = prepareAdapter(adapter);
    if (this.#entries.has(entry.key)) throw new ExtensionRegistryError("duplicate_extension", entry.extensionRef);
    this.#entries.set(entry.key, entry);
    return this.#descriptor(entry);
  }

  registerModule(module: ExtensionModuleV1): RegisteredExtensionDescriptorV1[] {
    const adapters = validateModuleContainer(module);
    const prepared: PreparedEntry[] = [];
    for (const adapter of adapters) prepared.push(prepareAdapter(adapter));
    const keys = prepared.map((entry) => entry.key);
    if (new Set(keys).size !== keys.length || prepared.some((entry) => this.#entries.has(entry.key))) {
      throw new ExtensionRegistryError("duplicate_extension");
    }
    for (const entry of prepared) this.#entries.set(entry.key, entry);
    return prepared.map((entry) => this.#descriptor(entry));
  }

  quarantine(extensionRef: string): void {
    if (typeof extensionRef !== "string" || extensionRef.length === 0 || extensionRef.length > 512) {
      throw new ExtensionRegistryError("invalid_options");
    }
    this.#quarantined.add(extensionRef);
  }

  list(kind?: ExtensionKind): RegisteredExtensionDescriptorV1[] {
    const descriptors = [...this.#entries.values()]
      .filter((entry) => kind === undefined || entry.manifest.kind === kind)
      .sort((left, right) => left.manifest.kind.localeCompare(right.manifest.kind)
        || left.manifest.id.localeCompare(right.manifest.id)
        || left.manifest.version.localeCompare(right.manifest.version))
      .map((entry) => this.#descriptor(entry));
    return structuredClone(descriptors);
  }

  fingerprint(): string {
    const material = this.list().map((descriptor) => ({
      extensionRef: descriptor.extensionRef,
      manifestDigest: descriptor.manifestDigest,
      quarantined: descriptor.quarantined,
    }));
    return sha256(stableStringify(material));
  }

  runEvidenceExtractor(
    id: string,
    input: EvidenceExtractorInputV1,
    options: ExtensionRunOptions = {},
  ): Promise<ExtensionRunEnvelopeV1<EvidenceExtractorOutputV1>> {
    return this.#execute("evidence-extractor", id, input, options);
  }

  runLanguageAnalyzer(
    id: string,
    input: LanguageAnalyzerInputV1,
    options: ExtensionRunOptions = {},
  ): Promise<ExtensionRunEnvelopeV1<LanguageAnalyzerOutputV1>> {
    return this.#execute("language-analyzer", id, input, options);
  }

  runInferenceProvider(
    id: string,
    input: InferenceProviderInputV1,
    options: ExtensionRunOptions = {},
  ): Promise<ExtensionRunEnvelopeV1<InferenceProviderOutputV1>> {
    return this.#execute("inference-provider", id, input, options);
  }

  runRedactor(
    id: string,
    input: RedactorInputV1,
    options: ExtensionRunOptions = {},
  ): Promise<ExtensionRunEnvelopeV1<RedactorOutputV1>> {
    return this.#execute("redactor", id, input, options);
  }

  runExporter(
    id: string,
    input: ExporterInputV1,
    options: ExtensionRunOptions = {},
  ): Promise<ExtensionRunEnvelopeV1<ExporterOutputV1>> {
    return this.#execute("exporter", id, input, options);
  }

  runValidator(
    id: string,
    input: ValidatorInputV1,
    options: ExtensionRunOptions = {},
  ): Promise<ExtensionRunEnvelopeV1<ValidatorOutputV1>> {
    return this.#execute("validator", id, input, options);
  }

  async #execute<K extends ExtensionKind>(
    kind: K,
    id: string,
    suppliedInput: ExtensionInputFor<K>,
    options: ExtensionRunOptions,
  ): Promise<ExtensionRunEnvelopeV1<ExtensionOutputFor<K>>> {
    const entry = this.#entries.get(registryKey(kind, id));
    if (!entry) throw new ExtensionRegistryError("extension_not_found");
    if (this.#quarantined.has(entry.extensionRef)) {
      throw new ExtensionRegistryError("extension_quarantined", entry.extensionRef);
    }
    const manifest = entry.manifest as ExtensionManifestFor<K>;
    let input: ExtensionInputFor<K>;
    try {
      const inputSnapshot = snapshotPlainStructuredData(suppliedInput);
      input = parseExtensionInput(kind, inputSnapshot);
      validateExtensionInputSemantics(kind, input, manifest);
    } catch {
      throw new ExtensionRegistryError("invalid_input", entry.extensionRef);
    }
    const validatedOptions = validateRunOptions(options);
    const timeoutMs = kind === "inference-provider"
      ? Math.min(validatedOptions.timeoutMs, (input as InferenceProviderInputV1).timeoutMs)
      : validatedOptions.timeoutMs;
    const inputDigest = sha256(stableStringify(input));
    const frozenInput = deepFreeze(structuredClone(input));
    const rawOutput = await invokeSafely(entry, frozenInput, timeoutMs, validatedOptions.signal);
    let output: ExtensionOutputFor<K>;
    try {
      const outputSnapshot = snapshotPlainStructuredData(rawOutput);
      output = parseExtensionOutput(kind, outputSnapshot);
      validateExtensionOutputSemantics(kind, input, output, manifest);
    } catch {
      throw new ExtensionRegistryError("invalid_output", entry.extensionRef);
    }
    const frozenOutput = deepFreeze(structuredClone(output));
    return deepFreeze({
      schemaVersion: EXTENSION_SCHEMA_VERSION,
      kind,
      producer: {
        id: manifest.id,
        version: manifest.version,
        manifestDigest: entry.manifestDigest,
      },
      inputDigest,
      outputDigest: sha256(stableStringify(frozenOutput)),
      output: frozenOutput,
    }) as ExtensionRunEnvelopeV1<ExtensionOutputFor<K>>;
  }

  #descriptor(entry: RegistryEntry): RegisteredExtensionDescriptorV1 {
    return deepFreeze({
      schemaVersion: EXTENSION_SCHEMA_VERSION,
      extensionRef: entry.extensionRef,
      manifestDigest: entry.manifestDigest,
      executionTrust: "in-process-trusted-code" as const,
      quarantined: this.#quarantined.has(entry.extensionRef),
      manifest: structuredClone(entry.manifest),
    });
  }
}

export function extensionRefFor(manifest: Pick<ExtensionManifestV1, "kind" | "id" | "version">): string {
  return `${manifest.kind}:${manifest.id}@${manifest.version}`;
}

function prepareAdapter(adapter: unknown): PreparedEntry {
  try {
    if (!adapter || typeof adapter !== "object" || !isPlainObject(adapter)) throw new ExtensionContractValidationError();
    const ownKeys = Reflect.ownKeys(adapter);
    if (ownKeys.some((key) => typeof key !== "string")) throw new ExtensionContractValidationError();
    const keys = (ownKeys as string[]).sort();
    if (keys.length !== 2 || keys[0] !== "manifest" || keys[1] !== "run") throw new ExtensionContractValidationError();
    const manifestDescriptor = Object.getOwnPropertyDescriptor(adapter, "manifest");
    const runDescriptor = Object.getOwnPropertyDescriptor(adapter, "run");
    if (!manifestDescriptor || !runDescriptor || manifestDescriptor.get || manifestDescriptor.set || runDescriptor.get || runDescriptor.set
      || typeof runDescriptor.value !== "function") throw new ExtensionContractValidationError();
    const manifestSnapshot = snapshotPlainStructuredData(manifestDescriptor.value);
    const parsedManifest = deepFreeze(parseExtensionManifest(manifestSnapshot));
    const manifestDigest = sha256(stableStringify(parsedManifest));
    return Object.freeze({
      key: registryKey(parsedManifest.kind, parsedManifest.id),
      manifest: parsedManifest,
      manifestDigest,
      extensionRef: extensionRefFor(parsedManifest),
      run: runDescriptor.value as RegistryEntry["run"],
    });
  } catch {
    throw new ExtensionRegistryError("invalid_manifest");
  }
}

function validateModuleContainer(module: ExtensionModuleV1): readonly unknown[] {
  if (!module || typeof module !== "object" || !isPlainObject(module)) throw new ExtensionRegistryError("invalid_manifest");
  const ownKeys = Reflect.ownKeys(module);
  if (ownKeys.some((key) => typeof key !== "string")) throw new ExtensionRegistryError("invalid_manifest");
  const keys = (ownKeys as string[]).sort();
  const schemaDescriptor = Object.getOwnPropertyDescriptor(module, "schemaVersion");
  const extensionsDescriptor = Object.getOwnPropertyDescriptor(module, "extensions");
  if (keys.length !== 2 || keys[0] !== "extensions" || keys[1] !== "schemaVersion"
    || !schemaDescriptor || !extensionsDescriptor || schemaDescriptor.get || schemaDescriptor.set
    || extensionsDescriptor.get || extensionsDescriptor.set
    || schemaDescriptor.value !== EXTENSION_SCHEMA_VERSION) {
    throw new ExtensionRegistryError("invalid_manifest");
  }
  try {
    const extensions = readExactDenseOrdinaryArray(extensionsDescriptor.value, 64);
    if (extensions.length === 0) throw new ExtensionContractValidationError();
    return extensions;
  } catch {
    throw new ExtensionRegistryError("invalid_manifest");
  }
}

function registryKey(kind: ExtensionKind, id: string): string {
  return `${kind}:${id}`;
}

function validateRunOptions(options: ExtensionRunOptions): { timeoutMs: number; signal: AbortSignal | undefined } {
  if (!options || typeof options !== "object" || !isPlainObject(options)) {
    throw new ExtensionRegistryError("invalid_options");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => typeof key !== "string" || (key !== "timeoutMs" && key !== "signal"))) {
    throw new ExtensionRegistryError("invalid_options");
  }
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(options, "timeoutMs");
  const signalDescriptor = Object.getOwnPropertyDescriptor(options, "signal");
  if (timeoutDescriptor?.get || timeoutDescriptor?.set || signalDescriptor?.get || signalDescriptor?.set) {
    throw new ExtensionRegistryError("invalid_options");
  }
  const timeoutMs = timeoutDescriptor?.value === undefined ? DEFAULT_EXTENSION_TIMEOUT_MS : timeoutDescriptor.value as number;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXTENSION_TIMEOUT_MS) {
    throw new ExtensionRegistryError("invalid_options");
  }
  const signal = signalDescriptor?.value as AbortSignal | undefined;
  if (signal !== undefined
    && (typeof signal !== "object" || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw new ExtensionRegistryError("invalid_options");
  }
  return { timeoutMs, signal };
}

const TIMED_OUT = Symbol("extension-timed-out");
const CANCELLED = Symbol("extension-cancelled");

async function invokeSafely(
  entry: RegistryEntry,
  input: unknown,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  if (callerSignal?.aborted) throw new ExtensionRegistryError("execution_cancelled", entry.extensionRef);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(TIMED_OUT);
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (!callerSignal) return;
    const onAbort = (): void => {
      controller.abort();
      reject(CANCELLED);
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => callerSignal.removeEventListener("abort", onAbort);
  });
  const context = Object.freeze({ signal: controller.signal });
  const execution = Promise.resolve().then(() => Reflect.apply(entry.run, undefined, [input, context]));
  try {
    return await Promise.race([execution, timeout, cancellation]);
  } catch (error) {
    if (error === TIMED_OUT) throw new ExtensionRegistryError("execution_timeout", entry.extensionRef);
    if (error === CANCELLED) throw new ExtensionRegistryError("execution_cancelled", entry.extensionRef);
    if (error instanceof ExtensionRegistryError) throw error;
    throw new ExtensionRegistryError("execution_failed", entry.extensionRef);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}

function snapshotPlainStructuredData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (child: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 100_000 || depth > 32) throw new ExtensionContractValidationError();
    if (child === null || ["string", "number", "boolean"].includes(typeof child)) return child;
    if (typeof child !== "object") throw new ExtensionContractValidationError();
    if (seen.has(child)) throw new ExtensionContractValidationError();
    seen.add(child);
    if (Array.isArray(child)) {
      const items = readExactDenseOrdinaryArray(child, 100_000);
      const snapshot = new Array<unknown>(items.length);
      for (let index = 0; index < items.length; index += 1) snapshot[index] = visit(items[index], depth + 1);
      return snapshot;
    }
    if (!isPlainObject(child)) throw new ExtensionContractValidationError();
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(child)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) {
        throw new ExtensionContractValidationError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(child, key);
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new ExtensionContractValidationError();
      }
      snapshot[key] = visit(descriptor.value, depth + 1);
    }
    return snapshot;
  };
  return visit(value, 0);
}

function readExactDenseOrdinaryArray(value: unknown, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ExtensionContractValidationError();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumLength) {
    throw new ExtensionContractValidationError();
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string"
    || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) {
    throw new ExtensionContractValidationError();
  }
  const items = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new ExtensionContractValidationError();
    }
    items[index] = descriptor.value;
  }
  return items;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function messageForError(code: ExtensionErrorCode): string {
  switch (code) {
    case "invalid_manifest": return "Extension registration was rejected because its manifest or module is invalid.";
    case "duplicate_extension": return "Extension registration was rejected because that extension kind and ID are already registered.";
    case "extension_not_found": return "The requested extension is not registered.";
    case "extension_quarantined": return "The requested extension version is quarantined and cannot execute.";
    case "invalid_input": return "Extension execution was rejected because its input contract is invalid.";
    case "invalid_output": return "Extension output was rejected atomically because its contract is invalid.";
    case "invalid_options": return "Extension execution options are invalid.";
    case "execution_failed": return "The extension failed without returning an accepted result.";
    case "execution_timeout": return "The host stopped waiting at the extension timeout; in-process code may still be running.";
    case "execution_cancelled": return "Extension execution was cancelled.";
  }
}
