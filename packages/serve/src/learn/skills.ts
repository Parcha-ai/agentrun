// What a run may propose beside its notes: one skill, `skills/<name>/SKILL.md`, and workflow drafts,
// `workflows/<name>/workflow.json` with its `README.md`. Their places in the learning folder and the shape each file must
// have. check.ts checks them; nothing here reads a file, runs a draft or calls a model.
import type { inspectWorkflow, validateWorkflow, Workflow } from "@parcha/agentrun-dsl";

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
    return (/^[>|][-+]?$/.test(own) ? more.join(" ") : own).replace(/^(["'])(.*)\1$/, "$2").trim();
  };
  return { lf, end, value };
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
export type DraftReader = { readonly validateWorkflow: typeof validateWorkflow; readonly inspectWorkflow: typeof inspectWorkflow };

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

const issuesOf = (dsl: DraftReader, doc: unknown, tools?: readonly string[]) => {
  const valid = dsl.validateWorkflow(doc as Workflow, { executeCode: false, ...(tools ? { tools } : {}) });
  return valid.ok ? [] : valid.issues;
};

/** Why `workflows/<name>/workflow.json` is not a draft the host can run; empty when it is. The DSL's own
 *  `validateWorkflow` judges it, with `executeCode: false` so no code it holds is run (a code node is syntax-checked),
 *  and with `tools`, so a node that names a tool outside them is its error: a harness's own tool (Bash, exec_command,
 *  apply_patch) is never on the list. With no list it fails closed: a draft the DSL refuses only once given an empty
 *  list names a tool. */
export function draftProblems(dsl: DraftReader, text: string, tools?: readonly string[]): DraftProblem[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ rule: "workflow", detail: "it does not parse as JSON" }];
  }
  const issues = issuesOf(dsl, doc, tools);
  if (issues.length) return issues.slice(0, 5).map((issue) => ({ rule: "workflow", detail: `the workflow DSL refuses it: ${issue.code} at ${issue.path || "/"}: ${issue.message.slice(0, 200)}` }));
  let out: DraftProblem[];
  try {
    out = executableNodes(dsl, doc);
  } catch (error) {
    // The inspection reads the whole document, as validation need not: what it cannot read is refused, never passed.
    return [{ rule: "workflow", detail: `the workflow DSL cannot inspect it: ${(error as Error).message.slice(0, 200)}` }];
  }
  if (!tools && issuesOf(dsl, doc, []).length) out.push({ rule: "no_tool_list", detail: NO_TOOL_LIST });
  return out;
}
