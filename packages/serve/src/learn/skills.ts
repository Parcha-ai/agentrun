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

/** Where a SKILL.md's or a draft README's front matter closes in `lf` (its text with LF line ends): the index of the
 *  `\n` before its closing `---` line, the last line or not; -1 when it has none. */
const closeOf = (lf: string): number => {
  const close = /\n---(?:\n|$)/.exec(lf.slice(3));
  return close ? 3 + close.index : -1;
};

/** YAML's double-quoted escapes, each to what it reads as (`\\x`, `\\u` and `\\U` take hex digits apart). */
const ESCAPES: Readonly<Record<string, string>> = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029" };

/** A scalar's value as YAML reads it: a double-quoted one with its escapes decoded (JSON's, which servedSkill writes,
 *  and YAML's own), a single-quoted one with each `''` one `'`, a plain one as it is. So reading what servedSkill wrote
 *  gives back the very value it quoted, and serving a skill again writes the same text (OpenCode serves a laid skill
 *  again): never an escape quoted twice. Undefined, never a throw, for a double-quoted value with an escape that does
 *  not decode cleanly (one YAML has not, a code point past U+10FFFF, a `\\` that ends it): what another reader makes of
 *  it is not known, so its front matter reads no way. The decoded value is the one every check reads (frontValues). */
function unquote(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  let clean = true;
  const decoded = value.slice(1, -1).replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S]?)/g, (whole, code: string) => {
    if (code.length > 1) {
      const point = Number.parseInt(code.slice(1), 16);
      if (point > 0x10ffff) return (clean = false), whole;
      return String.fromCodePoint(point);
    }
    const one = ESCAPES[code];
    if (one === undefined) clean = false;
    return one ?? whole;
  });
  return clean ? decoded : undefined;
}

/** A SKILL.md's or a draft README's front matter, as the host edits it: its lines, where it closes (closeOf, in `lf`,
 *  the text with LF line ends) and each key's value, a folded or literal block value read as one line. A string is why
 *  there is none. What it says of itself (its keys, its status) is frontMatter's to read, never this. */
function frontOf(text: string): { lf: string; end: number; value: (key: string) => string | undefined } | string {
  const lf = text.replace(/\r\n/g, "\n");
  if (!lf.startsWith("---\n")) return "it does not start with front matter";
  const end = closeOf(lf);
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
    return unquote(own)?.trim();
  };
  return { lf, end, value };
}

/** Why a front matter does not read one way, by frontMatter: the words a refusal says. */
export const UNCLEAR_FRONT = "its front matter does not read one way: each line a `key: value` at its left edge, a comment, or a line of the value above it";

/** A SKILL.md's or a draft README's front matter, read one way, as the one reader of what it says of itself (its keys,
 *  its name, its description, its status): each key to its value in order, or undefined when it does not read one way,
 *  since another reader (a harness's YAML) could then read a key, a status among them, this one does not. It reads one
 *  way when it starts the text (`---`), closes on a `---` line (the last line or not), and each line between is blank,
 *  a comment at its left edge, `key: value` at its left edge (a key set once), or a line of the value above it: any
 *  indented line under a `key:` with nothing after it (its nested value, a mapping or a list among them), an indented
 *  line of a `>` or `|` block, or of a plain value that wraps (one that reads as no key of its own), an indented comment
 *  under a plain value being no part of it. A quoted value is read as YAML reads it (unquote: its escapes decoded); a
 *  nested, block or wrapped value's lines are joined by one space. Anything else (an indented first line, an indented
 *  `key:` under a value, a list at the left edge, a key set twice, a YAML explicit key `? key`, which every writer here
 *  would have to edit in its own form) reads no way. */
export function frontMatter(text: string): ReadonlyMap<string, string> | undefined {
  const lf = text.replace(/\r\n/g, "\n");
  if (!lf.startsWith("---\n")) return undefined;
  const end = closeOf(lf);
  if (end < 0) return undefined;
  const front = new Map<string, string>();
  const add = (key: string, more: string) => front.set(key, `${front.get(key)} ${more.trim()}`.trim());
  // The key whose `>`/`|` block, or nested value (a `key:` with nothing after it), the next indented lines are; the key
  // whose plain value they wrap; a quoted value still open, its lines so far (quotedValue folds them).
  let block: string | undefined;
  let plain: string | undefined;
  let quoting: { key: string; lines: string[] } | undefined;
  for (const line of lf.slice(4, end).split("\n")) {
    const indented = /^\s+\S/.test(line);
    if (quoting) {
      // A quoted value's next line: indented, or blank (a line break of its own); one at the left edge reads no way.
      if (line.trim() !== "" && !indented) return undefined;
      quoting.lines.push(line);
      if (!closedQuote(quoting.lines.map((one) => one.trim()).join(" "))) continue;
      const read = unquote(foldQuoted(quoting.lines));
      if (read === undefined) return undefined;
      front.set(quoting.key, read);
      quoting = undefined;
      continue;
    }
    if (block !== undefined && (indented || line.trim() === "")) {
      if (line.trim()) add(block, line);
      continue;
    }
    block = undefined;
    if (line.trim() === "" || line.startsWith("#")) continue;
    // An indented comment under a plain value is no part of it, and the value may wrap on after it.
    if (indented && plain !== undefined && /^\s+#/.test(line)) continue;
    if (indented) {
      // A wrapped plain value's line, never one that reads as a key, a list item or a comment of its own.
      if (plain === undefined || /^\s+(?:#|-\s|\?\s|[^\s]*:(?:\s|$))/.test(line) || /:\s/.test(line)) return undefined;
      add(plain, line);
      continue;
    }
    plain = undefined;
    const pair = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!pair || front.has(pair[1]!)) return undefined;
    const value = (pair[2] ?? "").trim();
    if (!value || /^[>|][-+]?$/.test(value)) {
      block = pair[1]!;
      front.set(block, "");
    } else if (/^["']/.test(value) && !closedQuote(value)) {
      // A quoted value that runs on past its line: read once it closes, its lines folded as YAML folds them.
      quoting = { key: pair[1]!, lines: [value] };
    } else {
      // A quoted value whose escapes do not decode cleanly reads no way.
      const read = unquote(value);
      if (read === undefined) return undefined;
      front.set(pair[1]!, read);
      if (!/^["']/.test(value)) plain = pair[1]!;
    }
  }
  // A quoted value never closed reads no way.
  return quoting ? undefined : front;
}

/** Whether `value`, a quoted scalar's text from its opening quote, closes: it ends with its quote, a double quote not
 *  escaped (an even run of backslashes before it), a single quote not one of a doubled pair (`''`, an odd run). */
function closedQuote(value: string): boolean {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2 || !value.endsWith(quote)) return false;
  const inner = value.slice(1);
  if (quote === '"') return (/(\\*)"$/.exec(inner)![1]!.length % 2) === 0;
  return (/('+)$/.exec(inner)![1]!.length % 2) === 1;
}

/** A quoted scalar's `lines` (its first, from the opening quote, then the next ones as written) as one, folded as YAML
 *  folds a flow scalar: each line's surrounding white space dropped, each line break one space, each blank line a line
 *  break, and in a double-quoted one a break after a `\` none at all. unquote reads the result. */
function foldQuoted(lines: readonly string[]): string {
  let out = lines[0]!.trimEnd();
  let blanks = 0;
  for (const line of lines.slice(1)) {
    const part = line.trim();
    if (part === "") {
      blanks += 1;
      continue;
    }
    if (blanks) out += "\n".repeat(blanks);
    else if (out.startsWith('"') && /(?<!\\)(\\\\)*\\$/.test(out)) out = out.slice(0, -1);
    else out += " ";
    out += part;
    blanks = 0;
  }
  return out;
}

/** Every value a SKILL.md's or a draft README's front matter holds, as YAML reads it (frontMatter: escapes decoded):
 *  what a check for secrets reads beside the text as stored, since the decoded value is the one a harness is served
 *  (servedSkill). None for a text whose front matter does not read one way. */
export function frontValues(text: string): string[] {
  return [...(frontMatter(text)?.values() ?? [])];
}

/** The keys a SKILL.md's or a draft README's front matter sets, in order (frontMatter's); undefined for a text whose
 *  front matter does not read one way. */
export function frontKeys(text: string): string[] | undefined {
  const front = frontMatter(text);
  return front ? [...front.keys()] : undefined;
}

/** The front matter keys a learned skill or draft README may hold: what a skill is (its name and when to use it). Claude
 *  Code reads directives from more (hooks, allowed-tools, context, agent, model, ...): a hook is a shell command its CLI
 *  runs. `status` is the host's (a held one). */
export const LEARNED_KEYS: readonly string[] = ["name", "description"];

/** `text`, a learned skill's SKILL.md, as a run is given it: front matter with its name and its description alone, as
 *  the one reader reads them (frontMatter), each quoted as JSON writes it, which every YAML reads back as that very
 *  string (never null, a boolean, a number or a date), written again whatever else its file holds (servedSkill is the
 *  one door a learned skill reaches a harness by), then its body as it is. A text with no front matter, or one whose front
 *  matter reads no way, is as it is: never served with its fields emptied. A learned one of those is never active, so
 *  never given; a revision's own is the harness's to check, as its author wrote it. */
export function servedSkill(text: string): string {
  const opened = frontOf(text);
  if (typeof opened === "string") return text;
  const front = frontMatter(text);
  if (!front) return text;
  const lines = [`name: ${JSON.stringify(front.get("name") ?? "")}`, `description: ${JSON.stringify(front.get("description") ?? "")}`];
  return `---\n${lines.join("\n")}\n---\n${opened.lf.slice(opened.end + 5)}`;
}

/** Why a `SKILL.md` for the skill `name`, or a draft's `README.md` for the workflow `name`, is out of shape; empty when
 *  it is not. Its front matter names the folder's name and a description. */
export function skillProblems(text: string, name: string): string[] {
  const opened = frontOf(text);
  if (typeof opened === "string") return [opened];
  const front = frontMatter(text);
  if (!front) return [UNCLEAR_FRONT];
  const out: string[] = [];
  if (front.get("name") !== name) out.push(`name is not the folder's name, ${name}`);
  if (!front.get("description")) out.push("description is missing or empty");
  return out;
}

/** A SKILL.md's or a draft README's front matter as a reader shows it (frontMatter): its name, description and status,
 *  each absent when it is not there; undefined for a text whose front matter does not read one way. */
export function learnedFront(text: string): { name?: string; description?: string; status?: string } | undefined {
  const front = frontMatter(text);
  if (!front) return undefined;
  const [name, description, status] = ["name", "description", "status"].map((key) => front.get(key));
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), ...(status === undefined ? {} : { status }) };
}

/** Whether a SKILL.md or a draft's README.md sets `status`, which only the host does (`held`) (frontMatter). */
export const setsStatus = (text: string): boolean => frontMatter(text)?.has("status") ?? false;

/** A skill or a draft the grader held for its owner's OK: its SKILL.md, or its draft's README.md, says `status:
 *  pending` (learnedStatus). No run is given a held skill or workflow until a person approves it. */
export const isHeld = (text: string): boolean => learnedStatus(text) === "pending";

/** Whether `text`'s status, when it sets one, is one plain line, `status: <value>` with nothing of it on the lines after
 *  (no quoted value that runs on, no block, no wrapped line): the only status the host's writers (released,
 *  retiredLearned), which take the `status:` line out whole, can edit. One set any other way reads unclear (learnedStatus:
 *  retired), never held or active, and no writer edits it, so a write never leaves part of it behind. The host writes
 *  only one-line statuses (held, retiredLearned). */
export function statusOnOneLine(text: string): boolean {
  const front = frontMatter(text);
  if (!front?.has("status")) return true;
  const lf = text.replace(/\r\n/g, "\n");
  const own = lf.slice(4, closeOf(lf)).split("\n").find((line) => line.startsWith("status:"))?.slice("status:".length).trim() ?? "";
  if (!own || /^[>|]/.test(own) || (/^["']/.test(own) && !closedQuote(own))) return false;
  // A plain value that wraps onto the next lines reads longer than its own line.
  return unquote(own) === front.get("status");
}

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
  if (!statusOnOneLine(text)) throw new Error("it cannot be approved: its status is not one plain line");
  const kept = front.lf.slice(4, front.end).split("\n").filter((line) => !line.startsWith("status:"));
  const out = `---\n${kept.join("\n")}${front.lf.slice(front.end)}`;
  // What it leaves reads back active, or the approve fails: never an OK over a skill no run is given.
  if (learnedStatus(out) !== "active") throw new Error(`it cannot be approved: its status would read ${learnedStatus(out)}`);
  return out;
}

/** What a SKILL.md or a draft's README.md says of itself, the one reader of it (frontMatter), the server's and, through
 *  the folder's snapshot, the console's: `pending` while it waits for its owner's OK, `retired` once a person retired
 *  it, `active` when it sets no status or `active`. A front matter that does not read one way, or a status that is none
 *  of these, is `retired`: never active, since another reader could read it as held or retired; no run is given it, and
 *  a restore refuses it until it reads one way. A run is given only an active one. */
export function learnedStatus(text: string): "active" | "pending" | "retired" {
  const front = frontMatter(text);
  if (!front) return "retired";
  if (!statusOnOneLine(text)) return "retired";
  const status = front.get("status") ?? "active";
  return status === "active" || status === "pending" ? status : "retired";
}

/** `text`, a SKILL.md or a draft's README.md, as a person's retire leaves it: `status: retired` last in its front matter
 *  (any status line before it dropped), so no later run is given it. Throws on a text with no front matter. */
export function retiredLearned(text: string): string {
  const front = frontOf(text);
  if (typeof front === "string") throw new Error(`it cannot be retired: ${front}`);
  if (!statusOnOneLine(text)) throw new Error("it cannot be retired: its status is not one plain line");
  const kept = front.lf.slice(4, front.end).split("\n").filter((line) => !line.startsWith("status:"));
  const out = `---\n${[...kept, "status: retired"].join("\n")}${front.lf.slice(front.end)}`;
  if (!frontMatter(out) || learnedStatus(out) !== "retired") throw new Error("it cannot be retired: its front matter would not read retired");
  return out;
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
