import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(process.env.PLUGIN_ROOT || resolve(scriptDirectory, ".."));
const projectRoot = resolve(pluginRoot, "..", "..");
const bundledServerPath = resolve(pluginRoot, "runtime", "server.mjs");
const sourceServerPath = resolve(projectRoot, "dist", "mcp", "server.js");
let serverPath = bundledServerPath;

try {
  await access(bundledServerPath, fsConstants.R_OK);
} catch {
  serverPath = sourceServerPath;
  try {
    await access(sourceServerPath, fsConstants.R_OK);
  } catch {
    console.error(
      `[context-atlas] MCP runtime is missing. Expected ${bundledServerPath}. Run the Context Atlas build before installing this plugin.`,
    );
    process.exit(1);
  }
}

const child = spawn(process.execPath, [serverPath], {
  cwd: pluginRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`[context-atlas] Failed to start the MCP server: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[context-atlas] MCP server exited after receiving ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
