import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeEgressAttempt,
  canonicalJsonProviderSerializer,
  createEgressPreview,
  dispatchEgress,
  EgressGatewayError,
  grantEgressConsent,
  revokeEgressConsent,
  type EgressAttemptCompletionRecord,
  type EgressAttemptStartRecord,
  type EgressBudgetReservation,
  type EgressBudgetReservationRequest,
  type EgressPolicy,
  type EgressRequest,
  type EgressRuntime,
  type EgressUsage,
} from "../src/core/egress.js";

const NOW = "2026-08-23T12:00:00.000Z";

test("egress preview is exact-byte, bounded, secret-scanned, and side-effect free", () => {
  const preview = createEgressPreview(request(), policy(), canonicalJsonProviderSerializer, { now: () => NOW });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.destination.endpoint, "https://provider.example.invalid/v1/context");
  assert.equal(Buffer.byteLength(preview.payload.utf8, "utf8"), preview.payload.bytes);
  assert.match(preview.payload.digest, /^[a-f0-9]{64}$/);
  assert.equal(preview.consent.confirmationRequired, "ALLOW");
  assert.equal(preview.consent.perAttemptConfirmationRequired, "SEND");

  assert.throws(
    () =>
      createEgressPreview(request({ segmentText: `token=${"x".repeat(32)}` }), policy(), canonicalJsonProviderSerializer, {
        now: () => NOW,
      }),
    gatewayError("secret_detected", false),
  );
  const redacted = createEgressPreview(
    request({ segmentText: `token=${"x".repeat(32)}` }),
    policy({ secretAction: "redact" }),
    canonicalJsonProviderSerializer,
    { now: () => NOW },
  );
  assert.doesNotMatch(redacted.payload.utf8, /x{32}/);
  assert.equal(redacted.redactions[0]?.category, "credential-assignment");
});

test("one consent and one attempt authorization permit exactly one audited provider call", async () => {
  const material = authorized();
  const fixture = runtimeFixture(material.preview.usageEstimate.inputTokens);
  const result = await dispatchEgress(
    material.request,
    material.policy,
    canonicalJsonProviderSerializer,
    material.preview,
    material.consent,
    material.authorization,
    fixture.runtime,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.possiblyTransmitted, true);
  assert.equal(result.response.untrustedProviderOutput, true);
  assert.equal(fixture.transportCalls, 1);
  assert.equal(fixture.credentialCalls, 1);
  assert.equal(fixture.reservations.length, 1);
  assert.equal(fixture.settlements.length, 1);
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.completions.length, 1);
  assert.equal(fixture.completions[0]?.status, "completed");
  assert.equal(fixture.starts[0]?.payloadDigest, material.preview.payload.digest);
});

test("changed previews, revoked consent, and missing confirmation block before transport", async () => {
  const material = authorized();
  assert.throws(
    () =>
      authorizeEgressAttempt(material.preview, material.consent, material.policy, {
        actor: "human:alice",
        confirmation: "NO" as "SEND",
        now: () => NOW,
      }),
    gatewayError("authorization_required", false),
  );
  const fixture = runtimeFixture(material.preview.usageEstimate.inputTokens, { revokedConsentId: material.consent.consentId });
  await assert.rejects(
    dispatchEgress(
      material.request,
      material.policy,
      canonicalJsonProviderSerializer,
      material.preview,
      material.consent,
      material.authorization,
      fixture.runtime,
    ),
    gatewayError("consent_revoked", false),
  );
  assert.equal(fixture.transportCalls, 0);
  assert.equal(fixture.reservations.length, 0);

  const changed = request({ segmentText: "Different approved bytes." });
  await assert.rejects(
    dispatchEgress(
      changed,
      material.policy,
      canonicalJsonProviderSerializer,
      material.preview,
      material.consent,
      material.authorization,
      runtimeFixture(material.preview.usageEstimate.inputTokens).runtime,
    ),
    gatewayError("preview_changed", false),
  );
});

test("transport and response failures are recorded as possibly transmitted and never retried", async () => {
  const material = authorized();
  const failed = runtimeFixture(material.preview.usageEstimate.inputTokens, { transportFailure: true });
  await assert.rejects(
    dispatchEgress(
      material.request,
      material.policy,
      canonicalJsonProviderSerializer,
      material.preview,
      material.consent,
      material.authorization,
      failed.runtime,
    ),
    gatewayError("transport_failed", true),
  );
  assert.equal(failed.transportCalls, 1);
  assert.equal(failed.settlements[0]?.status, "failed");
  assert.equal(failed.completions[0]?.possiblyTransmitted, true);

  const sensitive = runtimeFixture(material.preview.usageEstimate.inputTokens, { sensitiveResponse: true });
  await assert.rejects(
    dispatchEgress(
      material.request,
      material.policy,
      canonicalJsonProviderSerializer,
      material.preview,
      material.consent,
      material.authorization,
      sensitive.runtime,
    ),
    gatewayError("response_sensitive", true),
  );
  assert.equal(sensitive.transportCalls, 1);
  assert.equal(sensitive.completions[0]?.errorCode, "response_sensitive");
});

test("durable audit start is required before credential resolution or transmission", async () => {
  const material = authorized();
  const fixture = runtimeFixture(material.preview.usageEstimate.inputTokens, { startAuditFailure: true });
  await assert.rejects(
    dispatchEgress(
      material.request,
      material.policy,
      canonicalJsonProviderSerializer,
      material.preview,
      material.consent,
      material.authorization,
      fixture.runtime,
    ),
    gatewayError("audit_unavailable", false),
  );
  assert.equal(fixture.transportCalls, 0);
  assert.equal(fixture.credentialCalls, 0);
  assert.equal(fixture.settlements[0]?.status, "blocked");
});

test("consent revocation is immutable, attributed, and secret-safe", () => {
  const material = authorized();
  const revocation = revokeEgressConsent(material.consent, {
    actor: "human:alice",
    reason: "Provider access is no longer required.",
    now: () => "2026-08-23T12:01:00.000Z",
  });
  assert.equal(revocation.consentId, material.consent.consentId);
  assert.match(revocation.recordDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(revocation), true);
});

function request(options: { segmentText?: string } = {}): EgressRequest {
  return {
    schemaVersion: 1,
    installationId: "installation_fixture",
    repositoryId: "repository_fixture",
    runId: "run_fixture",
    purpose: "component-purpose",
    provider: {
      providerId: "provider_fixture",
      model: "model-v1",
      endpoint: "https://provider.example.invalid/v1/context",
      retentionAssumption: "No training; transient processing under the selected provider policy.",
      credentialReference: "credential-store:provider_fixture",
      serializerId: canonicalJsonProviderSerializer.id,
      serializerVersion: canonicalJsonProviderSerializer.version,
      templateVersion: "component-purpose-v1",
      tokenizerVersion: "fixture-tokenizer-v1",
      pricingVersion: "fixture-pricing-v1",
      inputCostMicrosPerMillionTokens: 0,
      outputCostMicrosPerMillionTokens: 0,
      currency: "USD",
    },
    maxOutputTokens: 64,
    segments: [
      {
        segmentId: "segment_readme",
        evidenceId: "evidence_readme",
        dataClass: "internal",
        text: options.segmentText ?? "Fixture Shop processes subscription charges.",
      },
    ],
  };
}

function policy(overrides: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    schemaVersion: 1,
    policyVersion: "egress-policy-v1",
    allowedProviderIds: ["provider_fixture"],
    allowedEndpointOrigins: ["https://provider.example.invalid"],
    allowedPurposes: ["component-purpose"],
    allowedDataClasses: ["internal"],
    secretAction: "block",
    allowRecognizableHostPaths: false,
    maxInputTokensPerRun: 10_000,
    maxOutputTokensPerRun: 1_000,
    maxTokensPerRun: 11_000,
    maxTokensPerDay: 100_000,
    maxCostMicrosPerRun: 10_000,
    maxCostMicrosPerDay: 100_000,
    consentTtlMinutes: 60,
    authorizationTtlMinutes: 10,
    ...overrides,
  };
}

function authorized() {
  const requestValue = request();
  const policyValue = policy();
  const preview = createEgressPreview(requestValue, policyValue, canonicalJsonProviderSerializer, { now: () => NOW });
  const consent = grantEgressConsent(preview, requestValue, policyValue, {
    actor: "human:alice",
    reason: "Use the selected provider for this bounded component summary.",
    confirmation: "ALLOW",
    now: () => NOW,
  });
  const authorization = authorizeEgressAttempt(preview, consent, policyValue, {
    actor: "human:alice",
    confirmation: "SEND",
    now: () => NOW,
  });
  return { request: requestValue, policy: policyValue, preview, consent, authorization };
}

function runtimeFixture(
  inputTokens: number,
  options: {
    revokedConsentId?: string;
    transportFailure?: boolean;
    sensitiveResponse?: boolean;
    startAuditFailure?: boolean;
  } = {},
) {
  const starts: EgressAttemptStartRecord[] = [];
  const completions: EgressAttemptCompletionRecord[] = [];
  const reservations: EgressBudgetReservationRequest[] = [];
  const settlements: Array<{ reservation: EgressBudgetReservation; usage: EgressUsage; status: string }> = [];
  let transportCalls = 0;
  let credentialCalls = 0;
  const runtime: EgressRuntime = {
    now: () => NOW,
    revokedConsentIds: new Set(options.revokedConsentId ? [options.revokedConsentId] : []),
    audit: {
      async recordStarted(record) {
        if (options.startAuditFailure) throw new Error("fixture audit unavailable");
        starts.push(structuredClone(record));
      },
      async recordCompleted(record) {
        completions.push(structuredClone(record));
      },
    },
    budgets: {
      async reserve(requestValue) {
        reservations.push(structuredClone(requestValue));
        return {
          reservationId: `reservation_${requestValue.attemptId}`,
          reservedTokens: requestValue.maximumTokens,
          reservedCostMicros: requestValue.maximumCostMicros,
        };
      },
      async settle(reservation, usage, status) {
        settlements.push({ reservation: structuredClone(reservation), usage: structuredClone(usage), status });
      },
    },
    credentials: {
      async withCredential(_reference, _context, use) {
        credentialCalls += 1;
        return use("fixture-credential-value");
      },
    },
    transport: {
      async send() {
        transportCalls += 1;
        if (options.transportFailure) throw new Error("fixture transport failure");
        const body = Buffer.from(options.sensitiveResponse ? `token=${"y".repeat(32)}` : "Provider summary.", "utf8");
        return {
          statusCode: 200,
          body,
          usage: {
            inputTokens,
            outputTokens: 4,
            totalTokens: inputTokens + 4,
            costMicros: 0,
            currency: "USD",
          },
        };
      },
    },
  };
  return {
    runtime,
    starts,
    completions,
    reservations,
    settlements,
    get transportCalls() {
      return transportCalls;
    },
    get credentialCalls() {
      return credentialCalls;
    },
  };
}

function gatewayError(code: string, possiblyTransmitted: boolean): (error: unknown) => boolean {
  return (error): boolean =>
    error instanceof EgressGatewayError && error.code === code && error.possiblyTransmitted === possiblyTransmitted;
}
