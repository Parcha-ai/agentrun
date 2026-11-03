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
// with what the run reads of the index. The run's process reads that pin (withLearned, for app.ts) and never runs git, so
// it may run anywhere its directory is. When the run ends the server asks it one more turn, in which it may add notes to
// that copy (learning-run.ts). As the run settles, before anything can open it again, the copy is moved whole out of its work
// (snapshotLearned); what the turn added is checked from there (propose.ts), graded and merged into main (grade.ts).
//
// The host never follows a symbolic link into the folder (agentFolder): a link at the agent's home, at its `learning/`
// or at `learning/.git`, or a `MEMORY.md` that is one when the host writes it, is refused, and the run starts with
// nothing learned. The end-of-run turn's seed, its proposal's check, its grade and its merge reach the folder the same
// way, and a link there drops what the run learned. A person's reads and writes (learning-routes.ts) check it the same
// way (readFolder, agentFolder), and a link there is an error.
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { INDEX_FILE, type LearnedNote, loadedIndex, NOTE_FILE, parseNoteFile, type Problem, redactSecrets, secretShapes, valueMatcher, type Verdict } from "./learn/index.js";
import { homeOf, writeDurable } from "./files.js";
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

/** Where a run's learning stands (its `learning`, runs.ts): `seeded` once it starts from what its agent learned,
 *  `reflecting` while its end-of-run turn runs and until what it wrote is checked, `proposed` once that passed the checks
 *  and is kept in the run's directory (propose.ts), `merged` once it is on main (grade.ts), or `dropped` with a reason
 *  from the closed list. A learning fault never refuses a run: it starts with nothing learned, `seed_failed`.
 *  `tool_denied` is the tool gate's, which this server does not have yet: no run reads it today. */
export const LEARNING_STATES = ["seeded", "reflecting", "proposed", "merged", "dropped"] as const;
export const LEARNING_REASONS = ["seed_failed", "no_budget", "unknown_cost", "no_write_tool", "tool_denied", "cancelled", "crashed", "reflect_timeout", "reflect_failed", "empty", "propose_failed", "checker", "screen", "screen_down", "grader", "grade_failed"] as const;
export type LearningState = (typeof LEARNING_STATES)[number];
export type LearningReason = (typeof LEARNING_REASONS)[number];
/** Tokens by the platform's names, as a run's metrics and /v2/stats count them: `input` is the input neither read from
 *  nor written to the cache. */
export type Tokens = { input: number; cache_read: number; cache_write: number; output: number };
export const NO_TOKENS: Tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
/** A note a run read from its copy of the folder (`used`), by its file and its front matter's name. */
export type NoteUsed = { file: string; name: string };
/** A note a run's learning added to the folder (`learned`): its file, its name, and the notes it superseded. */
export type NoteLearned = NoteUsed & { supersedes: string[] };
/** A run's learning as serve.json keeps it. Past the view's four fields: the checker's `problems` (printable), the
 *  grader's `verdict`, kept before the merge, the merge commit, and what the grade cost (null when unknown, never 0),
 *  which is in no run's totals; the notes the run read from `.learning/` (`used`, found in its rows as it settles), and
 *  once merged the notes it added (`learned`); and how many notes it started from (`seed_notes`). Names are kept as
 *  written, and cut of the host's secrets as they leave. */
export type Learning = {
  state: LearningState; reason: LearningReason | null; detail: string | null; at: string;
  problems?: Problem[]; verdict?: Verdict; merged?: string; cost_usd?: { grade: number | null }; tokens?: { grade: Tokens | null };
  used?: NoteUsed[]; learned?: NoteLearned[];
  /** How many active notes the run started from: its seed's, set as it is seeded (none for a seed that failed). */
  seed_notes?: number;
  /** Once it asked its end-of-run turn: when its job's answer was final (before it looked back), and what the run had
   *  cost by then (null when unknown); once that turn ended, what the turn itself cost (null when unknown). */
  answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null;
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
 *  `used` once the run settled, `learned` once it merged, each only when it holds a note. serve.json's are read as
 *  untrusted: an entry out of shape is left out. */
export function notesView({ state, used, learned }: Learning, shown: Shown, settled: boolean): { used?: NoteUsed[]; learned?: NoteLearned[] } {
  const read = settled && Array.isArray(used) ? used.filter((note) => isText(note?.file) && isText(note.name)).map(({ file, name }) => ({ file: shown.name(file), name: shown.text(name) })) : [];
  const added = state === "merged" && Array.isArray(learned) ? learned.filter((note) => isText(note?.file) && isText(note.name) && Array.isArray(note.supersedes) && note.supersedes.every(isText)).map(({ file, name, supersedes }) => ({ file: shown.name(file), name: shown.text(name), supersedes: supersedes.map(shown.name) })) : [];
  return { ...(read.length ? { used: read } : {}), ...(added.length ? { learned: added } : {}) };
}
/** A run's learning in a person's words as a read shows them (learning-words.ts wordsOf): each part cut of the host's
 *  secrets as they are now (`shown`) first, then the words cut short to `max`, so a secret is never shown in part. */
export const detailShown = (learning: Learning, shown: Shown, max = DETAIL_MAX): string | null => {
  const words = wordsOf(learning, shown.text);
  return words === null ? null : short(words, max);
};
/** A run's learning as its view shows it: the state, why in a person's words (detailShown), and when, and the notes it
 *  read and learned (notesView). */
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

/** A run's proposal, in its directory (propose.ts): the seed it was checked against, and each new note's file and text. */
export const PROPOSAL = "learning-proposal.json";
export type Proposal = { seed: string; notes: { file: string; text: string }[] };

/** A run's pin, in its directory: written once, when the run is made, and never changed by a resume. */
export const LEARNING_PIN = "learning.json";
/** Where a run finds its agent's notes: in its work, a copy the run may read and nothing reads back. */
export const LEARNED_DIR = ".learning";
/** Where that copy goes once the run's end-of-run turn ended and the run settles: in the run's directory, outside its
 *  work, where the host alone reads it (snapshotLearned). */
export const LEARNED_SNAPSHOT = "learning-turn";
/** What a run's pin holds: the commit of main it was seeded from, and what it reads of the index, when that holds a line. */
export type Pin = { seed: string; learned?: string };
/** What a run is seeded from: main's commit, its index and its active notes by file, and the name of every entry at its
 *  top. `skipped` names what was there and not read. */
export type Seed = { sha: string; index?: string; notes: Record<string, string>; files: string[]; skipped: string[] };

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
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => queues.get(key) === settled && queues.delete(key));
  return next;
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
 *  parseNoteFile); anything else is named in `skipped`. A superseded or retired note is not a run's. A read git fails (an
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

/** The seed of a run of agent `agentId` about to be made: main's commit, the folder made first when it is absent, and
 *  what that commit holds. In the agent's queue. */
export function seedOf(data: string, agentId: string): Promise<Seed> {
  return withAgentRepo(data, agentId, async () => {
    const check = () => agentFolder(data, agentId);
    const repo = await check();
    const home = homeOf(data, agentId);
    const sha = await openAgentRepo(home, repo, check);
    return readSeed(home, repo, sha);
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
 *  open it again: its copy, `work/.learning/` as the turn left it, moved whole to `<run dir>/learning-turn/` with one
 *  rename on the run's own filesystem, so nothing the run does after its end reaches what is checked. The move takes
 *  whatever is there, a link or a file included, never following one; harvest refuses those. A snapshot already there
 *  stays (a server that went after the move); a copy the turn removed is an empty snapshot. `work` itself must be a
 *  folder, never a link the move would reach through. Throws when the move fails. */
export async function snapshotLearned(runDir: string): Promise<void> {
  const snapshot = join(runDir, LEARNED_SNAPSHOT);
  if (await lstat(snapshot).then(() => true, (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)))) return;
  await refuseLink(runDir, join(runDir, "work"));
  try {
    await rename(join(runDir, "work", LEARNED_DIR), snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(snapshot, { mode: 0o700 });
  }
}

/** Lays `seed`'s index and active notes in `dir`, made fresh: whatever was there goes. */
export async function layLearned(dir: string, seed: Seed): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  const files = Object.entries(seed.notes);
  if (seed.index !== undefined) files.unshift([INDEX_FILE, seed.index]);
  for (const [file, text] of files) await writeFile(join(dir, file), text, { flag: "wx" });
}

/** Writes `seed` into the run just made in `runDir`: the index and each active note into `work/.learning/`, made fresh
 *  (whatever was there goes), then the pin, last. A write that fails leaves no `.learning/` and no pin, and throws. */
export async function pinSeed(runDir: string, work: string, seed: Seed): Promise<Pin> {
  const dir = join(work, LEARNED_DIR);
  const pinFile = join(runDir, LEARNING_PIN);
  try {
    await learningTestHooks.beforePin?.(runDir);
    await layLearned(dir, seed);
    const learned = seed.index === undefined ? "" : loadedIndex(seed.index);
    const pin: Pin = { seed: seed.sha, ...(learned.trim() ? { learned } : {}) };
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
  if (!isObject(pin) || typeof pin.seed !== "string" || (pin.learned !== undefined && typeof pin.learned !== "string")) throw new Error(`the run's ${LEARNING_PIN} is not a learning pin`);
  return pin as Pin;
}

/** The heading and the lines before the index, in a run's instructions. */
export const LEARNED_HEADING = "# Learned";
const LEARNED_INTRO = `What you learned in earlier runs, one line per note. Each note is a file in \`${LEARNED_DIR}/\` in your working directory: open one when it applies to what you are doing.`;

/** A run's instructions, with what its pin in `runDir` says it learned after them, under `# Learned`. The one path for
 *  every harness (app.ts): pi's system prompt, claude-agent's and codex's instructions. */
export async function withLearned(runDir: string, instructions: string): Promise<string> {
  const pin = await readPin(runDir);
  return pin?.learned ? `${instructions.trim()}\n\n${LEARNED_HEADING}\n\n${LEARNED_INTRO}\n\n${pin.learned.trim()}` : instructions;
}
