// A run's tool gate as the runner builds it (tool-gate.ts runGate): the server's tool settings as the runner reads them
// from the one store (tool-plane.ts loadToolSettings: checked, failing closed, a value that does not read marked), the
// revision's own settings, whether anyone can approve, and its approvals.
import { nameMapOf, RunGate, settingsKeyOf, SETTINGS_UNREAD } from "../dist/tool-gate.js";
import { checkToolSettings, resolveCapability } from "../dist/tool-plane.js";
import { builtinHarness } from "../dist/harness-table.js";

/** The facts a built-in harness's adapter states (none for pi), as a caller names them to the gate and the plane. */
export const builtinFacts = (harness) => builtinHarness(harness)?.facts;

/** The settings key a call of `name` on the built-in `harness` is held to (tool-gate.ts settingsKeyOf), on its facts. */
export const builtinKeyOf = (harness, name) => settingsKeyOf(harness, name, nameMapOf(harness, builtinFacts(harness)));

/** What `capability` resolves to (tool-plane.ts resolveCapability) for `input`, on its built-in harness's facts unless it
 *  names its own. */
export const resolveOnBuiltin = (capability, input) => resolveCapability(capability, { facts: builtinFacts(input.harness), ...input });

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

/** A run's gate: the server's stored `settings` (a value, or a reader), the revision's own `overrides`, `harness`,
 *  `approvers` and `approvals`, its folder `root`, and `argumentsOf`, the arguments its pinned listing
 *  declares of each MCP tool (ClaimMcp.argumentsOf). */
export function runnerGate({ settings, overrides = {}, harness = "pi", approvers = true, approvals = "ask", root = "/nonexistent/run", work, argumentsOf } = {}) {
  const read = typeof settings === "function" ? settings : () => storedSettings(settings);
  return new RunGate({ root, work: work ?? root, runId: "r1", ...(harness ? { harness } : {}), ...(argumentsOf ? { argumentsOf } : {}), facts: builtinFacts(harness) }, read, overrides, approvers, approvals);
}

/** The words a call the gate refuses is answered with, or its verdict ("allow" or "ask"). */
export const verdictOf = async (gate, name, args = {}) => {
  const decided = await gate.decide(name, args);
  return typeof decided === "string" ? decided : decided.deny;
};
