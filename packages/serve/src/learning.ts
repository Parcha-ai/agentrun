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
// The host never follows a symbolic link into the folder (agentFolder): a link at the agent's home, at its `learning/`
// or at `learning/.git`, or a `MEMORY.md` that is one when the host writes it, is refused, and the run starts with
// nothing learned. The end-of-run turn's seed, its proposal's check, its grade and its merge reach the folder the same
// way, and a link there drops what the run learned. A person's reads and writes (learning-routes.ts) check it the same
// way (readFolder, agentFolder), and a link there is an error.
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { INDEX_FILE, type LearnedNote, loadedIndex, NOTE_FILE, parseNoteFile, type Problem, redactSecrets, secretShapes, valueMatcher, type Verdict } from "./learn/index.js";
import { homeOf, serialBy, writeDurable } from "./files.js";
import { DETAIL_MAX, LIST_DETAIL, short, wordsOf } from "./learning-words.js";
import { isObject } from "./validate.js";

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
};
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
 *  `used` once the run settled, `learned` and `pending` (what waits for the owner's OK) once it merged, each only when
 *  it holds a note. serve.json's are read as untrusted: an entry out of shape is left out. */
export function notesView({ state, used, learned, pending }: Learning, shown: Shown, settled: boolean): { used?: NoteUsed[]; learned?: NoteLearned[]; pending?: NoteUsed[] } {
  const read = settled && Array.isArray(used) ? used.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : [];
  const added = state === "merged" && Array.isArray(learned) ? learned.filter((note) => isText(note?.file) && isText(note.name) && Array.isArray(note.supersedes) && note.supersedes.every(isText)).map(({ file, name, supersedes }) => ({ file: shown.name(file), name: shown.text(name), supersedes: supersedes.map(shown.name) })) : [];
  const waiting = state === "merged" && Array.isArray(pending) ? pending.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : [];
  return { ...(read.length ? { used: read } : {}), ...(added.length ? { learned: added } : {}), ...(waiting.length ? { pending: waiting } : {}) };
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

/** A run's proposal, in its directory (propose.ts): the seed it was checked against, each new note's file and text, and
 *  what the user said in the run as the grader reads it (each message cut of the host's secrets, then shortened to
 *  GRADE_CAPS.askedMessage; absent in a proposal kept before the grader read them). */
export const PROPOSAL = "learning-proposal.json";
export type Proposal = { seed: string; notes: { file: string; text: string }[]; asked?: string[] };

/** A run's pin, in its directory: written once, when the run is made, and never changed by a resume. */
export const LEARNING_PIN = "learning.json";
/** Where a run finds its agent's notes: in its work, a copy the run may read and nothing reads back. */
export const LEARNED_DIR = ".learning";
/** What the run's end-of-run turn answered, and what the user said in the run, kept in the run's directory as the run
 *  settles (learning-run.ts beforeSettle), where the host alone reads it: what propose.ts checks. */
export const LEARNING_TURN = "learning-turn.json";
export type Turn = { answer: string; asked: string[] };
/** What a run's pin holds: the commit of main it was seeded from, and what it reads under `# Learned` (learnedOf), when
 *  it learned anything. `learned`, the index alone, is a pin an earlier server wrote, read as that server gave it. */
export type Pin = { seed: string; section?: string; learned?: string };
/** What a run is seeded from: main's commit, its index and its active notes by file, and the name of every entry at its
 *  top. `skipped` names what was there and not read. `recent`, when seedOf read it: the active notes' files, the one
 *  changed last on main first. */
export type Seed = { sha: string; index?: string; notes: Record<string, string>; files: string[]; skipped: string[]; recent?: string[] };

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
    return seed;
  });
}

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
 *  learned files are written, once its pin is in place, before what its end-of-run turn wrote is checked, and as each
 *  git call starts (its arguments). */
export const learningTestHooks: {
  git?: (args: readonly string[]) => void;
  afterMkdir?: (dir: string) => Promise<void> | void;
  beforePin?: (runDir: string) => Promise<void> | void;
  afterPin?: (runDir: string) => Promise<void> | void;
  beforePropose?: (runDir: string) => Promise<void> | void;
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

/** A note's file an index line links to. */
const LINKED = /\]\(([^)\s]+)\)/;
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
export type LearnedOptions = { budget: number; read: boolean; shown: Shown };
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
  const named = lines.every((entry) => active.has(LINKED.exec(entry)?.[1] ?? ""));
  if (named && blocks.reduce((sum, block) => sum + size(block), 0) <= budget) return [WHOLE_INTRO, ...blocks].join("\n\n");
  const shownIndex = lines.map(shown.text).join("\n");
  let left = budget - (shownIndex ? size(shownIndex) : 0);
  const whole = blocks.filter((block) => size(block) <= left && ((left -= size(block)), true));
  return [whole.length ? SOME_INTRO : INDEX_INTRO, shownIndex, ...(read && whole.length < notes.length ? [READ_LINE] : []), ...whole].filter(Boolean).join("\n\n");
}

/** Writes `seed` into the run just made in `runDir`: the index and each active note into `work/.learning/`, made fresh
 *  (whatever was there goes), then the pin, last, with what the run reads under `# Learned` (learnedOf). A write that
 *  fails leaves no `.learning/` and no pin, and throws. */
export async function pinSeed(runDir: string, work: string, seed: Seed, options: LearnedOptions): Promise<Pin> {
  const dir = join(work, LEARNED_DIR);
  const pinFile = join(runDir, LEARNING_PIN);
  try {
    await learningTestHooks.beforePin?.(runDir);
    await layLearned(dir, seed, options.shown);
    const section = learnedOf(seed, options);
    const pin: Pin = { seed: seed.sha, ...(section ? { section } : {}) };
    await writeDurable(pinFile, `${JSON.stringify(pin)}\n`);
    await learningTestHooks.afterPin?.(runDir);
    return pin;
  } catch (error) {
    // writeDurable renames the pin into place before it syncs the run's directory, so a failure there leaves the pin
    // behind: it goes too, or the run's instructions would still say what it learned, of notes it has no copy of.
    await rm(pinFile, { force: true }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Takes back a seed whose copy a server went down during (runs.ts load): the run's pin, then its `work/.learning/`.
 *  True when either was there. */
export async function dropSeed(runDir: string, work: string): Promise<boolean> {
  const pinFile = join(runDir, LEARNING_PIN);
  const dir = join(work, LEARNED_DIR);
  const there = Boolean((await lstat(pinFile).catch(() => null)) ?? (await lstat(dir).catch(() => null)));
  if (!there) return false;
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
  if (!isObject(pin) || typeof pin.seed !== "string" || (pin.section !== undefined && typeof pin.section !== "string") || (pin.learned !== undefined && typeof pin.learned !== "string")) throw new Error(`the run's ${LEARNING_PIN} is not a learning pin`);
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
 *  failed, a workflow's run) is never asked what to keep, so it is told nothing. The one path for every harness
 *  (app.ts): pi's system prompt, claude-agent's and codex's instructions. */
export async function withLearned(runDir: string, instructions: string): Promise<string> {
  const pin = await readPin(runDir);
  if (!pin) return instructions;
  const section = pin.section ?? (pin.learned?.trim() ? `${EARLIER_INTRO}\n\n${pin.learned.trim()}` : undefined);
  return `${instructions.trim()}\n\n${LEARNED_HEADING}\n\n${LEARNS}\n\n${section ?? NOTHING_YET}`;
}
