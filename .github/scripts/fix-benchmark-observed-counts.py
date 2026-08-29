from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "scripts/benchmark/run-benchmark.mjs",
    '''  const pack = outputs.get("context-pack");
  const includedKeys = ["includedEntityIds", "includedAssertionIds", "includedRelationshipIds", "includedEventIds", "includedEvidenceIds"];
  return {
    graphNodes: arrayLength(graph?.nodes),
    graphEdges: arrayLength(graph?.edges),
    timelineEvents: arrayLength(Array.isArray(timeline) ? timeline : timeline?.events),
    searchResults: arrayLength(Array.isArray(search) ? search : search?.results),
    contextPackSelected: includedKeys.reduce((total, key) => total + arrayLength(pack?.[key]), 0),
    contextPackExcluded: arrayLength(pack?.exclusions),
    contextPackBudgetExcluded: Array.isArray(pack?.exclusions)
      ? pack.exclusions.filter((item) => /budget|truncat/i.test(String(item?.reason))).length
      : 0,
  };''',
    '''  const pack = outputs.get("context-pack");
  const selection = pack?.selection;
  const includedKeys = ["includedEntityIds", "includedAssertionIds", "includedRelationshipIds", "includedEventIds", "includedEvidenceIds"];
  return {
    graphNodes: arrayLength(graph?.nodes),
    graphEdges: arrayLength(graph?.edges),
    timelineEvents: arrayLength(Array.isArray(timeline) ? timeline : timeline?.events),
    searchResults: arrayLength(Array.isArray(search) ? search : search?.results),
    contextPackSelected: includedKeys.reduce((total, key) => total + arrayLength(selection?.[key]), 0),
    contextPackExcluded: arrayLength(selection?.exclusions),
    contextPackBudgetExcluded: Array.isArray(selection?.exclusions)
      ? selection.exclusions.filter((item) => item?.reason === "token-budget").length
      : 0,
  };''',
)

replace_once(
    "scripts/benchmark/validate-report.mjs",
    '''assert(report.artifacts?.databaseBytes === null || Number.isInteger(report.artifacts.databaseBytes), "Invalid database size.");
assert(Array.isArray(report.limitations) && report.limitations.length > 0, "Benchmark limitations must remain explicit.");''',
    '''assert(report.artifacts?.databaseBytes === null || Number.isInteger(report.artifacts.databaseBytes), "Invalid database size.");
const observedCounts = report.observedCounts;
for (const field of [
  "graphNodes",
  "graphEdges",
  "timelineEvents",
  "searchResults",
  "contextPackSelected",
  "contextPackExcluded",
  "contextPackBudgetExcluded",
]) {
  assert(Number.isInteger(observedCounts?.[field]) && observedCounts[field] >= 0, `Invalid observed count: ${field}.`);
}
assert(observedCounts.graphNodes > 0, "The benchmark graph must contain at least one node.");
assert(observedCounts.timelineEvents > 0, "The benchmark timeline must contain at least one event.");
assert(observedCounts.searchResults > 0, "The benchmark search must contain at least one result.");
assert(observedCounts.contextPackSelected > 0, "The benchmark Context Pack must contain at least one selected item.");
assert(
  observedCounts.contextPackBudgetExcluded <= observedCounts.contextPackExcluded,
  "Budget exclusions cannot exceed all Context Pack exclusions.",
);
assert(Array.isArray(report.limitations) && report.limitations.length > 0, "Benchmark limitations must remain explicit.");''',
)
