export { posixPath } from "./util.js";

export function sanitizeForGitArgument(value: string): string {
  if (!/^[a-zA-Z0-9._/@:+-]+$/.test(value) || value.startsWith("-")) {
    throw new Error("Unsafe Git argument.");
  }
  return value;
}
