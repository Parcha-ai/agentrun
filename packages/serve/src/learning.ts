// Learning: an agent whose definition says `learning: true` keeps a folder of what it learned, and each of its runs
// starts from it. The folder is `learning/` in the agent's folder on the disk (files.ts agentFolderOf), in Claude Code's auto-memory format
// (learn/notes.ts): `MEMORY.md`, the index, one line per active note, and one `<slug>.md` per note. It is plain
// git with main checked out, so any reader sees its files, reached through its Workspace (learningWorkspace). Every
// write to main is one exec of the learning script (learn/folder.ts: a run's merge, a person's write, the first commit),
// which also writes `.agentrun/snapshot.json`, what the routes read. A run's seed is the script's read too (seedFrom over
// learn/seed-check.ts readSeed): no git runs in this process.
//
// When a run of such an agent is made the server makes the folder if it is absent (the script's init: one host commit
// on main, holding an empty `MEMORY.md`), and reads main's commit through the script, never the working tree. It copies that commit's
// index and active notes into the run's `work/.learning/` and pins the commit in the run's directory (`learning.json`),
// with what the run reads under `# Learned` (learnedParts): each active note whole while they fit the server's learning
// budget, else what its note selector picks (byRelevance: the notes that bear on the run's input whole, a line for each
// of the rest); every text cut of the server's secrets, the
// copy's too. The run's process reads that pin (withLearned, for app.ts) and never runs git, so it may run anywhere its
// directory is. When the run ends the runner asks it one more turn, which answers with the notes it would keep
// (runner/learning-end.ts, reflect-hook.ts); its notes are checked (propose.ts), then graded and merged into main by the
// runner's learning run (runner/learning-loop.ts). The copy in the run's work is only for reading: nothing the run
// writes there is ever kept.
//
// The skills the agent wrote are in the folder too, one folder each under `skills/` (SKILLS_DIR). A run
// gets those of its commit beside its revision's own, in `work/.agents/skills/`, read as its notes are: a
// skill named like one of the revision's is the revision's, and the learned ones fit their own budget
// (LEARNED_SKILLS_BUDGET) within what the revision's leave of the adapters' cap on a run's skills, so they never push the
// revision's out of a harness's own loading (skills.ts splitSkills). One that does not fit is left out, and the pin
// names it. A link at `skills/` or anywhere under it is never followed: the skill it is in is left out, with a warning.
//
// The host never follows a symbolic link into the folder (learn/folder.ts learningWorkspace, and the script): a link at
// the agent's home, at its `learning/` or at `learning/.git`, or a `MEMORY.md` that is one when the script writes it, is
// refused, and the run starts with nothing learned. Its proposal's check reads the folder the same way, and a link
// there drops what the run learned. A person's reads and writes (learning-routes.ts) check it the same
// way (learn/folder.ts learningWorkspace), and a link there is an error.
import { lstat, readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { SKILL_BYTES } from "@parcha/agentrun-kernel";
import { bm25, queryOf } from "./learn/relevance.js";
import { type DraftDryRun, INDEX_BYTES, INDEX_FILE, INDEX_LINES, type LearnedNote, loadedIndex, NOTE_FILE, parseNoteFile, type Problem, redactSecrets, secretShapes, servedSkill, SKILLS_DIR, valueMatcher, type Verdict, WORKFLOW_NAME, WORKFLOWS_DIR } from "./learn/index.js";
import { FolderBusy, learningInit, type LearningFolder, learningWorkspace, readLearning, readSnapshot, type Snapshot } from "./learn/folder.js";
import { readSeed as readFolderSeed } from "./learn/seed-check.js";
import { agentFolderOf, serialBy, writeDurable } from "./files.js";
import { withoutLoopbackAddresses } from "./key-refusal.js";
import { DETAIL_MAX, LIST_DETAIL, said, short, wordsOf } from "./learning-words.js";
import { isObject } from "./validate.js";
import { type Entry, isWorkspaceError, type Workspace, WorkspaceError, workspaceAt } from "./workspace/index.js";

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

/** How much of what a run learned its instructions hold under `# Learned` by default, in UTF-8 bytes (learnedParts): its
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
 *  checks and is kept (propose.ts), `merged` once it is on main (runner/learning-loop.ts), or `dropped` with a
 *  reason from the closed list. A learning fault never refuses a run: it starts with nothing learned, `seed_failed`. */
export const LEARNING_STATES = ["seeded", "reflecting", "proposed", "merged", "dropped"] as const;
export const LEARNING_REASONS = ["seed_failed", "no_budget", "unknown_cost", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "empty", "unparsed", "propose_failed", "checker", "grader", "grade_failed"] as const;
export type LearningState = (typeof LEARNING_STATES)[number];
export type LearningReason = (typeof LEARNING_REASONS)[number];
/** Tokens by the platform's names, as a run's metrics and /v2/stats count them: `input` is the input neither read from
 *  nor written to the cache. */
export type Tokens = { input: number; cache_read: number; cache_write: number; output: number };
export const NO_TOKENS: Tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
/** The variable that names the grader's model, as `--grade-model` does. */
export const GRADE_MODEL_ENV = "AGENTRUN_SERVE_GRADE_MODEL";
/** The model this server grades on, by name: `given` (`--grade-model`), else GRADE_MODEL_ENV, else its strong tier
 *  (AGENT_MODEL_STRONG); undefined when it names none, and each run is graded on its agent's own model (runner/learning-loop.ts). A
 *  name is a model as the strong tier takes one: sent as it is to a gateway, a provider/model-id otherwise. */
export const gradeModelOf = (env: NodeJS.ProcessEnv, given?: string): string | undefined => given || env[GRADE_MODEL_ENV] || env.AGENT_MODEL_STRONG || undefined;
/** How many of an agent's runs were given a note, and read it, by the note's file (learning-run.ts noteRuns). */
export type NoteRuns = Map<string, { given: number; read: number }>;
/** A note by its file and its front matter's name: one a run was given (`given`) or read (`read`). */
export type NoteUsed = { file: string; name: string };
/** A note a run's learning added to the folder (`learned`): its file, its name, and the notes it superseded. */
export type NoteLearned = NoteUsed & { supersedes: string[] };
/** A run's learning as serve.json keeps it. Past the view's four fields: the checker's `problems` (printable), the
 *  grader's `verdict` and the blob of each note it read superseded (`graded`, by file), both kept before the merge, the
 *  merge commit, and what the grade cost (null when unknown, never 0), which is in no run's totals; the notes the run
 *  started with (`given`: each note its # Learned section names, whole or as an index line, set as it is seeded) and read
 *  from `.learning/` (`read`, found in its rows as it settles), and once merged the notes it added (`learned`);
 *  and how many notes it started from (`seed_notes`). Names are kept as written, and cut of the host's secrets as they
 *  leave. */
export type Learning = {
  state: LearningState; reason: LearningReason | null; detail: string | null; at: string;
  problems?: Problem[]; verdict?: Verdict; graded?: Record<string, string>; merged?: string; cost_usd?: { grade: number | null }; tokens?: { grade: Tokens | null };
  given?: NoteUsed[]; read?: NoteUsed[]; learned?: NoteLearned[];
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
  /** A grader's drop's skill and workflow draft, from what the run proposed: lost with the rest, and named when its
   *  learning is said (learning-words.ts notKept). */
  lost?: LearnedFile[];
  /** A grader's drop on two answers the host could not read: the last, cut of secrets and in size (UNREAD_MAX), kept on the
   *  run's file to diagnose it by, and served by no read. */
  unread?: string;
};
/** A skill or a workflow draft a merge added or changed. */
export type LearnedFile = { file: string; name: string; pending?: true };

/** What a text or a name that leaves shows of the host's secrets now: none (secretsShown). */
export type Shown = { text: (text: string) => string; name: (name: string) => string; holds: (text: string) => boolean };
/** What a name holding a secret reads: learn/secrets.ts redactSecrets' mark, the name's whole, never a part of it. */
const REDACTED = "[redacted]";
/** The host's secrets as a reader cuts them: a text holding a value or a shape is cut of it (whole when long:
 *  learn/secrets.ts redactSecrets), and a file's name holding one reads REDACTED whole, not a name of the folder's (its
 *  route still answers the real name, to a caller who knows it); any other text or name is shown as it is. A text served
 *  has no loopback address, the address alone (key-refusal.ts withoutLoopbackAddresses, the pattern a run's words share,
 *  run-view.ts shownOf): the host's own, never a person's; a run error's `url:` tail is no rule of a note's, a patch's or a
 *  workflow.json's, so their label, line ends and JSON stay. `local`: kept, for what a run itself is given (its .learning/ notes, runner/learning-seed.ts, and its
 *  # Learned section, server.ts's learning start), where an address on the run's own machine is the note's to give. */
export function secretsShown(values: readonly string[], { local = false }: { local?: boolean } = {}): Shown {
  const matches = valueMatcher(values);
  const holds = (text: string) => matches(text) || secretShapes(text).length > 0;
  const cut = (text: string) => (holds(text) ? redactSecrets(text, values) : text);
  return { holds, text: local ? cut : (text) => withoutLoopbackAddresses(cut(text)), name: (name) => (holds(name) ? REDACTED : name) };
}

const isText = (value: unknown): value is string => typeof value === "string";
/** The notes a run read and learned, as a view or a list shows them, each name cut of the host's secrets (`shown`):
 *  `given` from its start, `read` once the run settled, `learned` and `pending` (what waits for the owner's OK) once it merged, and the skill
 *  and the workflow draft it merged (`skills`, `workflows`, each `pending` while it waits), each only when it holds one.
 *  serve.json's are read as untrusted: an entry out of shape is left out. */
export function notesView({ state, given, read: opened, learned, pending, skills, workflows }: Learning, shown: Shown, settled: boolean): { given?: NoteUsed[]; read?: NoteUsed[]; learned?: NoteLearned[]; pending?: NoteUsed[]; skills?: LearnedFile[]; workflows?: LearnedFile[] } {
  const refs = (list: NoteUsed[] | undefined) => (Array.isArray(list) ? list.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : []);
  const started = refs(given);
  const read = settled ? refs(opened) : [];
  const added = state === "merged" && Array.isArray(learned) ? learned.filter((note) => isText(note?.file) && isText(note.name) && Array.isArray(note.supersedes) && note.supersedes.every(isText)).map(({ file, name, supersedes }) => ({ file: shown.name(file), name: shown.text(name), supersedes: supersedes.map(shown.name) })) : [];
  const waiting = state === "merged" && Array.isArray(pending) ? pending.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : [];
  const files = (list: LearnedFile[] | undefined) => (state === "merged" && Array.isArray(list) ? list.filter((item) => isText(item?.file) && isText(item.name)).map(({ file, name, pending: waits }) => ({ file: shown.name(file), name: shown.name(name), ...(waits === true ? { pending: true as const } : {}) })) : []);
  const [kept, drafts] = [files(skills), files(workflows)];
  return { ...(started.length ? { given: started } : {}), ...(read.length ? { read } : {}), ...(added.length ? { learned: added } : {}), ...(waiting.length ? { pending: waiting } : {}), ...(kept.length ? { skills: kept } : {}), ...(drafts.length ? { workflows: drafts } : {}) };
}
/** A learned item's status on main (a note's front matter, a skill's SKILL.md, a draft's README.md), with what a note
 *  supersedes. */
export type ItemStatus = { status: string; supersedes?: readonly string[] };
/** Whether a run's learning held anything for its owner's OK: a merge with a held note, skill or draft. Only such a
 *  run's reads check main (currentLearning). */
export const holdsForOk = (learning: Learning | undefined): learning is Learning =>
  learning?.state === "merged" && ((Array.isArray(learning.pending) && learning.pending.length > 0) || [...(Array.isArray(learning.skills) ? learning.skills : []), ...(Array.isArray(learning.workflows) ? learning.workflows : [])].some((item) => item?.pending));

/** A merged run's learning as it reads now: what it held for the owner's OK checked against each item's status on
 *  main now (`status`, by file: a note's, a skill's SKILL.md, a draft's workflow.json). Still pending, it waits; approved
 *  (active), it is learned, as a merge that held nothing says it; retired or gone, it is no longer said. The record keeps
 *  what the merge wrote; only its reads change. No status (the folder unread): as written. */
export function currentLearning(learning: Learning, status: ReadonlyMap<string, ItemStatus> | undefined): Learning {
  if (!status || learning.state !== "merged") return learning;
  const of = (file: unknown) => (typeof file === "string" ? status.get(file)?.status : undefined);
  const held = Array.isArray(learning.pending) ? learning.pending : [];
  // An approved note replaces what its front matter on main says it supersedes, as a merge that held nothing says it.
  const approved = held.filter((note) => of(note?.file) === "active").map(({ file, name }) => ({ file, name, supersedes: [...(status.get(file)?.supersedes ?? [])] }));
  const files = (list: LearnedFile[] | undefined) => (Array.isArray(list) ? list.flatMap((item) => (!item?.pending || of(item.file) === "pending" ? [item] : of(item.file) === "active" ? [{ file: item.file, name: item.name }] : [])) : list);
  const { pending: _pending, learned, skills, workflows, ...rest } = learning;
  const waits = held.filter((note) => of(note?.file) === "pending");
  const kept = [...(Array.isArray(learned) ? learned : []), ...approved];
  const [madeSkills, madeDrafts] = [files(skills), files(workflows)];
  const gone = !kept.length && !waits.length && !madeSkills?.length && !madeDrafts?.length;
  return { ...rest, ...(gone ? { detail: said.retiredSince } : {}), ...(kept.length ? { learned: kept } : learned ? { learned } : {}), ...(waits.length ? { pending: waits } : {}), ...(madeSkills ? { skills: madeSkills } : {}), ...(madeDrafts ? { workflows: madeDrafts } : {}) };
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
  return { state, reason: reasonShown(reason, shown), detail: detailShown(learning, shown), at, ...notesView(learning, shown, settled) };
};
/** A learning's `reason` as it is served: one of its words as the server writes them, read back from a kept row, which is
 *  untrusted, so cut of the host's secrets as every text is. */
export const reasonShown = (reason: Learning["reason"] | undefined, shown: Shown): Learning["reason"] => (typeof reason === "string" ? (shown.text(reason) as Learning["reason"]) : (reason ?? null));
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
 *  secrets, then shortened to its head and tail, shortMessage; absent in a proposal kept before the grader read them). */
export const PROPOSAL = "learning-proposal.json";
/** A run's proposal: its notes, skill and drafts, each draft's dry run by its workflow.json's path (learn/skills.ts
 *  draftDryRun: passed, or not run and why), and what was said in the run. */
export type Proposal = { seed: string; notes: { file: string; text: string }[]; files?: { file: string; text: string }[]; dryRuns?: Record<string, DraftDryRun>; asked?: string[]; triggered?: Triggered[] };
/** A message a trigger sent the run that its owner did not write (a webhook body, a Slack or GitHub event), by its
 *  source: never what the user said. */
export type Triggered = { source: string; text: string };

/** A run's pin, in its directory: written once, when the run is made, and never changed by a resume. */
export const LEARNING_PIN = "learning.json";
/** Where a run finds its agent's notes: in its work, a copy the run may read and nothing reads back. */
export const LEARNED_DIR = ".learning";
/** What the run's end-of-run turn answered, and what the user said in the run: what propose.ts checks. */
export type Turn = { answer: string; asked: string[]; triggered?: Triggered[] };
/** What a run's pin holds: the commit of main it was seeded from (null: the folder had no main yet, so the run learns
 *  from an empty seed), and what it reads under `# Learned` (learnedParts), when it learned anything.
 *  `skills`: the files of the learned skills laid in its work, by their paths under `.agents/skills/`, as a revision
 *  names its own; `skills_left_out`: the learned skills it does not get, over their budget or holding a secret.
 *  `workflows`: the names of the learned workflows the run may run (its `learned_workflow` tool), each written whole in
 *  LEARNED_WORKFLOWS_FILE in the run's directory, outside its work; `workflows_left_out`: the learned workflows it does
 *  not get, their lines over what is left of the tool's description budget (LEARNED_WORKFLOWS_BUDGET), or holding a
 *  secret. Every harness runs them, on the run's one model route. */
export type Pin = { seed: string | null; section?: string; given?: NoteUsed[]; skills?: string[]; skills_left_out?: string[]; workflows?: string[]; workflows_left_out?: string[] };
/** What a run is seeded from: main's commit (null when the folder has none yet), its index and its active notes by
 *  file, and the name of every entry at its top. `skipped` names what was there and not read. `recent`, when seedOf read it: the active notes' files, the one
 *  changed last on main first. `skills`, when seedOf read them: the skills the agent wrote, the one changed last on main
 *  first. `workflows`: its active learned workflows, by name. */
export type Seed = { sha: string | null; index?: string; notes: Record<string, string>; files: string[]; skipped: string[]; recent?: string[]; skills?: LearnedSkill[]; workflows?: LearnedWorkflow[] };
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
  const shown = compactSchema(schema, doc?.schemas ?? {}, 0, definitionsOf(schema));
  return [`  input: ${shown}${shown.includes("*") ? " (* required)" : ""}`];
}

/** A schema's own inline definitions (`definitions`, `$defs`), which its `#/definitions/` references read first. */
const definitionsOf = (schema: unknown): Record<string, unknown> => {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  return { ...((s.$defs as Record<string, unknown> | undefined) ?? {}), ...((s.definitions as Record<string, unknown> | undefined) ?? {}) };
};

/** A JSON Schema in one line: an object's fields as `name type`, a required one marked `*`, each with its description cut
 *  short; an array as `array of <items>`; a reference to another of the workflow's schemas followed, two levels deep. */
function compactSchema(schema: unknown, schemas: Record<string, unknown>, depth = 0, defs: Record<string, unknown> = {}): string {
  const s = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : undefined;
  if (!s) return "any";
  if (typeof s.$ref === "string") {
    // As the DSL resolves it: `#/definitions/` and `#/$defs/` in the schema's own inline definitions first, then the
    // workflow's schemas by that name.
    const inline = /^#\/(?:definitions|\$defs)\//.test(s.$ref);
    const name = s.$ref.replace(/^#\/(?:schemas|definitions|\$defs)\//, "");
    const target = (inline ? defs[name] : undefined) ?? schemas[name];
    return depth > 2 || !target ? name : compactSchema(target, schemas, depth + 1, defs);
  }
  if (s.properties && typeof s.properties === "object") {
    if (depth > 2) return "object";
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const fields = Object.entries(s.properties as Record<string, unknown>).map(([key, value]) => {
      const said = value && typeof value === "object" ? (value as Record<string, unknown>).description : undefined;
      const words = typeof said === "string" && said.trim() ? ` "${said.trim().length > FIELD_DESCRIPTION ? `${said.trim().slice(0, FIELD_DESCRIPTION - 1)}…` : said.trim()}"` : "";
      return `${key}${required.has(key) ? "*" : ""} ${compactSchema(value, schemas, depth + 1, defs)}${words}`;
    });
    return `{${fields.join(", ")}}`;
  }
  if (s.type === "array") return `array of ${compactSchema(s.items, schemas, depth + 1, defs)}`;
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
/** The agent's learning folder: `learning/` in its folder on the disk, which only the host writes. The folder is files.ts
 *  agentFolderOf (pi-durable-agent agentDiskDir), so two ids that differ only in case never share one. */
export const learningRepo = (data: string, agentId: string): string => join(agentFolderOf(data, agentId), "learning");

const queues = new Map<string, Promise<unknown>>();

/** Runs `work` once every call queued before it on the agent's folder has finished: one at a time per agent, in this
 *  process. Everything that touches an agent's folder goes through it, so two runs made at once never both make it. */
export const withAgentRepo = <T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> => queued(learningRepo(data, agentId), work);

function queued<T>(key: string, work: () => Promise<T>): Promise<T> {
  return serialBy(queues, key, work);
}

/** Agent `agentId`'s learning folder (learn/folder.ts learningWorkspace), in this server's place: Mode 1's local folder
 *  under `data`. The one point that names the place; its `end()` is called in a finally after every use. */
export const learningFolderOf = (data: string, agentId: string): LearningFolder => learningWorkspace({ mode: "local", agentId, data });

/** What the learning folder's read at a commit gives a run's seed (the folder's script's read op, through the agent's
 *  learning Workspace): each file of its index, its active notes and its active skills, by its path from the folder's
 *  root, each skill it left out whole and why (`refused`, always there: a skill holding a tracked link), and every entry
 *  at the commit's top whatever its status (`held`: the index, every note, the skills' and workflows' folders); or why
 *  it has none: the folder cannot answer now (`unavailable`), or the commit is no longer there (`gone`). */
export type SeedRead =
  | { ok: true; files: readonly { path: string; text: string }[]; refused: readonly { skill: string; why: string }[]; held: readonly string[] }
  | { ok: false; why: "unavailable" | "gone" };
/** The read at `commit` (null: the folder has no main yet, an empty read). */
export type SeedReader = (commit: string | null) => Promise<SeedRead>;
/** What a seed can't tell from its read alone, as the folder's snapshot keeps it: each note file's place in main's log
 *  (0 the newest) and each skill's by its name. Order alone: what main holds is the read's (`held`). */
export type SeedOrder = { readonly notes: readonly { file: string; order: number }[]; readonly skills?: readonly { name: string; order: number }[] };

/** A run's seed from the folder's read at `commit` (`read`): its index, its notes the one changed last first, its
 *  skills grouped by folder, the one changed last first, each with its files while it could fit a run's budget at all
 *  (LEARNED_SKILLS_BUDGET), else held by its size alone, and its active learned workflows by name. A path that is none (a file deeper than the folder's top, a
 *  skill folder named out of shape) is named in `skipped`. A skill the read refused is not in it, and is said in one
 *  `warn` line of the run. No commit yet (null, read as null) is an empty seed whose commit stays null; a read that fails
 *  throws, saying why, and the run starts with nothing learned (or, opened again, keeps what it has). No git here: the
 *  read is the folder's. */
export async function seedFrom(commit: string | null, read: SeedReader, { order, warn }: { order?: SeedOrder; warn?: (line: string) => void } = {}): Promise<Seed> {
  const got = await read(commit);
  if (!got.ok) throw new Error(`the learning folder's read at ${commit ?? "its start"} is ${got.why}`);
  for (const { skill, why } of got.refused) warn?.(`starts without the skill ${skill} its agent learned: ${why}`);
  const seed: Seed = { sha: commit, notes: {}, files: [], skipped: [], recent: [], skills: [] };
  const skills = new Map<string, Record<string, string>>();
  const flows = new Map<string, Record<string, string>>();
  for (const { path, text } of got.files) {
    if (path === INDEX_FILE) seed.index = text;
    else if (NOTE_FILE.test(path)) seed.notes[path] = text;
    else {
      const [top, name = "", ...rest] = path.split("/");
      const file = rest.join("/");
      if (top === SKILLS_DIR && SKILL_NAME.test(name) && SKILL_FILE_PATH.test(file)) (skills.get(name) ?? skills.set(name, {}).get(name)!)[file] = text;
      else if (top === WORKFLOWS_DIR && WORKFLOW_NAME.test(name) && (file === "README.md" || file === "workflow.json")) (flows.get(name) ?? flows.set(name, {}).get(name)!)[file] = text;
      else seed.skipped.push(path);
    }
  }
  const noteAt = new Map((order?.notes ?? []).map(({ file, order: at }) => [file, at]));
  const skillAt = new Map((order?.skills ?? []).map(({ name, order: at }) => [name, at]));
  const by = (at: Map<string, number>) => (a: string, b: string) => (at.get(a) ?? Number.POSITIVE_INFINITY) - (at.get(b) ?? Number.POSITIVE_INFINITY) || (a < b ? -1 : a > b ? 1 : 0);
  seed.recent = Object.keys(seed.notes).sort(by(noteAt));
  // Every entry at the seed's top, as main holds it (the read's `held`, a pending, superseded or retired note's file
  // among them, so servedIndex leaves its line out of a run's index), beside what the read gave.
  seed.files = [...new Set([...(seed.index === undefined ? [] : [INDEX_FILE]), ...Object.keys(seed.notes), ...got.held, ...(skills.size ? [SKILLS_DIR] : [])])];
  seed.skills = [...skills.keys()].sort(by(skillAt)).map((name) => {
    const files = skills.get(name)!;
    const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    return bytes > LEARNED_SKILLS_BUDGET ? { name, bytes } : { name, bytes, files };
  });
  // The active learned workflows, by name, each with its workflow.json whole. The read gives an active one's README.md
  // and workflow.json; its front matter is read again here: one that does not read one way (readmeFront) could hold a
  // status another reader sees, so it is never read as active, and is named in `skipped`.
  seed.workflows = [];
  for (const name of [...flows.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const { "README.md": readme, "workflow.json": workflow } = flows.get(name)!;
    if (readme === undefined || workflow === undefined) continue;
    const front = readmeFront(readme);
    if (!front) {
      seed.skipped.push(`${WORKFLOWS_DIR}/${name} (its README.md's front matter does not read one way)`);
      continue;
    }
    if ((front.get("status") ?? "active") !== "active") continue;
    seed.workflows.push({ name, description: front.get("description") ?? "", workflow });
  }
  return seed;
}

/** What seedFrom reads through the agent's learning folder: the script's read at a commit, or the snapshot and its
 *  bodies when the commit is main's (learn/seed-check.ts readSeed). No git in this process. */
export const readerOf = (ws: Workspace): SeedReader => async (commit) => {
  const got = await readFolderSeed(ws, commit);
  return got.ok ? { ok: true, files: got.files, refused: got.refused, held: got.held } : { ok: false, why: got.reason };
};
/** The places a seed can't read from its files alone, from the folder's snapshot: each note's and each skill's. */
const orderOf = (snapshot: Snapshot | undefined): SeedOrder | undefined =>
  snapshot ? { notes: snapshot.notes.map(({ file, order }) => ({ file, order })), skills: snapshot.skills.map(({ name, order }) => ({ name, order })) } : undefined;

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

/** The seed of a run of agent `agentId` about to be made: main's commit, the folder made first when it is absent (the
 *  learning script's init), and what main holds for a run (seedFrom over the folder's read): its index, its active
 *  notes the one changed last first, its active skills, and its active learned workflows. A skill the read refused is
 *  said through `warn`. In the agent's queue. No git in this process: the folder's own script and file API. */
export function seedOf(data: string, agentId: string, warn?: (line: string) => void): Promise<Seed> {
  return withAgentRepo(data, agentId, async () => {
    const { workspace, end } = learningFolderOf(data, agentId);
    try {
      const main = await learningInit(workspace);
      return await seedFrom(main, readerOf(workspace), { order: orderOf(await readSnapshot(workspace)), ...(warn ? { warn } : {}) });
    } finally {
      await end();
    }
  });
}

/** What commit `sha` of the agent's folder holds for a run, as seedOf reads main: a run's seed, read again (a follow-up's
 *  copy, the names of the notes it read). No commit (a pin of an empty seed) is the empty seed. */
export const seedAt = async (data: string, agentId: string, sha: string | null): Promise<Seed> => {
  const { workspace, end } = learningFolderOf(data, agentId);
  try {
    return await seedFrom(sha, readerOf(workspace));
  } finally {
    await end();
  }
};

/** The skills the agent wrote at commit `sha` (seedAt's): what a run's pin names, laid again. */
export const skillsAt = async (data: string, agentId: string, sha: string | null): Promise<LearnedSkill[]> => (await seedAt(data, agentId, sha)).skills ?? [];
/** The active notes of a seed, parsed. */
export const activeOf = (seed: Pick<Seed, "notes">): LearnedNote[] => Object.entries(seed.notes).flatMap(([file, text]) => {
  const note = parseNoteFile(file, text);
  return Array.isArray(note) ? [] : [note];
});

/** Test seams, tests only: once a part of an agent's learning folder is made (before its check), before a run's
 *  learned files are written, once its pin is in place, before what its end-of-run turn wrote is checked, as a run that
 *  learns opens again for a follow-up, and as each git call starts (its arguments). */
export const learningTestHooks: {
  afterPin?: (runDir: string) => Promise<void> | void;
} = {};

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

/** Lays `seed`'s index and active notes in the run's `.learning/`, through its Workspace, made fresh: whatever was there
 *  goes. The index names the active notes alone (servedIndex), and each file is cut of the host's secrets (`shown`), the
 *  index a line at a time. */
export async function layLearned(work: Workspace, seed: Seed, shown: Shown): Promise<void> {
  await work.remove(LEARNED_DIR, { recursive: true, force: true });
  await work.mkdir(LEARNED_DIR);
  const files = Object.entries(seed.notes).map(([file, text]): [string, string] => [file, shown.text(text)]);
  const index = servedIndex(seed);
  if (index !== undefined) files.unshift([INDEX_FILE, linesShown(index, shown)]);
  for (const [file, text] of files) await work.write(`${LEARNED_DIR}/${file}`, text);
}

/** How a run reads what it learned (learnedParts): the server's learning budget, in bytes; whether its agent has the read
 *  tool; the host's secrets, which every text is cut of; and which of its notes it is given (`select`, byRelevance when
 *  none) for the run it starts (`run`: what the selector may read of it, its input). */
export type LearnedOptions = { budget: number; read: boolean; shown: Shown; select?: NoteSelector; run?: RunInput };

/** What a note selector may read of the run it chooses for: the input it was started with. */
export type RunInput = { readonly input?: unknown };
/** What a note selector chooses from: the agent's active notes, newest first, each with the UTF-8 bytes it takes whole
 *  (its block and the blank line before it); the bytes the served index takes (0 when there is none); whether every index
 *  line names an active note (none names one main does not hold whole); and the learning budget. */
export type NoteCandidates = {
  /** Each note, with the bytes it takes whole and the bytes it takes as one rule line (`lineBytes`: its name, file and
   *  description on one line). */
  readonly notes: readonly { readonly note: LearnedNote; readonly bytes: number; readonly lineBytes: number }[];
  readonly indexBytes: number;
  readonly indexComplete: boolean;
  readonly budget: number;
};
/** A selector's choice: the notes the run reads whole, in the order it reads them (a subset of the candidates), and
 *  whether it reads the index first. Without the index, the notes are all it is given; or, with `lines`, the notes it
 *  reads as one rule line each after them, in their place (`index` is then false). */
export type NoteSelection = { readonly whole: readonly LearnedNote[]; readonly index: boolean; readonly lines?: readonly LearnedNote[] };
/** The port that chooses which of an agent's notes a run gets (learnedParts; byRelevance when none is named). It chooses only: the seed, the pin, the cut of
 *  the host's secrets and the section's words stay learnedParts'. A selector keeps the budget: its whole notes, and the
 *  index when it serves it, fit `budget`, past which only the index may go (as loadedIndex bounds it). */
export type NoteSelector = (candidates: NoteCandidates, run: RunInput) => NoteSelection;

/** All of `candidates` fit whole: every note within the budget, and an index that names no note main does not hold. */
const allFit = ({ notes, indexComplete, budget }: NoteCandidates) => indexComplete && notes.reduce((sum, { bytes }) => sum + bytes, 0) <= budget;

/** The selector by recency: every note whole while all fit the budget and the index names no note main does not hold
 *  whole; else the index, then the newest notes that fit what it leaves, each whole. */
export const byRecency: NoteSelector = (candidates) => {
  const { notes, indexBytes, budget } = candidates;
  if (allFit(candidates)) return { whole: notes.map(({ note }) => note), index: false };
  let left = budget - indexBytes;
  return { whole: notes.filter(({ bytes }) => bytes <= left && ((left -= bytes), true)).map(({ note }) => note), index: true };
};

/** The default selector, by relevance, past the budget: while the notes fit it, recency's choice (byRecency). Else each
 *  note is scored against the run's input (learn/relevance.ts: BM25 over its name, description and body, a code
 *  review's changed paths' words weighed PATH_WEIGHT; no model call), and the run reads the notes that bear on it most
 *  whole, in score order, while they fit, then one rule line for each of the rest, best first, in place of the index; the lines count toward the
 *  budget before the whole notes, as the index did, and no more of them than a run reads of the index (loadedIndex). An
 *  input with no word any note holds reads by recency. */
export const byRelevance: NoteSelector = (candidates, run) => {
  // Within the budget, nothing changes: recency's choice (every note whole, or the index where it names a note main lacks).
  if (candidates.notes.reduce((sum, { bytes }) => sum + bytes, 0) <= candidates.budget) return byRecency(candidates, run);
  const { notes, budget } = candidates;
  const scores = bm25(notes.map(({ note }) => note), queryOf(run.input));
  if (!scores.some((score) => score > 0)) return byRecency(candidates, run);
  // Best first; a tie keeps recency (the candidates' order).
  const ranked = notes.map((candidate, i) => ({ ...candidate, score: scores[i]!, at: i })).sort((a, b) => b.score - a.score || a.at - b.at);
  // The lines of the rest, as the index was read (learn/notes.ts loadedIndex): the first INDEX_LINES, within INDEX_BYTES.
  const linesOf = (whole: ReadonlySet<LearnedNote>) => {
    let bytes = 0;
    return ranked.filter(({ note }) => !whole.has(note)).slice(0, INDEX_LINES).filter(({ lineBytes }) => (bytes += lineBytes) <= INDEX_BYTES);
  };
  const lineBytesOf = (whole: ReadonlySet<LearnedNote>) => linesOf(whole).reduce((sum, { lineBytes }) => sum + lineBytes, 0);
  // Promoted whole, best first, while the whole notes and the lines served of the rest fit: the room kept for lines is
  // only what is served of them (past INDEX_LINES or INDEX_BYTES a line is never served), never every note's.
  const whole = new Set<LearnedNote>();
  let wholeBytes = 0;
  for (const { note, bytes, score } of ranked) {
    if (score <= 0) break;
    whole.add(note);
    if (wholeBytes + bytes + lineBytesOf(whole) <= budget) wholeBytes += bytes;
    else whole.delete(note);
  }
  return { whole: ranked.filter(({ note }) => whole.has(note)).map(({ note }) => note), index: false, lines: linesOf(whole).map(({ note }) => note) };
};
/** The lines before what a run learned, under `# Learned` after LEARNS, and the one that names `.learning/` to an agent
 *  that can read it. */
const KEPT = "Follow a note when it applies to what you are doing.";
const WHOLE_INTRO = `What you learned in earlier runs: each note whole, newest first. ${KEPT}`;
const SOME_INTRO = `What you learned in earlier runs: the index, one line per note, then the newest notes whole. ${KEPT}`;
const INDEX_INTRO = `What you learned in earlier runs, one line per note. ${KEPT}`;
const LINES_INTRO = `What you learned in earlier runs: the notes that bear most on this run whole, then one line for each of the rest. ${KEPT}`;
const READ_LINE = `The notes not given whole here are files in \`${LEARNED_DIR}/\` in your working directory: open one with the read tool when it applies.`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A note as one rule line: its name and file, then its description, cut of the host's secrets. */
const ruleLine = (note: LearnedNote, shown: Shown): string => `- ${shown.text(oneLine(note.name))} (${shown.name(note.file)}): ${shown.text(oneLine(note.description))}`;

/** A note as a run reads it whole: its name and file, its description, then its body, each cut of the host's secrets. */
const wholeNote = (note: LearnedNote, shown: Shown): string => [`## ${shown.text(oneLine(note.name))} (${shown.name(note.file)})`, shown.text(oneLine(note.description)), shown.text(note.body.trim())].filter(Boolean).join("\n\n");

/** What a run of `seed` reads under `# Learned` (`section`, the same for every harness, undefined when it learned
 *  nothing) and the notes that names (`given`), from one choice of the selector, so the section and the given notes never
 *  come from two choices. Only active notes are served: a pending, superseded or retired one is never there, whole or in
 *  the index, nor counted toward the budget (readSeed reads active notes alone, and servedIndex drops their lines). Its
 *  active notes, newest first (`seed.recent`, else by name), each whole while all fit `budget`; past it, the selector's
 *  choice (byRelevance by default). An agent with the read tool is told the rest are in `.learning/`, one without is not.
 *  Every text is cut of the host's secrets. A run "was given" `given`; of them, it "read" those whose file it opened
 *  (store-reads/learning.ts notesReadOf). Whether it applied one given whole is not measured. */
export function learnedParts(seed: Seed, options: LearnedOptions): { section: string | undefined; given: LearnedNote[] } {
  const { budget, read, shown, select = byRelevance, run = {} } = options;
  const active = new Map(activeOf(seed).map((note) => [note.file, note]));
  const notes = (seed.recent ?? [...active.keys()].sort()).flatMap((file) => active.get(file) ?? []);
  const index = servedIndex(seed);
  const lines = index === undefined ? [] : loadedIndex(index).split("\n").filter((entry) => entry.trim() !== "");
  if (!notes.length && !lines.length) return { section: undefined, given: [] };
  const blocks = new Map(notes.map((note) => [note, wholeNote(note, shown)]));
  // Each part's bytes, and the blank line before it.
  const size = (text: string) => Buffer.byteLength(text) + 2;
  const shownIndex = lines.map(shown.text).join("\n");
  // Which notes the run reads whole, and whether it reads the index (the selector's one choice). Each line's first link,
  // in any spelling (`./x.md` is x.md: linkedFiles, as servedIndex reads it), names an active note when indexComplete.
  const choice = select({
    notes: notes.map((note) => ({ note, bytes: size(blocks.get(note)!), lineBytes: Buffer.byteLength(ruleLine(note, shown)) + 1 })),
    indexBytes: shownIndex ? size(shownIndex) : 0,
    indexComplete: lines.every((entry) => active.has(linkedFiles(entry)[0] ?? "")),
    budget,
  }, run);
  const chosen = new Set(choice.whole);
  const whole = choice.whole.filter((note) => blocks.has(note)).map((note) => blocks.get(note)!);
  // Rule lines in place of the index: the whole notes first, then a line for each of the rest the selector names.
  if (choice.lines) {
    // The whole section fits the budget, its intro, blank lines and read-tool line counted: while it does not, the last
    // whole note goes to the head of the lines (what the selector ranked best of the rest), the lines capped again as the
    // index is read. Lines alone may pass the budget, as the index may.
    const wholeNotes = choice.whole.filter((note) => blocks.has(note));
    // The lines as the index is read (learn/notes.ts loadedIndex): the first INDEX_LINES, within INDEX_BYTES, each line
    // and its newline counted. Applied again after every demotion, so a note demoted to a line never takes them past it.
    const capped = (list: readonly LearnedNote[]) => {
      let bytes = 0;
      return list.slice(0, INDEX_LINES).filter((note) => (bytes += Buffer.byteLength(ruleLine(note, shown)) + 1) <= INDEX_BYTES);
    };
    let lined = capped(choice.lines.filter((note) => blocks.has(note) && !chosen.has(note)));
    const render = () => [LINES_INTRO, ...wholeNotes.map((note) => blocks.get(note)!), lined.map((note) => ruleLine(note, shown)).join("\n"), ...(read && lined.length ? [READ_LINE] : [])].filter(Boolean).join("\n\n");
    let section = render();
    while (Buffer.byteLength(section) > budget && wholeNotes.length) {
      lined = capped([wholeNotes.pop()!, ...lined]);
      section = render();
    }
    const served = new Set([...wholeNotes, ...lined]);
    return { section, given: notes.filter((note) => served.has(note)) };
  }
  if (!choice.index) return { section: [WHOLE_INTRO, ...whole].join("\n\n"), given: notes.filter((note) => chosen.has(note)) };
  // Given: each note whole here, and each the index names by its file, by any of a line's links (a hand-edited line may
  // name more than one; linkedFiles, as servedIndex reads them).
  const indexed = new Set(lines.flatMap((entry) => linkedFiles(entry).filter((file) => active.has(file))));
  const given = notes.filter((note) => indexed.has(note.file) || chosen.has(note));
  return { section: [whole.length ? SOME_INTRO : INDEX_INTRO, shownIndex, ...(read && whole.length < notes.length ? [READ_LINE] : []), ...whole].filter(Boolean).join("\n\n"), given };
}

/** The run's skills folder, `.agents/skills`, as its Workspace names it. */
const SKILLS_PATH = RUN_SKILLS.join("/");

/** The names in the run's `.agents/skills/`: none when it is not there. A link on the way, or anything else that keeps
 *  it from being listed, throws. */
async function runSkillNames(work: Workspace): Promise<Set<string>> {
  try {
    return new Set((await work.list(SKILLS_PATH)).map((entry) => entry.name));
  } catch (error) {
    if (isWorkspaceError(error, "NOT_FOUND")) return new Set();
    throw error;
  }
}

/** Lays each of `skills` in the run's `.agents/skills/<name>/` through its Workspace, a folder made new for it (one
 *  already there throws EXISTS); a link on the way is ESCAPE, and nothing is written through it. Each name goes in
 *  `made` once its folder is, so a caller that fails takes back what was laid. */
export async function laySkills(work: Workspace, skills: readonly LearnedSkill[], made: string[]): Promise<void> {
  if (!skills.length) return;
  const there = await runSkillNames(work);
  for (const { name, files = {} } of skills) {
    if (there.has(name)) throw new WorkspaceError("EXISTS", `the run's ${SKILLS_PATH}/${name} is there already`, { path: `${SKILLS_PATH}/${name}` });
    await work.mkdir(`${SKILLS_PATH}/${name}`);
    made.push(name);
    // A SKILL.md as a harness is given it: its name and description alone in its front matter (servedSkill).
    for (const [path, text] of Object.entries(files)) await work.write(`${SKILLS_PATH}/${name}/${path}`, path === "SKILL.md" ? servedSkill(text) : text);
  }
}

/** Takes the learned skills `names` back out of the run's work: each `.agents/skills/<name>/`, unless a folder on the
 *  way is a link (or no folder), when nothing is touched. */
export async function takeSkills(work: Workspace, names: Iterable<string>): Promise<void> {
  for (const name of names) {
    try {
      await work.remove(`${SKILLS_PATH}/${name}`, { recursive: true, force: true });
    } catch (error) {
      if (isWorkspaceError(error, "ESCAPE") || isWorkspaceError(error, "NOT_FOUND") || isWorkspaceError(error, "REFUSED")) return;
      throw error;
    }
  }
}

/** The learned skills' names a pin's `skills` hold, each once. */
const namesIn = (files: readonly string[] | undefined): string[] => [...new Set((files ?? []).map((path) => path.split("/")[0]!))];

/** Which of `seed`'s learned skills a run gets, in `work`, in the seed's order: each whole while they fit their budget,
 *  LEARNED_SKILLS_BUDGET and never more than the revision's `own` skill files (by their bytes in `work`) leave of
 *  SKILL_BYTES. One named like a folder of the revision's skills, or like anything already in `work/.agents/skills/`, is
 *  the revision's, and not the run's; one that does not fit, or holds a host secret (`shown`), is left out. */
export async function chooseSkills(work: Workspace, seed: Seed, own: readonly string[], shown: Shown): Promise<{ taken: LearnedSkill[]; left: string[] }> {
  if (!seed.skills?.length) return { taken: [], left: [] };
  let ownBytes = 0;
  const folders = new Map<string, Promise<Entry[]>>();
  for (const path of own) {
    const at = `${SKILLS_PATH}/${path}`;
    const dir = posix.dirname(at);
    if (!folders.has(dir)) folders.set(dir, work.list(dir));
    const entry = (await folders.get(dir)!).find((one) => one.name === posix.basename(at) && one.kind === "file");
    if (!entry) throw new WorkspaceError("NOT_FOUND", `the revision's skill file ${at} is not in the run's work`, { path: at });
    ownBytes += entry.size;
  }
  let room = Math.max(0, Math.min(LEARNED_SKILLS_BUDGET, SKILL_BYTES - ownBytes));
  const owned = new Set(namesIn(own));
  const there = await runSkillNames(work);
  const taken: LearnedSkill[] = [];
  const left: string[] = [];
  for (const skill of seed.skills) {
    if (owned.has(skill.name) || there.has(skill.name)) continue;
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

/** Which of `seed`'s learned workflows a run may run (its `learned_workflow` tool), in the seed's order: each while its
 *  line (workflowLine) fits what is left of the tool's description budget (LEARNED_WORKFLOWS_BUDGET). One that does not,
 *  or holds a host secret (`shown`), is left out and named in `left`, but for one whose name is itself a secret, never
 *  named. Main's start (pinSeed) and a runner's claim (runner/learning-seed.ts) choose them the one way. */
export function chooseWorkflows(seed: Seed, shown: Shown): { flows: LearnedWorkflow[]; left: string[] } {
  const flows: LearnedWorkflow[] = [];
  const left: string[] = [];
  let room = LEARNED_WORKFLOWS_BUDGET;
  for (const flow of seed.workflows ?? []) {
    if (shown.holds(flow.workflow) || shown.holds(flow.description) || shown.holds(flow.name)) {
      // Named, but for a name that is itself a secret.
      if (!shown.holds(flow.name)) left.push(flow.name);
      continue;
    }
    const bytes = Buffer.byteLength(`${workflowLine(flow)}\n`, "utf8");
    if (bytes > room) left.push(flow.name);
    else (room -= bytes), flows.push(flow);
  }
  return { flows, left };
}

/** Writes `seed` into the run just made in `runDir`, its files through the run's Workspace (`work`): the index and each
 *  active note into `.learning/`, made fresh (whatever was there goes), then the pin, with what the run reads under
 *  `# Learned` (learnedParts) and the learned skills it gets beside the revision's `own` skill files (chooseSkills), then
 *  those skills, last, into `.agents/skills/`. A write that fails leaves no `.learning/`, no learned skill and no pin,
 *  and throws. */
export async function pinSeed(runDir: string, work: Workspace, seed: Seed, options: LearnedOptions & { own?: readonly string[] }): Promise<Pin> {
  const pinFile = join(runDir, LEARNING_PIN);
  const made: string[] = [];
  try {
    await layLearned(work, seed, options.shown);
    const { section, given } = learnedParts(seed, options);
    const { taken, left } = await chooseSkills(work, seed, options.own ?? [], options.shown);
    const skills = taken.flatMap(({ name, files = {} }) => Object.keys(files).sort().map((path) => `${name}/${path}`));
    // The learned workflows the run may run (chooseWorkflows), whole, in its directory before the pin names them (a
    // reopen keeps them); the ones left out the pin names.
    const { flows, left: flowsLeft } = chooseWorkflows(seed, options.shown);
    if (flows.length) await writeDurable(join(runDir, LEARNED_WORKFLOWS_FILE), `${JSON.stringify(flows)}\n`);
    const pin: Pin = { seed: seed.sha, ...(section ? { section } : {}), ...(given.length ? { given: given.map(({ file, name }) => ({ file, name })) } : {}), ...(skills.length ? { skills } : {}), ...(left.length ? { skills_left_out: left } : {}), ...(flows.length ? { workflows: flows.map(({ name }) => name) } : {}), ...(flowsLeft.length ? { workflows_left_out: flowsLeft } : {}) };
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
    await work.remove(LEARNED_DIR, { recursive: true, force: true }).catch(() => undefined);
    await takeSkills(work, made).catch(() => undefined);
    throw error;
  }
}

/** Lays the learned skills a reopened run's pin names (`pin.skills`) again, fresh, from `read` (the skills of its seed's
 *  commit: skillsAt): what the run wrote over them, or took away, is not what it learned. Each only with the files the
 *  pin names. Throws when it cannot, a link on the way among the reasons. */
export async function layPinnedSkills(work: Workspace, pin: Pin, read: () => Promise<LearnedSkill[]>): Promise<void> {
  const names = namesIn(pin.skills);
  if (!names.length) return;
  const files = new Set(pin.skills);
  const skills = (await read()).filter(({ name }) => names.includes(name)).map(({ name, bytes, files: all = {} }) => ({ name, bytes, files: Object.fromEntries(Object.entries(all).filter(([path]) => files.has(`${name}/${path}`))) }));
  await takeSkills(work, names);
  await laySkills(work, skills, []);
}

/** Takes back a seed whose copy a server went down during (runs.ts load): the learned skills its pin names, the pin,
 *  then the run's `.learning/`, through its Workspace. True when the pin or the copy was there. */
export async function dropSeed(runDir: string, work: Workspace): Promise<boolean> {
  const pinFile = join(runDir, LEARNING_PIN);
  const copied = await work.list(LEARNED_DIR).then(() => true, (error: unknown) => !isWorkspaceError(error, "NOT_FOUND"));
  const there = Boolean(await lstat(pinFile).catch(() => null)) || copied;
  if (!there) return false;
  await takeSkills(work, namesIn((await readPin(runDir).catch(() => undefined))?.skills));
  await rm(pinFile, { force: true });
  await work.remove(LEARNED_DIR, { recursive: true, force: true });
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
  if (!isObject(pin) || (typeof pin.seed !== "string" && pin.seed !== null) || (pin.section !== undefined && typeof pin.section !== "string") || (pin.given !== undefined && !(Array.isArray(pin.given) && pin.given.every((entry: unknown) => isObject(entry) && typeof entry.file === "string" && typeof entry.name === "string"))) || !names(pin.skills, skillFile) || !names(pin.skills_left_out, () => true) || !names(pin.workflows, (entry) => WORKFLOW_NAME.test(entry)) || !names(pin.workflows_left_out, (entry) => WORKFLOW_NAME.test(entry))) throw new Error(`the run's ${LEARNING_PIN} is not a learning pin`);
  return pin as Pin;
}

/** The heading of what a run learned, in its instructions. */
export const LEARNED_HEADING = "# Learned";
/** What every run that learns is told first under it, notes or none: a run not told it learns saves what the person
 *  asks it to remember in a file, or says it cannot, and that is never kept. */
const LEARNS = "You learn from your runs. When this run ends you are asked what to keep for later runs, anything the person asked you to remember included, and only your answer then is kept: a file you write is not. So when the person asks you to remember something, don't put it in a file or say you can't: tell them in one short sentence at the start of your reply that you will keep it for later runs. When what they asked sets how your reply starts or ends, follow it from your reply's first line to its last and leave that sentence out. A secret (a password, key or token) is never kept, so say so instead.";
/** What a run that starts with no note is told in place of what it learned. */
const NOTHING_YET = "Nothing learned yet.";

/** A run's instructions with its # Learned section laid in main's position: the revision's instructions, then the heading,
 *  LEARNS, and the section text — "Nothing learned yet." when the run learns but its section is empty (no notes yet, or a
 *  seed that could not be read). Shared so the runner (laying launch.learning.section, read with no folder) and app.ts
 *  (withLearned) lay the same bytes. */
export const laidLearned = (instructions: string, section: string | undefined): string =>
  `${instructions.trim()}\n\n${LEARNED_HEADING}\n\n${LEARNS}\n\n${section || NOTHING_YET}`;

/** A run's instructions, with `# Learned` after them when its pin in `runDir` says it learns: that it learns, then what
 *  the pin says it learned, or that it has learned nothing yet. A run with no pin (its agent does not learn, its seed
 *  failed, a workflow's run) is never asked what to keep, so it is told nothing. And its skill files: the revision's
 *  `own`, then the learned ones its pin names, by their paths under `.agents/skills/` in `work`, but for a skill named
 *  like one of the revision's, which is the revision's. A learned skill the work no longer holds whole, as a harness reads
 *  it through the run's Workspace (no link on the way), is left out: a learning fault never fails a run. The one path for
 *  every harness (app.ts): pi's system prompt, claude-agent's and codex's instructions, and the skills each gets. */
export async function withLearned(runDir: string, given: Workspace | string, instructions: string, own: readonly string[] = []): Promise<{ instructions: string; skills: string[] }> {
  // The run's process still hands its folder's path.
  const work = workspaceAt(given);
  const pin = await readPin(runDir);
  const section = pin?.section;
  const owned = new Set(namesIn(own));
  const learned = (pin?.skills ?? []).filter((path) => !owned.has(path.split("/")[0]!));
  const whole = new Set<string>();
  for (const name of namesIn(learned)) {
    const files = learned.filter((path) => path.startsWith(`${name}/`));
    if (await Promise.all(files.map((path) => work.read(`${SKILLS_PATH}/${path}`))).then(() => true, () => false)) whole.add(name);
    else process.stderr.write(`agentrun-serve: the skill ${name} its agent learned is no longer whole in the run's work, so the run goes on without it\n`);
  }
  return {
    instructions: pin ? laidLearned(instructions, section) : instructions,
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
