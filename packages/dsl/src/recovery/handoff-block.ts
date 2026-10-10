import fs from "node:fs";
import path from "node:path";
import { redactSensitiveValue, redactText } from "./handoff-redact.js";
import { HANDOFF_FILES_DIR, WALK_DEPTH, type InputProvenance } from "./handoff-files.js";

// The handoff a run's attempt leaves for its continuation, rendered for the model from the durable escalation row and the
// journal alone: a resumed continuation rebuilds the same words from the same journal. Every section has its own budget
// and the assembled text is never sliced, so the header, the reason and the closing instruction are always present
// whatever the state's size.

/** What the block says of the escalation. */
export type HandoffBlockInput = {
  kind: string; stage: string; summary: string;
  step_label?: string | null; step_exec_id?: string | null;
  state?: Record<string, unknown> | null;
  workflow_sha_used?: string | null;
  cost_usd?: number | null;
  evidence_dir?: string | null;
  /** Where the attempt's report.md was moved, when one existed. */
  report_path?: string | null;
  /** Workspace-relative paths the attempt's files were written to. */
  files?: readonly string[] | null;
  /** Where each input the attempt started from came from, and its form. */
  inputs?: readonly InputProvenance[] | null;
  /** The host's sizes for the continuation, stated as one line. */
  budget?: { max_tool_calls?: number; max_seconds?: number } | null;
};

const VALUE_LIMIT = 400;
const ARRAY_LIMIT = 20;
/** The state at the gate is rendered whole up to this size; beyond it the block points at state.json. */
export const STATE_LIMIT = 48 * 1024;
/** The Files section lists this many paths, then counts the rest by directory. */
const FILES_LIST_LIMIT = 200;
const SHAPES_LIMIT = 3 * 1024;
const SHAPE_LINE_LIMIT = 160;

/** Strings above the limit become a prefix plus a marker with the omitted length; nested values recurse. */
export function boundedValue(value: unknown, limit = VALUE_LIMIT): unknown {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}<${value.length - limit} more chars>` : value;
  if (Array.isArray(value)) {
    const head = value.slice(0, ARRAY_LIMIT).map(v => boundedValue(v, limit));
    return value.length > ARRAY_LIMIT ? [...head, `<${value.length - ARRAY_LIMIT} more items>`] : head;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, boundedValue(v, limit)]));
  return value;
}


/** One line per completed output in the state: the key the workflow wrote and the shape it holds. */
export function stateShapes(state: Record<string, unknown> | null | undefined): string[] {
  if (!state || typeof state !== "object") return [];
  return Object.entries(state).map(([key, value]) => {
    let line: string;
    if (value === null || value === undefined) line = `- ${key}: empty`;
    else if (Array.isArray(value)) line = `- ${key}: array of ${value.length}`;
    else if (typeof value === "object") {
      const keys = Object.keys(value as object);
      line = `- ${key}: object {${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""}}`;
    } else if (typeof value === "string") line = `- ${key}: string (${value.length} chars)`;
    else line = `- ${key}: ${typeof value}`;
    return line.length > SHAPE_LINE_LIMIT ? `${line.slice(0, SHAPE_LINE_LIMIT)}…` : line;
  });
}

/** The shapes section under its own budget: whole lines until the budget is spent, then a count. */
function shapesSection(shapes: string[], budget: number): string[] {
  if (!shapes.length) return ["- none"];
  const kept: string[] = [];
  let used = 0;
  for (const line of shapes) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < shapes.length) kept.push(`- …and ${shapes.length - kept.length} more keys (${shapes.length} in total)`);
  return kept;
}

/** The block lists this many inputs, then counts the rest; inputs.json lists every one. */
const INPUT_LINE_LIMIT = 100;
const INPUT_VALUE_LIMIT = 200;

/** The inputs section: one line per input, its path, its form and its value (a long value by size). */
function inputsSection(inputs: readonly InputProvenance[] | null | undefined, filed: boolean): string[] {
  if (!inputs?.length) return [];
  const label = (form: InputProvenance["form"]) => form === "email" ? "identifier (email address)" : form === "url" ? "identifier (URL)" : form === "text" ? "typed text" : form;
  return ["", `Inputs the run started from, as the dispatch carried them (path: form: value)${filed ? `; whole in \`${HANDOFF_FILES_DIR}/inputs.json\`` : ""}. An identifier is a value of a fixed form a source can be matched on; typed text is what was written in:`,
    ...inputs.slice(0, INPUT_LINE_LIMIT).map((input) => `- ${input.path}: ${label(input.form)}: ${input.value.length > INPUT_VALUE_LIMIT ? `(${input.value.length} chars)` : input.value.replace(/\s+/g, " ")}`),
    ...(inputs.length > INPUT_LINE_LIMIT ? [`- …${inputs.length - INPUT_LINE_LIMIT} more inputs (${inputs.length} in total)${filed ? `, each with its path and form in \`${HANDOFF_FILES_DIR}/inputs.json\`` : ""}`] : [])];
}

/** The one line that states the host's sizes for the continuation, or "" when the host sent none. */
export function escalationBudgetLine(budget: HandoffBlockInput["budget"]): string {
  if (!budget) return "";
  const sizes = [
    ...(budget.max_tool_calls !== undefined ? [`${budget.max_tool_calls} external tool calls`] : []),
    ...(budget.max_seconds !== undefined ? [`${budget.max_seconds} seconds`] : []),
  ];
  return sizes.length ? `Budget for this continuation (set by the host): ${sizes.join(" and ")}.` : "";
}

/** The Files section: every path the attempt left for the continuation. */
function filesSection(context: HandoffBlockInput): string[] {
  const frozen = [...(context.files ?? [])];
  const lines: string[] = [];
  const described: Record<string, string> = {
    [`${HANDOFF_FILES_DIR}/state.json`]: "the workflow state at the gate, whole",
    [`${HANDOFF_FILES_DIR}/gate.json`]: "the gate: kind, stage, step, reason, its state and every committed route decision",
    [`${HANDOFF_FILES_DIR}/inputs.json`]: "the inputs the frozen attempt started from, with each one's path and form",
  };
  const shown = frozen.slice(0, FILES_LIST_LIMIT);
  for (const file of shown) lines.push(`- ${file}${described[file] ? `: ${described[file]}` : ""}`);
  if (frozen.length > shown.length) {
    const rest = new Map<string, number>();
    for (const file of frozen.slice(shown.length)) { const dir = path.posix.dirname(file); rest.set(dir, (rest.get(dir) ?? 0) + 1); }
    for (const [dir, count] of rest) lines.push(`- …${count} more under ${dir}/`);
  }
  if (!lines.length) return [];
  const items = frozen.some((file) => file.startsWith(`${HANDOFF_FILES_DIR}/items/`));
  const effects = frozen.some((file) => file.startsWith(`${HANDOFF_FILES_DIR}/effects/`));
  return ["", "Files the frozen attempt left in the workspace (read them; they are whole where this text is not):",
    ...(items ? [`Each file under ${HANDOFF_FILES_DIR}/items/ is one record the workflow judged, with its text and its scores.`] : []),
    ...(effects ? [`Each file under ${HANDOFF_FILES_DIR}/effects/ is one paid call: its arguments and its full result.`] : []),
    ...lines];
}

/** The block the continuation reads first. Deterministic for a given row; policy-agnostic. The reason is the
 *  workflow's own text, whole; the state at the gate is whole up to STATE_LIMIT, and beyond it the
 *  block points at the file that holds it. */
export function escalationContextBlock(context: HandoffBlockInput): string {
  const step = context.step_label ?? context.stage;
  const summary = redactText(String(context.summary || "").trim()) || "(no summary recorded)";
  const budget = escalationBudgetLine(context.budget);
  const header = [
    "## YOU ARE CONTINUING A RUN THAT ESCALATED",
    "",
    `A reviewed workflow${context.workflow_sha_used ? ` (${String(context.workflow_sha_used).slice(0, 12)})` : ""} ran first and stopped at step \`${step}\`${context.step_exec_id ? ` (execution ${context.step_exec_id})` : ""}: ${context.kind}${context.stage && context.stage !== step ? ` at stage ${context.stage}` : ""}.`,
    "",
    "Why it stopped:",
    summary,
    ...(budget ? ["", budget] : []),
    "",
  ];
  const footer = [
    "",
    ...(context.evidence_dir ? [`Evidence gathered so far is under \`${context.evidence_dir}\`.`] : []),
    ...(context.report_path ? [`The frozen attempt's report was moved to \`${context.report_path}\`.`] : []),
    ...(typeof context.cost_usd === "number"
      ? [`The frozen attempt spent $${context.cost_usd.toFixed(4)}.`]
      : []),
    "",
    "Continue the job from this state. Do not redo completed work; build on it. When you explain what happened, cite this escalation (its step and reason) rather than inventing a cause.",
  ];
  const shapes = shapesSection(stateShapes(context.state), SHAPES_LIMIT);
  const stateFile = (context.files ?? []).includes(`${HANDOFF_FILES_DIR}/state.json`) ? `${HANDOFF_FILES_DIR}/state.json` : null;
  const stateJson = JSON.stringify(redactSensitiveValue(context.state ?? {}), null, 2);
  const state = stateJson.length <= STATE_LIMIT
    ? ["", `State at the gate (whole${stateFile ? `; also in \`${stateFile}\`` : ""}):`, "```json", stateJson, "```"]
    : ["", `State body is ${stateJson.length} chars (${Object.keys(context.state ?? {}).length} keys), beyond what this text carries; ${stateFile ? `read it whole in \`${stateFile}\`` : "the list above names every key with its type and size"}.`];
  const filedInputs = (context.files ?? []).includes(`${HANDOFF_FILES_DIR}/inputs.json`);
  return redactText([...header, "Completed outputs it left in the workflow state (do not redo this work):", ...shapes, ...state, ...inputsSection(context.inputs, filedInputs), ...filesSection(context), ...footer].join("\n"));
}
