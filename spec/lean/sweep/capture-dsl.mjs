// The DSL entry point with the validation entry points wrapped to record their workflows.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { types } from "node:util";
import * as dsl from "../../../packages/dsl/dist/index.js";

export * from "../../../packages/dsl/dist/index.js";

const directory = process.env.LEAN_SWEEP_DIR;
const source = process.argv[1] ?? "unknown";

/** Plain JSON data, decided without running accessors or entering proxy traps (the
 *  admission tests assert neither happens). Anything else is not recorded. */
function plainData(value, ancestors = new Set()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  ancestors.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) return false;
    if (descriptor.enumerable && descriptor.value !== undefined && !plainData(descriptor.value, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}

function record(workflow, inputKeys) {
  if (!directory || !plainData(workflow)) return;
  let text;
  try { text = JSON.stringify({ workflow, inputKeys }); } catch { return; }
  if (!text || !text.includes('"root"')) return;
  const entry = JSON.parse(text);
  const id = createHash("sha256").update(text).digest("hex").slice(0, 24);
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/${id}.json`, JSON.stringify({ source, ...entry }));
}

const keysOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : null);

export function validateWorkflow(workflow, opts) {
  record(workflow, opts?.input !== undefined ? keysOf(opts.input) : opts?.inputKeys ?? null);
  return dsl.validateWorkflow(workflow, opts);
}
export function runWorkflow(workflow, input, deps) {
  record(workflow, null);
  record(workflow, keysOf(input));
  return dsl.runWorkflow(workflow, input, deps);
}
export function runWorkflowSlice(workflow, input, focus, deps) {
  record(workflow, null);
  return dsl.runWorkflowSlice(workflow, input, focus, deps);
}
/** The input keys `dryRunWorkflow` validates and runs with: the explicit input, or the
 *  object it synthesizes from the declared input schema, plus `context` for a probe. */
function dryRunKeys(workflow, opts) {
  const explicit = keysOf(opts?.input);
  const declared = plainData(workflow) ? keysOf(workflow?.schemas?.[workflow?.input?.schemaId]?.properties) : null;
  const keys = opts?.input !== undefined ? explicit : declared ?? (workflow?.input ? null : []);
  if (!keys) return null;
  return opts?.probeContext && !keys.includes("context") ? [...keys, "context"] : keys;
}
export function dryRunWorkflow(workflow, opts) {
  record(workflow, null);
  record(workflow, dryRunKeys(workflow, opts));
  return dsl.dryRunWorkflow(workflow, opts);
}
export function runTypedWorkflow(workflow, input, deps) {
  record(workflow, null);
  record(workflow, keysOf(input));
  return dsl.runTypedWorkflow(workflow, input, deps);
}
