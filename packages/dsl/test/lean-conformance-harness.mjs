// Runs one Lean-conformance case (spec/lean/conformance/*.json) through the TypeScript
// interpreter with adapters scripted by the case. The Lean model reads the same files
// (`lake exe conformance`), so both sides are checked against one `expected` block.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runWorkflow, validateWorkflow, WorkflowStateError, WorkflowInvalidError, WorkflowInputInvalidError,
  WorkflowOutputInvalidError, EscalationSignal,
} from "../dist/index.js";

export const CASES_DIR = fileURLToPath(new URL("../../../spec/lean/conformance/", import.meta.url));
const COMPARED = new Set(["node.start", "node.end", "loop.exited", "escalate.evaluated", "route.chosen"]);

export function loadCases() {
  return readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort()
    .map((file) => ({ file, case: JSON.parse(readFileSync(CASES_DIR + file, "utf8")) }));
}

class ScriptedFailure extends Error {}

function eventText(e) {
  switch (e.type) {
    case "node.start": return `node.start:${e.label}`;
    case "node.end": return `node.end:${e.label}:${e.detail.status}`;
    case "loop.exited": return `loop.exited:${e.label}:${e.detail.reason}:${e.detail.iterations}`;
    case "escalate.evaluated": return `escalate.evaluated:${e.label}:${e.detail.fired}`;
    case "route.chosen": return `route.chosen:${e.label}:${e.detail.value.taken}`;
  }
}

function errorOf(error) {
  if (error instanceof WorkflowStateError) return { kind: "state", reason: error.reason, label: error.stage, path: error.path };
  if (error instanceof WorkflowInvalidError) return { kind: "invalid" };
  if (error instanceof WorkflowInputInvalidError) return { kind: "input_invalid" };
  if (error instanceof WorkflowOutputInvalidError) return { kind: "output_invalid" };
  if (error instanceof ScriptedFailure || error?.name === "WorkflowCodeError" || error?.name === "SystemOneError") return { kind: "adapter" };
  return { kind: "engine", message: String(error?.message ?? error) };
}

/** The node at an execution path, for recording code nodes' return values. */
export function nodeAt(workflow, executionPath) {
  const parts = executionPath.split("/").slice(2);
  let node = workflow.root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "steps") node = node.steps[Number(parts[++i])];
    else if (part === "branches") {
      const key = parts[++i];
      node = node.node === "route" ? node.branches[key] : node.branches[Number(key)];
    } else if (part === "items" || part === "iterations") i++;
    else if (part === "body") node = node.body;
    else if (part === "workflow") { node = node.workflow.root; i++; }
  }
  return node;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The value a code node returned, recovered from the patch the interpreter applied:
 *  `{[as]: out}`, the returned object itself, or `{[label]: out}` for any other return.
 *  Returning `{[label]: x}` with a non-object `x` applies the same patch as returning `x`;
 *  both are recorded as `x`, which the model wraps back into the identical patch. */
function codeReturn(node, patch) {
  if (node.as) return patch[node.as];
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === node.label && !isPlainObject(patch[node.label])) return patch[node.label];
  return patch;
}

export async function runCase(c) {
  if (!validateWorkflow(c.workflow, { input: c.input }).ok) return { expected: { valid: false }, codeReturns: {} };
  const script = c.script ?? {};
  const at = (kind, path) => script[kind]?.[path];
  const need = (kind, path) => {
    const entry = at(kind, path);
    if (!entry) throw new ScriptedFailure(`no scripted ${kind} at ${path}`);
    if (entry.throw) throw new ScriptedFailure(entry.throw);
    return structuredClone(entry);
  };
  const events = [];
  const codeReturns = {};
  const deps = {
    runNode: async ({ kind, executionPath }) => {
      const entry = need("gen", executionPath);
      return kind === "report" ? { report_markdown: entry.markdown } : entry.submission;
    },
    runJudge: async ({ executionPath }) => ({ answers: need("judge", executionPath).answers }),
    runEffect: async ({ executionPath }) => need("effect", executionPath).result,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "code.patch") {
        const node = nodeAt(c.workflow, event.executionPath);
        codeReturns[event.executionPath] = { return: codeReturn(node, event.detail) };
      }
    },
  };
  const hostChannel = Object.values(script.gen ?? {}).some((entry) => entry.host !== undefined);
  if (hostChannel || script.after) {
    deps.hostPolicy = {
      ...(hostChannel ? { decodeSubmission: (raw, ctx) => ({ value: raw, host: at("gen", ctx.executionPath)?.host }) } : {}),
      ...(script.after ? { afterNode: (ctx) => structuredClone(at("after", ctx.executionPath)) } : {}),
    };
  }
  let result;
  try {
    const run = await runWorkflow(c.workflow, c.input, deps);
    result = run.status === "complete"
      ? { outcome: "complete", state: run.state, output: run.output }
      : { outcome: "escalated", state: run.state, escalation: { kind: run.escalation.kind, stage: run.escalation.stage, label: run.escalation.label } };
  } catch (error) {
    if (error instanceof EscalationSignal) throw error;
    result = { outcome: "failed", error: errorOf(error) };
  }
  const grouped = {};
  for (const event of events) {
    if (!COMPARED.has(event.type)) continue;
    (grouped[event.executionPath] ??= []).push(eventText(event));
  }
  // JSON round trip: `undefined` members disappear exactly as they do from the case file.
  const expected = JSON.parse(JSON.stringify({ valid: true, ...result, events: grouped }));
  return { expected, codeReturns };
}
