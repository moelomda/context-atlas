import json
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


biome_path = Path("biome.json")
biome = json.loads(biome_path.read_text(encoding="utf-8"))
biome["linter"]["rules"] = {
    "preset": "recommended",
    "suspicious": {
        "noControlCharactersInRegex": "off",
    },
}
biome_path.write_text(json.dumps(biome, indent=2) + "\n", encoding="utf-8")

replace_once(
    "src/core/egress.ts",
    '''function normalizeTimestamp(value: string): string {
  if (!validTimestamp(value)) throw new EgressGatewayError("invalid_request");
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, any> {''',
    '''function isPlainRecord(value: unknown): value is Record<string, unknown> {''',
)

replace_once(
    ".github/scripts/smoke-installed-package.mjs",
    '''const fixtureRoot = mkdtempSync(path.join(tmpdir(), "context-atlas-installed-smoke-"));
let webChild = null;''',
    '''const fixtureRoot = mkdtempSync(path.join(tmpdir(), "context-atlas-installed-smoke-"));
const resolvedFixtureRoot = path.resolve(fixtureRoot);
const temporaryRoot = path.resolve(tmpdir());
if (!resolvedFixtureRoot.startsWith(`${temporaryRoot}${path.sep}context-atlas-installed-smoke-`)) {
  throw new Error(`Refusing to use unexpected smoke directory: ${resolvedFixtureRoot}`);
}
let webChild = null;''',
)
replace_once(
    ".github/scripts/smoke-installed-package.mjs",
    '''  const resolved = path.resolve(fixtureRoot);
  const temporaryRoot = path.resolve(tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}context-atlas-installed-smoke-`)) {
    throw new Error(`Refusing to remove unexpected smoke directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });''',
    '''  rmSync(resolvedFixtureRoot, { recursive: true, force: true });''',
)
