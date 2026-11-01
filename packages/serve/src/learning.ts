// Learning: an agent whose definition says `learning: true` keeps a folder of what it learned, and each of its runs
// starts from it. The folder is `<data>/homes/<agent id>/learning/`, in Claude Code's auto-memory format
// (packages/learn notes.ts): `MEMORY.md`, the index, one line per active note, and one `<slug>.md` per note. It is plain
// git with main checked out, so any reader sees its files. This server is its only writer. Every git call runs with the
// repository's hooks, fsmonitor, replace refs and lazy fetches off and reads no system or global config, and every call
// on one agent's folder waits its turn in that agent's queue in this process.
//
// When a run of such an agent is made the server makes the folder if it is absent (one host commit on main, holding an
// empty `MEMORY.md`), resolves main's commit and reads it with plumbing, never the working tree. It copies that commit's
// index and active notes into the run's `work/.learning/` and pins the commit in the run's directory (`learning.json`),
// with what the run reads of the index. The run's process reads that pin (withLearned, for app.ts) and never runs git, so
// it may run anywhere its directory is.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INDEX_FILE, loadedIndex, NOTE_FILE, parseNoteFile } from "@parcha/agentrun-learn";
import { writeDurable } from "./files.js";
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

/** Where a run's learning stands (its `learning`, runs.ts): `seeded` once it starts from what its agent learned, or
 *  `dropped` with why. A learning fault never refuses a run: it starts with nothing learned, `seed_failed`. */
export const LEARNING_STATES = ["seeded", "dropped"] as const;
export const LEARNING_REASONS = ["seed_failed"] as const;
export type LearningState = (typeof LEARNING_STATES)[number];
export type LearningReason = (typeof LEARNING_REASONS)[number];
export type Learning = { state: LearningState; reason: LearningReason | null; detail: string | null; at: string };

/** A run's pin, in its directory: written once, when the run is made, and never changed by a resume. */
export const LEARNING_PIN = "learning.json";
/** Where a run finds its agent's notes: in its work, a copy the run may read and nothing reads back. */
export const LEARNED_DIR = ".learning";
/** What a run's pin holds: the commit of main it was seeded from, and what it reads of the index, when that holds a line. */
export type Pin = { seed: string; learned?: string };
/** What a run is seeded from: main's commit, its index and its active notes by file. `skipped` names what was there
 *  and not read. */
export type Seed = { sha: string; index?: string; notes: Record<string, string>; skipped: string[] };

/** A file main holds over this is not read: a note is short, and the index is read only so far (loadedIndex). */
const FILE_CAP = 1 << 20;
const IDENTITY = { name: "agentrun-serve", email: "serve@agentrun.invalid" };
/** The floor of git this server's learning needs: the one the repository's other learning packages test on. Its own
 *  calls need 2.32 (GIT_CONFIG_GLOBAL). */
const MIN_GIT = [2, 40] as const;
/** How long one git call may take before it is killed: a hung call would hold its agent's queue. */
const GIT_TIMEOUT_MS = 60_000;

/** The agent's home, `<data>/homes/<agent id>`, and its learning folder: the home's `learning/` entry, which only the
 *  host writes. */
const homeDir = (data: string, agentId: string): string => join(data, "homes", agentId);
export const learningRepo = (data: string, agentId: string): string => join(homeDir(data, agentId), "learning");

/** Before every command: a `-c` flag wins over the repository's own config. No hook or fsmonitor runs, no replace ref
 *  is read, a commit is never signed (which would run a program), and no transport runs, so nothing is fetched lazily. */
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
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  ...(gitDir ? { GIT_DIR: gitDir } : {}),
});

/** One git call on `repo` (none for `init`), from `cwd`: its stdout, or a rejection naming the command and its stderr. */
function git(cwd: string, repo: string | undefined, args: readonly string[], input = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE, ...args], { cwd, env: gitEnv(repo && join(repo, ".git")), stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
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

const line = (out: Buffer): string => out.toString("utf8").trim();

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
export function withAgentRepo<T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> {
  const key = learningRepo(data, agentId);
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => queues.get(key) === settled && queues.delete(key));
  return next;
}

/** Main's commit, or undefined when there is no main yet: no repository, one whose `init` never finished, or one whose
 *  making stopped before main. A main that is there, by its ref, and names no commit git can read is an error: the
 *  repository is never made again over it. */
async function mainOf(cwd: string, repo: string): Promise<string | undefined> {
  if (!existsSync(join(repo, ".git")) || !(await git(cwd, repo, ["rev-parse", "--git-dir"]).then(() => true, () => false))) return undefined;
  if (!line(await git(cwd, repo, ["for-each-ref", "--format=%(objectname)", "refs/heads/main"]))) return undefined;
  return line(await git(cwd, repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]));
}

/** Makes the agent's folder, or finishes one whose making stopped before main: `init` with no template, then the host's
 *  one commit on main, holding an empty `MEMORY.md` alone, made with plumbing. The working tree and the index show that
 *  commit's tree first (written here, never checked out), and main is created last, only where it is not there yet: a
 *  making that stops anywhere before leaves no main, and the next one does it all again. Called in the queue. */
async function openAgentRepo(cwd: string, repo: string): Promise<string> {
  const known = await mainOf(cwd, repo);
  if (known) return known;
  await mkdir(repo, { recursive: true, mode: 0o700 });
  await git(cwd, undefined, ["init", "-q", "--template=", "--initial-branch=main", repo]);
  const blob = line(await git(cwd, repo, ["hash-object", "-w", "--no-filters", "--stdin"], ""));
  const tree = line(await git(cwd, repo, ["mktree"], `100644 blob ${blob}\t${INDEX_FILE}\n`));
  await writeFile(join(repo, INDEX_FILE), "");
  await git(cwd, repo, ["read-tree", tree]);
  const commit = line(await git(cwd, repo, ["commit-tree", tree, "-m", "host: the agent's learning folder"]));
  await git(cwd, repo, ["update-ref", "-m", "host: the agent's learning folder", "refs/heads/main", commit, ""]);
  return commit;
}

/** The blobs `oids` hold, in order, read in one `cat-file --batch`. One git cannot read throws. */
async function readBlobs(cwd: string, repo: string, oids: readonly string[]): Promise<Buffer[]> {
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
 *  Only a regular file (mode 100644) under FILE_CAP, in UTF-8, is read, and only a note in shape (packages/learn
 *  parseNoteFile); anything else is named in `skipped`. A superseded or retired note is not a run's. A read git fails (an
 *  object missing, a timeout) throws. */
async function readSeed(cwd: string, repo: string, sha: string): Promise<Seed> {
  const seed: Seed = { sha, notes: {}, skipped: [] };
  const listed = (await git(cwd, repo, ["ls-tree", "-l", "-z", sha])).toString("utf8").split("\0").filter(Boolean);
  const wanted: { path: string; oid: string }[] = [];
  for (const entry of listed) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
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
  const repo = learningRepo(data, agentId);
  const home = homeDir(data, agentId);
  return withAgentRepo(data, agentId, async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const sha = await openAgentRepo(home, repo);
    return readSeed(home, repo, sha);
  });
}

/** Test seams, tests only: before a run's learned files are written. */
export const learningTestHooks: { beforePin?: (runDir: string) => Promise<void> | void } = {};

/** Writes `seed` into the run just made in `runDir`: the index and each active note into `work/.learning/`, made fresh
 *  (whatever was there goes), then the pin, last. A write that fails leaves no `.learning/` and no pin, and throws. */
export async function pinSeed(runDir: string, work: string, seed: Seed): Promise<Pin> {
  const dir = join(work, LEARNED_DIR);
  try {
    await learningTestHooks.beforePin?.(runDir);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    const files = Object.entries(seed.notes);
    if (seed.index !== undefined) files.unshift([INDEX_FILE, seed.index]);
    for (const [file, text] of files) await writeFile(join(dir, file), text, { flag: "wx" });
    const learned = seed.index === undefined ? "" : loadedIndex(seed.index);
    const pin: Pin = { seed: seed.sha, ...(learned.trim() ? { learned } : {}) };
    await writeDurable(join(runDir, LEARNING_PIN), `${JSON.stringify(pin)}\n`);
    return pin;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
