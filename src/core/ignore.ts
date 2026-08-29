import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findSecrets } from "./security.js";
import { posixPath, sha256 } from "./util.js";

interface Rule {
  negated: boolean;
  regex: RegExp;
}

export interface AtlasIgnore {
  path: string | null;
  hash: string | null;
  patterns: string[];
  matches(relativePath: string): boolean;
}

export function loadAtlasIgnore(repoRoot: string): AtlasIgnore {
  const filePath = path.join(repoRoot, ".atlasignore");
  if (!existsSync(filePath)) return emptyIgnore();
  if (statSync(filePath).size > 64 * 1024) throw new Error(".atlasignore exceeds the 64 KiB safety limit.");
  const raw = readFileSync(filePath, "utf8");
  if (findSecrets(raw).length > 0) throw new Error(".atlasignore appears to contain a secret; refusing to ingest until it is removed.");
  const patterns = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !line.startsWith("#"));
  const rules = patterns.map(compileRule);
  return {
    path: filePath,
    hash: sha256(raw),
    patterns,
    matches(relativePath: string): boolean {
      const normalized = posixPath(relativePath).replace(/^\/+/, "");
      let ignored = false;
      for (const rule of rules) if (rule.regex.test(normalized)) ignored = !rule.negated;
      return ignored;
    },
  };
}

function emptyIgnore(): AtlasIgnore {
  return { path: null, hash: null, patterns: [], matches: () => false };
}

function compileRule(input: string): Rule {
  const negated = input.startsWith("!");
  let pattern = negated ? input.slice(1) : input;
  const anchored = pattern.startsWith("/");
  pattern = pattern.replace(/^\/+/, "");
  const directory = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  if (!pattern || pattern.includes("\0")) throw new Error(`Invalid .atlasignore pattern: ${input}`);
  const hasSlash = pattern.includes("/");
  const body = globToRegex(pattern);
  const prefix = anchored || hasSlash ? "^" : "(?:^|/)";
  const suffix = directory ? "(?:/.*)?$" : "(?:$|/)";
  return { negated, regex: new RegExp(`${prefix}${body}${suffix}`) };
}

function globToRegex(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*" && pattern[index + 1] === "*") {
      output += ".*";
      index += 1;
    } else if (character === "*") output += "[^/]*";
    else if (character === "?") output += "[^/]";
    else output += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return output;
}
