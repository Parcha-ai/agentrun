// Learning, its first half: each agent has a learning repository, and each agentic run starts from what its main holds.
// The repository is `<data>/homes/<agent id>/learning/` (files.ts homeOf), laid out as packages/learn's SPEC.md says
// (`learnings/INDEX.md`, `learnings/L-<12 hex>.md`, `.agents/skills/<name>/SKILL.md`, `memos/<run id>.md`, branches
// `runs/<run id>`): plain git with main checked out, so any reader sees its files. This server is its only writer. Every
// git call runs with the repository's hooks, fsmonitor, replace refs and lazy fetches off and reads no system or global
// config, and every call on one agent's repository waits its turn in that agent's queue in this process.
//
// When an agentic run is made the server makes the repository if it is absent (one host commit on main, holding only
// `learnings/INDEX.md`), resolves main's commit and reads it with plumbing, never the working tree. Once the store has
// seeded the run's directory with the revision's skills, the server writes the skills that commit holds into the run's
// work and pins the commit in the run's directory (`learning.json`), with the index the run reads. The run's process
// reads that pin and those files (app.ts promptOf) and never runs git, so it may run anywhere its directory is.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homeOf, writeDurable } from "./files.js";
import { isObject } from "./validate.js";

/** A run's pin, in its directory: written once, when the run is made, and never changed by a resume. */
export const LEARNING_PIN = "learning.json";
/** What a run's pin holds: the commit of main it was seeded from, the learned skills written into its work, and the
 *  index it reads, when that holds a note. */
export type Pin = { seed: string; skills: string[]; learned?: string };
/** What a run is seeded from: main's commit and what it holds. `skipped` names what was there and not read. */
export type Seed = { sha: string; index?: string; skills: Record<string, string>; skipped: string[] };

const INDEX = "learnings/INDEX.md";
/** The index a new repository's host commit holds: a header line, which SPEC allows, and no note. */
const NEW_INDEX = "# Learnings\n";
/** SPEC's index line, its skill name and its caps: what main holds over a cap is not read. */
const NOTE_LINE = /^- L-[0-9a-f]{12}: \S/m;
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_FILE = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/;
const CAPS = { index: 4096, file: 32_768 };
const IDENTITY = { name: "agentrun-serve", email: "serve@agentrun.invalid" };
/** The floor of git this server's learning needs: the one the repository's other learning packages test on. Its own
 *  calls need 2.32 (GIT_CONFIG_GLOBAL). */
const MIN_GIT = [2, 40] as const;
/** How long one git call may take before it is killed: a hung call would hold its agent's queue. */
const GIT_TIMEOUT_MS = 60_000;

/** The agent's learning repository: in its home, a path only the host writes (files.ts HOME_HOST_OWNED). */
export const learningRepo = (data: string, agentId: string): string => join(homeOf(data, agentId), "learning");

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

/** Why this host keeps no learning repository, or undefined when it can: git MIN_GIT or later on `env`'s PATH. */
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

/** Runs `work` once every call queued before it on the agent's repository has finished: one at a time per agent, in this
 *  process. Everything that touches an agent's repository goes through it, so two runs made at once never both make it. */
export function withAgentRepo<T>(data: string, agentId: string, work: () => Promise<T>): Promise<T> {
  const key = learningRepo(data, agentId);
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => queues.get(key) === settled && queues.delete(key));
  return next;
}

/** Main's commit, or undefined when the repository or its main is not there. */
async function mainOf(cwd: string, repo: string): Promise<string | undefined> {
  if (!existsSync(join(repo, ".git"))) return undefined;
  return git(cwd, repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]).then((out) => line(out) || undefined, () => undefined);
}

/** Makes the agent's repository, or finishes one whose making stopped before main: `init` with no template, then the
 *  host's one commit on main, holding `learnings/INDEX.md` alone, made with plumbing and created only where main is not
 *  there yet. The working tree and the index then show main, written here, never checked out. Called in the queue. */
async function openAgentRepo(cwd: string, repo: string): Promise<string> {
  const known = await mainOf(cwd, repo);
  if (known) return known;
  await mkdir(repo, { recursive: true, mode: 0o700 });
  await git(cwd, undefined, ["init", "-q", "--template=", "--initial-branch=main", repo]);
  const blob = line(await git(cwd, repo, ["hash-object", "-w", "--no-filters", "--stdin"], NEW_INDEX));
  const learnings = line(await git(cwd, repo, ["mktree"], `100644 blob ${blob}\tINDEX.md\n`));
  const tree = line(await git(cwd, repo, ["mktree"], `040000 tree ${learnings}\tlearnings\n`));
  const commit = line(await git(cwd, repo, ["commit-tree", tree, "-m", "host: the agent's learning repository"]));
  await git(cwd, repo, ["update-ref", "-m", "host: the agent's learning repository", "refs/heads/main", commit, ""]);
  await mkdir(join(repo, "learnings"), { recursive: true });
  await writeFile(join(repo, INDEX), NEW_INDEX);
  await git(cwd, repo, ["read-tree", "refs/heads/main"]);
  return commit;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** What commit `sha` holds for a run, read with plumbing: its index, and each skill at `.agents/skills/<name>/SKILL.md`.
 *  Only a regular file (mode 100644) under its cap, in UTF-8, is read; anything else is named in `skipped`. */
async function readSeed(cwd: string, repo: string, sha: string): Promise<Seed> {
  const seed: Seed = { sha, skills: {}, skipped: [] };
  const listed = (await git(cwd, repo, ["ls-tree", "-r", "-l", "-z", sha, "--", INDEX, ".agents/skills"])).toString("utf8").split("\0").filter(Boolean);
  for (const entry of listed) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    const name = SKILL_FILE.exec(path)?.[1];
    if (path !== INDEX && name === undefined) continue;
    if (name !== undefined && !SKILL_NAME.test(name)) {
      seed.skipped.push(`${path} (not a skill name)`);
      continue;
    }
    const cap = path === INDEX ? CAPS.index : CAPS.file;
    if (mode !== "100644" || type !== "blob" || !oid) {
      seed.skipped.push(`${path} (mode ${mode})`);
      continue;
    }
    if (Number(size) > cap) {
      seed.skipped.push(`${path} (over ${cap} bytes)`);
      continue;
    }
    let text: string;
    try {
      text = utf8.decode(await git(cwd, repo, ["cat-file", "blob", oid]));
    } catch {
      seed.skipped.push(`${path} (not UTF-8)`);
      continue;
    }
    if (path === INDEX) seed.index = text;
    else seed.skills[name!] = text;
  }
  return seed;
}

/** The seed of a run of agent `agentId` about to be made: main's commit, the repository made first when it is absent,
 *  and what that commit holds. In the agent's queue. */
export function seedOf(data: string, agentId: string): Promise<Seed> {
  const repo = learningRepo(data, agentId);
  const home = homeOf(data, agentId);
  return withAgentRepo(data, agentId, async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const sha = await openAgentRepo(home, repo);
    return readSeed(home, repo, sha);
  });
}

/** Writes `seed` into the run just made in `runDir`, after the store seeded it (seedRun empties `work/.agents/skills`
 *  and writes the revision's skills there): each learned skill whose folder no file of the revision's `skillFiles` is in
 *  (the revision's skill wins), then the pin, last. */
export async function pinSeed(runDir: string, work: string, seed: Seed, skillFiles: Iterable<string>): Promise<Pin> {
  const revision = [...skillFiles];
  const skills = Object.keys(seed.skills).sort().filter((name) => !revision.some((file) => file.startsWith(`${name}/`)));
  for (const name of skills) {
    const dir = join(work, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), seed.skills[name]!, { flag: "wx" });
  }
  const pin: Pin = { seed: seed.sha, skills, ...(seed.index !== undefined && NOTE_LINE.test(seed.index) ? { learned: seed.index } : {}) };
  await writeDurable(join(runDir, LEARNING_PIN), `${JSON.stringify(pin)}\n`);
  return pin;
}

/** The run's pin, as its process reads it: undefined when the run has none (made before learning, a workflow's run, or
 *  on a host that keeps no repository). A pin out of shape is an error, never read as none. */
export async function readPin(runDir: string): Promise<Pin | undefined> {
  let text: string;
  try {
    text = await readFile(join(runDir, LEARNING_PIN), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const pin = JSON.parse(text) as unknown;
  if (!isObject(pin) || typeof pin.seed !== "string" || !Array.isArray(pin.skills) || !pin.skills.every((name) => typeof name === "string" && SKILL_NAME.test(name)) || (pin.learned !== undefined && typeof pin.learned !== "string")) {
    throw new Error(`the run's ${LEARNING_PIN} is not a learning pin`);
  }
  return pin as Pin;
}
