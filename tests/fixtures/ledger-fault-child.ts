import { AtlasDatabase } from "../../src/core/database.js";
import { flushLedgerOutbox, stageLedgerEntry } from "../../src/core/ledger.js";

type Mode = "stage-and-wait" | "flush-on-command";

interface ParentCommand {
  type: "go";
}

interface ChildMessage {
  type: "committed" | "ready" | "result";
  ok?: boolean;
  flushed?: number;
  head?: string;
  error?: string;
}

const mode = process.argv[2] as Mode | undefined;
const repoRoot = process.argv[3];

if (!repoRoot || (mode !== "stage-and-wait" && mode !== "flush-on-command")) {
  throw new Error("Expected ledger fault child mode and fixture repository path.");
}
if (typeof process.send !== "function") throw new Error("Ledger fault child requires an IPC channel.");

const database = new AtlasDatabase(repoRoot);

if (mode === "stage-and-wait") {
  database.transaction(() => {
    stageLedgerEntry(repoRoot, database, {
      kind: "process_crash_fixture",
      actionId: "committed-before-process-kill",
      payload: { boundary: "after-database-commit-before-ledger-flush" },
    });
  });

  process.on("message", () => {
    /* Keep the IPC channel referenced until the parent terminates us. */
  });
  send({ type: "committed" });
} else {
  process.once("message", (message: ParentCommand) => {
    if (message?.type !== "go") {
      finish({ type: "result", ok: false, error: "Expected an explicit go barrier." }, 1);
      return;
    }
    try {
      const result = flushLedgerOutbox(repoRoot, database);
      finish({ type: "result", ok: true, ...result }, 0);
    } catch (error) {
      finish(
        {
          type: "result",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        1,
      );
    }
  });
  send({ type: "ready" });
}

function send(message: ChildMessage): void {
  process.send?.(message);
}

function finish(message: ChildMessage, exitCode: number): void {
  try {
    database.close();
  } catch {
    /* The original recovery result is authoritative. */
  }
  process.send?.(message, () => {
    process.exitCode = exitCode;
    process.disconnect?.();
  });
}
