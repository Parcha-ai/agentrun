// A run's tool gate as the runner builds it (tool-gate.ts runGate): the server's tool settings as the runner reads them
// from the one store (tool-plane.ts loadToolSettings: checked, failing closed, a value that does not read marked), the
// revision's own settings, whether anyone can approve, and its approvals.
import { RunGate, SETTINGS_UNREAD } from "../dist/tool-gate.js";
import { checkToolSettings } from "../dist/tool-plane.js";

/** The server's stored tool settings `value` as the runner reads them (loadToolSettings): none stored is every default. */
export function storedSettings(value) {
  if (value === undefined) return { settings: {}, problems: [] };
  const read = checkToolSettings(value, "the stored tool settings");
  if (read.unreadable) read.settings[SETTINGS_UNREAD] = true;
  return read;
}

/** A reader of the server's settings that a test may change between calls (`set`), as the gate reads them at each call. */
export function liveSettings(value) {
  let read = storedSettings(value);
  return { read: () => read, set: (next) => void (read = storedSettings(next)), readAs: (given) => void (read = given) };
}

/** A run's gate: the server's stored `settings` (a value, or a reader), the revision's own `overrides`, `harness`, the MCP
 *  servers it pins, `approvers` and `approvals`, and where its own files are read (`files`, its folder `root`). */
export function runnerGate({ settings, overrides = {}, harness = "pi", mcpServers, approvers = true, approvals = "ask", root = "/nonexistent/run", work, files } = {}) {
  const read = typeof settings === "function" ? settings : () => storedSettings(settings);
  return new RunGate({ root, work: work ?? root, runId: "r1", ...(harness ? { harness } : {}), ...(mcpServers ? { mcpServers } : {}) }, read, overrides, approvers, approvals, files ?? root);
}

/** The words a call the gate refuses is answered with, or its verdict ("allow" or "ask"). */
export const verdictOf = async (gate, name, args = {}) => {
  const decided = await gate.decide(name, args);
  return typeof decided === "string" ? decided : decided.deny;
};
