// What a run may propose beside its notes: one skill, `skills/<name>/SKILL.md`, and workflow drafts,
// `workflows/<name>/workflow.json` with its `README.md`. Their places in the learning folder and the shape each file must
// have. check.ts checks them; nothing here reads a file, runs a draft or calls a model.
import type { assertWorkflowCapabilities, desugarWorkflow, inspectWorkflow, validateWorkflow, Workflow } from "@parcha/agentrun-dsl";

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
 *  no `status` or `retired_from` line, so it is given to every later run. Throws on a text with no front matter. */
export function released(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") throw new Error(`it cannot be approved: ${front}`);
  const kept = front.lf.slice(4, front.end).split("\n").filter((line) => !line.startsWith("status:") && !line.startsWith("retired_from:"));
  return `---\n${kept.join("\n")}${front.lf.slice(front.end)}`;
}

/** The status a retired SKILL.md or draft README.md goes back to when a person restores it (`retired_from`, which its
 *  retire recorded): `active` only when it was active; `pending` otherwise, a retire that recorded none among them (fail
 *  closed: only an approval makes a skill or a draft active). */
export function retiredFrom(text: string): "active" | "pending" {
  const front = frontOf(text);
  return typeof front !== "string" && front.value("retired_from") === "active" ? "active" : "pending";
}

/** `text`, a retired SKILL.md or draft README.md, as the host leaves it when a person restores it: back in the status its
 *  retire recorded (retiredFrom), active, or waiting for its owner's OK. Throws on a text with no front matter. */
export const restoredLearned = (text: string): string => (retiredFrom(text) === "active" ? released(text) : held(released(text)));

/** What a SKILL.md or a draft's README.md says of itself: `pending` while it waits for its owner's OK, `retired` once a
 *  person retired it, else `active`. A run is given only an active one. */
export function learnedStatus(text: string): "active" | "pending" | "retired" {
  const front = frontOf(text);
  const status = typeof front === "string" ? undefined : front.value("status");
  return status === "pending" ? "pending" : status === "retired" ? "retired" : "active";
}

/** `text`, a SKILL.md or a draft's README.md, as a person's retire leaves it: `status: retired` and `retired_from`, the
 *  status it had (active, or pending while it waited for its owner's OK), last in its front matter (any such lines before
 *  them dropped), so no later run is given it and its restore gives that status back. Throws on a text with no front
 *  matter. */
export function retiredLearned(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") throw new Error(`it cannot be retired: ${front}`);
  const from = learnedStatus(text) === "pending" ? "pending" : "active";
  const kept = front.lf.slice(4, front.end).split("\n").filter((line) => !line.startsWith("status:") && !line.startsWith("retired_from:"));
  return `---\n${[...kept, "status: retired", `retired_from: ${from}`].join("\n")}${front.lf.slice(front.end)}`;
}

/** A draft's `README.md` as the host writes it, from the workflow's name and the one-line description its block gives. */
export const readmeOf = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n`;

/** A workflow block's two files: its `description:` front matter written as the draft's README.md (readmeOf), and the
 *  JSON after it as its workflow.json. A block with no front matter, or none that says what the draft is for, gives a
 *  README with no description, which the checker refuses; what the JSON holds is the checker's to judge. */
export function draftFiles(name: string, block: string): { json: string; readme: string } {
  const front = frontOf(block);
  if (typeof front === "string") return { json: block, readme: readmeOf(name, "") };
  const description = (front.value("description") ?? "").replace(/\s+/g, " ").trim();
  return { json: front.lf.slice(front.end + "\n---\n".length), readme: readmeOf(name, description) };
}

/** The refusal for a draft that names a tool when the host gave no tool list: the check fails closed. */
export const NO_TOOL_LIST = "no tool list was given, so a draft that names a tool is refused";

export type DraftProblem = { readonly rule: "workflow" | "no_tool_list" | "executable_node"; readonly detail: string };
/** What a draft is read with: the workflow DSL's own validation and inspection. The caller loads the DSL (`await
 *  import("@parcha/agentrun-dsl")`), which the server only ever loads when it needs it, and hands it here. */
export type DraftReader = { readonly validateWorkflow: typeof validateWorkflow; readonly inspectWorkflow: typeof inspectWorkflow; readonly desugarWorkflow: typeof desugarWorkflow; readonly assertWorkflowCapabilities: typeof assertWorkflowCapabilities };

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
    out = [...toolingNodes(dsl, doc), ...executableNodes(dsl, doc), ...unrunnableNodes(dsl, doc), ...longNodes(dsl, doc), ...gatedNodes(dsl, doc, gated, deniedBy)];
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
