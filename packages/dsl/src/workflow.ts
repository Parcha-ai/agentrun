import { observerSnapshot } from "./observer-snapshot.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { predicateMatches, getPath, MECHANICAL_PREDICATE_NAMES, type AcceptPredicate } from "./predicates.js";
import { WORKFLOW_NODE_KINDS, NODE_FIELDS, HOST_NODE_FIELDS, IGNORED_NODE_FIELDS, WORKFLOW_PREDICATES, THINKING_LEVELS, MODEL_TIERS, CALL_TRANSPORTS, CALL_RETRY_CLASSES, PROSE_ARTIFACT_TYPES, type WorkflowNodeKind } from "./vocabulary.js";
import { validateAnswers, answerConfidence, answersSidecar, answersToValue, compileQuestions, SYSTEM_ONE_LIMITS, type AnswersSidecar, type CompiledQuestions, type SystemOneAnswer, type SystemOneQuestion } from "./system-one.js";
import { Compile } from "typebox/compile";
import { compileTransform, compileTransformSyntax } from "./code-exec.js";
import { workflowShapeErrors } from "./workflow-shape.js";
import { resolveSchemaForWorkflow } from "./schema-references.js";
export { resolveSchemaForWorkflow } from "./schema-references.js";

/** The model tier a node asks for: `fast` (the cheap tier), `strong` (the host's stronger model),
 *  or the kind's default. A router that sends the few thin cases to `strong` buys depth only where the
 *  decision is on the edge. */
export type ModelTier = "fast" | "default" | "strong";
export type VerifyClause = { out: string; state?: Record<string, unknown>; maxDrives?: number; override?: { below: number } };
export type AskPredicate = { predicate: "ask"; instructions: string; state?: Record<string, unknown>; criteria?: { true?: string; false?: string }; gte?: number };
export type MechanicalPredicate = AcceptPredicate;
export type Predicate = MechanicalPredicate | AskPredicate;

// Generative node kinds are adapter presets. Tools, effort, thinking and tier are requests to
// the adapter; resource ceilings and allowed capabilities remain host-owned.
export type WorkflowEffort = "minimal" | "low" | "medium" | "high";
/** The author's thinking dial. There is deliberately no "off": thinking is never off. */
export type WorkflowThinking = "low" | "medium" | "high";

/** Host-owned markers on a node: any JSON object. The engine admits, carries and hashes it with the
 *  document and never reads it; it never reaches state, events, prompts or effect identities. */
export type NodeMetadata = { [key: string]: unknown };

export type WorkflowNode =
  | { node: "chain"; steps: WorkflowNode[]; metadata?: NodeMetadata }
  | { node: "code"; label: string; code: string; as?: string; metadata?: NodeMetadata }
  | { node: "agent"; label: string; instructions: string; state?: Record<string, unknown>; sopSection?: string | string[]; out: string; as?: string; requires?: string[]; tools?: string[]; effort?: WorkflowEffort; thinking?: WorkflowThinking; verify?: VerifyClause; tier?: ModelTier; metadata?: NodeMetadata }
  | { node: "decide"; label: string; instructions: string; state?: Record<string, unknown>; sopSection?: string | string[]; out: string; as?: string; requires?: string[]; tools?: string[]; effort?: WorkflowEffort; thinking?: WorkflowThinking; verify?: VerifyClause; tier?: ModelTier; metadata?: NodeMetadata }
  | { node: "extract"; label: string; instructions: string; state?: Record<string, unknown>; sopSection?: string | string[]; out: string; as?: string; requires?: string[]; tools?: string[]; effort?: WorkflowEffort; thinking?: WorkflowThinking; verify?: VerifyClause; tier?: ModelTier; metadata?: NodeMetadata }
  | { node: "report"; label: string; instructions: string; state?: Record<string, unknown>; sopSection?: string | string[]; requires?: string[]; tools?: string[]; effort?: WorkflowEffort; thinking?: WorkflowThinking; metadata?: NodeMetadata }
  | ArtifactNode
  | { node: "map"; label: string; itemsPath: string; body: WorkflowNode; as: string; resultPath?: string; maxConcurrency?: number; metadata?: NodeMetadata }
  | { node: "parallel"; label: string; branches: WorkflowNode[]; metadata?: NodeMetadata }
  | { node: "loop"; label: string; body: WorkflowNode; until: Predicate; maxIters: number; metadata?: NodeMetadata }
  | { node: "escalate"; label: string; when: Predicate; kind: string; stage: string; summary: string; metadata?: NodeMetadata }
  | JudgeNode
  | PickNode
  | SiftNode
  | RouteNode
  | CallNode
  | WorkflowInvocation;

/** A judgment as typed questions. `state` is what the questions see, interpolated by value from the
 *  workflow state (a whole-string placeholder keeps its type); `out` is a flat schema of enums,
 *  booleans and level-integers — the question set. The schema-valid value lands at `as`, the raw
 *  answers with their confidences at `<as>$answers`. No tools, no turns, one request. */
export type JudgeNode = { node: "judge"; label: string; state: Record<string, unknown>; out: string; as: string; requires?: string[]; metadata?: NodeMetadata };
/** One choice whose options are the items of a list. `describe` renders each item as its option
 *  text (`{item.field}`); `allowNone` adds a none-of-these option. The result at `as` is
 *  {index, item, none, option}; confidence is `<as>$answers.confidence.pick` and the
 *  distribution is `<as>$answers.answers.pick.probabilities`. */
export type PickNode = { node: "pick"; label: string; itemsPath: string; describe: string; instructions: string; state?: Record<string, unknown>; allowNone?: boolean; as: string; requires?: string[]; metadata?: NodeMetadata };
/** The same question set (`out`, a judge schema) asked of every item of a list in ONE request: item i's
 *  questions are prefixed `i.`; every answer lands in `as.answers[i]` and `as.values[i]`. `keep`
 *  filters: items whose answer at `keep.path` (a question id, or `<id>.confidence`) is at least
 *  `keep.gte` (a boolean question keeps on yes) land in `as.items`, in the original order. */
export type SiftNode = { node: "sift"; label: string; itemsPath: string; describe?: string; state?: Record<string, unknown>; out: string; as: string; keep?: { path: string; gte?: number }; requires?: string[]; metadata?: NodeMetadata };
/** A choice among subgraphs. The options are the branch names, their criteria the branch
 *  descriptions; the chosen branch runs on the state. `as` (optional) records the choice and its
 *  distribution; `unsure` names the branch taken when confidence is below `gte`. */
export type RouteNode = { node: "route"; label: string; state: Record<string, unknown>; instructions: string; branches: { [branch: string]: { criteria?: string; body: WorkflowNode } }; unsure?: { branch: string; gte: number }; as?: string; requires?: string[]; metadata?: NodeMetadata };

/** A child workflow invoked as one step of its parent. The child is embedded whole, so the parent
 *  digest covers every child byte; `input` is interpolated by value and is the child's ENTIRE initial
 *  state (no parent state leaks in); the child's validated output is checked against the parent's
 *  `out` schema and lands at `as`. The parent owns the terminal: a child never renders a report or
 *  delivers an artifact. Children may otherwise compose all workflow primitives. */
export type WorkflowInvocation = { node: "workflow"; label: string; workflow: Workflow; input: Record<string, unknown>; out: string; as: string; metadata?: NodeMetadata };

/** `exit` is a shell command that ended with a non-zero status: retried only when the author
 *  declared retry, since re-running a command is the author's call. */
export type CallRetryClass = "timeout" | "http_5xx" | "http_429" | "connection" | "exit";
/** The workflow's terminal deliverable. Types "markdown" and "report" use the report
 * writer; other non-empty types name a workspace file produced by an earlier call.
 * File existence and delivery are the host's responsibility. */
export type ArtifactNode = {
  node: "artifact";
  label: string;
  /** Host-defined file type, or "markdown"/"report" for prose. */
  type: string;
  /** File types: the workspace-relative primary file, produced by an earlier call. */
  path?: string;
  /** Prose types: the report writer's fields. */
  instructions?: string;
  state?: Record<string, unknown>;
  sopSection?: string | string[];
  tools?: string[];
  effort?: WorkflowEffort;
  thinking?: WorkflowThinking;
  requires?: string[];
  metadata?: NodeMetadata;
};

export type ArtifactState = { path: string; filename: string; type: string };

export function artifactNodeIsProse(node: ArtifactNode): boolean {
  return (PROSE_ARTIFACT_TYPES as readonly string[]).includes(node.type);
}

export function desugarWorkflow(workflow: Workflow): Workflow {
  const visit = (node: WorkflowNode): WorkflowNode => {
    if (!node || typeof node !== "object") return node;
    if (node.node === "artifact" && artifactNodeIsProse(node)) {
      const { node: _kind, type: _type, path: _path, ...rest } = node;
      return { node: "report", ...rest } as WorkflowNode;
    }
    if (node.node === "chain") return { ...node, steps: (node.steps || []).map(visit) };
    if (node.node === "parallel") return { ...node, branches: (node.branches || []).map(visit) };
    if (node.node === "map" || node.node === "loop") return { ...node, body: visit(node.body) };
    if (node.node === "route") return { ...node, branches: Object.fromEntries(Object.entries(node.branches || {}).map(([k, b]) => [k, { ...b, body: visit(b?.body) }])) };
    if (node.node === "workflow") return { ...node, workflow: desugarWorkflow(node.workflow) };
    return node;
  };
  if (!workflow || typeof workflow !== "object" || !workflow.root) return workflow;
  return { ...workflow, root: visit(workflow.root) };
}

export function terminalArtifactType(workflow: Workflow): string | null {
  const steps = workflow?.root?.node === "chain" ? (workflow.root as Extract<WorkflowNode, { node: "chain" }>).steps || [] : [workflow?.root];
  const last = steps[steps.length - 1] as WorkflowNode | undefined;
  if (!last || last.node !== "artifact") return null;
  return last.type;
}

/** A predicate a `call` evaluates against ITS OWN RESULT: paths are result-relative. */
export type CallPredicate = MechanicalPredicate;
export type PollClause = { until: CallPredicate; fail_when?: CallPredicate; interval_s: number; deadline_s: number };
export type CallNode = {
  node: "call";
  label: string;
  via: "tool" | "executor" | "shell";
  /** `via: tool` — the host tool address. */
  tool?: string;
  /** `via: tool` — typed args; `{dot.path}` interpolation by value. */
  args?: Record<string, unknown>;
  /** `via: executor` — the body run on the executor; must `return` JSON. */
  code?: string;
  /** `via: executor` — the JSON value bound to `input` inside the body; interpolated. */
  input?: Record<string, unknown>;
  /** `via: shell` — the command, taken LITERALLY (it is code; `{…}` in it is the script's own
   *  syntax). Values reach it through `env`. */
  command?: string;
  /** `via: shell` — environment variables for the command, interpolated by value and passed to
   *  the process directly (never through shell quoting): the way a long prompt or a JSON record
   *  reaches a script. */
  env?: { [name: string]: string };
  /** Reserved. Only `sandbox` is accepted today. */
  where?: "sandbox";
  /** Schema id of the JSON result (`tool` and `executor`); `shell` results are the fixed ShellResult shape. */
  out?: string;
  /** State key the result lands under. */
  as: string;
  /** Workspace-relative files the node promises to create; verified after the effect. Each entry
   *  interpolates `{dot.path}` by value, so a call inside a map can name its item's file. */
  produces?: string[];
  /** Wall bound in seconds for one execution. Required: an unbounded effect is how a stalled provider becomes a stalled job. */
  deadline_s: number;
  retry?: { attempts: number; backoff_s?: number; on?: CallRetryClass[] };
  /** Repeat the call until its result settles (a queued job, an eventually consistent read). */
  poll?: PollClause;
  requires?: string[];
  metadata?: NodeMetadata;
};

export const SHELL_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["code", "stdout", "stderr"],
  properties: { code: { type: "integer" }, stdout: { type: "string" }, stderr: { type: "string" }, truncated: { type: "boolean" } },
};

export type LlmNode = Extract<WorkflowNode, { node: "agent" | "decide" | "extract" | "report" }>;

export const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["report_markdown"],
  properties: { report_markdown: { type: "string", minLength: 40, pattern: "\\S" } },
};

export type Workflow = {
  v: 2;
  name: string;
  schemas: { [id: string]: { [keyword: string]: unknown } };
  /** Initial state schema, enforced when present. Required for child workflows. */
  input?: { schemaId: string };
  output: { schemaId: string; path?: string };
  root: WorkflowNode;
};

export type Escalation = { kind: string; stage: string; summary: string; state: Record<string, unknown>;
  label?: string;
  executionPath?: string };

export type WorkflowRunResult =
  | { status: "complete"; state: Record<string, unknown>; output: unknown;
      /** What the host's policy wrote through `decodeSubmission`: the final `state.$host`, never part of `output`. */
      host?: Record<string, unknown> }
  | { status: "escalated"; state: Record<string, unknown>; escalation: Escalation };

export type MapItem = { label: string; index: number };

/** Where a host policy hook is being applied. `terminal` is true for a generative node whose `out` is
 *  the workflow's output schema: the node that emits the terminal record. */
export type HostPolicyContext = {
  workflow: { name: string; outputSchemaId: string };
  node: { kind: WorkflowNode["node"]; label: string; out?: string; as?: string };
  terminal: boolean;
  executionPath: string;
  item?: MapItem;
};

/** Application policy around generative nodes and completed steps. This is host code handed in through
 *  deps: nothing in a workflow document can name or reach it, so a candidate workflow cannot change its
 *  host's channels. Each hook is a general capability rather than a product rule:
 *  - `systemBlocks` appends host text after the node's instructions.
 *  - `submissionSchema` widens the schema the adapter submits against with host-owned channels. The
 *    returned schema must accept every value the stage schema accepts; the engine validates the raw
 *    submission against it and the decoded domain value against the unchanged stage schema, so no host
 *    channel can bypass domain validation or verification.
 *  - `decodeSubmission` splits an accepted transport submission into the domain value and host state.
 *    Host state lives under the reserved `$host` state key (no workflow may write it), so it is
 *    checkpointed and resumed with the rest of the state, isolated per map item, branch and child
 *    exactly as the state is, excluded from a path-less output projection, and returned as `result.host`.
 *    Parallel branches merge their `$host` deltas key by key: arrays append, an unchanged value is kept,
 *    two branches changing one non-array key to different values is a write conflict.
 *  - `afterNode` enriches a completed step's state before commit and checkpoint. This is domain state:
 *    downstream nodes and output validation see it. */
export type HostPolicy = {
  systemBlocks?: (context: HostPolicyContext) => string[];
  submissionSchema?: (stageSchema: Record<string, unknown>, context: HostPolicyContext) => Record<string, unknown>;
  decodeSubmission?: (submission: unknown, context: HostPolicyContext & { host: Record<string, unknown> }) => { value: unknown; host?: Record<string, unknown> };
  afterNode?: (context: HostPolicyContext & { state: Record<string, unknown> }) => Record<string, unknown> | undefined;
};

export type WorkflowDeps = {
  maxQuestionsPerRequest?: number;
  /** Host application policy; see `HostPolicy`. Absent = the engine's own behavior, unchanged. */
  hostPolicy?: HostPolicy;
  runNode?: (params: {
    kind: "agent" | "decide" | "extract" | "report";
    label: string;
    item?: MapItem;
    executionPath?: string;
    signal?: AbortSignal;
    system: string[];
    user: string;
    schema: Record<string, unknown>;
    effort?: WorkflowEffort;
    thinking?: WorkflowThinking;
    tools?: string[];
    /** The node's verify clause compiled to a submit-time reviewer: the runner hands it to the
     *  session's submit tool (`submit.review`); a verdict that does not accept continues the SAME
     *  session with the message as the next tool result. The engine verifies returned submissions even if the runner ignores this hook. */
    review?: (candidate: unknown) => Promise<{ accepted: true } | { accepted: false; message: string }>;
    tier?: ModelTier;
  }) => Promise<unknown>;
  runEffect?: (params: {
    node: CallNode;
    schema?: Record<string, unknown>;
    input: Record<string, unknown>;
    produces: string[];
    attempt: number;
    idempotencyKey: string;
    signal: AbortSignal;
    item?: MapItem;
    executionPath?: string;
  }) => Promise<unknown>;
  runJudge?: (params: {
    label: string;
    kind: "judge" | "pick" | "sift" | "route" | "ask";
    item?: MapItem;
    executionPath?: string;
    signal?: AbortSignal;
    state: unknown;
    questions: Record<string, SystemOneQuestion>;
  }) => Promise<{ answers: Record<string, SystemOneAnswer>; model?: string | null; usage?: { input_tokens: number; output_tokens: number } | null; cost_usd?: number | null; request_sha256?: string }>;
  syntheticEffects?: boolean;
  checkpoint?: (state: Record<string, unknown>, label: string, executionPath?: string) => Promise<void>;
  /** Critical recovery stores stop execution on write failure; omitted retains legacy best effort. */
  checkpointFailureMode?: "required" | "best_effort";
  recovery?: {
    /** Required for composed child graphs: every store key must include executionPath. */
    supportsExecutionPaths?: boolean;
    resume: (node: WorkflowNode, state: Record<string, unknown>, item?: MapItem, executionPath?: string) => Promise<Record<string, unknown> | undefined>;
    commit: (node: WorkflowNode, state: Record<string, unknown>, item?: MapItem, executionPath?: string) => Promise<void>;
    pollStartedAt: (node: CallNode, item?: MapItem, executionPath?: string) => number;
    wait: (node: CallNode, ms: number, item?: MapItem, executionPath?: string) => Promise<void>;
    fail?: (node: WorkflowNode, results: unknown[], error: unknown, executionPath?: string) => Promise<void>;
  };
  /** A completed-effect memo keyed by the call's idempotency key. A hit skips the effect and
   *  reuses its result; polled calls are never memoized (their result is a moment in time). */
  memo?: {
    get: (key: string, node: CallNode) => Promise<unknown>;
    put: (key: string, node: CallNode, result: unknown) => Promise<void>;
  };
  sop?: string;
  skill?: string;
  signal?: AbortSignal;
  /** Best-effort observation only: thrown errors and rejected promises are ignored.
   * Observers are never awaited. Use required checkpoints for durable lifecycle gates. */
  onEvent?: (event: { type: string; label: string; detail?: unknown; executionPath?: string }) => void;
};

export const declaredWrites = (node: WorkflowNode | undefined): Set<string> => {
  const out = new Set<string>();
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.node === "report") out.add("report_markdown");
    else if (typeof n.as === "string" && n.as.trim()) out.add(n.as);
    if (n.node === "map") return;
    if (Array.isArray(n.steps)) n.steps.forEach(visit);
    if (Array.isArray(n.branches)) n.branches.forEach(visit);
    else if (n.node === "route" && n.branches && typeof n.branches === "object") Object.values(n.branches).forEach((b: any) => visit(b?.body));
    if (n.body) visit(n.body);
  };
  visit(node);
  return out;
};
/** The top-level keys a loop body writes, with engine sidecars; null when an unaliased code node makes them unknowable. */
const loopBodyWrites = (body: WorkflowNode | undefined): Set<string> | null => {
  const out = new Set<string>();
  let known = true;
  const visit = (n: any): void => {
    if (!n || typeof n !== "object" || !known) return;
    if (n.node === "code" && n.as === undefined) { known = false; return; }
    if (n.node === "report") out.add("report_markdown");
    else if (typeof n.as === "string" && n.as.trim()) out.add(n.as);
    else if (["agent", "decide", "extract"].includes(n.node) && typeof n.label === "string") out.add(n.label);
    if (n.node === "map" || n.node === "workflow") return;
    if (Array.isArray(n.steps)) n.steps.forEach(visit);
    if (Array.isArray(n.branches)) n.branches.forEach(visit);
    else if (n.node === "route" && n.branches && typeof n.branches === "object") Object.values(n.branches).forEach((b: any) => visit(b?.body));
    if (n.body) visit(n.body);
  };
  visit(body);
  if (!known) return null;
  for (const key of [...out]) out.add(`${key}$answers`).add(`${key}$verify`);
  return out;
};
const routeBodies = (node: WorkflowNode): WorkflowNode[] => node.node === "route" ? Object.values(node.branches || {}).map((b) => b?.body).filter(Boolean) as WorkflowNode[] : [];
const snapshotState = (state: Record<string, unknown>): Record<string, unknown> => {
  try { return structuredClone(state); }
  catch (cause) { throw new Error("Workflow state must be structured-cloneable", { cause }); }
};
const KINDS: ReadonlySet<string> = new Set(WORKFLOW_NODE_KINDS);
// The vocabulary names exactly the kinds the WorkflowNode type declares.
type SameKinds<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const kindsMatchType: SameKinds<WorkflowNodeKind, WorkflowNode["node"]> = true;
void kindsMatchType;
const KIND_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(WORKFLOW_NODE_KINDS.map((kind) => [kind, new Set([...NODE_FIELDS[kind], ...HOST_NODE_FIELDS, ...(IGNORED_NODE_FIELDS[kind] ?? [])])]));
export const childSteps = (child: Workflow | undefined): WorkflowNode[] | null => {
  const root = child?.root;
  if (!root || typeof root !== "object") return null;
  return root.node === "chain" ? (Array.isArray(root.steps) ? root.steps : null) : [root];
};

export class EffectFailure extends Error {
  constructor(message: string, public readonly retryClass: CallRetryClass | null = null) {
    super(message);
    this.name = "EffectFailure";
  }
}

function containsReportNode(node: WorkflowNode | undefined): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.node === "report" || node.node === "artifact") return true;
  if (node.node === "chain") return (node.steps || []).some(containsReportNode);
  if (node.node === "parallel") return (node.branches || []).some(containsReportNode);
  if (node.node === "map" || node.node === "loop") return containsReportNode(node.body);
  if (node.node === "route") return routeBodies(node).some(containsReportNode);
  return false;
}
const PREDICATES: ReadonlySet<string> = new Set(WORKFLOW_PREDICATES);

function predicateShapeErrors(pred: { predicate: string; path?: string; values?: unknown; n?: unknown; instructions?: unknown; gte?: unknown; state?: unknown }): string[] {
  const out: string[] = [];
  if (pred.predicate === "in") {
    if (!String(pred.path || "").trim()) out.push("in needs a path");
    if (!Array.isArray(pred.values) || !pred.values.length || pred.values.some((v) => !["string", "number", "boolean"].includes(typeof v))) out.push("in needs a non-empty values list of strings, numbers, or booleans");
  }
  if (pred.predicate === "gte" || pred.predicate === "lt") {
    if (!String(pred.path || "").trim()) out.push(`${pred.predicate} needs a path`);
    if (typeof pred.n !== "number" || !Number.isFinite(pred.n)) out.push(`${pred.predicate} needs a finite number n`);
  }
  if (pred.predicate === "ask") {
    if (typeof pred.instructions !== "string" || !pred.instructions.trim()) out.push("ask needs instructions (the yes/no question)");
    // A yes/no gate sits above the fence: at 0.5 or below it would hold on an answer that is not a
    // yes, and a dry run's synthesized 0.5 could satisfy it.
    if (pred.gte !== undefined && !(typeof pred.gte === "number" && pred.gte > 0.5 && pred.gte <= 1)) out.push("ask.gte must be in (0.5, 1]");
    if (pred.state !== undefined && (!pred.state || typeof pred.state !== "object" || Array.isArray(pred.state))) out.push("ask.state must be an object map");
  }
  return out;
}

function resultPathMissing(shape: unknown, dotted: string): boolean {
  let cursor: any = shape;
  for (const segment of dotted.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !(segment in cursor)) return true;
    cursor = cursor[segment];
  }
  return false;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((c) => c.trim() !== "")) rows.push(row); }
  return rows;
}

export function buildReferenceContext(files: Record<string, string>): { references: Record<string, string>; references_parsed: Record<string, { header: string[]; rows: string[][] }> } {
  // Null prototypes: reference filenames are external data. On a plain object a name like
  // "__proto__" hits the prototype SETTER on assignment — the file silently vanishes from
  // the map (and worse shapes pollute it). A null-prototype object stores it as an ordinary
  // own key, so every filename round-trips.
  const references: Record<string, string> = Object.create(null);
  const referencesParsed: Record<string, { header: string[]; rows: string[][] }> = Object.create(null);
  for (const [name, body] of Object.entries(files)) {
    references[name] = body;
    if (name.toLowerCase().endsWith(".csv")) {
      const rows = parseCsvRows(body);
      if (rows.length) referencesParsed[name] = { header: rows[0], rows: rows.slice(1) };
    }
  }
  return { references, references_parsed: referencesParsed };
}

export function normalizeStringNullsForSchema(value: unknown, schema: Record<string, unknown> | undefined, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const properties = (schema as { properties?: Record<string, any> })?.properties || {};
  for (const [key, spec] of Object.entries(properties)) {
    if (!spec || typeof spec !== "object") continue;
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const anyOf: any[] = Array.isArray(spec.anyOf) ? spec.anyOf : [];
    const nullable = types.includes("null") || anyOf.some((variant) => variant?.type === "null");
    const current = (value as Record<string, unknown>)[key];
    if (nullable && typeof current === "string" && ["null", "none", "n/a"].includes(current.trim().toLowerCase())) {
      (value as Record<string, unknown>)[key] = null;
      continue;
    }
    const objectSpecs = [spec, ...anyOf].filter((candidate) => candidate?.type === "object" || (candidate?.properties && typeof candidate.properties === "object"));
    for (const objectSpec of objectSpecs) normalizeStringNullsForSchema(current, objectSpec as Record<string, unknown>, depth + 1);
    const items = spec.type === "array" || types.includes("array") ? spec.items : anyOf.find((variant) => variant?.type === "array")?.items;
    if (items && Array.isArray(current)) for (const element of current) normalizeStringNullsForSchema(element, items as Record<string, unknown>, depth + 1);
  }
  return value;
}

export function workflowSha256(workflow: Workflow): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as any).sort().map((k) => [k, stable((v as any)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(workflow))).digest("hex");
}

/** Bound the complete document before any recursive schema or semantic traversal. Shared
 * objects are valid, but each occurrence consumes the budget; cycles are never JSON. */
export function workflowDocumentError(value: unknown): string | undefined {
  const ancestors = new WeakSet<object>();
  const stack: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  let entries = 1;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.leave) { ancestors.delete(current.value as object); continue; }
    if (current.depth > 128) return "workflow document exceeds nesting depth 128";
    if (typeof current.value === "function") return "workflow document must contain data, not functions";
    if (current.value === null || typeof current.value !== "object") continue;
    if (utilTypes.isProxy(current.value)) return "workflow document must not contain proxies";
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return "workflow document must contain plain objects and arrays";
    if (ancestors.has(current.value)) return "workflow document contains a cycle";
    ancestors.add(current.value);
    stack.push({ ...current, leave: true });
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(current.value));
    if (descriptors.some(descriptor => descriptor.get || descriptor.set)) return "workflow document must not contain accessors";
    const values = descriptors.map(descriptor => descriptor.value);
    entries += values.length;
    if (entries > 100_000) return "workflow document exceeds 100000 expanded values";
    for (let i = values.length - 1; i >= 0; i--) stack.push({ value: values[i], depth: current.depth + 1 });
  }
  return undefined;
}

/** Set executeCode:false for untrusted author feedback: check syntax and mechanical contracts
 * without evaluating authored expressions or probing transforms. This is not execution admission;
 * trusted/default validation and runtime output checks remain authoritative. */
export function validateWorkflow(workflow: Workflow, opts?: { executeCode?: boolean; input?: Record<string, unknown>; inputKeys?: string[]; probeContext?: { references?: Record<string, string>; references_parsed?: Record<string, { header: string[]; rows: string[][] }> } }): { ok: true } | { ok: false; errors: string[] } {
  const bounded = workflowDocumentError(workflow);
  if (bounded) return { ok: false, errors: [bounded] };
  const shapeErrors = workflowShapeErrors(workflow);
  if (shapeErrors.length) return { ok: false, errors: shapeErrors };
  workflow = desugarWorkflow(workflow);
  const errors: string[] = [];
  const declaredInput = workflow.input && Object.hasOwn(workflow.schemas, workflow.input.schemaId)
    ? resolveSchemaForWorkflow(workflow, workflow.schemas[workflow.input.schemaId]) : undefined;
  const inputKeys = opts?.input !== undefined ? Object.keys(opts.input ?? {}) : opts?.inputKeys;
  const reachability: { available: Set<string>; unknowable: boolean } | null = inputKeys ? { available: new Set(inputKeys), unknowable: false } : null;
  // Closed, typed producers let us reject impossible nested paths without running
  // authored code. Open schemas, unions, references and dynamic control flow stand
  // down; this is a conservative edge check, not a second schema validator.
  const typedOutputs = new Map<string, Record<string, unknown>>();
  const rememberOutput = (key: string, schema: unknown): void => {
    typedOutputs.delete(key);
    if (schema && typeof schema === "object" && !Array.isArray(schema)) typedOutputs.set(key, schema as Record<string, unknown>);
  };
  for (const [key, schema] of Object.entries((declaredInput?.properties ?? {}) as Record<string, unknown>)) rememberOutput(key, schema);
  const checkTypedPath = (dotted: string, at: string): void => {
    if (!reachability || reachability.unknowable) return;
    const [head, ...tail] = dotted.split(".");
    let schema: any = typedOutputs.get(head);
    for (const segment of tail) {
      if (!schema || typeof schema !== "object" || schema.$ref || schema.anyOf || schema.oneOf || schema.allOf || schema.if) return;
      if (schema.type === "array") {
        // Tuple prefixes have different item contracts; leave them to runtime validation.
        if (!/^\d+$/.test(segment) || schema.prefixItems || Array.isArray(schema.items)) return;
        schema = schema.items;
      } else if (schema.type === "object") {
        if (Object.hasOwn(schema.properties ?? {}, segment)) schema = schema.properties[segment];
        else {
          if (schema.additionalProperties === false && !schema.patternProperties) errors.push(`${at}: state path "${dotted}" is excluded by the upstream schema at "${head}"; check the producer's as key and declared properties`);
          return;
        }
      } else return;
    }
  };
  const probedSubtrees = new Map<string, unknown[]>();
  const producedFiles = new Set<string>();
  let mayEscalate = false;
  // Keys written by a code node whose source uses spread syntax: a spread of probed state
  // enumerates to {} under the tolerant proxy, so required-field checks over such shapes would
  // false-positive — they stand down instead.
  const spreadTaintedKeys = new Set<string>();
  const tolerantProbe = (): any => new Proxy(function () {} as any, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
      if (prop === Symbol.iterator) return function* () {} ;
      if (prop === "length") return 0;
      return tolerantProbe();
    },
    apply: () => tolerantProbe(),
    has: () => true,
  });
  const realDataOverlay = (real: Record<string, unknown> | undefined): any => new Proxy({} as any, {
    get: (_t, prop) => {
      if (typeof prop === "string" && real && Object.prototype.hasOwnProperty.call(real, prop)) return real[prop];
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
      if (prop === Symbol.iterator) return function* () {};
      return tolerantProbe();
    },
    has: () => true,
  });
  const referenceProbe = opts?.probeContext ? (() => {
    const context = new Proxy({} as any, {
      get: (_t, prop) => {
        if (prop === "references") return realDataOverlay(opts.probeContext?.references);
        if (prop === "references_parsed") return realDataOverlay(opts.probeContext?.references_parsed);
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
        return tolerantProbe();
      },
      has: () => true,
    });
    return new Proxy(function () {} as any, {
      get: (_t, prop) => {
        if (prop === "context") return context;
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
        if (prop === Symbol.iterator) return function* () {};
        if (prop === "length") return 0;
        return tolerantProbe();
      },
      apply: () => tolerantProbe(),
      has: () => true,
    });
  })() : null;
  const probeCodePatches = (code: string, at?: { path: string; label: string }): Record<string, unknown>[] => {
    if (opts?.executeCode === false) return [];
    let compiled: (s: unknown) => unknown;
    try { compiled = compileTransform(code) as (s: unknown) => unknown; } catch { return []; }
    const patches: Record<string, unknown>[] = [];
    let tolerantThrew = false;
    const fullTolerant = tolerantProbe();
    for (const probe of [{}, fullTolerant]) {
      try {
        const patch = compiled(probe);
        if (patch && typeof patch === "object" && !Array.isArray(patch) && !(patch instanceof Function)) patches.push(patch as Record<string, unknown>);
      } catch { if (probe === fullTolerant) tolerantThrew = true; /* state-dependent — try the next probe */ }
    }
    if (referenceProbe && at) {
      try {
        const patch = compiled(referenceProbe);
        if (patch && typeof patch === "object" && !Array.isArray(patch) && !(patch instanceof Function)) patches.push(patch as Record<string, unknown>);
      } catch (thrown) {
        // A throw HERE but not under the fully tolerant probe is a defect, not state-dependence:
        // the only difference between the two probes is the real reference data, so the node's
        // own fail-closed guard (or a structural mismatch with the actual files) fired. Code that
        // also threw under the tolerant probe is state-dependent and stands down as before.
        if (!tolerantThrew) errors.push(`${at.path} (${at.label}): code node throws against the real reference data: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      }
    }
    return patches;
  };
  // Everything the walk learns about the state at the current point, so parallel branches can each start from the same point.
  type Knowledge = { available: Set<string> | null; unknowable: boolean; typed: Map<string, Record<string, unknown>>; probed: Map<string, unknown[]>; spread: Set<string>; files: Set<string> };
  const snapshotKnowledge = (): Knowledge => ({
    available: reachability ? new Set(reachability.available) : null, unknowable: reachability?.unknowable ?? true,
    typed: new Map(typedOutputs), probed: new Map([...probedSubtrees].map(([key, values]) => [key, [...values]])),
    spread: new Set(spreadTaintedKeys), files: new Set(producedFiles),
  });
  const restoreKnowledge = (knowledge: Knowledge): void => {
    if (reachability && knowledge.available) { reachability.available = new Set(knowledge.available); reachability.unknowable = knowledge.unknowable; }
    typedOutputs.clear(); for (const [key, value] of knowledge.typed) typedOutputs.set(key, value);
    probedSubtrees.clear(); for (const [key, values] of knowledge.probed) probedSubtrees.set(key, [...values]);
    spreadTaintedKeys.clear(); for (const key of knowledge.spread) spreadTaintedKeys.add(key);
    producedFiles.clear(); for (const file of knowledge.files) producedFiles.add(file);
  };
  /** After a parallel node: each branch's own changes applied over the state before it; keys, files and shapes accumulate. */
  const mergeKnowledge = (before: Knowledge, branches: Knowledge[]): void => {
    restoreKnowledge(before);
    for (const branch of branches) {
      if (reachability && branch.available) for (const key of branch.available) reachability.available.add(key);
      for (const [key, value] of branch.typed) if (before.typed.get(key) !== value) typedOutputs.set(key, value);
      for (const key of before.typed.keys()) if (!branch.typed.has(key)) typedOutputs.delete(key);
      for (const [key, values] of branch.probed) if (before.probed.get(key)?.length !== values.length || before.probed.get(key)?.some((v, i) => v !== values[i])) probedSubtrees.set(key, [...values]);
      for (const key of branch.spread) spreadTaintedKeys.add(key);
      for (const file of branch.files) producedFiles.add(file);
    }
    // The merged state depends on which branches ran how; later reachability checks stand down, as before.
    if (reachability) reachability.unknowable = true;
  };
  const checkPredicatePath = (when: { path?: string } | undefined, label: string, path: string): void => {
    if (!reachability || !when?.path) return;
    const head = String(when.path).split(".")[0];
    const subtrees = probedSubtrees.get(head);
    if (!subtrees?.length) return; // head not from a probed code node — stand down
    // Resolve the full dotted path inside the probed subtree; a missing segment = a predicate
    // that can never fire against the shape the gate returns.
    const segments = String(when.path).split(".").slice(1);
    let missingAt: unknown;
    for (const subtree of subtrees) {
      let cursor: any = subtree;
      let missing = false;
      for (const segment of segments) {
        if (typeof cursor === "function") return;
        // A computed key evaluated against the tolerant probe collapses to "" — the shape at this
        // level is state-dependent, so the check stands down rather than false-positive.
        if (cursor && typeof cursor === "object" && (Object.prototype.hasOwnProperty.call(cursor, "") || Object.prototype.hasOwnProperty.call(cursor, "undefined"))) return;
        if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !(segment in cursor)) {
          missingAt = cursor;
          missing = true;
          break;
        }
        cursor = cursor[segment];
      }
      if (!missing) return;
    }
    errors.push(`${path} (${label}): predicate path "${when.path}" is not produced by the code node that writes "${head}" (its shape has: ${missingAt && typeof missingAt === "object" ? Object.keys(missingAt).join(", ") : typeof missingAt}); the guard can never fire`);
  };
  // A mechanical predicate reads one state key; when no input key or earlier node writes it, the guard can never fire.
  const checkPredicateHead = (pred: unknown, label: string, path: string, field: string, produced?: ReadonlySet<string>): void => {
    if (!reachability || reachability.unknowable || !pred || typeof pred !== "object") return;
    const available = produced ?? reachability.available;
    const { predicate, path: at, key } = pred as { predicate?: unknown; path?: unknown; key?: unknown };
    const read = predicate === "no_new_items" ? key : predicate === "ask" ? undefined : at;
    if (typeof read !== "string" || !read.trim()) return;
    const head = read.split(".")[0];
    if (!available.has(head)) errors.push(`${path} (${label}): ${field} reads "${read}" but no input key or earlier node produces "${head}"; the guard can never fire`);
    else if (!produced) checkTypedPath(read, `${path} (${label}) ${field}`);
  };
  const checkInterpolations = (value: unknown, label: string, path: string): void => {
    if (!reachability || reachability.unknowable || value === undefined) return;
    for (const m of JSON.stringify(value).matchAll(/\{([a-zA-Z0-9_.$]+)\}/g)) {
      // Runtime tries a literal state.* property before the optional prefix alias.
      // When both namespaces may exist, do not reject either possible resolution.
      if (m[1].startsWith("state.") && reachability.available.has("state")) continue;
      const head = (m[1].startsWith("state.") ? m[1].slice(6) : m[1]).split(".")[0];
      if (!reachability.available.has(head)) errors.push(`${path} (${label}): interpolates {${m[1]}} but no upstream node produces "${head}"`);
      else checkTypedPath(m[1].startsWith("state.") ? m[1].slice(6) : m[1], `${path} (${label})`);
    }
  };
  const checkRequires = (node: { label: string; requires?: unknown }, path: string): void => {
    if (node.requires === undefined) return;
    if (!Array.isArray(node.requires) || node.requires.some((p) => typeof p !== "string" || !p.trim())) { errors.push(`${path} (${node.label}): requires must be non-empty state paths`); return; }
    if (!reachability || reachability.unknowable) return;
    for (const required of node.requires as string[]) {
      const head = String(required).split(".")[0];
      if (!reachability.available.has(head)) {
        errors.push(`${path} (${node.label}): requires "${required}" but no upstream node produces it; state here has only: ${[...reachability.available].join(", ")}`);
      } else checkTypedPath(required, `${path} (${node.label}) requires`);
    }
  };
  const checkItemsPath = (node: { label: string; itemsPath: string }, path: string): void => {
    if (!reachability || reachability.unknowable || !node.itemsPath) return;
    const head = node.itemsPath.split(".")[0];
    if (!reachability.available.has(head)) errors.push(`${path} (${node.label}): itemsPath "${node.itemsPath}" has no upstream producer; read the value under the producing node's as key (or its label when as is omitted)`);
    else checkTypedPath(node.itemsPath, `${path} (${node.label}) itemsPath`);
  };
  if (workflow?.v !== 2) errors.push("workflow.v must be 2");
  if (!workflow?.name) errors.push("workflow.name is required");
  if (!workflow?.schemas || typeof workflow.schemas !== "object") errors.push("workflow.schemas is required");
  if (workflow?.input !== undefined && (!workflow.input || typeof workflow.input.schemaId !== "string" || !Object.hasOwn(workflow.schemas, workflow.input.schemaId))) errors.push("workflow.input.schemaId must name a schema");
  if (!workflow?.output?.schemaId || !Object.hasOwn(workflow.schemas, workflow.output.schemaId)) errors.push("workflow.output.schemaId must name a schema");
  for (const [id, schema] of Object.entries(workflow?.schemas || {})) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) { errors.push(`schema "${id}" must be a JSON-schema object (got ${schema === null ? "null" : Array.isArray(schema) ? "array" : typeof schema})`); continue; }
    // Fail closed on refs: typebox compiles an unresolvable $ref to a never-matching schema
    // (no throw), which surfaces only at case time as every submission rejected. Resolve
    // sibling refs first, then reject any ref that still points nowhere and any ref form
    // other than #/definitions/<name> (the one form the resolver supports).
    const refs: string[] = [];
    const walkRefs = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walkRefs(item); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "$ref" && typeof child === "string") refs.push(child);
        else walkRefs(child);
      }
    };
    walkRefs(schema);
    const resolved = resolveSchemaForWorkflow(workflow as Workflow, schema as Record<string, unknown>);
    const definitions = (resolved.definitions as Record<string, unknown>) || {};
    for (const ref of refs) {
      const match = ref.match(/^#\/definitions\/(.+)$/);
      if (!match) errors.push(`schema "${id}": unsupported $ref form "${ref}" — only "#/definitions/<name>" resolves (against inline definitions or a sibling schema)`);
      else if (!Object.hasOwn(definitions, match[1])) errors.push(`schema "${id}": $ref "${ref}" resolves to no inline definition and no sibling schema`);
    }
    try { Compile(resolved as never); } catch (e: any) { errors.push(`schema "${id}" does not compile: ${e?.message || e}`); }
  }
  if (opts?.input !== undefined) {
    if (!opts.input || typeof opts.input !== "object" || Array.isArray(opts.input)) errors.push("input must be a JSON object");
    else if (declaredInput) {
      try {
        const validator = Compile(declaredInput as never);
        if (!validator.Check(opts.input)) errors.push(...schemaProblems(validator, opts.input).map(problem => `input: ${problem}`));
      } catch { /* Schema diagnostics above retain the original compilation failure. */ }
    }
  }
  const checkStateMap = (map: unknown, label: string, path: string, field = "state"): void => {
    if (map === undefined) return;
    if (!map || typeof map !== "object" || Array.isArray(map)) { errors.push(`${path} (${label}): ${field} must be an object map of what the questions see`); return; }
    checkInterpolations(map, label, path);
  };
  const checkQuestionSchema = (schemaId: unknown, label: string, path: string): CompiledQuestions | null => {
    if (typeof schemaId !== "string" || !Object.hasOwn(workflow.schemas, schemaId)) { errors.push(`${path} (${label}): out schema "${String(schemaId)}" not in workflow.schemas`); return null; }
    const compiled = compileQuestions(workflow.schemas[schemaId] as Record<string, unknown>, workflow.schemas as Record<string, unknown>);
    if (compiled.ok === false) { errors.push(...compiled.errors.map((e) => `${path} (${label}): schema "${schemaId}": ${e}`)); return null; }
    return compiled.questions;
  };
  const checkPredicate = (pred: unknown, label: string, path: string, field: string, mechanicalOnly = false): boolean => {
    const name = (pred as any)?.predicate;
    if (!pred || !PREDICATES.has(name) || (mechanicalOnly && !MECHANICAL_PREDICATE_NAMES.has(name))) { errors.push(`${path} (${label}): ${field}: unknown predicate "${name}"${mechanicalOnly && name === "ask" ? " (a poll reads a value, never asks a question)" : ""}`); return false; }
    errors.push(...predicateShapeErrors(pred as any).map((e) => `${path} (${label}): ${field}: ${e}`));
    if (name === "ask") checkStateMap((pred as any).state, label, path, `${field}.state`);
    return true;
  };
  const walk = (node: WorkflowNode, path: string): void => {
    if (!node || typeof node !== "object" || !KINDS.has((node as any).node)) { errors.push(`${path}: unknown node kind "${(node as any)?.node}"`); return; }
    {
      const allowed = KIND_KEYS[(node as any).node];
      const extraneous = Object.keys(node).filter((key) => !allowed.has(key));
      if (extraneous.length) errors.push(`${path} (${(node as any).label || (node as any).node}): unknown key(s) for a ${(node as any).node} node: ${extraneous.join(", ")}`);
      // `$`-prefixed state keys are engine-owned (`$host`, `<as>$verify`): no node may write one. A label
      // is the state key whenever `as` is omitted, so labels are held to the same rule.
      if (typeof (node as any).as === "string" && (node as any).as.startsWith("$")) errors.push(`${path} (${(node as any).label || (node as any).node}): "as" must not name an engine-owned "$" state key ("${(node as any).as}")`);
      // Only an unaliased generative or code node writes under its label; every other label is a name, not a key.
      const labelIsKey = ((node as any).node === "agent" || (node as any).node === "decide" || (node as any).node === "extract" || (node as any).node === "code") && (node as any).as === undefined;
      if (labelIsKey && typeof (node as any).label === "string" && (node as any).label.startsWith("$")) errors.push(`${path} (${(node as any).label}): label must not begin with "$" — an unaliased ${(node as any).node} node writes under its label, and "$" keys are engine-owned`);
    }
    switch (node.node) {
      case "chain":
        if (!Array.isArray(node.steps) || !node.steps.length) errors.push(`${path}: chain needs steps`);
        (node.steps || []).forEach((s, i) => walk(s, `${path}.steps[${i}]`));
        return;
      case "code":
        try {
          if (opts?.executeCode === false) compileTransformSyntax(node.code);
          else compileTransform(node.code);
        } catch (e: any) { errors.push(`${path} (${node.label}): ${e?.message || e}`); }
        if (reachability) {
          const patches = probeCodePatches(node.code, { path, label: node.label });
          const keys = new Set(patches.flatMap((patch) => Object.keys(patch)));
          if (/\.\.\./.test(node.code)) for (const key of keys) spreadTaintedKeys.add(key);
          for (const key of keys) {
            const prior = probedSubtrees.get(key) || [];
            const preservesPrior = patches.some((patch) => !Object.prototype.hasOwnProperty.call(patch, key));
            const values = [
              ...(preservesPrior ? prior : []),
              ...patches.flatMap((patch) => Object.prototype.hasOwnProperty.call(patch, key) ? [patch[key]] : []),
            ];
            if (values.length) {
              reachability.available.add(key);
              probedSubtrees.set(key, values);
            }
          }
          reachability.unknowable = true;
        }
        return;
      case "agent":
      case "decide":
      case "extract":
      case "report":
        if (node.state !== undefined) checkStateMap(node.state, node.label, path);
        if (!node.instructions?.trim()) errors.push(`${path} (${node.label}): instructions required`);
        if (node.node !== "report" && !Object.hasOwn(workflow.schemas, node.out)) errors.push(`${path} (${node.label}): out schema "${node.out}" not in workflow.schemas`);
        if ((node as any).thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(String((node as any).thinking))) errors.push(`${path} (${node.label}): thinking must be low|medium|high — thinking is never off`);
        if ((node as any).tools !== undefined && (!Array.isArray((node as any).tools) || (node as any).tools.some((t: unknown) => typeof t !== "string" || !(t as string).trim()))) errors.push(`${path} (${node.label}): tools must be a list of non-empty tool names when present (an empty list disables tools)`);
        checkRequires(node, path);
        if ((node as any).tier !== undefined && !(MODEL_TIERS as readonly string[]).includes(String((node as any).tier))) errors.push(`${path} (${node.label}): tier must be fast|default|strong`);
        if (node.node !== "report" && (node as any).verify !== undefined) {
          const v = (node as any).verify as VerifyClause;
          if (!v || typeof v !== "object" || typeof v.out !== "string") errors.push(`${path} (${node.label}): verify needs an out (a question schema id)`);
          else {
            const qs = checkQuestionSchema(v.out, node.label, path);
            if (qs && !Object.values(qs).some((q) => q.type === "noul")) errors.push(`${path} (${node.label}): verify.out "${v.out}" carries no yes/no question — a verifier decides by yes/no (a boolean named after a submission field verifies it; any other boolean is a requirement)`);
            if (v.state !== undefined) checkStateMap(v.state, node.label, path, "verify.state");
            if (v.maxDrives !== undefined && (!Number.isInteger(v.maxDrives) || v.maxDrives < 1 || v.maxDrives > 4)) errors.push(`${path} (${node.label}): verify.maxDrives must be an integer 1..4`);
            if (v.override !== undefined && (typeof v.override?.below !== "number" || v.override.below <= 0 || v.override.below >= 1)) errors.push(`${path} (${node.label}): verify.override.below must be in (0, 1)`);
          }
        }
        if (reachability && node.node === "report") { reachability.available.add("report_markdown"); typedOutputs.delete("report_markdown"); }
        else if (reachability && node.node !== "report") {
          const key = node.as || node.label;
          reachability.available.add(key); rememberOutput(key, workflow.schemas[node.out]);
          if (node.verify) { reachability.available.add(`${key}$verify`); typedOutputs.delete(`${key}$verify`); }
        }
        return;
      case "map":
        if (node.resultPath !== undefined && (typeof node.resultPath !== "string" || !node.resultPath.trim())) errors.push(`${path} (${node.label}): resultPath must be a non-empty path in the completed item state`);
        if (node.maxConcurrency !== undefined && (!Number.isSafeInteger(node.maxConcurrency) || node.maxConcurrency < 1)) errors.push(`${path} (${node.label}): maxConcurrency must be a positive safe integer`);
        if (!node.itemsPath) errors.push(`${path} (${node.label}): itemsPath required`);
        checkItemsPath(node, path);
        if (!node.as) errors.push(`${path} (${node.label}): as required`);
        if (containsReportNode(node.body)) errors.push(`${path} (${node.label}): a report node cannot live inside a map body — the report is the workflow's ONE terminal rendering (a mapped copy lands in the item results, never at state.report_markdown)`);
        if (reachability) reachability.unknowable = true;
        walk(node.body, `${path}.body`);
        return;
      case "parallel":
        if (!Array.isArray(node.branches) || node.branches.length < 2) errors.push(`${path} (${node.label}): parallel needs at least two branches`);
        if (containsReportNode(node)) errors.push(`${path} (${node.label}): a report node cannot live inside a parallel branch — the report is rendered once, after every branch has landed`);
        {
          const writers = new Map<string, number>();
          (node.branches || []).forEach((branch, i) => {
            for (const key of declaredWrites(branch)) {
              const prior = writers.get(key);
              if (prior !== undefined && prior !== i) errors.push(`${path} (${node.label}): branches ${prior} and ${i} both write state.${key} — parallel branches must write disjoint keys`);
              writers.set(key, i);
            }
          });
        }
        {
          // Every branch starts from the state before the parallel node: a branch never sees a sibling's writes.
          // All walk knowledge is restored per branch, then the branches' results merge (their writes are disjoint).
          const before = snapshotKnowledge();
          const after: Knowledge[] = [];
          (node.branches || []).forEach((branch, i) => {
            restoreKnowledge(before);
            walk(branch, `${path}.branches[${i}]`);
            after.push(snapshotKnowledge());
          });
          if (after.length) mergeKnowledge(before, after);
          if (reachability) reachability.unknowable = true;
        }
        return;
      case "loop":
        if (!Number.isInteger(node.maxIters) || node.maxIters < 1 || node.maxIters > 20) errors.push(`${path} (${node.label}): maxIters must be 1..20`);
        if (containsReportNode(node.body)) errors.push(`${path} (${node.label}): a report node cannot live inside a loop body — the report is rendered once, after the record is final`);
        checkPredicate(node.until, node.label, path, "until");
        {
          // `until` reads the state after the body: the keys before the loop plus every key the body writes.
          const bodyWrites = loopBodyWrites(node.body);
          if (reachability && !reachability.unknowable && bodyWrites) checkPredicateHead(node.until, node.label, path, "until", new Set([...reachability.available, ...bodyWrites]));
        }
        if (reachability) reachability.unknowable = true;
        walk(node.body, `${path}.body`);
        return;
      case "escalate":
        mayEscalate = true;
        checkPredicate(node.when, node.label, path, "when");
        if (!node.kind?.trim() || !node.stage?.trim() || !node.summary?.trim()) errors.push(`${path} (${node.label}): kind, stage, summary required`);
        checkPredicateHead(node.when, node.label, path, "when");
        checkPredicatePath(node.when as { path?: string }, node.label, path);
        return;
      case "judge": {
        const label = node.label || "judge";
        if (!node.state || typeof node.state !== "object" || Array.isArray(node.state) || !Object.keys(node.state).length) errors.push(`${path} (${label}): state must be a non-empty object map of what the questions see`);
        else checkStateMap(node.state, label, path);
        checkQuestionSchema(node.out, label, path);
        if (!node.as?.trim()) errors.push(`${path} (${label}): as required`);
        checkRequires({ label, requires: node.requires }, path);
        if (reachability && node.as) {
          reachability.available.add(node.as); reachability.available.add(`${node.as}$answers`);
          rememberOutput(node.as, workflow.schemas[node.out]); typedOutputs.delete(`${node.as}$answers`);
          if (typeof node.out === "string" && (Object.hasOwn(workflow.schemas, node.out) ? workflow.schemas[node.out] : undefined)) probedSubtrees.set(node.as, [shapeFromSchema(workflow.schemas[node.out] as Record<string, unknown>)]);
        }
        return;
      }
      case "pick": {
        const label = node.label || "pick";
        if (!node.itemsPath?.trim()) errors.push(`${path} (${label}): itemsPath required`);
        checkItemsPath(node, path);
        if (typeof node.describe !== "string" || !node.describe.trim()) errors.push(`${path} (${label}): describe (the option text per item, e.g. "{item.name}, born {item.dob}") required`);
        if (typeof node.instructions !== "string" || !node.instructions.trim()) errors.push(`${path} (${label}): instructions (the one question) required`);
        checkStateMap(node.state, label, path);
        if (!node.as?.trim()) errors.push(`${path} (${label}): as required`);
        if (node.allowNone !== undefined && typeof node.allowNone !== "boolean") errors.push(`${path} (${label}): allowNone must be boolean`);
        checkRequires({ label, requires: node.requires }, path);
        if (reachability && node.as) { reachability.available.add(node.as); reachability.available.add(`${node.as}$answers`); typedOutputs.delete(node.as); typedOutputs.delete(`${node.as}$answers`); probedSubtrees.set(node.as, [{ index: 0, item: "", none: false, option: "" }]); }
        return;
      }
      case "sift": {
        const label = node.label || "sift";
        if (!node.itemsPath?.trim()) errors.push(`${path} (${label}): itemsPath required`);
        checkItemsPath(node, path);
        if (node.describe !== undefined && (typeof node.describe !== "string" || !node.describe.trim())) errors.push(`${path} (${label}): describe must be a non-empty template when present`);
        checkStateMap(node.state, label, path);
        const compiled = checkQuestionSchema(node.out, label, path);
        if (!node.as?.trim()) errors.push(`${path} (${label}): as required`);
        if (node.keep !== undefined) {
          const k = node.keep as { path?: unknown; gte?: unknown };
          if (!k || typeof k !== "object" || typeof k.path !== "string" || !k.path.trim()) errors.push(`${path} (${label}): keep.path must name a question id (or <id>.confidence)`);
          else if (compiled) {
            const [id, tail] = k.path.split(".");
            if (!Object.hasOwn(compiled, id) || (tail !== undefined && tail !== "confidence")) errors.push(`${path} (${label}): keep.path "${k.path}" names no question of schema "${String(node.out)}"`);
            else if (compiled[id].type === "choice" && tail !== "confidence") errors.push(`${path} (${label}): keep.path "${k.path}" is a choice — keep on a boolean or score question, or on <id>.confidence`);
          }
          if (k?.gte !== undefined && !(typeof k.gte === "number" && Number.isFinite(k.gte))) errors.push(`${path} (${label}): keep.gte must be a number`);
        }
        checkRequires({ label, requires: node.requires }, path);
        if (reachability && node.as) { reachability.available.add(node.as); typedOutputs.delete(node.as); probedSubtrees.set(node.as, [{ items: [], values: [], answers: [], kept: [] }]); }
        return;
      }
      case "route": {
        const label = node.label || "route";
        if (!node.state || typeof node.state !== "object" || Array.isArray(node.state) || !Object.keys(node.state).length) errors.push(`${path} (${label}): state must be a non-empty object map of what the question sees`);
        else checkStateMap(node.state, label, path);
        if (typeof node.instructions !== "string" || !node.instructions.trim()) errors.push(`${path} (${label}): instructions (the one question) required`);
        const names = node.branches && typeof node.branches === "object" && !Array.isArray(node.branches) ? Object.keys(node.branches) : [];
        if (names.length < 2) errors.push(`${path} (${label}): route needs at least two named branches`);
        if (names.length > SYSTEM_ONE_LIMITS.maxChoiceOptions) errors.push(`${path} (${label}): route takes at most ${SYSTEM_ONE_LIMITS.maxChoiceOptions} branches`);
        if (node.unsure !== undefined) {
          const u = node.unsure as { branch?: unknown; gte?: unknown };
          if (!u || typeof u.branch !== "string" || !names.includes(u.branch)) errors.push(`${path} (${label}): unsure.branch must name one of the branches`);
          if (!(typeof u?.gte === "number" && u.gte > 0 && u.gte <= 1)) errors.push(`${path} (${label}): unsure.gte must be in (0, 1]`);
        }
        if (containsReportNode(node)) errors.push(`${path} (${label}): a report node cannot live inside a route branch — the report is rendered once, after the record is final`);
        if (node.as !== undefined && (typeof node.as !== "string" || !node.as.trim())) errors.push(`${path} (${label}): as must be a state key when present`);
        checkRequires({ label, requires: node.requires }, path);
        if (reachability) { if (typeof node.as === "string" && node.as.trim()) { reachability.available.add(node.as); reachability.available.add(`${node.as}$answers`); } reachability.unknowable = true; }
        for (const name of names) {
          const branch = (node.branches as any)[name];
          if (!branch || typeof branch !== "object" || !branch.body) { errors.push(`${path} (${label}): branch "${name}" needs a body`); continue; }
          if (branch.criteria !== undefined && typeof branch.criteria !== "string") errors.push(`${path} (${label}): branch "${name}" criteria must be a string`);
          walk(branch.body, `${path}.branches.${name}`);
        }
        return;
      }
      case "artifact": {
        const label = node.label || "artifact";
        const type = typeof node.type === "string" && node.type.trim() ? node.type : null;
        if (!type) errors.push(`${path} (${label}): artifact type must be a non-empty string`);
        for (const key of ["instructions", "state", "sopSection", "tools", "effort", "thinking"] as const) if (node[key] !== undefined) errors.push(`${path} (${label}): ${key} is a prose-artifact field; a ${type ?? "file"} artifact has no model in the loop`);
        if (typeof node.path !== "string" || !node.path.trim() || node.path.startsWith("/") || node.path.split("/").includes("..")) errors.push(`${path} (${label}): path must be a workspace-relative file`);
        else if (reachability && !producedFiles.has(node.path)) errors.push(`${path} (${label}): path "${node.path}" is not produced by any earlier shell call (declare it in that call's produces)`);
        checkRequires({ label, requires: node.requires }, path);
        if (reachability) { reachability.available.add("artifact"); typedOutputs.delete("artifact"); }
        return;
      }
      case "workflow": {
        const label = typeof node.label === "string" && node.label.trim() ? node.label : "workflow";
        if (typeof node.label !== "string" || !node.label.trim() || typeof node.as !== "string" || !node.as.trim()) errors.push(`${path} (${label}): a workflow invocation requires label and as`);
        if (!Object.hasOwn(workflow.schemas, node.out)) errors.push(`${path} (${label}): out schema "${String(node.out)}" not in workflow.schemas`);
        if (!node.input || typeof node.input !== "object" || Array.isArray(node.input)) errors.push(`${path} (${label}): input must be an object mapping onto the child's initial state`);
        else if (Object.hasOwn(node.input, HOST_STATE_KEY)) errors.push(`${path} (${label}): input must not contain the reserved "${HOST_STATE_KEY}" key`);
        const child = node.workflow;
        const steps = childSteps(child);
        if (!child || typeof child !== "object" || !steps || !steps.length) errors.push(`${path} (${label}): the child workflow must contain a root node`);
        else {
          if (containsReportNode(child.root)) errors.push(`${path} (${label}): a child cannot render a report or deliver an artifact; the parent owns the terminal`);
          if (typeof child.input?.schemaId !== "string" || !Object.hasOwn(child.schemas, child.input.schemaId)) errors.push(`${path} (${label}): the child must declare input.schemaId in its own schemas`);
          const validated = validateWorkflow(child, { executeCode: opts?.executeCode, inputKeys: Object.keys(node.input && typeof node.input === "object" ? node.input : {}) });
          if (!validated.ok) errors.push(...(validated as { ok: false; errors: string[] }).errors.map(error => `${path} (${label}) child: ${error}`));
          for (const step of steps) if (step.node === "call" && Array.isArray(step.produces)) for (const file of step.produces) producedFiles.add(String(file));
        }
        if (node.input && typeof node.input === "object") checkInterpolations(node.input, label, path);
        if (reachability && typeof node.as === "string") { reachability.available.add(node.as); rememberOutput(node.as, workflow.schemas[node.out]); }
        return;
      }
      case "call": {
        const label = node.label || "call";
        if (!(CALL_TRANSPORTS as readonly string[]).includes(String(node.via))) errors.push(`${path} (${label}): via must be tool|executor|shell`);
        if (node.via === "tool") {
          if (!node.tool?.trim()) errors.push(`${path} (${label}): via tool needs a tool address`);
          if (node.args !== undefined && (!node.args || typeof node.args !== "object" || Array.isArray(node.args))) errors.push(`${path} (${label}): args must be an object`);
          for (const key of ["code", "input", "command", "env"] as const) if (node[key] !== undefined) errors.push(`${path} (${label}): ${key} is not a via tool field`);
        }
        if (node.via === "executor") {
          if (!node.code?.trim()) errors.push(`${path} (${label}): via executor needs a code body`);
          if (!/\breturn\b/.test(String(node.code || ""))) errors.push(`${path} (${label}): the executor body must return its JSON result`);
          if (/\b(require|process|fetch|eval|Function|import)\s*\(?/.test(String(node.code || ""))) errors.push(`${path} (${label}): the executor body may use only tools and input (no require/process/fetch/eval/import)`);
          if (node.input !== undefined && (!node.input || typeof node.input !== "object" || Array.isArray(node.input))) errors.push(`${path} (${label}): input must be an object`);
          for (const key of ["tool", "args", "command", "env"] as const) if (node[key] !== undefined) errors.push(`${path} (${label}): ${key} is not a via executor field`);
        }
        if (node.via === "shell") {
          if (!node.command?.trim()) errors.push(`${path} (${label}): via shell needs a command`);
          if (node.env !== undefined && (!node.env || typeof node.env !== "object" || Array.isArray(node.env) || Object.entries(node.env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== "string"))) errors.push(`${path} (${label}): env must map UPPER_CASE names to strings`);
          if (node.out !== undefined) errors.push(`${path} (${label}): a shell call's result is the fixed shell shape; drop out`);
          for (const key of ["tool", "args", "code", "input"] as const) if (node[key] !== undefined) errors.push(`${path} (${label}): ${key} is not a via shell field`);
        } else if (node.produces?.length) {
          errors.push(`${path} (${label}): only a via shell call may declare produces`);
        }
        if (node.via !== "shell") {
          if (!node.out) errors.push(`${path} (${label}): out schema required for a ${node.via} call`);
          else if (!Object.hasOwn(workflow.schemas, node.out)) errors.push(`${path} (${label}): out schema "${node.out}" not in workflow.schemas`);
        }
        if (!node.as?.trim()) errors.push(`${path} (${label}): as required`);
        if (node.where !== undefined && node.where !== "sandbox") errors.push(`${path} (${label}): where accepts only "sandbox"`);
        if (!(Number.isFinite(node.deadline_s) && node.deadline_s > 0 && node.deadline_s <= 3600)) errors.push(`${path} (${label}): deadline_s must be greater than 0 and at most 3600 seconds`);
        if (node.produces !== undefined && (!Array.isArray(node.produces) || !node.produces.length || node.produces.some((f) => typeof f !== "string" || !f.trim() || f.startsWith("/") || f.split("/").includes("..")))) errors.push(`${path} (${label}): produces must be non-empty workspace-relative paths`);
        else for (const f of node.produces || []) producedFiles.add(f);
        if (node.retry !== undefined) {
          const r = node.retry;
          if (!r || !Number.isInteger(r.attempts) || r.attempts < 1 || r.attempts > 5) errors.push(`${path} (${label}): retry.attempts must be 1..5`);
          if (r?.backoff_s !== undefined && !(Number.isFinite(r.backoff_s) && r.backoff_s >= 0 && r.backoff_s <= 60)) errors.push(`${path} (${label}): retry.backoff_s must be 0..60`);
          if (r?.on !== undefined && (!Array.isArray(r.on) || r.on.some((c) => !(CALL_RETRY_CLASSES as readonly string[]).includes(String(c))))) errors.push(`${path} (${label}): retry.on may name only timeout|http_5xx|http_429|connection|exit`);
        }
        if (node.poll !== undefined) {
          const p = node.poll;
          if (!p || typeof p !== "object" || Array.isArray(p)) errors.push(`${path} (${label}): poll must be an object`);
          else {
            const resultShape = node.via === "shell" ? shapeFromSchema(SHELL_RESULT_SCHEMA) : node.out && (Object.hasOwn(workflow.schemas, node.out) ? workflow.schemas[node.out] : undefined) ? shapeFromSchema(workflow.schemas[node.out] as Record<string, unknown>) : undefined;
            for (const [name, pred] of [["until", p.until], ["fail_when", p.fail_when]] as const) {
              if (pred === undefined) { if (name === "until") errors.push(`${path} (${label}): poll.until is required`); continue; }
              if (!checkPredicate(pred, label, path, `poll.${name}`, true)) continue;
              const predPath = (pred as { path?: string }).path;
              if (resultShape && typeof resultShape === "object" && predPath && resultPathMissing(resultShape, predPath)) errors.push(`${path} (${label}): poll.${name} path "${predPath}" is not in the declared result shape (${Object.keys(resultShape as object).join(", ")}); the poll could never settle`);
            }
            if (!(Number.isFinite(p.interval_s) && p.interval_s >= 0.1 && p.interval_s <= 300)) errors.push(`${path} (${label}): poll.interval_s must be 0.1..300 seconds`);
            if (!(Number.isFinite(p.deadline_s) && p.deadline_s >= (Number(node.deadline_s) || 0) && p.deadline_s <= 7200)) errors.push(`${path} (${label}): poll.deadline_s must be at least deadline_s and at most 7200 seconds`);
          }
        }
        checkRequires({ label, requires: node.requires }, path);
        checkInterpolations({ args: node.args, input: node.input, env: node.env }, label, path);
        if (reachability) {
          reachability.available.add(node.as);
          rememberOutput(node.as, node.via === "shell" ? SHELL_RESULT_SCHEMA : workflow.schemas[node.out!]);
          if (node.out && (Object.hasOwn(workflow.schemas, node.out) ? workflow.schemas[node.out] : undefined)) probedSubtrees.set(node.as, [shapeFromSchema(workflow.schemas[node.out] as Record<string, unknown>)]);
          else if (node.via === "shell") probedSubtrees.set(node.as, [shapeFromSchema(SHELL_RESULT_SCHEMA)]);
        }
        return;
      }
    }
  };
  walk(workflow?.root, "root");
  {
    const countReports = (node: WorkflowNode | undefined): number => {
      if (!node || typeof node !== "object") return 0;
      if (node.node === "report" || node.node === "artifact") return 1;
      if (node.node === "chain") return (node.steps || []).reduce((n, s) => n + countReports(s), 0);
      if (node.node === "parallel") return (node.branches || []).reduce((n, b) => n + countReports(b), 0);
      if (node.node === "map" || node.node === "loop") return countReports(node.body);
      if (node.node === "route") return routeBodies(node).reduce((n, b) => n + countReports(b), 0);
      return 0;
    };
    const total = countReports(workflow?.root);
    if (total > 1) errors.push(`root: at most ONE terminal node (report or artifact) — a second rendering overwrites the first at its fixed state key`);
    else if (total === 1) {
      const rootSteps = workflow?.root?.node === "chain" ? (workflow.root as Extract<WorkflowNode, { node: "chain" }>).steps || [] : [workflow?.root as WorkflowNode];
      const lastStep = rootSteps[rootSteps.length - 1];
      if (!lastStep || ((lastStep as WorkflowNode).node !== "report" && (lastStep as WorkflowNode).node !== "artifact")) {
        errors.push(`root: the terminal node (report or artifact) must be the LAST step of the root chain — rendered earlier it ships a record that later nodes still change`);
      }
    }
  }
  {
    const llmNodes: LlmNode[] = [];
    const collect = (node: WorkflowNode): void => {
      if (!node || typeof node !== "object") return;
      if (node.node === "agent" || node.node === "decide" || node.node === "extract" || node.node === "report") llmNodes.push(node);
      if (node.node === "chain") (node.steps || []).forEach(collect);
      if (node.node === "parallel") (node.branches || []).forEach(collect);
      if (node.node === "map" || node.node === "loop") collect(node.body);
      if (node.node === "route") routeBodies(node).forEach(collect);
    };
    collect(workflow?.root);
    if (llmNodes.some((n) => n.node === "report")) {
      for (const node of llmNodes) {
        if (node.node === "report" || node.node === "agent") continue;
        const properties = ((Object.hasOwn(workflow.schemas, node.out) ? workflow.schemas[node.out] : undefined) as { properties?: Record<string, unknown> } | undefined)?.properties;
        if (properties && Object.prototype.hasOwnProperty.call(properties, "report_markdown")) {
          errors.push(`root (${node.label}): a ${node.node} node must not emit report_markdown — the report node owns the report; drop the field from schema "${node.out}"`);
        }
      }
    }
  }
  if (reachability && !reachability.unknowable && !mayEscalate && workflow?.output?.path) {
    const head = workflow.output.path.split(".")[0];
    if (!reachability.available.has(head)) errors.push(`output: path "${workflow.output.path}" has no input or upstream producer; select the final node's as key (or label when as is omitted)`);
    else checkTypedPath(workflow.output.path, "output");
  }
  // Output-completeness: when the node writing the output path is a probeable code node, its
  // probed shape must carry every REQUIRED key of the output schema. A required field added to
  // the contract (e.g. self_corrections) that assemble never emits otherwise dies only at
  // runtime — every case fails output validation with no author-time signal. Conservative:
  // stands down when the output head is not code-probed, when the probe hit computed keys, or
  // when navigation leaves plain objects.
  if (reachability && workflow?.output?.path && (Object.hasOwn(workflow.schemas, workflow.output.schemaId) ? workflow.schemas[workflow.output.schemaId] : undefined)) {
    const outSchema = workflow.schemas[workflow.output.schemaId] as { required?: unknown };
    const required = Array.isArray(outSchema.required) ? outSchema.required.filter((k): k is string => typeof k === "string") : [];
    const segments = String(workflow.output.path).split(".");
    const subtrees = probedSubtrees.get(segments[0]);
    if (required.length && subtrees?.length && !spreadTaintedKeys.has(segments[0])) {
      let bestMissing: string[] | null = null;
      for (const subtree of subtrees) {
        let cursor: any = subtree;
        let standDown = false;
        for (const segment of segments.slice(1)) {
          if (!cursor || typeof cursor !== "object" || typeof cursor === "function" || Array.isArray(cursor)) { standDown = true; break; }
          if (Object.prototype.hasOwnProperty.call(cursor, "") || Object.prototype.hasOwnProperty.call(cursor, "undefined")) { standDown = true; break; }
          if (!(segment in cursor)) { standDown = true; break; }
          cursor = cursor[segment];
        }
        if (standDown || !cursor || typeof cursor !== "object" || typeof cursor === "function" || Array.isArray(cursor)) continue;
        if (Object.prototype.hasOwnProperty.call(cursor, "") || Object.prototype.hasOwnProperty.call(cursor, "undefined")) continue;
        const missing = required.filter((key) => !(key in cursor));
        if (!missing.length) { bestMissing = null; break; }
        if (!bestMissing || missing.length < bestMissing.length) bestMissing = missing;
      }
      if (bestMissing?.length) {
        errors.push(`output: the code node writing "${workflow.output.path}" never emits required field(s) ${bestMissing.join(", ")} of schema "${workflow.output.schemaId}" — every run would fail output validation`);
      }
    }
  }
  if (!errors.length) errors.push(...workflowShapeErrors(workflow, true));
  return errors.length ? { ok: false, errors } : { ok: true };
}

function interpolate(template: string, state: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_.$]+)\}/g, (_, p) => {
    let v = getPath(state, p);
    if (v === undefined && p.startsWith("state.")) v = getPath(state, p.slice(6));
    return v === undefined || v === null ? `(${p} unset)` : typeof v === "string" ? v : JSON.stringify(v);
  });
}

export class EscalationSignal extends Error {
  constructor(readonly escalation: Escalation) { super(`escalated: ${escalation.kind}`); }
}

async function evaluatePredicate(pred: Predicate, state: Record<string, unknown>, deps: WorkflowDeps, at: { label: string; kind: "loop" | "escalate" }): Promise<{ holds: boolean; detail?: Record<string, unknown> }> {
  if (pred.predicate !== "ask") return { holds: predicateMatches(pred, state) };
  const ask = pred as AskPredicate;
  const runJudge = requireJudge(deps, `${at.kind} (ask predicate)`, at.label);
  const asked = ask.state ? interpolateValue(ask.state, state, at.label) : promptStateOf(state);
  const questions: Record<string, SystemOneQuestion> = { holds: { type: "noul", instructions: ask.instructions, ...(ask.criteria ? { criteria: ask.criteria } : {}) } };
  const result = await runJudge({ label: at.label, kind: "ask", state: asked, questions, signal: deps.signal });
  validateAnswers(questions, result.answers);
  const answer = result.answers.holds;
  const p = answer?.type === "noul" ? answer.noul : NaN;
  if (!Number.isFinite(p)) throw new Error(`${at.kind} node "${at.label}": the ask predicate got no yes/no answer`);
  const gte = ask.gte ?? 0.6;
  deps.onEvent?.({ type: "ask.evaluated", label: at.label, detail: { kind: at.kind, p_yes: +p.toFixed(4), gte, holds: p >= gte, model: result.model ?? null, cost_usd: result.cost_usd ?? null } });
  return { holds: p >= gte, detail: { p_yes: p, gte } };
}

function promptStateOf(state: Record<string, unknown>): Record<string, unknown> {
  const context = state.context as Record<string, unknown> | undefined;
  if (!context || (context.references === undefined && context.references_parsed === undefined)) return state;
  const { references: _r, references_parsed: _rp, ...rest } = context;
  return { ...state, context: rest };
}



export function schemaProblems(validator: { Errors: (candidate: unknown) => Iterable<any> }, candidate: unknown): string[] {
  return [...validator.Errors(candidate)]
    .slice(0, 8)
    // Instance paths and propertyNames messages can contain source-derived keys.
    // Schema paths describe the authored contract instead of rejected input data.
    .map((error: any) => `${error.schemaPath || "#"}: ${error.keyword === "propertyNames"
      ? "property names must satisfy the declared schema" : error.keyword === "~refine"
        ? "must satisfy the declared refinement" : error.message}`);
}

export class WorkflowInvalidError extends Error {
  readonly code = "workflow_invalid";
  readonly stage = "validate";
  constructor(readonly workflowName: string, readonly problems: string[]) {
    super(`workflow "${workflowName}" is invalid: ${problems.join("; ")}`);
    this.name = "WorkflowInvalidError";
  }
}

export class WorkflowInputInvalidError extends Error {
  readonly code = "input_invalid";
  readonly stage = "input";
  constructor(readonly workflowName: string, readonly problems: string[]) {
    super(`workflow "${workflowName}" input does not satisfy its schema: ${problems.join("; ")}`);
    this.name = "WorkflowInputInvalidError";
  }
}

/** The adapter returned after its deadline. Its effect must be reconciled by the host;
 * the engine refuses the late result and never retries it automatically. */
export class EffectDeadlineExceededError extends Error {
  readonly code = "effect_deadline_exceeded";
  constructor(readonly stage: string, readonly lateResult: unknown) {
    super(`call node "${stage}" returned after its deadline; reconcile the effect before retrying`);
    this.name = "EffectDeadlineExceededError";
  }
}

export type EffectSettlement =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown };

/** An admitted effect did not settle before cancellation or its deadline. An abort signal
 * cannot prove whether the external effect occurred. Reconcile before any new admission. */
export class EffectOutcomeUnknownError extends Error {
  readonly code = "effect_outcome_unknown";
  readonly outcome = "unknown";
  constructor(
    readonly stage: string,
    readonly interruption: "deadline" | "cancelled",
    readonly attempt: number,
    readonly idempotencyKey: string,
    readonly settlement: Promise<EffectSettlement>,
    cause?: unknown,
    readonly executionPath?: string,
  ) {
    super(`call node "${stage}" did not settle before ${interruption}; its effect outcome is unknown and must be reconciled before retrying`, { cause });
    this.name = "EffectOutcomeUnknownError";
  }
}

export class WorkflowOutputInvalidError extends Error {
  readonly code = "output_invalid";
  constructor(summary: string, readonly problems: string[], readonly stage: string = "output") {
    super(problems.length ? `${summary}: ${problems.join("; ")}` : summary);
    this.name = "WorkflowOutputInvalidError";
  }
}

/** Local transform failure. The cause is retained for trusted hosts, not author-facing diagnostics. */
export class WorkflowCodeError extends Error {
  readonly code = "code_transform_failed";
  constructor(readonly stage: string, cause: unknown) {
    super(`code node "${stage}" failed: ${cause instanceof Error ? cause.message : 'transform threw'}; check its state paths, synchronous function body and supported globals`, { cause });
    this.name = "WorkflowCodeError";
  }
}

/** A mechanical state-contract failure, distinct from provider or authored-code errors.
 * Trusted hosts retain the location; a parallel collision key can be runtime-derived
 * and must be omitted by public diagnostics. No full state object is retained. */
export class WorkflowStateError extends Error {
  readonly code = "state_invalid";
  constructor(summary: string, readonly stage: string, readonly path: string,
    readonly reason: "required_nonempty" | "missing_interpolation" | "expected_list" | "empty_selection" | "missing_map_result" | "parallel_write_conflict" | "reserved_state_key") {
    super(summary);
    this.name = "WorkflowStateError";
  }
}


export function stageSchemaForNode(workflow: Workflow, node: LlmNode): Record<string, unknown> {
  if (node.node === "report") return REPORT_SCHEMA;
  return resolveSchemaForWorkflow(workflow, workflow.schemas[node.out]);
}

export const submissionSchemaForNode = stageSchemaForNode;

const hasConcreteValue = (value: unknown): boolean => {
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasConcreteValue);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(hasConcreteValue));
};

function assertNodeInputs(node: { node: string; label: string; requires?: string[] }, state: Record<string, unknown>): void {
  const requiredPaths = [...(node.requires || [])];
  for (const requiredPath of requiredPaths) {
    if (!hasConcreteValue(getPath(state, requiredPath))) {
      throw new WorkflowStateError(`${node.node} node "${node.label}" requires non-empty state path "${requiredPath}" before agent construction`, node.label, requiredPath, "required_nonempty");
    }
  }
}

export function mergeStageDelta(
  state: Record<string, unknown>,
  node: LlmNode,
  result: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (node.node === "report") return { ...state, report_markdown: result.report_markdown };
  const properties = schema?.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : null;
  const delta = properties
    ? Object.fromEntries(Object.entries(result).filter(([key]) => Object.prototype.hasOwnProperty.call(properties, key)))
    : result;
  return { ...state, [node.as || node.label]: delta };
}

function shapeFromSchema(schema: Record<string, unknown>): unknown {
  const properties = schema && typeof schema === "object" ? (schema as { properties?: Record<string, unknown> }).properties : undefined;
  if (!properties || typeof properties !== "object") return "";
  return Object.fromEntries(Object.entries(properties).map(([key, sub]) => [key, shapeFromSchema(sub as Record<string, unknown>)]));
}

function interpolateValue(value: unknown, state: Record<string, unknown>, stage: string = "interpolation"): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{([a-zA-Z0-9_.$]+)\}$/);
    if (whole) {
      const p = whole[1];
      let v = getPath(state, p);
      if (v === undefined && p.startsWith("state.")) v = getPath(state, p.slice(6));
      if (v === undefined) throw new WorkflowStateError(`interpolation path "${p}" is not present in the state`, stage, p, "missing_interpolation");
      return v;
    }
    return value.replace(/\{([a-zA-Z0-9_.$]+)\}/g, (_, p) => {
      let v = getPath(state, p);
      if (v === undefined && p.startsWith("state.")) v = getPath(state, p.slice(6));
      if (v === undefined) throw new WorkflowStateError(`interpolation path "${p}" is not present in the state`, stage, p, "missing_interpolation");
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, state, stage));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateValue(v, state, stage)]));
  return value;
}

function canonicalJson(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  return JSON.stringify(stable(value));
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error("workflow aborted")); return; }
  const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("workflow aborted")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
  signal?.addEventListener("abort", aborted, { once: true });
});

async function runCallNode(node: CallNode, state: Record<string, unknown>, workflow: Workflow, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  if (!deps.runEffect) throw new Error(`call node "${node.label}": this runner has no effect executor (deps.runEffect)`);
  assertNodeInputs(node, state);
  const input: Record<string, unknown> = node.via === "tool"
    ? (interpolateValue(node.args ?? {}, state, node.label) as Record<string, unknown>)
    : node.via === "executor"
      ? (interpolateValue(node.input ?? {}, state, node.label) as Record<string, unknown>)
      : { command: String(node.command), ...(node.env ? { env: Object.fromEntries(Object.entries(interpolateValue(node.env, state, node.label) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) } : {}) };
  const produces = (node.produces ?? []).map((entry) => String(interpolateValue(entry, state, node.label)));
  // Existing flat pins retain their exact receipt identity. Newly supported composition uses
  // a versioned tuple including the full runtime path; its document could not run previously.
  const identity = (deps as LocatedDeps)[SCOPED_EFFECTS]
    ? canonicalJson(["execution-path-v1", executionPath(deps), node.label, node.via, node.tool ?? node.code ?? "", input])
    : `${node.label}\n${node.via}\n${node.tool ?? node.code ?? ""}\n${canonicalJson(input)}`;
  const idempotencyKey = createHash("sha256").update(identity).digest("hex");
  const effectNode: CallNode = produces.length ? { ...node, produces } : node;
  const schema = node.via === "shell" ? SHELL_RESULT_SCHEMA : resolveSchemaForWorkflow(workflow, workflow.schemas[node.out as string]);
  const validator = Compile(schema as never);
  const attempts = Math.max(1, node.retry?.attempts ?? 1);
  const retryOn = new Set<string>(node.retry?.on ?? ["timeout", "http_5xx", "http_429", "connection", "exit"]);
  const executeOnce = async (budgetUntilMs?: number): Promise<unknown> => {
    let result: unknown;
    let lastError: unknown;
    let failed = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
      const remainingMs = budgetUntilMs === undefined ? Infinity : budgetUntilMs - Date.now();
      // A durable receipt can be retrieved after expiry. The recovery adapter checks
      // the original deadline before any NEW admission; it never extends the poll.
      // Expired receipt reads receive the node deadline so asynchronous store IO can finish.
      if (remainingMs <= 0 && !deps.recovery) throw new EffectFailure(`call node "${node.label}" poll exceeded its ${node.poll?.deadline_s}s deadline`, "timeout");
      const controller = new AbortController();
      const attemptMs = Math.max(1, Math.min(node.deadline_s * 1000, remainingMs <= 0 && deps.recovery ? Infinity : remainingMs));
      const attemptDeadlineMs = Date.now() + attemptMs;
      let settled: EffectSettlement | undefined;
      let unknownOutcome: EffectOutcomeUnknownError | undefined;
      let interruptionCheck: ReturnType<typeof setImmediate> | undefined;
      let resolveInterruption!: (value: { status: "unknown"; error: EffectOutcomeUnknownError }) => void;
      const interrupted = new Promise<{ status: "unknown"; error: EffectOutcomeUnknownError }>(resolve => { resolveInterruption = resolve; });
      let resolveSettlement!: (value: EffectSettlement) => void;
      const settlement = new Promise<EffectSettlement>(resolve => { resolveSettlement = resolve; });
      const finish = (value: EffectSettlement) => {
        settled = value;
        resolveSettlement(value);
        if (unknownOutcome) {
          try {
            deps.onEvent?.({ type: "effect.late_settled", label: node.label, detail: {
              via: node.via, attempt, idempotency_key: idempotencyKey,
              interruption: unknownOutcome.interruption, ...value,
            } });
          } catch { /* The settlement promise still retains the complete adapter evidence. */ }
        }
      };
      const interrupt = (interruption: "deadline" | "cancelled", cause?: unknown) => {
        if (controller.signal.aborted) return;
        controller.abort(cause);
        // Drain synchronous abort rejection and its promise reactions first. A settled
        // cooperative failure can honor retry policy; a still-pending adapter cannot.
        interruptionCheck = setImmediate(() => {
          if (settled) return;
          unknownOutcome = new EffectOutcomeUnknownError(node.label, interruption, attempt, idempotencyKey, settlement, cause, executionPath(deps));
          resolveInterruption({ status: "unknown", error: unknownOutcome });
        });
      };
      const onAbort = () => interrupt("cancelled", deps.signal?.reason);
      deps.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => interrupt("deadline"), attemptMs);
      try {
        deps.onEvent?.({ type: "effect.attempt", label: node.label, detail: { via: node.via, attempt, idempotency_key: idempotencyKey } });
        Promise.resolve().then(() => {
          if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
          if (controller.signal.aborted || Date.now() >= attemptDeadlineMs) {
            throw new EffectFailure(`call node "${node.label}" deadline elapsed before effect admission`, "timeout");
          }
          return deps.runEffect!({ node: effectNode, schema, input, produces, attempt, idempotencyKey, signal: controller.signal });
        }).then(value => finish({ status: "fulfilled", value }), reason => finish({ status: "rejected", reason }));
        const outcome = await Promise.race([settlement, interrupted]);
        if (outcome.status === "unknown") throw outcome.error;
        if (outcome.status === "rejected") throw outcome.reason;
        result = outcome.value;
        if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
        if (controller.signal.aborted || Date.now() >= attemptDeadlineMs) throw new EffectDeadlineExceededError(node.label, result);
        failed = false;
        lastError = undefined;
        break;
      } catch (error) {
        failed = true;
        const cutByPoll = controller.signal.aborted && budgetUntilMs !== undefined && Date.now() >= budgetUntilMs;
        lastError = error instanceof EffectOutcomeUnknownError ? error
          : deps.signal?.aborted ? deps.signal.reason ?? new Error("workflow aborted")
          : controller.signal.aborted && !(error instanceof EffectFailure) && !(error instanceof EffectDeadlineExceededError)
          ? new EffectFailure(cutByPoll ? `call node "${node.label}" poll exceeded its ${node.poll?.deadline_s}s deadline` : `call node "${node.label}" exceeded its ${node.deadline_s}s deadline`, "timeout")
          : error;
        const retryClass = lastError instanceof EffectFailure ? lastError.retryClass : null;
        // Durable admission is uncertain after failure; only the host can reconcile it.
        const retryable = !deps.signal?.aborted && !deps.recovery && retryClass !== null && retryOn.has(retryClass) && attempt < attempts;
        deps.onEvent?.({ type: "effect.failed", label: node.label, detail: { via: node.via, attempt, retry_class: retryClass, retrying: retryable, ...(lastError instanceof EffectOutcomeUnknownError ? { outcome: "unknown", interruption: lastError.interruption, idempotency_key: idempotencyKey } : {}), message: String((lastError as Error)?.message || lastError).slice(0, 300) } });
        if (!retryable || (budgetUntilMs !== undefined && Date.now() >= budgetUntilMs)) break;
        const delay = Math.min((node.retry?.backoff_s ?? 1) * 1000 * attempt, budgetUntilMs === undefined ? Infinity : Math.max(0, budgetUntilMs - Date.now()));
        await sleep(delay, deps.signal);
      } finally {
        clearTimeout(timer);
        if (interruptionCheck) clearImmediate(interruptionCheck);
        deps.signal?.removeEventListener("abort", onAbort);
      }
    }
    if (failed) throw lastError instanceof Error ? lastError : new Error(String(lastError), { cause: lastError });
    return result;
  };
  const invalid = (value: unknown) => new WorkflowOutputInvalidError(`call node "${node.label}" result does not satisfy schema "${node.via === "shell" ? "shell" : node.out}"`, schemaProblems(validator, value), node.label);
  let result: unknown;
  const memoized = !node.poll && deps.memo ? await deps.memo.get(idempotencyKey, effectNode) : undefined;
  if (memoized !== undefined) {
    deps.onEvent?.({ type: "effect.memo", label: node.label, detail: { via: node.via, idempotency_key: idempotencyKey } });
    result = memoized;
  } else if (!node.poll || deps.syntheticEffects) {
    result = await executeOnce();
  } else {
    const startedAt = deps.recovery?.pollStartedAt(node, undefined, executionPath(deps)) ?? Date.now();
    const pollUntilMs = startedAt + node.poll.deadline_s * 1000;
    for (let iteration = 1; ; iteration += 1) {
      result = await executeOnce(pollUntilMs);
      if (!validator.Check(result)) throw invalid(result);
      const elapsedMs = Date.now() - startedAt;
      if (node.poll.fail_when && predicateMatches(node.poll.fail_when, result)) {
        deps.onEvent?.({ type: "effect.poll", label: node.label, detail: { iteration, settled: "fail_when", elapsed_ms: elapsedMs } });
        throw new EffectFailure(`call node "${node.label}" poll met fail_when after ${iteration} check(s): ${JSON.stringify(result).slice(0, 300)}`, null);
      }
      if (predicateMatches(node.poll.until, result)) {
        deps.onEvent?.({ type: "effect.poll", label: node.label, detail: { iteration, settled: "until", elapsed_ms: elapsedMs } });
        break;
      }
      if (!deps.recovery && elapsedMs + node.poll.interval_s * 1000 > node.poll.deadline_s * 1000) {
        deps.onEvent?.({ type: "effect.poll", label: node.label, detail: { iteration, settled: "deadline", elapsed_ms: elapsedMs } });
        throw new EffectFailure(`call node "${node.label}" poll exceeded its ${node.poll.deadline_s}s deadline after ${iteration} check(s)`, "timeout");
      }
      deps.onEvent?.({ type: "effect.poll", label: node.label, detail: { iteration, settled: null, elapsed_ms: elapsedMs } });
      if (deps.recovery) await deps.recovery.wait(node, node.poll.interval_s * 1000, undefined, executionPath(deps));
      else await sleep(node.poll.interval_s * 1000, deps.signal);
    }
  }
  if (!validator.Check(result)) {
    throw new WorkflowOutputInvalidError(`call node "${node.label}" result does not satisfy schema "${node.via === "shell" ? "shell" : node.out}"`, schemaProblems(validator, result), node.label);
  }
  // Only a schema-valid completed effect is reusable. Once a recovery store is
  // supplied, losing its write must stop downstream effects rather than silently
  // claiming that this execution can safely resume.
  if (deps.memo && memoized === undefined && !node.poll && !deps.syntheticEffects) {
    await deps.memo.put(idempotencyKey, effectNode, result);
  }
  return { ...state, [node.as]: result };
}

function assertQuestionCount(deps: WorkflowDeps, count: number, label: string): void {
  const limit = deps.maxQuestionsPerRequest ?? 256;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("maxQuestionsPerRequest must be a positive safe integer");
  if (count > limit) throw new Error(`node "${label}": ${count} questions exceed maxQuestionsPerRequest (${limit}); reduce the collection/question set or raise the host limit`);
}

const requireJudge = (deps: WorkflowDeps, kind: string, label: string): NonNullable<WorkflowDeps["runJudge"]> => {
  if (!deps.runJudge) throw new Error(`${kind} node "${label}": this runner has no System One runner (deps.runJudge)`);
  return async params => {
    assertQuestionCount(deps, Object.keys(params.questions).length, params.label);
    return deps.runJudge!(params);
  };
};

function questionSetOf(workflow: Workflow, node: { node: string; label: string; out: string }): { questions: CompiledQuestions; decode: (answers: Record<string, SystemOneAnswer>, what?: string) => Record<string, unknown> } {
  const schema = resolveSchemaForWorkflow(workflow, workflow.schemas[node.out]);
  const compiled = compileQuestions(schema, workflow.schemas as Record<string, unknown>);
  if (compiled.ok === false) throw new Error(`${node.node} node "${node.label}": ${compiled.errors.join("; ")}`);
  const validator = Compile(schema as never);
  return {
    questions: compiled.questions,
    decode: (answers, what = "") => {
      const value = answersToValue(answers, compiled.questions);
      if (!validator.Check(value)) throw new WorkflowOutputInvalidError(`${node.node} node "${node.label}"${what} answers do not satisfy schema "${node.out}"`, schemaProblems(validator, value), node.label);
      return value;
    },
  };
}

const describeItem = (template: string, state: Record<string, unknown>, item: unknown, index: number): string =>
  interpolate(template, { ...state, item, item_index: index }).replace(/\s+/g, " ").trim();

async function askQuestions(deps: WorkflowDeps, node: { node: "judge" | "pick" | "sift" | "route"; label: string }, asked: unknown, questions: Record<string, SystemOneQuestion>): Promise<{ answers: Record<string, SystemOneAnswer>; sidecar: AnswersSidecar; model: string | null; cost_usd: number | null }> {
  const runJudge = requireJudge(deps, node.node, node.label);
  const result = await runJudge({ label: node.label, kind: node.node, state: asked, questions, signal: deps.signal });
  validateAnswers(questions, result.answers);
  return { answers: result.answers, sidecar: answersSidecar(result.answers), model: result.model ?? null, cost_usd: result.cost_usd ?? null };
}

async function runJudgeNode(node: JudgeNode, state: Record<string, unknown>, workflow: Workflow, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  assertNodeInputs(node, state);
  const set = questionSetOf(workflow, node);
  const { answers, sidecar, model, cost_usd } = await askQuestions(deps, node, interpolateValue(node.state, state, node.label), set.questions);
  const value = set.decode(answers);
  deps.onEvent?.({ type: "judge.answered", label: node.label, detail: { kind: "judge", as: node.as, value, sidecar, model, cost_usd } });
  return { ...state, [node.as]: value, [`${node.as}$answers`]: sidecar };
}

async function runPickNode(node: PickNode, state: Record<string, unknown>, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  assertNodeInputs(node, state);
  const items = getPath(state, node.itemsPath);
  if (!Array.isArray(items)) throw new WorkflowStateError(`pick node "${node.label}": ${node.itemsPath} is not a list`, node.label, node.itemsPath, "expected_list");
  const NONE = "none_of_these";
  if (!items.length) {
    if (!node.allowNone) throw new WorkflowStateError(`pick node "${node.label}": ${node.itemsPath} is empty and the pick does not allow none`, node.label, node.itemsPath, "empty_selection");
    const value = { index: null, item: null, none: true, option: null }; const sidecar = answersSidecar({});
    deps.onEvent?.({ type: "judge.answered", label: node.label, detail: { kind: "pick", as: node.as, empty: true, value, sidecar } });
    return { ...state, [node.as]: value, [`${node.as}$answers`]: sidecar };
  }
  const capacity = SYSTEM_ONE_LIMITS.maxChoiceOptions - (node.allowNone ? 1 : 0);
  if (items.length > capacity) throw new Error(`pick node "${node.label}": ${items.length} items exceed the ${capacity} a choice can hold — sift first`);
  const options: Record<string, string> = Object.fromEntries(items.map((item, i) => [`item_${i}`, describeItem(node.describe, state, item, i) || `item ${i}`]));
  const criteria: Record<string, string | null> = node.allowNone ? { ...options, [NONE]: "none of the items fits" } : options;
  const asked = { ...(node.state ? interpolateValue(node.state, state, node.label) as Record<string, unknown> : { context: promptStateOf(state) }), candidates: options };
  const { answers, sidecar, model, cost_usd } = await askQuestions(deps, node, asked, { pick: { type: "choice", instructions: node.instructions, criteria } });
  const a = answers.pick;
  if (!a || a.type !== "choice") throw new Error(`pick node "${node.label}": no choice came back`);
  const none = a.choice === NONE;
  const index = none ? null : Object.keys(options).indexOf(a.choice);
  if (index !== null && index < 0) throw new Error(`pick node "${node.label}": the choice "${a.choice}" names no item`);
  const value = { index, item: index === null ? null : items[index], none, option: none ? null : options[a.choice] };
  deps.onEvent?.({ type: "judge.answered", label: node.label, detail: { kind: "pick", as: node.as, value, sidecar, model, cost_usd } });
  return { ...state, [node.as]: value, [`${node.as}$answers`]: sidecar };
}

async function runSiftNode(node: SiftNode, state: Record<string, unknown>, workflow: Workflow, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  assertNodeInputs(node, state);
  const items = getPath(state, node.itemsPath);
  if (!Array.isArray(items)) throw new WorkflowStateError(`sift node "${node.label}": ${node.itemsPath} is not a list`, node.label, node.itemsPath, "expected_list");
  const set = questionSetOf(workflow, node);
  const ids = Object.keys(set.questions);
  assertQuestionCount(deps, items.length * ids.length, node.label);
  const [keepId, keepTail] = node.keep ? node.keep.path.split(".") : [];
  const values: Record<string, unknown>[] = []; const sidecars: AnswersSidecar[] = []; const kept: number[] = [];
  let metering: { model: string | null; cost_usd: number | null } | null = null;
  if (items.length) {
    const base = node.state ? interpolateValue(node.state, state, node.label) as Record<string, unknown> : {};
    const named = items.map((item, i) => ({ id: `item_${i}`, ...(node.describe ? { summary: describeItem(node.describe, state, item, i) } : {}), item }));
    const questions: Record<string, SystemOneQuestion> = {};
    for (let i = 0; i < items.length; i += 1) for (const id of ids) questions[`${i}.${id}`] = { ...set.questions[id], instructions: `For \`items[${i}]\` (id item_${i}): ${set.questions[id].instructions}` } as SystemOneQuestion;
    const { answers, model, cost_usd } = await askQuestions(deps, node, { ...base, items: named }, questions);
    metering = { model, cost_usd };
    for (let i = 0; i < items.length; i += 1) {
      const mine: Record<string, SystemOneAnswer> = Object.create(null);
      for (const id of ids) { const a = answers[`${i}.${id}`]; if (!a) throw new Error(`sift node "${node.label}": no answer for item ${i} question "${id}"`); mine[id] = a; }
      values.push(set.decode(mine, ` answers for item ${i}`)); sidecars.push(answersSidecar(mine));
      if (!node.keep) { kept.push(i); continue; }
      const a = mine[keepId];
      const measure = keepTail === "confidence" ? answerConfidence(a) : a.type === "noul" ? a.noul : a.type === "score" ? a.score : NaN;
      const threshold = node.keep.gte ?? (a.type === "noul" && keepTail !== "confidence" ? 0.5 : 0);
      if (Number.isFinite(measure) && measure >= threshold) kept.push(i);
    }
  }
  const value = { items: kept.map((i) => items[i]), values, answers: sidecars, kept };
  deps.onEvent?.({ type: "judge.answered", label: node.label, detail: { kind: "sift", as: node.as, value, count: items.length, kept: kept.length, ...(metering ?? {}) } });
  return { ...state, [node.as]: value };
}

async function runRouteNode(node: RouteNode, state: Record<string, unknown>, workflow: Workflow, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  assertNodeInputs(node, state);
  const names = Object.keys(node.branches);
  const criteria: Record<string, string | null> = Object.fromEntries(names.map((n) => [n, node.branches[n]?.criteria?.trim() || null]));
  const { answers, sidecar, model, cost_usd } = await askQuestions(deps, node, interpolateValue(node.state, state, node.label), { branch: { type: "choice", instructions: node.instructions, criteria } });
  const a = answers.branch;
  if (!a || a.type !== "choice" || !names.includes(a.choice)) throw new Error(`route node "${node.label}": the choice "${String((a as any)?.choice)}" names no branch`);
  const unsure = Boolean(node.unsure && a.confidence < node.unsure.gte);
  const taken = unsure ? node.unsure!.branch : a.choice;
  const value = { branch: a.choice, taken, unsure };
  deps.onEvent?.({ type: "route.chosen", label: node.label, detail: { kind: "route", as: node.as ?? null, value, sidecar, model, cost_usd } });
  const routed = node.as ? { ...state, [node.as]: value, [`${node.as}$answers`]: sidecar } : state;
  return runNodeOnState(node.branches[taken].body, routed, workflow, scopeExecution(deps, "branches", taken, "body"));
}

const EXECUTION_PATH = Symbol("workflow.executionPath");
const SCOPED_EFFECTS = Symbol("workflow.scopedEffects");
/** The map item a scoped copy of deps runs for, so host policy context can name it. */
const MAP_ITEM = Symbol("workflow.mapItem");
type LocatedDeps = WorkflowDeps & { [EXECUTION_PATH]?: string; [SCOPED_EFFECTS]?: boolean; [MAP_ITEM]?: MapItem };
/** The reserved state key host policy writes under. Engine-owned like every `$`-prefixed key: no node may name it. */
export const HOST_STATE_KEY = "$host";
const hostStateOf = (state: Record<string, unknown>): Record<string, unknown> => {
  const host = state[HOST_STATE_KEY];
  return host && typeof host === "object" && !Array.isArray(host) ? host as Record<string, unknown> : {};
};
const hostContext = (workflow: Workflow, node: WorkflowNode, deps: WorkflowDeps): HostPolicyContext => {
  const item = (deps as LocatedDeps)[MAP_ITEM];
  const generative = node.node === "agent" || node.node === "decide" || node.node === "extract" || node.node === "report";
  return {
    workflow: { name: workflow.name, outputSchemaId: workflow.output.schemaId },
    node: { kind: node.node, label: String((node as { label?: string }).label ?? node.node), ...("out" in node && typeof node.out === "string" ? { out: node.out } : {}), ...("as" in node && typeof node.as === "string" ? { as: node.as } : {}) },
    terminal: generative && node.node !== "report" && (node as { out?: string }).out === workflow.output.schemaId,
    executionPath: executionPath(deps),
    ...(item ? { item } : {}),
  };
};

const executionPath = (deps: WorkflowDeps): string => (deps as LocatedDeps)[EXECUTION_PATH] ?? "/root";
const scopeExecution = (deps: WorkflowDeps, ...parts: (string | number)[]): WorkflowDeps => ({
  ...deps,
  [EXECUTION_PATH]: executionPath(deps) + parts.map(part => "/" + String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join(""),
} as LocatedDeps);

function withExecutionLocation(deps: WorkflowDeps): WorkflowDeps {
  const path = executionPath(deps);
  return {
    ...deps,
    ...(deps.runNode ? { runNode: params => deps.runNode!({ ...params, executionPath: params.executionPath ?? path }) } : {}),
    ...(deps.runEffect ? { runEffect: params => deps.runEffect!({ ...params, executionPath: params.executionPath ?? path }) } : {}),
    ...(deps.runJudge ? { runJudge: params => deps.runJudge!({ ...params, executionPath: params.executionPath ?? path }) } : {}),
    ...(deps.onEvent ? { onEvent: event => deps.onEvent!({ ...event, executionPath: event.executionPath ?? path }) } : {}),
  };
}

/** Older hosts only support flat child chains outside repeated/branching structure. They must
 * explicitly opt into location-aware recovery before newly composed graphs can execute. */
function needsComposedRecovery(node: WorkflowNode, structured = false, child = false): boolean {
  if (node.node === "workflow") {
    const steps = childSteps(node.workflow) ?? [];
    return structured || child || steps.some(step => !["code", "call", "agent", "decide", "extract", "escalate", "judge", "pick", "sift"].includes(step.node)) || needsComposedRecovery(node.workflow.root, false, true);
  }
  if (node.node === "chain") return node.steps.some(step => needsComposedRecovery(step, structured, child));
  if (node.node === "map" || node.node === "loop") return needsComposedRecovery(node.body, true, child);
  if (node.node === "parallel") return node.branches.some(branch => needsComposedRecovery(branch, structured, child));
  if (node.node === "route") return routeBodies(node).some(branch => needsComposedRecovery(branch, true, child));
  return false;
}

function scopeDepsToItem(deps: WorkflowDeps, item: MapItem, signal?: AbortSignal): WorkflowDeps {
  const recovery = deps.recovery;
  return {
    ...(deps as LocatedDeps),
    ...({ [MAP_ITEM]: item } as LocatedDeps),
    checkpoint: undefined,
    ...(signal ? { signal } : {}),
    ...(deps.runNode ? { runNode: params => deps.runNode!({ ...params, item: params.item ?? item, ...(signal ? { signal: params.signal ?? signal } : {}) }) } : {}),
    ...(deps.runEffect ? { runEffect: params => deps.runEffect!({ ...params, item: params.item ?? item }) } : {}),
    ...(deps.runJudge ? { runJudge: params => deps.runJudge!({ ...params, item: params.item ?? item, ...(signal ? { signal: params.signal ?? signal } : {}) }) } : {}),
    ...(recovery ? { recovery: {
      supportsExecutionPaths: recovery.supportsExecutionPaths,
      resume: (node, state, nestedItem, path) => recovery.resume(node, state, nestedItem ?? item, path),
      commit: (node, state, nestedItem, path) => recovery.commit(node, state, nestedItem ?? item, path),
      pollStartedAt: (node, nestedItem, path) => recovery.pollStartedAt(node, nestedItem ?? item, path),
      wait: (node, ms, nestedItem, path) => recovery.wait(node, ms, nestedItem ?? item, path),
      ...(recovery.fail ? { fail: (node, results, error, path) => recovery.fail!(node, results, error, path) } : {}),
    } } : {}),
  };
}

function scopeDepsToChild(deps: WorkflowDeps, invocation: WorkflowInvocation): WorkflowDeps {
  deps = scopeExecution(deps, "workflow", "root");
  const prefix = invocation.label;
  const relabel = <T extends WorkflowNode>(node: T): T => ("label" in node && typeof node.label === "string" ? { ...node, label: `${prefix}/${node.label}` } : node);
  const recovery = deps.recovery;
  return {
    ...deps,
    checkpoint: undefined,
    ...(deps.runNode ? { runNode: params => deps.runNode!({ ...params, label: `${prefix}/${params.label}` }) } : {}),
    ...(deps.runEffect ? { runEffect: params => deps.runEffect!({ ...params, node: relabel(params.node) }) } : {}),
    ...(deps.runJudge ? { runJudge: params => deps.runJudge!({ ...params, label: `${prefix}/${params.label}` }) } : {}),
    ...(recovery ? { recovery: {
      supportsExecutionPaths: recovery.supportsExecutionPaths,
      resume: (node, state, item, path) => recovery.resume(relabel(node), state, item, path),
      commit: (node, state, item, path) => recovery.commit(relabel(node), state, item, path),
      pollStartedAt: (node, item, path) => recovery.pollStartedAt(relabel(node), item, path),
      wait: (node, ms, item, path) => recovery.wait(relabel(node), ms, item, path),
      ...(recovery.fail ? { fail: (node, results, error, path) => recovery.fail!(relabel(node), results, error, path) } : {}),
    } } : {}),
    ...(deps.onEvent ? { onEvent: event => deps.onEvent!({ ...event, label: `${prefix}/${event.label}` }) } : {}),
  };
}

const STEP_KINDS: ReadonlySet<string> = new Set(["agent", "decide", "extract", "report", "code", "call", "artifact", "workflow", "judge", "pick", "sift"]);
const CHECKPOINTED_STRUCTURE_KINDS: ReadonlySet<string> = new Set(["map", "parallel", "loop", "route"]);

const guardedObservers = new WeakSet<NonNullable<WorkflowDeps["onEvent"]>>();

async function runNodeOnState(node: WorkflowNode, state: Record<string, unknown>, workflow: Workflow, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  deps = withExecutionLocation(deps);
  const observer = deps.onEvent;
  if (observer && !guardedObservers.has(observer)) {
    const guarded: NonNullable<WorkflowDeps["onEvent"]> = event => {
      try {
        // TypeScript void callbacks can still return promises. Consume rejection without
        // awaiting telemetry or allowing it to replace an execution or recovery outcome.
        // Observers receive snapshots, never objects shared with execution state.
        const returned: unknown = observer(observerSnapshot(event));
        if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(returned).catch(() => {});
        }
      } catch { /* Observation cannot control workflow delivery. */ }
    };
    guardedObservers.add(guarded);
    deps = { ...deps, onEvent: guarded };
  }
  if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
  if (deps.recovery && node.node !== "chain") {
    const restored = await deps.recovery.resume(node, state, undefined, executionPath(deps));
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
    if (restored !== undefined) return restored;
  }
  const label = (node as any).label || node.node;
  const isStep = STEP_KINDS.has(node.node);
  if (isStep) deps.onEvent?.({ type: "node.start", label, detail: { kind: node.node } });
  const startedAt = Date.now();
  try {
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
    let out = await runNodeBody(node, state, workflow, deps);
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
    // Host policy enrichment lands before commit and checkpoint: a resumed run sees exactly what ran.
    if (isStep && deps.hostPolicy?.afterNode) {
      const patch = deps.hostPolicy.afterNode({ ...hostContext(workflow, node, deps), state: out });
      if (patch && typeof patch === "object" && !Array.isArray(patch) && Object.prototype.hasOwnProperty.call(patch, HOST_STATE_KEY)) {
        throw new WorkflowStateError(`host policy afterNode for "${label}" may not write the reserved "${HOST_STATE_KEY}" key; return host state from decodeSubmission`, label, HOST_STATE_KEY, "reserved_state_key");
      }
      if (patch && typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length) {
        out = { ...out, ...patch };
        deps.onEvent?.({ type: "host.patched", label, detail: { keys: Object.keys(patch) } });
      }
    }
    if (deps.recovery && node.node !== "chain") await deps.recovery.commit(node, out, undefined, executionPath(deps));
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
    if ((isStep || CHECKPOINTED_STRUCTURE_KINDS.has(node.node)) && deps.checkpoint) {
      try { await deps.checkpoint(out, label, executionPath(deps)); }
      catch (error) {
        deps.onEvent?.({ type: "checkpoint.failed", label, detail: { message: String((error as Error)?.message || error).slice(0, 300) } });
        if (deps.checkpointFailureMode === "required") throw error;
      }
    }
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("workflow aborted");
    if (isStep) deps.onEvent?.({ type: "node.end", label, detail: { kind: node.node, status: "ok", duration_ms: Date.now() - startedAt } });
    return out;
  } catch (error) {
    if (isStep) deps.onEvent?.({ type: "node.end", label, detail: { kind: node.node, status: error instanceof EscalationSignal ? "escalated" : "failed", duration_ms: Date.now() - startedAt, error: String((error as any)?.message || error).slice(0, 300) } });
    throw error;
  }
}

function uncertainEffects(error: unknown, found = new Set<EffectOutcomeUnknownError>(), seen = new Set<unknown>()): Set<EffectOutcomeUnknownError> {
  if (seen.has(error)) return found;
  seen.add(error);
  if (error instanceof EffectOutcomeUnknownError) found.add(error);
  else if (error instanceof AggregateError) for (const nested of error.errors) uncertainEffects(nested, found, seen);
  return found;
}

function withSiblingUncertainty(primary: unknown, uncertainties: Set<EffectOutcomeUnknownError>): unknown {
  const retained = uncertainEffects(primary);
  const additional = [...uncertainties].filter(error => !retained.has(error));
  return additional.length
    ? new AggregateError([primary, ...additional], "Workflow branches failed with uncertain effects; reconcile each effect before retrying", { cause: primary })
    : primary;
}

async function runNodeBody(node: WorkflowNode, state: Record<string, unknown>, workflow: Workflow, deps: WorkflowDeps): Promise<Record<string, unknown>> {
  switch (node.node) {
    case "chain": {
      let current = state;
      for (let i = 0; i < node.steps.length; i++) current = await runNodeOnState(node.steps[i], current, workflow, scopeExecution(deps, "steps", i));
      return current;
    }
    case "code": {
      let out: unknown;
      try {
        const fn = compileTransform(node.code);
        out = fn(state, { sop: deps.sop || "" });
      } catch (cause) { throw new WorkflowCodeError(node.label, cause); }
      const patch = node.as ? { [node.as]: out } : (out && typeof out === "object" && !Array.isArray(out) ? out as Record<string, unknown> : { [node.label]: out });
      if (Object.prototype.hasOwnProperty.call(patch, HOST_STATE_KEY)) throw new WorkflowStateError(`code node "${node.label}" wrote the reserved "${HOST_STATE_KEY}" state key`, node.label, HOST_STATE_KEY, "reserved_state_key");
      deps.onEvent?.({ type: "code.patch", label: node.label, detail: patch });
      return { ...state, ...patch };
    }
    case "agent":
    case "decide":
    case "extract":
    case "report": {
      const stageSchema = stageSchemaForNode(workflow, node);
      const schema = stageSchema;
      const validator = Compile(schema as never);
      const { sopSections, sopSlice } = resolveSopSections(node, deps);
      if (deps.sop) deps.onEvent?.({ type: "sop.coverage", label: node.label, detail: { sections: sopSections.map((s) => ({ name: s, chars: sliceSop(deps.sop as string, s).length })), sliceChars: sopSlice.length, sopChars: (deps.sop as string).length } });
      assertNodeInputs(node, state);
      const promptState = node.state ? interpolateValue(node.state, state, node.label) : promptStateOf(state);
      const verifier = node.node !== "report" && (node as any).verify ? compileVerifier(workflow, node as WorkflowNode & { verify: VerifyClause; as?: string; label: string; node: string }, state, deps) : null;
      // Host policy: the adapter submits against the transport schema (the stage schema plus the host's
      // channels); the decoded domain value is what the stage schema, the verifier and the state see.
      const policy = deps.hostPolicy;
      const context = policy ? hostContext(workflow, node, deps) : null;
      const transportSchema = policy?.submissionSchema && context ? policy.submissionSchema(schema, context) : schema;
      const transportValidator = transportSchema === schema ? validator : Compile(transportSchema as never);
      const stageName = node.node === "report" ? "report" : node.out;
      const decode = (raw: unknown): { value: unknown; host?: Record<string, unknown> } => {
        normalizeStringNullsForSchema(raw, transportSchema as Record<string, unknown>);
        if (!transportValidator.Check(raw)) {
          throw new WorkflowOutputInvalidError(`${node.node} node "${node.label}" submission does not satisfy schema "${stageName}"`, schemaProblems(transportValidator, raw), node.label);
        }
        const decoded = policy?.decodeSubmission && context ? policy.decodeSubmission(raw, { ...context, host: hostStateOf(state) }) : { value: raw };
        if (decoded !== null && typeof decoded === "object" && decoded.value !== raw) normalizeStringNullsForSchema(decoded.value, schema as Record<string, unknown>);
        if (!validator.Check(decoded.value)) {
          throw new WorkflowOutputInvalidError(`${node.node} node "${node.label}" decoded submission does not satisfy schema "${stageName}"`, schemaProblems(validator, decoded.value), node.label);
        }
        return decoded;
      };
      // A verify clause reviews the domain value: the host's channels are split off before the judge sees it.
      const review = verifier
        ? (transportSchema === schema && !policy?.decodeSubmission
          ? verifier.review
          : async (candidate: unknown) => {
              let decoded: { value: unknown };
              try { decoded = decode(structuredClone(candidate)); }
              catch (error) {
                if (error instanceof WorkflowOutputInvalidError) return { accepted: false as const, message: error.message };
                throw error;
              }
              return verifier.review(decoded.value);
            })
        : undefined;
      let submission: unknown;
      submission = await deps.runNode!({
      signal: deps.signal,
      kind: node.node, label: node.label,
      ...(review ? { review } : {}),
      ...((node as any).tier ? { tier: (node as any).tier } : {}),
      system: [sopSlice, deps.skill, node.instructions, ...(policy?.systemBlocks && context ? policy.systemBlocks(context) : [])].filter(Boolean) as string[],
      user: JSON.stringify(promptState),
      schema: transportSchema,
      ...((node as any).effort ? { effort: (node as any).effort } : {}),
      ...((node as any).thinking ? { thinking: (node as any).thinking } : {}),
      ...(Array.isArray((node as any).tools) ? { tools: (node as any).tools } : {}),
      });
      const decoded = decode(submission);
      const result = decoded.value as Record<string, unknown>;
      const verified = verifier ? await verifier.finish(result) : null;
      let merged = mergeStageDelta(state, node, verified ? verified.submission : result, stageSchema);
      if (verified) merged = { ...merged, [`${("as" in node && node.as) || node.label}$verify`]: verified.record };
      const hostState = decoded.host && typeof decoded.host === "object" && !Array.isArray(decoded.host) ? decoded.host : null;
      if (hostState && Object.keys(hostState).length) {
        deps.onEvent?.({ type: "host.decoded", label: node.label, detail: { keys: Object.keys(hostState) } });
        merged = { ...merged, [HOST_STATE_KEY]: { ...hostStateOf(merged), ...hostState } };
      }
      return merged;
    }
    case "map": {
      const items = getPath(state, node.itemsPath);
      if (!Array.isArray(items)) throw new WorkflowStateError(`map node "${node.label}": ${node.itemsPath} is not a list`, node.label, node.itemsPath, "expected_list");
      const results: unknown[] = new Array(items.length);
      let cursor = 0;
      const width = Math.min(node.maxConcurrency ?? 4, Math.max(items.length, 1));
      const siblings = new AbortController();
      const signal = deps.signal ? AbortSignal.any([deps.signal, siblings.signal]) : siblings.signal;
      let failure: unknown;
      let failed = false;
      const uncertainties = new Set<EffectOutcomeUnknownError>();
      await Promise.all(Array.from({ length: width }, async () => {
        while (!signal.aborted) {
          const i = cursor++;
          if (i >= items.length) return;
          // Item-local state is never a checkpoint: concurrent bodies would overwrite one
          // another with partial views. The map checkpoints its aggregate when it completes.
          // Under recovery each item is its own child: the body's session, effects and commit
          // carry the item, so a resumed map answers finished items from their rows and
          // continues the ones that were running.
          try {
            const itemState = snapshotState({ ...state, item: items[i], item_index: i });
            const out = await runNodeOnState(node.body, itemState, workflow, scopeDepsToItem(scopeExecution(deps, "items", i, "body"), { label: node.label, index: i }, signal));
            if (node.resultPath !== undefined) {
              const selected = node.resultPath.split(".").reduce<unknown>((value, key) => value == null ? undefined : (value as Record<string, unknown>)[key], out);
              if (selected === undefined) throw new WorkflowStateError(`map node "${node.label}": resultPath "${node.resultPath}" is missing from item ${i}`, node.label, node.resultPath, "missing_map_result");
              results[i] = structuredClone(selected);
            } else results[i] = (node.body as any).as ? (out as any)[(node.body as any).as] : out;
          } catch (error) {
            uncertainEffects(error, uncertainties);
            if (!failed) { failed = true; failure = error; siblings.abort(error); }
            return;
          }
        }
      }));
      if (failed) {
        failure = withSiblingUncertainty(failure, uncertainties);
        const escalated = failure instanceof EscalationSignal;
        deps.onEvent?.({ type: escalated ? "map.escalated" : "map.failed", label: node.label, detail: { completed: results.reduce<number>((n, r) => n + (r === undefined ? 0 : 1), 0), of: items.length, message: String((failure as any)?.message || failure).slice(0, 300) } });
        if (!escalated && deps.recovery?.fail) {
          try { await deps.recovery.fail(node, results, failure, executionPath(deps)); }
          catch (persistenceError) {
            throw new AggregateError([failure, persistenceError], `map node "${node.label}" failed and its partial result could not be persisted`, { cause: failure });
          }
        }
        throw failure;
      }
      return { ...state, [node.as]: results };
    }
    case "parallel": {
      // Every branch starts from the same state and runs at once; what comes back is each branch's
      // PATCH (the keys whose value it changed), merged in branch order. Branch-local state is never
      // a checkpoint (a partial view would overwrite a sibling's); the node checkpoints the merge.
      const baseline = snapshotState(state);
      const inputs = (node.branches || []).map(() => snapshotState(baseline));
      const siblings = new AbortController();
      const signal = deps.signal ? AbortSignal.any([deps.signal, siblings.signal]) : siblings.signal;
      let failure: unknown;
      let failed = false;
      const uncertainties = new Set<EffectOutcomeUnknownError>();
      const outs = await Promise.all((node.branches || []).map(async (branch, i) => {
        try { return await runNodeOnState(branch, inputs[i], workflow, scopeExecution({ ...deps, signal, checkpoint: undefined }, "branches", i)); }
        catch (error) {
          uncertainEffects(error, uncertainties);
          if (!failed) { failed = true; failure = error; siblings.abort(error); }
          return inputs[i];
        }
      }));
      if (failed) throw withSiblingUncertainty(failure, uncertainties);
      const merged: Record<string, unknown> = { ...state };
      const writer = new Map<string, number>();
      // Host state is engine-owned and merges by delta: every branch started from the same `$host`, so an
      // array grows by what each branch appended, an unchanged value is kept, and two branches that set one
      // non-array key to different values are a write conflict like any other.
      const baseHost = hostStateOf(baseline);
      const mergedHost: Record<string, unknown> = { ...baseHost };
      const hostWriter = new Map<string, number>();
      let hostChanged = false;
      outs.forEach((out, i) => {
        const branchHost = hostStateOf((out || {}) as Record<string, unknown>);
        for (const [key, value] of Object.entries(branchHost)) {
          if (Object.hasOwn(baseHost, key) && isDeepStrictEqual(value, baseHost[key])) continue;
          hostChanged = true;
          // The same value from several branches is one write, whatever its shape.
          if (hostWriter.has(key) && isDeepStrictEqual(mergedHost[key], value)) continue;
          const base = baseHost[key];
          const prior = hostWriter.get(key);
          const conflict = () => new WorkflowStateError(`parallel node "${node.label}": branches ${prior} and ${i} both wrote host state ${HOST_STATE_KEY}.${key} to different values`, node.label, `${HOST_STATE_KEY}.${key}`, "parallel_write_conflict");
          // An append is an array that extends the base array (or a new array on a key with no base).
          // Appends from several branches join in branch order. An append meets a prior non-append
          // write of the same key as a conflict, whichever branch came first: no shape wins silently.
          if (Array.isArray(value) && (base === undefined || Array.isArray(base)) && (!Array.isArray(base) || (value.length >= base.length && base.every((entry, n) => isDeepStrictEqual(entry, value[n]))))) {
            if (prior !== undefined && !Array.isArray(mergedHost[key])) throw conflict();
            const appended = value.slice(Array.isArray(base) ? base.length : 0);
            mergedHost[key] = [...(Array.isArray(mergedHost[key]) ? mergedHost[key] as unknown[] : []), ...appended];
            hostWriter.set(key, i);
            continue;
          }
          if (prior !== undefined && !isDeepStrictEqual(mergedHost[key], value)) throw conflict();
          hostWriter.set(key, i);
          mergedHost[key] = value;
        }
      });
      if (hostChanged) merged[HOST_STATE_KEY] = mergedHost;
      outs.forEach((out, i) => {
        for (const [key, value] of Object.entries((out || {}) as Record<string, unknown>)) {
          if (key === HOST_STATE_KEY) continue;
          if (Object.hasOwn(baseline, key) && isDeepStrictEqual(value, baseline[key])) continue;
          const prior = writer.get(key);
          if (prior !== undefined) throw new WorkflowStateError(`parallel node "${node.label}": branches ${prior} and ${i} both wrote state.${key} — branches must write disjoint keys`, node.label, key, "parallel_write_conflict");
          writer.set(key, i);
          Object.defineProperty(merged, key, { value, enumerable: true, configurable: true, writable: true });
        }
      });
      return merged;
    }
    case "loop": {
      let current = state;
      for (let i = 0; i < node.maxIters; i += 1) {
        const iterationDeps = scopeExecution(deps, "iterations", i);
        current = await runNodeOnState(node.body, current, workflow, scopeExecution(iterationDeps, "body"));
        if ((await evaluatePredicate(node.until, current, withExecutionLocation(iterationDeps), { label: node.label, kind: "loop" })).holds) {
          deps.onEvent?.({ type: "loop.exited", label: node.label, detail: { reason: "condition_met", iterations: i + 1 } });
          return current;
        }
      }
      deps.onEvent?.({ type: "loop.exited", label: node.label, detail: { reason: "bound_reached", iterations: node.maxIters } });
      return current; // A following node decides what reaching the bound means for this workflow.
    }
    case "judge": {
      return runJudgeNode(node, state, workflow, deps);
    }
    case "pick": {
      return runPickNode(node, state, deps);
    }
    case "sift": {
      return runSiftNode(node, state, workflow, deps);
    }
    case "route": {
      return runRouteNode(node, state, workflow, deps);
    }
    case "artifact": {
      assertNodeInputs(node, state);
      const type = node.type;
      const artifact: ArtifactState = { path: String(node.path), filename: String(node.path).split("/").pop() as string, type };
      deps.onEvent?.({ type: "artifact.declared", label: node.label, detail: artifact });
      return { ...state, artifact };
    }
    case "call": {
      return runCallNode(node, state, workflow, deps);
    }
    case "workflow": {
      const input = structuredClone(interpolateValue(node.input, state, node.label)) as Record<string, unknown>;
      const child = node.workflow;
      const inputValidator = Compile(resolveSchemaForWorkflow(child, child.schemas[child.input!.schemaId]) as never);
      if (!inputValidator.Check(input)) throw new WorkflowOutputInvalidError(`workflow "${node.label}" input does not satisfy the child's schema "${child.input!.schemaId}"`, schemaProblems(inputValidator, input), node.label);
      const result = await runWorkflow(child, input, scopeDepsToChild(deps, node));
      if (result.status === "escalated") {
        const inner = result.escalation;
        throw new EscalationSignal({ kind: inner.kind, stage: inner.stage, summary: inner.summary, state, label: `${node.label}/${inner.label ?? inner.stage}`, executionPath: inner.executionPath });
      }
      const validator = Compile(resolveSchemaForWorkflow(workflow, workflow.schemas[node.out]) as never);
      if (!validator.Check(result.output)) throw new WorkflowOutputInvalidError(`workflow "${node.label}" returned a value that does not satisfy the parent's schema "${node.out}"`, schemaProblems(validator, result.output), node.label);
      return { ...state, [node.as]: structuredClone(result.output) };
    }
    case "escalate": {
      const evaluated = await evaluatePredicate(node.when, state, deps, { label: node.label, kind: "escalate" });
      const fired = evaluated.holds;
      const pathValue = (node.when as { path?: string })?.path
        ? String((node.when as { path?: string }).path).split(".").reduce<any>((acc, key) => (acc == null ? acc : acc[key]), state)
        : undefined;
      deps.onEvent?.({ type: "escalate.evaluated", label: node.label, detail: { fired, path: (node.when as { path?: string })?.path ?? null, path_resolved: pathValue !== undefined, ...(evaluated.detail ?? {}) } });
      if (fired) {
        throw new EscalationSignal({ kind: node.kind, stage: node.stage, summary: interpolate(node.summary, state), state, label: node.label, executionPath: executionPath(deps) });
      }
      return state;
    }
  }
}


function sliceSop(sop: string, section: string): string {
  const heading = sop.split(/\r?\n/).find(line => line.trimEnd() === `## ${section}`);
  const start = heading ? sop.indexOf(heading) : -1;
  if (start < 0) return "";
  const rest = sop.slice(start + 3);
  const boundary = /^ROLE\s*:/i.test(section) ? /\n## (?:ROLE\s*:|APPENDIX)/i : /\n## /;
  const next = rest.search(boundary);
  return sop.slice(start, next < 0 ? undefined : start + 3 + next);
}

export class WorkflowVerificationError extends Error {
  readonly code = "WORKFLOW_VERIFICATION_FAILED";
  constructor(readonly stage: string, readonly candidate: unknown, readonly drives: unknown[], message: string) {
    super(`Verification failed at "${stage}": ${message}`);
    this.name = "WorkflowVerificationError";
  }
}

function compileVerifier(workflow: Workflow, node: WorkflowNode & { verify: VerifyClause; as?: string; label: string; node: string }, state: Record<string, unknown>, deps: WorkflowDeps) {
  const clause = node.verify;
  const compiled = compileQuestions(workflow.schemas[clause.out] as Record<string, unknown>, workflow.schemas as Record<string, unknown>);
  if (compiled.ok === false) throw new Error(`${node.node} node "${node.label}": verify.out "${clause.out}": ${compiled.errors.join("; ")}`);
  const questions = compiled.questions;
  const schema = (workflow.schemas[clause.out] as { properties?: Record<string, { description?: string }> }).properties ?? {};
  const maxDrives = clause.maxDrives ?? 2; const floor = clause.override?.below ?? 0.3;
  const runJudge = requireJudge(deps, "judge", `${node.label} (verify)`);
  const drives: Array<{ drive: number; doubted: string[]; unmet: string[]; accepted: boolean; sidecar: AnswersSidecar }> = [];
  let reviewedCandidate: string | undefined;
  let last: { answers: Record<string, SystemOneAnswer>; doubted: string[]; unmet: string[] } | null = null;
  const pYes = (a: SystemOneAnswer | undefined): number => !a ? 0 : a.type === "noul" ? a.noul : a.type === "choice" ? (a.choice === "true" ? 1 : 0) : 0;
  const PLACEHOLDER = /^(none|null|nil|n\/a|na|unknown|not published|not stated|not available|not found|not applicable|-)$/i;
  const filled = (v: unknown): boolean => !(v === null || v === undefined || v === false || (typeof v === "string" && (v.trim() === "" || PLACEHOLDER.test(v.trim()))) || (Array.isArray(v) && v.length === 0));
  const outSchema = workflow.schemas[(node as { out?: string }).out ?? ""] as Record<string, unknown> | undefined;
  const review = async (candidate: unknown) => {
    if (drives.length >= maxDrives) throw new WorkflowVerificationError(node.label, candidate, drives, `exhausted ${maxDrives} review attempts`);
    const sub = (candidate && typeof candidate === "object" && !Array.isArray(candidate)) ? { ...(candidate as Record<string, unknown>) } : {};
    if (outSchema) normalizeStringNullsForSchema(sub, outSchema);
    const asked = interpolateValue({ ...(clause.state ?? {}), submission: "{submission}" }, { ...state, submission: sub, ...(node.as ? { [node.as]: sub } : {}) }, node.label);
    const result = await runJudge({ label: `${node.label} (verify)`, kind: "judge", state: asked, questions, signal: deps.signal });
  validateAnswers(questions, result.answers);
    const answers = result.answers; const doubted: string[] = []; const unmet: string[] = [];
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== "noul") continue;
      const p = pYes(answers[id]);
      if (Object.prototype.hasOwnProperty.call(sub, id)) { if (filled(sub[id]) && p < floor) doubted.push(id); }
      else if (p < 0.5) unmet.push(id);
    }
    const drive = drives.length + 1; const accepted = doubted.length === 0 && unmet.length === 0;
    reviewedCandidate = JSON.stringify(sub);
    const sidecar = answersSidecar(answers);
    drives.push({ drive, doubted, unmet, accepted, sidecar }); last = { answers, doubted, unmet };
    deps.onEvent?.({ type: "verify.answered", label: node.label, detail: { drive, doubted, unmet, accepted, sidecar, model: result.model ?? null, cost_usd: result.cost_usd ?? null } });
    if (accepted) return { accepted: true as const };
    if (drive >= maxDrives) throw new WorkflowVerificationError(node.label, sub, drives, `exhausted ${maxDrives} review attempts; unmet: ${unmet.join(", ") || "none"}; doubted: ${doubted.join(", ") || "none"}`);
    const line = (id: string) => `${id}: ${String(schema[id]?.description ?? questions[id].instructions).replace(/\s+/g, " ").trim()}`;
    const message = [
      doubted.length ? `Not supported by your evidence (remove it, or add the packet that prints it): ${doubted.map(line).join(" | ")}.` : "",
      unmet.length ? `Still required: ${unmet.map(line).join(" | ")}.` : "",
    ].filter(Boolean).join(" ");
    return { accepted: false as const, message };
  };
  const finish = async (submission: Record<string, unknown>) => {
    if (reviewedCandidate !== JSON.stringify(submission) || !drives.at(-1)?.accepted) {
      const verdict = await review(submission);
      if (!verdict.accepted) throw new WorkflowVerificationError(node.label, submission, drives, verdict.message);
    }
    return { submission, record: { drives, answers: last?.answers ?? {} } };
  };
  return { review, finish };
}

function resolveSopSections(node: { node: string; label?: string; sopSection?: string | string[] }, deps: WorkflowDeps): { sopSections: string[]; sopSlice: string } {
  const sopSections = Array.isArray(node.sopSection) ? node.sopSection : node.sopSection ? [node.sopSection] : [];
  if (sopSections.length && !deps.sop) throw new Error(`${node.node} node "${node.label}": sopSection requires SOP text in deps.sop`);
  const slices = sopSections.map(name => ({ name, text: sliceSop(deps.sop!, name) }));
  const missing = slices.filter(section => !section.text).map(section => section.name);
  if (missing.length) throw new Error(`${node.node} node "${node.label}": sopSection ${missing.map(name => `"${name}"`).join(", ")} matches no "## <section>" heading in the SOP`);
  return { sopSections, sopSlice: slices.map(section => section.text).join("\n\n") };
}

export function assertWorkflowCapabilities(node: WorkflowNode, deps: WorkflowDeps, workflow?: Workflow): void {
  assertQuestionCount(deps, 0, "workflow");
  if (workflow) {
    const schemaId = node.node === "judge" || node.node === "sift" ? node.out : "verify" in node ? node.verify?.out : undefined;
    if (schemaId) {
      const compiled = compileQuestions(workflow.schemas[schemaId], workflow.schemas);
      if (compiled.ok) assertQuestionCount(deps, Object.keys(compiled.questions).length, "label" in node ? node.label : node.node);
    }
  }
  if ("sopSection" in node) resolveSopSections(node, deps);
  const missing = (capability: string) => { throw new Error(`${node.node} node "${"label" in node ? node.label : node.node}" requires ${capability}`); };
  if ((["agent", "decide", "extract", "report"].includes(node.node) || node.node === "artifact" && artifactNodeIsProse(node)) && !deps.runNode) missing("runNode");
  if (node.node === "call" && !deps.runEffect) missing("runEffect");
  if ((["judge", "pick", "sift", "route"].includes(node.node) || "verify" in node && node.verify ||
      node.node === "loop" && (node.until as AskPredicate)?.predicate === "ask" ||
      node.node === "escalate" && (node.when as AskPredicate)?.predicate === "ask") && !deps.runJudge) missing("runJudge");
  if (node.node === "chain") node.steps.forEach(n => assertWorkflowCapabilities(n, deps, workflow));
  if (node.node === "parallel") node.branches.forEach(n => assertWorkflowCapabilities(n, deps, workflow));
  if (node.node === "map" || node.node === "loop") assertWorkflowCapabilities(node.body, deps, workflow);
  if (node.node === "route") Object.values(node.branches).forEach(b => assertWorkflowCapabilities(b.body, deps, workflow));
  if (node.node === "workflow") assertWorkflowCapabilities(desugarWorkflow(node.workflow).root, deps, node.workflow);
}

export async function runWorkflow(workflow: Workflow, input: Record<string, unknown>, deps: WorkflowDeps): Promise<WorkflowRunResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkflowInputInvalidError(String(workflow?.name), ["input must be a JSON object"]);
  const valid = validateWorkflow(workflow);
  if (!valid.ok) throw new WorkflowInvalidError(String(workflow?.name), valid.errors);
  workflow = desugarWorkflow(workflow);
  if (workflow.input) {
    const validator = Compile(resolveSchemaForWorkflow(workflow, workflow.schemas[workflow.input.schemaId]) as never);
    if (!validator.Check(input)) throw new WorkflowInputInvalidError(workflow.name, schemaProblems(validator, input));
  }
  const reachable = validateWorkflow(workflow, { inputKeys: Object.keys(input) });
  if (!reachable.ok) throw new WorkflowInvalidError(workflow.name, reachable.errors);
  assertWorkflowCapabilities(workflow.root, deps, workflow);
  if (needsComposedRecovery(workflow.root)) deps = { ...deps, [SCOPED_EFFECTS]: true } as LocatedDeps;
  if (deps.recovery && !deps.recovery.supportsExecutionPaths && needsComposedRecovery(workflow.root)) throw new Error("Composed child workflows require recovery.supportsExecutionPaths: true and stores keyed by executionPath");
  if (Object.prototype.hasOwnProperty.call(input, HOST_STATE_KEY)) throw new WorkflowInputInvalidError(workflow.name, [`input must not contain the reserved "${HOST_STATE_KEY}" key`]);
  try {
    const state = await runNodeOnState(workflow.root, snapshotState(input), workflow, deps);
    const host = hostStateOf(state);
    const output = workflow.output.path
      ? getPath(state, workflow.output.path)
      : (Object.prototype.hasOwnProperty.call(state, HOST_STATE_KEY) ? Object.fromEntries(Object.entries(state).filter(([key]) => key !== HOST_STATE_KEY)) : state);
    const validator = Compile(resolveSchemaForWorkflow(workflow, workflow.schemas[workflow.output.schemaId]) as never);
    if (!validator.Check(output)) {
      throw new WorkflowOutputInvalidError(`workflow "${workflow.name}" output does not satisfy schema "${workflow.output.schemaId}"`, schemaProblems(validator, output));
    }
    return { status: "complete", state, output, ...(Object.keys(host).length ? { host } : {}) };
  } catch (error) {
    if (error instanceof EscalationSignal) return { status: "escalated", state: error.escalation.state, escalation: error.escalation };
    throw error;
  }
}


export async function runWorkflowSlice(
  workflow: Workflow,
  input: Record<string, unknown>,
  focus: { from: string; to?: string; seed?: Record<string, unknown> },
  deps: WorkflowDeps,
): Promise<{ status: "complete"; state: Record<string, unknown>; focus: { from: string; to: string } } | { status: "escalated"; state: Record<string, unknown>; escalation: Escalation }> {
  const valid = validateWorkflow(workflow);
  if (!valid.ok) throw new WorkflowInvalidError(String(workflow?.name), valid.errors);
  const desugared = desugarWorkflow(workflow);
  const root = desugared.root.node === "chain" ? desugared.root.steps : [desugared.root];
  const labels = root.map((n) => (n as { label?: string }).label ?? "");
  const find = (want: string) => { const exact = labels.indexOf(want); return exact >= 0 ? exact : labels.findIndex((l) => l.startsWith(want)); };
  const a = find(focus.from);
  if (a < 0) throw new Error(`workflow slice: "${focus.from}" names no root step of "${desugared.name}"`);
  const b = focus.to ? find(focus.to) : a;
  if (b < 0) throw new Error(`workflow slice: "${focus.to}" names no root step of "${desugared.name}"`);
  if (b < a) throw new Error(`workflow slice: "${focus.to}" comes before "${focus.from}"`);
  const slice: WorkflowNode = { node: "chain", steps: root.slice(a, b + 1) };
  const state = snapshotState({ ...input, ...(focus.seed ?? {}) });
  assertWorkflowCapabilities(slice, deps, desugared);
  if (needsComposedRecovery(desugared.root)) deps = { ...deps, [SCOPED_EFFECTS]: true } as LocatedDeps;
  if (deps.recovery && !deps.recovery.supportsExecutionPaths && needsComposedRecovery(slice)) throw new Error("Composed child workflows require recovery.supportsExecutionPaths: true and stores keyed by executionPath");
  try {
    // A slice keeps the original document positions: effects must have the same identity as
    // the corresponding steps of the complete workflow, never renumbered from zero.
    let out = state;
    for (let i = a; i <= b; i++) out = await runNodeOnState(root[i], out, desugared,
      desugared.root.node === "chain" ? scopeExecution(deps, "steps", i) : deps);
    return { status: "complete", state: out, focus: { from: labels[a], to: labels[b] } };
  } catch (error) {
    if (error instanceof EscalationSignal) return { status: "escalated", state: error.escalation.state, escalation: error.escalation };
    throw error;
  }
}
