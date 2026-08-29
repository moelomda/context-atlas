export const BENCHMARK_SCHEMA_VERSION = 1;
export const FIXTURE_SCHEMA_VERSION = 1;

export const SCENARIOS = Object.freeze({
  smoke: Object.freeze({
    description: "Small CI fixture that exercises every public read workflow.",
    seed: "context-atlas-smoke-v1",
    fileCount: 80,
    bytesPerFile: 320,
    commitCount: 12,
    filesChangedPerCommit: 5,
    componentCount: 8,
    dependenciesPerComponent: 3,
    untrackedFileCount: 12,
    untrackedBytesPerFile: 192,
    readSamples: 2,
  }),
  "files-10k": Object.freeze({
    description: "Tracked-file scale fixture for local or scheduled qualification.",
    seed: "context-atlas-files-10k-v1",
    fileCount: 10_000,
    bytesPerFile: 256,
    commitCount: 40,
    filesChangedPerCommit: 25,
    componentCount: 80,
    dependenciesPerComponent: 4,
    untrackedFileCount: 100,
    untrackedBytesPerFile: 256,
    readSamples: 5,
  }),
  "history-5k": Object.freeze({
    description: "Long-history fixture with five thousand deterministic commits.",
    seed: "context-atlas-history-5k-v1",
    fileCount: 500,
    bytesPerFile: 256,
    commitCount: 5_000,
    filesChangedPerCommit: 3,
    componentCount: 25,
    dependenciesPerComponent: 3,
    untrackedFileCount: 25,
    untrackedBytesPerFile: 256,
    readSamples: 5,
  }),
  "relationships-dense": Object.freeze({
    description: "Workspace fixture with a dense, deterministic package dependency graph.",
    seed: "context-atlas-relationships-dense-v1",
    fileCount: 2_500,
    bytesPerFile: 256,
    commitCount: 100,
    filesChangedPerCommit: 10,
    componentCount: 250,
    dependenciesPerComponent: 12,
    untrackedFileCount: 50,
    untrackedBytesPerFile: 256,
    readSamples: 5,
  }),
  "untracked-bounded": Object.freeze({
    description: "Fixture that stresses bounded untracked-file fingerprint policy.",
    seed: "context-atlas-untracked-bounded-v1",
    fileCount: 1_000,
    bytesPerFile: 256,
    commitCount: 30,
    filesChangedPerCommit: 10,
    componentCount: 40,
    dependenciesPerComponent: 4,
    untrackedFileCount: 5_000,
    untrackedBytesPerFile: 512,
    readSamples: 5,
  }),
});

export function scenarioNames() {
  return Object.keys(SCENARIOS).sort();
}

export function getScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(`Unknown benchmark scenario ${JSON.stringify(name)}. Choose one of: ${scenarioNames().join(", ")}.`);
  }
  return { name, ...scenario };
}
