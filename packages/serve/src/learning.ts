// Learning: an agent whose definition says `learning: true` keeps a folder of what it learned, and each of its runs
// starts from it. The folder is its home's `learning/` (files.ts homeOf), in Claude Code's auto-memory format
// (learn/notes.ts): `MEMORY.md`, the index, one line per active note, and one `<slug>.md` per note. It is plain
// git with main checked out, so any reader sees its files. This server is its only writer. Every git call runs with the
// repository's hooks, fsmonitor, replace refs and lazy fetches off and reads no system or global config, and every call
// on one agent's folder waits its turn in that agent's queue in this process.
//
// When a run of such an agent is made the server makes the folder if it is absent (one host commit on main, holding an
// empty `MEMORY.md`), resolves main's commit and reads it with plumbing, never the working tree. It copies that commit's
// index and active notes into the run's `work/.learning/` and pins the commit in the run's directory (`learning.json`),
// with what the run reads under `# Learned` (learnedOf): each active note whole while they fit the server's learning
// budget, else the index and the notes changed last, whole, while they fit; every text cut of the server's secrets, the
// copy's too. The run's process reads that pin (withLearned, for app.ts) and never runs git, so it may run anywhere its
// directory is. When the run ends the server asks it one more turn, which answers with the notes
// it would keep (learning-run.ts). As the run settles, before anything can open it again, that answer is kept in the
// run's directory (`learning-turn.json`); its notes are checked from there (propose.ts), graded and merged into main
// (grade.ts). The copy in the run's work is only for reading: nothing the run writes there is ever kept.
//
// The skills the agent wrote are in the folder too, one folder each under `skills/` (SKILLS_DIR). A run
// gets those of its commit beside its revision's own, in `work/.agents/skills/`, read with plumbing as its notes are: a
// skill named like one of the revision's is the revision's, and the learned ones fit their own budget
// (LEARNED_SKILLS_BUDGET) within what the revision's leave of the adapters' cap on a run's skills, so they never push the
// revision's out of a harness's own loading (skills.ts splitSkills). One that does not fit is left out, and the pin
// names it. A link at `skills/` or anywhere under it is never followed: the run starts with nothing learned.
//
// The host never follows a symbolic link into the folder (agentFolder): a link at the agent's home, at its `learning/`
// or at `learning/.git`, or a `MEMORY.md` that is one when the host writes it, is refused, and the run starts with
// nothing learned. The end-of-run turn's seed, its proposal's check, its grade and its merge reach the folder the same
// way, and a link there drops what the run learned. A person's reads and writes (learning-routes.ts) check it the same
// way (readFolder, agentFolder), and a link there is an error.
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { SKILL_BYTES } from "@parcha/agentrun-kernel";
import { INDEX_FILE, type LearnedNote, loadedIndex, NOTE_FILE, parseNoteFile, type Problem, redactSecrets, secretShapes, servedSkill, SKILLS_DIR, valueMatcher, type Verdict, WORKFLOW_NAME, WORKFLOWS_DIR } from "./learn/index.js";
import { homeOf, serialBy, writeDurable } from "./files.js";
import { DETAIL_MAX, LIST_DETAIL, short, wordsOf } from "./learning-words.js";
import { isObject } from "./validate.js";
import { readWorkText } from "./workspace.js";

/** The server's learning switch (`--learning`, AGENTRUN_SERVE_LEARNING; capabilities.features.learning). `on`, the
 *  default: a run learns when its agent's definition says `learning: true`. `off`: no run this server starts does. */
export const LEARNING_MODES = ["on", "off"] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];
export const LEARNING_ENV = "AGENTRUN_SERVE_LEARNING";
/** The switch: `given`, else AGENTRUN_SERVE_LEARNING, else on. Any other value is an error, and the server does not start. */
export function learningOf(env: NodeJS.ProcessEnv, given?: string): LearningMode {
  const value = given ?? (env[LEARNING_ENV] || "on");
  if (!(LEARNING_MODES as readonly string[]).includes(value)) throw new Error(`learning is on or off (--learning, ${LEARNING_ENV}), not ${value}`);
  return value as LearningMode;
}

/** How much of what a run learned its instructions hold under `# Learned` by default, in UTF-8 bytes (learnedOf): its
 *  notes whole while they fit, else the index and the notes changed last, whole, while they fit. */
export const LEARNING_BUDGET = 8000;
export const LEARNING_BUDGET_ENV = "AGENTRUN_SERVE_LEARNING_BUDGET";
/** The learning budget: `given` (`--learning-budget`), else AGENTRUN_SERVE_LEARNING_BUDGET, else LEARNING_BUDGET. Any
 *  value that is not a whole number of bytes, 0 or more, is an error, and the server does not start. */
export function learningBudgetOf(env: NodeJS.ProcessEnv, given?: number): number {
  const named = env[LEARNING_BUDGET_ENV];
  const value = given ?? (named ? (/^\d+$/.test(named) ? Number(named) : Number.NaN) : LEARNING_BUDGET);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`the learning budget is a whole number of bytes, 0 or more (--learning-budget, ${LEARNING_BUDGET_ENV}), not ${given ?? named}`);
  return value;
}

/** Where a run's learning stands (its `learning`, runs.ts): `seeded` once it starts from what its agent learned,
 *  `reflecting` while its end-of-run turn runs and until what it answered is checked, `proposed` once that passed the
 *  checks and is kept in the run's directory (propose.ts), `merged` once it is on main (grade.ts), or `dropped` with a
 *  reason from the closed list. A learning fault never refuses a run: it starts with nothing learned, `seed_failed`. */
export const LEARNING_STATES = ["seeded", "reflecting", "proposed", "merged", "dropped"] as const;
export const LEARNING_REASONS = ["seed_failed", "no_budget", "unknown_cost", "no_write_tool", "tool_denied", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "empty", "unparsed", "propose_failed", "checker", "screen", "screen_down", "grader", "grade_failed"] as const;
/** The reasons only an older server gave (an agent with no write tool, or a tool gate denying it, from before the
 *  end-of-run turn answered with its notes): still read, from a run's serve.json and the ledger, and counted; never
 *  given now. */
export const LEGACY_LEARNING_REASONS: readonly LearningReason[] = ["no_write_tool", "tool_denied"];
export type LearningState = (typeof LEARNING_STATES)[number];
export type LearningReason = (typeof LEARNING_REASONS)[number];
/** Tokens by the platform's names, as a run's metrics and /v2/stats count them: `input` is the input neither read from
 *  nor written to the cache. */
export type Tokens = { input: number; cache_read: number; cache_write: number; output: number };
export const NO_TOKENS: Tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
/** The variable that names the grader's model, as `--grade-model` does. */
export const GRADE_MODEL_ENV = "AGENTRUN_SERVE_GRADE_MODEL";
/** The model this server grades on, by name: `given` (`--grade-model`), else GRADE_MODEL_ENV, else its strong tier
 *  (AGENT_MODEL_STRONG); undefined when it names none, and each run is graded on its agent's own model (grade.ts). A
 *  name is a model as the strong tier takes one: sent as it is to a gateway, a provider/model-id otherwise. */
export const gradeModelOf = (env: NodeJS.ProcessEnv, given?: string): string | undefined => given || env[GRADE_MODEL_ENV] || env.AGENT_MODEL_STRONG || undefined;
/** A note a run read from its copy of the folder (`used`), by its file and its front matter's name. */
export type NoteUsed = { file: string; name: string };
/** A note a run's learning added to the folder (`learned`): its file, its name, and the notes it superseded. */
export type NoteLearned = NoteUsed & { supersedes: string[] };
/** A run's learning as serve.json keeps it. Past the view's four fields: the checker's `problems` (printable), the
 *  grader's `verdict` and the blob of each note it read superseded (`graded`, by file), both kept before the merge, the
 *  merge commit, and what the grade cost (null when unknown, never 0), which is in no run's totals; the notes the run
 *  read from `.learning/` (`used`, found in its rows as it settles), and once merged the notes it added (`learned`);
 *  and how many notes it started from (`seed_notes`). Names are kept as written, and cut of the host's secrets as they
 *  leave. */
export type Learning = {
  state: LearningState; reason: LearningReason | null; detail: string | null; at: string;
  problems?: Problem[]; verdict?: Verdict; graded?: Record<string, string>; merged?: string; cost_usd?: { grade: number | null }; tokens?: { grade: Tokens | null };
  used?: NoteUsed[]; learned?: NoteLearned[];
  /** How many active notes the run started from: its seed's, set as it is seeded (none for a seed that failed). */
  seed_notes?: number;
  /** Once it asked its end-of-run turn: when its job's answer was final (before it looked back), and what the run had
   *  cost by then (null when unknown); once that turn ended, what the turn itself cost (null when unknown). */
  answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null;
  /** A merge's notes that wait for a person's OK (`status: pending` on main): in no index, and no run reads them until
   *  approved. */
  pending?: { file: string; name: string }[];
  /** A merge's skill and workflow draft, by name and the path of its SKILL.md or workflow.json; `pending` when it waits
   *  for a person's OK (`status: pending` in its SKILL.md or README.md), and no run is given it until approved. */
  skills?: LearnedFile[];
  workflows?: LearnedFile[];
};
/** A skill or a workflow draft a merge added or changed. */
export type LearnedFile = { file: string; name: string; pending?: true };
/** What a run's learning keeps whatever its learning does after: what it read, how many notes it started from, and its
 *  answer's time and its costs (learning-run.ts setLearning). */
export const KEPT_LEARNING = ["used", "seed_notes", "answered_at", "job_cost_usd", "look_back_usd"] as const;

/** What a text or a name that leaves shows of the host's secrets now: none (secretsShown). */
export type Shown = { text: (text: string) => string; name: (name: string) => string; holds: (text: string) => boolean };
/** What a name holding a secret reads: learn/secrets.ts redactSecrets' mark, the name's whole, never a part of it. */
const REDACTED = "[redacted]";
/** The host's secrets as a reader cuts them: a text holding a value or a shape is cut of it (whole when long:
 *  learn/secrets.ts redactSecrets), and a file's name holding one reads REDACTED whole, not a name of the folder's (its
 *  route still answers the real name, to a caller who knows it); any other text or name is shown as it is. */
export function secretsShown(values: readonly string[]): Shown {
  const matches = valueMatcher(values);
  const holds = (text: string) => matches(text) || secretShapes(text).length > 0;
  return { holds, text: (text) => (holds(text) ? redactSecrets(text, values) : text), name: (name) => (holds(name) ? REDACTED : name) };
}

const isText = (value: unknown): value is string => typeof value === "string";
/** The notes a run read and learned, as a view or a list shows them, each name cut of the host's secrets (`shown`):
 *  `used` once the run settled, `learned` and `pending` (what waits for the owner's OK) once it merged, and the skill
 *  and the workflow draft it merged (`skills`, `workflows`, each `pending` while it waits), each only when it holds one.
 *  serve.json's are read as untrusted: an entry out of shape is left out. */
export function notesView({ state, used, learned, pending, skills, workflows }: Learning, shown: Shown, settled: boolean): { used?: NoteUsed[]; learned?: NoteLearned[]; pending?: NoteUsed[]; skills?: LearnedFile[]; workflows?: LearnedFile[] } {
  const read = settled && Array.isArray(used) ? used.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : [];
  const added = state === "merged" && Array.isArray(learned) ? learned.filter((note) => isText(note?.file) && isText(note.name) && Array.isArray(note.supersedes) && note.supersedes.every(isText)).map(({ file, name, supersedes }) => ({ file: shown.name(file), name: shown.text(name), supersedes: supersedes.map(shown.name) })) : [];
  const waiting = state === "merged" && Array.isArray(pending) ? pending.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : [];
  const files = (list: LearnedFile[] | undefined) => (state === "merged" && Array.isArray(list) ? list.filter((item) => isText(item?.file) && isText(item.name)).map(({ file, name, pending: waits }) => ({ file: shown.name(file), name: shown.name(name), ...(waits === true ? { pending: true as const } : {}) })) : []);
  const [kept, drafts] = [files(skills), files(workflows)];
  return { ...(read.length ? { used: read } : {}), ...(added.length ? { learned: added } : {}), ...(waiting.length ? { pending: waiting } : {}), ...(kept.length ? { skills: kept } : {}), ...(drafts.length ? { workflows: drafts } : {}) };
}
/** A run's learning in a person's words as a read shows them (learning-words.ts wordsOf): each part cut of the host's
 *  secrets as they are now (`shown`) first, then the words cut short to `max`, so a secret is never shown in part. */
export const detailShown = (learning: Learning, shown: Shown, max = DETAIL_MAX): string | null => {
  const words = wordsOf(learning, shown.text);
  return words === null ? null : short(words, max);
};
/** A run's learning as its view shows it: the state, why in a person's words (detailShown), and when, and the notes it
 *  read, learned and holds for the owner's OK (notesView). */
export const learningView = (learning: Learning, shown: Shown, settled: boolean) => {
  const { state, reason, at } = learning;
  return { state, reason, detail: detailShown(learning, shown), at, ...notesView(learning, shown, settled) };
};
/** A run's learning as a list shows it: its state and reason, its detail cut of the host's secrets and then short (at
 *  most LIST_DETAIL characters, so a secret is never cut in half and shown), and the notes it read and learned
 *  (notesView); never its time. */
export const shortLearning = (learning: Learning | null, shown: Shown, settled: boolean) => (learning ? shortOf(learningView(learning, shown, settled)) : null);
/** A run's learning as its view shows it, in short for a list: all of it but its time, its detail cut short. */
export function shortOf<T extends { state: LearningState; reason: LearningReason | null; detail: string | null; at: string }>({ state, reason, detail, at: _, ...notes }: T) {
  return { state, reason, detail: detail === null ? null : short(detail, LIST_DETAIL), ...notes };
}
/** The label of the end-of-run turn's timeline rows, and the kind and label of a run's learning row. */
export const LEARNING_LABEL = "learning";

/** A run's proposal, in its directory (propose.ts): the seed it was checked against, each new note's file and text, its
 *  skill's and workflow draft's files by path and text (`files`: a SKILL.md, a workflow.json and its README.md; absent
 *  when it gives none), and what the user said in the run as the grader reads it (each message cut of the host's
 *  secrets, then shortened to GRADE_CAPS.askedMessage; absent in a proposal kept before the grader read them). */
export const PROPOSAL = "learning-proposal.json";
export type Proposal = { seed: string; notes: { file: string; text: string }[]; files?: { file: string; text: string }[]; asked?: string[] };

/** A run's pin, in its directory: written once, when the run is made, and never changed by a resume. */
export const LEARNING_PIN = "learning.json";
/** Where a run finds its agent's notes: in its work, a copy the run may read and nothing reads back. */
export const LEARNED_DIR = ".learning";
/** What the run's end-of-run turn answered, and what the user said in the run, kept in the run's directory as the run
 *  settles (learning-run.ts beforeSettle), where the host alone reads it: what propose.ts checks. */
export const LEARNING_TURN = "learning-turn.json";
export type Turn = { answer: string; asked: string[] };
/** What a run's pin holds: the commit of main it was seeded from, and what it reads under `# Learned` (learnedOf), when
 *  it learned anything. `learned`, the index alone, is a pin an earlier server wrote, read as that server gave it.
 *  `skills`: the files of the learned skills laid in its work, by their paths under `.agents/skills/`, as a revision
 *  names its own; `skills_left_out`: the learned skills it does not get, over their budget or holding a secret.
 *  `workflows`: the names of the learned workflows the run may run (its `learned_workflow` tool), each written whole in
 *  LEARNED_WORKFLOWS_FILE in the run's directory, outside its work; `workflows_left_out`: the learned workflows it does
 *  not get, their lines over what is left of the tool's description budget (LEARNED_WORKFLOWS_BUDGET), or holding a
 *  secret, or every one when `workflows_off` says why the run is offered none (its harness's requests go where a learned
 *  workflow's could not follow: learnedWorkflowsOff). */
export type Pin = { seed: string; section?: string; learned?: string; skills?: string[]; skills_left_out?: string[]; workflows?: string[]; workflows_left_out?: string[]; workflows_off?: string };
/** What a run is seeded from: main's commit, its index and its active notes by file, and the name of every entry at its
 *  top. `skipped` names what was there and not read. `recent`, when seedOf read it: the active notes' files, the one
 *  changed last on main first. `skills`, when seedOf read them: the skills the agent wrote, the one changed last on main
 *  first. */
export type Seed = { sha: string; index?: string; notes: Record<string, string>; files: string[]; skipped: string[]; recent?: string[]; skills?: LearnedSkill[]; workflows?: LearnedWorkflow[] };
/** A workflow the agent learned, as a run may run it: its name, the line its README says what it does with, and its
 *  workflow.json whole. */
export type LearnedWorkflow = { name: string; description: string; workflow: string };
/** Where a run keeps the learned workflows its pin names, whole: in the run's directory, beside its pin, never in its
 *  work, so nothing the run does changes what its `learned_workflow` tool runs. */
export const LEARNED_WORKFLOWS_FILE = "learned-workflows.json";
/** The most bytes the `learned_workflow` tool's description gives its workflows, each one's line (workflowLine)
 *  together: every harness sends the description with each request, so it never grows with what an agent learned. */
export const LEARNED_WORKFLOWS_BUDGET = 8 * 1024;
/** A learned workflow's line in the `learned_workflow` tool's description: its name, and what its README says it does. */
export const workflowLine = ({ name, description, workflow }: Pick<LearnedWorkflow, "name" | "description"> & { workflow?: string }): string =>
  [`- ${name}: ${description || "(no description)"}`, ...inputLine(workflow)].join("\n");

/** The most of a field's description a workflow's input line carries. */
const FIELD_DESCRIPTION = 60;

/** A workflow's input as its line in learned_workflow's description says it: its input schema, compact (inputSchema), on
 *  a line of its own, so a call names the fields the workflow takes; none for a workflow whose input names no schema. */
function inputLine(workflow: string | undefined): string[] {
  let doc: { schemas?: Record<string, unknown>; input?: { schemaId?: unknown } } | undefined;
  try {
    doc = workflow ? JSON.parse(workflow) : undefined;
  } catch {
    return [];
  }
  const id = doc?.input?.schemaId;
  const schema = typeof id === "string" ? doc?.schemas?.[id] : undefined;
  if (!schema) return [];
  const shown = compactSchema(schema, doc?.schemas ?? {});
  return [`  input: ${shown}${shown.includes("*") ? " (* required)" : ""}`];
}

/** A JSON Schema in one line: an object's fields as `name type`, a required one marked `*`, each with its description cut
 *  short; an array as `array of <items>`; a reference to another of the workflow's schemas followed, two levels deep. */
function compactSchema(schema: unknown, schemas: Record<string, unknown>, depth = 0): string {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : undefined;
  if (!s) return "any";
  if (typeof s.$ref === "string") {
    const name = s.$ref.replace(/^#\/(?:schemas|definitions|\$defs)\//, "");
    return depth > 2 || !schemas[name] ? name : compactSchema(schemas[name], schemas, depth + 1);
  }
  if (s.properties && typeof s.properties === "object") {
    if (depth > 2) return "object";
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const fields = Object.entries(s.properties as Record<string, unknown>).map(([key, value]) => {
      const said = value && typeof value === "object" ? (value as Record<string, unknown>).description : undefined;
      const words = typeof said === "string" && said.trim() ? ` "${said.trim().length > FIELD_DESCRIPTION ? `${said.trim().slice(0, FIELD_DESCRIPTION - 1)}…` : said.trim()}"` : "";
      return `${key}${required.has(key) ? "*" : ""} ${compactSchema(value, schemas, depth + 1)}${words}`;
    });
    return `{${fields.join(", ")}}`;
  }
  if (s.type === "array") return `array of ${compactSchema(s.items, schemas, depth + 1)}`;
  if (Array.isArray(s.enum)) return s.enum.map((value) => JSON.stringify(value)).join("|");
  return typeof s.type === "string" ? s.type : Array.isArray(s.type) ? s.type.join("|") : "any";
}

/** The most bytes of learned skills one run gets, every file of each together. They get no more than what the
 *  revision's own skills leave of the adapters' cap on a run's skills in all (SKILL_BYTES): over that cap an adapter
 *  refuses the whole set, and every skill, the revision's too, would be inlined in the prompt (skills.ts splitSkills). */
export const LEARNED_SKILLS_BUDGET = 256 * 1024;
/** Where a run's harness finds its skills in its work: the revision's, and the learned ones laid beside them. */
const RUN_SKILLS = [".agents", "skills"] as const;
/** A learned skill's folder: the shared skills convention's name (lowercase letters, digits and single dashes). */
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A file's path inside a learned skill, as every adapter takes one (agentrun-kernel skillProblems). */
const SKILL_FILE_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/){0,4}[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** A skill the agent wrote, as a seed holds it: its name, its files' bytes together, and each file's text by its path
 *  inside the skill, read only when the skill could fit a run's budget at all. */
export type LearnedSkill = { name: string; bytes: number; files?: Record<string, string> };
/** The `status` a SKILL.md's front matter sets, quotes dropped, or undefined when it sets none. The host alone sets one
 *  (`status: pending` on a skill held for its owner's OK); the checker refuses a run's skill that does. */
const statusOf = (text: string | undefined): string | undefined => {
  const lf = (text ?? "").replace(/\r\n/g, "\n");
  const end = lf.startsWith("---\n") ? lf.indexOf("\n---\n", 3) : -1;
  const line = end < 0 ? undefined : lf.slice(4, end).split("\n").find((entry) => entry.startsWith("status:"));
  return line?.slice("status:".length).trim().replace(/^(["'])(.*)\1$/, "$2");
};

/** A file main holds over this is not read: a note is short, and the index is read only so far (loadedIndex). */
const FILE_CAP = 1 << 20;
const IDENTITY = { name: "agentrun-serve", email: "serve@agentrun.invalid" };
/** The floor of git this server's learning needs: the one the repository's other learning packages test on. Its own
 *  calls need 2.32 (GIT_CONFIG_GLOBAL). */
const MIN_GIT = [2, 40] as const;
/** How long one git call may take before it is killed: a hung call would hold its agent's queue. */
const GIT_TIMEOUT_MS = 60_000;

/** The agent's learning folder: its home's `learning/` entry, which only the host writes. The home is files.ts homeOf,
 *  the one definition the home's routes use too, so two ids that differ only in case never share a folder. */
export const learningRepo = (data: string, agentId: string): string => join(homeOf(data, agentId), "learning");

/** Makes `dir` where it is absent: a plain `mkdir`, never recursive (which would follow a link on the way). One that is
 *  there, whatever it is, is left for the check after. */
async function makeDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  await learningTestHooks.afterMkdir?.(dir);
}

/** Throws when `path` is a symbolic link or not a directory, by `lstat`, which never follows one. A missing one passes
 *  when `absent` says it may be. What it throws names `path` in the data directory, never where a link points. */
async function refuseLink(data: string, path: string, absent = false): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`${relative(data, path)} is a symbolic link, and the host never follows one into a learning folder`);
  if (!stats.isDirectory()) throw new Error(`${relative(data, path)} is not a directory`);
}

/** The agent's learning folder, each level checked by `lstat`: its home, its `learning/` and, once there, `.git`. None
 *  may be a symbolic link or anything but a directory, or the host's git would read from, and write to, where the link
 *  points. `make`: the home and the folder are made where absent first, one level at a time, each checked after it is
 *  made (agentFolder); without it nothing is made and a missing level passes (readFolder). The one link rule. */
async function checkedFolder(data: string, agentId: string, make: boolean): Promise<string> {
  const home = homeOf(data, agentId);
  const repo = learningRepo(data, agentId);
  if (make) await makeDir(dirname(home));
  for (const dir of [home, repo]) {
    if (make) await makeDir(dir);
    await refuseLink(data, dir, !make);
  }
  await refuseLink(data, join(repo, ".git"), true);
  return repo;
}

/** The agent's learning folder, its home and the folder made where absent (checkedFolder). A link swapped in for a part
 *  just made is caught by the check after. `<data>/homes` is the operator's, as the data directory is. Every write into
 *  the folder goes through it, in the agent's queue: before anything reads or makes the repository, and again once
 *  `git init` has made `.git`; before a run's end-of-run turn reads its seed again (seedAt), before its proposal is
 *  checked against it (propose.ts), before its grade reads main and its merge writes it (grade.ts), and before a
 *  person's edit, create or retire (learning-routes.ts). A refusal throws: a run about to start starts with nothing
 *  learned (seed_failed), a run that ended drops what it learned (reflect_failed, propose_failed or grade_failed), and
 *  a person's write is an error. */
export const agentFolder = (data: string, agentId: string): Promise<string> => checkedFolder(data, agentId, true);

/** The agent's learning folder for a person's read, outside the queue: the same check as agentFolder's, and nothing
 *  made. A link or a non-directory throws as it does there; a missing level passes, so a folder never made reads as
 *  empty (mainOf finds no main). */
export const readFolder = (data: string, agentId: string): Promise<string> => checkedFolder(data, agentId, false);

/** Before every command: a `-c` flag wins over the repository's own config. No hook or fsmonitor runs, no replace ref
 *  is read, a commit is never signed (which would run a program), and no transport runs, so nothing is fetched lazily.
 *  No optional lock is taken (GIT_OPTIONAL_LOCKS), so a read never writes. */
const SAFE = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "protocol.allow=never"];

/** Every call's environment, built from nothing: no system or global config (so no template or hooks folder named
 *  there), no HOME, no prompt, the host's identity, and the repository named outright, never looked for. */
const gitEnv = (gitDir: string | undefined): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  ...(gitDir ? { GIT_DIR: gitDir } : {}),
});

/** One git call on `repo` (none for `init`), from `cwd`: its stdout, or a rejection naming the command and its stderr.
 *  `env` adds to the call's environment (a temporary index, a work tree named outright). */
export function git(cwd: string, repo: string | undefined, args: readonly string[], input: string | Uint8Array = "", env: NodeJS.ProcessEnv = {}): Promise<Buffer> {
  learningTestHooks.git?.(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE, ...args], { cwd, env: { ...gitEnv(repo && join(repo, ".git")), ...env }, stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new Error(`git ${args[0]} failed (${signal ?? code}): ${Buffer.concat(err).toString("utf8").trim().slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}

export const line = (out: Buffer): string => out.toString("utf8").trim();

const gitChecks = new Map<string, Promise<string | undefined>>();

/** Why this host keeps no learning folder, or undefined when it can: git MIN_GIT or later on `env`'s PATH. */
export function learningBlocker(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const key = env.PATH ?? "";
  let check = gitChecks.get(key);
  if (!check) {
    const floor = MIN_GIT.join(".");
    check = new Promise<string | undefined>((resolve) => {
      const child = spawn("git", ["--version"], { env: { PATH: key }, stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.once("error", () => resolve(`learning needs git ${floor} or later on PATH, and this host has none`));
      child.once("close", (code) => {
        const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number);
        if (code !== 0) resolve(`learning needs git ${floor} or later on PATH, and this host has none`);
        else resolve(major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]) ? undefined : `learning needs git ${floor} or later, and this host has ${out.trim()}`);
      });
    });
    gitChecks.set(key, check);
  }
  return check;
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `work` once every call queued before it on the agent's folder has finished: one at a time per agent, in this
 *  process. Everything that touches an agent's folder goes through it, so two runs made at once never both make it. */
export const withAgentRepo = <T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> => queued(learningRepo(data, agentId), work);
/** Runs `work` after every grade of the agent's runs queued before it (grade.ts): one grade at a time per agent, each
 *  against main as the one before left it. Its own queue, so a grade's model call never holds a run's seed. */
export const withAgentGrade = <T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> => queued(`${learningRepo(data, agentId)}\0grade`, work);

function queued<T>(key: string, work: () => Promise<T>): Promise<T> {
  return serialBy(queues, key, work);
}

/** Main's commit, or undefined when there is no main yet: no repository, one whose `init` never finished, or one whose
 *  making stopped before main. A main that is there, by its ref, and names no commit git can read is an error: the
 *  repository is never made again over it. */
export async function mainOf(cwd: string, repo: string): Promise<string | undefined> {
  if (!existsSync(join(repo, ".git")) || !(await git(cwd, repo, ["rev-parse", "--git-dir"]).then(() => true, () => false))) return undefined;
  if (!line(await git(cwd, repo, ["for-each-ref", "--format=%(objectname)", "refs/heads/main"]))) return undefined;
  return line(await git(cwd, repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]));
}

/** Makes the agent's folder, or finishes one whose making stopped before main: `init` with no template, then the host's
 *  one commit on main, holding an empty `MEMORY.md` alone, made with plumbing. The working tree and the index show that
 *  commit's tree first (written here, never checked out; a `MEMORY.md` that is a link is refused, never written
 *  through), and main is created last, only where it is not there yet: a making that stops anywhere before leaves no
 *  main, and the next one does it all again. Called in the queue, on the folder agentFolder made and checked; `check`
 *  checks it again once `.git` is made. */
export async function openAgentRepo(cwd: string, repo: string, check: () => Promise<unknown>): Promise<string> {
  const known = await mainOf(cwd, repo);
  if (known) return known;
  await git(cwd, undefined, ["init", "-q", "--template=", "--initial-branch=main", repo]);
  await check();
  const blob = line(await git(cwd, repo, ["hash-object", "-w", "--no-filters", "--stdin"], ""));
  const tree = line(await git(cwd, repo, ["mktree"], `100644 blob ${blob}\t${INDEX_FILE}\n`));
  await writeFile(join(repo, INDEX_FILE), "", { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOOP" ? new Error(`the learning folder's ${INDEX_FILE} is a symbolic link, and the host never writes through one`) : error;
  });
  await git(cwd, repo, ["read-tree", tree]);
  const commit = line(await git(cwd, repo, ["commit-tree", tree, "-m", "host: the agent's learning folder"]));
  await git(cwd, repo, ["update-ref", "-m", "host: the agent's learning folder", "refs/heads/main", commit, ""]);
  return commit;
}

/** Brings the folder's checked-out files in line with commit `sha` of main: host-only files, so no hook or filter runs,
 *  with the work tree named outright, the folder itself. Why it could not, when it could not. In the queue, on the
 *  folder agentFolder checked. */
export const checkOut = (repo: string, sha: string): Promise<Error | undefined> =>
  git(repo, repo, ["read-tree", "-u", "--reset", sha], "", { GIT_WORK_TREE: repo }).then(() => undefined, (error: Error) => error);

/** The blobs `oids` hold, in order, read in one `cat-file --batch`. One git cannot read throws. */
export async function readBlobs(cwd: string, repo: string, oids: readonly string[]): Promise<Buffer[]> {
  if (!oids.length) return [];
  const out = await git(cwd, repo, ["cat-file", "--batch"], oids.map((oid) => `${oid}\n`).join(""));
  const blobs: Buffer[] = [];
  let at = 0;
  for (const oid of oids) {
    const end = out.indexOf(10, at);
    const [named, type, size] = out.subarray(at, end < 0 ? at : end).toString("utf8").split(" ");
    if (end < 0 || named !== oid || type !== "blob") throw new Error(`git cat-file could not read ${oid}`);
    blobs.push(out.subarray(end + 1, end + 1 + Number(size)));
    at = end + 2 + Number(size);
  }
  return blobs;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** What commit `sha` holds for a run, read with plumbing: its index and its active notes, the `.md` files at its top.
 *  Only a regular file (mode 100644) under FILE_CAP, in UTF-8, is read, and only a note in shape (learn/notes.ts
 *  parseNoteFile); anything else is named in `skipped`. Only an active note is a run's: a pending, superseded or retired
 *  one is not, and nothing serves it (learnedOf, layLearned). A read git fails (an
 *  object missing, a timeout) throws. */
export async function readSeed(cwd: string, repo: string, sha: string): Promise<Seed> {
  const seed: Seed = { sha, notes: {}, files: [], skipped: [] };
  const listed = (await git(cwd, repo, ["ls-tree", "-l", "-z", sha])).toString("utf8").split("\0").filter(Boolean);
  const wanted: { path: string; oid: string }[] = [];
  for (const entry of listed) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    seed.files.push(path);
    if (!path.endsWith(".md")) continue;
    if (path !== INDEX_FILE && !NOTE_FILE.test(path)) seed.skipped.push(`${path} (not a note's file name)`);
    else if (mode !== "100644" || type !== "blob" || !oid) seed.skipped.push(`${path} (mode ${mode})`);
    else if (Number(size) > FILE_CAP) seed.skipped.push(`${path} (over ${FILE_CAP} bytes)`);
    else wanted.push({ path, oid });
  }
  const blobs = await readBlobs(cwd, repo, wanted.map(({ oid }) => oid));
  wanted.forEach(({ path }, i) => {
    let text: string;
    try {
      text = utf8.decode(blobs[i]!);
    } catch {
      return void seed.skipped.push(`${path} (not UTF-8)`);
    }
    if (path === INDEX_FILE) return void (seed.index = text);
    const note = parseNoteFile(path, text);
    if (Array.isArray(note)) seed.skipped.push(`${path} (${note.join("; ")})`);
    else if (note.status === "active") seed.notes[path] = text;
  });
  return seed;
}

/** The skills commit `sha` holds under SKILLS_DIR, read with plumbing, by name. A skill is read when its folder's
 *  name and each of its files' paths are in shape, it holds a SKILL.md, and each file is a regular one (mode 100644) in
 *  UTF-8; else it is named in `skipped`. Only an active skill is a run's, one whose SKILL.md sets no status (or
 *  `active`): one held for its owner's OK (`status: pending`), or with any other status, is left out as a note that is
 *  not active is (readSeed). One over LEARNED_SKILLS_BUDGET, which no run could get, is held with its bytes and none of
 *  its files. A symbolic link or a submodule at SKILLS_DIR or anywhere under it throws, as a read
 *  git fails does: the run starts with nothing learned, and no link is ever laid in its work or followed. */
export async function readSkills(cwd: string, repo: string, sha: string): Promise<{ skills: LearnedSkill[]; skipped: string[] }> {
  const listed = (await git(cwd, repo, ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", sha, "--", SKILLS_DIR])).toString("utf8").split("\0").filter(Boolean);
  const found = new Map<string, { path: string; oid: string; size: number }[]>();
  const refused = new Set<string>();
  const skipped: string[] = [];
  for (const entry of listed) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if (path !== SKILLS_DIR && !path.startsWith(`${SKILLS_DIR}/`)) continue;
    if (mode === "120000" || mode === "160000") throw new Error(`the learning folder's ${path} is a ${mode === "120000" ? "symbolic link" : "submodule"}, and the host never lays one in a run`);
    if (type === "tree") continue;
    if (path === SKILLS_DIR) {
      skipped.push(`${path} (not a folder)`);
      continue;
    }
    const [name = "", ...rest] = path.slice(SKILLS_DIR.length + 1).split("/");
    const file = rest.join("/");
    const why = !SKILL_NAME.test(name) || !file ? "not in a skill's folder named in lowercase letters, digits and dashes" : !SKILL_FILE_PATH.test(file) ? "not a plain path inside a skill" : mode !== "100644" || type !== "blob" || !oid ? `mode ${mode}` : undefined;
    if (why) {
      refused.add(name);
      skipped.push(`${path} (${why})`);
    } else (found.get(name) ?? found.set(name, []).get(name)!).push({ path: file, oid, size: Number(size) });
  }
  const skills: LearnedSkill[] = [];
  for (const [name, files] of [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (refused.has(name)) continue;
    if (!files.some(({ path }) => path === "SKILL.md")) {
      skipped.push(`${SKILLS_DIR}/${name} (no SKILL.md)`);
      continue;
    }
    const bytes = files.reduce((sum, { size }) => sum + size, 0);
    if (bytes > LEARNED_SKILLS_BUDGET) {
      skills.push({ name, bytes });
      continue;
    }
    const blobs = await readBlobs(cwd, repo, files.map(({ oid }) => oid));
    let texts: Record<string, string>;
    try {
      texts = Object.fromEntries(files.map(({ path }, i) => [path, utf8.decode(blobs[i]!)]));
    } catch {
      skipped.push(`${SKILLS_DIR}/${name} (not UTF-8)`);
      continue;
    }
    const status = statusOf(texts["SKILL.md"]);
    if (status === undefined || status === "active") skills.push({ name, bytes, files: texts });
  }
  return { skills, skipped };
}

/** The workflows commit `sha` holds under WORKFLOWS_DIR, read with plumbing, by name: each a folder with a workflow.json
 *  and a README.md, each a regular file (mode 100644) of at most FILE_CAP bytes in UTF-8; else named in `skipped`. Only an
 *  active one is a run's, by the rule a skill is (readSkills): its README.md sets no status, or `active`; one held for
 *  its owner's OK, or retired, is left out. A symbolic link or a submodule under WORKFLOWS_DIR throws. */
export async function readWorkflows(cwd: string, repo: string, sha: string): Promise<{ workflows: LearnedWorkflow[]; skipped: string[] }> {
  const listed = (await git(cwd, repo, ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", sha, "--", WORKFLOWS_DIR])).toString("utf8").split("\0").filter(Boolean);
  const found = new Map<string, Record<string, string>>();
  const refused = new Set<string>();
  const skipped: string[] = [];
  for (const entry of listed) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if (path !== WORKFLOWS_DIR && !path.startsWith(`${WORKFLOWS_DIR}/`)) continue;
    if (mode === "120000" || mode === "160000") throw new Error(`the learning folder's ${path} is a ${mode === "120000" ? "symbolic link" : "submodule"}, and the host never reads one for a run`);
    if (type === "tree") continue;
    const [name = "", file = "", ...more] = path.slice(WORKFLOWS_DIR.length + 1).split("/");
    const why = !WORKFLOW_NAME.test(name) || more.length || (file !== "workflow.json" && file !== "README.md") ? "not a workflow's workflow.json or README.md" : mode !== "100644" || type !== "blob" || !oid ? `mode ${mode}` : Number(size) > FILE_CAP ? `over ${FILE_CAP} bytes` : undefined;
    if (why) {
      refused.add(name);
      skipped.push(`${path} (${why})`);
    } else (found.get(name) ?? found.set(name, {}).get(name)!)[file] = oid!;
  }
  const workflows: LearnedWorkflow[] = [];
  for (const [name, oids] of [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (refused.has(name)) continue;
    if (!oids["workflow.json"] || !oids["README.md"]) {
      skipped.push(`${WORKFLOWS_DIR}/${name} (no ${oids["workflow.json"] ? "README.md" : "workflow.json"})`);
      continue;
    }
    const [json, readme] = await readBlobs(cwd, repo, [oids["workflow.json"], oids["README.md"]]);
    let texts: [string, string];
    try {
      texts = [utf8.decode(json!), utf8.decode(readme!)];
    } catch {
      skipped.push(`${WORKFLOWS_DIR}/${name} (not UTF-8)`);
      continue;
    }
    // Its README read one way only, or not at all: one whose front matter is not closed, or holds a line that is no key
    // at its left edge, could hold a status a reader other than this one sees, so it is never read as active.
    const front = readmeFront(texts[1]);
    if (!front) {
      skipped.push(`${WORKFLOWS_DIR}/${name} (its README.md's front matter does not read one way)`);
      continue;
    }
    const status = front.get("status");
    if (status !== undefined && status !== "active") continue;
    workflows.push({ name, description: front.get("description") ?? "", workflow: texts[0] });
  }
  return { workflows, skipped };
}

/** A learned workflow README's front matter, each key to its value (quotes dropped; a `>` or `|` value's indented lines
 *  joined by spaces), or undefined when it does not read one way: no front matter, none closed (`---` on a line of its
 *  own, the last line or not), a line that is neither a key at its left edge, a comment, blank, nor a line of a `>` or
 *  `|` value, or a key set twice. */
export function readmeFront(text: string): Map<string, string> | undefined {
  const lf = text.replace(/\r\n/g, "\n");
  if (!lf.startsWith("---\n")) return undefined;
  const close = /\n---(?:\n|$)/.exec(lf.slice(3));
  if (!close) return undefined;
  const front = new Map<string, string>();
  let block: string | undefined;
  for (const line of lf.slice(4, 3 + close.index).split("\n")) {
    if (block !== undefined && (/^\s+\S/.test(line) || line.trim() === "")) {
      if (line.trim()) front.set(block, `${front.get(block)} ${line.trim()}`.trim());
      continue;
    }
    block = undefined;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const pair = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!pair || front.has(pair[1]!)) return undefined;
    const value = (pair[2] ?? "").trim();
    if (/^[>|][-+]?$/.test(value)) {
      block = pair[1]!;
      front.set(block, "");
    } else front.set(pair[1]!, value.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return front;
}

/** Each file's place in main's first-parent log from `sha`, by the newest commit that changed it: 0 for those the newest
 *  commit changed, and so on, so two changes in one second keep their order. A run's notes (seedOf) and a person's view
 *  of them (learning-routes.ts) are in this order, the one changed last first. */
export async function changedOrder(cwd: string, repo: string, sha: string): Promise<Map<string, number>> {
  const walked = (await git(cwd, repo, ["log", "--first-parent", "-z", "--name-only", "--format=%x1e", sha])).toString("utf8");
  const order = new Map<string, number>();
  walked.split("\x1e").slice(1).forEach((record, i) => {
    const end = record.indexOf("\0");
    if (end < 0) return;
    for (const file of record.slice(end + 1).split("\0").map((name) => name.replace(/^\n/, "")).filter(Boolean)) if (!order.has(file)) order.set(file, i);
  });
  return order;
}

/** The seed of a run of agent `agentId` about to be made: main's commit, the folder made first when it is absent, and
 *  what that commit holds, its active notes in the order they changed on main, the one changed last first (then by
 *  name). In the agent's queue. */
export function seedOf(data: string, agentId: string): Promise<Seed> {
  return withAgentRepo(data, agentId, async () => {
    const check = () => agentFolder(data, agentId);
    const repo = await check();
    const home = homeOf(data, agentId);
    const sha = await openAgentRepo(home, repo, check);
    const seed = await readSeed(home, repo, sha);
    const order = await changedOrder(home, repo, sha);
    const place = (file: string) => order.get(file) ?? Number.POSITIVE_INFINITY;
    seed.recent = Object.keys(seed.notes).sort((a, b) => place(a) - place(b) || (a < b ? -1 : a > b ? 1 : 0));
    const { skills, skipped } = await readSkills(home, repo, sha);
    // A skill's place is its file changed last's; by name (readSkills' order) among skills changed in one commit.
    const skillPlace = new Map<string, number>();
    for (const [file, at] of order) {
      const name = file.startsWith(`${SKILLS_DIR}/`) ? file.slice(SKILLS_DIR.length + 1).split("/")[0]! : undefined;
      if (name !== undefined && at < (skillPlace.get(name) ?? Number.POSITIVE_INFINITY)) skillPlace.set(name, at);
    }
    const placeOf = (skill: LearnedSkill) => skillPlace.get(skill.name) ?? Number.POSITIVE_INFINITY;
    seed.skills = [...skills].sort((a, b) => placeOf(a) - placeOf(b) || 0);
    seed.skipped.push(...skipped);
    const flows = await readWorkflows(home, repo, sha);
    seed.workflows = flows.workflows;
    seed.skipped.push(...flows.skipped);
    return seed;
  });
}

/** The skills the agent wrote at commit `sha` (readSkills): what a run's pin names, laid again. In the agent's queue,
 *  through agentFolder. */
export const skillsAt = (data: string, agentId: string, sha: string): Promise<LearnedSkill[]> =>
  withAgentRepo(data, agentId, async () => (await readSkills(homeOf(data, agentId), await agentFolder(data, agentId), sha)).skills);

/** What commit `sha` of the agent's folder holds for a run, as seedOf reads main: a run's seed, read again. In the
 *  agent's queue, through agentFolder. */
export const seedAt = (data: string, agentId: string, sha: string): Promise<Seed> =>
  withAgentRepo(data, agentId, async () => readSeed(homeOf(data, agentId), await agentFolder(data, agentId), sha));
/** The active notes of a seed, parsed. */
export const activeOf = (seed: Pick<Seed, "notes">): LearnedNote[] => Object.entries(seed.notes).flatMap(([file, text]) => {
  const note = parseNoteFile(file, text);
  return Array.isArray(note) ? [] : [note];
});

/** Test seams, tests only: once a part of an agent's learning folder is made (before its check), before a run's
 *  learned files are written, once its pin is in place, before what its end-of-run turn wrote is checked, as a run that
 *  learns opens again for a follow-up, and as each git call starts (its arguments). */
export const learningTestHooks: {
  git?: (args: readonly string[]) => void;
  afterMkdir?: (dir: string) => Promise<void> | void;
  beforePin?: (runDir: string) => Promise<void> | void;
  afterPin?: (runDir: string) => Promise<void> | void;
  beforePropose?: (runDir: string) => Promise<void> | void;
  beforeReopen?: (runDir: string) => Promise<void> | void;
} = {};

/** As the run in `runDir` settles after its end-of-run turn ended, before it reads ended and before a follow-up can
 *  open it again: what the turn answered and what the user said, kept whole in `<run dir>/learning-turn.json`, so
 *  nothing the run does after its end reaches what is checked. One already there stays (a server that went after it
 *  was written). Throws when the write fails. */
export async function keepTurn(runDir: string, turn: Turn): Promise<void> {
  const file = join(runDir, LEARNING_TURN);
  if (await lstat(file).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)))) return;
  await writeDurable(file, `${JSON.stringify(turn)}\n`);
}

/** The turn a run's directory keeps (keepTurn). One that is not there, or out of shape, throws. */
export async function readTurn(runDir: string): Promise<Turn> {
  const turn = JSON.parse(await readFile(join(runDir, LEARNING_TURN), "utf8")) as unknown;
  if (!isObject(turn) || typeof turn.answer !== "string" || !Array.isArray(turn.asked) || !turn.asked.every((message) => typeof message === "string")) throw new Error(`the run's ${LEARNING_TURN} is not a turn`);
  return turn as Turn;
}

/** `text` cut of the host's secrets (`shown`) a line at a time: the index, which may be longer than a whole text is
 *  read (learn/secrets.ts PRINT_MAX). */
const linesShown = (text: string, shown: Shown) => text.split("\n").map(shown.text).join("\n");

/** Every link's target on an index line: `<…>` or up to a space or `)`. */
const LINKS = /\]\(\s*(?:<([^>\n]*)>|([^)\s]+))/g;

/** The files an index line links to, each as the folder's path to it: its #fragment dropped, percent-decoded, and
 *  normalized at the folder's top, so `./x.md`, `/x.md` and `a/../x.md` are all x.md. */
const linkedFiles = (entry: string): string[] => [...entry.matchAll(LINKS)].map((link) => {
  const target = (link[1] ?? link[2]!).split("#")[0]!;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Not percent-encoded right: taken as written.
  }
  return posix.normalize(decoded).replace(/^(?:\.?\/)+/, "");
});

/** `seed`'s index as a run is given it: each line with a link, any of them in any spelling (linkedFiles), to a file main
 *  holds that is no active note (a pending, superseded or retired one, or one not read) left out, so it is never served
 *  or counted. The host's index names none; a hand edit might. A line naming only files main does not hold stays. */
function servedIndex(seed: Seed): string | undefined {
  if (seed.index === undefined) return undefined;
  const held = new Set(seed.files);
  return seed.index.split("\n").filter((entry) => !linkedFiles(entry).some((file) => held.has(file) && !Object.hasOwn(seed.notes, file))).join("\n");
}

/** Lays `seed`'s index and active notes in `dir`, made fresh: whatever was there goes. The index names the active notes
 *  alone (servedIndex), and each file is cut of the host's secrets (`shown`), the index a line at a time. */
export async function layLearned(dir: string, seed: Seed, shown: Shown): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  const files = Object.entries(seed.notes).map(([file, text]): [string, string] => [file, shown.text(text)]);
  const index = servedIndex(seed);
  if (index !== undefined) files.unshift([INDEX_FILE, linesShown(index, shown)]);
  for (const [file, text] of files) await writeFile(join(dir, file), text, { flag: "wx" });
}

/** How a run reads what it learned (learnedOf): the server's learning budget, in bytes; whether its agent has the read
 *  tool; the host's secrets, which every text is cut of. */
export type LearnedOptions = { budget: number; read: boolean; shown: Shown; workflowsOff?: string };
/** The lines before what a run learned, under `# Learned` after LEARNS, and the one that names `.learning/` to an agent
 *  that can read it. */
const KEPT = "Follow a note when it applies to what you are doing.";
const WHOLE_INTRO = `What you learned in earlier runs: each note whole, newest first. ${KEPT}`;
const SOME_INTRO = `What you learned in earlier runs: the index, one line per note, then the newest notes whole. ${KEPT}`;
const INDEX_INTRO = `What you learned in earlier runs, one line per note. ${KEPT}`;
const READ_LINE = `The notes not given whole here are files in \`${LEARNED_DIR}/\` in your working directory: open one with the read tool when it applies.`;
/** How a pin an earlier server wrote, the index alone, was read: its intro then. */
const EARLIER_INTRO = `What you learned in earlier runs, one line per note. Each note is a file in \`${LEARNED_DIR}/\` in your working directory: open one when it applies to what you are doing.`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A note as a run reads it whole: its name and file, its description, then its body, each cut of the host's secrets. */
const wholeNote = (note: LearnedNote, shown: Shown): string => [`## ${shown.text(oneLine(note.name))} (${shown.name(note.file)})`, shown.text(oneLine(note.description)), shown.text(note.body.trim())].filter(Boolean).join("\n\n");

/** What a run of `seed` reads under `# Learned`, the same for every harness, or undefined when it learned nothing. Only
 *  active notes are served: a pending, superseded or retired one is never there, whole or in the index, nor counted
 *  toward the budget (readSeed reads active notes alone, and servedIndex drops their lines). Its active notes, newest
 *  first (`seed.recent`, else by name): each whole while all fit `budget`, the UTF-8 bytes of
 *  what follows the first paragraph. Past it, or when the index names a note main does not hold whole: the index as a
 *  run loads it (learn/notes.ts loadedIndex, the first 200 lines and no more than 25 KB, past the budget when it is
 *  larger), then the newest notes that fit what is left, each whole, and the rest named only in the index; an agent
 *  with the read tool is told they are in `.learning/`, one without is not. Every text is cut of the host's secrets. */
export function learnedOf(seed: Seed, options: LearnedOptions): string | undefined {
  const { budget, read, shown } = options;
  const active = new Map(activeOf(seed).map((note) => [note.file, note]));
  const notes = (seed.recent ?? [...active.keys()].sort()).flatMap((file) => active.get(file) ?? []);
  const index = servedIndex(seed);
  const lines = index === undefined ? [] : loadedIndex(index).split("\n").filter((entry) => entry.trim() !== "");
  if (!notes.length && !lines.length) return undefined;
  const blocks = notes.map((note) => wholeNote(note, shown));
  // Each part's bytes, and the blank line before it.
  const size = (text: string) => Buffer.byteLength(text) + 2;
  // Each line's first link, in any spelling (`./x.md` is x.md: linkedFiles, as servedIndex reads it), names an active note.
  const named = lines.every((entry) => active.has(linkedFiles(entry)[0] ?? ""));
  if (named && blocks.reduce((sum, block) => sum + size(block), 0) <= budget) return [WHOLE_INTRO, ...blocks].join("\n\n");
  const shownIndex = lines.map(shown.text).join("\n");
  let left = budget - (shownIndex ? size(shownIndex) : 0);
  const whole = blocks.filter((block) => size(block) <= left && ((left -= size(block)), true));
  return [whole.length ? SOME_INTRO : INDEX_INTRO, shownIndex, ...(read && whole.length < notes.length ? [READ_LINE] : []), ...whole].filter(Boolean).join("\n\n");
}

/** `rel`, a folder of the run's `work`, made where absent by a plain `mkdir` (which follows no link), then checked by
 *  `lstat`: a symbolic link there, or anything but a folder, throws, and nothing is written through it. */
async function workFolder(work: string, rel: string): Promise<void> {
  const path = join(work, rel);
  await mkdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`the run's ${rel} is not a folder, and the host never writes through a link`);
}

/** Lays each of `skills` in the run's `work/.agents/skills/<name>/`, a folder made new for it (one already there
 *  throws), every folder on the way checked (workFolder). Each name goes in `made` once its folder is, so a caller that
 *  fails takes back what was laid. */
async function laySkills(work: string, skills: readonly LearnedSkill[], made: string[]): Promise<void> {
  if (!skills.length) return;
  for (let depth = 1; depth <= RUN_SKILLS.length; depth++) await workFolder(work, RUN_SKILLS.slice(0, depth).join("/"));
  for (const { name, files = {} } of skills) {
    await mkdir(join(work, ...RUN_SKILLS, name));
    made.push(name);
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth++) await workFolder(work, [...RUN_SKILLS, name, ...parts.slice(0, depth)].join("/"));
      // A SKILL.md as a harness is given it: its name and description alone in its front matter (servedSkill).
      await writeFile(join(work, ...RUN_SKILLS, name, ...parts), path === "SKILL.md" ? servedSkill(text) : text, { flag: "wx" });
    }
  }
}

/** Takes the learned skills `names` back out of the run's work: each `work/.agents/skills/<name>/`, unless a folder on
 *  the way is a link (or no folder), when nothing is touched. */
async function takeSkills(work: string, names: Iterable<string>): Promise<void> {
  for (let depth = 1; depth <= RUN_SKILLS.length; depth++) {
    const stats = await lstat(join(work, ...RUN_SKILLS.slice(0, depth))).catch(() => undefined);
    if (!stats?.isDirectory()) return;
  }
  for (const name of names) await rm(join(work, ...RUN_SKILLS, name), { recursive: true, force: true });
}

/** The learned skills' names a pin's `skills` hold, each once. */
const namesIn = (files: readonly string[] | undefined): string[] => [...new Set((files ?? []).map((path) => path.split("/")[0]!))];

/** Which of `seed`'s learned skills a run gets, in `work`, in the seed's order: each whole while they fit their budget,
 *  LEARNED_SKILLS_BUDGET and never more than the revision's `own` skill files (by their bytes in `work`) leave of
 *  SKILL_BYTES. One named like a folder of the revision's skills, or like anything already in `work/.agents/skills/`, is
 *  the revision's, and not the run's; one that does not fit, or holds a host secret (`shown`), is left out. */
async function chooseSkills(work: string, seed: Seed, own: readonly string[], shown: Shown): Promise<{ taken: LearnedSkill[]; left: string[] }> {
  if (!seed.skills?.length) return { taken: [], left: [] };
  let ownBytes = 0;
  for (const path of own) ownBytes += (await lstat(join(work, ...RUN_SKILLS, ...path.split("/")))).size;
  let room = Math.max(0, Math.min(LEARNED_SKILLS_BUDGET, SKILL_BYTES - ownBytes));
  const owned = new Set(namesIn(own));
  const taken: LearnedSkill[] = [];
  const left: string[] = [];
  for (const skill of seed.skills) {
    if (owned.has(skill.name) || (await lstat(join(work, ...RUN_SKILLS, skill.name)).then(() => true, () => false))) continue;
    const secret = shown.holds(skill.name) || Object.entries(skill.files ?? {}).some(([path, text]) => shown.holds(path) || shown.holds(text));
    if (!skill.files || secret || skill.bytes > room) {
      left.push(shown.name(skill.name));
      continue;
    }
    room -= skill.bytes;
    taken.push(skill);
  }
  return { taken, left };
}

/** Writes `seed` into the run just made in `runDir`: the index and each active note into `work/.learning/`, made fresh
 *  (whatever was there goes), then the pin, with what the run reads under `# Learned` (learnedOf) and the learned
 *  skills it gets beside the revision's `own` skill files (chooseSkills), then those skills, last, into
 *  `work/.agents/skills/`. A write that fails leaves no `.learning/`, no learned skill and no pin, and throws. */
export async function pinSeed(runDir: string, work: string, seed: Seed, options: LearnedOptions & { own?: readonly string[] }): Promise<Pin> {
  const dir = join(work, LEARNED_DIR);
  const pinFile = join(runDir, LEARNING_PIN);
  const made: string[] = [];
  try {
    await learningTestHooks.beforePin?.(runDir);
    await layLearned(dir, seed, options.shown);
    const section = learnedOf(seed, options);
    const { taken, left } = await chooseSkills(work, seed, options.own ?? [], options.shown);
    const skills = taken.flatMap(({ name, files = {} }) => Object.keys(files).sort().map((path) => `${name}/${path}`));
    // The learned workflows the run may run, whole, in its directory before the pin names them (a reopen keeps them):
    // by name, each while its line fits what is left of the tool's description budget; one that does not, or holds a
    // secret, is left out, and the pin names it.
    const flows: LearnedWorkflow[] = [];
    const flowsLeft: string[] = [];
    let room = LEARNED_WORKFLOWS_BUDGET;
    for (const flow of seed.workflows ?? []) {
      // None, when the run is offered none (learnedWorkflowsOff): each is named, but for a name that is itself a secret.
      if (options.workflowsOff !== undefined) {
        if (!options.shown.holds(flow.name)) flowsLeft.push(flow.name);
        continue;
      }
      if (options.shown.holds(flow.workflow) || options.shown.holds(flow.description) || options.shown.holds(flow.name)) {
        // Named, but for a name that is itself a secret.
        if (!options.shown.holds(flow.name)) flowsLeft.push(flow.name);
        continue;
      }
      const bytes = Buffer.byteLength(`${workflowLine(flow)}\n`, "utf8");
      if (bytes > room) flowsLeft.push(flow.name);
      else (room -= bytes), flows.push(flow);
    }
    if (flows.length) await writeDurable(join(runDir, LEARNED_WORKFLOWS_FILE), `${JSON.stringify(flows)}\n`);
    const pin: Pin = { seed: seed.sha, ...(section ? { section } : {}), ...(skills.length ? { skills } : {}), ...(left.length ? { skills_left_out: left } : {}), ...(flows.length ? { workflows: flows.map(({ name }) => name) } : {}), ...(options.workflowsOff !== undefined && flowsLeft.length ? { workflows_off: options.workflowsOff } : {}), ...(flowsLeft.length ? { workflows_left_out: flowsLeft } : {}) };
    // The pin names the skills before they are laid: a server that goes down while they are takes them back (dropSeed).
    await writeDurable(pinFile, `${JSON.stringify(pin)}\n`);
    await laySkills(work, taken, made);
    await learningTestHooks.afterPin?.(runDir);
    return pin;
  } catch (error) {
    // writeDurable renames the pin into place before it syncs the run's directory, so a failure there leaves the pin
    // behind: it goes too, or the run's instructions would still say what it learned, of notes it has no copy of.
    await rm(pinFile, { force: true }).catch(() => undefined);
    await rm(join(runDir, LEARNED_WORKFLOWS_FILE), { force: true }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await takeSkills(work, made).catch(() => undefined);
    throw error;
  }
}

/** Lays the learned skills a reopened run's pin names (`pin.skills`) again, fresh, from `read` (the skills of its seed's
 *  commit: skillsAt): what the run wrote over them, or took away, is not what it learned. Each only with the files the
 *  pin names. Throws when it cannot, a link on the way among the reasons. */
export async function layPinnedSkills(work: string, pin: Pin, read: () => Promise<LearnedSkill[]>): Promise<void> {
  const names = namesIn(pin.skills);
  if (!names.length) return;
  const files = new Set(pin.skills);
  const skills = (await read()).filter(({ name }) => names.includes(name)).map(({ name, bytes, files: all = {} }) => ({ name, bytes, files: Object.fromEntries(Object.entries(all).filter(([path]) => files.has(`${name}/${path}`))) }));
  await takeSkills(work, names);
  await laySkills(work, skills, []);
}

/** Takes back a seed whose copy a server went down during (runs.ts load): the learned skills its pin names, the pin,
 *  then its `work/.learning/`. True when the pin or the copy was there. */
export async function dropSeed(runDir: string, work: string): Promise<boolean> {
  const pinFile = join(runDir, LEARNING_PIN);
  const dir = join(work, LEARNED_DIR);
  const there = Boolean((await lstat(pinFile).catch(() => null)) ?? (await lstat(dir).catch(() => null)));
  if (!there) return false;
  await takeSkills(work, namesIn((await readPin(runDir).catch(() => undefined))?.skills));
  await rm(pinFile, { force: true });
  await rm(dir, { recursive: true, force: true });
  return there;
}

/** The run's pin, as its process reads it: undefined when the run has none (its agent does not learn, its seed failed, a
 *  workflow's run). A pin out of shape is an error, never read as none. */
export async function readPin(runDir: string): Promise<Pin | undefined> {
  let text: string;
  try {
    text = await readFile(join(runDir, LEARNING_PIN), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const pin = JSON.parse(text) as unknown;
  const names = (value: unknown, shape: (entry: string) => boolean) => value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string" && shape(entry)));
  const skillFile = (entry: string) => SKILL_NAME.test(entry.split("/")[0]!) && SKILL_FILE_PATH.test(entry.slice(entry.indexOf("/") + 1)) && entry.includes("/");
  if (!isObject(pin) || typeof pin.seed !== "string" || (pin.section !== undefined && typeof pin.section !== "string") || (pin.learned !== undefined && typeof pin.learned !== "string") || !names(pin.skills, skillFile) || !names(pin.skills_left_out, () => true) || !names(pin.workflows, (entry) => WORKFLOW_NAME.test(entry)) || !names(pin.workflows_left_out, (entry) => WORKFLOW_NAME.test(entry)) || (pin.workflows_off !== undefined && typeof pin.workflows_off !== "string")) throw new Error(`the run's ${LEARNING_PIN} is not a learning pin`);
  return pin as Pin;
}

/** The heading of what a run learned, in its instructions. */
export const LEARNED_HEADING = "# Learned";
/** What every run that learns is told first under it, notes or none: a run not told it learns saves what the person
 *  asks it to remember in a file, or says it cannot, and that is never kept. */
const LEARNS = "You learn from your runs. When this run ends you are asked what to keep for later runs, anything the person asked you to remember included, and only your answer then is kept: a file you write is not. So when the person asks you to remember something, don't put it in a file or say you can't: tell them you will keep it for later runs. A secret (a password, key or token) is never kept, so say so instead.";
/** What a run that starts with no note is told in place of what it learned. */
const NOTHING_YET = "Nothing learned yet.";

/** A run's instructions, with `# Learned` after them when its pin in `runDir` says it learns: that it learns, then what
 *  the pin says it learned, or that it has learned nothing yet. A run with no pin (its agent does not learn, its seed
 *  failed, a workflow's run) is never asked what to keep, so it is told nothing. And its skill files: the revision's
 *  `own`, then the learned ones its pin names, by their paths under `.agents/skills/` in `work`, but for a skill named
 *  like one of the revision's, which is the revision's. A learned skill the work no longer holds whole, as a harness reads
 *  it (no link on the way: workspace.ts), is left out: a learning fault never fails a run. The one path for every harness
 *  (app.ts): pi's system prompt, claude-agent's and codex's instructions, and the skills each gets. */
export async function withLearned(runDir: string, work: string, instructions: string, own: readonly string[] = []): Promise<{ instructions: string; skills: string[] }> {
  const pin = await readPin(runDir);
  const section = pin?.section ?? (pin?.learned?.trim() ? `${EARLIER_INTRO}\n\n${pin.learned.trim()}` : undefined);
  const owned = new Set(namesIn(own));
  const learned = (pin?.skills ?? []).filter((path) => !owned.has(path.split("/")[0]!));
  const whole = new Set<string>();
  for (const name of namesIn(learned)) {
    const files = learned.filter((path) => path.startsWith(`${name}/`));
    if (await Promise.all(files.map((path) => readWorkText(work, [...RUN_SKILLS, path].join("/")))).then(() => true, () => false)) whole.add(name);
    else process.stderr.write(`agentrun-serve: the skill ${name} its agent learned is no longer whole in the run's work, so the run goes on without it\n`);
  }
  return {
    instructions: pin ? `${instructions.trim()}\n\n${LEARNED_HEADING}\n\n${LEARNS}\n\n${section ?? NOTHING_YET}` : instructions,
    skills: [...own, ...learned.filter((path) => whole.has(path.split("/")[0]!))],
  };
}

/** The learned workflows a run's pin names, as its directory keeps them (LEARNED_WORKFLOWS_FILE): none when the pin
 *  names none. A file that is not the list the pin names throws. */
export async function pinnedWorkflows(runDir: string, pin: Pin | undefined): Promise<LearnedWorkflow[]> {
  const names = pin?.workflows ?? [];
  if (!names.length) return [];
  const kept = JSON.parse(await readFile(join(runDir, LEARNED_WORKFLOWS_FILE), "utf8")) as unknown;
  const ok = (entry: unknown): entry is LearnedWorkflow => isObject(entry) && typeof entry.name === "string" && typeof entry.description === "string" && typeof entry.workflow === "string";
  if (!Array.isArray(kept) || !kept.every(ok) || kept.map(({ name }) => name).join("\n") !== names.join("\n")) throw new Error(`the run's ${LEARNED_WORKFLOWS_FILE} is not the workflows its pin names`);
  return kept;
}
