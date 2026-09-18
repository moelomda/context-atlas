import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getCommitFiles, getCommits, parseBatchedCommitFiles } from "../src/core/git.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);

test("batched Git parser preserves NUL-delimited statuses and unusual path bytes", () => {
  const output = `${SHA1}\0A\0normal.ts\0R100\0old\nname.ts\0new\tname.ts\0${SHA256}\0C075\0copy-from.ts\0--copy-to.ts\0M\0unicodé-雪.ts\0A\0${SHA1}\0`;
  const parsed = parseBatchedCommitFiles(output, [SHA1, SHA256]);
  assert.deepEqual(parsed.get(SHA1), [
    { status: "A", path: "normal.ts" },
    { status: "R100", path: "new\tname.ts", previousPath: "old\nname.ts" },
  ]);
  assert.deepEqual(parsed.get(SHA256), [
    { status: "C075", path: "--copy-to.ts", previousPath: "copy-from.ts" },
    { status: "M", path: "unicodé-雪.ts" },
    { status: "A", path: SHA1 },
  ]);
});

test("batched Git parser rejects malformed, missing, repeated, and truncated records", () => {
  const malformed: Array<{ output: string; expected: string[]; error: RegExp }> = [
    { output: "A\0file.ts\0", expected: [SHA1], error: /before a commit header/ },
    { output: `${SHA256}\0`, expected: [SHA1], error: /unexpected commit/ },
    { output: `${SHA1}\0${SHA1}\0`, expected: [SHA1], error: /repeated commit/ },
    { output: `${SHA1}\0`, expected: [SHA1, SHA256], error: /omitted commits/ },
    { output: `${SHA1}\0INVALID\0file.ts\0`, expected: [SHA1], error: /Malformed batched Git file status/ },
    { output: `${SHA1}\0A\0\0`, expected: [SHA1], error: /empty path/ },
    { output: `${SHA1}\0R100\0old.ts\0\0`, expected: [SHA1], error: /empty path/ },
    { output: SHA1, expected: [SHA1], error: /NUL-terminated field/ },
    { output: `${SHA1}\0A`, expected: [SHA1], error: /NUL-terminated field/ },
    { output: `${SHA1}\0A\0unfinished.ts`, expected: [SHA1], error: /NUL-terminated field/ },
    { output: `${SHA1}\0R100\0old.ts\0`, expected: [SHA1], error: /NUL-terminated field/ },
    { output: `${SHA1}\nA\0file.ts\0`, expected: [SHA1], error: /before a commit header/ },
  ];
  for (const example of malformed) {
    assert.throws(() => parseBatchedCommitFiles(example.output, example.expected), example.error);
  }
  assert.deepEqual(parseBatchedCommitFiles("", []), new Map());
  assert.deepEqual(
    parseBatchedCommitFiles(`${SHA1}\0${SHA256}\0`, [SHA1, SHA256]),
    new Map([
      [SHA1, []],
      [SHA256, []],
    ]),
  );
});

for (const objectFormat of ["sha1", "sha256"] as const) {
  test(`getCommits batches ${objectFormat} history and matches the per-commit reference`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "context-atlas-git-history-"));
    try {
      git(root, ["init", "--initial-branch=main", `--object-format=${objectFormat}`]);
      git(root, ["config", "user.name", "Atlas Git Test"]);
      git(root, ["config", "user.email", "atlas-git@example.invalid"]);
      git(root, ["config", "commit.gpgsign", "false"]);
      git(root, ["config", "diff.renames", "true"]);
      git(root, ["config", "core.autocrlf", "false"]);
      assert.deepEqual(getCommits(root, 100), []);

      write(root, "alpha.txt", "alpha\n");
      commitAll(root, "Create root history");

      renameSync(path.join(root, "alpha.txt"), path.join(root, "--renamed file.txt"));
      commitAll(root, "Rename a leading-dash path");

      write(root, "unicodé-雪.txt", "unicode\n");
      commitAll(root, "Add a Unicode path");

      if (process.platform !== "win32") {
        write(root, "line\nbreak.txt", "newline\n");
        commitAll(root, "Add a newline path");
      }

      git(root, ["commit", "--allow-empty", "-m", "Record an empty commit"]);
      git(root, ["switch", "-c", "feature-history"]);
      write(root, "feature.txt", "feature\n");
      commitAll(root, "Add feature history");
      git(root, ["switch", "main"]);
      write(root, "main.txt", "main\n");
      commitAll(root, "Add main history");
      git(root, ["merge", "--no-ff", "feature-history", "-m", "Merge feature history"]);

      const tracePath = path.join(root, "git-trace.jsonl");
      const previousTrace = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = tracePath;
      let commits: ReturnType<typeof getCommits>;
      try {
        commits = getCommits(root, 100);
      } finally {
        if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
        else process.env.GIT_TRACE2_EVENT = previousTrace;
      }

      const startEvents = readFileSync(tracePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string })
        .filter((event) => event.event === "start");
      assert.equal(startEvents.length, 3, "history discovery must use rev-parse, log, and one batched diff-tree process");

      assert.ok(commits.length >= 7);
      for (const commit of commits) {
        assert.equal(commit.hash.length, objectFormat === "sha256" ? 64 : 40);
        assert.deepEqual(commit.files, getCommitFiles(root, commit.hash));
      }
      assert.deepEqual(getCommits(root, 3), commits.slice(-3), "bounded histories preserve the original selection and order");
      const allPaths = commits.flatMap((commit) => commit.files.flatMap((file) => [file.path, file.previousPath].filter(Boolean)));
      assert.ok(allPaths.includes("unicodé-雪.txt"));
      assert.ok(allPaths.includes("--renamed file.txt"));
      if (process.platform !== "win32") assert.ok(allPaths.includes("line\nbreak.txt"));
      assert.deepEqual(commits.find((commit) => commit.subject === "Record an empty commit")?.files, []);
      assert.deepEqual(commits.find((commit) => commit.subject === "Merge feature history")?.files, []);
    } finally {
      remove(root);
    }
  });
}

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
