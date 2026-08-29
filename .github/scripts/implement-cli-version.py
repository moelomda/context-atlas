from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


Path("src/version.ts").write_text(
    '''import { readFileSync } from "node:fs";

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
''',
    encoding="utf-8",
)

replace_once(
    "src/cli.ts",
    'import { startWebServer } from "./web/server.js";',
    'import { getVersionInfo } from "./version.js";\nimport { startWebServer } from "./web/server.js";',
)
replace_once(
    "src/cli.ts",
    '''  if (["help", "--help", "-h", ""].includes(parsed.command)) {
    process.stdout.write(HELP);
    return;
  }
  assertAllowedOptions(parsed);

  if (parsed.command === "init") {''',
    '''  if (["help", "--help", "-h", ""].includes(parsed.command)) {
    process.stdout.write(HELP);
    return;
  }
  if (["version", "--version", "-v"].includes(parsed.command)) {
    requireExactPositionals(parsed, 0);
    const unsupported = [...parsed.options.keys()].filter((key) => key !== "json").sort();
    if (unsupported.length > 0) {
      throw new Error(`version does not accept ${unsupported.map((key) => `--${key}`).join(", ")}.`);
    }
    const version = getVersionInfo();
    if (json) output(version, true);
    else process.stdout.write(`${version.name} ${version.version}\\n`);
    return;
  }
  assertAllowedOptions(parsed);

  if (parsed.command === "init") {''',
)
replace_once(
    "src/cli.ts",
    '''Usage:
  context-atlas init [repo] [--name NAME] [--dry-run]''',
    '''Usage:
  context-atlas version [--json]
  context-atlas init [repo] [--name NAME] [--dry-run]''',
)

replace_once(
    "tests/cli.test.ts",
    'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";',
)
replace_once(
    "tests/cli.test.ts",
    'import { afterEach, test } from "node:test";\nimport path from "node:path";',
    'import { afterEach, test } from "node:test";\nimport { tmpdir } from "node:os";\nimport path from "node:path";',
)
replace_once(
    "tests/cli.test.ts",
    '''const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("CLI init preview is read-only and status exposes repository identity", () => {''',
    '''const fixtures: string[] = [];
afterEach(() => { while (fixtures.length) removeFixture(fixtures.pop() as string); });

test("CLI version is repository-independent and comes from package metadata", () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(projectRoot, "dist", "cli.js");
  const emptyRoot = mkdtempSync(path.join(tmpdir(), "context-atlas-cli-version-"));
  try {
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
      engines: { node: string };
    };
    const run = (args: string[]): string => execFileSync(process.execPath, [cli, ...args], {
      cwd: emptyRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    const expected = `${manifest.name} ${manifest.version}\\n`;
    assert.equal(run(["version"]), expected);
    assert.equal(run(["--version"]), expected);
    assert.equal(run(["-v"]), expected);

    const version = JSON.parse(run(["version", "--json"])) as {
      schemaVersion: number;
      name: string;
      version: string;
      supportedNodeRange: string;
      nodeVersion: string;
      platform: string;
      architecture: string;
    };
    assert.deepEqual(version, {
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version,
      supportedNodeRange: manifest.engines.node,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    });
    assert.deepEqual(readdirSync(emptyRoot), []);
    assert.throws(() => run(["version", "--repo", emptyRoot]), /version does not accept --repo/);
    assert.deepEqual(readdirSync(emptyRoot), []);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("CLI init preview is read-only and status exposes repository identity", () => {''',
)

replace_once(
    ".github/scripts/smoke-installed-package.mjs",
    'const fixtureRoot = mkdtempSync(path.join(tmpdir(), "context-atlas-installed-smoke-"));',
    '''const versionText = runCli(["version"]);
assert.equal(versionText, "context-atlas 0.1.0\\n");
assert.equal(runCli(["--version"]), versionText);
assert.equal(runCli(["-v"]), versionText);
const versionJson = parseJson(runCli(["version", "--json"]), "version");
assert.deepEqual(versionJson, {
  schemaVersion: 1,
  name: "context-atlas",
  version: "0.1.0",
  supportedNodeRange: ">=24.12.0 <25",
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
});
assert.equal(existsSync(path.join(installRoot, ".context-atlas")), false);

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "context-atlas-installed-smoke-"));''',
)

replace_once(
    "README.md",
    '''Run `node dist/cli.js help` for the complete command list. The main workflows are:

- Explore:''',
    '''Run `node dist/cli.js version` for concise installed-version output or `node dist/cli.js version --json` for a repository-independent diagnostic object. Run `node dist/cli.js help` for the complete command list. The main workflows are:

- Diagnose installation: `version`, `--version`, and `-v` work outside an initialized repository; `version --json` reports the package version, supported Node.js range, active Node.js version, platform, and architecture.
- Explore:''',
)

replace_once(
    "CHANGELOG.md",
    '''- Packed-product installation smoke coverage on Linux and Windows at the exact
  minimum supported Node.js runtime.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.''',
    '''- Packed-product installation smoke coverage on Linux and Windows at the exact
  minimum supported Node.js runtime.
- Repository-independent `version`, `--version`, and `-v` CLI diagnostics backed by package metadata, including a versioned JSON form used by tests and installed-product verification.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.''',
)
