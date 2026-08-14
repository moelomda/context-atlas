import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "src", "web", "public");
const destination = path.join(projectRoot, "dist", "web", "public");

if (!existsSync(source)) {
  throw new Error(`Missing web assets: ${source}`);
}
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true, force: true });

const pluginRuntimeDirectory = path.join(projectRoot, "plugin", "context-atlas", "runtime");
mkdirSync(pluginRuntimeDirectory, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(projectRoot, "src", "mcp", "server.ts")],
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "eof",
  logLevel: "warning",
});
const runtime = bundle.outputFiles[0]?.text;
if (!runtime) throw new Error("MCP bundling produced no runtime output.");
writeFileSync(
  path.join(pluginRuntimeDirectory, "server.mjs"),
  `${runtime.replace(/[ \t]+$/gm, "").trimEnd()}\n`,
  "utf8",
);
