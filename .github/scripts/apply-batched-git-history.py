from pathlib import Path


def replace_function(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"Missing start marker in {path}: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"Missing end marker in {path}: {end_marker!r}")
    file.write_text(text[:start] + replacement + text[end:], encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_function(
    "src/core/git.ts",
    "function runGit(",
    "\n\nexport function findGitRoot",
    '''function runGit(root: string, args: string[], allowFailure = false, input?: string): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["pipe", "pipe", allowFailure ? "ignore" : "pipe"],
      ...(input === undefined ? {} : { input }),
    });
  } catch (error) {
    if (allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed: ${message}`);
  }
}''',
)

replace_function(
    "src/core/git.ts",
    "export function getCommits(",
    "\n\nexport function getCommitFiles",
    '''export function getCommits(root: string, maximum: number): GitCommit[] {
  if (!runGit(root, ["rev-parse", "--verify", "HEAD"], true).trim()) return [];
  const format = "%H%x1f%aI%x1f%an%x1f%s%x1e";
  const output = runGit(root, ["log", `--max-count=${Math.max(1, maximum)}`, "--reverse", `--format=${format}`], true);
  const commits = output
    .split("\\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map<GitCommit>((record) => {
      const [hash = "", timestamp = "", author = "", subject = ""] = record.split("\\x1f");
      return { hash, timestamp, author, subject, files: [] };
    })
    .filter((commit) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commit.hash));
  const filesByCommit = getCommitFilesBatch(root, commits.map((commit) => commit.hash));
  return commits.map((commit) => ({ ...commit, files: filesByCommit.get(commit.hash) ?? [] }));
}

export function getCommitFilesBatch(root: string, commitHashes: string[]): Map<string, CommitFile[]> {
  const uniqueHashes = [...new Set(commitHashes)];
  for (const hash of uniqueHashes) sanitizeForGitArgument(hash);
  if (uniqueHashes.length === 0) return new Map();
  const output = runGit(
    root,
    ["diff-tree", "--stdin", "--root", "--always", "--name-status", "-r", "-z"],
    false,
    `${uniqueHashes.join("\\n")}\\n`,
  );
  return parseBatchedCommitFiles(output, uniqueHashes);
}

export function parseBatchedCommitFiles(output: string, expectedHashes: string[]): Map<string, CommitFile[]> {
  const expectedByNormalized = new Map(expectedHashes.map((hash) => [hash.toLowerCase(), hash]));
  const result = new Map(expectedHashes.map((hash) => [hash, [] as CommitFile[]]));
  const seen = new Set<string>();
  let currentHash: string | null = null;
  let offset = 0;

  while (offset < output.length) {
    while (output[offset] === "\\0" || output[offset] === "\\n") offset += 1;
    if (offset >= output.length) break;

    const nextNul = output.indexOf("\\0", offset);
    const nextNewline = output.indexOf("\\n", offset);
    if (nextNewline >= 0 && (nextNul < 0 || nextNewline < nextNul)) {
      const candidate = output.slice(offset, nextNewline);
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(candidate)) {
        throw new Error(`Malformed batched Git commit header: ${JSON.stringify(candidate)}.`);
      }
      const expected = expectedByNormalized.get(candidate.toLowerCase());
      if (!expected) throw new Error(`Batched Git output included an unexpected commit: ${candidate}.`);
      if (seen.has(expected)) throw new Error(`Batched Git output repeated commit: ${candidate}.`);
      seen.add(expected);
      currentHash = expected;
      offset = nextNewline + 1;
      continue;
    }

    if (!currentHash) throw new Error("Batched Git output included file status before a commit header.");
    const statusField = readNulField(output, offset);
    const status = statusField.value;
    offset = statusField.nextOffset;
    if (!status) continue;
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) {
      throw new Error(`Malformed batched Git file status for ${currentHash}: ${JSON.stringify(status)}.`);
    }

    const firstPath = readNulField(output, offset);
    offset = firstPath.nextOffset;
    const files = result.get(currentHash);
    if (!files) throw new Error(`Batched Git parser lost commit state for ${currentHash}.`);
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = readNulField(output, offset);
      offset = secondPath.nextOffset;
      const currentPath = posixPath(secondPath.value);
      if (currentPath.length > 0) files.push({ status, path: currentPath, previousPath: posixPath(firstPath.value) });
    } else {
      const currentPath = posixPath(firstPath.value);
      if (currentPath.length > 0) files.push({ status, path: currentPath });
    }
  }

  const missing = expectedHashes.filter((hash) => !seen.has(hash));
  if (missing.length > 0) throw new Error(`Batched Git output omitted commits: ${missing.join(", ")}.`);
  return result;
}

function readNulField(output: string, offset: number): { value: string; nextOffset: number } {
  const end = output.indexOf("\\0", offset);
  if (end < 0) throw new Error("Batched Git output ended before a NUL-terminated field completed.");
  return { value: output.slice(offset, end), nextOffset: end + 1 };
}''',
)

Path("tests/git-history.test.ts").write_text(
    '''import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getCommitFiles, getCommits, parseBatchedCommitFiles } from "../src/core/git.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);

test("batched Git parser preserves NUL-delimited statuses and unusual path bytes", () => {
  const output = `${SHA1}\\nA\\0normal.ts\\0R100\\0old\\nname.ts\\0new\\tname.ts\\0${SHA256}\\nC075\\0copy-from.ts\\0--copy-to.ts\\0M\\0unicodé-雪.ts\\0`;
  const parsed = parseBatchedCommitFiles(output, [SHA1, SHA256]);
  assert.deepEqual(parsed.get(SHA1), [
    { status: "A", path: "normal.ts" },
    { status: "R100", path: "new\\tname.ts", previousPath: "old\\nname.ts" },
  ]);
  assert.deepEqual(parsed.get(SHA256), [
    { status: "C075", path: "--copy-to.ts", previousPath: "copy-from.ts" },
    { status: "M", path: "unicodé-雪.ts" },
  ]);
});

test("getCommits batches file discovery and matches the per-commit reference", () => {
  const root = mkdtempSync(path.join(tmpdir(), "context-atlas-git-history-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Atlas Git Test"]);
    git(root, ["config", "user.email", "atlas-git@example.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "diff.renames", "true"]);

    write(root, "alpha.txt", "alpha\\n");
    commitAll(root, "Create root history");

    renameSync(path.join(root, "alpha.txt"), path.join(root, "--renamed file.txt"));
    commitAll(root, "Rename a leading-dash path");

    write(root, "unicodé-雪.txt", "unicode\\n");
    commitAll(root, "Add a Unicode path");

    if (process.platform !== "win32") {
      write(root, "line\\nbreak.txt", "newline\\n");
      commitAll(root, "Add a newline path");
    }

    git(root, ["commit", "--allow-empty", "-m", "Record an empty commit"]);
    git(root, ["switch", "-c", "feature-history"]);
    write(root, "feature.txt", "feature\\n");
    commitAll(root, "Add feature history");
    git(root, ["switch", "main"]);
    write(root, "main.txt", "main\\n");
    commitAll(root, "Add main history");
    git(root, ["merge", "--no-ff", "feature-history", "-m", "Merge feature history"]);

    const tracePath = path.join(root, "git-trace.jsonl");
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = tracePath;
    let commits;
    try {
      commits = getCommits(root, 100);
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previousTrace;
    }

    const startEvents = readFileSync(tracePath, "utf8")
      .split("\\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .filter((event) => event.event === "start");
    assert.equal(startEvents.length, 3, "history discovery must use rev-parse, log, and one batched diff-tree process");

    assert.ok(commits.length >= 7);
    for (const commit of commits) assert.deepEqual(commit.files, getCommitFiles(root, commit.hash));
    const allPaths = commits.flatMap((commit) => commit.files.flatMap((file) => [file.path, file.previousPath].filter(Boolean)));
    assert.ok(allPaths.includes("unicodé-雪.txt"));
    assert.ok(allPaths.includes("--renamed file.txt"));
    if (process.platform !== "win32") assert.ok(allPaths.includes("line\\nbreak.txt"));
    assert.deepEqual(commits.find((commit) => commit.subject === "Record an empty commit")?.files, []);
    assert.deepEqual(commits.find((commit) => commit.subject === "Merge feature history")?.files, []);
  } finally {
    remove(root);
  }
});

function write(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", message]);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function remove(root: string): void {
  const resolved = path.resolve(root);
  const temporaryRoot = path.resolve(tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}context-atlas-git-history-`)) {
    throw new Error(`Refusing to remove unexpected Git history fixture: ${resolved}`);
  }
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}
''',
    encoding="utf-8",
)

replace_once(
    "CHANGELOG.md",
    '''- A deterministic synthetic benchmark harness with named file-count, history, relationship-density, and untracked-content scenarios; public-command timings, p50/p95, RSS where available, database bytes, Git Trace2 process counts, output counts, schema validation, CI smoke artifacts, and an explicitly limited reference baseline.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.''',
    '''- A deterministic synthetic benchmark harness with named file-count, history, relationship-density, and untracked-content scenarios; public-command timings, p50/p95, RSS where available, database bytes, Git Trace2 process counts, output counts, schema validation, CI smoke artifacts, and an explicitly limited reference baseline.
- Git history file-status extraction now uses one NUL-safe batched `diff-tree --stdin` process per imported history window instead of one subprocess per commit, with semantic-reference and unusual-path regression tests.
- Local Git ingestion into an evidence-backed SQLite project-memory graph.''',
)
