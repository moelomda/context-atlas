import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Tag is not a supported release tag: ${tag ?? "<missing>"}`);
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const version = tag.slice(1);

if (manifest.version !== version) {
  throw new Error(`Tag ${tag} does not match package.json ${manifest.version}`);
}
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  throw new Error("package-lock.json version does not match the release tag");
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const datedHeading = new RegExp(
  `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  "m",
);
if (!datedHeading.test(changelog)) {
  throw new Error(`CHANGELOG.md has no dated section for ${version}`);
}

console.log(`Verified release identity for ${tag}`);
