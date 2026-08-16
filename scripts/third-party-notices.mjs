import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function generateThirdPartyNotices(projectRoot, metafile, outputPath) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const packageRoot = packageRootForInput(projectRoot, input);
    if (!packageRoot) continue;
    const manifestPath = path.join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Bundled dependency has no package manifest: ${packageRoot}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Bundled dependency has invalid identity metadata: ${manifestPath}`);
    }
    if (typeof manifest.license !== "string" || manifest.license.trim().length === 0) {
      throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has no declared license.`);
    }
    const license = manifest.license;
    const licenseFile = readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying)(\..*)?$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => licenseFileRank(left) - licenseFileRank(right) || compareText(left, right))[0];
    if (!licenseFile) {
      throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has no license text file.`);
    }
    const key = `${manifest.name}@${manifest.version}`;
    const licenseText = readFileSync(path.join(packageRoot, licenseFile), "utf8").replace(/\r\n/g, "\n").trimEnd();
    const existing = packages.get(key);
    if (existing && (existing.license !== license || existing.licenseText !== licenseText)) {
      throw new Error(`Conflicting license metadata for bundled dependency ${key}.`);
    }
    packages.set(key, { name: manifest.name, version: manifest.version, license, licenseFile, licenseText });
  }

  const dependencies = [...packages.values()].sort((left, right) =>
    compareText(left.name, right.name) || compareText(left.version, right.version));
  if (dependencies.length === 0) throw new Error("The plugin bundle did not report any third-party dependencies.");

  const sections = dependencies.map((dependency) => {
    const indentedLicense = dependency.licenseText
      .split("\n")
      .map((line) => line.length === 0 ? "" : `    ${line}`)
      .join("\n");
    return [
      `## ${dependency.name} ${dependency.version}`,
      "",
      `Declared license: ${dependency.license}. License text source: ${dependency.licenseFile}.`,
      "",
      indentedLicense,
    ].join("\n");
  });
  const notice = [
    "# Third-party notices",
    "",
    "This file is generated from the dependency inputs that are actually bundled into the self-contained Context Atlas Codex plugin runtime. Do not edit it by hand.",
    "",
    ...sections,
    "",
  ].join("\n");
  writeFileSync(outputPath, notice, "utf8");
  return dependencies.map(({ name, version, license }) => ({ name, version, license }));
}

function packageRootForInput(projectRoot, input) {
  const absolute = path.resolve(projectRoot, input).replace(/\\/g, "/");
  const marker = "/node_modules/";
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const tail = absolute.slice(markerIndex + marker.length).split("/");
  const segmentCount = tail[0]?.startsWith("@") ? 2 : 1;
  if (tail.length < segmentCount || tail.slice(0, segmentCount).some((part) => !part)) return null;
  return path.normalize(`${absolute.slice(0, markerIndex + marker.length)}${tail.slice(0, segmentCount).join("/")}`);
}

function licenseFileRank(fileName) {
  if (/^license$/i.test(fileName)) return 0;
  if (/^licence$/i.test(fileName)) return 1;
  if (/^copying$/i.test(fileName)) return 2;
  return 3;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metafilePath = process.argv[2];
  const outputPath = process.argv[3];
  if (!metafilePath || !outputPath) {
    throw new Error("Usage: node scripts/third-party-notices.mjs <esbuild-metafile.json> <output.md>");
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const metafile = JSON.parse(readFileSync(path.resolve(metafilePath), "utf8"));
  generateThirdPartyNotices(projectRoot, metafile, path.resolve(outputPath));
}
