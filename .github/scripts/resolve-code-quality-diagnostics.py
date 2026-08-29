from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_function(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"Missing function start marker in {path}: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"Missing function end marker in {path}: {end_marker!r}")
    file.write_text(text[:start] + replacement + text[end:], encoding="utf-8")


replace_once(
    "src/core/external-import.ts",
    '''import {
  closeSync,
  constants,''',
    '''import {
  type BigIntStats,
  closeSync,
  constants,''',
)
replace_once("src/core/external-import.ts", "  let initial;", "  let initial: BigIntStats;")
replace_once("src/core/external-import.ts", "  let opened;\n  let after;", "  let opened: BigIntStats;\n  let after: BigIntStats;")
replace_once("src/core/external-import.ts", "  let final;", "  let final: BigIntStats;")

replace_function(
    "src/core/pack-lifecycle.ts",
    "function withStorageLock<T>",
    "\n\nfunction snapshotPath",
    '''function withStorageLock<T>(root: string, packsRoot: string, operation: () => T): T {
  const lockPath = path.join(packsRoot, ".write.lock");
  assertContained(packsRoot, lockPath);
  const token = `${process.pid}:${randomUUID()}`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "unknown";
    throw new Error(`Context-pack storage is locked by another writer (${code}); retry after that operation completes.`);
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    try {
      writeFileSync(descriptor, `${token}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    outcome = { ok: true, value: operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupError: unknown;
  try {
    if (existsSync(lockPath)) {
      assertSafeRegularFile(root, lockPath, "context-pack write lock");
      const storedToken = readFileSync(lockPath, "utf8").trim();
      if (storedToken !== token) {
        throw new Error("Context-pack write lock changed during the operation; refusing to remove an unowned lock.");
      }
      unlinkSync(lockPath);
    }
  } catch (error) {
    cleanupError = error;
  }

  if (cleanupError !== undefined) {
    if (!outcome.ok) {
      throw new AggregateError([outcome.error, cleanupError], "Context-pack operation and write-lock cleanup both failed.");
    }
    throw cleanupError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}''',
)

replace_once(
    "src/mcp/server.ts",
    '''      response.content[0]!.text = `Context pack ${pack.packId} is available once in structuredContent (pack estimate ${pack.estimatedTokens} tokens; complete MCP tool-result estimate ${envelope.transport.estimatedTokens}/${pack.tokenBudget} tokens; ${disposition}).`;''',
    '''      const summaryBlock = response.content[0];
      if (!summaryBlock) throw new Error("Context-pack MCP response is missing its summary content block.");
      summaryBlock.text = `Context pack ${pack.packId} is available once in structuredContent (pack estimate ${pack.estimatedTokens} tokens; complete MCP tool-result estimate ${envelope.transport.estimatedTokens}/${pack.tokenBudget} tokens; ${disposition}).`;''',
)

replace_once(
    "src/web/public/app.js",
    '''      .forEach((node) => node.setAttribute("tabindex", node.dataset.nodeId === next.id ? "0" : "-1"));''',
    '''      .forEach((node) => {
        node.setAttribute("tabindex", node.dataset.nodeId === next.id ? "0" : "-1");
      });''',
)
replace_once(
    "src/web/public/app.js",
    '''    targets.forEach((target, index) =>
      target.closest(".timeline-event")?.classList.toggle("is-keyboard-active", index === state.timeline.activeIndex),
    );''',
    '''    targets.forEach((target, index) => {
      target.closest(".timeline-event")?.classList.toggle("is-keyboard-active", index === state.timeline.activeIndex);
    });''',
)
replace_once(
    "src/web/public/app.js",
    '''    options.forEach((option, optionIndex) => option.setAttribute("aria-selected", String(optionIndex === state.searchActiveIndex)));''',
    '''    options.forEach((option, optionIndex) => {
      option.setAttribute("aria-selected", String(optionIndex === state.searchActiveIndex));
    });''',
)
replace_once(
    "src/web/public/app.js",
    '''  document.querySelectorAll("[data-close-proposal-review]").forEach((button) => button.addEventListener("click", closeProposalReview));''',
    '''  document.querySelectorAll("[data-close-proposal-review]").forEach((button) => {
    button.addEventListener("click", closeProposalReview);
  });''',
)
replace_once(
    "src/web/public/app.js",
    '''  document.querySelectorAll("[data-close-source-import]").forEach((button) => button.addEventListener("click", closeSourceImport));''',
    '''  document.querySelectorAll("[data-close-source-import]").forEach((button) => {
    button.addEventListener("click", closeSourceImport);
  });''',
)

replace_once(
    "tests/e2e.test.ts",
    '''  assert.equal((currentOverviews[0]?.value as { summary?: string }).summary, "Billing retries stop after a configurable limit.");''',
    '''  const currentOverview = currentOverviews[0];
  assert.ok(currentOverview);
  assert.equal((currentOverview.value as { summary?: string }).summary, "Billing retries stop after a configurable limit.");''',
)
