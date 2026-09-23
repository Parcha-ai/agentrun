import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { validateWorkflow, type Workflow, type WorkflowDeps, type WorkflowNode } from "./workflow.js";
import { SYSTEM_ONE_LIMITS } from "./system-one.js";
import {
  WORKFLOW_NODE_KINDS, NODE_FIELDS, WORKFLOW_PREDICATES, PREDICATE_FIELDS, MECHANICAL_PREDICATES,
  EFFORT_LEVELS, THINKING_LEVELS, MODEL_TIERS, CALL_TRANSPORTS, CALL_RETRY_CLASSES, PROSE_ARTIFACT_TYPES,
  GENERATIVE_NODE_KINDS, JUDGMENT_NODE_KINDS, type WorkflowNodeKind,
} from "./vocabulary.js";

/** What a host adds to the author contract. It names the host's own vocabulary and rules and never
 *  restates or changes the language: the package renders it once, after the language section. */
export interface AuthorHostAddendum {
  /** The host's name, the addendum's heading. */
  name: string;
  /** The keys the host seeds into the initial state, each with what it holds. Candidates are validated
   *  against exactly these keys when they declare no `input` schema. */
  initialState?: Readonly<Record<string, string>>;
  /** The artifact types the host delivers. A prose type is the report writer under the host's name; a file
   *  type names a file an earlier shell call produced. Declared, they are the only artifact types admitted. */
  outputTypes?: Readonly<Record<string, { kind: "prose" | "file"; description: string }>>;
  /** The node kinds the host runs. Declared, a candidate using any other kind is refused. */
  nodeKinds?: readonly WorkflowNodeKind[];
  /** Host rules, one sentence each. The host enforces them in its own acceptance checks. */
  rules?: readonly string[];
}

const code = (value: string): string => `\`${value}\``;
const list = (values: readonly string[]): string => values.map(code).join(", ");
const alternatives = (values: readonly string[]): string => values.join("|");

const PREDICATE_SHAPES: { readonly [Name in typeof WORKFLOW_PREDICATES[number]]: string } = {
  field_equals: "holds when the value at `path` equals `value` (a string, number or boolean)",
  field_true: "holds when the value at `path` is `true`",
  in: "holds when the value at `path` is one of `values` (a non-empty list of strings, numbers or booleans)",
  count_gte: "holds when the array (or number) at `path` has at least `n` items",
  gte: "holds when the finite number at `path` is at least `n`",
  lt: "holds when the finite number at `path` is below `n`",
  empty: "holds when the value at `path` is an empty array, an empty string, null or absent",
  no_new_items: "takes `key`, not `path`; holds when that state key is an empty array or falsy",
  ask: "a yes/no question for the host's judge: `instructions` is the question, `state` what it sees (default: the whole state), `criteria` optional {true, false} descriptions; holds when the yes-probability is at least `gte` (in (0.5, 1], default 0.6)",
};

function nodeFieldLines(): string {
  return WORKFLOW_NODE_KINDS.map((kind) => `- ${code(kind)}: ${list(NODE_FIELDS[kind].filter((field) => field !== "node"))}`).join("\n");
}

function predicateLines(): string {
  return WORKFLOW_PREDICATES.map((name) => `- ${code(name)} {${PREDICATE_FIELDS[name].join(", ")}}: ${PREDICATE_SHAPES[name]}`).join("\n");
}

const LANGUAGE = `You author AgentRun workflows: JSON documents the AgentRun interpreter runs.
Deliver the complete JSON document the way your host asks; never deliver prose, a file name or a fragment. Make the smallest workflow that satisfies the request. A candidate runs nothing until its host accepts it, and an accepted candidate is not activated by acceptance.

## Document

A workflow is {"v":2,"name","schemas","input"?,"output","root"}.
- ${code("schemas")} maps ids to inline JSON Schema objects. Every schema id a node, ${code("input")} or ${code("output")} names must exist there. Inside a schema, reference a catalog schema or an inline definition only as {"$ref":"#/definitions/<id>"}.
- The input contract: the run starts from the input object and nothing else. ${code("input.schemaId")}, when present, is enforced before the first node. A node may read only input keys and keys an earlier node wrote.
- ${code("output.schemaId")} validates the final value; ${code("output.path")} selects it from state and must name an input key or a key an earlier node wrote.
- State is one object. Each step writes its result under one key: its ${code("as")}, or, for an agent, decide, extract or code node without ${code("as")}, its label. A report writes ${code("report_markdown")}. A code node without ${code("as")} that returns an object merges that object's top-level fields instead.
- Keys that begin with ${code("$")} are engine-owned: ${code("$host")} (host state), ${code("<as>$answers")} (raw judge answers and confidences) and ${code("<as>$verify")} (verifier results). Read them; never write one. No ${code("as")} may begin with ${code("$")}, and neither may the label of an agent, decide, extract or code node without ${code("as")}.
- ${code("{dot.path}")} placeholders are replaced from state in ${code("state")} maps (including ${code("verify.state")} and ${code("ask.state")}), call ${code("args")}, ${code("input")}, ${code("env")} and ${code("produces")}, a child workflow's ${code("input")}, and ${code("escalate.summary")}; ${code("pick")} and ${code("sift")} ${code("describe")} templates also see ${code("{item...}")}. A placeholder that is the whole string keeps its value's type. Every key a state map, call or child input interpolates must be produced upstream. ${code("instructions")}, ${code("code")} and ${code("command")} are literal and never interpolated.

## Node kinds

This is the complete set. Each kind accepts exactly these fields; any other field is an error.
${nodeFieldLines()}

### Generative nodes: ${GENERATIVE_NODE_KINDS.join(", ")}

Each runs one adapter session. A kind is a preset (its duty, default effort and model tier), not a capability limit:
- ${code("extract")} transcribes facts already present in its input into ${code("out")}: faithfully, null for an absent field, nothing invented, no judgment.
- ${code("decide")} judges what is already in state.
- ${code("agent")} gathers new evidence with its tools.
- ${code("report")} renders the final record as the deliverable prose. It has no ${code("out")} or ${code("as")}: it writes ${code("report_markdown")}.

Their fields:
- ${code("instructions")} (required, non-empty) states the node's duty as literal prose. The node receives ${code("state")} (an interpolated map) or, without it, the accumulated state as its JSON input; refer to keys by name.
- ${code("out")} names the schema the submission must satisfy; the value lands at ${code("as")}.
- ${code("requires")} lists state paths that must hold evidence before the node runs, each produced upstream: missing values, null, blank strings, empty arrays and empty objects stop the run; ${code("false")} and ${code("0")} pass.
- ${code("tools")} names tools the host offers. ${code("[]")} means no tools; omitting ${code("tools")} offers every tool the host allows. Never name a tool the host did not offer.
- ${code("effort")} is ${alternatives(EFFORT_LEVELS)}; ${code("thinking")} is ${alternatives(THINKING_LEVELS)} (never off); ${code("tier")} is ${alternatives(MODEL_TIERS)}. They are requests to the host: resource ceilings are the host's, and nodes carry no budgets.
- ${code("sopSection")} names one heading of the host's SOP, or a list of them, as the exact text after "## ". The node receives those sections verbatim.
- ${code("verify")} reviews a submission before it is accepted: {"out": a question schema with at least one boolean question, "state"?, "maxDrives"?: 1..4 (default 2), "override"?: {"below": a number in (0, 1), default 0.3}}. A boolean question named after a submission field doubts that field when its yes-probability is below ${code("override.below")}; any other boolean question is a requirement met at 0.5. A rejected submission returns to the same session with the reasons.
- When the workflow has a report, no decide or extract ${code("out")} schema carries ${code("report_markdown")}.

### Terminal nodes: report and artifact

A workflow has at most one terminal node, a ${code("report")} or an ${code("artifact")}, and it is the last step of the root chain. No terminal node sits inside a map, loop, parallel branch, route branch or child workflow.
- An ${code("artifact")} of type ${PROSE_ARTIFACT_TYPES.map((type) => code(type)).join(" or ")} is the report writer: give it the report's fields.
- Any other ${code("artifact")} type names a file: ${code("path")} is the workspace-relative file an earlier shell call declared in ${code("produces")}, and the node has no model fields (${list(["instructions", "state", "sopSection", "tools", "effort", "thinking"])}).

### Judgment nodes: ${JUDGMENT_NODE_KINDS.join(", ")}

Typed questions answered by the host's judge in one request each: no tools, no session, no ${code("sopSection")}.
- A question schema is a flat object. Each property's ${code("description")} is its question. A boolean yields a yes-probability; a string enum (at most ${SYSTEM_ONE_LIMITS.maxChoiceOptions} options, optional per-option ${code("criteria")}) yields a choice; an integer with ${code("criteria")}: [level descriptions] (${SYSTEM_ONE_LIMITS.minScoreLevels} to ${SYSTEM_ONE_LIMITS.maxScoreLevels} levels, minimum 0, maximum the last level index) yields a score. Nothing else is a question.
- ${code("judge")}: a non-empty ${code("state")} map, ${code("out")} (a question schema) and ${code("as")}. The decoded value lands at ${code("as")}, the raw answers at ${code("<as>$answers")}.
- ${code("pick")}: ${code("itemsPath")}, ${code("describe")} (the option text per item, such as "{item.name}"), ${code("instructions")} (the one question) and ${code("as")}; ${code("allowNone")} adds a none-of-these option. The result is {index, item, none, option}.
- ${code("sift")}: ${code("itemsPath")}, ${code("out")} (a question schema asked of every item in one request) and ${code("as")}. ${code("keep")} {path: a question id or <id>.confidence, never a choice, gte?} keeps passing items, in order, at ${code("<as>.items")}.
- ${code("route")}: a non-empty ${code("state")} map, ${code("instructions")} (the one question) and 2 to ${SYSTEM_ONE_LIMITS.maxChoiceOptions} named ${code("branches")}, each {criteria?, body}. ${code("unsure")} {branch: one of the branches, gte: a number in (0, 1]} takes that branch when the choice's confidence is below ${code("gte")}. ${code("as")} records the choice.
- A decoded boolean is true at yes-probability 0.5. To hold a different threshold, read ${code("<as>$answers.answers.<id>.noul")} in a code node.

### Control nodes

- ${code("chain")}: non-empty ${code("steps")}, run in order.
- ${code("map")}: ${code("itemsPath")} (an upstream list), ${code("body")} and ${code("as")}. The body sees ${code("item")} and ${code("item_index")}; ${code("maxConcurrency")} is a positive integer (default 4); ${code("resultPath")} selects one path from each completed item's state.
- ${code("parallel")}: at least two ${code("branches")}, each starting from the state before the parallel node. Branches write disjoint keys and never read a sibling's writes.
- ${code("loop")}: ${code("body")}, ${code("until")} (a predicate) and an integer ${code("maxIters")} from 1 to 20. At the bound the state passes through with ${code("until")} unmet; follow the loop with an escalate or gate on that condition.
- ${code("escalate")}: ${code("when")} (a predicate), and non-empty ${code("kind")}, ${code("stage")} and ${code("summary")}. When the predicate holds the run stops without output and returns the escalation with its interpolated summary.
- ${code("workflow")}: ${code("label")}, ${code("workflow")} (a complete inline child), ${code("input")} (an object, interpolated, the child's entire initial state), ${code("out")} (a parent schema checked against the child's output) and ${code("as")}. The child declares ${code("input.schemaId")} in its own schemas and contains no report or artifact.
- ${code("code")}: ${code("code")} is one synchronous function expression such as "(s) => ({ total: s.items.length })". It receives the full state. ${code("Date")}, ${code("Promise")}, timers, ${code("fetch")}, ${code("require")}, ${code("process")}, ${code("Function")} and ${code("globalThis")} are unavailable. It is trusted host JavaScript, not a sandbox. Use code for typed-state mechanics, never to read meaning from prose.
- ${code("call")}: one side effect with no model in the loop. ${code("via")} is ${alternatives(CALL_TRANSPORTS)}; ${code("as")} and ${code("deadline_s")} (greater than 0, at most 3600) are required.
  - ${code("via: tool")} takes ${code("tool")} (a host tool address), ${code("args")} (an object) and ${code("out")} (the tool's result schema).
  - ${code("via: executor")} takes ${code("code")} (a body that returns its JSON result and uses only ${code("tools")} and ${code("input")}), ${code("input")} and ${code("out")}.
  - ${code("via: shell")} takes ${code("command")} (literal) and ${code("env")} (UPPER_CASE names to strings, interpolated by value; the way long values reach a command). Its result has the fixed shape {code, stdout, stderr, truncated?}: no ${code("out")}. Only a shell call may declare ${code("produces")} (workspace-relative files, checked after the effect).
  - ${code("retry")} {attempts: 1..5, backoff_s?: 0..60, on?: [${CALL_RETRY_CLASSES.join(", ")}]}. ${code("where")} accepts only "sandbox".
  - ${code("poll")} {until, fail_when?, interval_s: 0.1..300, deadline_s: from the call's deadline_s to 7200} repeats the call until ${code("until")} holds on its own result; ${code("fail_when")} fails it at once. Both are mechanical predicates whose paths are relative to the result and lie in its declared shape.
  - Validation and dry runs never perform effects: they synthesize the declared result, and a shell result's stdout is "{}".

## Predicates

${code("loop.until")} and ${code("escalate.when")} take one of these; ${code("poll")} takes only the first ${MECHANICAL_PREDICATES.length}. Each path or key reads a state value an input or an earlier node produced.
${predicateLines()}

## Authority

- Use only tools the host names. Never invent a tool, capability, evidence source or successful check.
- Code, call and artifact nodes need the host's explicit authorization for executable candidates.
- When the host supplies rubric sections, they are authoritative source text: every generative node's ${code("sopSection")} lists all of them, a merged judgment inherits the union of its parents' sections, and policy is never paraphrased into instructions. Judgment nodes, ${code("ask")} predicates and ${code("verify")} clauses are then refused until the host reviews a separate question contract.
- Acceptance checks are the host's. Never change a check, fixture or threshold to pass.
- Bound loops and parallelism. Uncertainty escalates or takes an explicit fallback such as ${code("route.unsure")} or a threshold gate.

## Example

{"v":2,"name":"summarize","schemas":{"Input":{"type":"object","properties":{"text":{"type":"string","minLength":1}},"required":["text"],"additionalProperties":false},"Result":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}},"input":{"schemaId":"Input"},"output":{"schemaId":"Result","path":"result"},"root":{"node":"extract","label":"summarize","instructions":"Summarize the text field faithfully. Invent nothing.","out":"Result","as":"result","requires":["text"],"tools":[]}}`;

/** The host section of the contract, or "" without a host. */
export function renderAuthorHostAddendum(host: AuthorHostAddendum | undefined): string {
  if (!host) return "";
  const lines: string[] = [`## Host: ${host.name}`, "", "These host rules add to the language above; they never change it."];
  if (host.initialState && Object.keys(host.initialState).length) {
    lines.push(`- The run starts with exactly these state keys: ${Object.entries(host.initialState).map(([key, description]) => `${code(key)} (${description})`).join("; ")}. Any other key must be written by a node before it is read.`);
  }
  if (host.outputTypes && Object.keys(host.outputTypes).length) {
    const types = Object.entries(host.outputTypes).map(([type, spec]) => `${code(type)} (${spec.kind === "prose" ? "prose: the report writer, with the report's fields" : `file: ${code("path")} names the file an earlier shell call produced`}; ${spec.description})`);
    lines.push(`- A terminal artifact's ${code("type")} is one of: ${types.join("; ")}.`);
  }
  if (host.nodeKinds) lines.push(`- This host runs only these node kinds: ${list(host.nodeKinds)}. Author no other kind.`);
  for (const rule of host.rules ?? []) lines.push(`- ${rule}`);
  return lines.join("\n");
}

/** The one author contract: the language every host shares, then the host's addendum when one is supplied. */
export function authorContract(options: { host?: AuthorHostAddendum } = {}): string {
  const addendum = renderAuthorHostAddendum(options.host);
  return addendum ? `${LANGUAGE}\n\n${addendum}` : LANGUAGE;
}

export interface CandidatePolicyOptions {
  /** Authoritative rubric text by section name. Every generative node must name every section. */
  rubricSections?: Record<string, string>;
  /** Admits code, call and artifact nodes. */
  allowExecutableCandidates?: boolean;
  /** Direct tool calls admitted without executable authorization. */
  allowedEffectTools?: readonly string[];
  host?: AuthorHostAddendum;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Author policy over a candidate, checked before validation so a refused candidate never evaluates code. */
export function candidatePolicyErrors(candidate: unknown, options: CandidatePolicyOptions): string[] {
  const errors: string[] = [];
  const sections = Object.keys(options.rubricSections ?? {});
  const kinds = options.host?.nodeKinds ? new Set<string>(options.host.nodeKinds) : undefined;
  const outputTypes = options.host?.outputTypes;
  const visit = (value: unknown) => {
    const node = record(value);
    if (!node) return;
    const kind = node.node;
    if (kinds && !kinds.has(String(kind))) errors.push(`${String(node.label ?? kind)}: this host does not run ${String(kind)} nodes`);
    if (!options.allowExecutableCandidates && ["code", "call", "artifact"].includes(String(kind)) && !(kind === "call" && node.via === "tool" && typeof node.tool === "string" && options.allowedEffectTools?.includes(node.tool))) errors.push(`${kind} requires allowExecutableCandidates`);
    if (sections.length && (JUDGMENT_NODE_KINDS as readonly string[]).includes(String(kind))) errors.push(`${String(kind)} cannot carry supplied SOP sections; use an LLM node with sopSection`);
    const llm = (GENERATIVE_NODE_KINDS as readonly string[]).includes(String(kind));
    const predicate = kind === "loop" ? record(node.until) : kind === "escalate" ? record(node.when) : undefined;
    if (sections.length && (predicate?.predicate === "ask" || (llm && node.verify !== undefined))) errors.push("Semantic predicates and verify clauses require a separately reviewed question contract when rubric sections are supplied");
    const hostType = kind === "artifact" && typeof node.type === "string" && outputTypes && Object.hasOwn(outputTypes, node.type) ? outputTypes[node.type] : undefined;
    if (kind === "artifact" && outputTypes && !hostType) errors.push(`${String(node.label ?? kind)}: artifact type ${JSON.stringify(node.type)} is not one of this host's output types`);
    const proseArtifact = kind === "artifact" && ((PROSE_ARTIFACT_TYPES as readonly unknown[]).includes(node.type) || hostType?.kind === "prose");
    if (llm || proseArtifact) {
      const included = Array.isArray(node.sopSection) ? node.sopSection : [node.sopSection];
      for (const section of sections) if (!included.includes(section)) errors.push(`${String(node.label)} must include rubric section ${section}`);
    }
    switch (kind) {
      case "chain": if (Array.isArray(node.steps)) node.steps.forEach(visit); break;
      case "parallel": if (Array.isArray(node.branches)) node.branches.forEach(visit); break;
      case "map": case "loop": visit(node.body); break;
      case "route": {
        const branches = record(node.branches);
        if (branches) Object.values(branches).forEach(branch => visit(record(branch)?.body));
        break;
      }
      case "workflow": visit(record(node.workflow)?.root); break;
    }
  };
  visit(record(candidate)?.root);
  return errors;
}

/** The interpreter's view of a workflow written in a host's vocabulary: an artifact of a declared prose output
 *  type becomes the report writer it is. Validate and run this view; retain and digest the authored bytes. */
export function applyHostOutputTypes(candidate: Workflow, host: AuthorHostAddendum | undefined): Workflow {
  const prose = new Set(Object.entries(host?.outputTypes ?? {}).filter(([, spec]) => spec.kind === "prose").map(([type]) => type));
  if (!prose.size) return candidate;
  const visit = (node: WorkflowNode): WorkflowNode => {
    if (!node || typeof node !== "object") return node;
    if (node.node === "artifact" && prose.has(node.type)) return { ...node, type: "report" };
    if (node.node === "chain") return { ...node, steps: (node.steps || []).map(visit) };
    if (node.node === "parallel") return { ...node, branches: (node.branches || []).map(visit) };
    if (node.node === "map" || node.node === "loop") return { ...node, body: visit(node.body) };
    if (node.node === "route") return { ...node, branches: Object.fromEntries(Object.entries(node.branches || {}).map(([name, branch]) => [name, { ...branch, body: visit(branch?.body) }])) };
    return node;
  };
  return { ...candidate, root: visit(candidate.root) };
}

export interface AuthorWorkflowOptions {
  request: string;
  outputDir: string;
  /** The host's generative adapter. The author asks it for one agent session with no tools. */
  runNode: NonNullable<WorkflowDeps["runNode"]>;
  host?: AuthorHostAddendum;
  /** Keys available to a candidate without an input schema; defaults to the host's initial state keys. */
  inputKeys?: string[];
  rubricSections?: Record<string, string>;
  allowExecutableCandidates?: boolean;
  maxCandidates?: number;
  /** Host acceptance over a structurally valid candidate, in the interpreter's view (`applyHostOutputTypes`):
   *  diagnostics, or [] to accept. */
  acceptance?: (candidate: Workflow) => Promise<string[]> | string[];
  signal?: AbortSignal;
}

export interface AuthoredWorkflow {
  /** The accepted candidate as authored. A host with prose output types runs `applyHostOutputTypes(workflow, host)`. */
  workflow: Workflow;
  path: string;
  directory: string;
  candidates: number;
  checks: "structural" | "structural-and-host";
}

/** Author one workflow and retain every candidate with its review in a new directory under `outputDir`.
 *  Policy, validation and host acceptance review each submission; a rejection returns to the same session. */
export async function authorWorkflow(options: AuthorWorkflowOptions): Promise<AuthoredWorkflow> {
  if (!options.request.trim()) throw new Error("Workflow request is required");
  const maxCandidates = options.maxCandidates ?? 4;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error("maxCandidates must be a positive integer");
  const inputKeys = options.inputKeys ?? (options.host?.initialState ? Object.keys(options.host.initialState) : []);
  const directory = resolve(options.outputDir, `candidate-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "request.json"), JSON.stringify({ request: options.request, host: options.host?.name ?? null, inputKeys, rubricSections: options.rubricSections ?? {}, allowExecutableCandidates: options.allowExecutableCandidates ?? false, maxCandidates }, null, 2), { flag: "wx" });
  let candidates = 0;
  let acceptedPath: string | undefined;
  let accepted: Workflow | undefined;
  const checks = options.acceptance ? "structural-and-host" as const : "structural" as const;
  try {
    await options.runNode({
      kind: "agent", label: "author-workflow", tools: [], signal: options.signal,
      system: [authorContract({ host: options.host }), "Deliver each candidate as the value of the submit tool. A rejected candidate comes back with its errors; repair it in the same session.", `Executable candidates authorized: ${options.allowExecutableCandidates ?? false}.`, `All supplied rubric sections (authoritative): ${JSON.stringify(options.rubricSections ?? {})}`],
      user: `${options.request}\nAvailable input keys: ${JSON.stringify(inputKeys)}`,
      schema: { type: "object", additionalProperties: true },
      async review(value) {
        candidates++;
        if (candidates > maxCandidates) throw new Error(`Candidate limit exceeded: ${maxCandidates}`);
        const number = String(candidates).padStart(3, "0");
        const candidatePath = join(directory, `${number}.json`);
        await writeFile(candidatePath, JSON.stringify(value, null, 2), { flag: "wx" });
        const errors = candidatePolicyErrors(value, options);
        if (!errors.length) {
          try {
            const verdict = validateWorkflow(applyHostOutputTypes(value as Workflow, options.host), { inputKeys });
            if (!verdict.ok) errors.push(...verdict.errors);
          } catch (error) { errors.push(`Invalid workflow: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (!errors.length && options.acceptance) errors.push(...await options.acceptance(applyHostOutputTypes(structuredClone(value) as Workflow, options.host)));
        await writeFile(join(directory, `${number}.review.json`), JSON.stringify({ accepted: !errors.length, checks, errors }, null, 2), { flag: "wx" });
        if (errors.length) return { accepted: false, message: errors.join("\n") };
        acceptedPath = candidatePath;
        accepted = structuredClone(value) as Workflow;
        return { accepted: true };
      },
    });
    // The result is the candidate review accepted, never whatever the adapter returns afterwards.
    if (!acceptedPath || !accepted) throw new Error("Author returned without a retained accepted candidate");
    const workflow = accepted;
    await writeFile(join(directory, "result.json"), JSON.stringify({ status: "candidate", path: acceptedPath, candidates }, null, 2), { flag: "wx" });
    return { workflow, path: acceptedPath, directory, candidates, checks };
  } catch (error) {
    await writeFile(join(directory, "result.json"), JSON.stringify({ status: "failed", candidates, message: error instanceof Error ? error.message : String(error) }, null, 2), { flag: "wx" });
    throw error;
  }
}

/** The packaged author skill's name, as a skill-loading host registers it. */
export const AUTHOR_SKILL_NAME = "agentrun-author";

const skillRoot = new URL("../skills/author/", import.meta.url);

/** The absolute directory of the packaged author skill (the one holding SKILL.md). */
export function authorSkillDirectory(): string {
  return fileURLToPath(skillRoot);
}

/** A reference shipped with the author skill, for hosts without file-reading tools. */
export function loadAuthorReference(name: "language" | "workflow-format" | "jev-decisions"): string {
  return readFileSync(new URL(`references/${name}.md`, skillRoot), "utf8");
}

/** The whole skill as one text: SKILL.md, its references and its JSON examples. */
export function loadAuthorSkillBundle(): string {
  const files = ["SKILL.md", "references/language.md", "references/workflow-format.md", "references/jev-decisions.md",
    ...readdirSync(new URL("examples/", skillRoot)).filter(name => name.endsWith(".json")).sort().map(name => `examples/${name}`)];
  return files.map(path => `\n--- ${path} ---\n${readFileSync(new URL(path, skillRoot), "utf8")}`).join("\n");
}
