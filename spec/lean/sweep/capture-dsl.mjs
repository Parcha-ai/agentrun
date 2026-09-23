// The DSL entry point with the validation entry points wrapped to record their workflows.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as dsl from "../../../packages/dsl/dist/index.js";

export * from "../../../packages/dsl/dist/index.js";

const directory = process.env.LEAN_SWEEP_DIR;
const source = process.argv[1] ?? "unknown";

function record(workflow, inputKeys) {
  if (!directory) return;
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
export function dryRunWorkflow(workflow, ...rest) {
  record(workflow, null);
  return dsl.dryRunWorkflow(workflow, ...rest);
}
export function runTypedWorkflow(workflow, input, deps) {
  record(workflow, null);
  record(workflow, keysOf(input));
  return dsl.runTypedWorkflow(workflow, input, deps);
}
