import { readFileSync } from "node:fs";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  engines?: {
    node?: unknown;
  };
}

export interface VersionInfo {
  schemaVersion: 1;
  name: string;
  version: string;
  supportedNodeRange: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
}

const packageManifest = readPackageManifest();

export function getVersionInfo(): VersionInfo {
  return {
    schemaVersion: 1,
    name: packageManifest.name,
    version: packageManifest.version,
    supportedNodeRange: packageManifest.supportedNodeRange,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
}

function readPackageManifest(): { name: string; version: string; supportedNodeRange: string } {
  const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
  return {
    name: requiredString(parsed.name, "name"),
    version: requiredString(parsed.version, "version"),
    supportedNodeRange: requiredString(parsed.engines?.node, "engines.node"),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Package manifest field ${field} must be a non-empty string.`);
  }
  return value;
}
