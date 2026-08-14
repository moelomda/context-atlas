import path from "node:path";
import { posixPath } from "./util.js";

export interface SecretFinding {
  kind: string;
  start: number;
  end: number;
}

const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "github-token", pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "credential-assignment", pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{12,}/gi },
  { kind: "connection-string", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/gi },
];

const SENSITIVE_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", "credentials", "credentials.json", "secrets.json",
  "id_rsa", "id_ed25519", ".npmrc", ".pypirc",
]);

export function isSensitivePath(relativePath: string): boolean {
  const normalized = posixPath(relativePath).toLowerCase();
  const base = path.posix.basename(normalized);
  return SENSITIVE_BASENAMES.has(base)
    || base.endsWith(".pem")
    || base.endsWith(".key")
    || base.endsWith(".p12")
    || /(^|\/)(?:secrets?|credentials?)(\/|\.|$)/.test(normalized)
    || /(^|\/)\.env(?:\.|$)/.test(normalized);
}

export function findSecrets(value: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index === undefined) continue;
      findings.push({ kind, start: match.index, end: match.index + match[0].length });
    }
  }
  return findings.sort((left, right) => left.start - right.start);
}

export function redactSecrets(value: string): { value: string; findings: SecretFinding[] } {
  const findings = findSecrets(value);
  let redacted = value;
  for (const finding of [...findings].sort((left, right) => right.start - left.start)) {
    redacted = `${redacted.slice(0, finding.start)}[REDACTED:${finding.kind}]${redacted.slice(finding.end)}`;
  }
  return { value: redacted, findings };
}

export function sanitizeText(value: string, maxLength = 2_000): { value: string; sensitive: boolean; findings: SecretFinding[] } {
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  const redacted = redactSecrets(clean);
  return {
    value: redacted.value.slice(0, maxLength),
    sensitive: redacted.findings.length > 0,
    findings: redacted.findings,
  };
}

export function isExcludedPath(relativePath: string, exclusions: string[]): boolean {
  const normalized = posixPath(relativePath).toLowerCase();
  return exclusions.some((excluded) => {
    const target = posixPath(excluded).toLowerCase().replace(/^\/+|\/+$/g, "");
    return normalized === target || normalized.startsWith(`${target}/`) || normalized.includes(`/${target}/`);
  });
}
