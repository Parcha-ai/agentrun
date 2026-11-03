import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { checkRun, runOf, type Change, type CheckInput, type RunCheck } from "./check.js";
import { CAPS, isGitFile, isLocked, placeOf } from "./layout.js";

const exec = promisify(execFile);

export type CheckBranchInput = Omit<CheckInput, "branch" | "changes" | "forkPoint" | "headFiles"> & {
  /** A directory in the repository, or a bare repository. */
  readonly cwd: string;
  /** The ref the run's branch merges into, usually `main` or `origin/main`. */
  readonly base: string;
  /** The run's commit; `HEAD` by default. */
  readonly head?: string;
  /** The branch the run pushes, `runs/<run id>`. By default the branch `head` names. */
  readonly branch?: string;
};

export type BranchCheck = RunCheck & { readonly run?: string; readonly branch?: string; readonly forkPoint?: string };

/** A ref that does not name a commit. */
export class RefError extends Error {}

// Plumbing that reads objects only (rev-parse, merge-base, diff-tree, ls-tree, cat-file, config --get): nothing checks
// out, so no filter, smudge, hook or merge driver runs, and the flags below turn off what could still reach a command
// (an fsmonitor, a hooks folder, replace refs, a lazy fetch from a promisor remote).
const SAFE = ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const ENV = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", [...SAFE, ...args], { cwd, env: ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function blob(cwd: string, sha: string): Promise<Buffer> {
  return (await exec("git", [...SAFE, "cat-file", "blob", sha], { cwd, env: ENV, encoding: "buffer", maxBuffer: 2 * CAPS.file })).stdout;
}

const attempt = async (cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return undefined;
  }
};

/** The full commit id `ref` names. */
export async function commitOf(cwd: string, ref: string): Promise<string> {
  const sha = await attempt(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (!sha) throw new RefError(`${JSON.stringify(ref)} does not name a commit`);
  return sha;
}

/** The branch a ref names: `HEAD`'s current branch, `refs/heads/<b>`, or `refs/remotes/<remote>/<b>`. */
async function branchOf(cwd: string, head: string): Promise<string | undefined> {
  if (head === "HEAD") return (await attempt(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || undefined;
  const full = await attempt(cwd, ["rev-parse", "--symbolic-full-name", "--end-of-options", head]);
  if (full?.startsWith("refs/heads/")) return full.slice("refs/heads/".length);
  if (full?.startsWith("refs/remotes/")) return full.split("/").slice(3).join("/") || undefined;
  return undefined;
}

/** The repository-relative path of a file or folder the host names, when it lies inside the work tree. */
export async function insideRepo(cwd: string, path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return path.replace(/^\.\//, "");
  const top = await attempt(cwd, ["rev-parse", "--show-toplevel"]);
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const inside = top ? relative(real(top), real(path)) : undefined;
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : undefined;
}

const STATUS: Record<string, Change["status"]> = { A: "added", M: "modified", T: "modified", D: "deleted" };

/** Checks the run's branch in a git repository: the changes from where it starts on `base` to `head`. The repository's
 *  own hooks folder (`core.hooksPath`) is locked. Throws RefError when `base`, `head` or `runBase` names no commit. */
export async function checkBranch(input: CheckBranchInput): Promise<BranchCheck> {
  const { cwd, base: baseRef, head: headRef = "HEAD", branch: given, ...rest } = input;
  const base = await commitOf(cwd, baseRef);
  const head = await commitOf(cwd, headRef);
  const runBase = rest.runBase === undefined ? undefined : await commitOf(cwd, rest.runBase);
  const branch = given ?? (await branchOf(cwd, headRef));
  const named = { ...(branch !== undefined && runOf(branch) ? { run: runOf(branch)! } : {}), ...(branch !== undefined ? { branch } : {}) };
  const forkPoint = await attempt(cwd, ["merge-base", base, head]);
  if (!forkPoint) return { ...named, ok: false, problems: [{ rule: "branch", detail: "the branch shares no history with the base" }] };
  // Read without SAFE's own override, which would answer /dev/null.
  const hooks = await exec("git", ["config", "--get", "core.hooksPath"], { cwd, env: ENV, encoding: "utf8" }).then((out) => out.stdout.trim(), () => undefined);
  const hooksInRepo = hooks ? await insideRepo(cwd, hooks) : undefined;
  const lockedPaths = [...(rest.lockedPaths ?? []), ...(hooksInRepo ? [hooksInRepo] : [])];
  const raw = (await git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", forkPoint, head])).split("\0");
  // Counted before any body is read: over the cap, the checker reads nothing more.
  const over = Math.floor(raw.length / 2) > CAPS.changes;
  const changes: Change[] = [];
  for (let at = 0; at + 1 < raw.length; at += 2) {
    const [, mode, sha, letter] = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(raw[at]!) ?? [];
    const path = raw[at + 1]!;
    const status = STATUS[letter ?? ""];
    if (!status) throw new Error(`git diff-tree gave an entry this checker does not read: ${JSON.stringify(raw[at])}`);
    if (status === "deleted") changes.push({ path, status });
    else if (over || mode !== "100644" || isLocked(path, lockedPaths) || isGitFile(path) || !placeOf(path)) changes.push({ path, status, mode: mode! });
    else {
      const size = Number(await git(cwd, ["cat-file", "-s", sha!]));
      changes.push(size > CAPS.file ? { path, status, mode, size } : { path, status, mode, size, bytes: await blob(cwd, sha!) });
    }
  }
  // --full-tree: the whole tree's paths from its root, whichever folder of the work tree the checker runs in.
  const headFiles = over ? [] : (await git(cwd, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", head])).split("\0").filter(Boolean);
  const checked = checkRun({ ...rest, ...(runBase ? { runBase } : {}), branch: branch ?? "", changes, forkPoint, headFiles, lockedPaths });
  return { ...named, forkPoint, ...checked };
}
