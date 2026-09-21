import { findSecrets, redactSecrets } from "./security.js";
import type { TimelineEvent } from "./types.js";
import { sha256 } from "./util.js";

/** Redact legacy observations at read time without rewriting their immutable audit binding. */
export function presentTimelineEvent(event: TimelineEvent): TimelineEvent {
  const presentPath = (value: string): string => (findSecrets(value).length > 0 ? `[withheld:${sha256(value).slice(0, 10)}]` : value);
  return {
    ...event,
    title: redactSecrets(event.title).value,
    summary: redactSecrets(event.summary).value,
    files: event.files.map((file) => ({
      ...file,
      path: presentPath(file.path),
      ...(file.previousPath ? { previousPath: presentPath(file.previousPath) } : {}),
    })),
  };
}
