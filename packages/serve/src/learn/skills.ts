// What a run may propose beside its notes: one skill, `skills/<name>/SKILL.md`, and workflow drafts,
// `workflows/<name>/workflow.json` with its `README.md`. Their places in the learning folder and the shape each file must
// have. check.ts checks them; nothing here reads a file, runs a draft or calls a model.
import type { assertWorkflowCapabilities, desugarWorkflow, dryRunWorkflow, inspectWorkflow, resolveSchemaForWorkflow, validateWorkflow, Workflow } from "@parcha/agentrun-dsl";

/** Where a skill and a workflow draft live in the folder. */
export const SKILLS_DIR = "skills";
export const WORKFLOWS_DIR = "workflows";
/** The shared skills convention's name: lowercase letters, digits and single dashes, at most 64. */
export const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A workflow's name: lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or digit. */
export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A skill's `SKILL.md`, a workflow's `workflow.json` or its `README.md`, by the folder it names. */
export type LearnedPlace = { readonly kind: "skill" | "workflow" | "readme"; readonly name: string };
const PLACES: readonly (readonly [RegExp, LearnedPlace["kind"]])[] = [
  [/^skills\/([^/]+)\/SKILL\.md$/, "skill"],
  [/^workflows\/([^/]+)\/workflow\.json$/, "workflow"],
  [/^workflows\/([^/]+)\/README\.md$/, "readme"],
];

/** Where `path` sits among the skills and workflows, its folder's name as written (unchecked); undefined when it is
 *  not a skill's or a workflow's file. */
export function learnedPlace(path: string): LearnedPlace | undefined {
  for (const [pattern, kind] of PLACES) {
    const name = pattern.exec(path)?.[1];
    if (name !== undefined) return { kind, name };
  }
  return undefined;
}

/** Whether `name` is a good name for a folder of `kind`. */
export const learnedName = (kind: LearnedPlace["kind"], name: string): boolean => (kind === "skill" ? SKILL_NAME : WORKFLOW_NAME).test(name);

/** A SKILL.md's or a draft README's front matter: its lines, where it closes (the index of its closing `\n---\n`, in
 *  `lf`, the text with LF line ends) and each key's value, a folded or literal block value read as one line. A string
 *  is why there is none. */
function frontOf(text: string): { lf: string; end: number; value: (key: string) => string | undefined } | string {
  const lf = text.replace(/\r\n/g, "\n");
  if (!lf.startsWith("---\n")) return "it does not start with front matter";
  const end = lf.indexOf("\n---\n", 3);
  if (end < 0) return "its front matter is not closed";
  const lines = lf.slice(4, end).split("\n");
  const value = (key: string): string | undefined => {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const own = lines[at]!.slice(key.length + 1).trim();
    const more: string[] = [];
    for (const line of lines.slice(at + 1)) if (/^\s+\S/.test(line)) more.push(line.trim()); else break;
    if (/^[>|][-+]?$/.test(own)) return more.join(" ").trim();
    // A plain value folds the indented lines after it in, one space each, as YAML reads it: one that wraps, or one
    // written entirely on the next lines. A quoted one is read as its own line says.
    // A comment line (`# ...`) is no part of a plain value; a block keeps its lines as written.
    const words = more.filter((line) => !line.startsWith("#"));
    if (!own) return words.join(" ").trim();
    if (words.length && !/^["']/.test(own)) return [own, ...words].join(" ").trim();
    return own.replace(/^(["'])(.*)\1$/, "$2").trim();
  };
  return { lf, end, value };
}

/** The keys a SKILL.md's or a draft README's front matter sets, in order (each line at its left edge that names one);
 *  undefined for a text with no front matter. */
export function frontKeys(text: string): string[] | undefined {
  const front = frontOf(text);
  if (typeof front === "string") return undefined;
  return front.lf.slice(4, front.end).split("\n").flatMap((line) => /^([^\s#:][^:]*):/.exec(line)?.[1] ?? []).map((key) => key.trim());
}

/** The front matter keys a learned skill or draft README may hold: what a skill is (its name and when to use it). Claude
 *  Code reads directives from more (hooks, allowed-tools, context, agent, model, ...): a hook is a shell command its CLI
 *  runs. `status` is the host's (a held one). */
export const LEARNED_KEYS: readonly string[] = ["name", "description"];

/** `text`, a learned skill's SKILL.md, as a run is given it: front matter with its name and its description alone,
 *  written again whatever else its file holds (servedSkill is the one door a learned skill reaches a harness by), then its
 *  body as it is. A text with no front matter is as it is. */
export function servedSkill(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") return text;
  const description = front.value("description") ?? "";
  // Quoted only where YAML would read it as more than one plain line of text.
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^\n]*$/.test(description) && !/: |\s#|:$/.test(description);
  const lines = [`name: ${front.value("name") ?? ""}`, `description: ${plain ? description : JSON.stringify(description)}`];
  return `---\n${lines.join("\n")}\n---\n${front.lf.slice(front.end + 5)}`;
}

/** Why a `SKILL.md` for the skill `name`, or a draft's `README.md` for the workflow `name`, is out of shape; empty when
 *  it is not. Its front matter names the folder's name and a description. */
export function skillProblems(text: string, name: string): string[] {
  const front = frontOf(text);
  if (typeof front === "string") return [front];
  const out: string[] = [];
  if (front.value("name") !== name) out.push(`name is not the folder's name, ${name}`);
  if (!front.value("description")) out.push("description is missing or empty");
  return out;
}

/** A SKILL.md's or a draft README's front matter as a reader shows it: its name, description and status, each absent
 *  when it is not there; undefined for a text with no front matter. */
export function learnedFront(text: string): { name?: string; description?: string; status?: string } | undefined {
  const front = frontOf(text);
  if (typeof front === "string") return undefined;
  const [name, description, status] = ["name", "description", "status"].map((key) => front.value(key));
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), ...(status === undefined ? {} : { status }) };
}

/** Whether a SKILL.md or a draft's README.md sets `status`, which only the host does (`held`). */
export const setsStatus = (text: string): boolean => {
  const front = frontOf(text);
  return typeof front !== "string" && front.value("status") !== undefined;
};

/** A skill or a draft the grader held for its owner's OK: its SKILL.md, or its draft's README.md, says `status:
 *  pending`. No run is given a held skill or workflow until a person approves it. */
export const isHeld = (text: string): boolean => {
  const front = frontOf(text);
  return typeof front !== "string" && front.value("status") === "pending";
};

/** `text`, a SKILL.md or a draft's README.md, as the host merges one the grader held for its owner's OK: `status:
 *  pending` last in its front matter, with LF line ends. Throws on a text with no front matter, which the checker never
 *  passes. */
export function held(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") throw new Error(`it cannot be held: ${front}`);
  return `${front.lf.slice(0, front.end)}\nstatus: pending${front.lf.slice(front.end)}`;
}

/** `text`, a held SKILL.md or draft README.md, as the host leaves it when its owner approves it: its front matter with
 *  no `status` line, so it is given to every later run. Throws on a text with no front matter. */
export function released(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") throw new Error(`it cannot be approved: ${front}`);
  const kept = front.lf.slice(4, front.end).split("\n").filter((line) => !line.startsWith("status:"));
  return `---\n${kept.join("\n")}${front.lf.slice(front.end)}`;
}

/** What a SKILL.md or a draft's README.md says of itself: `pending` while it waits for its owner's OK, `retired` once a
 *  person retired it, else `active`. A run is given only an active one. */
export function learnedStatus(text: string): "active" | "pending" | "retired" {
  const front = frontOf(text);
  const status = typeof front === "string" ? undefined : front.value("status");
  return status === "pending" ? "pending" : status === "retired" ? "retired" : "active";
}

/** `text`, a SKILL.md or a draft's README.md, as a person's retire leaves it: `status: retired` last in its front matter
 *  (any status line before it dropped), so no later run is given it. Throws on a text with no front matter. */
export function retiredLearned(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") throw new Error(`it cannot be retired: ${front}`);
  const kept = front.lf.slice(4, front.end).split("\n").filter((line) => !line.startsWith("status:"));
  return `---\n${[...kept, "status: retired"].join("\n")}${front.lf.slice(front.end)}`;
}

/** A draft's `README.md` as the host writes it, from the workflow's name and the one-line description its block gives. */
export const readmeOf = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n`;

/** A workflow block's two files: its `description:` front matter written as the draft's README.md (readmeOf), and the
 *  JSON after it as its workflow.json. A block with no front matter, or none that says what the draft is for, gives a
 *  README with no description, which the checker refuses; what the JSON holds is the checker's to judge. `example`, its
 *  `example:` front matter line as written (the run's own input to the workflow, one JSON object): what its dry run runs
 *  on (draftDryRun), and never a file's: the README holds its name and description alone, so the run's input, which can
 *  be a customer's data, is never kept in the learning folder. */
export function draftFiles(name: string, block: string): { json: string; readme: string; example?: string } {
  const front = frontOf(block);
  if (typeof front === "string") return { json: block, readme: readmeOf(name, "") };
  const description = (front.value("description") ?? "").replace(/\s+/g, " ").trim();
  const example = front.value("example")?.trim();
  return { json: front.lf.slice(front.end + "\n---\n".length), readme: readmeOf(name, description), ...(example ? { example } : {}) };
}

/** How a draft's dry run went (draftDryRun): `passed`, the path its one input took ran on synthetic values (not every
 *  branch or body); `not_run`, a check could not run (`detail` says which), so it is no proof; `failed`, `detail` says
 *  where. */
export type DraftDryRun = { readonly status: "passed" | "not_run" | "failed"; readonly detail?: string };

/** The words a draft that failed its dry run is left out with, before why: a re-ask reads them (reflect-hook.ts). */
export const DRY_RUN_FAILED = "its dry run failed";
/** The most synthetic steps a draft's dry run takes before it stops, as not run. */
const DRY_RUN_STEPS = 2_000;
/** The longest a draft's dry run may take, by the clock, before it stops, as not run: a backstop behind the steps and the
 *  static bounds (the DSL reads its signal at each step). */
const DRY_RUN_MS = 10_000;

/** The code runner a dry run hands every code node to: it refuses each. Given a runner, the DSL validates with
 *  executeCode: false (a code node's expression is parsed, never evaluated or probed) and never compiles or calls a code
 *  body in this process; with none, it evaluates every code node's expression and runs its body here, at validation and
 *  at run time. A learned draft holds no code node (draftProblems refuses it before any dry run): this holds even when
 *  one is handed here anyway. */
const refuseCode = async (node: { readonly label: string }): Promise<never> => {
  throw new Error(`the code node "${node.label}" is never run: a learned draft holds no code node`);
};

/** The most of a value a draft's dry run may synthesize from one of its schemas (the DSL's synthesizeInstance builds
 *  each in the host, before any step it counts): an array's minItems and a string's minLength each, and the values and
 *  string characters the schema's whole synthesized instance holds. Past any of them the draft is refused statically
 *  (draftProblems), and a dry run handed one anyway stands down as not run before anything is built (draftDryRun). */
export const SYNTH_MIN_ITEMS = 100;
export const SYNTH_MIN_LENGTH = 1_000;
export const SYNTH_VALUES = 2_000;
export const SYNTH_CHARS = 64_000;
/** The depth past which the DSL's synthesis stops (synthesizeInstance: null past 12). */
const SYNTH_DEPTH = 12;

type Synthesized = { values: number; chars: number };
/** A literal's values and string characters (a const, an enum's first), as the value it is. */
const literalSize = (value: unknown): Synthesized =>
  value === null || typeof value !== "object"
    ? { values: 1, chars: typeof value === "string" ? value.length : 0 }
    : Object.values(value as Record<string, unknown>).map(literalSize).reduce((a, b) => ({ values: a.values + b.values, chars: a.chars + b.chars }), { values: 1, chars: 0 });
/** What the DSL's synthesizeInstance would build of `schema` at `depth`, counted without building it: its values and its
 *  strings' characters. It reads the schema as synthesis does (a $ref to its definitions, a const or an enum's first, an
 *  anyOf's first non-null branch, a oneOf's first, an object's every property, an array of max(1, minItems) items, a
 *  string of max(1, minLength) characters, nothing past depth 12), and counts an array's items once, times its length,
 *  each (schema, depth) once (`seen`), so the count itself is bounded by the schema's size. */
function synthesized(schema: unknown, definitions: Readonly<Record<string, unknown>>, depth: number, seen: Map<unknown, Map<number, Synthesized>>): Synthesized {
  if (depth > SYNTH_DEPTH || !schema || typeof schema !== "object") return { values: 1, chars: 0 };
  const known = seen.get(schema)?.get(depth);
  if (known) return known;
  const spec = schema as Record<string, unknown>;
  const of = (sub: unknown) => synthesized(sub, definitions, depth + 1, seen);
  let out: Synthesized = { values: 1, chars: 0 };
  const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  if (typeof spec.$ref === "string") {
    const match = /^#\/definitions\/(.+)$/.exec(spec.$ref);
    if (match && definitions[match[1]!]) out = of(definitions[match[1]!]);
  } else if (spec.const !== undefined || (Array.isArray(spec.enum) && spec.enum.length)) {
    // The literal itself, as written in the draft (so bounded by its size).
    out = literalSize(spec.const !== undefined ? spec.const : (spec.enum as unknown[])[0]);
  } else if (Array.isArray(spec.anyOf) && spec.anyOf.length) {
    out = of(spec.anyOf.find((branch) => (branch as { type?: unknown } | null)?.type !== "null") ?? spec.anyOf[0]);
  } else if (Array.isArray(spec.oneOf) && spec.oneOf.length) {
    out = of(spec.oneOf[0]);
  } else if (type === "object" || (!type && spec.properties)) {
    for (const property of Object.values((spec.properties as Record<string, unknown>) || {})) {
      const one = of(property);
      out = { values: out.values + one.values, chars: out.chars + one.chars };
    }
  } else if (type === "array") {
    if (spec.maxItems !== 0 && spec.items) {
      const length = Math.max(1, Number.isInteger(spec.minItems) ? (spec.minItems as number) : 1);
      const item = of(spec.items);
      out = { values: 1 + length * item.values, chars: length * item.chars };
    }
  } else if (type === "string") {
    if (spec.maxLength !== 0) out = { values: 1, chars: Math.max(1, Number.isInteger(spec.minLength) ? (spec.minLength as number) : 1) };
  }
  let atDepth = seen.get(schema);
  if (!atDepth) seen.set(schema, (atDepth = new Map()));
  atDepth.set(depth, out);
  return out;
}

/** What the DSL's synthesizeInstance would build of `schema` over `definitions`, counted without building it. */
export const synthesizedSize = (schema: unknown, definitions: Readonly<Record<string, unknown>> = {}): Synthesized => synthesized(schema, definitions, 0, new Map());

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The nodes directly inside `node`, as the DSL reads them (recovery/execution-path.ts childrenOf): a chain's steps, a
 *  parallel's branches, a map's or a loop's body, a route's branch bodies. A composed workflow node's child is a
 *  workflow, walked as one (eachWorkflow). Only these are node positions: an object anywhere else (a schema, a const, a
 *  step's literal value) is data, never a node, whatever keys it holds. */
function childNodes(node: Record<string, unknown>): unknown[] {
  switch (node.node) {
    case "chain": return Array.isArray(node.steps) ? node.steps : [];
    case "parallel": return Array.isArray(node.branches) ? node.branches : [];
    case "map": case "loop": return [node.body];
    case "route": return isRecord(node.branches) ? Object.values(node.branches).map((branch) => (isRecord(branch) ? branch.body : undefined)) : [];
    default: return [];
  }
}

/** Each workflow in `doc` (the draft's own, then each composed workflow node's child, at any depth), each with the loops
 *  around it (their maxIters multiplied), and each node of it at a node position with the loops around that node. */
function eachWorkflow(doc: unknown, visit: { workflow?: (workflow: Record<string, unknown>) => void; node?: (node: Record<string, unknown>, around: number) => number }): void {
  const walkNode = (value: unknown, around: number): void => {
    if (!isRecord(value)) return;
    const within = visit.node ? visit.node(value, around) : around;
    if (value.node === "workflow") return walkWorkflow(value.workflow, within);
    for (const child of childNodes(value)) walkNode(child, within);
  };
  const walkWorkflow = (value: unknown, around: number): void => {
    if (!isRecord(value)) return;
    visit.workflow?.(value);
    walkNode(value.root, around);
  };
  walkWorkflow(doc, 1);
}

/** Every workflow in `doc` with its schemas: the draft's own and each composed workflow node's child, at any depth. */
function workflowsOf(doc: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  eachWorkflow(doc, { workflow: (workflow) => out.push(workflow) });
  return out;
}

/** The keywords whose values are schemas, by shape: a map of them, a list of them, or one (a list too, for items). Every
 *  other keyword's value (const, enum, default, examples, a title) is data, never a schema. */
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
const SCHEMA_ONES = ["items", "additionalItems", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedItems", "unevaluatedProperties"] as const;

/** Each schema in `schema`, itself first, at schema positions only (each once). */
function eachSchema(schema: unknown, visit: (spec: Record<string, unknown>) => void, seen = new Set<unknown>()): void {
  if (!isRecord(schema) || seen.has(schema)) return;
  seen.add(schema);
  visit(schema);
  for (const key of SCHEMA_MAPS) if (isRecord(schema[key])) for (const sub of Object.values(schema[key] as Record<string, unknown>)) eachSchema(sub, visit, seen);
  for (const key of SCHEMA_LISTS) if (Array.isArray(schema[key])) for (const sub of schema[key] as unknown[]) eachSchema(sub, visit, seen);
  for (const key of SCHEMA_ONES) for (const sub of Array.isArray(schema[key]) ? (schema[key] as unknown[]) : [schema[key]]) eachSchema(sub, visit, seen);
}

/** The most iterations one loop of a learned draft may run (its maxIters), and the most nested loops may run together
 *  (their maxIters multiplied, outermost to innermost). A loop's iterations are work the dry run does in the host whether
 *  or not its body asks a model (an empty map, a predicate), so they are bounded here, not only by the dry run's steps. */
export const LEARNED_MAX_ITERS = 50;
export const LEARNED_LOOP_ITERS = 1_000;

/** Why `doc`'s loops could run too long: a loop whose maxIters is past LEARNED_MAX_ITERS, or nested loops whose maxIters
 *  multiply past LEARNED_LOOP_ITERS, a composed workflow node's child's included. Read from the JSON alone, at node
 *  positions only (eachWorkflow): a literal shaped like a loop is data. */
export function loopProblems(doc: unknown): string[] {
  const problems: string[] = [];
  eachWorkflow(doc, {
    node: (node, around) => {
      if (node.node !== "loop") return around;
      const iters = typeof node.maxIters === "number" ? node.maxIters : 0;
      const label = JSON.stringify(String(node.label ?? "").slice(0, 64));
      const within = around * iters;
      if (iters > LEARNED_MAX_ITERS) problems.push(`its loop ${label} runs up to maxIters ${iters} times (the most is ${LEARNED_MAX_ITERS})`);
      else if (within > LEARNED_LOOP_ITERS) problems.push(`its loop ${label} and the loops around it run up to ${within} times together, their maxIters multiplied (the most is ${LEARNED_LOOP_ITERS})`);
      return within;
    },
  });
  return problems;
}

/** How the dry run resolves a schema before it synthesizes it (the DSL's resolveSchemaForWorkflow): its `$ref`s to the
 *  workflow's other schemas filled into its definitions, whatever definitions it gives of its own. */
export type SchemaResolver = { readonly resolveSchemaForWorkflow: typeof resolveSchemaForWorkflow };

/** Why a dry run of `doc` would build too much in the host: a schema whose minItems or minLength is past its cap, or
 *  whose synthesized instance holds more values or characters than SYNTH_VALUES or SYNTH_CHARS. Empty when none. Each
 *  schema is counted as the dry run reads it, after the same resolution (`dsl.resolveSchemaForWorkflow`), so a `$ref` a
 *  schema's own (even empty) definitions would hide is counted as the dry run fills it in. Building nothing. */
export function synthesisProblems(doc: unknown, dsl: SchemaResolver): string[] {
  const problems: string[] = [];
  for (const workflow of workflowsOf(doc)) {
    const schemas = workflow.schemas && typeof workflow.schemas === "object" ? (workflow.schemas as Record<string, Record<string, unknown>>) : {};
    for (const [id, raw] of Object.entries(schemas)) {
      // One count per schema: a `$ref` resolves against that schema's own definitions.
      const seen = new Map<unknown, Map<number, Synthesized>>();
      let schema: Record<string, unknown>;
      try {
        schema = raw && typeof raw === "object" ? dsl.resolveSchemaForWorkflow({ schemas }, raw) : raw;
      } catch (error) {
        problems.push(`its schema ${JSON.stringify(id.slice(0, 64))} could not be resolved as its dry run would: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
        continue;
      }
      // Each cap, on each schema in the schema (eachSchema: schema positions only; a literal that holds the keyword is
      // data).
      const caps = new Set<string>();
      eachSchema(schema, (spec) => {
        if (typeof spec.minItems === "number" && spec.minItems > SYNTH_MIN_ITEMS) caps.add(`minItems ${spec.minItems} (the most is ${SYNTH_MIN_ITEMS})`);
        if (typeof spec.minLength === "number" && spec.minLength > SYNTH_MIN_LENGTH) caps.add(`minLength ${spec.minLength} (the most is ${SYNTH_MIN_LENGTH})`);
      });
      const definitions = (schema as { definitions?: Record<string, unknown> } | null)?.definitions ?? schemas;
      const size = synthesized(schema, definitions, 0, seen);
      if (size.values > SYNTH_VALUES) caps.add(`${size.values > 1e12 ? "over a trillion" : size.values} values (the most is ${SYNTH_VALUES})`);
      if (size.chars > SYNTH_CHARS) caps.add(`${size.chars > 1e12 ? "over a trillion" : size.chars} characters (the most is ${SYNTH_CHARS})`);
      if (caps.size) problems.push(`its schema ${JSON.stringify(id.slice(0, 64))} would have its dry run synthesize too large a value: ${[...caps].join(", ")}`);
    }
  }
  return problems;
}

/** A draft's workflow.json `json` dry-run by the workflow DSL (dryRunWorkflow) on `example` (its block's `example:`
 *  line, one JSON object), else on an input synthesized from its input schema. Every model, Jev and tool-call answer is
 *  synthesized from the node's output schema: no request is sent, nothing is paid, no tool runs, and no code it holds
 *  runs in this process (refuseCode). Only a draft the static checks pass is dry-run (propose.ts). It checks the wiring
 *  at run time (the state each step reads, its output's path and schema), never the answers. */
export async function draftDryRun(dsl: { readonly dryRunWorkflow: typeof dryRunWorkflow } & SchemaResolver, json: string, example?: string): Promise<DraftDryRun> {
  let doc: unknown;
  let input: Record<string, unknown> | undefined;
  try {
    doc = JSON.parse(json);
  } catch {
    return { status: "failed", detail: `${DRY_RUN_FAILED}: it does not parse as JSON` };
  }
  if (example !== undefined) {
    let given: unknown;
    try {
      given = JSON.parse(example);
    } catch {
      given = undefined;
    }
    if (typeof given !== "object" || given === null || Array.isArray(given)) return { status: "failed", detail: `${DRY_RUN_FAILED}: its example: line is not one JSON object` };
    input = given as Record<string, unknown>;
  }
  // Nothing is synthesized or looped past the bounds: a draft whose schemas would build too much, or whose loops could run
  // too long, stands down here before the DSL runs any of it (the static checks refuse it first; this holds for a draft
  // handed here anyway).
  const tooLarge = [...synthesisProblems(doc, dsl), ...loopProblems(doc)];
  if (tooLarge.length) return { status: "not_run", detail: tooLarge.join("; ").slice(0, 300) };
  let result: Awaited<ReturnType<typeof dryRunWorkflow>>;
  try {
    result = await dsl.dryRunWorkflow(doc as Workflow, { ...(input ? { input } : {}), maxSteps: DRY_RUN_STEPS, runCode: refuseCode, signal: AbortSignal.timeout(DRY_RUN_MS) });
  } catch (error) {
    return { status: "failed", detail: `${DRY_RUN_FAILED}: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
  if (result.ok) return result.status === "passed" ? { status: "passed" } : { status: "not_run", detail: (result.skipped ?? []).join("; ").slice(0, 300) || "a check could not run" };
  return { status: "failed", detail: `${DRY_RUN_FAILED}${result.stage ? ` at "${result.stage.slice(0, 64)}"` : ""}: ${result.problems.join("; ").slice(0, 300)}` };
}

/** The refusal for a draft that names a tool when the host gave no tool list: the check fails closed. */
export const NO_TOOL_LIST = "no tool list was given, so a draft that names a tool is refused";

export type DraftProblem = { readonly rule: "workflow" | "no_tool_list" | "executable_node"; readonly detail: string };
/** What a draft is read with: the workflow DSL's own validation and inspection. The caller loads the DSL (`await
 *  import("@parcha/agentrun-dsl")`), which the server only ever loads when it needs it, and hands it here. */
export type DraftReader = SchemaResolver & { readonly validateWorkflow: typeof validateWorkflow; readonly inspectWorkflow: typeof inspectWorkflow; readonly desugarWorkflow: typeof desugarWorkflow; readonly assertWorkflowCapabilities: typeof assertWorkflowCapabilities };

/** The value at a JSON Pointer (RFC 6901) in `doc`. */
const at = (doc: unknown, pointer: string): unknown =>
  pointer.split("/").slice(1).reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);

/** A draft carries no node that runs code: a `code` node runs in the host's process unless the host isolates it, and a
 *  call via shell or executor runs a command. The DSL's inspection lists each node and its pointer. */
const executableNodes = (dsl: DraftReader, doc: unknown): DraftProblem[] =>
  dsl.inspectWorkflow(doc).nodes.flatMap((node) => {
    if (node.kind === "code") return [{ rule: "executable_node" as const, detail: `the code node at ${node.path} runs code in the host's process; a learned draft holds no code node` }];
    const via = node.kind === "call" ? (at(doc, node.path) as { via?: unknown } | undefined)?.via : undefined;
    return via === "shell" || via === "executor" ? [{ rule: "executable_node" as const, detail: `the call node at ${node.path} runs via ${via}; a learned draft never runs a command` }] : [];
  });

/** What a learned workflow's model node is refused with when it names a tool: it runs in a session of its own, with no
 *  tool (learned-workflow.ts). Refused at learn time and before a call runs any node, never after earlier nodes spent. */
export const MODEL_NODE_TOOLS = "a learned workflow's model node runs without tools";

/** A draft's model nodes that name a tool: only a call node runs one. The DSL's inspection lists each node and its
 *  pointer; a call node's `tool` is the DSL's to check against the list. */
const toolingNodes = (dsl: DraftReader, doc: unknown): DraftProblem[] =>
  dsl.inspectWorkflow(doc).nodes.flatMap((node) => {
    if (node.kind === "call") return [];
    const tools = (at(doc, node.path) as { tools?: unknown } | undefined)?.tools;
    return Array.isArray(tools) && tools.length ? [{ rule: "workflow" as const, detail: `the model node at ${node.path} names a tool (${tools.map(String).join(", ").slice(0, 200)}): ${MODEL_NODE_TOOLS}` }] : [];
  });

/** What a learned draft whose output names no path is refused with. */
export const LEARNED_OUTPUT_PATH = "its output names no path: a learned workflow's output is the value at output.path";

/** What a learned workflow is refused with when a node needs more than its runner gives the DSL (learned-workflow.ts:
 *  runNode and runEffect alone): a judge, pick or sift node, a route by question, a verify or an ask needs a decision
 *  provider (runJudge) a run is not given. Refused at learn time and before a call runs any node, never after. */
export const LEARNED_NODES = "a learned workflow runs model and tool-call nodes";

/** Where a deny was set (tool-gate.ts SettingFrom), and its words (tool-gate.ts denyPlace), kept here so the learn
 *  module needs no import of the gate. */
type SettingFrom = "agent" | "server" | "default";
const denyPlace = (from: SettingFrom = "server"): string => (from === "agent" ? "for this agent" : from === "default" ? "by default" : "on this server");

/** A draft's call nodes that call a tool in `gated` (by name, what the gate holds it to: ask or deny), a composed
 *  workflow node's inner ones too (the DSL's inspection lists them, by their pointer under it): the run would park on it
 *  or refuse it, and a call node cannot wait for an approval. Worded as the server words a workflow revision's call node
 *  on such a tool before its run starts (runnable.ts), with the node's place. */
const gatedNodes = (dsl: DraftReader, doc: unknown, gated: Readonly<Record<string, string>>, deniedBy: Readonly<Record<string, SettingFrom>>): DraftProblem[] =>
  dsl.inspectWorkflow(doc).nodes.flatMap((node) => {
    if (node.kind !== "call") return [];
    const tool = (at(doc, node.path) as { tool?: unknown } | undefined)?.tool;
    const setting = typeof tool === "string" ? gated[tool] : undefined;
    if (!setting) return [];
    const words = setting === "deny"
      ? `This workflow's call node calls ${tool}, which is set to deny ${denyPlace(deniedBy[tool as string])}.`
      : `This workflow's call node calls ${tool}, which is set to ask, and a workflow's call node can't wait for an approval: set it to allow for this agent.`;
    return [{ rule: "workflow" as const, detail: `${words} (the call node at ${node.path})` }];
  });

/** The most turns a learned workflow's model node runs (learned-workflow.ts hands its runner this cap): an agent node
 *  that asks for more is refused at learn time and before a call, never when it comes up after earlier nodes spent. */
export const LEARNED_MAX_TURNS = 8;

/** A draft's agent nodes that ask what the learned runner refuses when the node comes up (the pi runner's request-time
 *  checks, with the options learned-workflow.ts hands it; learn-runner-parity.test.mjs holds the two together): more
 *  turns than LEARNED_MAX_TURNS, or `context: "fork"` (every node starts a fresh session, with no transcript to fork). */
const longNodes = (dsl: DraftReader, doc: unknown): DraftProblem[] =>
  dsl.inspectWorkflow(doc).nodes.flatMap((node) => {
    const fields = (at(doc, node.path) as { max_turns?: unknown; context?: unknown } | undefined) ?? {};
    const out: DraftProblem[] = [];
    if (typeof fields.max_turns === "number" && fields.max_turns > LEARNED_MAX_TURNS) out.push({ rule: "workflow", detail: `the agent node at ${node.path} asks max_turns ${fields.max_turns}: a learned workflow's model node runs at most ${LEARNED_MAX_TURNS} turns` });
    if (fields.context === "fork") out.push({ rule: "workflow", detail: `the agent node at ${node.path} asks context fork: a learned workflow's model node starts a fresh session` });
    return out;
  });

/** The node the learned runner cannot run, as the DSL's own check says it (assertWorkflowCapabilities, which runWorkflow
 *  makes before any node runs) with the runner's deps: none when it can run every one. */
const unrunnableNodes = (dsl: DraftReader, doc: unknown): DraftProblem[] => {
  const workflow = dsl.desugarWorkflow(doc as Workflow);
  const runner = { runNode: async () => ({}), runEffect: async () => ({}) };
  try {
    dsl.assertWorkflowCapabilities(workflow.root, runner as never, workflow);
    return [];
  } catch (error) {
    return [{ rule: "workflow", detail: `${(error as Error).message.slice(0, 200)}: ${LEARNED_NODES}` }];
  }
};

const issuesOf = (dsl: DraftReader, doc: unknown, tools?: readonly string[]) => {
  const valid = dsl.validateWorkflow(doc as Workflow, { executeCode: false, ...(tools ? { tools } : {}) });
  return valid.ok ? [] : valid.issues;
};

/** Why `workflows/<name>/workflow.json` is not a draft the host can run; empty when it is. The DSL's own
 *  `validateWorkflow` judges it, with `executeCode: false` so no code it holds is run (a code node is syntax-checked),
 *  and with `tools`, so a node that names a tool outside them is its error: a harness's own tool (Bash, exec_command,
 *  apply_patch) is never on the list. A model node that names any tool is refused (MODEL_NODE_TOOLS), and a node the
 *  learned runner cannot run (LEARNED_NODES: a judge's). With no list it
 *  fails closed: a draft the DSL refuses only once given an empty list names a tool. */
export function draftProblems(dsl: DraftReader, text: string, tools?: readonly string[], gated: Readonly<Record<string, string>> = {}, deniedBy: Readonly<Record<string, SettingFrom>> = {}): DraftProblem[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ rule: "workflow", detail: "it does not parse as JSON" }];
  }
  // A tool in `gated` is the agent's own, held back by the gate: on the list here, so the refusal is the gate's words
  // (gatedNodes), not the DSL's for a tool it was never given.
  const listed = tools ? [...tools, ...Object.keys(gated)] : undefined;
  const issues = issuesOf(dsl, doc, listed);
  if (issues.length) return issues.slice(0, 5).map((issue) => ({ rule: "workflow", detail: `the workflow DSL refuses it: ${issue.code} at ${issue.path || "/"}: ${issue.message.slice(0, 200)}` }));
  let out: DraftProblem[];
  try {
    out = [...toolingNodes(dsl, doc), ...executableNodes(dsl, doc), ...unrunnableNodes(dsl, doc), ...longNodes(dsl, doc), ...gatedNodes(dsl, doc, gated, deniedBy), ...[...synthesisProblems(doc, dsl), ...loopProblems(doc)].map((detail) => ({ rule: "workflow" as const, detail }))];
    // A learned workflow answers the value at its output's path: one that names none would answer its whole state, which
    // fails its output schema when the call ends, after every node spent.
    const path = (doc as { output?: { path?: unknown } } | null)?.output?.path;
    if (typeof path !== "string" || !path) out.push({ rule: "workflow", detail: LEARNED_OUTPUT_PATH });
    // A composed workflow node's child too: its output is the value at its own output.path, or it fails the same way.
    for (const node of dsl.inspectWorkflow(doc).nodes) {
      if (node.kind !== "workflow") continue;
      const child = (at(doc, node.path) as { workflow?: { output?: { path?: unknown } } } | undefined)?.workflow;
      const childPath = child?.output?.path;
      if (typeof childPath !== "string" || !childPath) out.push({ rule: "workflow", detail: `the workflow node at ${node.path}: ${LEARNED_OUTPUT_PATH}` });
    }
  } catch (error) {
    // The inspection reads the whole document, as validation need not: what it cannot read is refused, never passed.
    return [{ rule: "workflow", detail: `the workflow DSL cannot inspect it: ${(error as Error).message.slice(0, 200)}` }];
  }
  if (!tools && issuesOf(dsl, doc, []).length) out.push({ rule: "no_tool_list", detail: NO_TOOL_LIST });
  return out;
}
