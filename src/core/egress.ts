import { randomUUID } from "node:crypto";
import { findSecrets, type SecretFinding } from "./security.js";
import { estimateTokens, nowIso, sha256, stableStringify } from "./util.js";

export const EGRESS_SCHEMA_VERSION = 1 as const;
export const EGRESS_GATEWAY_VERSION = "egress-gateway-v1" as const;
export const EGRESS_SCANNER_VERSION = "context-atlas-secret-scanner-v1" as const;
export const EGRESS_REDACTOR_VERSION = "context-atlas-secret-redactor-v1" as const;
export const EGRESS_ESTIMATOR_VERSION = "char4-v1" as const;
export const MAX_EGRESS_PAYLOAD_BYTES = 256 * 1024;
export const MAX_EGRESS_RESPONSE_BYTES = 512 * 1024;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,255}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const HUMAN_ACTOR = /^human:[a-zA-Z0-9._@-]{1,200}$/;
const CREDENTIAL_REFERENCE = /^(?:env|os-keychain|credential-store):[A-Za-z_][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECOGNIZABLE_HOST_PATH =
  /(?:^|[^a-zA-Z0-9])(?:[a-zA-Z]:[\\/]|\\\\[^\\\s]|\/(?:Applications|Library|Network|System|Users|Volumes|app|bin|boot|builds|code|data|dev|etc|github|home|lib|lib64|media|mnt|nix|opt|private|proc|project|repo|root|run|runner|sbin|snap|source|src|srv|sys|tmp|usr|var|workspace|workspaces)(?:\/|\b))/im;
const FORBIDDEN_STATIC_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;

export type EgressPurpose = "component-purpose" | "semantic-event-grouping" | "change-impact" | "missing-context";
export type EgressDataClass = "public" | "internal";
export type EgressSecretAction = "block" | "redact";

export interface EgressProviderDescriptor {
  providerId: string;
  model: string;
  endpoint: string;
  retentionAssumption: string;
  credentialReference: string;
  serializerId: string;
  serializerVersion: string;
  templateVersion: string;
  tokenizerVersion: string;
  pricingVersion: string;
  inputCostMicrosPerMillionTokens: number;
  outputCostMicrosPerMillionTokens: number;
  currency: string;
}

export interface EgressSegment {
  segmentId: string;
  evidenceId: string;
  dataClass: EgressDataClass;
  text: string;
}

export interface EgressRequest {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  installationId: string;
  repositoryId: string;
  runId: string;
  purpose: EgressPurpose;
  provider: EgressProviderDescriptor;
  maxOutputTokens: number;
  segments: EgressSegment[];
}

export interface EgressPolicy {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  policyVersion: string;
  allowedProviderIds: string[];
  allowedEndpointOrigins: string[];
  allowedPurposes: EgressPurpose[];
  allowedDataClasses: EgressDataClass[];
  secretAction: EgressSecretAction;
  allowRecognizableHostPaths: boolean;
  maxInputTokensPerRun: number;
  maxOutputTokensPerRun: number;
  maxTokensPerRun: number;
  maxTokensPerDay: number;
  maxCostMicrosPerRun: number;
  maxCostMicrosPerDay: number;
  consentTtlMinutes: number;
  authorizationTtlMinutes: number;
}

export interface ProviderPayloadInput {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  model: string;
  purpose: EgressPurpose;
  templateVersion: string;
  maxOutputTokens: number;
  segments: Array<{
    segmentId: string;
    evidenceId: string;
    dataClass: EgressDataClass;
    text: string;
  }>;
}

export interface ProviderPayloadSerializer {
  readonly id: string;
  readonly version: string;
  readonly mediaType: string;
  serialize(input: Readonly<ProviderPayloadInput>): string | Uint8Array;
}

export interface EgressPreview {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  operation: "provider-egress-preview";
  dryRun: true;
  previewId: string;
  scopeDigest: string;
  generatedAt: string;
  destination: {
    providerId: string;
    model: string;
    endpoint: string;
    retentionAssumption: string;
  };
  purpose: EgressPurpose;
  policy: {
    policyVersion: string;
    requestDigest: string;
    policyDigest: string;
    serializerDigest: string;
    gatewayVersion: typeof EGRESS_GATEWAY_VERSION;
    scannerVersion: typeof EGRESS_SCANNER_VERSION;
    redactorVersion: typeof EGRESS_REDACTOR_VERSION;
    estimatorVersion: typeof EGRESS_ESTIMATOR_VERSION;
    serializerId: string;
    serializerVersion: string;
    tokenizerVersion: string;
    pricingVersion: string;
  };
  payload: {
    mediaType: string;
    utf8: string;
    bytes: number;
    digest: string;
  };
  redactions: Array<{ segmentId: string; category: string; count: number; action: "redact" }>;
  usageEstimate: {
    inputTokens: number;
    maxOutputTokens: number;
    maximumTotalTokens: number;
    maximumCostMicros: number;
    currency: string;
  };
  credential: {
    reference: string;
    persistedSecret: false;
  };
  consent: {
    scopeDigest: string;
    confirmationRequired: "ALLOW";
    perAttemptConfirmationRequired: "SEND";
  };
}

export interface EgressConsentRecord {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  consentId: string;
  scopeDigest: string;
  installationId: string;
  repositoryId: string;
  actor: string;
  reasonDigest: string;
  grantedAt: string;
  expiresAt: string;
  recordDigest: string;
}

export interface EgressAttemptAuthorization {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  authorizationId: string;
  consentId: string;
  previewId: string;
  scopeDigest: string;
  payloadDigest: string;
  previewDigest: string;
  actor: string;
  approvedAt: string;
  expiresAt: string;
  recordDigest: string;
}

export interface EgressConsentRevocation {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  revocationId: string;
  consentId: string;
  actor: string;
  reasonDigest: string;
  revokedAt: string;
  recordDigest: string;
}

export interface EgressBudgetReservationRequest {
  attemptId: string;
  installationId: string;
  repositoryId: string;
  runId: string;
  providerId: string;
  dayUtc: string;
  maximumTokens: number;
  maximumCostMicros: number;
  runTokenLimit: number;
  dayTokenLimit: number;
  runCostLimitMicros: number;
  dayCostLimitMicros: number;
}

export interface EgressBudgetReservation {
  reservationId: string;
  reservedTokens: number;
  reservedCostMicros: number;
}

export interface EgressUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  currency: string;
}

export interface EgressBudgetStore {
  /** Must atomically reject a reservation that would cross any supplied run/day limit. */
  reserve(request: Readonly<EgressBudgetReservationRequest>): Promise<EgressBudgetReservation>;
  /** Must atomically finalize the reservation exactly once. The gateway never retries settlement. */
  settle(
    reservation: Readonly<EgressBudgetReservation>,
    usage: Readonly<EgressUsage>,
    status: "completed" | "blocked" | "failed",
  ): Promise<void>;
}

export interface EgressAttemptStartRecord {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  attemptId: string;
  previewId: string;
  consentId: string;
  authorizationId: string;
  installationId: string;
  repositoryId: string;
  runId: string;
  providerId: string;
  model: string;
  endpointOrigin: string;
  purpose: EgressPurpose;
  policyVersion: string;
  payloadDigest: string;
  payloadBytes: number;
  reservedTokens: number;
  reservedCostMicros: number;
  startedAt: string;
  recordDigest: string;
}

export interface EgressAttemptCompletionRecord {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  completionId: string;
  attemptId: string;
  status: "completed" | "blocked" | "failed";
  possiblyTransmitted: boolean;
  responseDigest: string | null;
  usage: EgressUsage;
  errorCode: EgressErrorCode | null;
  completedAt: string;
  recordDigest: string;
}

export interface EgressAuditSink {
  /** Must resolve only after the dispatch marker is durable. */
  recordStarted(record: Readonly<EgressAttemptStartRecord>): Promise<void>;
  recordCompleted(record: Readonly<EgressAttemptCompletionRecord>): Promise<void>;
}

export interface EgressCredentialResolver {
  /** The implementation must not persist, cache, log, or return the credential outside this callback. */
  withCredential<T>(
    reference: string,
    context: Readonly<{ providerId: string; endpointOrigin: string; attemptId: string }>,
    use: (credential: string) => Promise<T>,
  ): Promise<T>;
}

export interface EgressTransportResponse {
  statusCode: number;
  body: Uint8Array;
  usage: EgressUsage;
}

export interface EgressTransport {
  /** The gateway never retries this call. */
  send(
    request: Readonly<{
      endpoint: string;
      mediaType: string;
      body: Uint8Array;
      credential: string;
      attemptId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<EgressTransportResponse>;
}

export interface EgressRuntime {
  audit: EgressAuditSink;
  budgets: EgressBudgetStore;
  credentials: EgressCredentialResolver;
  transport: EgressTransport;
  revokedConsentIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  now?: () => string;
  scanSecrets?: (value: string) => SecretFinding[];
}

export interface EgressDispatchResult {
  schemaVersion: typeof EGRESS_SCHEMA_VERSION;
  attemptId: string;
  status: "completed";
  possiblyTransmitted: true;
  response: {
    statusCode: number;
    bodyUtf8: string;
    bodyDigest: string;
    untrustedProviderOutput: true;
  };
  usage: EgressUsage;
}

export type EgressErrorCode =
  | "invalid_request"
  | "policy_denied"
  | "secret_detected"
  | "scanner_failed"
  | "serializer_failed"
  | "preview_changed"
  | "consent_required"
  | "consent_invalid"
  | "consent_revoked"
  | "authorization_required"
  | "authorization_invalid"
  | "budget_exceeded"
  | "budget_settlement_failed"
  | "audit_unavailable"
  | "credential_unavailable"
  | "transport_failed"
  | "response_invalid"
  | "response_sensitive";

export class EgressGatewayError extends Error {
  readonly code: EgressErrorCode;
  readonly possiblyTransmitted: boolean;

  constructor(code: EgressErrorCode, possiblyTransmitted = false) {
    super(egressErrorMessage(code, possiblyTransmitted));
    this.name = "EgressGatewayError";
    this.code = code;
    this.possiblyTransmitted = possiblyTransmitted;
  }
}

export const canonicalJsonProviderSerializer: ProviderPayloadSerializer = Object.freeze({
  id: "context-atlas-canonical-json",
  version: "1.0.0",
  mediaType: "application/json; charset=utf-8",
  serialize(input: Readonly<ProviderPayloadInput>): string {
    return stableStringify(input);
  },
});

export function createEgressPreview(
  requestValue: EgressRequest,
  policyValue: EgressPolicy,
  serializer: ProviderPayloadSerializer = canonicalJsonProviderSerializer,
  options: { now?: () => string; scanSecrets?: (value: string) => SecretFinding[] } = {},
): EgressPreview {
  const request = validateRequest(requestValue);
  const policy = validatePolicy(policyValue);
  validateSerializer(serializer, request.provider);
  const endpoint = validateDestination(request.provider.endpoint);
  enforcePolicy(request, policy, endpoint.origin);
  const scan = options.scanSecrets ?? findSecrets;
  const redactions: EgressPreview["redactions"] = [];
  const segments = request.segments.map((segment) => {
    const findings = scanSafely(scan, segment.text);
    if (findings.length > 0 && policy.secretAction === "block") {
      throw new EgressGatewayError("secret_detected");
    }
    if (findings.length === 0) return { ...segment };
    const counts = new Map<string, number>();
    for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
    for (const [category, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
      redactions.push({ segmentId: segment.segmentId, category, count, action: "redact" });
    }
    return { ...segment, text: redactScannerFindings(segment.text, findings) };
  });
  const payloadInput = deepFreeze({
    schemaVersion: EGRESS_SCHEMA_VERSION,
    model: request.provider.model,
    purpose: request.purpose,
    templateVersion: request.provider.templateVersion,
    maxOutputTokens: request.maxOutputTokens,
    segments,
  }) as Readonly<ProviderPayloadInput>;
  let serialized: string | Uint8Array;
  try {
    serialized = Reflect.apply(serializer.serialize, undefined, [payloadInput]) as string | Uint8Array;
  } catch {
    throw new EgressGatewayError("serializer_failed");
  }
  const body = normalizeSerializedPayload(serialized);
  const bodyText = decodeUtf8(body, "serializer_failed");
  if (!Buffer.from(bodyText, "utf8").equals(Buffer.from(body))) {
    throw new EgressGatewayError("serializer_failed");
  }
  if (scanSafely(scan, bodyText).length > 0) throw new EgressGatewayError("secret_detected");
  if (!policy.allowRecognizableHostPaths && RECOGNIZABLE_HOST_PATH.test(bodyText)) {
    throw new EgressGatewayError("policy_denied");
  }
  const inputTokens = estimateTokens(bodyText);
  const maximumTotalTokens = checkedAdd(inputTokens, request.maxOutputTokens);
  const maximumCostMicros = checkedAdd(
    tokenCostMicros(inputTokens, request.provider.inputCostMicrosPerMillionTokens),
    tokenCostMicros(request.maxOutputTokens, request.provider.outputCostMicrosPerMillionTokens),
  );
  if (
    inputTokens > policy.maxInputTokensPerRun ||
    request.maxOutputTokens > policy.maxOutputTokensPerRun ||
    maximumTotalTokens > policy.maxTokensPerRun ||
    maximumCostMicros > policy.maxCostMicrosPerRun
  ) {
    throw new EgressGatewayError("budget_exceeded");
  }
  const requestDigest = sha256(stableStringify(request));
  const policyDigest = sha256(stableStringify(policy));
  const serializerDigest = egressSerializerDigest(serializer);
  const scopeDigest = egressScopeDigest(request, policy, endpoint.origin, serializer);
  const payloadDigest = sha256(Buffer.from(body));
  const previewId = `egress_preview_${sha256(`${scopeDigest}\0${payloadDigest}`).slice(0, 32)}`;
  return deepFreeze({
    schemaVersion: EGRESS_SCHEMA_VERSION,
    operation: "provider-egress-preview",
    dryRun: true,
    previewId,
    scopeDigest,
    generatedAt: safeNow(options.now ?? nowIso),
    destination: {
      providerId: request.provider.providerId,
      model: request.provider.model,
      endpoint: endpoint.href,
      retentionAssumption: request.provider.retentionAssumption,
    },
    purpose: request.purpose,
    policy: {
      policyVersion: policy.policyVersion,
      requestDigest,
      policyDigest,
      serializerDigest,
      gatewayVersion: EGRESS_GATEWAY_VERSION,
      scannerVersion: EGRESS_SCANNER_VERSION,
      redactorVersion: EGRESS_REDACTOR_VERSION,
      estimatorVersion: EGRESS_ESTIMATOR_VERSION,
      serializerId: serializer.id,
      serializerVersion: serializer.version,
      tokenizerVersion: request.provider.tokenizerVersion,
      pricingVersion: request.provider.pricingVersion,
    },
    payload: { mediaType: serializer.mediaType, utf8: bodyText, bytes: body.byteLength, digest: payloadDigest },
    redactions,
    usageEstimate: {
      inputTokens,
      maxOutputTokens: request.maxOutputTokens,
      maximumTotalTokens,
      maximumCostMicros,
      currency: request.provider.currency,
    },
    credential: { reference: request.provider.credentialReference, persistedSecret: false },
    consent: { scopeDigest, confirmationRequired: "ALLOW", perAttemptConfirmationRequired: "SEND" },
  } satisfies EgressPreview);
}

export function grantEgressConsent(
  preview: EgressPreview,
  request: EgressRequest,
  policy: EgressPolicy,
  options: { actor: string; reason: string; confirmation: "ALLOW"; now?: () => string },
): EgressConsentRecord {
  validatePreview(preview);
  const validatedRequest = validateRequest(request);
  const validatedPolicy = validatePolicy(policy);
  assertPreviewScopeBinding(preview, validatedRequest, validatedPolicy);
  if (options.confirmation !== "ALLOW" || !HUMAN_ACTOR.test(options.actor)) {
    throw new EgressGatewayError("consent_required");
  }
  const reason = safeHumanReason(options.reason);
  const grantedAt = safeNow(options.now ?? nowIso);
  const expiresAt = new Date(Date.parse(grantedAt) + validatedPolicy.consentTtlMinutes * 60_000).toISOString();
  const content = {
    schemaVersion: EGRESS_SCHEMA_VERSION,
    scopeDigest: preview.scopeDigest,
    installationId: validatedRequest.installationId,
    repositoryId: validatedRequest.repositoryId,
    actor: options.actor,
    reasonDigest: sha256(reason),
    grantedAt,
    expiresAt,
  };
  const recordDigest = sha256(stableStringify(content));
  return deepFreeze({
    ...content,
    consentId: `egress_consent_${recordDigest.slice(0, 32)}`,
    recordDigest,
  } satisfies EgressConsentRecord);
}

export function authorizeEgressAttempt(
  preview: EgressPreview,
  consent: EgressConsentRecord,
  policy: EgressPolicy,
  options: { actor: string; confirmation: "SEND"; now?: () => string },
): EgressAttemptAuthorization {
  validatePreview(preview);
  validateConsent(consent);
  const validatedPolicy = validatePolicy(policy);
  if (preview.policy.policyDigest !== sha256(stableStringify(validatedPolicy))) {
    throw new EgressGatewayError("preview_changed");
  }
  if (options.confirmation !== "SEND" || !HUMAN_ACTOR.test(options.actor)) {
    throw new EgressGatewayError("authorization_required");
  }
  const approvedAt = safeNow(options.now ?? nowIso);
  if (
    Date.parse(approvedAt) < Date.parse(consent.grantedAt) ||
    Date.parse(consent.expiresAt) <= Date.parse(approvedAt) ||
    consent.scopeDigest !== preview.scopeDigest
  ) {
    throw new EgressGatewayError("consent_invalid");
  }
  const expiresAt = new Date(
    Math.min(Date.parse(consent.expiresAt), Date.parse(approvedAt) + validatedPolicy.authorizationTtlMinutes * 60_000),
  ).toISOString();
  const content = {
    schemaVersion: EGRESS_SCHEMA_VERSION,
    consentId: consent.consentId,
    previewId: preview.previewId,
    scopeDigest: preview.scopeDigest,
    payloadDigest: preview.payload.digest,
    previewDigest: egressPreviewDigest(preview),
    actor: options.actor,
    approvedAt,
    expiresAt,
  };
  const recordDigest = sha256(stableStringify(content));
  return deepFreeze({
    ...content,
    authorizationId: `egress_authorization_${recordDigest.slice(0, 32)}`,
    recordDigest,
  } satisfies EgressAttemptAuthorization);
}

export function revokeEgressConsent(
  consent: EgressConsentRecord,
  options: { actor: string; reason: string; now?: () => string },
): EgressConsentRevocation {
  validateConsent(consent);
  if (!HUMAN_ACTOR.test(options.actor)) throw new EgressGatewayError("consent_invalid");
  const reason = safeHumanReason(options.reason);
  const content = {
    schemaVersion: EGRESS_SCHEMA_VERSION,
    consentId: consent.consentId,
    actor: options.actor,
    reasonDigest: sha256(reason),
    revokedAt: safeNow(options.now ?? nowIso),
  };
  const recordDigest = sha256(stableStringify(content));
  return deepFreeze({
    ...content,
    revocationId: `egress_revocation_${recordDigest.slice(0, 32)}`,
    recordDigest,
  } satisfies EgressConsentRevocation);
}

export async function dispatchEgress(
  request: EgressRequest,
  policy: EgressPolicy,
  serializer: ProviderPayloadSerializer,
  preview: EgressPreview,
  consent: EgressConsentRecord,
  authorization: EgressAttemptAuthorization,
  runtime: EgressRuntime,
): Promise<EgressDispatchResult> {
  validateRuntime(runtime);
  const now = runtime.now ?? nowIso;
  validatePreview(preview);
  const rebuilt = createEgressPreview(request, policy, serializer, {
    now: () => preview.generatedAt,
    ...(runtime.scanSecrets ? { scanSecrets: runtime.scanSecrets } : {}),
  });
  if (!samePreviewBoundary(preview, rebuilt)) throw new EgressGatewayError("preview_changed");
  validateConsent(consent);
  validateAuthorization(authorization);
  const validatedPolicy = validatePolicy(policy);
  const validatedRequest = validateRequest(request);
  assertPreviewScopeBinding(preview, validatedRequest, validatedPolicy);
  const currentIso = safeNow(now);
  const currentTime = Date.parse(currentIso);
  let revoked = false;
  try {
    revoked = runtime.revokedConsentIds?.has(consent.consentId) ?? false;
  } catch {
    throw new EgressGatewayError("consent_invalid");
  }
  if (revoked) throw new EgressGatewayError("consent_revoked");
  if (
    consent.scopeDigest !== preview.scopeDigest ||
    consent.installationId !== validatedRequest.installationId ||
    consent.repositoryId !== validatedRequest.repositoryId ||
    Date.parse(consent.grantedAt) > currentTime ||
    Date.parse(consent.expiresAt) <= currentTime
  ) {
    throw new EgressGatewayError("consent_invalid");
  }
  if (
    authorization.consentId !== consent.consentId ||
    authorization.previewId !== preview.previewId ||
    authorization.scopeDigest !== preview.scopeDigest ||
    authorization.payloadDigest !== preview.payload.digest ||
    authorization.previewDigest !== egressPreviewDigest(preview) ||
    Date.parse(authorization.approvedAt) > currentTime ||
    Date.parse(authorization.expiresAt) <= currentTime
  ) {
    throw new EgressGatewayError("authorization_invalid");
  }
  const attemptId = `egress_attempt_${randomUUID()}`;
  const reservationRequest: EgressBudgetReservationRequest = {
    attemptId,
    installationId: validatedRequest.installationId,
    repositoryId: validatedRequest.repositoryId,
    runId: validatedRequest.runId,
    providerId: validatedRequest.provider.providerId,
    dayUtc: new Date(currentTime).toISOString().slice(0, 10),
    maximumTokens: preview.usageEstimate.maximumTotalTokens,
    maximumCostMicros: preview.usageEstimate.maximumCostMicros,
    runTokenLimit: validatedPolicy.maxTokensPerRun,
    dayTokenLimit: validatedPolicy.maxTokensPerDay,
    runCostLimitMicros: validatedPolicy.maxCostMicrosPerRun,
    dayCostLimitMicros: validatedPolicy.maxCostMicrosPerDay,
  };
  let reservation: EgressBudgetReservation;
  try {
    reservation = validateReservation(await runtime.budgets.reserve(deepFreeze({ ...reservationRequest })), reservationRequest);
  } catch {
    throw new EgressGatewayError("budget_exceeded");
  }
  let possiblyTransmitted = false;
  let settlementAttempted = false;
  let completionAttempted = false;
  const settleOnce = async (settledUsage: EgressUsage, status: "completed" | "blocked" | "failed"): Promise<void> => {
    if (settlementAttempted) throw new EgressGatewayError("budget_settlement_failed", possiblyTransmitted);
    settlementAttempted = true;
    try {
      await runtime.budgets.settle(reservation, deepFreeze({ ...settledUsage }), status);
    } catch {
      throw new EgressGatewayError("budget_settlement_failed", possiblyTransmitted);
    }
  };
  const completeOnce = async (
    status: "completed" | "blocked" | "failed",
    transmitted: boolean,
    responseDigest: string | null,
    completedUsage: EgressUsage,
    errorCode: EgressErrorCode | null,
  ): Promise<void> => {
    if (completionAttempted) throw new EgressGatewayError("audit_unavailable", transmitted);
    completionAttempted = true;
    const completion = createAttemptCompletion(
      attemptId,
      status,
      transmitted,
      responseDigest,
      completedUsage,
      errorCode,
      bestEffortNow(now, currentIso),
    );
    try {
      await runtime.audit.recordCompleted(completion);
    } catch {
      throw new EgressGatewayError("audit_unavailable", transmitted);
    }
  };
  const start = createAttemptStart(attemptId, preview, consent, authorization, validatedRequest, reservation, currentIso);
  try {
    await runtime.audit.recordStarted(start);
  } catch {
    await settleOnce(zeroUsage(validatedRequest.provider.currency), "blocked");
    throw new EgressGatewayError("audit_unavailable");
  }

  let responseDigest: string | null = null;
  let usage = zeroUsage(validatedRequest.provider.currency);
  let usageValidated = false;
  try {
    let credentialCallbackCalls = 0;
    let callbackClosed = false;
    let transportPromise: Promise<EgressTransportResponse> | null = null;
    await runtime.credentials.withCredential(
      validatedRequest.provider.credentialReference,
      deepFreeze({
        providerId: validatedRequest.provider.providerId,
        endpointOrigin: new URL(validatedRequest.provider.endpoint).origin,
        attemptId,
      }),
      async (credential) => {
        credentialCallbackCalls += 1;
        if (callbackClosed || credentialCallbackCalls !== 1) {
          throw new EgressGatewayError("credential_unavailable", possiblyTransmitted);
        }
        if (typeof credential !== "string" || credential.length < 1 || credential.length > 16_384) {
          throw new EgressGatewayError("credential_unavailable");
        }
        possiblyTransmitted = true;
        transportPromise = (async () => {
          try {
            return (await Reflect.apply(runtime.transport.send, undefined, [
              deepFreeze({
                endpoint: preview.destination.endpoint,
                mediaType: preview.payload.mediaType,
                body: Buffer.from(preview.payload.utf8, "utf8"),
                credential,
                attemptId,
                ...(runtime.signal ? { signal: runtime.signal } : {}),
              }),
            ])) as EgressTransportResponse;
          } catch {
            throw new EgressGatewayError("transport_failed", true);
          }
        })();
        return await transportPromise;
      },
    );
    callbackClosed = true;
    if (credentialCallbackCalls !== 1 || transportPromise === null) {
      throw new EgressGatewayError("credential_unavailable", possiblyTransmitted);
    }
    const response = await transportPromise;
    const validatedResponse = validateTransportResponse(response, validatedRequest.provider.currency, reservation, preview);
    usage = validatedResponse.usage;
    usageValidated = true;
    responseDigest = sha256(Buffer.from(validatedResponse.body));
    const responseText = decodeUtf8(validatedResponse.body, "response_invalid");
    try {
      if (scanSafely(runtime.scanSecrets ?? findSecrets, responseText).length > 0) {
        throw new EgressGatewayError("response_sensitive", true);
      }
    } catch (error) {
      throw reclassifyAfterTransmission(error);
    }
    const completedAt = bestEffortNow(now, currentIso);
    await settleOnce(usage, "completed");
    if (completionAttempted) throw new EgressGatewayError("audit_unavailable", true);
    completionAttempted = true;
    const completion = createAttemptCompletion(attemptId, "completed", true, responseDigest, usage, null, completedAt);
    try {
      await runtime.audit.recordCompleted(completion);
    } catch {
      throw new EgressGatewayError("audit_unavailable", true);
    }
    return deepFreeze({
      schemaVersion: EGRESS_SCHEMA_VERSION,
      attemptId,
      status: "completed",
      possiblyTransmitted: true,
      response: {
        statusCode: validatedResponse.statusCode,
        bodyUtf8: responseText,
        bodyDigest: responseDigest,
        untrustedProviderOutput: true,
      },
      usage,
    } satisfies EgressDispatchResult);
  } catch (error) {
    let gatewayError = normalizeDispatchError(error, possiblyTransmitted);
    const status = possiblyTransmitted ? "failed" : "blocked";
    if (!settlementAttempted) {
      const settlementUsage = usageValidated
        ? usage
        : possiblyTransmitted
          ? reservedUsage(reservation, validatedRequest.provider.currency)
          : usage;
      try {
        await settleOnce(settlementUsage, status);
      } catch (settlementError) {
        gatewayError = normalizeDispatchError(settlementError, possiblyTransmitted);
      }
      usage = settlementUsage;
    }
    if (!completionAttempted) {
      try {
        await completeOnce(status, possiblyTransmitted, responseDigest, usage, gatewayError.code);
      } catch (completionError) {
        throw normalizeDispatchError(completionError, possiblyTransmitted);
      }
    }
    throw gatewayError;
  }
}

export function egressConsentRecordDigest(record: Omit<EgressConsentRecord, "consentId" | "recordDigest">): string {
  return sha256(stableStringify(record));
}

export function egressAuthorizationRecordDigest(record: Omit<EgressAttemptAuthorization, "authorizationId" | "recordDigest">): string {
  return sha256(stableStringify(record));
}

function validateRequest(value: EgressRequest): EgressRequest {
  assertPlainData(value);
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "installationId,maxOutputTokens,provider,purpose,repositoryId,runId,schemaVersion,segments" ||
    value.schemaVersion !== EGRESS_SCHEMA_VERSION ||
    !validIdentifier(value.installationId) ||
    !validIdentifier(value.repositoryId) ||
    !validIdentifier(value.runId) ||
    !["component-purpose", "semantic-event-grouping", "change-impact", "missing-context"].includes(value.purpose) ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxOutputTokens > 1_000_000 ||
    !Array.isArray(value.segments) ||
    value.segments.length < 1 ||
    value.segments.length > 4_096
  ) {
    throw new EgressGatewayError("invalid_request");
  }
  validateProvider(value.provider);
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const segment of value.segments) {
    if (
      !isPlainRecord(segment) ||
      Object.keys(segment).sort().join(",") !== "dataClass,evidenceId,segmentId,text" ||
      !validIdentifier(segment.segmentId) ||
      !validIdentifier(segment.evidenceId) ||
      !["public", "internal"].includes(segment.dataClass) ||
      typeof segment.text !== "string" ||
      !segment.text ||
      segment.text.length > MAX_EGRESS_PAYLOAD_BYTES ||
      ids.has(segment.segmentId)
    )
      throw new EgressGatewayError("invalid_request");
    ids.add(segment.segmentId);
    totalBytes = checkedAdd(totalBytes, Buffer.byteLength(segment.text, "utf8"));
  }
  if (totalBytes > MAX_EGRESS_PAYLOAD_BYTES) throw new EgressGatewayError("invalid_request");
  return structuredClone(value);
}

function validateProvider(value: EgressProviderDescriptor): void {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "credentialReference,currency,endpoint,inputCostMicrosPerMillionTokens,model,outputCostMicrosPerMillionTokens,pricingVersion,providerId,retentionAssumption,serializerId,serializerVersion,templateVersion,tokenizerVersion" ||
    !validIdentifier(value.providerId) ||
    !validText(value.model, 200) ||
    !validText(value.retentionAssumption, 500) ||
    !validVersion(value.serializerId) ||
    !validVersion(value.serializerVersion) ||
    !validVersion(value.templateVersion) ||
    !validVersion(value.tokenizerVersion) ||
    !validVersion(value.pricingVersion) ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !CREDENTIAL_REFERENCE.test(value.credentialReference) ||
    findSecrets(value.credentialReference).length > 0 ||
    !nonNegativeInteger(value.inputCostMicrosPerMillionTokens) ||
    !nonNegativeInteger(value.outputCostMicrosPerMillionTokens)
  ) {
    throw new EgressGatewayError("invalid_request");
  }
  validateDestination(value.endpoint);
}

function validatePolicy(value: EgressPolicy): EgressPolicy {
  assertPlainData(value);
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !==
      "allowRecognizableHostPaths,allowedDataClasses,allowedEndpointOrigins,allowedProviderIds,allowedPurposes,authorizationTtlMinutes,consentTtlMinutes,maxCostMicrosPerDay,maxCostMicrosPerRun,maxInputTokensPerRun,maxOutputTokensPerRun,maxTokensPerDay,maxTokensPerRun,policyVersion,schemaVersion,secretAction" ||
    value.schemaVersion !== EGRESS_SCHEMA_VERSION ||
    !validVersion(value.policyVersion) ||
    !["block", "redact"].includes(value.secretAction) ||
    typeof value.allowRecognizableHostPaths !== "boolean"
  )
    throw new EgressGatewayError("invalid_request");
  validateUniqueStrings(value.allowedProviderIds, 128, validIdentifier);
  validateUniqueStrings(value.allowedEndpointOrigins, 128, (item) => {
    try {
      const url = new URL(item);
      return url.origin === item && url.protocol === "https:";
    } catch {
      return false;
    }
  });
  validateUniqueStrings(value.allowedPurposes, 4, (item) =>
    ["component-purpose", "semantic-event-grouping", "change-impact", "missing-context"].includes(item),
  );
  validateUniqueStrings(value.allowedDataClasses, 2, (item) => ["public", "internal"].includes(item));
  for (const limit of [
    value.maxInputTokensPerRun,
    value.maxOutputTokensPerRun,
    value.maxTokensPerRun,
    value.maxTokensPerDay,
    value.maxCostMicrosPerRun,
    value.maxCostMicrosPerDay,
    value.consentTtlMinutes,
    value.authorizationTtlMinutes,
  ])
    if (!Number.isSafeInteger(limit) || limit < 1) throw new EgressGatewayError("invalid_request");
  if (
    value.maxTokensPerRun > value.maxTokensPerDay ||
    value.maxCostMicrosPerRun > value.maxCostMicrosPerDay ||
    value.authorizationTtlMinutes > value.consentTtlMinutes
  )
    throw new EgressGatewayError("invalid_request");
  return structuredClone(value);
}

function validateSerializer(serializer: ProviderPayloadSerializer, provider: EgressProviderDescriptor): void {
  if (
    !serializer ||
    typeof serializer !== "object" ||
    !validVersion(serializer.id) ||
    !validVersion(serializer.version) ||
    serializer.id !== provider.serializerId ||
    serializer.version !== provider.serializerVersion ||
    typeof serializer.mediaType !== "string" ||
    !/^application\/[A-Za-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/i.test(serializer.mediaType) ||
    typeof serializer.serialize !== "function"
  )
    throw new EgressGatewayError("invalid_request");
}

function validateDestination(endpoint: string): URL {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href.length > 2_000) {
      throw new Error();
    }
    return url;
  } catch {
    throw new EgressGatewayError("invalid_request");
  }
}

function enforcePolicy(request: EgressRequest, policy: EgressPolicy, origin: string): void {
  if (
    !policy.allowedProviderIds.includes(request.provider.providerId) ||
    !policy.allowedEndpointOrigins.includes(origin) ||
    !policy.allowedPurposes.includes(request.purpose) ||
    request.segments.some((segment) => !policy.allowedDataClasses.includes(segment.dataClass))
  ) {
    throw new EgressGatewayError("policy_denied");
  }
}

function egressScopeDigest(
  request: EgressRequest,
  policy: EgressPolicy,
  endpointOrigin: string,
  serializer: Pick<ProviderPayloadSerializer, "id" | "version" | "mediaType">,
): string {
  return sha256(
    stableStringify({
      schemaVersion: EGRESS_SCHEMA_VERSION,
      gatewayVersion: EGRESS_GATEWAY_VERSION,
      requestDigest: sha256(stableStringify(request)),
      policyDigest: sha256(stableStringify(policy)),
      serializerDigest: egressSerializerDigest(serializer),
      installationId: request.installationId,
      repositoryId: request.repositoryId,
      providerId: request.provider.providerId,
      model: request.provider.model,
      endpoint: request.provider.endpoint,
      endpointOrigin,
      purpose: request.purpose,
      retentionAssumption: request.provider.retentionAssumption,
      credentialReference: request.provider.credentialReference,
      policyVersion: policy.policyVersion,
      secretAction: policy.secretAction,
      allowRecognizableHostPaths: policy.allowRecognizableHostPaths,
      dataClasses: [...new Set(request.segments.map((item) => item.dataClass))].sort(),
      serializerId: serializer.id,
      serializerVersion: serializer.version,
      serializerMediaType: serializer.mediaType,
      templateVersion: request.provider.templateVersion,
      scannerVersion: EGRESS_SCANNER_VERSION,
      redactorVersion: EGRESS_REDACTOR_VERSION,
      tokenizerVersion: request.provider.tokenizerVersion,
      pricingVersion: request.provider.pricingVersion,
      currency: request.provider.currency,
      price: {
        input: request.provider.inputCostMicrosPerMillionTokens,
        output: request.provider.outputCostMicrosPerMillionTokens,
      },
      limits: {
        maxInputTokensPerRun: policy.maxInputTokensPerRun,
        maxOutputTokensPerRun: policy.maxOutputTokensPerRun,
        maxTokensPerRun: policy.maxTokensPerRun,
        maxTokensPerDay: policy.maxTokensPerDay,
        maxCostMicrosPerRun: policy.maxCostMicrosPerRun,
        maxCostMicrosPerDay: policy.maxCostMicrosPerDay,
      },
    }),
  );
}

function egressSerializerDigest(serializer: Pick<ProviderPayloadSerializer, "id" | "version" | "mediaType">): string {
  return sha256(stableStringify({ id: serializer.id, version: serializer.version, mediaType: serializer.mediaType }));
}

function egressPreviewDigest(preview: EgressPreview): string {
  return sha256(stableStringify(preview));
}

function assertPreviewScopeBinding(preview: EgressPreview, request: EgressRequest, policy: EgressPolicy): void {
  const endpoint = validateDestination(request.provider.endpoint);
  const serializer = {
    id: preview.policy.serializerId,
    version: preview.policy.serializerVersion,
    mediaType: preview.payload.mediaType,
  };
  if (
    serializer.id !== request.provider.serializerId ||
    serializer.version !== request.provider.serializerVersion ||
    preview.policy.requestDigest !== sha256(stableStringify(request)) ||
    preview.policy.policyDigest !== sha256(stableStringify(policy)) ||
    preview.policy.serializerDigest !== egressSerializerDigest(serializer) ||
    preview.scopeDigest !== egressScopeDigest(request, policy, endpoint.origin, serializer) ||
    preview.destination.providerId !== request.provider.providerId ||
    preview.destination.model !== request.provider.model ||
    preview.destination.endpoint !== endpoint.href ||
    preview.destination.retentionAssumption !== request.provider.retentionAssumption ||
    preview.purpose !== request.purpose ||
    preview.policy.policyVersion !== policy.policyVersion ||
    preview.policy.tokenizerVersion !== request.provider.tokenizerVersion ||
    preview.policy.pricingVersion !== request.provider.pricingVersion ||
    preview.usageEstimate.currency !== request.provider.currency ||
    preview.credential.reference !== request.provider.credentialReference
  ) {
    throw new EgressGatewayError("preview_changed");
  }
}

function validatePreview(preview: EgressPreview): void {
  assertPlainData(preview);
  if (
    preview.schemaVersion !== EGRESS_SCHEMA_VERSION ||
    preview.operation !== "provider-egress-preview" ||
    preview.dryRun !== true ||
    !/^egress_preview_[a-f0-9]{32}$/.test(preview.previewId) ||
    !SHA256.test(preview.scopeDigest) ||
    !SHA256.test(preview.payload.digest) ||
    preview.previewId !== `egress_preview_${sha256(`${preview.scopeDigest}\0${preview.payload.digest}`).slice(0, 32)}` ||
    !validTimestamp(preview.generatedAt) ||
    !SHA256.test(preview.policy.requestDigest) ||
    !SHA256.test(preview.policy.policyDigest) ||
    !SHA256.test(preview.policy.serializerDigest) ||
    preview.policy.gatewayVersion !== EGRESS_GATEWAY_VERSION ||
    preview.policy.scannerVersion !== EGRESS_SCANNER_VERSION ||
    preview.policy.redactorVersion !== EGRESS_REDACTOR_VERSION ||
    preview.policy.estimatorVersion !== EGRESS_ESTIMATOR_VERSION ||
    preview.consent.scopeDigest !== preview.scopeDigest ||
    preview.consent.confirmationRequired !== "ALLOW" ||
    preview.consent.perAttemptConfirmationRequired !== "SEND" ||
    preview.credential.persistedSecret !== false ||
    !CREDENTIAL_REFERENCE.test(preview.credential.reference) ||
    findSecrets(preview.credential.reference).length > 0 ||
    preview.payload.bytes < 1 ||
    preview.payload.bytes > MAX_EGRESS_PAYLOAD_BYTES ||
    sha256(Buffer.from(preview.payload.utf8, "utf8")) !== preview.payload.digest ||
    Buffer.byteLength(preview.payload.utf8, "utf8") !== preview.payload.bytes ||
    !nonNegativeInteger(preview.usageEstimate.inputTokens) ||
    !nonNegativeInteger(preview.usageEstimate.maxOutputTokens) ||
    !nonNegativeInteger(preview.usageEstimate.maximumTotalTokens) ||
    !nonNegativeInteger(preview.usageEstimate.maximumCostMicros) ||
    !/^[A-Z]{3}$/.test(preview.usageEstimate.currency)
  ) {
    throw new EgressGatewayError("preview_changed");
  }
}

function validateConsent(consent: EgressConsentRecord): void {
  assertPlainData(consent);
  const { consentId: _id, recordDigest: _digest, ...content } = consent;
  const expected = egressConsentRecordDigest(content);
  if (
    !/^egress_consent_[a-f0-9]{32}$/.test(consent.consentId) ||
    consent.consentId !== `egress_consent_${expected.slice(0, 32)}` ||
    consent.recordDigest !== expected ||
    !SHA256.test(consent.scopeDigest) ||
    !HUMAN_ACTOR.test(consent.actor) ||
    !SHA256.test(consent.reasonDigest) ||
    !validIdentifier(consent.installationId) ||
    !validIdentifier(consent.repositoryId) ||
    !validTimestamp(consent.grantedAt) ||
    !validTimestamp(consent.expiresAt) ||
    Date.parse(consent.expiresAt) <= Date.parse(consent.grantedAt)
  ) {
    throw new EgressGatewayError("consent_invalid");
  }
}

function validateAuthorization(authorization: EgressAttemptAuthorization): void {
  assertPlainData(authorization);
  const { authorizationId: _id, recordDigest: _digest, ...content } = authorization;
  const expected = egressAuthorizationRecordDigest(content);
  if (
    !/^egress_authorization_[a-f0-9]{32}$/.test(authorization.authorizationId) ||
    authorization.authorizationId !== `egress_authorization_${expected.slice(0, 32)}` ||
    authorization.recordDigest !== expected ||
    !SHA256.test(authorization.scopeDigest) ||
    !SHA256.test(authorization.payloadDigest) ||
    !SHA256.test(authorization.previewDigest) ||
    !HUMAN_ACTOR.test(authorization.actor) ||
    !validTimestamp(authorization.approvedAt) ||
    !validTimestamp(authorization.expiresAt) ||
    Date.parse(authorization.expiresAt) <= Date.parse(authorization.approvedAt)
  ) {
    throw new EgressGatewayError("authorization_invalid");
  }
}

function createAttemptStart(
  attemptId: string,
  preview: EgressPreview,
  consent: EgressConsentRecord,
  authorization: EgressAttemptAuthorization,
  request: EgressRequest,
  reservation: EgressBudgetReservation,
  startedAt: string,
): EgressAttemptStartRecord {
  const content = {
    schemaVersion: EGRESS_SCHEMA_VERSION,
    attemptId,
    previewId: preview.previewId,
    consentId: consent.consentId,
    authorizationId: authorization.authorizationId,
    installationId: request.installationId,
    repositoryId: request.repositoryId,
    runId: request.runId,
    providerId: request.provider.providerId,
    model: request.provider.model,
    endpointOrigin: new URL(request.provider.endpoint).origin,
    purpose: request.purpose,
    policyVersion: preview.policy.policyVersion,
    payloadDigest: preview.payload.digest,
    payloadBytes: preview.payload.bytes,
    reservedTokens: reservation.reservedTokens,
    reservedCostMicros: reservation.reservedCostMicros,
    startedAt,
  };
  return deepFreeze({ ...content, recordDigest: sha256(stableStringify(content)) });
}

function createAttemptCompletion(
  attemptId: string,
  status: "completed" | "blocked" | "failed",
  possiblyTransmitted: boolean,
  responseDigest: string | null,
  usage: EgressUsage,
  errorCode: EgressErrorCode | null,
  completedAt: string,
): EgressAttemptCompletionRecord {
  const content = {
    schemaVersion: EGRESS_SCHEMA_VERSION,
    completionId: `egress_completion_${sha256(`${attemptId}\0${completedAt}`).slice(0, 32)}`,
    attemptId,
    status,
    possiblyTransmitted,
    responseDigest,
    usage,
    errorCode,
    completedAt,
  };
  return deepFreeze({ ...content, recordDigest: sha256(stableStringify(content)) });
}

function validateReservation(value: EgressBudgetReservation, expected: EgressBudgetReservationRequest): EgressBudgetReservation {
  if (
    !isPlainRecord(value) ||
    !validIdentifier(value.reservationId) ||
    Object.keys(value).sort().join(",") !== "reservationId,reservedCostMicros,reservedTokens" ||
    !nonNegativeInteger(value.reservedTokens) ||
    !nonNegativeInteger(value.reservedCostMicros) ||
    value.reservedTokens !== expected.maximumTokens ||
    value.reservedCostMicros !== expected.maximumCostMicros
  ) {
    throw new EgressGatewayError("budget_exceeded");
  }
  return deepFreeze({ ...value });
}

function validateTransportResponse(
  value: EgressTransportResponse,
  expectedCurrency: string,
  reservation: EgressBudgetReservation,
  preview: EgressPreview,
): EgressTransportResponse {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "body,statusCode,usage" ||
    !Number.isInteger(value.statusCode) ||
    value.statusCode < 200 ||
    value.statusCode > 299 ||
    !(value.body instanceof Uint8Array) ||
    value.body.byteLength > MAX_EGRESS_RESPONSE_BYTES ||
    !isPlainRecord(value.usage) ||
    Object.keys(value.usage).sort().join(",") !== "costMicros,currency,inputTokens,outputTokens,totalTokens" ||
    value.usage.currency !== expectedCurrency ||
    !nonNegativeInteger(value.usage.inputTokens) ||
    !nonNegativeInteger(value.usage.outputTokens) ||
    !nonNegativeInteger(value.usage.totalTokens) ||
    !nonNegativeInteger(value.usage.costMicros) ||
    value.usage.inputTokens + value.usage.outputTokens !== value.usage.totalTokens ||
    !Number.isSafeInteger(value.usage.inputTokens + value.usage.outputTokens) ||
    value.usage.outputTokens > preview.usageEstimate.maxOutputTokens ||
    value.usage.totalTokens > reservation.reservedTokens ||
    value.usage.costMicros > reservation.reservedCostMicros
  ) {
    throw new EgressGatewayError("response_invalid", true);
  }
  return {
    statusCode: value.statusCode,
    body: Buffer.from(value.body),
    usage: { ...value.usage },
  };
}

function normalizeSerializedPayload(value: string | Uint8Array): Uint8Array {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new EgressGatewayError("serializer_failed");
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (body.byteLength < 1 || body.byteLength > MAX_EGRESS_PAYLOAD_BYTES || body.includes(0)) {
    throw new EgressGatewayError("serializer_failed");
  }
  return body;
}

function decodeUtf8(value: Uint8Array, code: "serializer_failed" | "response_invalid"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new EgressGatewayError(code, code === "response_invalid");
  }
}

function scanSafely(scanner: (value: string) => SecretFinding[], value: string): SecretFinding[] {
  try {
    const result = scanner(value);
    if (
      !Array.isArray(result) ||
      result.some(
        (item) =>
          !isPlainRecord(item) ||
          typeof item.kind !== "string" ||
          !Number.isSafeInteger(item.start) ||
          !Number.isSafeInteger(item.end) ||
          item.start < 0 ||
          item.end <= item.start ||
          item.end > value.length,
      )
    )
      throw new Error();
    return result;
  } catch {
    throw new EgressGatewayError("scanner_failed");
  }
}

function redactScannerFindings(value: string, findings: SecretFinding[]): string {
  const ordered = [...findings].sort(
    (left, right) => left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind),
  );
  const merged: Array<{ start: number; end: number; kinds: Set<string> }> = [];
  for (const finding of ordered) {
    const previous = merged.at(-1);
    if (previous && finding.start <= previous.end) {
      previous.end = Math.max(previous.end, finding.end);
      previous.kinds.add(finding.kind);
    } else {
      merged.push({ start: finding.start, end: finding.end, kinds: new Set([finding.kind]) });
    }
  }
  let redacted = value;
  for (const span of [...merged].reverse()) {
    const categories = [...span.kinds].sort().join("+");
    redacted = `${redacted.slice(0, span.start)}[REDACTED:${categories}]${redacted.slice(span.end)}`;
  }
  return redacted;
}

function safeNow(clock: () => string): string {
  let value: unknown;
  try {
    value = Reflect.apply(clock, undefined, []);
  } catch {
    throw new EgressGatewayError("invalid_request");
  }
  if (!validTimestamp(value)) throw new EgressGatewayError("invalid_request");
  return value;
}

function bestEffortNow(clock: () => string, fallback: string): string {
  try {
    return safeNow(clock);
  } catch {
    return fallback;
  }
}

function validateRuntime(runtime: EgressRuntime): void {
  if (
    !runtime ||
    typeof runtime !== "object" ||
    !runtime.audit ||
    typeof runtime.audit.recordStarted !== "function" ||
    typeof runtime.audit.recordCompleted !== "function" ||
    !runtime.budgets ||
    typeof runtime.budgets.reserve !== "function" ||
    typeof runtime.budgets.settle !== "function" ||
    !runtime.credentials ||
    typeof runtime.credentials.withCredential !== "function" ||
    !runtime.transport ||
    typeof runtime.transport.send !== "function" ||
    (runtime.now !== undefined && typeof runtime.now !== "function") ||
    (runtime.scanSecrets !== undefined && typeof runtime.scanSecrets !== "function") ||
    (runtime.revokedConsentIds !== undefined && typeof runtime.revokedConsentIds.has !== "function") ||
    (runtime.signal !== undefined && !(runtime.signal instanceof AbortSignal))
  ) {
    throw new EgressGatewayError("invalid_request");
  }
  if (runtime.signal?.aborted) throw new EgressGatewayError("transport_failed");
}

function reclassifyAfterTransmission(error: unknown): EgressGatewayError {
  if (error instanceof EgressGatewayError) {
    return error.possiblyTransmitted ? error : new EgressGatewayError(error.code, true);
  }
  return new EgressGatewayError("response_invalid", true);
}

function normalizeDispatchError(error: unknown, possiblyTransmitted: boolean): EgressGatewayError {
  if (error instanceof EgressGatewayError) {
    return possiblyTransmitted && !error.possiblyTransmitted ? new EgressGatewayError(error.code, true) : error;
  }
  return new EgressGatewayError(possiblyTransmitted ? "transport_failed" : "credential_unavailable", possiblyTransmitted);
}

function reservedUsage(reservation: EgressBudgetReservation, currency: string): EgressUsage {
  return {
    inputTokens: reservation.reservedTokens,
    outputTokens: 0,
    totalTokens: reservation.reservedTokens,
    costMicros: reservation.reservedCostMicros,
    currency,
  };
}

function samePreviewBoundary(left: EgressPreview, right: EgressPreview): boolean {
  return stableStringify(left) === stableStringify(right);
}

function zeroUsage(currency: string): EgressUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0, currency };
}

function tokenCostMicros(tokens: number, pricePerMillion: number): number {
  const product = tokens * pricePerMillion;
  if (!Number.isSafeInteger(product)) throw new EgressGatewayError("budget_exceeded");
  return Math.ceil(product / 1_000_000);
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new EgressGatewayError("budget_exceeded");
  return sum;
}

function safeHumanReason(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    trimmed.length < 3 ||
    value.length > 1_000 ||
    findSecrets(value).length > 0 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
  ) {
    throw new EgressGatewayError("consent_invalid");
  }
  return trimmed;
}

function validateUniqueStrings(value: unknown, maximum: number, predicate: (item: string) => boolean): void {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !predicate(item)) ||
    new Set(value).size !== value.length
  )
    throw new EgressGatewayError("invalid_request");
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value) && findSecrets(value).length === 0;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value) && findSecrets(value).length === 0;
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) &&
    findSecrets(value).length === 0
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainData(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > 100_000) throw new EgressGatewayError("invalid_request");
    if (current === null || ["string", "number", "boolean"].includes(typeof current)) continue;
    if (typeof current !== "object") throw new EgressGatewayError("invalid_request");
    if (seen.has(current)) throw new EgressGatewayError("invalid_request");
    seen.add(current);
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || Object.keys(current).length !== current.length) {
        throw new EgressGatewayError("invalid_request");
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || descriptor.get || descriptor.set) throw new EgressGatewayError("invalid_request");
        pending.push(descriptor.value);
      }
      continue;
    }
    if (!isPlainRecord(current)) throw new EgressGatewayError("invalid_request");
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw new EgressGatewayError("invalid_request");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new EgressGatewayError("invalid_request");
      pending.push(descriptor.value);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    // Typed-array elements cannot be frozen in current JavaScript runtimes.
    // They are copied at every gateway boundary and are never reused after a
    // transport call, so freeze the containing record but leave the private
    // byte copy itself mutable to the transport implementation.
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function egressErrorMessage(code: EgressErrorCode, possiblyTransmitted: boolean): string {
  const suffix = possiblyTransmitted
    ? " The request may have been transmitted; do not retry automatically."
    : " No provider call was authorized.";
  return `Provider egress was refused (${code}).${suffix}`;
}

void FORBIDDEN_STATIC_HEADER;
