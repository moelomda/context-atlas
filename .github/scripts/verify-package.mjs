import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const reportPath = resolve(process.argv[2] ?? "npm-pack.json");
// Windows PowerShell 5 may add a UTF-8 BOM when redirecting JSON. GitHub's
// Ubuntu runner does not, but accepting either form keeps local release audits
// equivalent across maintainer platforms.
const reportText = readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "");
const parsed = JSON.parse(reportText);

if (!Array.isArray(parsed) || parsed.length !== 1) {
  throw new Error("Expected npm pack to describe exactly one package");
}

const report = parsed[0];
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (report.name !== manifest.name || report.version !== manifest.version) {
  throw new Error(
    `Packed identity ${report.name}@${report.version} does not match package.json ${manifest.name}@${manifest.version}`,
  );
}
if (report.filename !== `${manifest.name}-${manifest.version}.tgz`) {
  throw new Error(`Unexpected package filename: ${report.filename}`);
}
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(report.integrity ?? "")) {
  throw new Error("npm pack report is missing a valid SHA-512 integrity value");
}
if (!/^[a-f0-9]{40}$/.test(report.shasum ?? "")) {
  throw new Error("npm pack report is missing a valid SHA-1 compatibility checksum");
}
if (report.size > 10 * 1024 * 1024 || report.unpackedSize > 50 * 1024 * 1024) {
  throw new Error(
    `Package exceeds release size ceiling (${report.size} compressed; ${report.unpackedSize} unpacked)`,
  );
}

const fileEntries = report.files ?? [];
const paths = new Set(fileEntries.map((entry) => entry.path));
if (paths.size !== fileEntries.length) {
  throw new Error("npm pack report contains duplicate archive paths");
}
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli.js",
  "dist/mcp/server.js",
  "dist/web/public/index.html",
  "plugin/context-atlas/.codex-plugin/plugin.json",
  "plugin/context-atlas/.mcp.json",
  "plugin/context-atlas/runtime/server.mjs",
  "plugin/context-atlas/skills/context-atlas/SKILL.md",
];

const missing = required.filter((path) => !paths.has(path));
if (missing.length > 0) {
  throw new Error(`Package is missing required files: ${missing.join(", ")}`);
}

const forbidden = [
  /^(?:src|tests|node_modules|coverage|\.context-atlas)(?:\/|$)/,
  /(?:^|\/)(?:atlas\.db(?:-.+)?|ledger\.ndjson)$/,
  /(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx))$/i,
  /(?:^|\/)(?:backups|exports)(?:\/|$)/,
];
const leaked = [...paths].filter((path) =>
  forbidden.some((pattern) => pattern.test(path)),
);
if (leaked.length > 0) {
  throw new Error(`Package contains forbidden local/development files: ${leaked.join(", ")}`);
}

if (!report.filename || typeof report.filename !== "string") {
  throw new Error("npm pack report did not include an archive filename");
}

const candidate = resolve(dirname(reportPath), basename(report.filename));
const archivePath = existsSync(candidate)
  ? candidate
  : resolve(dirname(reportPath), report.filename);
if (!existsSync(archivePath)) {
  throw new Error(`Package archive does not exist: ${archivePath}`);
}

console.log(
  `Verified ${paths.size} packaged files in ${basename(archivePath)} (${report.size} bytes compressed)`,
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `package_file=${archivePath}\n`, "utf8");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `package_name=${basename(archivePath)}\n`,
    "utf8",
  );
}
