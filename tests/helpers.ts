import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeConfig } from "../src/core/config.js";
import { syncRepository } from "../src/core/ingest.js";

export function createFixtureRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "context-atlas-test-"));
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Atlas Test"]);
  runGit(root, ["config", "user.email", "atlas-test@example.invalid"]);
  mkdirSync(path.join(root, "src", "payments"), { recursive: true });
  mkdirSync(path.join(root, "docs", "adr"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-shop",
    description: "A fixture subscription service",
    dependencies: { zod: "4.4.3" },
    devDependencies: { typescript: "7.0.2" },
  }, null, 2));
  writeFileSync(path.join(root, "README.md"), "# Fixture Shop\n\nA small subscription service used to verify Context Atlas.\n");
  writeFileSync(path.join(root, "src", "payments", "billing.ts"), "export const charge = (cents: number) => cents > 0;\n");
  writeFileSync(path.join(root, "docs", "adr", "0001-use-ledger.md"), "# Use an append-only ledger\n\nStatus: accepted. Preserve history rather than overwriting it.\n");
  writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-this-must-never-enter-context-storage\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Create subscription service foundation"]);
  return root;
}

export function initializeFixture(root: string): void {
  initializeConfig(root, "Fixture Shop");
  syncRepository(root);
}

export function commitFile(root: string, relativePath: string, content: string, message: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  runGit(root, ["add", relativePath]);
  runGit(root, ["commit", "-m", message]);
}

export function removeFixture(root: string): void {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(tmpdir());
  if (!resolved.startsWith(`${tempRoot}${path.sep}context-atlas-test-`)) {
    throw new Error(`Refusing to remove non-fixture directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true });
}
